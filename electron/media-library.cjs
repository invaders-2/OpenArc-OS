/**
 * B5e · 本地音乐库（逐函数移植自只读源 server/library.ts:1-535）。
 *
 * 行号为源文件行号：
 *   · :14-24   music-metadata 惰性加载（本仓用注入的 musicMetadataLoader / require）
 *   · :26-41   数据文件与 AUDIO_EXT
 *   · :79-89   loadJson / saveJson
 *   · :94-121  元数据覆盖层 loadMeta / saveMeta / setMeta
 *   · :126-143 artwork 目录 / artworkPath
 *   · :144-188 fetchJson / findImageUrl / downloadImage（网络，走注入 fetchImpl）
 *   · :190-239 artworkTargets / putArtwork / cacheRemoteArtwork
 *   · :245-268 scrapeArtwork（网络，best-effort）
 *   · :279-310 loadCfg / persist / getConfig / setDirs
 *   · :316-343 uploadFiles
 *   · :346-378 scanDir（限深 6 层、单库 5000 首）
 *   · :380-442 lyricsText / readSidecarLyrics / enrichTrack
 *   · :444-475 scan（并发 6 的标签富化 + 元数据覆盖 + artwork 投影）
 *   · :477-501 getLyrics / listTracks
 *
 * OUT（Express 路由，与本仓 media:command 无关）逐条注明：
 *   · :503-535 streamTrack(req,res) —— HTTP 流式 Range，属 Express 层，不在命令面；
 *     trackCache / pathIndex 的"id → 绝对路径"索引仍保留（路径不出主进程）。
 *   · :144-188、:245-268 外站请求（iTunes / Deezer / lrclib）—— 网络 OUT，
 *     只在注入 fetchImpl 时可用，未注入即结构化不可用。
 *
 * 依赖注入：{ dataDir, fetchImpl, musicMetadataLoader, clock }；扫描根可用 options.dirs
 * 或 setDirs 注入。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const { createMediaError, MEDIA_ERR_INVALID_INPUT, MEDIA_ERR_NOT_FOUND, MEDIA_ERR_DEPENDENCY_UNAVAILABLE } = require("./media-domain.cjs");

/** 源 :32-41 */
const AUDIO_EXT = Object.freeze({
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".wma": "audio/x-ms-wma",
});

const MAX_DEPTH = 6;
const MAX_TRACKS = 5000;
const TRUSTED_ARTWORK_HOSTS = Object.freeze(["e-cdns-images.dzcdn.net", "is1-ssl.mzstatic.com"]);

let extensions = Object.freeze({});
let musicMetadataRuntime = null;

/** 依赖注入：{ dataDir, fetchImpl, musicMetadataLoader, clock, dirs }。 */
function configureMediaLibrary(options) {
  if (options && typeof options === "object") extensions = Object.freeze(Object.assign({}, extensions, options));
  return Object.assign({}, extensions);
}

function effective(options) {
  return Object.assign({}, extensions, options || {});
}

function dataDirOf(options) {
  const opts = effective(options);
  if (!opts.dataDir) throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "音乐库数据目录未装配（缺少 dataDir）", "缺少 dataDir：注入 <userData>/dxos/media 后重试。");
  return opts.dataDir;
}

function libraryFile(options) { return path.join(dataDirOf(options), "library.json"); }
function metaFile(options) { return path.join(dataDirOf(options), "library-meta.json"); }
function tagCacheFile(options) { return path.join(dataDirOf(options), "library-tags.json"); }
function lyricsCacheFile(options) { return path.join(dataDirOf(options), "library-lyrics.json"); }
function artworkDir(options) { return path.join(dataDirOf(options), "artwork"); }
function artworkMetaFile(options) { return path.join(dataDirOf(options), "library-artwork.json"); }

// ---------------------------------------------------------------------------
// 状态（扫描时重建；测试可 reset）
// ---------------------------------------------------------------------------
const pathIndex = new Map();
let trackCache = [];
let lastScan = 0;

function resetLibraryForTests() {
  pathIndex.clear();
  trackCache = [];
  lastScan = 0;
  musicMetadataRuntime = null;
}

/** 源 :14-24 music-metadata 惰性加载；缺失由调用方 catch 回文件名兜底。 */
function loadMusicMetadata(options) {
  const opts = effective(options);
  if (typeof opts.musicMetadataLoader === "function") return Promise.resolve(opts.musicMetadataLoader());
  if (!musicMetadataRuntime) {
    musicMetadataRuntime = Promise.resolve().then(() => require("music-metadata")).catch((error) => {
      musicMetadataRuntime = null;
      throw error;
    });
  }
  return musicMetadataRuntime;
}

/** 源 :79-89 loadJson / saveJson。 */
function loadJson(file, fallback) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : fallback;
  } catch { return fallback; }
}

function saveJson(file, value) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf-8");
}

/** 源 :94-104 loadMeta / saveMeta。 */
function loadMeta(options) { return loadJson(metaFile(options), {}); }
function saveMeta(value, options) { saveJson(metaFile(options), value); }

/** 源 :106-121 setMeta：合并保存分类结果；返回写入条数。 */
function setMeta(items, options) {
  const m = loadMeta(options);
  let n = 0;
  for (const it of items || []) {
    const id = String(it && it.id || "").trim();
    if (!id) continue;
    const cur = m[id] || {};
    if (it.title !== undefined) cur.title = String(it.title).trim();
    if (it.artist !== undefined) cur.artist = String(it.artist).trim();
    if (it.album !== undefined) cur.album = String(it.album).trim();
    m[id] = cur;
    n++;
  }
  saveMeta(m, options);
  return n;
}

/** 源 :126-143 loadArtwork / saveArtwork / artworkPath。 */
function loadArtwork(options) {
  try {
    if (fs.existsSync(artworkMetaFile(options))) {
      const r = JSON.parse(fs.readFileSync(artworkMetaFile(options), "utf-8"));
      return { artists: r.artists || {}, albums: r.albums || {} };
    }
  } catch { /* ignore */ }
  return { artists: {}, albums: {} };
}

function saveArtwork(m, options) { saveJson(artworkMetaFile(options), m); }

function artworkPath(id, options) {
  return path.join(artworkDir(options), String(id).replace(/[^a-f0-9]/g, "") + ".jpg");
}

/** 源 :144-156 fetchJson；未注入 fetchImpl 即结构化不可用。 */
async function fetchJson(url, timeoutMs, options) {
  const opts = effective(options);
  if (typeof opts.fetchImpl !== "function") return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 8000);
  try {
    const r = await opts.fetchImpl(url, { headers: { "User-Agent": "CCS-OS/1.0", Accept: "application/json" }, signal: ctrl.signal });
    if (!r.ok) return null;
    return JSON.parse(await r.text());
  } catch { return null; } finally { clearTimeout(timer); }
}

/** 源 :157-174 findImageUrl：专辑优先 iTunes，歌手优先 Deezer。 */
async function findImageUrl(kind, query, options) {
  const opts = effective(options);
  if (typeof opts.fetchImpl !== "function") {
    throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "刮削封面需要注入 fetchImpl", "缺少 fetchImpl：注入后重试。");
  }
  if (kind === "album") {
    const it = await fetchJson("https://itunes.apple.com/search?term=" + encodeURIComponent(query) + "&entity=album&limit=1", 8000, opts);
    const u = it && it.results && it.results[0] && it.results[0].artworkUrl100;
    if (u) return String(u).replace("100x100bb", "600x600bb").replace("100x100", "600x600");
    const dz = await fetchJson("https://api.deezer.com/search/album?q=" + encodeURIComponent(query) + "&limit=1", 8000, opts);
    return (dz && dz.data && dz.data[0] && (dz.data[0].cover_xl || dz.data[0].cover_big)) || null;
  }
  const dz = await fetchJson("https://api.deezer.com/search/artist?q=" + encodeURIComponent(query) + "&limit=8", 8000, opts);
  const candidates = dz && Array.isArray(dz.data) ? dz.data : [];
  const normalize = (value) => String(value || "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const picture = (candidate) => String(candidate && (candidate.picture_xl || candidate.picture_big) || "");
  const valid = (candidate) => /^https:\/\//i.test(picture(candidate)) && !/\/artist\/\//i.test(picture(candidate));
  const candidate = candidates.find((item) => normalize(item.name) === normalize(query) && valid(item)) || candidates.find((item) => valid(item));
  return candidate ? picture(candidate) : null;
}

/** 源 :175-188 downloadImage。 */
async function downloadImage(url, options) {
  const opts = effective(options);
  if (typeof opts.fetchImpl !== "function") {
    throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "下载封面需要注入 fetchImpl", "缺少 fetchImpl：注入后重试。");
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await opts.fetchImpl(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length < 200 ? null : buf;
  } catch { return null; } finally { clearTimeout(timer); }
}

/** 源 :194-207 artworkTargets：当前曲库"还没有图"的歌手与「歌手+专辑」。 */
async function artworkTargets(options) {
  const tracks = await listTracks(options);
  const art = loadArtwork(options);
  const artistSet = new Set();
  const albumKeys = new Map();
  for (const t of tracks) {
    if (t.artist) artistSet.add(t.artist);
    if (t.artist && t.album) albumKeys.set(t.artist + "\n" + t.album, { artist: t.artist, album: t.album });
  }
  const artists = [...artistSet].filter((name) => !art.artists[name]);
  const albums = [...albumKeys.entries()].filter(([key]) => !art.albums[key]).map(([key, value]) => ({ ...value, key }));
  return { artists, albums };
}

/** 源 :209-219 putArtwork：写缓存并登记 map；返回缓存 id。 */
function putArtwork(scope, key, buf, options) {
  const id = createHash("md5").update(scope + "|" + key + "|" + buf.length).digest("hex").slice(0, 16);
  const dir = artworkDir(options);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(artworkPath(id, options), buf);
  const art = loadArtwork(options);
  if (scope === "artist") art.artists[key] = id;
  else art.albums[key] = id;
  saveArtwork(art, options);
  return id;
}

/** 源 :221-239 cacheRemoteArtwork：只接受受信任音乐服务 HTTPS 直链。 */
async function cacheRemoteArtwork(scope, key, rawUrl, options) {
  const opts = effective(options);
  const cacheKey = String(key || "").trim();
  if (!cacheKey || cacheKey.length > 300) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "艺术图缓存键无效");
  let url;
  try { url = new URL(String(rawUrl || "").trim()); } catch { throw createMediaError(MEDIA_ERR_INVALID_INPUT, "艺术图地址无效"); }
  const host = url.hostname.toLowerCase();
  const trusted = url.protocol === "https:" && (host.endsWith(".dzcdn.net") || host.endsWith(".mzstatic.com") || TRUSTED_ARTWORK_HOSTS.includes(host));
  if (!trusted) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "只允许缓存受信任音乐服务的图片");
  const buf = await downloadImage(url.toString(), opts);
  if (!buf) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "艺术图下载失败");
  const id = putArtwork(scope, cacheKey, buf, opts);
  const localUrl = "/api/library/artwork/" + id;
  for (const track of trackCache) {
    if (scope === "artist" && track.artist === cacheKey) track.artistImage = localUrl;
    if (scope === "album" && ((track.albumArtist || track.artist || "") + "\n" + (track.album || "")) === cacheKey) track.albumImage = localUrl;
  }
  return localUrl;
}

/** 源 :245-268 scrapeArtwork（best-effort）。 */
async function scrapeArtwork(options) {
  const opts = effective(options);
  const { artists, albums } = await artworkTargets(opts);
  let artistsDone = 0;
  let albumsDone = 0;
  let failed = 0;
  for (const name of artists) {
    const url = await findImageUrl("artist", name, opts);
    const buf = url ? await downloadImage(url, opts) : null;
    if (buf) { putArtwork("artist", name, buf, opts); artistsDone++; } else failed++;
  }
  for (const { artist, album, key } of albums) {
    const url = await findImageUrl("album", artist + " " + album, opts);
    const buf = url ? await downloadImage(url, opts) : null;
    if (buf) { putArtwork("album", key, buf, opts); albumsDone++; } else failed++;
  }
  await scan(opts);
  return { artists: artistsDone, albums: albumsDone, failed };
}

/** 源 :279-291 loadCfg / persist。 */
function loadCfg(options) {
  try {
    const file = libraryFile(options);
    if (!fs.existsSync(file)) return { dirs: [] };
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    return { dirs: Array.isArray(raw.dirs) ? raw.dirs : [] };
  } catch { return { dirs: [] }; }
}

function persist(cfg, options) { saveJson(libraryFile(options), cfg); }

/** 源 :293-295 getConfig。 */
function getConfig(options) {
  return { ...loadCfg(options), trackCount: trackCache.length };
}

/** 源 :297-310 setDirs：目录必须存在且是目录；去重。 */
function setDirs(dirs, options) {
  const errors = [];
  const valid = [];
  for (const d of (Array.isArray(dirs) ? dirs : []).map((x) => String(x).trim()).filter(Boolean)) {
    const abs = path.resolve(d);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      errors.push("目录不存在：" + d);
      continue;
    }
    if (!valid.includes(abs)) valid.push(abs);
  }
  persist({ dirs: valid }, options);
  // 目录变了就必须让下一次 listTracks 重新扫描：否则 5 分钟缓存会把新目录藏起来。
  pathIndex.clear();
  trackCache = [];
  lastScan = 0;
  return { dirs: valid, errors };
}

/** 源 :316-343 uploadFiles：写入首个曲库目录。 */
function uploadFiles(files, options) {
  const dirs = loadCfg(options).dirs;
  const target = dirs[0];
  if (!target || !fs.existsSync(target)) {
    return { saved: 0, skipped: files.map((f) => f.name) };
  }
  let saved = 0;
  const skipped = [];
  for (const f of files) {
    const name = path.basename(f.name).trim();
    if (!name || !AUDIO_EXT[path.extname(name).toLowerCase()]) {
      skipped.push(f.name || "(无名文件)");
      continue;
    }
    const dest = path.join(target, name);
    if (fs.existsSync(dest)) {
      skipped.push(name + "（已存在）");
      continue;
    }
    try {
      fs.writeFileSync(dest, f.buffer);
      saved++;
    } catch (e) {
      skipped.push(name + "（写入失败：" + String(e && e.message || e) + "）");
    }
  }
  return { saved, skipped };
}

/** 源 :346-378 scanDir（限深 6 层、单库上限 5000 首）。 */
async function scanDir(root, dir, out, depth, options) {
  if (depth > MAX_DEPTH || out.length >= MAX_TRACKS) return;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch { return; }
  for (const e of entries) {
    if (out.length >= MAX_TRACKS) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!e.name.startsWith(".")) await scanDir(root, full, out, depth + 1, options);
    } else {
      const ext = path.extname(e.name).toLowerCase();
      if (!AUDIO_EXT[ext]) continue;
      let size = 0;
      let modified = 0;
      try {
        const stat = fs.statSync(full);
        size = stat.size;
        modified = stat.mtimeMs;
      } catch { continue; }
      const id = createHash("md5").update(full).digest("hex").slice(0, 16);
      pathIndex.set(id, full);
      const fileName = path.basename(e.name, path.extname(e.name));
      const folder = path.relative(root, path.dirname(full)).replace(/\\/g, "/") || undefined;
      out.push({ id, title: fileName, fileName, folder, ext: ext.slice(1), size, dir: path.basename(root), _signature: size + ":" + modified });
    }
  }
}

/** 源 :380-387 lyricsText。 */
function lyricsText(value) {
  const first = value && value.find((item) => (item.syncText && item.syncText.length) || item.text);
  if (!first) return undefined;
  if (first.syncText && first.syncText.length) {
    return first.syncText.map((line) => "[" + Math.floor((line.timestamp || 0) / 60).toString().padStart(2, "0") + ":" + ((line.timestamp || 0) % 60).toFixed(2).padStart(5, "0") + "]" + line.text).join("\n");
  }
  return (first.text && first.text.trim()) || undefined;
}

/** 源 :389-396 readSidecarLyrics。 */
async function readSidecarLyrics(audioPath) {
  const lrc = audioPath.slice(0, -path.extname(audioPath).length) + ".lrc";
  try {
    return (await fs.promises.readFile(lrc, "utf-8")).trim() || undefined;
  } catch { return undefined; }
}

/** 源 :398-442 enrichTrack。 */
async function enrichTrack(track, tags, lyrics, options) {
  const file = pathIndex.get(track.id);
  if (!file) return;
  const signature = String(track._signature || "");
  let cached = tags[track.id];
  if (!cached || cached.signature !== signature) {
    cached = { signature };
    try {
      const mod = await loadMusicMetadata(options);
      const parsed = await mod.parseFile(file, { duration: true, skipCovers: false });
      const c = parsed.common;
      cached.title = (c.title && c.title.trim()) || undefined;
      cached.artist = (c.artist && c.artist.trim()) || (c.artists && c.artists.filter(Boolean).join(" / ")) || undefined;
      cached.album = (c.album && c.album.trim()) || undefined;
      cached.albumArtist = (c.albumartist && c.albumartist.trim()) || undefined;
      cached.trackNo = (c.track && c.track.no) || undefined;
      cached.year = c.year;
      cached.genre = c.genre && c.genre.filter(Boolean);
      cached.duration = parsed.format.duration;
      cached.lyrics = lyricsText(c.lyrics);
      const picture = c.picture && c.picture[0];
      if (picture && picture.data && picture.data.length) {
        const key = track.id + "\nembedded";
        cached.embeddedArtworkId = putArtwork("album", key, Buffer.from(picture.data), options);
      }
    } catch {
      // 损坏 / 缺少 music-metadata 时保留文件名兜底，不阻断整库扫描（源 :423-425）。
    }
    const sidecar = await readSidecarLyrics(file);
    if (sidecar) lyrics[track.id] = { lyrics: sidecar, source: "sidecar" };
    else if (cached.lyrics) lyrics[track.id] = { lyrics: cached.lyrics, source: "embedded" };
    tags[track.id] = cached;
  }
  track.title = cached.title || track.fileName;
  track.artist = cached.artist;
  track.album = cached.album;
  track.albumArtist = cached.albumArtist;
  track.trackNo = cached.trackNo;
  track.year = cached.year;
  track.genre = cached.genre;
  track.duration = cached.duration;
  track.hasLyrics = !!lyrics[track.id];
  if (cached.embeddedArtworkId) track.albumImage = "/api/library/artwork/" + cached.embeddedArtworkId;
  delete track._signature;
}

/** 源 :444-475 scan：扫描根可由 options.dirs 注入，否则用配置。 */
async function scan(options) {
  const opts = effective(options);
  const dirs = Array.isArray(opts.dirs) && opts.dirs.length ? opts.dirs : loadCfg(opts).dirs;
  pathIndex.clear();
  const out = [];
  for (const d of dirs) await scanDir(d, d, out, 0, opts);
  const tags = loadJson(tagCacheFile(opts), {});
  const lyrics = loadJson(lyricsCacheFile(opts), {});
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(6, out.length) }, async () => {
    while (cursor < out.length) await enrichTrack(out[cursor++], tags, lyrics, opts);
  }));
  saveJson(tagCacheFile(opts), tags);
  saveJson(lyricsCacheFile(opts), lyrics);
  const meta = loadMeta(opts);
  const art = loadArtwork(opts);
  for (const t of out) {
    const m = meta[t.id];
    t.title = (m && m.title) || t.title || t.fileName;
    t.artist = (m && m.artist) || t.artist;
    if (m && m.album) t.album = m.album;
    if (t.artist && art.artists[t.artist]) t.artistImage = "/api/library/artwork/" + art.artists[t.artist];
    if (!t.albumImage && t.artist && t.album && art.albums[t.artist + "\n" + t.album]) {
      t.albumImage = "/api/library/artwork/" + art.albums[t.artist + "\n" + t.album];
    }
  }
  out.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
  trackCache = out;
  lastScan = (opts.clock || (() => Date.now()))();
  return out;
}

/** 源 :477-495 getLyrics；在线查询需注入 fetchImpl。 */
async function getLyrics(id, online, options) {
  const opts = effective(options);
  await listTracks(opts);
  const cached = loadJson(lyricsCacheFile(opts), {});
  if (cached[id]) return cached[id];
  if (online === false) return null;
  const track = trackCache.find((item) => item.id === id);
  if (!track || !track.artist || !track.title) return null;
  if (typeof opts.fetchImpl !== "function") {
    throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "在线歌词查询需要注入 fetchImpl", "缺少 fetchImpl：注入后重试。");
  }
  const params = new URLSearchParams({ track_name: track.title, artist_name: track.artist });
  if (track.album) params.set("album_name", track.album);
  if (track.duration) params.set("duration", String(Math.round(track.duration)));
  const result = await fetchJson("https://lrclib.net/api/get?" + params.toString(), 8000, opts);
  const text = String(result && (result.syncedLyrics || result.plainLyrics) || "").trim();
  if (!text) return null;
  cached[id] = { lyrics: text, source: "lrclib" };
  saveJson(lyricsCacheFile(opts), cached);
  const found = trackCache.find((item) => item.id === id);
  if (found) found.hasLyrics = true;
  return cached[id];
}

/** 源 :497-501 listTracks：5 分钟缓存。 */
async function listTracks(options) {
  const opts = effective(options);
  const now = (opts.clock || (() => Date.now()))();
  if (!trackCache.length || now - lastScan > 5 * 60_000) await scan(opts);
  return trackCache;
}

/** 只读：id → 绝对路径（仅主进程内部使用，绝不回渲染层）。 */
function trackFilePath(id) {
  const file = pathIndex.get(String(id));
  if (!file || !fs.existsSync(file)) throw createMediaError(MEDIA_ERR_NOT_FOUND, "曲目不存在（可能已被移动，请重新扫描）");
  return file;
}

module.exports = {
  AUDIO_EXT,
  MAX_DEPTH,
  MAX_TRACKS,
  configureMediaLibrary,
  resetLibraryForTests,
  loadJson,
  saveJson,
  setMeta,
  loadArtwork,
  saveArtwork,
  artworkPath,
  fetchJson,
  findImageUrl,
  downloadImage,
  artworkTargets,
  putArtwork,
  cacheRemoteArtwork,
  scrapeArtwork,
  loadCfg,
  persist,
  getConfig,
  setDirs,
  uploadFiles,
  scanDir,
  lyricsText,
  readSidecarLyrics,
  enrichTrack,
  scan,
  getLyrics,
  listTracks,
  trackFilePath,
  // 源 :503-535 streamTrack 为 Express HTTP 流式 Range，属 OUT（命令面不适用）。
};
