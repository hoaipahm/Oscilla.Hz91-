'use strict';
const { app, BrowserWindow, dialog, ipcMain, protocol, net, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { AUDIO, IMAGES, walk, describe, checkAvailability, cleanCollections, cleanSettings, LibraryStore } = require('./library.cjs');
const { prepareMusicImport } = require('./importer.cjs');
const { mediaResponse } = require('./media.cjs');

protocol.registerSchemesAsPrivileged([
  { scheme: 'green', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'green-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled:true } }
]);
app.setName('Music Green');
app.setAppUserModelId('local.hoai.musicgreen');
app.setPath('userData', process.env.MUSIC_GREEN_TEST_DATA || path.join(app.getPath('appData'),'Music Green'));
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
let window;
let store;
let importing = false;
let trashing = false;
const media = new Map();
const rendererRoot = path.join(__dirname, 'renderer');
function refreshMedia() { media.clear(); for (const item of [...store.data.tracks, ...store.data.images]) media.set(item.id, item.path); }
function snapshot() {
  const safe = structuredClone(store.data);
  for (const item of [...safe.tracks, ...safe.images]) { delete item.path; item.url = `green-media://local/${item.id}`; }
  return { ...safe, loadWarning: Boolean(store.loadWarning) };
}
function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame ||
      !event.senderFrame.url.startsWith('green://app/')) throw new Error('FORBIDDEN');
    try { return { ok: true, value: await callback(...args) }; }
    catch (error) { console.error(channel, error.message); return { ok: false, error: error.code || error.message }; }
  });
}
async function importMedia(kind) {
  if (importing || trashing) throw new Error('IMPORT_BUSY');
  importing = true;
  try {
    const imageMode = kind === 'images';
    const folderMode = kind !== 'files';
    const english = store.data.settings.language === 'en';
    const result = await dialog.showOpenDialog(window, {
      title: imageMode ? (english ? 'Music Green — Choose image folder' : 'Music Green — Chọn thư mục ảnh')
        : folderMode ? (english ? 'Music Green — Choose music folder' : 'Music Green — Chọn thư mục chứa nhạc')
        : (english ? 'Music Green — Add tracks' : 'Music Green — Thêm bài hát'),
      buttonLabel: folderMode ? (english ? 'Add this folder' : 'Thêm thư mục này') : (english ? 'Add tracks' : 'Thêm bài hát'),
      defaultPath: app.getPath(imageMode ? 'pictures' : 'music'),
      properties: folderMode ? ['openDirectory'] : ['openFile', 'multiSelections'],
      filters: folderMode ? [] : [{ name: 'Audio', extensions: [...AUDIO].map(ext => ext.slice(1)) }]
    });
    if (result.canceled) return null;
    const scanned = folderMode ? await walk(result.filePaths[0], imageMode ? IMAGES : AUDIO)
      : { files: result.filePaths.filter(file => AUDIO.has(path.extname(file).toLowerCase())), skippedFolders: 0, limitReached: false };
    const parser = imageMode ? null : (await import('music-metadata')).parseFile;
    const progress = value => window?.webContents.send('import-progress',value);
    let prepared;
    if (imageMode) {
      const images = []; const failures = [];
      for (let index=0;index<scanned.files.length;index+=8) {
        const batch = await Promise.allSettled(scanned.files.slice(index,index+8).map(file => describe(file)));
        for (const entry of batch) { if(entry.status==='fulfilled') images.push(entry.value); else failures.push('image'); }
        progress({done:Math.min(index+8,scanned.files.length),total:scanned.files.length});
      }
      prepared = {images,added:images.length,duplicates:[],relinked:[],failures,limitReached:false};
    } else prepared = await prepareMusicImport(store.data.tracks,scanned.files,parser,progress);
    const before = structuredClone(store.data);
    if (imageMode) store.data.images = prepared.images;
    else store.data.tracks = prepared.tracks;
    try { await store.persist(); }
    catch (error) { store.data = before; throw error; }
    refreshMedia();
    return { snapshot: snapshot(), count: prepared.added, found:scanned.files.length,
      selectedFolder:folderMode ? result.filePaths[0] : null, duplicates:prepared.duplicates,relinked:prepared.relinked,
      failed:prepared.failures.length, failureNames:prepared.failures, skippedFolders: scanned.skippedFolders, limitReached: scanned.limitReached || prepared.limitReached };
  } finally { importing = false; }
}
function setupIPC() {
  handle('bootstrap', () => snapshot());
  handle('import', kind => { if (!['files','folder','images'].includes(kind)) throw new Error('INVALID_IMPORT'); return importMedia(kind); });
  handle('settings', async input => {
    if (!input || typeof input !== 'object') throw new Error('INVALID_SETTINGS');
    const previous = store.data.settings;
    store.data.settings = cleanSettings(input, previous);
    const ids = new Set(store.data.tracks.map(track => track.id));
    store.data.settings.queue = store.data.settings.queue.filter(id => ids.has(id));
    try { await store.persist(); } catch (error) { store.data.settings = previous; throw error; }
    return store.data.settings;
  });
  handle('collections', async input => {
    const previous = { playlists: store.data.playlists, favorites: store.data.favorites };
    Object.assign(store.data, cleanCollections(input, store.data.tracks));
    try { await store.persist(); } catch (error) { Object.assign(store.data, previous); throw error; }
    return { playlists: store.data.playlists, favorites: store.data.favorites };
  });
  async function removeTrack(id) {
    if (importing) throw new Error('IMPORT_BUSY');
    if (typeof id !== 'string' || !store.data.tracks.some(track => track.id === id)) throw new Error('INVALID_ID');
    const before = structuredClone(store.data);
    store.data.tracks = store.data.tracks.filter(track => track.id !== id);
    Object.assign(store.data, cleanCollections(store.data, store.data.tracks));
    if (store.data.settings.currentId === id) { store.data.settings.currentId = null; store.data.settings.position = 0; }
    store.data.settings.queue = store.data.settings.queue.filter(trackId => trackId !== id);
    try { await store.persist(); } catch (error) { store.data = before; throw error; }
    refreshMedia();
    return snapshot();
  }
  handle('remove-track',id => { if (trashing) throw new Error('IMPORT_BUSY'); return removeTrack(id); });
  handle('trash-track',async id => {
    if (importing || trashing) throw new Error('IMPORT_BUSY');
    const track = store.data.tracks.find(item => item.id === id);
    if (!track) throw new Error('INVALID_ID');
    trashing = true;
    try {
    // Confirmation happens in the native process using the actual allowlisted file path.
    const english = store.data.settings.language === 'en';
    const result = await dialog.showMessageBox(window,{type:'warning',
      title:english ? 'Move music file to Recycle Bin?' : 'Đưa tệp nhạc vào Thùng rác?',
      message:english ? 'This removes the file from this computer and from Music Green.' : 'Thao tác này xóa tệp khỏi vị trí trên máy và khỏi Music Green.',
      detail:track.path, buttons:english ? ['Cancel','Move to Recycle Bin'] : ['Hủy','Đưa vào Thùng rác'],defaultId:0,cancelId:0,noLink:true});
    if (result.response !== 1) return null;
    await shell.trashItem(track.path);
    return await removeTrack(id);
    } finally { trashing = false; }
  });
  handle('reveal-track',id => {
    const track = store.data.tracks.find(item => item.id === id); if (!track) throw new Error('INVALID_ID');
    shell.showItemInFolder(track.path); return true;
  });
  handle('refresh-library',async () => {
    if (importing || trashing) throw new Error('IMPORT_BUSY');
    await checkAvailability(store.data.tracks); await store.persist(); return snapshot();
  });
  handle('export', async () => {
    const result = await dialog.showSaveDialog(window, { defaultPath: 'music-green-backup.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!result.canceled) await fs.writeFile(result.filePath, JSON.stringify(store.data, null, 2));
    return !result.canceled;
  });
}

app.whenReady().then(async () => {
  store = new LibraryStore(path.join(app.getPath('userData'), 'music-green-data'));
  await store.load(); refreshMedia();
  protocol.handle('green', async request => {
    const url = new URL(request.url);
    const assets = new Set(['index.html','app.js','audio.js','playlist-picker.js','model.js','i18n.js','styles.css','icon.svg']);
    const name = url.pathname.slice(1) || 'index.html';
    if (url.hostname !== 'app' || !assets.has(name)) return new Response('', { status: 404 });
    return net.fetch(pathToFileURL(path.join(rendererRoot, name)).href);
  });
  protocol.handle('green-media', async request => {
    const url = new URL(request.url);
    const filename = url.hostname === 'local' && media.get(url.pathname.slice(1));
    if (!filename || !['GET','HEAD'].includes(request.method)) return new Response('', { status: 404 });
    return mediaResponse(request,filename);
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*','https://*/*','ws://*/*','wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  window = new BrowserWindow({ width: 1480, height: 960, minWidth: 900, minHeight: 680,
    backgroundColor: '#030b08', title: 'Music Green', icon: path.join(__dirname,'app.ico'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== 'green://app/index.html') event.preventDefault(); });
  setupIPC();
  let closing = false;
  window.on('close', event => {
    if (closing) return;
    event.preventDefault(); closing = true;
    window.webContents.executeJavaScript('window.MusicGreenFlush ? window.MusicGreenFlush() : null')
      .catch(error => console.error('Final save',error.message)).finally(() => window.destroy());
  });
  await window.loadURL('green://app/index.html');
  if (process.env.MUSIC_GREEN_SMOKE === '1') require('./tests/smoke-main.cjs').run({ app, window, store, refreshMedia });
}).catch(error => { dialog.showErrorBox('Music Green', String(error.message)); app.quit(); });
app.on('window-all-closed', () => app.quit());
