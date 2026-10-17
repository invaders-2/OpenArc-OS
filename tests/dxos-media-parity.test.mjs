/** task-25 A21/B16 · 音频抽取/裁剪（真实 ffmpeg）与公共媒体注入抓取/上传。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { IdentityStore } = require("../electron/identity-store.cjs");
const mediaDomain = require("../electron/media-domain.cjs");
const mediaStore = require("../electron/media-store.cjs");
const { createMediaBundle } = require("../electron/media-service.cjs");

const tmpDirs = [];
const stores = [];
function tempDir(prefix) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(dir); return dir; }
test.afterEach(() => { mediaStore.resetMediaStoreForTests(); while (stores.length) { try { stores.pop().close(); } catch { /* ignore */ } } });
test.after(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });

function auth() { return { resolveActor: ({ context }) => context && context.sessionRef ? { ok: true, user: { id: "u-media" } } : { ok: false } }; }

function openBundle(overrides = {}) {
  const dir = tempDir("dxos-media-parity-");
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  stores.push(store);
  const bundle = createMediaBundle(Object.assign({ userDataDir: dir, identityStore: store, authorization: auth() }, overrides));
  return {
    dir, store, bundle, dxosMedia: path.join(dir, "dxos", "media"),
    call: (command, payload) => bundle.execute(command, payload || {}, { sessionRef: "sess-test", requestId: "req-test" }),
  };
}

let SAMPLE = null;
function sample() {
  if (SAMPLE) return SAMPLE;
  const dir = tempDir("dxos-media-parity-sample-");
  const file = path.join(dir, "sample.mp4");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", file]);
  SAMPLE = fs.readFileSync(file);
  return SAMPLE;
}

test("A21 · 命令表新增 extract/trim；真实 ffmpeg 抽音轨与裁剪落媒体库音频目录", async () => {
  const commands = mediaDomain.listMediaCommands().map((entry) => entry.command);
  assert.ok(commands.includes("media/audio/extract"));
  assert.ok(commands.includes("media/audio/trim"));
  assert.equal(mediaDomain.mediaCommandRisk("media/audio/extract"), "use");
  const fx = openBundle();
  const saved = await fx.call("media/asset/save", { projectId: "11111111-1111-4111-8111-111111111111", name: "sample.mp4", mime: "video/mp4", base64: sample().toString("base64") });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const assetId = saved.value.asset.id;
  const extracted = await fx.call("media/audio/extract", { assetId });
  assert.equal(extracted.ok, true, JSON.stringify(extracted));
  assert.match(extracted.value.audio.relativePath, /^audio\/[A-Za-z0-9-]+\.m4a$/);
  assert.ok(extracted.value.audio.bytes > 0);
  assert.ok(fs.existsSync(path.join(fx.dxosMedia, extracted.value.audio.relativePath)));
  assert.equal(JSON.stringify(extracted).includes(fx.dir), false, "不得回绝对路径");
  const trimmed = await fx.call("media/audio/trim", { assetId, startMs: 0, durationMs: 500 });
  assert.equal(trimmed.ok, true, JSON.stringify(trimmed));
  assert.equal(trimmed.value.audio.durationMs, 500);
  assert.ok(trimmed.value.audio.bytes > 0);
  assert.ok(fs.existsSync(path.join(fx.dxosMedia, trimmed.value.audio.relativePath)));
  const artifacts = await fx.call("media/artifact/list", {});
  assert.ok(artifacts.value.artifacts.some((entry) => entry.kind === "audio"), "产物清单必须包含 audio");
  const bad = await fx.call("media/audio/trim", { assetId, startMs: -1, durationMs: 500 });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "MEDIA_INVALID_INPUT");
  const tooShort = await fx.call("media/audio/trim", { assetId, durationMs: 50 });
  assert.equal(tooShort.ok, false);
});

test("B16 · 公共媒体远端抓取/上传：默认无依赖结构化；注入 fetch/uploader 才可用", async () => {
  const fx = openBundle({
    publicMediaFetchImpl: async (url) => {
      assert.match(url, /^https:\/\/cdn\.example\.com\//);
      return {
        ok: true,
        headers: { get: (key) => (key === "content-type" ? "image/png" : key === "content-length" ? "8" : null) },
        arrayBuffer: async () => Uint8Array.from(Buffer.from("PNGDATA!")).buffer,
      };
    },
    publicMediaUploader: async ({ fileName, bytes }) => ({ url: "https://public.example.com/" + encodeURIComponent(fileName), bytes: bytes.length }),
    publicMediaAllowedHosts: ["cdn.example.com"],
  });
  const noFetcher = await openBundle({ publicMediaAllowedHosts: ["cdn.example.com"] }).call("media/public-media/fetch", { url: "https://cdn.example.com/a.png" });
  assert.equal(noFetcher.ok, false);
  assert.equal(noFetcher.error, "MEDIA_DEPENDENCY_UNAVAILABLE", "未注入 fetchImpl 必须结构化缺失");
  const fetched = await fx.call("media/public-media/fetch", { url: "https://cdn.example.com/a.png" });
  assert.equal(fetched.ok, true, JSON.stringify(fetched));
  assert.match(fetched.value.media.url, /^\/api\/public-media\//);
  assert.equal(fetched.value.media.bytes, 8);
  const bad = await fx.call("media/public-media/fetch", { url: "https://evil.example.com/a.png" });
  assert.equal(bad.ok, false);
  const uploaded = await fx.call("media/public-media/upload", { fileName: fetched.value.media.fileName });
  assert.equal(uploaded.ok, true, JSON.stringify(uploaded));
  assert.match(uploaded.value.media.url, /^https:\/\/public\.example\.com\//);
  const noUploader = await openBundle().call("media/public-media/upload", { fileName: "x.png" });
  assert.equal(noUploader.ok, false);
  assert.equal(noUploader.error, "MEDIA_DEPENDENCY_UNAVAILABLE");
});
