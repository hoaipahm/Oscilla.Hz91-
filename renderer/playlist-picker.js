'use strict';
window.GreenPlaylistPicker = class {
  constructor() {
    this.root = document.getElementById('playlistTrackSection');
    this.search = document.getElementById('playlistTrackSearch');
    this.list = document.getElementById('playlistTrackList');
    this.count = document.getElementById('playlistSelectionCount');
    this.hint = document.getElementById('playlistPickerHint');
    this.selected = new Set(); this.tracks = [];
    this.search.addEventListener('input', () => this.render());
    document.getElementById('playlistSelectAll').addEventListener('click', () => {
      for (const track of this.filtered()) this.selected.add(track.id);
      this.render();
    });
    document.getElementById('playlistClearSelection').addEventListener('click', () => { this.selected.clear(); this.render(); });
  }
  open(tracks, ids, translate) {
    this.translate = translate;
    const collator = new Intl.Collator(document.documentElement.lang,{numeric:true,sensitivity:'base'});
    this.tracks = [...tracks].sort((a,b) => collator.compare(a.title,b.title));
    const available = new Set(tracks.map(track => track.id));
    this.selected = new Set(ids.filter(id => available.has(id)));
    this.search.value = ''; this.root.hidden = false; this.render();
  }
  hide() { this.root.hidden = true; }
  values() { return [...this.selected]; }
  filtered() {
    const query = this.search.value.trim().toLocaleLowerCase();
    return this.tracks.filter(track => `${track.title} ${track.artist} ${track.filename}`.toLocaleLowerCase().includes(query));
  }
  updateCount() { this.count.textContent = `${this.selected.size} / ${this.tracks.length} ${this.translate('tracksSelected')}`; }
  render() {
    const filtered = this.filtered();
    const shown = filtered.slice(0,100);
    const rows = shown.map(track => {
      const label = document.createElement('label'); label.className = 'playlist-pick-row';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = track.id;
      checkbox.checked = this.selected.has(track.id);
      checkbox.addEventListener('change', () => { if(checkbox.checked) this.selected.add(track.id); else this.selected.delete(track.id); this.updateCount(); });
      const info = document.createElement('span'); info.className = 'playlist-pick-info';
      const title = document.createElement('span'); title.textContent = track.title; title.title = track.title;
      const artist = document.createElement('small'); artist.textContent = track.artist || this.translate('unknownArtist');
      info.append(title,artist); label.append(checkbox,info); return label;
    });
    if (!rows.length) { const empty = document.createElement('p'); empty.className = 'tiny muted'; empty.textContent = this.translate(this.tracks.length ? 'noResults' : 'emptyHelp'); rows.push(empty); }
    this.list.replaceChildren(...rows);
    this.hint.textContent = `${shown.length} / ${filtered.length} ${this.translate('pickerResults')}`;
    this.updateCount();
  }
};
