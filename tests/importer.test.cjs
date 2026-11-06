'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { prepareMusicImport } = require('../importer.cjs');
const { LibraryStore, checkAvailability, cleanSettings, defaults } = require('../library.cjs');

async function withFolder(callback) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(),'green-import-'));
  try { await callback(folder); } finally { await fs.rm(folder,{recursive:true,force:true}); }
}
test('same path and renamed byte-identical file are rejected, including within one batch',() => withFolder(async folder => {
  const one = path.join(folder,'My music.mp3'); const renamed = path.join(folder,'renamed.mp3');
  await fs.writeFile(one,Buffer.from('same audio payload')); await fs.copyFile(one,renamed);
  const first = await prepareMusicImport([],[one,renamed]);
  assert.equal(first.added,1); assert.equal(first.duplicates.length,1); assert.equal(first.tracks.length,1);
  const second = await prepareMusicImport(first.tracks,[renamed,one]);
  assert.equal(second.added,0); assert.equal(second.duplicates.length,2); assert.equal(second.tracks.length,1);
}));
test('MP3 metadata changes do not bypass identical-audio duplicate detection',() => withFolder(async folder => {
  const payload = Buffer.from('mpeg audio bytes in this isolated fingerprint fixture');
  const tagged = path.join(folder,'tagged.mp3'); const raw = path.join(folder,'raw.mp3');
  const header = Buffer.from([73,68,51,3,0,0,0,0,0,5]);
  await fs.writeFile(tagged,Buffer.concat([header,Buffer.from('TITLE'),payload,Buffer.from('TAG'),Buffer.alloc(125)]));
  await fs.writeFile(raw,payload);
  const result = await prepareMusicImport([],[tagged,raw]);
  assert.equal(result.tracks.length,1); assert.equal(result.duplicates.length,1);
}));
test('moved file relinks after restart and keeps bookmark, playlist ID and added date',() => withFolder(async folder => {
  const original = path.join(folder,'original.wav'); const renamed = path.join(folder,'new name.wav');
  await fs.writeFile(original,'unique waveform bytes');
  const imported = await prepareMusicImport([],[original]);
  const track = imported.tracks[0];
  const store = new LibraryStore(path.join(folder,'state')); await store.load();
  store.data.tracks = imported.tracks; store.data.favorites = [track.id]; store.data.playlists = [{id:'p',name:'Keep',trackIds:[track.id]}];
  await store.persist(); await fs.rename(original,renamed);
  const restored = new LibraryStore(path.join(folder,'state')); await restored.load();
  assert.equal(restored.data.tracks[0].missing,true);
  const result = await prepareMusicImport(restored.data.tracks,[renamed]);
  assert.equal(result.added,0); assert.equal(result.relinked.length,1); assert.equal(result.tracks.length,1);
  assert.equal(result.tracks[0].id,track.id); assert.equal(result.tracks[0].path,renamed); assert.equal(result.tracks[0].missing,false);
  assert.equal(result.tracks[0].addedAt,track.addedAt);
  restored.data.tracks = result.tracks; await restored.persist();
  const again = new LibraryStore(path.join(folder,'state')); await again.load();
  assert.equal(again.data.favorites[0],again.data.tracks[0].id); assert.equal(again.data.playlists[0].trackIds[0],again.data.tracks[0].id);
}));
test('same title with different audio is preserved; missing input reported without losing good tracks',() => withFolder(async folder => {
  const first = path.join(folder,'first.wav'); const second = path.join(folder,'second.wav');
  await fs.writeFile(first,'audio A'); await fs.writeFile(second,'audio B');
  const parser = async () => ({common:{title:'Same title'},format:{duration:3}});
  const result = await prepareMusicImport([],[first,second,path.join(folder,'missing.wav')],parser);
  assert.equal(result.tracks.length,2); assert.equal(result.failures.length,1); assert.equal(result.duplicates.length,0);
  await fs.unlink(first); await checkAvailability(result.tracks);
  assert.equal(result.tracks[0].missing,true); assert.equal(result.tracks[1].missing,false);
}));
test('legacy records get content fingerprints without new entries',() => withFolder(async folder => {
  const file = path.join(folder,'old.wav'); await fs.writeFile(file,'old bytes');
  const first = await prepareMusicImport([],[file]); delete first.tracks[0].contentHash; delete first.tracks[0].audioHash;
  const result = await prepareMusicImport(first.tracks,[file]);
  assert.equal(result.tracks.length,1); assert.equal(result.duplicates.length,1); assert(result.tracks[0].contentHash);
}));
test('persistent queue sanitizes duplicates, unknown types and excessive payload',() => {
  const id = 'a'.repeat(64);
  assert.deepEqual(cleanSettings({queue:[id,id,'arbitrary-path',null]},defaults().settings).queue,[id]);
  assert.deepEqual(cleanSettings({queue:Array(20001).fill(id)},defaults().settings).queue,[]);
});
test('empty files and invalid audio are skipped with no mutation of existing library',() => withFolder(async folder => {
  const empty = path.join(folder,'empty.mp3'); const corrupt = path.join(folder,'corrupt.mp3');
  await fs.writeFile(empty,''); await fs.writeFile(corrupt,'not audio');
  const result = await prepareMusicImport([],[empty,corrupt],async () => { throw new Error('bad format'); });
  assert.equal(result.added,0); assert.equal(result.failures.length,2); assert.equal(result.tracks.length,0);
}));
