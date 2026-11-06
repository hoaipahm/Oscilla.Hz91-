'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname,'..');
async function run() {
  const runtime = require('electron');
  const directory = await fs.mkdtemp(path.join(root,'.test-data','desktop-'));
  const env = {...process.env,MUSIC_GREEN_TEST_DATA:directory,MUSIC_GREEN_SMOKE:'1'};
  delete env.ELECTRON_RUN_AS_NODE;
  for (const phase of ['first','restore']) {
    await new Promise((resolve,reject) => {
      const child = spawn(runtime,[root],{cwd:root,env:{...env,MUSIC_GREEN_PHASE:phase},windowsHide:true,stdio:'inherit'});
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Desktop test timeout')); },120000);
      child.on('error',error => { clearTimeout(timeout); reject(error); });
      child.on('exit',code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`Desktop test failed: ${code}`)); });
    });
  }
  console.log('Desktop integration and restart persistence passed. Artifacts:',directory);
}
fs.mkdir(path.join(root,'.test-data'),{recursive:true}).then(run).catch(error => { console.error(error); process.exitCode = 1; });
