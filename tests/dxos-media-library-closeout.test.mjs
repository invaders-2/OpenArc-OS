/**
 * task-9 · 本地音乐库 media/library/* 收口回归。
 *
 * 覆盖：空库如实空态、配置目录设置 / 缓存失效、扫描 / tracks、歌词（sidecar 优先）、
 * 元数据覆盖、封面写入与缺失目标；全程经 media:command，返回不含绝对路径。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createMediaBundle } = require("../electron/media-service.cjs");
const mediaStore = require("../electron/media-store.cjs");
const mediaLibrary = require("../electron/media-library.cjs");

const tempDirs = [];
const STUB_AUTH = { resolveActor: ({ context }) => (context && context.sessionRef ? { ok: true, user: { id: "u-library" } } : { ok: false, error: "no-session" }) };

afterEach(() => {
  mediaStore.resetMediaStoreForTests();
  mediaLibrary.resetLibraryForTests();
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function openLibraryBundle() {
  const dir = tempDir("oa-media-library-");
  const bundle = createMediaBundle({ userDataDir: dir, authorization: STUB_AUTH, clock: () => Date.now() });
  const call = (command, payload = {}) => bundle.execute(command, payload, { sessionRef: "sess-library", appId: "ai" });
  return { dir, bundle, call };
}

function writeTrack(dir, relative, bytes = 128) {
  const file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
  return file;
}

test("空库：config / scan / tracks / artwork / lyrics 全部如实空态（不报错、不造条目）", async () => {
  const { dir, call } = openLibraryBundle();
  const config = await call("media/library/config/get");
  assert.equal(config.ok, true, JSON.stringify(config));
  assert.equal(config.value.config.configured, false);
  assert.deepEqual(config.value.config.dirNames, []);
  assert.equal(config.value.config.trackCount, 0);

  const scanned = await call("media/library/scan", {});
  assert.equal(scanned.ok, true, JSON.stringify(scanned));
  assert.deepEqual(scanned.value.tracks, []);
  const tracks = await call("media/library/tracks", {});
  assert.equal(tracks.ok, true, JSON.stringify(tracks));
  assert.deepEqual(tracks.value.tracks, []);
  const targets = await call("media/library/artwork/targets", {});
  assert.equal(targets.ok, true);
  assert.deepEqual(targets.value.artists, []);
  assert.deepEqual(targets.value.albums, []);
  const lyrics = await call("media/library/lyrics", { trackId: "no-such-track", online: false });
  assert.equal(lyrics.ok, true, JSON.stringify(lyrics));
  assert.equal(lyrics.value.lyrics, null);
  assert.equal(JSON.stringify(config.value).includes(dir), false);
});

test("配置目录：不存在目录如实报错；setDirs 后配置可见、缓存失效、scan/tracks 真实可用", async () => {
  const { dir, call } = openLibraryBundle();
  const musicA = path.join(dir, "music-a");
  const musicB = path.join(dir, "music-b");
  writeTrack(musicA, "song-a.mp3");
  writeTrack(musicB, "song-b.flac");

  const invalid = await call("media/library/config/set-dirs", { dirs: [path.join(dir, "missing")] });
  assert.equal(invalid.ok, true, JSON.stringify(invalid));
  assert.equal(invalid.value.errors.length, 1);
  assert.deepEqual(invalid.value.dirNames, []);
  assert.equal(JSON.stringify(invalid.value).includes(dir), false, "响应不得含绝对路径");

  const setA = await call("media/library/config/set-dirs", { dirs: [musicA] });
  assert.equal(setA.ok, true, JSON.stringify(setA));
  assert.deepEqual(setA.value.errors, []);
  assert.deepEqual(setA.value.dirNames, ["music-a"]);

  const configA = await call("media/library/config/get");
  assert.equal(configA.value.config.configured, true);
  assert.deepEqual(configA.value.config.dirNames, ["music-a"]);

  // 不带 dirs 的 scan 使用已保存配置目录。
  const scanned = await call("media/library/scan", {});
  assert.equal(scanned.ok, true, JSON.stringify(scanned));
  assert.equal(scanned.value.tracks.length, 1);
  assert.equal(scanned.value.tracks[0].folder === undefined || scanned.value.tracks[0].folder === "", true);
  assert.equal(JSON.stringify(scanned.value).includes(musicA), false);

  const tracksA = await call("media/library/tracks", {});
  assert.equal(tracksA.value.tracks.length, 1);
  assert.match(tracksA.value.tracks[0].id, /^[a-f0-9]{16}$/);

  // 目录变更后缓存必须失效：下一次 tracks 重新扫描（A + B 两首）。
  const setBoth = await call("media/library/config/set-dirs", { dirs: [musicA, musicB] });
  assert.deepEqual(setBoth.value.dirNames, ["music-a", "music-b"]);
  const afterChange = await call("media/library/config/get");
  assert.equal(afterChange.value.config.trackCount, 0, "目录变更后旧曲目缓存必须清空");
  const tracksBoth = await call("media/library/tracks", {});
  assert.equal(tracksBoth.value.tracks.length, 2);
  assert.equal(JSON.stringify(tracksBoth.value).includes(musicA), false);
  assert.equal(JSON.stringify(tracksBoth.value).includes(musicB), false);

  // 清空配置 → 空态（不是继续吐旧曲目）。
  const cleared = await call("media/library/config/set-dirs", { dirs: [] });
  assert.deepEqual(cleared.value.dirNames, []);
  const emptyTracks = await call("media/library/tracks", {});
  assert.deepEqual(emptyTracks.value.tracks, []);
});

test("歌词 / 元数据 / 封面：sidecar 优先、手工元数据覆盖、封面写入后不再列为缺失目标", async () => {
  const { dir, call } = openLibraryBundle();
  const root = path.join(dir, "music");
  const file = writeTrack(root, "song.mp3");
  fs.writeFileSync(file.replace(/\.mp3$/, ".lrc"), "[00:00.00]第一句\n[00:02.00]第二句\n", "utf8");
  const configured = await call("media/library/config/set-dirs", { dirs: [root] });
  assert.deepEqual(configured.value.dirNames, ["music"]);

  const scanned = await call("media/library/scan", {});
  assert.equal(scanned.ok, true, JSON.stringify(scanned));
  assert.equal(scanned.value.tracks.length, 1);
  const track = scanned.value.tracks[0];
  assert.equal(track.hasLyrics, true);

  const lyrics = await call("media/library/lyrics", { trackId: track.id, online: false });
  assert.equal(lyrics.ok, true, JSON.stringify(lyrics));
  assert.match(lyrics.value.lyrics.lyrics, /第一句/);
  assert.equal(lyrics.value.lyrics.source, "sidecar");

  // 手工 / AI 元数据覆盖：写 meta 后重新扫描生效。
  const metaSet = await call("media/library/meta/set", { items: [{ id: track.id, title: "曲名A", artist: "歌手A", album: "专辑A" }] });
  assert.equal(metaSet.ok, true, JSON.stringify(metaSet));
  assert.equal(metaSet.value.updated, 1);
  const rescanned = await call("media/library/scan", {});
  const covered = rescanned.value.tracks.find((entry) => entry.id === track.id);
  assert.equal(covered.title, "曲名A");
  assert.equal(covered.artist, "歌手A");
  assert.equal(covered.album, "专辑A");

  // 封面缺失目标 → 写入后不再缺失，并出现在曲目投影里。
  const targetsBefore = await call("media/library/artwork/targets", {});
  assert.deepEqual(targetsBefore.value.artists, ["歌手A"]);
  assert.equal(targetsBefore.value.albums.length, 1);
  const artwork = await call("media/library/artwork/put", { scope: "artist", key: "歌手A", base64: Buffer.alloc(512, 3).toString("base64") });
  assert.equal(artwork.ok, true, JSON.stringify(artwork));
  assert.match(artwork.value.url, /^\/api\/library\/artwork\/[a-f0-9]{16}$/);
  const targetsAfter = await call("media/library/artwork/targets", {});
  assert.equal(targetsAfter.value.artists.includes("歌手A"), false);
  const finalTracks = await call("media/library/scan", {});
  const withArt = finalTracks.value.tracks.find((entry) => entry.artist === "歌手A");
  assert.equal(withArt.artistImage, artwork.value.url);

  // artwork 参数校验：非法 scope / 缺字节载荷。
  const badScope = await call("media/library/artwork/put", { scope: "playlist", key: "x", base64: Buffer.from([1]).toString("base64") });
  assert.equal(badScope.ok, false);
  assert.equal(badScope.error, "MEDIA_INVALID_INPUT");
  const badBytes = await call("media/library/artwork/put", { scope: "artist", key: "歌手A" });
  assert.equal(badBytes.ok, false);
  assert.equal(badBytes.error, "MEDIA_INVALID_INPUT");
});
