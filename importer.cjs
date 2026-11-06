'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { describe, fingerprints, MAX_ITEMS } = require('./library.cjs');
const keyPath = filename => path.resolve(filename).toLowerCase();

async function prepareMusicImport(existing, files, parser, progress = () => {}) {
  const tracks = structuredClone(existing);
  // Upgrade old indexes lazily and invalidate cached fingerprints if the original changed.
  for (let index = 0; index < tracks.length; index += 8) {
    await Promise.all(tracks.slice(index,index + 8).map(async track => {
      try {
        const stat = await fs.stat(track.path); track.missing = !stat.isFile();
        if (!track.contentHash || track.modifiedAt !== stat.mtimeMs || track.size !== stat.size) {
          Object.assign(track,await fingerprints(track.path,stat),{modifiedAt:stat.mtimeMs,size:stat.size});
        }
      } catch { track.missing = true; }
    }));
  }
  const byPath = new Map(tracks.map(track => [keyPath(track.path),track]));
  const byHash = new Map();
  for (const track of tracks) {
    if (track.contentHash) byHash.set(track.contentHash,track);
    if (track.audioHash) byHash.set(track.audioHash,track);
  }
  const duplicates = []; const failures = []; const relinked = [];
  let added = 0; let limitReached = false;
  for (let index = 0; index < files.length; index += 4) {
    const batch = await Promise.allSettled(files.slice(index,index + 4).map(file => describe(file,parser)));
    for (let offset = 0; offset < batch.length; offset++) {
      const entry = batch[offset]; const filename = files[index + offset];
      if (entry.status !== 'fulfilled') { failures.push(path.basename(filename)); continue; }
      const candidate = entry.value;
      const samePath = byPath.get(keyPath(candidate.path));
      const duplicate = byHash.get(candidate.contentHash) || (candidate.audioHash && byHash.get(candidate.audioHash)) || samePath;
      if (duplicate) {
        duplicates.push({filename:candidate.filename,title:duplicate.title});
        if (duplicate.missing) {
          // Repair a moved/renamed file without losing bookmarks, playlist membership or stable ID.
          byPath.delete(keyPath(duplicate.path));
          const stable = {id:duplicate.id,addedAt:duplicate.addedAt};
          Object.assign(duplicate,candidate,stable);
          byPath.set(keyPath(duplicate.path),duplicate); relinked.push(candidate.filename);
        } else if (samePath === duplicate) {
          const stable = {id:duplicate.id,addedAt:duplicate.addedAt}; Object.assign(duplicate,candidate,stable);
        }
        continue;
      }
      if (tracks.length >= MAX_ITEMS) { limitReached = true; continue; }
      tracks.push(candidate); byPath.set(keyPath(candidate.path),candidate);
      byHash.set(candidate.contentHash,candidate); if (candidate.audioHash) byHash.set(candidate.audioHash,candidate); added++;
    }
    progress({done:Math.min(index + 4,files.length),total:files.length});
  }
  return {tracks,added,duplicates,failures,relinked,limitReached};
}
module.exports = {prepareMusicImport};
