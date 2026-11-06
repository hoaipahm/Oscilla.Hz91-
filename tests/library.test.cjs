'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { defaults, walk, AUDIO, describe, mergeTracks, cleanCollections, cleanSettings, LibraryStore } = require('../library.cjs');
const { visibleTracks, nextTrack, shuffleNext, formatTime } = require('../renderer/model.js');

test('queue boundaries: no wrap on automatic end, repeat all/one, manual next and previous',() => {
  assert.equal(nextTrack(['a','b'],'b',{automatic:true}),null);
  assert.equal(nextTrack(['a','b'],'b',{automatic:true,repeat:'all'}),'a');
  assert.equal(nextTrack(['a','b'],'b',{automatic:true,repeat:'one'}),'b');
  assert.equal(nextTrack(['a','b'],'b',{repeat:'one'}),'a');
  assert.equal(nextTrack(['a','b'],'a',{direction:-1}),'b');
  assert.equal(nextTrack([],'a'),null);
  assert.equal(nextTrack(['a'],'a',{shuffle:true}),'a');
  assert.equal(nextTrack(['a','b','c'],'b',{shuffle:true,random:() => 0}),'a');
});
test('library filters and alphabetical/numeric/date sorting do not mutate original',() => {
  const state = defaults();
  state.tracks = [{id:'a',title:'Track 10',artist:'ZZ',filename:'a.mp3',addedAt:10,createdAt:50},{id:'b',title:'Track 2',artist:'AA',filename:'b.mp3',addedAt:20,createdAt:30}];
  assert.deepEqual(visibleTracks(state,'library').map(item => item.id),['b','a']);
  state.favorites = ['a']; assert.equal(visibleTracks(state,'favorites')[0].id,'a');
  state.playlists = [{id:'p',trackIds:['b','missing']}]; assert.equal(visibleTracks(state,'p').length,1);
  assert.equal(visibleTracks(state,'library','ZZ')[0].id,'a');
  assert.equal(visibleTracks(state,'library','absent').length,0);
  state.settings.sort = 'created'; assert.equal(visibleTracks(state,'library')[0].id,'a');
  state.settings.sort = 'added'; assert.equal(visibleTracks(state,'library')[0].id,'b');
  assert.equal(state.tracks[0].id,'a');
});
test('settings clamps unsafe values and collections reject invalid / stale IDs',() => {
  const cleaned = cleanSettings({volume:100,synthVolume:-5,theme:'url(http://evil)',position:NaN},defaults().settings);
  assert.equal(cleaned.volume,1); assert.equal(cleaned.synthVolume,0); assert.equal(cleaned.theme,'green'); assert.equal(cleaned.position,0);
  assert.throws(() => cleanCollections({playlists:[{id:'p',name:'',trackIds:[]}],favorites:[]},[]));
  assert.deepEqual(cleanCollections({playlists:[{id:'p',name:' A ',trackIds:['a','a','missing']}],favorites:['a','missing']},[{id:'a'}]),{playlists:[{id:'p',name:'A',trackIds:['a']}],favorites:['a']});
});
test('recursive Unicode scanning, ID stability, atomic concurrent saves and persistence',async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(),'green-test-'));
  try {
    const music = path.join(folder,'Nhạc của Hoài'); await fs.mkdir(music);
    await fs.writeFile(path.join(music,'Tế lễ.MP3'),'fixture'); await fs.writeFile(path.join(music,'ignore.exe'),'fixture');
    const scan = await walk(folder,AUDIO); assert.equal(scan.files.length,1);
    const track = await describe(scan.files[0]); assert.equal(track.title,'Tế lễ');
    assert.equal(mergeTracks([track],[{...track,addedAt:track.addedAt + 100}])[0].addedAt,track.addedAt);
    const store = new LibraryStore(path.join(folder,'store')); await store.load(); store.data.tracks = [track];
    store.data.favorites = [track.id]; store.data.playlists = [{id:'p',name:'My playlist',trackIds:[track.id]}];
    const first = store.persist(); store.data.settings.volume = .23; const second = store.persist();
    await Promise.all([first,second]);
    const restored = new LibraryStore(path.join(folder,'store')); await restored.load();
    assert.equal(restored.data.settings.volume,.23); assert.equal(restored.data.tracks[0].id,track.id);
    assert.equal(restored.data.favorites[0],track.id); assert.equal(restored.data.playlists[0].name,'My playlist');
  } finally { await fs.rm(folder,{recursive:true,force:true}); }
});
test('corrupted database is preserved for recovery',async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(),'green-corrupt-'));
  try {
    await fs.writeFile(path.join(folder,'library.json'),'invalid json');
    const store = new LibraryStore(folder); await store.load();
    assert.equal(store.loadWarning,true); assert.equal(store.data.tracks.length,0);
    assert((await fs.readdir(folder)).some(name => name.startsWith('library-recovery-')));
  } finally { await fs.rm(folder,{recursive:true,force:true}); }
});
test('clock formatting supports long podcasts and invalid durations',() => {
  assert.equal(formatTime(3670),'1:01:10'); assert.equal(formatTime(59.9),'0:59'); assert.equal(formatTime(NaN),'0:00');
});
test('shuffle exhausts every track before repeat and stops at the end when repeat is off',() => {
  const queue = ['a','b','c'];
  const first = shuffleNext(queue,'a',[],{repeat:'off',automatic:true,random:() => 0}); assert.equal(first.id,'b');
  const second = shuffleNext(queue,'b',first.played,{repeat:'off',automatic:true,random:() => 0}); assert.equal(second.id,'c');
  assert.equal(shuffleNext(queue,'c',second.played,{repeat:'off',automatic:true}).id,null);
  const restarted = shuffleNext(queue,'c',second.played,{repeat:'all',automatic:true,random:() => 0}); assert.equal(restarted.id,'a');
  assert.equal(shuffleNext(['a'],'a',['a'],{repeat:'one',automatic:true}).id,'a');
});
