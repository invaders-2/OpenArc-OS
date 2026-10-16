/**
 * B5g · 媒体域回归测试（全离线：无网络、无 Electron、不跑构建）。
 *
 * 覆盖独立验证抓出的三处真缺陷：
 *   ① media-short-drama.cjs 未导入 MEDIA_ERR_CONFLICT —— 项目文件夹丢失 / 在废纸篓
 *      分支以前抛 ReferenceError，现在必须回稳定 MEDIA_CONFLICT；
 *   ② media-store.cjs 未导入 MEDIA_ERR_POSTER_FAILED —— 封面「失败退避 / 队列满 / 空封面」
 *      三条分支以前抛 ReferenceError，现在必须回稳定 MEDIA_POSTER_FAILED；
 *   ③ media-service.cjs createGuardedFetch 只看 string / input.url —— URL 对象与尾点 host
 *      可绕过出口护栏，现在 string / Request / URL 三种入参 × dx-os.com 变体全部 MEDIA_FORBIDDEN，
 *      本地 / 公网自配端点仍放行。
 */
"use strict";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const mediaDomain = require("../electron/media-domain.cjs");
const mediaStore = require("../electron/media-store.cjs");
const shortDrama = require("../electron/media-short-drama.cjs");
const { createGuardedFetch } = require("../electron/media-service.cjs");

const tmpDirs = [];
after(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** 覆盖 fsPort 全部必需方法的短剧画布 stub；只让 getNode / isInTrash 随用例变化。 */
function dramaAdapter(folder, inTrash) {
  return {
    getNode: () => folder,
    isInTrash: () => inTrash,
    listChildren: () => ({ nodes: [] }),
    findByPath: () => null,
    ensureFolder: () => "folder",
    createNode: () => ({ id: "node" }),
    setContent: () => {},
    renameNode: () => {},
    saveBlob: () => {},
    readBlob: () => Buffer.alloc(0),
    ensureCanvasRoot: () => ({ id: "root" }),
  };
}

// ── ① 短剧项目文件夹丢失 / 在废纸篓 → MEDIA_CONFLICT ───────────────────────
test("短剧 find：项目文件夹丢失 / 在废纸篓 → 稳定 MEDIA_CONFLICT（修复前 ReferenceError）", () => {
  const projects = [{ id: "p1", folderId: "f1" }];

  const missing = dramaAdapter(null, false);
  assert.throws(() => shortDrama.find(projects, "p1", { fsAdapter: missing }), (error) => {
    assert.equal(error.name, "MediaError");
    assert.equal(error.code, "MEDIA_CONFLICT");
    assert.equal(error.code, mediaDomain.MEDIA_ERR_CONFLICT);
    return true;
  });

  const trashed = dramaAdapter({ id: "f1" }, true);
  assert.throws(() => shortDrama.find(projects, "p1", { fsAdapter: trashed }), (error) => {
    assert.equal(error.code, "MEDIA_CONFLICT");
    assert.equal(error.code, mediaDomain.MEDIA_ERR_CONFLICT);
    return true;
  });

  // 文件夹存在且不在废纸篓仍正常返回（不过度拦截）
  const alive = dramaAdapter({ id: "f1" }, false);
  assert.equal(shortDrama.find(projects, "p1", { fsAdapter: alive }).id, "p1");
  // 项目本身不存在仍是 NOT_FOUND（不串码）
  assert.throws(() => shortDrama.find(projects, "nope", { fsAdapter: alive }), (error) => error.code === "MEDIA_NOT_FOUND");
});

// ── ② 封面缓存三条分支 → MEDIA_POSTER_FAILED ─────────────────────────────
test("封面缓存：失败退避分支 → MEDIA_POSTER_FAILED（修复前 ReferenceError）", async () => {
  const dir = tempDir("dxos-media-b5g-backoff-");
  const source = path.join(dir, "movie.mp4");
  fs.writeFileSync(source, Buffer.alloc(64, 7));
  const cache = mediaStore.createVideoPosterCache(path.join(dir, "cache"), async () => { throw new Error("render boom"); });

  await assert.rejects(() => cache(source, 256), (error) => error.message === "render boom");
  await assert.rejects(() => cache(source, 256), (error) => {
    assert.equal(error.name, "MediaError");
    assert.equal(error.code, "MEDIA_POSTER_FAILED");
    assert.equal(error.code, mediaDomain.MEDIA_ERR_POSTER_FAILED);
    return true;
  });
  assert.equal(cache.stats().failures, 1);
});

test("封面缓存：队列满分支（128 个在途）→ MEDIA_POSTER_FAILED（修复前 ReferenceError）", async () => {
  const dir = tempDir("dxos-media-b5g-queue-");
  const source = path.join(dir, "movie.mp4");
  fs.writeFileSync(source, Buffer.alloc(64, 7));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cache = mediaStore.createVideoPosterCache(path.join(dir, "cache"), async () => { await gate; });

  // 同一源 + 128 个不同 size ⇒ 128 个不同 key，逐个占满在途作业表。
  const inFlight = [];
  for (let size = 1; size <= 128; size++) inFlight.push(cache(source, size).catch((error) => error));
  for (let attempt = 0; attempt < 200 && cache.stats().pending < 128; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(cache.stats().pending, 128, "必须先填满 128 个在途作业，才能验证队列满分支");

  await assert.rejects(() => cache(source, 999), (error) => {
    assert.equal(error.name, "MediaError");
    assert.equal(error.code, "MEDIA_POSTER_FAILED");
    assert.equal(error.code, mediaDomain.MEDIA_ERR_POSTER_FAILED);
    return true;
  });

  release();
  await Promise.allSettled(inFlight);
});

test("封面缓存：渲染出 0 字节封面 → MEDIA_POSTER_FAILED（修复前 ReferenceError）", async () => {
  const dir = tempDir("dxos-media-b5g-empty-");
  const source = path.join(dir, "movie.mp4");
  fs.writeFileSync(source, Buffer.alloc(64, 7));
  const cache = mediaStore.createVideoPosterCache(path.join(dir, "cache"), async (_source, target) => {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, Buffer.alloc(0));
  });

  await assert.rejects(() => cache(source, 256), (error) => {
    assert.equal(error.name, "MediaError");
    assert.equal(error.code, "MEDIA_POSTER_FAILED");
    assert.equal(error.code, mediaDomain.MEDIA_ERR_POSTER_FAILED);
    return true;
  });
});

// ── ③ 出口护栏：string / Request / URL × dx-os.com 变体 ───────────────────
const FORBIDDEN_HOSTS = [
  "api.dx-os.com",
  "sub.dx-os.com",
  "API.DX-OS.COM",
  "api.dx-os.com:8443",
  "api.dx-os.com.",
];

const ALLOWED_URLS = [
  "http://127.0.0.1:9999/x",
  "https://example.com/x",
  "https://notdx-os.com/x",
  "https://api.dx-os.com.evil.example/x",
];

function formsFor(href) {
  return [
    ["string", href],
    ["Request", new Request(href)],
    ["URL", new URL(href)],
  ];
}

test("出口护栏：string / Request / URL × dx-os.com 变体全部 MEDIA_FORBIDDEN", () => {
  const guarded = createGuardedFetch(async () => ({ ok: true, status: 200 }));
  for (const host of FORBIDDEN_HOSTS) {
    const href = "https://" + host + "/v1/models";
    for (const [kind, input] of formsFor(href)) {
      assert.throws(() => guarded(input), (error) => {
        assert.equal(error.name, "MediaError", kind + " " + href);
        assert.equal(error.code, "MEDIA_FORBIDDEN", kind + " " + href);
        assert.equal(error.code, mediaDomain.MEDIA_ERR_FORBIDDEN);
        return true;
      }, kind + " " + href);
    }
  }
});

test("出口护栏：本地 / 公网自配端点（string / Request / URL）仍放行", async () => {
  const seen = [];
  const guarded = createGuardedFetch(async (input) => {
    seen.push(typeof input === "string" ? input : input.url || input.href);
    return { ok: true, status: 200 };
  });
  for (const href of ALLOWED_URLS) {
    for (const [kind, input] of formsFor(href)) {
      const response = await guarded(input);
      assert.equal(response.ok, true, kind + " " + href);
    }
  }
  assert.equal(seen.length, ALLOWED_URLS.length * 3);
});
