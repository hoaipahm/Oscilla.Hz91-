#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::Accessor;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

const CREATE_NO_WINDOW: u32 = 0x08000000;
const MAX_ITEMS: usize = 20000;

const AUDIO_EXTS: &[&str] = &[".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac", ".opus", ".webm"];
const IMAGE_EXTS: &[&str] = &[".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"];

const INDEX_HTML: &str = include_str!("../../renderer/index.html");
const APP_JS: &str = include_str!("../../renderer/app.js");
const AUDIO_JS: &str = include_str!("../../renderer/audio.js");
const PLAYLIST_PICKER_JS: &str = include_str!("../../renderer/playlist-picker.js");
const MODEL_JS: &str = include_str!("../../renderer/model.js");
const I18N_JS: &str = include_str!("../../renderer/i18n.js");
const STYLES_CSS: &str = include_str!("../../renderer/styles.css");
const ICON_SVG: &str = include_str!("../../renderer/icon.svg");
const APP_ICO: &[u8] = include_bytes!("../../app.ico");

const MG_WINDOW_EXE: &[u8] = include_bytes!("../assets/mg-window.exe");
const WV2_CORE_DLL: &[u8] = include_bytes!("../assets/Microsoft.Web.WebView2.Core.dll");
const WV2_WINFORMS_DLL: &[u8] = include_bytes!("../assets/Microsoft.Web.WebView2.WinForms.dll");
const WV2_LOADER_DLL: &[u8] = include_bytes!("../assets/WebView2Loader.dll");

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaRecord {
    id: String,
    #[serde(default)]
    path: String,
    filename: String,
    title: String,
    #[serde(default)]
    artist: String,
    #[serde(default)]
    album: String,
    #[serde(default)]
    duration: f64,
    #[serde(default)]
    created_at: f64,
    #[serde(default)]
    modified_at: f64,
    #[serde(default)]
    added_at: f64,
    #[serde(default)]
    size: u64,
    extension: String,
    #[serde(default)]
    missing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    audio_hash: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Playlist {
    id: String,
    name: String,
    track_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    language: String,
    theme: String,
    volume: f64,
    synth_volume: f64,
    repeat: String,
    shuffle: bool,
    sort: String,
    camera_interval: f64,
    waveform: String,
    current_id: Option<String>,
    position: f64,
    playback_rate: f64,
    queue: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            language: "vi".to_string(),
            theme: "green".to_string(),
            volume: 0.65,
            synth_volume: 0.12,
            repeat: "off".to_string(),
            shuffle: false,
            sort: "title".to_string(),
            camera_interval: 18.0,
            waveform: "hybrid".to_string(),
            current_id: None,
            position: 0.0,
            playback_rate: 1.0,
            queue: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryData {
    version: u32,
    tracks: Vec<MediaRecord>,
    images: Vec<MediaRecord>,
    playlists: Vec<Playlist>,
    favorites: Vec<String>,
    settings: Settings,
}

impl Default for LibraryData {
    fn default() -> Self {
        Self {
            version: 1,
            tracks: Vec::new(),
            images: Vec::new(),
            playlists: Vec::new(),
            favorites: Vec::new(),
            settings: Settings::default(),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
struct ImportProgress {
    done: usize,
    total: usize,
}

struct AppState {
    directory: PathBuf,
    file: PathBuf,
    data: LibraryData,
    load_warning: bool,
    media: HashMap<String, String>,
    port: u16,
    progress: ImportProgress,
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn time_to_ms(t: std::io::Result<SystemTime>) -> f64 {
    t.ok()
        .and_then(|s| s.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or_else(now_ms)
}

fn normalize_path_str(p: &Path) -> String {
    let abs = fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let s = abs.to_string_lossy().to_string();
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        stripped.to_string()
    } else {
        s
    }
}

fn key_path(p: &str) -> String {
    normalize_path_str(Path::new(p)).to_lowercase()
}

fn hex_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn file_id(filename: &Path) -> String {
    let norm = normalize_path_str(filename).to_lowercase();
    hex_sha256(norm.as_bytes())
}

fn ext_lower(p: &Path) -> String {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_lowercase()))
        .unwrap_or_default()
}

fn is_audio_ext(ext: &str) -> bool {
    AUDIO_EXTS.contains(&ext)
}

fn is_image_ext(ext: &str) -> bool {
    IMAGE_EXTS.contains(&ext)
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn fingerprints(filename: &Path, size: u64, mtime_ms: f64) -> Result<(String, Option<String>), String> {
    let mut start: u64 = 0;
    let mut end: u64 = size;
    let ext = ext_lower(filename);

    if ext == ".mp3" {
        let mut f = File::open(filename).map_err(|e| e.to_string())?;
        let mut header = [0u8; 10];
        if f.read(&mut header).unwrap_or(0) == 10 {
            if &header[0..3] == b"ID3" && header[6..10].iter().all(|&v| v < 128) {
                let tag_size = ((header[6] as u64) << 21)
                    | ((header[7] as u64) << 14)
                    | ((header[8] as u64) << 7)
                    | (header[9] as u64);
                let footer = if header[3] == 4 && (header[5] & 16) != 0 { 10 } else { 0 };
                start = end.min(10 + tag_size + footer);
            }
        }
        if size >= 128 {
            if f.seek(SeekFrom::Start(size - 128)).is_ok() {
                let mut tail = [0u8; 3];
                if f.read(&mut tail).unwrap_or(0) == 3 && &tail == b"TAG" {
                    end = end.saturating_sub(128);
                }
            }
        }
    }

    let mut f = File::open(filename).map_err(|e| e.to_string())?;
    let mut content = Sha256::new();
    let mut payload = Sha256::new();
    let mut offset: u64 = 0;
    let mut buf = vec![0u8; 64 * 1024];

    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        let chunk = &buf[..n];
        content.update(chunk);
        let left = start.saturating_sub(offset).min(n as u64) as usize;
        let right = end.saturating_sub(offset).min(n as u64) as usize;
        if right > left {
            payload.update(&chunk[left..right]);
        }
        offset += n as u64;
    }

    let after = fs::metadata(filename).map_err(|e| e.to_string())?;
    let after_mtime = time_to_ms(after.modified());
    if after.len() != size || (after_mtime - mtime_ms).abs() > 1.0 {
        return Err("FILE_CHANGED_DURING_SCAN".to_string());
    }

    let content_hash = format!("{:x}", content.finalize());
    let audio_hash = if end > start {
        Some(format!("{:x}", payload.finalize()))
    } else {
        None
    };
    Ok((content_hash, audio_hash))
}

fn describe(filename: &Path, parse_audio: bool) -> Result<MediaRecord, String> {
    let meta = fs::metadata(filename).map_err(|_| "EMPTY_OR_INVALID_FILE".to_string())?;
    if !meta.is_file() || meta.len() == 0 {
        return Err("EMPTY_OR_INVALID_FILE".to_string());
    }
    let extension = ext_lower(filename);
    let norm_path = normalize_path_str(filename);
    let base_name = filename
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let stem = if base_name.len() > extension.len() {
        base_name[..base_name.len() - extension.len()].to_string()
    } else {
        base_name.clone()
    };

    let modified_at = time_to_ms(meta.modified());
    let created_at = meta
        .created()
        .ok()
        .and_then(|s| s.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(modified_at);

    let mut record = MediaRecord {
        id: file_id(filename),
        path: norm_path,
        filename: base_name,
        title: stem,
        artist: String::new(),
        album: String::new(),
        duration: 0.0,
        created_at,
        modified_at,
        added_at: now_ms(),
        size: meta.len(),
        extension: extension.clone(),
        missing: false,
        content_hash: None,
        audio_hash: None,
    };

    if is_audio_ext(&extension) {
        let (ch, ah) = fingerprints(filename, meta.len(), modified_at)?;
        record.content_hash = Some(ch);
        record.audio_hash = ah;
    }

    if parse_audio {
        let tagged = Probe::open(filename)
            .map_err(|_| "INVALID_AUDIO_FILE".to_string())?
            .read()
            .map_err(|_| "INVALID_AUDIO_FILE".to_string())?;

        let props = tagged.properties();
        let dur = props.duration().as_secs_f64();
        if dur.is_finite() && dur > 0.0 {
            record.duration = dur;
        }

        if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
            if let Some(t) = tag.title() {
                let s = t.trim();
                if !s.is_empty() {
                    record.title = s.chars().take(1000).collect();
                }
            }
            if let Some(a) = tag.artist() {
                record.artist = a.trim().chars().take(1000).collect();
            }
            if let Some(al) = tag.album() {
                record.album = al.trim().chars().take(1000).collect();
            }
        }
    }

    Ok(record)
}

fn walk_folder(folder: &Path, audio_mode: bool) -> (Vec<PathBuf>, usize, bool) {
    let mut files = Vec::new();
    let mut pending = vec![folder.to_path_buf()];
    let mut skipped_folders = 0usize;

    while let Some(dir) = pending.pop() {
        if files.len() >= MAX_ITEMS {
            break;
        }
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => {
                skipped_folders += 1;
                continue;
            }
        };
        for entry in entries.flatten() {
            let ft = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if ft.is_symlink() {
                continue;
            }
            let path = entry.path();
            if ft.is_dir() {
                pending.push(path);
            } else if ft.is_file() {
                let ext = ext_lower(&path);
                let matched = if audio_mode {
                    is_audio_ext(&ext)
                } else {
                    is_image_ext(&ext)
                };
                if matched {
                    files.push(path);
                }
            }
            if files.len() >= MAX_ITEMS {
                break;
            }
        }
    }
    let limit_reached = files.len() >= MAX_ITEMS;
    (files, skipped_folders, limit_reached)
}

fn clean_collections(input: &Value, tracks: &[MediaRecord]) -> Result<(Vec<Playlist>, Vec<String>), String> {
    let ids: HashSet<&str> = tracks.iter().map(|t| t.id.as_str()).collect();
    let playlists_val = input
        .get("playlists")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "INVALID_COLLECTIONS".to_string())?;
    let favorites_val = input
        .get("favorites")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "INVALID_COLLECTIONS".to_string())?;

    if playlists_val.len() > 500 {
        return Err("INVALID_COLLECTIONS".to_string());
    }

    let mut playlists = Vec::new();
    let mut seen_playlist_ids = HashSet::new();

    for p in playlists_val {
        let id = p.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
        let track_ids_arr = p
            .get("trackIds")
            .and_then(|v| v.as_array())
            .ok_or_else(|| "INVALID_PLAYLIST".to_string())?;

        if name.is_empty()
            || name.chars().count() > 100
            || id.is_empty()
            || id.len() > 100
            || track_ids_arr.len() > MAX_ITEMS
        {
            return Err("INVALID_PLAYLIST".to_string());
        }
        if !seen_playlist_ids.insert(id.to_string()) {
            return Err("DUPLICATE_PLAYLIST".to_string());
        }

        let mut track_ids = Vec::new();
        let mut seen_t = HashSet::new();
        for tid in track_ids_arr {
            if let Some(s) = tid.as_str() {
                if ids.contains(s) && seen_t.insert(s.to_string()) {
                    track_ids.push(s.to_string());
                }
            }
        }
        playlists.push(Playlist {
            id: id.to_string(),
            name: name.to_string(),
            track_ids,
        });
    }

    let mut favorites = Vec::new();
    let mut seen_fav = HashSet::new();
    for f in favorites_val {
        if let Some(s) = f.as_str() {
            if ids.contains(s) && seen_fav.insert(s.to_string()) {
                favorites.push(s.to_string());
            }
        }
    }

    Ok((playlists, favorites))
}

fn clean_settings(input: &Value, previous: &Settings) -> Settings {
    let mut res = previous.clone();
    if let Some(s) = input.get("language").and_then(|v| v.as_str()) {
        if ["vi", "en"].contains(&s) {
            res.language = s.to_string();
        }
    }
    if let Some(s) = input.get("theme").and_then(|v| v.as_str()) {
        if ["green", "amber", "ice"].contains(&s) {
            res.theme = s.to_string();
        }
    }
    if let Some(s) = input.get("sort").and_then(|v| v.as_str()) {
        if ["title", "artist", "added", "created"].contains(&s) {
            res.sort = s.to_string();
        }
    }
    if let Some(s) = input.get("repeat").and_then(|v| v.as_str()) {
        if ["off", "all", "one"].contains(&s) {
            res.repeat = s.to_string();
        }
    }
    if let Some(s) = input.get("waveform").and_then(|v| v.as_str()) {
        if ["hybrid", "waves", "bars"].contains(&s) {
            res.waveform = s.to_string();
        }
    }
    if let Some(v) = input.get("volume").and_then(|v| v.as_f64()) {
        if v.is_finite() {
            res.volume = v.clamp(0.0, 1.0);
        }
    }
    if let Some(v) = input.get("synthVolume").and_then(|v| v.as_f64()) {
        if v.is_finite() {
            res.synth_volume = v.clamp(0.0, 0.4);
        }
    }
    if let Some(v) = input.get("cameraInterval").and_then(|v| v.as_f64()) {
        if v.is_finite() {
            res.camera_interval = v.clamp(5.0, 120.0);
        }
    }
    if let Some(v) = input.get("position").and_then(|v| v.as_f64()) {
        if v.is_finite() {
            res.position = v.clamp(0.0, 864000.0);
        }
    }
    if let Some(v) = input.get("playbackRate").and_then(|v| v.as_f64()) {
        if v.is_finite() {
            res.playback_rate = v.clamp(0.25, 2.0);
        }
    }
    if let Some(b) = input.get("shuffle").and_then(|v| v.as_bool()) {
        res.shuffle = b;
    }
    if let Some(cid) = input.get("currentId") {
        if cid.is_null() {
            res.current_id = None;
        } else if let Some(s) = cid.as_str() {
            if is_hex64(s) {
                res.current_id = Some(s.to_string());
            }
        }
    }
    if let Some(q) = input.get("queue").and_then(|v| v.as_array()) {
        if q.len() <= MAX_ITEMS {
            let mut seen = HashSet::new();
            let mut queue = Vec::new();
            for item in q {
                if let Some(s) = item.as_str() {
                    if is_hex64(s) && seen.insert(s.to_string()) {
                        queue.push(s.to_string());
                    }
                }
            }
            res.queue = queue;
        }
    }
    res
}

fn check_availability(tracks: &mut [MediaRecord]) {
    for track in tracks.iter_mut() {
        track.missing = !Path::new(&track.path).is_file();
    }
}

impl AppState {
    fn new(directory: PathBuf, port: u16) -> Self {
        let file = directory.join("library.json");
        let mut state = Self {
            directory,
            file,
            data: LibraryData::default(),
            load_warning: false,
            media: HashMap::new(),
            port,
            progress: ImportProgress::default(),
        };
        state.load();
        state.refresh_media();
        state
    }

    fn load(&mut self) {
        let _ = fs::create_dir_all(&self.directory);
        if !self.file.exists() {
            return;
        }
        let result: Result<(), String> = (|| {
            let raw_str = fs::read_to_string(&self.file).map_err(|e| e.to_string())?;
            let raw: Value = serde_json::from_str(&raw_str).map_err(|e| e.to_string())?;
            if raw.get("version").and_then(|v| v.as_u64()) != Some(1)
                || !raw.get("tracks").map(|v| v.is_array()).unwrap_or(false)
                || !raw.get("images").map(|v| v.is_array()).unwrap_or(false)
            {
                return Err("INVALID_LIBRARY".to_string());
            }
            let parsed: LibraryData = serde_json::from_value(raw.clone()).map_err(|e| e.to_string())?;
            let tracks: Vec<MediaRecord> = parsed
                .tracks
                .into_iter()
                .filter(|r| {
                    Path::new(&r.path).is_absolute()
                        && is_hex64(&r.id)
                        && is_audio_ext(&ext_lower(Path::new(&r.path)))
                })
                .take(MAX_ITEMS)
                .collect();
            let images: Vec<MediaRecord> = parsed
                .images
                .into_iter()
                .filter(|r| {
                    Path::new(&r.path).is_absolute()
                        && is_hex64(&r.id)
                        && is_image_ext(&ext_lower(Path::new(&r.path)))
                })
                .take(MAX_ITEMS)
                .collect();

            let (playlists, favorites) = clean_collections(&raw, &tracks)?;
            let settings_val = raw.get("settings").cloned().unwrap_or_else(|| json!({}));
            let mut settings = clean_settings(&settings_val, &Settings::default());
            let track_ids: HashSet<&str> = tracks.iter().map(|t| t.id.as_str()).collect();
            settings.queue.retain(|id| track_ids.contains(id.as_str()));

            self.data = LibraryData {
                version: 1,
                tracks,
                images,
                playlists,
                favorites,
                settings,
            };
            check_availability(&mut self.data.tracks);
            Ok(())
        })();

        if result.is_err() {
            self.data = LibraryData::default();
            self.load_warning = true;
            let recovery = self
                .directory
                .join(format!("library-recovery-{}.json", now_ms() as u64));
            let _ = fs::copy(&self.file, recovery);
        }
    }

    fn persist(&self) -> Result<(), String> {
        let serialized = serde_json::to_string(&self.data).map_err(|e| e.to_string())?;
        let tmp = self.file.with_extension(format!("json.{}.tmp", now_ms() as u64));
        fs::write(&tmp, serialized).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &self.file).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn refresh_media(&mut self) {
        self.media.clear();
        for item in self.data.tracks.iter().chain(self.data.images.iter()) {
            self.media.insert(item.id.clone(), item.path.clone());
        }
    }

    fn snapshot(&self) -> Value {
        let port = self.port;
        let map_item = |item: &MediaRecord| -> Value {
            let mut val = serde_json::to_value(item).unwrap_or_else(|_| json!({}));
            if let Some(obj) = val.as_object_mut() {
                obj.remove("path");
                obj.insert(
                    "url".to_string(),
                    Value::String(format!("http://127.0.0.1:{}/media/{}", port, item.id)),
                );
            }
            val
        };
        let tracks: Vec<Value> = self.data.tracks.iter().map(map_item).collect();
        let images: Vec<Value> = self.data.images.iter().map(map_item).collect();
        json!({
            "version": self.data.version,
            "tracks": tracks,
            "images": images,
            "playlists": self.data.playlists,
            "favorites": self.data.favorites,
            "settings": self.data.settings,
            "loadWarning": self.load_warning
        })
    }
}

fn run_powershell_dialog(script: &str) -> Result<String, String> {
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-STA", "-WindowStyle", "Hidden", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn pick_files_or_folder(kind: &str, english: bool) -> Result<Vec<PathBuf>, String> {
    let image_mode = kind == "images";
    let folder_mode = kind != "files";
    let title = if image_mode {
        if english {
            "Music Green - Choose image folder"
        } else {
            "Music Green - Chọn thư mục ảnh"
        }
    } else if folder_mode {
        if english {
            "Music Green - Choose music folder"
        } else {
            "Music Green - Chọn thư mục chứa nhạc"
        }
    } else if english {
        "Music Green - Add tracks"
    } else {
        "Music Green - Thêm bài hát"
    };

    let script = if folder_mode {
        format!(
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
             Add-Type -AssemblyName System.Windows.Forms; \
             $d = New-Object System.Windows.Forms.FolderBrowserDialog; \
             $d.Description = '{}'; \
             $d.ShowNewFolderButton = $false; \
             if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{ Write-Output $d.SelectedPath }}",
            title.replace('\'', "''")
        )
    } else {
        format!(
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
             Add-Type -AssemblyName System.Windows.Forms; \
             $d = New-Object System.Windows.Forms.OpenFileDialog; \
             $d.Title = '{}'; \
             $d.Multiselect = $true; \
             $d.Filter = 'Audio (*.mp3;*.wav;*.flac;*.ogg;*.m4a;*.aac;*.opus;*.webm)|*.mp3;*.wav;*.flac;*.ogg;*.m4a;*.aac;*.opus;*.webm'; \
             if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{ $d.FileNames | ForEach-Object {{ Write-Output $_ }} }}",
            title.replace('\'', "''")
        )
    };

    let out = run_powershell_dialog(&script)?;
    if out.is_empty() {
        return Ok(Vec::new());
    }
    Ok(out
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(PathBuf::from)
        .collect())
}

fn confirm_and_trash_file(track_path: &str, english: bool) -> Result<bool, String> {
    let title = if english {
        "Move music file to Recycle Bin?"
    } else {
        "Đưa tệp nhạc vào Thùng rác?"
    };
    let message = if english {
        "This removes the file from this computer and from Music Green."
    } else {
        "Thao tác này xóa tệp khỏi vị trí trên máy và khỏi Music Green."
    };
    let script = format!(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
         Add-Type -AssemblyName System.Windows.Forms; \
         Add-Type -AssemblyName Microsoft.VisualBasic; \
         $res = [System.Windows.Forms.MessageBox]::Show('{}\\n\\n{}', '{}', [System.Windows.Forms.MessageBoxButtons]::OKCancel, [System.Windows.Forms.MessageBoxIcon]::Warning); \
         if ($res -eq [System.Windows.Forms.DialogResult]::OK) {{ \
           [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('{}', [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin); \
           Write-Output 'TRASHED' \
         }}",
        message.replace('\'', "''"),
        track_path.replace('\'', "''"),
        title.replace('\'', "''"),
        track_path.replace('\'', "''")
    );
    let out = run_powershell_dialog(&script)?;
    Ok(out.contains("TRASHED"))
}

fn save_backup_dialog(serialized: &str) -> Result<bool, String> {
    let script = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
        Add-Type -AssemblyName System.Windows.Forms; \
        $d = New-Object System.Windows.Forms.SaveFileDialog; \
        $d.FileName = 'music-green-backup.json'; \
        $d.Filter = 'JSON (*.json)|*.json'; \
        if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }";
    let out = run_powershell_dialog(script)?;
    if out.is_empty() {
        return Ok(false);
    }
    fs::write(out.trim(), serialized).map_err(|e| e.to_string())?;
    Ok(true)
}

fn prepare_music_import(
    existing: &[MediaRecord],
    files: &[PathBuf],
    state: &Arc<Mutex<AppState>>,
) -> (Vec<MediaRecord>, usize, Vec<Value>, Vec<String>, Vec<String>, bool) {
    let mut tracks = existing.to_vec();
    for track in tracks.iter_mut() {
        let p = Path::new(&track.path);
        match fs::metadata(p) {
            Ok(meta) if meta.is_file() => {
                track.missing = false;
                let mtime = time_to_ms(meta.modified());
                if track.content_hash.is_none()
                    || (track.modified_at - mtime).abs() > 1.0
                    || track.size != meta.len()
                {
                    if let Ok((ch, ah)) = fingerprints(p, meta.len(), mtime) {
                        track.content_hash = Some(ch);
                        track.audio_hash = ah;
                        track.modified_at = mtime;
                        track.size = meta.len();
                    }
                }
            }
            _ => {
                track.missing = true;
            }
        }
    }

    let mut duplicates = Vec::new();
    let mut failures = Vec::new();
    let mut relinked = Vec::new();
    let mut added = 0usize;
    let mut limit_reached = false;
    let total = files.len();

    for (idx, file) in files.iter().enumerate() {
        let candidate = match describe(file, true) {
            Ok(c) => c,
            Err(_) => {
                let name = file
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("unknown")
                    .to_string();
                failures.push(name);
                if let Ok(mut st) = state.lock() {
                    st.progress = ImportProgress { done: idx + 1, total };
                }
                continue;
            }
        };

        let cand_key = key_path(&candidate.path);
        let same_path_idx = tracks.iter().position(|t| key_path(&t.path) == cand_key);
        let hash_idx = tracks.iter().position(|t| {
            (t.content_hash.is_some() && t.content_hash == candidate.content_hash)
                || (candidate.audio_hash.is_some() && t.audio_hash == candidate.audio_hash)
        });

        let dup_idx = hash_idx.or(same_path_idx);
        if let Some(di) = dup_idx {
            let dup_title = tracks[di].title.clone();
            duplicates.push(json!({
                "filename": candidate.filename,
                "title": dup_title
            }));
            if tracks[di].missing {
                let stable_id = tracks[di].id.clone();
                let stable_added = tracks[di].added_at;
                let relink_name = candidate.filename.clone();
                tracks[di] = candidate;
                tracks[di].id = stable_id;
                tracks[di].added_at = stable_added;
                relinked.push(relink_name);
            } else if same_path_idx == Some(di) {
                let stable_id = tracks[di].id.clone();
                let stable_added = tracks[di].added_at;
                tracks[di] = candidate;
                tracks[di].id = stable_id;
                tracks[di].added_at = stable_added;
            }
        } else if tracks.len() >= MAX_ITEMS {
            limit_reached = true;
        } else {
            tracks.push(candidate);
            added += 1;
        }

        if let Ok(mut st) = state.lock() {
            st.progress = ImportProgress { done: idx + 1, total };
        }
    }

    (tracks, added, duplicates, failures, relinked, limit_reached)
}

fn handle_rpc(
    channel: &str,
    args: &[Value],
    state: &Arc<Mutex<AppState>>,
    busy: &Arc<AtomicBool>,
) -> Result<Value, String> {
    match channel {
        "bootstrap" => {
            let st = state.lock().map_err(|_| "LOCK_ERROR".to_string())?;
            Ok(st.snapshot())
        }
        "progress" => {
            let st = state.lock().map_err(|_| "LOCK_ERROR".to_string())?;
            Ok(json!({ "done": st.progress.done, "total": st.progress.total }))
        }
        "settings" => {
            let input = args.first().ok_or_else(|| "INVALID_SETTINGS".to_string())?;
            if !input.is_object() {
                return Err("INVALID_SETTINGS".to_string());
            }
            let mut st = state.lock().map_err(|_| "LOCK_ERROR".to_string())?;
            let prev = st.data.settings.clone();
            let mut next = clean_settings(input, &prev);
            let ids: HashSet<String> = st.data.tracks.iter().map(|t| t.id.clone()).collect();
            next.queue.retain(|id| ids.contains(id));
            st.data.settings = next;
            if let Err(e) = st.persist() {
                st.data.settings = prev;
                return Err(e);
            }
            Ok(serde_json::to_value(&st.data.settings).unwrap_or_else(|_| json!({})))
        }
        "collections" => {
            let input = args.first().ok_or_else(|| "INVALID_COLLECTIONS".to_string())?;
            let mut st = state.lock().map_err(|_| "LOCK_ERROR".to_string())?;
            let (playlists, favorites) = clean_collections(input, &st.data.tracks)?;
            let prev_p = st.data.playlists.clone();
            let prev_f = st.data.favorites.clone();
            st.data.playlists = playlists;
            st.data.favorites = favorites;
            if let Err(e) = st.persist() {
                st.data.playlists = prev_p;
                st.data.favorites = prev_f;
                return Err(e);
            }
            Ok(json!({
                "playlists": st.data.playlists,
                "favorites": st.data.favorites
            }))
        }
        "remove-track" => {
            if busy.load(Ordering::SeqCst) {
                return Err("IMPORT_BUSY".to_string());
            }
            let id = args
                .first()
                .and_then(|v| v.as_str())
                .ok_or_else(|| "INVALID_ID".to_string())?;
            let mut st = state.lock().map_err(|_| "LOCK_ERROR".to_string())?;
            if !st.data.tracks.iter().any(|t| t.id == id) {
                return Err("INVALID_ID".to_string());
            }
            let before = st.data.clone();
            st.data.tracks.retain(|t| t.id != id);
            for pl in st.data.playlists.iter_mut() {
                pl.track_ids.retain(|tid| tid != id);
            }
            st.data.favorites.retain(|fid| fid != id);
            if st.data.settings.current_id.as_deref() == Some(id) {
                st.data.settings.current_id = None;
                st.data.settings.position = 0.0;
            }
            st.data.settings.queue.retain(|qid| qid != id);
            if let Err(e) = st.persist() {
                st.data = before;
                return Err(e);
            }
            st.refresh_media();
            Ok(st.snapshot())
        }
        "trash-track" => {
            if busy
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
            {
                return Err("IMPORT_BUSY".to_string());
            }
            let result = (|| {
                let id = args
                    .first()
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "INVALID_ID".to_string())?;
                let (track_path, english) = {
                    let st = state.lock().map_err(|_| "LOCK_ERROR".to_string())?;
                    let tr = st
                        .data
                        .tracks
                        .iter()
                        .find(|t| t.id == id)
                        .ok_or_else(|| "INVALID_ID".to_string())?;
                    (tr.path.clone(), st.data.settings.language == "en")
                };
                if !confirm_and_trash_file(&track_path, english)? {
                    return Ok(Value::Null);
                }
                let mut st = state.lock().map_err(|_| "LOCK_ERROR".to_string())?;
                let before = st.data.clone();
                st.data.tracks.retain(|t| t.id != id);
                for pl in st.data.playlists.iter_mut() {
                    pl.track_ids.retain(|tid| tid != id);
                }
                st.data.favorites.retain(|fid| fid != id);
                if st.data.settings.current_id.as_deref() == Some(id) {
                    st.data.settings.current_id = None;
                    st.data.settings.position = 0.0;
                }
                st.data.settings.queue.retain(|qid| qid != id);
                if let Err(e) = st.persist() {
                    st.data = before;
                    return Err(e);
                }
                st.refresh_media();
                Ok(st.snapshot())
            })();
            busy.store(false, Ordering::SeqCst);
            result
        }
        "reveal-track" => {
            let id = args
                .first()
                .and_then(|v| v.as_str())
                .ok_or_else(|| "INVALID_ID".to_string())?;
            let track_path = {
                let st = state.lock().map_err(|_| "LOCK_ERROR".to_string())?;
                let tr = st
                    .data
                    .tracks
                    .iter()
                    .find(|t| t.id == id)
                    .ok_or_else(|| "INVALID_ID".to_string())?;
                tr.path.clone()
            };
            let _ = Command::new("explorer.exe")
                .arg(format!("/select,{}", track_path))
                .spawn();
            Ok(Value::Bool(true))
        }
        "refresh-library" => {
            if busy.load(Ordering::SeqCst) {
                return Err("IMPORT_BUSY".to_string());
            }
            let mut st = state.lock().map_err(|_| "LOCK_ERROR".to_string())?;
            check_availability(&mut st.data.tracks);
            st.persist()?;
            Ok(st.snapshot())
        }
        "export" => {
            let serialized = {
                let st = state.lock().map_err(|_| "LOCK_ERROR".to_string())?;
                serde_json::to_string_pretty(&st.data).map_err(|e| e.to_string())?
            };
            let ok = save_backup_dialog(&serialized)?;
            Ok(Value::Bool(ok))
        }
        "import" => {
            let kind = args
                .first()
                .and_then(|v| v.as_str())
                .ok_or_else(|| "INVALID_IMPORT".to_string())?;
            if !["files", "folder", "images"].contains(&kind) {
                return Err("INVALID_IMPORT".to_string());
            }
            if busy
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
            {
                return Err("IMPORT_BUSY".to_string());
            }
            let result = (|| {
                let (english, existing_tracks) = {
                    let mut st = state.lock().map_err(|_| "LOCK_ERROR".to_string())?;
                    st.progress = ImportProgress { done: 0, total: 0 };
                    (st.data.settings.language == "en", st.data.tracks.clone())
                };
                let picked = pick_files_or_folder(kind, english)?;
                if picked.is_empty() {
                    return Ok(Value::Null);
                }
                let image_mode = kind == "images";
                let folder_mode = kind != "files";
                let selected_folder = if folder_mode {
                    Some(picked[0].to_string_lossy().to_string())
                } else {
                    None
                };

                let (scanned_files, skipped_folders, scan_limit) = if folder_mode {
                    walk_folder(&picked[0], !image_mode)
                } else {
                    let filtered: Vec<PathBuf> = picked
                        .into_iter()
                        .filter(|p| is_audio_ext(&ext_lower(p)))
                        .collect();
                    (filtered, 0, false)
                };

                let found = scanned_files.len();
                if image_mode {
                    let mut images = Vec::new();
                    let mut failures = Vec::new();
                    for (idx, file) in scanned_files.iter().enumerate() {
                        match describe(file, false) {
                            Ok(rec) => images.push(rec),
                            Err(_) => failures.push("image".to_string()),
                        }
                        if let Ok(mut st) = state.lock() {
                            st.progress = ImportProgress {
                                done: idx + 1,
                                total: found,
                            };
                        }
                    }
                    let mut st = state.lock().map_err(|_| "LOCK_ERROR".to_string())?;
                    let before = st.data.clone();
                    let added = images.len();
                    st.data.images = images;
                    if let Err(e) = st.persist() {
                        st.data = before;
                        return Err(e);
                    }
                    st.refresh_media();
                    Ok(json!({
                        "snapshot": st.snapshot(),
                        "count": added,
                        "found": found,
                        "selectedFolder": selected_folder,
                        "duplicates": [],
                        "relinked": [],
                        "failed": failures.len(),
                        "failureNames": failures,
                        "skippedFolders": skipped_folders,
                        "limitReached": scan_limit
                    }))
                } else {
                    let (tracks, added, duplicates, failures, relinked, prep_limit) =
                        prepare_music_import(&existing_tracks, &scanned_files, state);
                    let mut st = state.lock().map_err(|_| "LOCK_ERROR".to_string())?;
                    let before = st.data.clone();
                    st.data.tracks = tracks;
                    if let Err(e) = st.persist() {
                        st.data = before;
                        return Err(e);
                    }
                    st.refresh_media();
                    Ok(json!({
                        "snapshot": st.snapshot(),
                        "count": added,
                        "found": found,
                        "selectedFolder": selected_folder,
                        "duplicates": duplicates,
                        "relinked": relinked,
                        "failed": failures.len(),
                        "failureNames": failures,
                        "skippedFolders": skipped_folders,
                        "limitReached": scan_limit || prep_limit
                    }))
                }
            })();
            busy.store(false, Ordering::SeqCst);
            result
        }
        _ => Err("UNKNOWN_CHANNEL".to_string()),
    }
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        ".mp3" => "audio/mpeg",
        ".wav" => "audio/wav",
        ".flac" => "audio/flac",
        ".ogg" | ".opus" => "audio/ogg",
        ".m4a" => "audio/mp4",
        ".aac" => "audio/aac",
        ".webm" => "audio/webm",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".png" => "image/png",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".bmp" => "image/bmp",
        ".avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

fn parse_byte_range(header: Option<&str>, size: u64) -> Option<(u64, u64, u16)> {
    let h = match header {
        None => return Some((0, size.saturating_sub(1), 200)),
        Some(s) => s.trim(),
    };
    let rest = h.strip_prefix("bytes=")?;
    let (left, right) = rest.split_once('-')?;
    if left.is_empty() && right.is_empty() || size == 0 {
        return None;
    }
    let start = if !left.is_empty() {
        left.parse::<u64>().ok()?
    } else {
        let suffix = right.parse::<u64>().ok()?;
        size.saturating_sub(suffix)
    };
    let end = if !left.is_empty() {
        if !right.is_empty() {
            right.parse::<u64>().ok()?.min(size - 1)
        } else {
            size - 1
        }
    } else {
        size - 1
    };
    if start >= size || end < start {
        return None;
    }
    Some((start, end, 206))
}

fn write_response(stream: &mut TcpStream, status: &str, content_type: &str, body: &[u8]) {
    let header = format!(
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        status,
        content_type,
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body);
}

fn serve_media(stream: &mut TcpStream, method: &str, id: &str, range_header: Option<&str>, state: &Arc<Mutex<AppState>>) {
    if method != "GET" && method != "HEAD" {
        write_response(stream, "405 Method Not Allowed", "text/plain", b"");
        return;
    }
    let filename = {
        let st = match state.lock() {
            Ok(s) => s,
            Err(_) => {
                write_response(stream, "500 Internal Server Error", "text/plain", b"");
                return;
            }
        };
        match st.media.get(id) {
            Some(p) => p.clone(),
            None => {
                write_response(stream, "404 Not Found", "text/plain", b"");
                return;
            }
        }
    };

    let path = Path::new(&filename);
    let meta = match fs::metadata(path) {
        Ok(m) if m.is_file() => m,
        _ => {
            write_response(stream, "404 Not Found", "text/plain", b"");
            return;
        }
    };
    let size = meta.len();
    let (start, end, status) = match parse_byte_range(range_header, size) {
        Some(r) => r,
        None => {
            let hdr = format!(
                "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                size
            );
            let _ = stream.write_all(hdr.as_bytes());
            return;
        }
    };

    let length = if size == 0 { 0 } else { end - start + 1 };
    let mime = mime_for_ext(&ext_lower(path));
    let status_line = if status == 206 {
        "206 Partial Content"
    } else {
        "200 OK"
    };
    let range_line = if status == 206 {
        format!("Content-Range: bytes {}-{}/{}\r\n", start, end, size)
    } else {
        String::new()
    };
    let header = format!(
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nAccept-Ranges: bytes\r\nContent-Length: {}\r\n{}Cache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
        status_line, mime, length, range_line
    );
    if stream.write_all(header.as_bytes()).is_err() || method == "HEAD" || length == 0 {
        return;
    }

    if let Ok(mut file) = File::open(path) {
        if file.seek(SeekFrom::Start(start)).is_ok() {
            let mut remaining = length;
            let mut buf = vec![0u8; 64 * 1024];
            while remaining > 0 {
                let to_read = (buf.len() as u64).min(remaining) as usize;
                match file.read(&mut buf[..to_read]) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if stream.write_all(&buf[..n]).is_err() {
                            break;
                        }
                        remaining -= n as u64;
                    }
                }
            }
        }
    }
}

fn bridge_js() -> &'static str {
    r#"'use strict';
(() => {
  const listeners = new Set();
  let pollTimer = null;
  const invoke = async (channel, ...args) => {
    const response = await fetch(`/api/${channel}`, {
      method: 'POST',
      keepalive: channel === 'settings',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args })
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  window.addEventListener('pagehide', () => {
    try { if (window.MusicGreenFlush) window.MusicGreenFlush(); } catch {}
  });
  window.addEventListener('beforeunload', () => {
    try { if (window.MusicGreenFlush) window.MusicGreenFlush(); } catch {}
  });
  window.green = {
    bootstrap: () => invoke('bootstrap'),
    importMusic: async mode => {
      pollTimer = setInterval(async () => {
        try {
          const p = await invoke('progress');
          if (p && p.total > 0) for (const fn of listeners) fn(p);
        } catch {}
      }, 150);
      try {
        return await invoke('import', mode);
      } finally {
        clearInterval(pollTimer);
      }
    },
    saveSettings: input => invoke('settings', input),
    saveCollections: input => invoke('collections', input),
    removeTrack: id => invoke('remove-track', id),
    trashTrack: id => invoke('trash-track', id),
    revealTrack: id => invoke('reveal-track', id),
    refreshLibrary: () => invoke('refresh-library'),
    exportLibrary: () => invoke('export'),
    onImportProgress: callback => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  };
})();
"#
}

fn render_index_html() -> String {
    INDEX_HTML
        .replace(
            "img-src 'self' green-media:; media-src green-media:; connect-src 'none';",
            "img-src 'self' data: http://127.0.0.1:*; media-src 'self' http://127.0.0.1:*; connect-src 'self' http://127.0.0.1:*;",
        )
        .replace(
            "<script defer src=\"model.js\"></script>",
            "<script defer src=\"bridge.js\"></script><script defer src=\"model.js\"></script>",
        )
}

fn handle_client(mut stream: TcpStream, state: Arc<Mutex<AppState>>, busy: Arc<AtomicBool>) {
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });

    let mut request_line = String::new();
    if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
        return;
    }
    let parts: Vec<&str> = request_line.trim().split_whitespace().collect();
    if parts.len() < 2 {
        return;
    }
    let method = parts[0];
    let raw_path = parts[1].split('?').next().unwrap_or("/");

    let mut content_length = 0usize;
    let mut range_header: Option<String> = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            if k.eq_ignore_ascii_case("content-length") {
                content_length = v.trim().parse::<usize>().unwrap_or(0);
            } else if k.eq_ignore_ascii_case("range") {
                range_header = Some(v.trim().to_string());
            }
        }
    }

    if let Some(id) = raw_path.strip_prefix("/media/") {
        serve_media(&mut stream, method, id, range_header.as_deref(), &state);
        return;
    }

    if let Some(channel) = raw_path.strip_prefix("/api/") {
        let mut body = vec![0u8; content_length.min(16 * 1024 * 1024)];
        if content_length > 0 {
            let _ = reader.read_exact(&mut body);
        }
        let parsed: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
        let args = parsed
            .get("args")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let response_json = match handle_rpc(channel, &args, &state, &busy) {
            Ok(val) => json!({ "ok": true, "value": val }),
            Err(err) => json!({ "ok": false, "error": err }),
        };
        let bytes = serde_json::to_vec(&response_json).unwrap_or_default();
        write_response(&mut stream, "200 OK", "application/json; charset=utf-8", &bytes);
        return;
    }

    match raw_path {
        "/" | "/index.html" => {
            let html = render_index_html();
            write_response(&mut stream, "200 OK", "text/html; charset=utf-8", html.as_bytes());
        }
        "/bridge.js" => write_response(
            &mut stream,
            "200 OK",
            "text/javascript; charset=utf-8",
            bridge_js().as_bytes(),
        ),
        "/app.js" => write_response(
            &mut stream,
            "200 OK",
            "text/javascript; charset=utf-8",
            APP_JS.as_bytes(),
        ),
        "/audio.js" => write_response(
            &mut stream,
            "200 OK",
            "text/javascript; charset=utf-8",
            AUDIO_JS.as_bytes(),
        ),
        "/playlist-picker.js" => write_response(
            &mut stream,
            "200 OK",
            "text/javascript; charset=utf-8",
            PLAYLIST_PICKER_JS.as_bytes(),
        ),
        "/model.js" => write_response(
            &mut stream,
            "200 OK",
            "text/javascript; charset=utf-8",
            MODEL_JS.as_bytes(),
        ),
        "/i18n.js" => write_response(
            &mut stream,
            "200 OK",
            "text/javascript; charset=utf-8",
            I18N_JS.as_bytes(),
        ),
        "/styles.css" => write_response(
            &mut stream,
            "200 OK",
            "text/css; charset=utf-8",
            STYLES_CSS.as_bytes(),
        ),
        "/icon.svg" => write_response(
            &mut stream,
            "200 OK",
            "image/svg+xml",
            ICON_SVG.as_bytes(),
        ),
        _ => write_response(&mut stream, "404 Not Found", "text/plain", b""),
    }
}

fn ensure_file(path: &Path, bytes: &[u8]) {
    let needs_write = match fs::metadata(path) {
        Ok(m) => m.len() != bytes.len() as u64,
        Err(_) => true,
    };
    if needs_write {
        let _ = fs::write(path, bytes);
    }
}

fn webview2_is_healthy() -> bool {
    let candidates = [
        r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application",
        r"C:\Program Files\Microsoft\EdgeWebView\Application",
    ];
    for base in candidates {
        if let Ok(entries) = fs::read_dir(base) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() && path.join("msedgewebview2.exe").is_file() {
                    if let Some(ver) = path.file_name().and_then(|n| n.to_str()) {
                        let manifest = path.join(format!("{}.manifest", ver));
                        if manifest.is_file() {
                            return true;
                        }
                    }
                }
            }
        }
    }
    false
}

fn find_chromium_browser() -> Option<PathBuf> {
    let mut paths = vec![
        PathBuf::from(r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"),
        PathBuf::from(r"C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe"),
        PathBuf::from(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        PathBuf::from(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
        PathBuf::from(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        PathBuf::from(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
    ];
    if let Ok(local) = env::var("LOCALAPPDATA") {
        let lp = PathBuf::from(local);
        paths.push(lp.join(r"BraveSoftware\Brave-Browser\Application\brave.exe"));
        paths.push(lp.join(r"Google\Chrome\Application\chrome.exe"));
        paths.push(lp.join(r"Microsoft\Edge\Application\msedge.exe"));
    }
    paths.into_iter().find(|p| p.is_file())
}

fn launch_app_browser(url: &str, user_data: &Path) {
    if let Some(browser) = find_chromium_browser() {
        let profile_dir = user_data.join("app-window-profile");
        let _ = fs::create_dir_all(&profile_dir);
        if let Ok(mut child) = Command::new(browser)
            .arg(format!("--app={}", url))
            .arg(format!("--user-data-dir={}", profile_dir.display()))
            .arg("--window-size=1280,780")
            .arg("--window-position=50,30")
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .arg("--disable-features=Translate")
            .arg("--disable-extensions")
            .arg("--disable-sync")
            .spawn()
        {
            let _ = child.wait();
            thread::sleep(std::time::Duration::from_millis(300));
        }
    }
}

fn main() {
    for arg in env::args().skip(1) {
        if arg == "--version" {
            println!("Music Green 1.0.2 (Rust)");
            return;
        }
    }

    let user_data = env::var("MUSIC_GREEN_TEST_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let appdata = env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
            PathBuf::from(appdata).join("Music Green")
        });
    let _ = fs::create_dir_all(&user_data);

    let host_dir = user_data.join("rust-webview-host");
    let _ = fs::create_dir_all(&host_dir);
    let host_exe = host_dir.join("mg-window.exe");
    let icon_path = host_dir.join("app.ico");
    ensure_file(&host_exe, MG_WINDOW_EXE);
    ensure_file(&host_dir.join("Microsoft.Web.WebView2.Core.dll"), WV2_CORE_DLL);
    ensure_file(&host_dir.join("Microsoft.Web.WebView2.WinForms.dll"), WV2_WINFORMS_DLL);
    ensure_file(&host_dir.join("WebView2Loader.dll"), WV2_LOADER_DLL);
    ensure_file(&icon_path, APP_ICO);

    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(_) => return,
    };
    let port = match listener.local_addr() {
        Ok(a) => a.port(),
        Err(_) => return,
    };

    let state = Arc::new(Mutex::new(AppState::new(
        user_data.join("music-green-data"),
        port,
    )));
    let busy = Arc::new(AtomicBool::new(false));

    let server_state = Arc::clone(&state);
    let server_busy = Arc::clone(&busy);
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let st = Arc::clone(&server_state);
            let bs = Arc::clone(&server_busy);
            thread::spawn(move || handle_client(stream, st, bs));
        }
    });

    let url = format!("http://127.0.0.1:{}/index.html", port);
    if webview2_is_healthy() {
        if let Ok(mut child) = Command::new(&host_exe)
            .arg(&url)
            .arg(&user_data)
            .arg(&icon_path)
            .current_dir(&host_dir)
            .spawn()
        {
            if let Ok(status) = child.wait() {
                if status.code() == Some(2) {
                    launch_app_browser(&url, &user_data);
                }
            }
            thread::sleep(std::time::Duration::from_millis(250));
            return;
        }
    }
    launch_app_browser(&url, &user_data);
}
