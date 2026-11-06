'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const assert = require('node:assert/strict');
const {LibraryStore,describe} = require('../library.cjs');
const root = path.resolve(__dirname,'..');
const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
async function main() {
  const latest = JSON.parse(await fs.readFile(path.join(root,'dist','latest.json'),'utf8'));
  const profile = await fs.mkdtemp(path.join(root,'.test-data','packaged-'));
  const store = new LibraryStore(path.join(profile,'music-green-data')); await store.load();
  const {parseFile} = await import('music-metadata');
  const assets = path.join(root,'test-media');
  const track = await describe(path.join(assets,'no-im-not-a-human-ost.mp3'),parseFile);
  const pictures = (await fs.readdir(assets)).filter(name => /\.(png|jpg|webp)$/i.test(name));
  store.data.tracks = [track]; store.data.images = await Promise.all(pictures.map(name => describe(path.join(assets,name))));
  store.data.settings.queue = [track.id]; store.data.settings.language = 'vi';
  await store.persist();
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0,'127.0.0.1',resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const env = {...process.env,MUSIC_GREEN_TEST_DATA:profile}; delete env.ELECTRON_RUN_AS_NODE; delete env.MUSIC_GREEN_SMOKE;
  const child = spawn(latest.executable,[`--remote-debugging-port=${port}`],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let socket;
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  let passed = 0;
  const check = (name,value,expected = true) => { assert.deepEqual(value,expected,name); console.log('PASS',++passed,name); };
  try {
    let page;
    for (let attempt=0;attempt<120;attempt++) {
      try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page'); if(page) break; }
      catch { /* The packaged process is still starting. */ }
      await wait(100);
    }
    if (!page) throw new Error('Packaged app did not start');
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve,reject) => {socket.onopen = resolve; socket.onerror = reject;});
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
      if (message.id) { const request = pending.get(message.id); if (request) {pending.delete(message.id); message.error ? request.reject(message.error) : request.resolve(message.result);} }
    };
    socket.onclose = () => { for (const request of pending.values()) request.reject(new Error('Window closed')); pending.clear(); };
    const command = (method,params = {}) => new Promise((resolve,reject) => {
      const id = ++sequence;
      const timer = setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},12000);
      pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
      socket.send(JSON.stringify({id,method,params}));
    });
    const evaluate = async expression => {
      const result = await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const until = async source => {for(let index=0;index<120;index++){if(await evaluate(source)) return;await wait(100);}throw new Error('Timed out: '+source);};
    await command('Runtime.enable'); await until('window.MUSIC_GREEN_READY');
    check('packaged preload / library available',await evaluate('state.tracks.length'),1);
    check('packaged sandbox active',await evaluate('typeof require === "undefined" && typeof process === "undefined"'));
    check('packaged app sees every selected image',await evaluate('state.images.length'),pictures.length);
    await evaluate('$("navStudio").click(); $("playAll").click()');
    // playAll is hidden in radio mode; invoking it still exercises the same controller.
    await until('!audio.paused && Number.isFinite(audio.duration) && audio.currentTime > .3');
    check('packaged MP3 decoding',await evaluate('audio.duration > 4000'));
    await evaluate('audio.currentTime = 180'); await until('audio.currentTime > 180');
    check('packaged seeking',await evaluate('audio.currentTime < 185'));
    await until('engine.analyser.getFloatTimeDomainData(engine.samples); engine.samples.some(value=>Math.abs(value)>.00001)');
    check('packaged waveform uses real MP3 samples',await evaluate('engine.analyser.fftSize'),4096);
    await evaluate('$("synthPads").querySelector("button").click()'); await until('engine.synths.size === 1');
    check('packaged synthesizer',await evaluate('engine.synths.size'),1);
    await evaluate('$("synthOff").click(); $("cameraSelect").value = state.images.length - 1; $("cameraSelect").dispatchEvent(new Event("change"))');
    await until('$("cameraImage").complete && $("cameraImage").naturalWidth > 0');
    check('packaged last image decodes',await evaluate('cameraIndex'),pictures.length - 1);
    const screenshot = await command('Page.captureScreenshot',{format:'png'});
    await fs.writeFile(path.join(root,'.test-data','packaged-radio.png'),Buffer.from(screenshot.data,'base64'));
    await evaluate('$("langEn").click()'); check('packaged English',await evaluate('$("viewTitle").textContent'),'Radio & camera');
    check('packaged no page overflow',await evaluate('document.documentElement.scrollWidth <= innerWidth'));
    check('packaged no runtime errors',errors,[]);
    // Closing the real window must flush the final position, not just periodic autosave.
    await evaluate('audio.pause(); audio.currentTime = 33;');
    const exited = new Promise((resolve,reject) => { const timer = setTimeout(()=>reject(new Error('App did not close')),15000);child.once('exit',()=>{clearTimeout(timer);resolve();}); });
    await command('Browser.close').catch(()=>{}); await exited;
    const saved = JSON.parse(await fs.readFile(store.file,'utf8'));
    check('packaged window close saves position',saved.settings.position >= 32 && saved.settings.position <= 34);
    check('packaged window close saves language',saved.settings.language,'en');
    console.log(`PACKAGED: ${passed} checks passed`);
  } finally {
    if (socket?.readyState === WebSocket.OPEN) socket.close();
    if (child.exitCode === null) child.kill();
  }
}
const timeout = setTimeout(()=>{console.error('Packaged test timed out');process.exit(1);},90000);
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(timeout));
