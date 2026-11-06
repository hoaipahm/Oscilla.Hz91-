'use strict';
const $ = id => document.getElementById(id);
const { visibleTracks, nextTrack, shuffleNext, formatTime } = GreenModel;
const audio = $('audio');
const engine = new GreenAudio(audio, $('scope'));
const PRESETS = [[32.7,'deep'],[55,'hollow'],[73.4,'hoai'],[110,'solitude'],[174,'fog'],[220,'ritual'],[285,'dusk'],[432,'signal']];
let state;
let view = 'library';
let queue = [];
let currentId = null;
let generation = 0;
let scrubbing = false;
let collectionBusy = false;
let settingsTimer;
let toastTimer;
let cameraIndex = 0;
let cameraLast = Date.now();
let editorAction = null;
let lastPositionSave = 0;
let lastImport = null;
let libraryPage = 0;
let queuePage = 0;
let collectionChain = Promise.resolve();
const failedPlayback = new Set();
let shufflePlayed = [];
let playHistory = [];
let historyIndex = -1;
let pendingPosition = null;
let playlistPicker;
const t = key => GreenWords[key]?.[state?.settings.language === 'en' ? 1 : 0] || key;

function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500); }
function report(error) { console.error(error); toast(t(error.message === 'IMPORT_BUSY' ? 'importBusy' : 'error')); }
function action(callback) { return (...args) => Promise.resolve().then(() => callback(...args)).catch(report); }
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function button(text, title, callback, className = 'icon-button') { const node = element('button', className, text); node.type = 'button'; node.title = t(title); node.setAttribute('aria-label', t(title)); node.addEventListener('click', action(callback)); return node; }
function scheduleSettings() { clearTimeout(settingsTimer); settingsTimer = setTimeout(() => saveSettings().catch(report), 300); }
async function saveSettings() {
  if (!state) return;
  state.settings.currentId = currentId;
  state.settings.position = pendingPosition ?? (Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
  state.settings.queue = [...queue];
  await window.green.saveSettings({ ...state.settings });
}
function applyLanguage() {
  document.documentElement.lang = state.settings.language;
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-placeholder]')) node.placeholder = t(node.dataset.placeholder);
  for (const node of document.querySelectorAll('[data-title]')) { node.title = t(node.dataset.title); node.setAttribute('aria-label', node.title); }
  $('langVi').setAttribute('aria-pressed', state.settings.language === 'vi');
  $('langEn').setAttribute('aria-pressed', state.settings.language === 'en');
  render(); renderSynths(); renderCameraOptions(); renderPlayer(); renderImportReport();
}
function viewTracks() { return visibleTracks(state, view === 'studio' ? 'library' : view, $('search').value); }
function interfaceIcon(name) {
  const paths = {
    edit:'M4 16v4h4L20 8l-4-4L4 16Zm10-10 4 4M4 20h16',
    trash:'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7',
    playlist:'M4 5h12M4 10h12M4 15h7M17 13v8M13 17h8'
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('aria-hidden','true'); svg.classList.add('ui-icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg','path'); path.setAttribute('d',paths[name]); svg.append(path); return svg;
}
function renderNavigation() {
  $('libraryCount').textContent = state.tracks.length;
  $('favoritesCount').textContent = state.favorites.length;
  $('navLibrary').classList.toggle('active', view === 'library'); $('navFavorites').classList.toggle('active', view === 'favorites');
  $('navStudio').classList.toggle('active',view === 'studio');
  const nodes = state.playlists.map(list => {
    const node = button('', 'playlists', () => changeView(list.id), 'playlist-link');
    node.title = list.name; node.append(interfaceIcon('playlist'), element('span','',list.name), element('small','',list.trackIds.length));
    node.classList.toggle('active', view === list.id); return node;
  });
  $('playlistNav').replaceChildren(...nodes);
}
function render() {
  renderNavigation();
  document.body.dataset.view = view === 'studio' ? 'studio' : 'library';
  const playlist = state.playlists.find(list => list.id === view);
  $('viewTitle').textContent = playlist?.name || t(view === 'studio' ? 'studio' : view === 'favorites' ? 'favorites' : 'library');
  $('renamePlaylist').hidden = !playlist; $('deletePlaylist').hidden = !playlist; $('managePlaylist').hidden = !playlist;
  const tracks = viewTracks();
  $('resultCount').textContent = `${tracks.length} ${t('tracks')}`;
  $('empty').hidden = tracks.length > 0; $('emptyAdd').hidden = state.tracks.length > 0;
  $('emptyPlaylistTracks').hidden = !playlist || !state.tracks.length || Boolean($('search').value);
  $('empty').querySelector('h2').textContent = t(playlist ? 'playlistEmptyTitle' : 'empty');
  $('emptyText').textContent = t($('search').value ? 'noResults' : view === 'favorites' ? 'noFavorites' : playlist ? 'noPlaylist' : 'emptyHelp');
  $('playAll').disabled = !tracks.length;
  const dateFormatter = new Intl.DateTimeFormat(state.settings.language === 'vi' ? 'vi-VN' : 'en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
  libraryPage = Math.max(0,Math.min(libraryPage,Math.ceil(tracks.length / 100) - 1));
  const pageTracks = tracks.slice(libraryPage * 100,(libraryPage + 1) * 100);
  $('libraryPage').textContent = `${libraryPage + 1} / ${Math.max(1,Math.ceil(tracks.length / 100))}`;
  $('libraryPrev').disabled = libraryPage === 0; $('libraryNext').disabled = (libraryPage + 1) * 100 >= tracks.length;
  $('libraryPagination').hidden = tracks.length <= 100;
  const rows = pageTracks.map((track, index) => {
    const row = element('div', 'track-row'); row.dataset.id = track.id; row.classList.toggle('current', currentId === track.id);
    const titleCell = element('div','track-meta');
    const playButton = button(track.title, 'play', () => playTrack(track.id, tracks.map(item => item.id)), 'track-title'); playButton.title = track.filename;
    titleCell.append(playButton, element('div',track.missing ? 'track-subtitle missing' : 'track-subtitle',track.missing ? t('missing') : track.extension.slice(1).toUpperCase()));
    const artistCell = element('div','track-meta');
    artistCell.append(element('div','',track.artist || t('unknownArtist')), element('div','track-subtitle',track.album || '—'));
    const actions = element('div','track-actions');
    const favorite = state.favorites.includes(track.id);
    const bookmark = button(favorite ? '◆' : '◇','bookmark',() => toggleFavorite(track.id)); bookmark.setAttribute('aria-pressed',favorite);
    actions.append(bookmark, button('+','addToPlaylist',() => addToPlaylist(track.id)));
    actions.append(button('≡+','playLater',() => enqueue(track.id)),button('⋯','more',() => openTrackMenu(track)));
    row.append(element('span','track-number',currentId === track.id && !audio.paused ? '▶' : String(libraryPage * 100 + index + 1).padStart(2,'0')),titleCell,artistCell,
      element('span','track-date',dateFormatter.format(new Date(track.addedAt))),element('span','track-duration',track.duration ? formatTime(track.duration) : '—'),actions);
    return row;
  });
  $('tracks').replaceChildren(...rows); renderQueue();
}
function changeView(next) { view = next; libraryPage = 0; $('search').value = ''; render(); }
function renderQueue() {
  $('queuePagination').hidden = queue.length <= 50;
  if (!queue.length) { $('queueList').replaceChildren(element('p','queue-empty',t('queueEmpty'))); return; }
  queuePage = Math.max(0,Math.min(queuePage,Math.ceil(queue.length / 50) - 1));
  $('queuePage').textContent = `${queuePage + 1} / ${Math.max(1,Math.ceil(queue.length / 50))}`;
  $('queuePrev').disabled = queuePage === 0; $('queueNext').disabled = (queuePage + 1) * 50 >= queue.length;
  $('queueList').replaceChildren(...queue.slice(queuePage * 50,(queuePage + 1) * 50).map((id,index) => {
    const track = state.tracks.find(item => item.id === id); if (!track) return element('span');
    const row = element('div','queue-item');
    const node = button('','play',() => playTrack(id), 'queue-row');
    node.append(element('small','',String(queuePage * 50 + index + 1).padStart(2,'0')),element('span','',track.title));
    node.classList.toggle('current', id === currentId); row.append(node);
    const up = button('↑','moveUp',() => moveQueued(id,-1),'queue-control'); up.disabled = queue.indexOf(id) === 0;
    const down = button('↓','moveDown',() => moveQueued(id,1),'queue-control'); down.disabled = queue.indexOf(id) === queue.length - 1;
    row.append(up,down,button('×','removeQueue',() => removeQueued(id),'queue-control'));
    return row;
  }));
}
function enqueue(id, next = false) {
  if (next) {
    if (id === currentId) return;
    queue = queue.filter(item => item !== id);
    queue.splice(Math.max(0,queue.indexOf(currentId) + 1),0,id);
  } else {
    if (queue.includes(id)) { toast(t('alreadyQueued')); return; }
    queue.push(id);
  }
  renderQueue(); scheduleSettings(); toast(t('queued'));
}
function moveQueued(id,direction) {
  const index = queue.indexOf(id); const target = index + direction;
  if (index < 0 || target < 0 || target >= queue.length) return;
  [queue[index],queue[target]] = [queue[target],queue[index]];
  renderQueue(); scheduleSettings();
}
function removeQueued(id) { queue = queue.filter(item => item !== id); renderQueue(); scheduleSettings(); }
function adoptSnapshot(result) {
  state.tracks = result.tracks; state.playlists = result.playlists; state.favorites = result.favorites;
  queue = queue.filter(id => state.tracks.some(track => track.id === id));
  if (currentId && !state.tracks.some(track => track.id === currentId)) {
    generation++; pendingPosition = null; audio.pause(); audio.removeAttribute('src'); audio.load(); currentId = null;
  }
  render(); renderPlayer(); scheduleSettings();
}
async function trashTrack(track) {
  const isCurrent = currentId === track.id;
  const resume = !audio.paused; const position = audio.currentTime;
  if (isCurrent) { generation++; audio.pause(); audio.removeAttribute('src'); audio.load(); }
  let result;
  try { result = await window.green.trashTrack(track.id); }
  catch (error) { if (isCurrent) await playTrack(track.id,null,resume,position); throw error; }
  if (result) { adoptSnapshot(result); toast(t('trashed')); }
  else if (isCurrent) await playTrack(track.id,null,resume,position);
}
function openTrackMenu(track) {
  const make = (key,callback,danger = false) => button(t(key),key,async () => { $('trackMenu').close(); await callback(); },danger ? 'menu-action danger' : 'menu-action');
  $('trackMenuTitle').textContent = track.title;
  const actions = [make('playNext',() => enqueue(track.id,true)),make('playLater',() => enqueue(track.id)),make('reveal',() => window.green.revealTrack(track.id))];
  if (!['library','favorites','studio'].includes(view)) actions.push(make('removeFromPlaylist',() => updateCollections(() => {
    const playlist = state.playlists.find(list => list.id === view); if (playlist) playlist.trackIds = playlist.trackIds.filter(id => id !== track.id);
  })));
  actions.push(make('remove',() => confirmDialog('removeQuestion',async () => adoptSnapshot(await window.green.removeTrack(track.id)))),make('trash',() => trashTrack(track),true));
  $('trackMenuActions').replaceChildren(...actions); $('trackMenu').showModal();
}
function renderPlayer() {
  const track = state.tracks.find(item => item.id === currentId);
  $('currentTitle').textContent = track?.title || t('idleTitle'); $('currentTitle').title = track?.title || '';
  $('currentArtist').textContent = track ? track.artist || t('unknownArtist') : 'LOCAL AUDIO // YOUR FREQUENCY';
  if ('mediaSession' in navigator && track) navigator.mediaSession.metadata = new MediaMetadata({title:track.title,artist:track.artist || t('unknownArtist'),album:track.album});
  $('play').textContent = audio.paused ? '▶' : 'Ⅱ'; $('play').title = t(audio.paused ? 'play' : 'pause'); $('play').setAttribute('aria-label',$('play').title);
  const repeatKey = {off:'repeatOff',all:'repeatAll',one:'repeatOne'}[state.settings.repeat];
  $('repeat').textContent = state.settings.repeat === 'one' ? '↻₁' : '↻'; $('repeat').title = t(repeatKey); $('repeat').setAttribute('aria-label',t(repeatKey)); $('repeat').setAttribute('aria-pressed',state.settings.repeat !== 'off');
  $('shuffle').setAttribute('aria-pressed',state.settings.shuffle);
  $('currentBookmark').disabled = !track; $('currentBookmark').textContent = state.favorites.includes(currentId) ? '◆' : '◇';
  $('currentBookmark').setAttribute('aria-pressed',state.favorites.includes(currentId));
  $('signalState').textContent = `● ${t(!audio.paused || engine.synths.size ? 'playing' : currentId ? 'paused' : 'standby')}`;
  $('play').disabled = !state.tracks.length;
  for (const id of ['back','forward','stop','previous','next']) $(id).disabled = !track;
  renderTime(); renderQueue();
}
function renderTime() {
  const duration = audio.duration;
  $('seek').disabled = !Number.isFinite(duration) || duration <= 0;
  if (!scrubbing) { $('seek').value = Number.isFinite(duration) && duration > 0 ? audio.currentTime / duration * 1000 : 0; $('elapsed').textContent = formatTime(audio.currentTime); }
  $('total').textContent = formatTime(duration);
}
async function playTrack(id, ids, start = true, position = 0) {
  const track = state.tracks.find(item => item.id === id); if (!track) return;
  if (track.missing) { toast(t('missingHelp')); return; }
  const request = ++generation;
  pendingPosition = position > 0 ? position : null;
  if (ids) { queue = [...ids]; shufflePlayed = []; playHistory = []; historyIndex = -1; }
  else if (!queue.includes(id)) queue = [id];
  if (start && playHistory[historyIndex] !== id) {
    playHistory = playHistory.slice(0,historyIndex + 1); playHistory.push(id);
    if (playHistory.length > 1000) playHistory.shift(); historyIndex = playHistory.length - 1;
  }
  const changing = currentId !== id || audio.getAttribute('src') !== track.url || Boolean(audio.error);
  currentId = id;
  if (changing) { audio.pause(); audio.src = track.url; audio.load(); queuePage = Math.max(0,Math.floor(queue.indexOf(id) / 50)); }
  audio.playbackRate = state.settings.playbackRate;
  audio.loop = false;
  if (position > 0) {
    if (audio.readyState >= 1) { audio.currentTime = Math.min(position, Math.max(0,audio.duration - .1)); pendingPosition = null; }
    else audio.addEventListener('loadedmetadata', () => { if (generation === request) { audio.currentTime = Math.min(position, Math.max(0,audio.duration - .1)); pendingPosition = null; scheduleSettings(); } },{once:true});
  }
  renderPlayer(); render(); scheduleSettings();
  if (!start) return;
  await engine.ensure();
  if (request !== generation) return;
  try { await audio.play(); }
  catch (error) { if (request === generation && error.name !== 'AbortError') { toast(t('mediaError')); renderPlayer(); } }
  if (request !== generation) return;
  engine.draw(); renderPlayer(); render();
}
async function togglePlay() {
  if (!audio.paused) { generation++; audio.pause(); return; }
  if (!currentId) {
    if (queue.length) { await playTrack(queue[0]); return; }
    const tracks = viewTracks(); if (tracks.length) await playTrack(tracks[0].id,tracks.map(track => track.id)); return;
  }
  await playTrack(currentId);
}
async function advance(direction = 1, automatic = false) {
  const playable = queue.filter(id => { const track = state.tracks.find(item => item.id === id); return track && !track.missing && !failedPlayback.has(id); });
  let next;
  if (direction < 0 && historyIndex > 0 && playable.includes(playHistory[historyIndex - 1])) { historyIndex--; next = playHistory[historyIndex]; }
  else if (direction > 0 && historyIndex < playHistory.length - 1 && !(automatic && state.settings.repeat === 'one')) { historyIndex++; next = playHistory[historyIndex]; }
  else if (state.settings.shuffle && direction > 0) {
    const choice = shuffleNext(playable,currentId,shufflePlayed,{...state.settings,automatic}); next = choice.id; shufflePlayed = choice.played;
  } else next = nextTrack(playable,currentId,{...state.settings,shuffle:false,direction,automatic});
  if (!next) { audio.pause(); audio.currentTime = 0; renderPlayer(); scheduleSettings(); return; }
  if (next === currentId) { audio.currentTime = 0; }
  await playTrack(next);
}
function seekBy(seconds) { if (Number.isFinite(audio.duration)) { audio.currentTime = Math.max(0,Math.min(audio.duration,audio.currentTime + seconds)); renderTime(); scheduleSettings(); } }
async function updateCollections(mutator) {
  const run = async () => {
  collectionBusy = true;
  const before = { playlists: structuredClone(state.playlists), favorites: [...state.favorites] };
  try { mutator(); await window.green.saveCollections({playlists:state.playlists,favorites:state.favorites}); render(); renderPlayer(); }
  catch (error) { Object.assign(state,before); render(); renderPlayer(); throw error; }
  finally { collectionBusy = false; }
  };
  const operation = collectionChain.catch(() => {}).then(run);
  collectionChain = operation; return operation;
}
function toggleFavorite(id) { if (!id) return; return updateCollections(() => { state.favorites = state.favorites.includes(id) ? state.favorites.filter(item => item !== id) : [...state.favorites,id]; }); }

function openEditor({ title, message = '', input = false, value = '', select = false, confirm = false, onSave }) {
  playlistPicker.hide(); $('editorInput').setCustomValidity('');
  $('editorTitle').textContent = t(title); $('editorMessage').textContent = message;
  $('editorInput').hidden = !input; $('editorLabel').hidden = !input;
  $('editorInput').value = value; $('editorInput').required = input; $('editorLabel').textContent = t('playlistName');
  $('playlistSelect').hidden = !select; $('playlistSelectLabel').hidden = !select;
  $('editorSave').textContent = t(confirm ? 'confirm' : 'save');
  editorAction = onSave; $('editor').showModal();
  if (input) $('editorInput').focus(); else $('editorSave').focus();
}
function confirmDialog(message, callback) { openEditor({title:'deleteTitle',message:t(message),confirm:true,onSave:callback}); }
function editPlaylist(playlist) {
  openEditor({title:playlist ? 'renamePlaylist' : 'newPlaylist',input:true,value:playlist?.name || '',onSave:async () => {
    const name = $('editorInput').value.trim(); if (!name) { $('editorInput').setCustomValidity(t('playlistName')); $('editorInput').reportValidity(); return false; }
    const selectedIds = playlist ? null : playlistPicker.values();
    let nextView;
    await updateCollections(() => {
      if (playlist) { state.playlists.find(item => item.id === playlist.id).name = name; }
      else { nextView = crypto.randomUUID(); state.playlists.push({id:nextView,name,trackIds:selectedIds}); }
    });
    if (nextView) changeView(nextView);
  }});
  if (!playlist) playlistPicker.open(state.tracks,[],t);
}
function choosePlaylistTracks() {
  const playlist = state.playlists.find(item => item.id === view);
  if (!playlist) return;
  openEditor({title:'choosePlaylistTracks',message:playlist.name,onSave:async () => {
    const selectedIds = playlistPicker.values();
    await updateCollections(() => {
      const current = state.playlists.find(item => item.id === playlist.id);
      if (current) current.trackIds = selectedIds;
    });
    changeView(playlist.id); toast(t('saved'));
  }});
  playlistPicker.open(state.tracks,playlist.trackIds,t);
}
function addToPlaylist(id) {
  if (!state.playlists.length) { toast(t('noPlaylists')); return; }
  $('playlistSelect').replaceChildren(...state.playlists.map(playlist => { const option = element('option','',playlist.name); option.value = playlist.id; return option; }));
  openEditor({title:'addToPlaylist',select:true,onSave:async () => {
    await updateCollections(() => { const list = state.playlists.find(item => item.id === $('playlistSelect').value); if (list && !list.trackIds.includes(id)) list.trackIds.push(id); });
    toast(t('saved'));
  }});
}
async function importMedia(kind) {
  for (const id of ['addFiles','addFolder','emptyAdd','chooseImages']) $(id).disabled = true;
  $('importProgress').textContent = t('importBusy'); $('importProgress').hidden = false;
  try {
    const result = await window.green.importMusic(kind); if (!result) return;
    state.tracks = result.snapshot.tracks; state.images = result.snapshot.images; failedPlayback.clear();
    if (kind === 'images') render(); else changeView('library');
    renderCameraOptions(); cameraIndex = 0; renderCamera();
    lastImport = result; renderImportReport();
    const duplicate = result.duplicates?.[0];
    const message = result.found === 0 && kind !== 'images' ? `${t('noAudioFound')}${result.skippedFolders ? ' ' + t('warnings') : ''}`
      : duplicate ? `${t('duplicate')}: ${duplicate.title} (${result.duplicates.length} ${t('duplicates')}).${result.relinked.length ? ` ${result.relinked.length} ${t('relinked')}.` : ''}`
      : `${t('imported')} ${result.count} ${t('files')}.${result.failed || result.skippedFolders || result.limitReached ? ' ' + t('warnings') : ''}`;
    toast(message);
  } finally {
    for (const id of ['addFiles','addFolder','emptyAdd','chooseImages']) $(id).disabled = false;
    $('importProgress').hidden = true;
  }
}
function renderImportReport() {
  if (!lastImport) return;
  $('importReport').hidden = false;
  $('importSummary').textContent = `${t('importReport')}: ${lastImport.found ?? lastImport.count} ${t('foundFiles')} · ${lastImport.count} ${t('newFiles')} · ${lastImport.duplicates.length} ${t('duplicates')} · ${lastImport.relinked.length} ${t('relinked')}`;
  const lines = lastImport.duplicates.slice(0,100).map(item => element('p','',`${t('duplicate')}: ${item.filename} → ${item.title}`));
  if (lastImport.selectedFolder) lines.unshift(element('p','',`${t('selectedFolder')}: ${lastImport.selectedFolder}`));
  for (const filename of (lastImport.failureNames || []).slice(0,100)) lines.push(element('p','missing',`${t('failedFiles')}: ${filename}`));
  if (lastImport.failed || lastImport.skippedFolders || lastImport.limitReached) lines.push(element('p','missing',t('warnings')));
  $('importDetails').replaceChildren(...lines);
}
function renderSynths() {
  $('synthPads').replaceChildren(...PRESETS.map(([frequency,label]) => {
    const node = button('',label,async () => { await engine.toggleSynth(frequency); $('frequencyNumber').replaceChildren(document.createTextNode(String(frequency)),element('span','','Hz')); renderSynths(); renderPlayer(); });
    node.className = 'synth-pad'; node.append(document.createTextNode(String(frequency)),element('span','unit',' Hz'),element('small','',t(label)));
    node.setAttribute('aria-pressed',engine.synths.has(frequency)); return node;
  }));
}
function renderCameraOptions() {
  $('cameraSelect').replaceChildren(...state.images.map((image,index) => {
    const option = element('option','',`${String(index + 1).padStart(2,'0')} / ${state.images.length} — ${image.title}`); option.value = index; return option;
  }));
  $('cameraSelect').disabled = !state.images.length; $('nextImage').disabled = state.images.length < 2;
}
function renderCamera() {
  const image = state.images[cameraIndex];
  $('cameraImage').hidden = !image; $('cameraEmpty').hidden = Boolean(image);
  if (image) { $('cameraImage').src = image.url; $('cameraImage').alt = image.title; $('cameraCaption').textContent = image.title; $('cameraSelect').value = cameraIndex; }
  else { $('cameraImage').removeAttribute('src'); $('cameraCaption').textContent = ''; }
  $('cameraNumber').textContent = image ? `CAM ${String(cameraIndex + 1).padStart(2,'0')} / ${state.images.length}` : 'CAM -- / --';
  cameraLast = Date.now();
}
function nextImage() { if (state.images.length) { cameraIndex = (cameraIndex + 1) % state.images.length; renderCamera(); } }

function bindEvents() {
  $('navLibrary').onclick = () => changeView('library'); $('navFavorites').onclick = () => changeView('favorites');
  $('navStudio').onclick = () => { changeView('studio'); window.scrollTo(0,0); engine.draw(); };
  document.querySelector('.brand').onclick = event => { event.preventDefault(); changeView('library'); };
  $('managePlaylist').onclick = $('emptyPlaylistTracks').onclick = choosePlaylistTracks;
  $('newPlaylist').onclick = () => editPlaylist(); $('renamePlaylist').onclick = () => editPlaylist(state.playlists.find(list => list.id === view));
  $('closeTrackMenu').onclick = () => $('trackMenu').close();
  $('clearQueue').onclick = () => { queue = []; renderQueue(); scheduleSettings(); };
  $('deletePlaylist').onclick = () => confirmDialog('deleteQuestion',async () => { await updateCollections(() => { state.playlists = state.playlists.filter(list => list.id !== view); }); changeView('library'); });
  $('editorCancel').onclick = () => $('editor').close(); $('editorInput').oninput = () => $('editorInput').setCustomValidity('');
  $('editorForm').onsubmit = async event => {
    event.preventDefault(); $('editorSave').disabled = true;
    try { if (await editorAction() !== false) $('editor').close(); } catch (error) { report(error); }
    finally { $('editorSave').disabled = false; }
  };
  $('addFiles').onclick = action(() => importMedia('files')); $('addFolder').onclick = $('emptyAdd').onclick = action(() => importMedia('folder'));
  $('chooseImages').onclick = action(() => importMedia('images'));
  $('refreshLibrary').onclick = action(async () => { adoptSnapshot(await window.green.refreshLibrary()); toast(t('saved')); });
  window.green.onImportProgress(progress => { $('importProgress').textContent = `${t('importBusy')} ${progress.done} / ${progress.total}`; });
  $('search').oninput = () => { libraryPage = 0; render(); };
  $('libraryPrev').onclick = () => { libraryPage--; render(); }; $('libraryNext').onclick = () => { libraryPage++; render(); };
  $('queuePrev').onclick = () => { queuePage--; renderQueue(); }; $('queueNext').onclick = () => { queuePage++; renderQueue(); };
  $('sort').onchange = () => { state.settings.sort = $('sort').value; render(); scheduleSettings(); };
  $('playAll').onclick = action(() => { const tracks = viewTracks(); return playTrack(tracks[0]?.id,tracks.map(track => track.id)); });
  $('langVi').onclick = () => setLanguage('vi'); $('langEn').onclick = () => setLanguage('en');
  $('theme').onchange = () => { state.settings.theme = $('theme').value; document.body.dataset.theme = state.settings.theme; engine.draw(); scheduleSettings(); };
  $('play').onclick = action(togglePlay); $('back').onclick = () => seekBy(-10); $('forward').onclick = () => seekBy(10);
  $('previous').onclick = action(() => advance(-1)); $('next').onclick = action(() => advance());
  $('stop').onclick = () => { generation++; pendingPosition = null; audio.pause(); audio.currentTime = 0; renderTime(); scheduleSettings(); };
  $('shuffle').onclick = () => { state.settings.shuffle = !state.settings.shuffle; shufflePlayed = currentId ? [currentId] : []; renderPlayer(); scheduleSettings(); };
  $('repeat').onclick = () => { state.settings.repeat = {off:'all',all:'one',one:'off'}[state.settings.repeat]; renderPlayer(); scheduleSettings(); };
  $('currentBookmark').onclick = action(() => toggleFavorite(currentId));
  $('volume').oninput = () => { state.settings.volume = Number($('volume').value) / 100; engine.setVolume(state.settings.volume); $('volumeValue').textContent = `${$('volume').value}%`; scheduleSettings(); };
  $('speed').onchange = () => { state.settings.playbackRate = Number($('speed').value); audio.playbackRate = state.settings.playbackRate; audio.preservesPitch = true; scheduleSettings(); };
  $('seek').oninput = () => { scrubbing = true; $('elapsed').textContent = formatTime(Number($('seek').value) / 1000 * audio.duration); };
  $('seek').onchange = () => { if (Number.isFinite(audio.duration)) audio.currentTime = Number($('seek').value) / 1000 * audio.duration; scrubbing = false; renderTime(); scheduleSettings(); };
  $('seek').addEventListener('pointercancel',() => { scrubbing = false; renderTime(); });
  $('seek').onblur = () => { scrubbing = false; renderTime(); };
  audio.addEventListener('loadedmetadata', () => { const track = state.tracks.find(item => item.id === currentId); if (track && Number.isFinite(audio.duration)) track.duration = audio.duration; renderPlayer(); render(); });
  audio.addEventListener('timeupdate',() => { renderTime(); if (Date.now() - lastPositionSave > 10000) { lastPositionSave = Date.now(); scheduleSettings(); } });
  for (const name of ['play','pause','ended']) audio.addEventListener(name,() => { renderPlayer(); render(); engine.draw(); scheduleSettings(); });
  audio.addEventListener('ended',action(() => advance(1,true)));
  audio.addEventListener('error',() => { if (audio.getAttribute('src')) { failedPlayback.add(currentId); toast(t('mediaError')); renderPlayer(); } });
  $('waveMode').onchange = () => { state.settings.waveform = $('waveMode').value; engine.mode = state.settings.waveform; engine.draw(); scheduleSettings(); };
  $('synthVolume').oninput = () => { state.settings.synthVolume = Number($('synthVolume').value) / 100; engine.setSynthVolume(state.settings.synthVolume); $('synthVolumeValue').textContent = `${$('synthVolume').value}%`; scheduleSettings(); };
  $('synthOff').onclick = () => { engine.stopSynths(); renderSynths(); renderPlayer(); };
  $('customSynth').onclick = action(async () => { if (!$('customFrequency').reportValidity()) return; const frequency = Number($('customFrequency').value); await engine.toggleSynth(frequency); $('frequencyNumber').replaceChildren(document.createTextNode(String(frequency)),element('span','','Hz')); renderSynths(); renderPlayer(); });
  $('nextImage').onclick = nextImage;
  $('cameraSelect').onchange = () => { cameraIndex = Number($('cameraSelect').value); renderCamera(); };
  $('cameraInterval').onchange = () => { state.settings.cameraInterval = Number($('cameraInterval').value); cameraLast = Date.now(); scheduleSettings(); };
  $('cameraAuto').onchange = () => { cameraLast = Date.now(); };
  $('cameraImage').onerror = () => { $('cameraImage').hidden = true; $('cameraEmpty').hidden = false; $('cameraCaption').textContent = t('imageError'); };
  $('export').onclick = action(async () => { if (await window.green.exportLibrary()) toast(t('exportDone')); });
  document.addEventListener('keydown',event => {
    if (event.ctrlKey && event.key.toLowerCase() === 'o') { event.preventDefault(); action(() => importMedia('files'))(); return; }
    if ($('editor').open || $('trackMenu').open || ['INPUT','TEXTAREA','SELECT','BUTTON'].includes(event.target.tagName)) return;
    if (event.code === 'Space') { event.preventDefault(); action(togglePlay)(); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); seekBy(-10); }
    if (event.key === 'ArrowRight') { event.preventDefault(); seekBy(10); }
  });
  if ('mediaSession' in navigator) {
    for (const [name, callback] of Object.entries({play:() => playTrack(currentId),pause:() => audio.pause(),previoustrack:() => advance(-1),nexttrack:() => advance(),seekbackward:() => seekBy(-10),seekforward:() => seekBy(10),stop:() => $('stop').click()})) {
      navigator.mediaSession.setActionHandler(name,action(callback));
    }
  }
}
function setLanguage(language) { state.settings.language = language; $('toast').hidden = true; applyLanguage(); scheduleSettings(); }
async function initialize() {
  state = await window.green.bootstrap();
  document.body.dataset.theme = state.settings.theme; $('theme').value = state.settings.theme;
  $('sort').value = state.settings.sort; $('waveMode').value = state.settings.waveform; engine.mode = state.settings.waveform;
  $('volume').value = state.settings.volume * 100; $('volumeValue').textContent = `${Math.round(state.settings.volume * 100)}%`; engine.setVolume(state.settings.volume);
  $('synthVolume').value = state.settings.synthVolume * 100; $('synthVolumeValue').textContent = `${Math.round(state.settings.synthVolume * 100)}%`; engine.setSynthVolume(state.settings.synthVolume);
  $('cameraInterval').value = state.settings.cameraInterval;
  $('speed').value = state.settings.playbackRate; audio.playbackRate = state.settings.playbackRate; audio.preservesPitch = true;
  $('cameraAuto').checked = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  playlistPicker = new GreenPlaylistPicker();
  $('renamePlaylist').replaceChildren(interfaceIcon('edit')); $('deletePlaylist').replaceChildren(interfaceIcon('trash'));
  bindEvents(); applyLanguage(); renderCamera();
  const initialId = state.settings.currentId;
  queue = (state.settings.queue || []).filter(id => state.tracks.some(track => track.id === id));
  if (state.tracks.some(track => track.id === initialId)) await playTrack(initialId,null,false,state.settings.position);
  if (state.loadWarning) toast(t('loadWarning'));
  setInterval(() => {
    $('cameraClock').textContent = new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date());
    if (!document.hidden && $('cameraAuto').checked && Date.now() - cameraLast >= state.settings.cameraInterval * 1000) nextImage();
  },1000);
  engine.draw();
  window.MusicGreenFlush = async () => { clearTimeout(settingsTimer); await saveSettings(); };
  window.MUSIC_GREEN_READY = true;
}
initialize().catch(report);
