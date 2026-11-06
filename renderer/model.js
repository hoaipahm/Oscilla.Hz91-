(function (root) {
  'use strict';
  function visibleTracks(state, view, search = '') {
    let tracks = state.tracks;
    if (view === 'favorites') tracks = tracks.filter(track => state.favorites.includes(track.id));
    else if (view !== 'library') {
      const list = state.playlists.find(item => item.id === view);
      tracks = (list?.trackIds || []).map(id => tracks.find(track => track.id === id)).filter(Boolean);
    }
    const query = search.trim().toLocaleLowerCase();
    if (query) tracks = tracks.filter(track => [track.title, track.artist, track.album, track.filename].join(' ').toLocaleLowerCase().includes(query));
    const collator = new Intl.Collator(state.settings.language, { numeric: true, sensitivity: 'base' });
    return [...tracks].sort((a, b) => {
      switch (state.settings.sort) {
        case 'artist': return collator.compare(a.artist, b.artist) || collator.compare(a.title, b.title);
        case 'added': return b.addedAt - a.addedAt || collator.compare(a.title, b.title);
        case 'created': return b.createdAt - a.createdAt || collator.compare(a.title, b.title);
        default: return collator.compare(a.title, b.title);
      }
    });
  }
  function nextTrack(queue, currentId, { repeat = 'off', shuffle = false, direction = 1, automatic = false, random = Math.random } = {}) {
    if (!queue.length) return null;
    const index = queue.indexOf(currentId);
    if (automatic && repeat === 'one' && index >= 0) return currentId;
    if (shuffle && queue.length > 1) {
      const candidates = queue.filter(id => id !== currentId);
      return candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))];
    }
    const next = index + direction;
    if (automatic && repeat === 'off' && next >= queue.length) return null;
    return queue[((next % queue.length) + queue.length) % queue.length];
  }
  const formatTime = seconds => {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const total = Math.floor(seconds);
    return total >= 3600 ? `${Math.floor(total / 3600)}:${String(Math.floor(total / 60) % 60).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
      : `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  };
  function shuffleNext(queue,currentId,played = [],options = {}) {
    const seen = new Set(played); if (currentId) seen.add(currentId);
    if (options.automatic && options.repeat === 'one' && queue.includes(currentId)) return {id:currentId,played:[...seen]};
    let available = queue.filter(id => !seen.has(id));
    if (!available.length) {
      if (options.automatic && options.repeat === 'off') return {id:null,played:[...seen]};
      seen.clear(); if (currentId && queue.length > 1) seen.add(currentId);
      available = queue.filter(id => !seen.has(id));
    }
    if (!available.length) return {id:null,played:[...seen]};
    const id = available[Math.floor((options.random || Math.random)() * available.length)];
    seen.add(id); return {id,played:[...seen]};
  }
  const api = { visibleTracks, nextTrack, shuffleNext, formatTime };
  if (typeof module !== 'undefined') module.exports = api;
  else root.GreenModel = api;
})(globalThis);
