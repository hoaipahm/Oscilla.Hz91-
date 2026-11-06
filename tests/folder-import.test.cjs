'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AUDIO, walk } = require('../library.cjs');
const { prepareMusicImport } = require('../importer.cjs');

async function withFolder(callback) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(),'green-folder-import-'));
  try { await callback(folder); }
  finally { await fs.rm(folder,{recursive:true,force:true}); }
}

test('folder import recursively finds supported audio with Unicode names and uppercase extensions',() => withFolder(async folder => {
  const nested = path.join(folder,'Nh\u1ea1c c\u1ee7a Ho\u00e0i','\u0110\u00eam');
  await fs.mkdir(nested,{recursive:true});
  const expected = [
    path.join(folder,'APT..mp3'),
    path.join(nested,'S\u01a0N THU\u1ef6 TR\u00d9NG M\u00c2Y.MP3'),
    path.join(nested,'Another Track.FLAC')
  ];
  await Promise.all(expected.map((filename,index) => fs.writeFile(filename,`audio fixture ${index}`)));
  await fs.writeFile(path.join(nested,'photo.png'),'image fixture');
  await fs.writeFile(path.join(folder,'notes.txt'),'not audio');
  await fs.writeFile(path.join(folder,'archive.mp3.zip'),'not audio');
  await fs.mkdir(path.join(folder,'empty'));
  const scan = await walk(folder,AUDIO);
  assert.deepEqual(new Set(scan.files),new Set(expected));
  assert.equal(scan.skippedFolders,0);
  assert.equal(scan.limitReached,false);
  const parsed = [];
  const result = await prepareMusicImport([],scan.files,async filename => {
    parsed.push(filename);
    return {common:{artist:'Fixture'},format:{duration:24}};
  });
  assert.equal(result.added,3);
  assert.deepEqual(result.failures,[]);
  assert.deepEqual(new Set(parsed),new Set(expected));
  assert(result.tracks.some(track => track.filename === 'S\u01a0N THU\u1ef6 TR\u00d9NG M\u00c2Y.MP3' && track.extension === '.mp3'));
}));

test('folder reimport skips identical and renamed audio without losing existing tracks',() => withFolder(async folder => {
  const nested = path.join(folder,'playlist');
  await fs.mkdir(nested);
  const original = path.join(folder,'First.MP3');
  const renamed = path.join(nested,'Different filename.mp3');
  const other = path.join(nested,'Second.wav');
  await fs.writeFile(original,'first unique audio');
  await fs.copyFile(original,renamed);
  await fs.writeFile(other,'second unique audio');
  await fs.writeFile(path.join(nested,'cover.jpg'),'not audio');
  const scan = await walk(folder,AUDIO);
  const parser = async () => ({common:{},format:{duration:24}});
  const first = await prepareMusicImport([],scan.files,parser);
  assert.equal(scan.files.length,3);
  assert.equal(first.added,2);
  assert.equal(first.duplicates.length,1);
  assert.deepEqual(first.failures,[]);
  const originalIds = first.tracks.map(track => track.id);
  const second = await prepareMusicImport(first.tracks,scan.files,parser);
  assert.equal(second.added,0);
  assert.equal(second.duplicates.length,3);
  assert.equal(second.tracks.length,2);
  assert.deepEqual(second.tracks.map(track => track.id),originalIds);
  assert.deepEqual(second.failures,[]);
}));
