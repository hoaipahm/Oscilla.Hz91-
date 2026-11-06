'use strict';
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const AUDIO = new Set(['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus', '.webm']);
const IMAGES = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']);
const MAX_ITEMS = 20000;
const fileId = filename => createHash('sha256').update(path.resolve(filename).toLowerCase()).digest('hex');
const defaults = () => ({ version: 1, tracks: [], images: [], playlists: [], favorites: [], settings: {
  language: 'vi', theme: 'green', volume: .65, synthVolume: .12, repeat: 'off', shuffle: false,
  sort: 'title', cameraInterval: 18, waveform: 'hybrid', currentId: null, position: 0, playbackRate: 1, queue: []
} });

async function fingerprints(filename, stat) {
  let start = 0; let end = stat.size;
  // Ignore common MP3 ID3 tags as well: changing tags must not bypass duplicate detection.
  if (path.extname(filename).toLowerCase() === '.mp3') {
    const handle = await fs.open(filename,'r');
    try {
      const header = Buffer.alloc(10); await handle.read(header,0,10,0);
      if (header.toString('ascii',0,3) === 'ID3' && [...header.subarray(6,10)].every(value => value < 128)) {
        const size = (header[6] << 21) | (header[7] << 14) | (header[8] << 7) | header[9];
        start = Math.min(end,10 + size + (header[3] === 4 && (header[5] & 16) ? 10 : 0));
      }
      if (stat.size >= 128) {
        const tail = Buffer.alloc(3); await handle.read(tail,0,3,stat.size - 128);
        if (tail.toString('ascii') === 'TAG') end -= 128;
      }
    } finally { await handle.close(); }
  }
  const content = createHash('sha256'); const payload = createHash('sha256');
  let offset = 0;
  for await (const chunk of createReadStream(filename)) {
    content.update(chunk);
    const left = Math.max(0,start - offset); const right = Math.min(chunk.length,end - offset);
    if (right > left) payload.update(chunk.subarray(left,right));
    offset += chunk.length;
  }
  const after = await fs.stat(filename);
  if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('FILE_CHANGED_DURING_SCAN');
  return { contentHash:content.digest('hex'), audioHash:end > start ? payload.digest('hex') : null };
}

async function walk(folder, extensions) {
  const files = [];
  const pending = [folder];
  const warnings = [];
  while (pending.length && files.length < MAX_ITEMS) {
    const directory = pending.pop();
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch { warnings.push(directory); continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(filename);
      else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) files.push(filename);
      if (files.length >= MAX_ITEMS) break;
    }
  }
  return { files, skippedFolders: warnings.length, limitReached: files.length >= MAX_ITEMS };
}

async function describe(filename, metadataParser) {
  const stat = await fs.stat(filename);
  if (!stat.isFile() || stat.size === 0) throw new Error('EMPTY_OR_INVALID_FILE');
  const extension = path.extname(filename).toLowerCase();
  const record = { id: fileId(filename), path: path.resolve(filename), filename: path.basename(filename),
    title: path.basename(filename).slice(0, -extension.length), artist: '', album: '', duration: 0,
    createdAt: stat.birthtimeMs || stat.mtimeMs, modifiedAt: stat.mtimeMs, addedAt: Date.now(), size:stat.size, extension, missing:false };
  if (AUDIO.has(extension)) Object.assign(record,await fingerprints(filename,stat));
  if (metadataParser) {
    try {
      const metadata = await metadataParser(filename, { duration: false, skipCovers: true });
      record.title = String(metadata.common.title || record.title).slice(0, 1000);
      record.artist = String(metadata.common.artist || '').slice(0, 1000);
      record.album = String(metadata.common.album || '').slice(0, 1000);
      record.duration = Number.isFinite(metadata.format.duration) ? metadata.format.duration : 0;
    } catch { throw new Error('INVALID_AUDIO_FILE'); }
  }
  return record;
}

function mergeTracks(existing, incoming) {
  const tracks = new Map(existing.map(track => [track.id, track]));
  for (const track of incoming) tracks.set(track.id, { ...track, addedAt: tracks.get(track.id)?.addedAt || track.addedAt });
  return [...tracks.values()];
}

function cleanCollections(input, tracks) {
  const ids = new Set(tracks.map(track => track.id));
  if (!input || !Array.isArray(input.playlists) || input.playlists.length > 500 || !Array.isArray(input.favorites)) {
    throw new Error('INVALID_COLLECTIONS');
  }
  const playlists = input.playlists.map(playlist => {
    if (!playlist || typeof playlist.name !== 'string' || !playlist.name.trim() || playlist.name.length > 100 ||
      typeof playlist.id !== 'string' || playlist.id.length > 100 || !Array.isArray(playlist.trackIds) || playlist.trackIds.length > MAX_ITEMS) {
      throw new Error('INVALID_PLAYLIST');
    }
    return { id: playlist.id, name: playlist.name.trim(), trackIds: [...new Set(playlist.trackIds.filter(id => ids.has(id)))] };
  });
  if (new Set(playlists.map(list => list.id)).size !== playlists.length) throw new Error('DUPLICATE_PLAYLIST');
  return { playlists, favorites: [...new Set(input.favorites.filter(id => ids.has(id)))] };
}

function cleanSettings(input, previous) {
  const result = { ...previous };
  for (const [key, choices] of Object.entries({ language: ['vi','en'], theme: ['green','amber','ice'],
    sort: ['title','artist','added','created'], repeat: ['off','all','one'], waveform: ['hybrid','waves','bars'] })) {
    if (choices.includes(input[key])) result[key] = input[key];
  }
  for (const [key, min, max] of [['volume',0,1],['synthVolume',0,.4],['cameraInterval',5,120],['position',0,864000],['playbackRate',.25,2]]) {
    if (Number.isFinite(input[key])) result[key] = Math.min(max, Math.max(min, input[key]));
  }
  if (typeof input.shuffle === 'boolean') result.shuffle = input.shuffle;
  if (input.currentId === null || /^[a-f0-9]{64}$/.test(input.currentId || '')) result.currentId = input.currentId;
  if (Array.isArray(input.queue) && input.queue.length <= MAX_ITEMS) result.queue = [...new Set(input.queue.filter(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)))];
  return result;
}

async function checkAvailability(tracks) {
  for (let index = 0; index < tracks.length; index += 32) {
    await Promise.all(tracks.slice(index,index + 32).map(async track => {
      try { const stat = await fs.stat(track.path); track.missing = !stat.isFile(); }
      catch { track.missing = true; }
    }));
  }
}

class LibraryStore {
  constructor(directory) { this.directory = directory; this.file = path.join(directory, 'library.json'); this.data = defaults(); this.writes = Promise.resolve(); }
  async load() {
    await fs.mkdir(this.directory, { recursive: true });
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (raw.version !== 1 || !Array.isArray(raw.tracks) || !Array.isArray(raw.images)) throw new Error('INVALID_LIBRARY');
      const validRecord = (record, extensions) => record && typeof record.path === 'string' && path.isAbsolute(record.path) &&
        typeof record.id === 'string' && /^[a-f0-9]{64}$/.test(record.id) && typeof record.title === 'string' &&
        extensions.has(path.extname(record.path).toLowerCase());
      this.data.tracks = raw.tracks.filter(item => validRecord(item, AUDIO)).slice(0, MAX_ITEMS);
      this.data.images = raw.images.filter(item => validRecord(item, IMAGES)).slice(0, MAX_ITEMS);
      Object.assign(this.data, cleanCollections(raw, this.data.tracks));
      this.data.settings = cleanSettings(raw.settings || {}, this.data.settings);
      const ids = new Set(this.data.tracks.map(track => track.id));
      this.data.settings.queue = this.data.settings.queue.filter(id => ids.has(id));
      await checkAvailability(this.data.tracks);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // Keep the damaged file intact for manual recovery; never replace it silently.
        this.data = defaults();
        this.loadWarning = true;
        await fs.copyFile(this.file, path.join(this.directory, `library-recovery-${Date.now()}.json`));
      }
    }
    return this.data;
  }
  persist() {
    const serialized = JSON.stringify(this.data);
    const write = this.writes.catch(() => {}).then(async () => {
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, serialized, 'utf8');
      await fs.rename(temporary, this.file);
    });
    this.writes = write;
    return write;
  }
}

module.exports = { AUDIO, IMAGES, MAX_ITEMS, fileId, defaults, walk, describe, mergeTracks, cleanCollections, cleanSettings, LibraryStore, fingerprints, checkAvailability };
