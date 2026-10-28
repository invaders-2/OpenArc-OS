/**
 * task-9 · 渲染成片导出（访达 / 资源库）回归。
 *
 * 真实媒体域：createMediaBundle + media:command + media-store 的渲染任务生命周期
 * （queued → running → completed）；真实资源域：tests/resource-fixtures.mjs。
 * 断言红线：IPC 返回值绝不包含绝对路径；非法文件名 / target / 未完成任务全部结构化拒绝。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createResourceFixture } from "./resource-fixtures.mjs";

const require = createRequire(import.meta.url);
const { createMediaBundle } = require("../electron/media-service.cjs");
const { createMediaResourceRegistrar } = require("../electron/media-resource-registrar.cjs");
const mediaStore = require("../electron/media-store.cjs");
const mediaLibrary = require("../electron/media-library.cjs");
const mediaShortDrama = require("../electron/media-short-drama.cjs");

const tempDirs = [];
const openFixtures = [];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const WORKER = "worker-export";

afterEach(() => {
  mediaStore.resetMediaStoreForTests();
  mediaLibrary.resetLibraryForTests();
  mediaShortDrama.configureShortDrama({ dataDir: null, fsAdapter: null, fetchImpl: null, providerStore: null, modelGateway: null, mediaStore: null, renderSubmit: null, resourceRegistrar: null });
  while (openFixtures.length) { try { openFixtures.pop().close(); } catch { /* 已关 */ } }
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function makeHarness({ withRegistrar = true } = {}) {
  const fixture = await createResourceFixture();
  openFixtures.push(fixture);
  const dir = tempDir("oa-media-export-");
  const admin = fixture.identity.validateSession(fixture.sessions.admin, { sensitive: false }).user;
  const registrar = withRegistrar
    ? createMediaResourceRegistrar({ resourceService: fixture.resourceService, resourceStore: fixture.resourceStore, identity: fixture.identity, tempDir: path.join(dir, "tmp") })
    : null;
  const revealed = [];
  const bundle = createMediaBundle({
    userDataDir: dir,
    identityStore: fixture.identity,
    authorization: { resolveActor: () => ({ ok: true, user: { id: admin.id, team_id: admin.team_id } }) },
    resourceRegistrar: registrar,
    revealExport: (absolutePath) => { revealed.push(String(absolutePath)); return true; },
    clock: () => Date.now(),
  });
  const context = { sessionRef: fixture.sessions.admin, appId: "ai" };
  return {
    fixture, dir, admin, registrar, bundle, context, revealed,
    call: (command, payload = {}) => bundle.execute(command, payload, context),
    fixtureContext: fixture.adminCtx(),
  };
}

/** 直接用 media-store 造一条"已完成"的渲染任务（真实状态机：queued → running → completed）。 */
function createCompletedJob({ ownerId, projectId = randomUUID(), projectName = "短剧", completed = true } = {}) {
  const asset = mediaStore.saveVideoAsset({
    projectId, ownerId, projectName,
    name: "frame.png", mime: "image/png",
    buffer: PNG,
    probe: { durationMs: 2000, width: 1080, height: 1920, hasVideo: true, hasAudio: false },
  });
  const timeline = {
    schemaVersion: "1.0", projectId, version: 1, timebase: 1000,
    canvas: { width: 1080, height: 1920, fps: 30 }, durationMs: 2000, outputProfileId: "short-drama",
    tracks: [{
      id: "video-1", type: "video", name: "分镜", order: 1, locked: false, muted: false, hidden: false,
      clips: [{ id: "c1", trackId: "video-1", assetId: asset.id, name: "开场", timelineStartMs: 0, durationMs: 2000, sourceInMs: 0, sourceOutMs: 2000, volume: 1 }],
    }],
  };
  const job = mediaStore.createVideoRenderJob({ projectId, ownerId, projectName, timeline });
  if (!completed) return { jobId: job.id, projectId, outputPath: null };
  mediaStore.claimNextVideoRenderJob(WORKER, 30000);
  const partial = path.join(mediaStore.getMediaDirs().renders, job.id + ".partial.mp4");
  fs.mkdirSync(path.dirname(partial), { recursive: true });
  fs.writeFileSync(partial, Buffer.from("fake-mp4-bytes"));
  const outputPath = mediaStore.completeVideoRenderJob(job.id, WORKER, partial);
  return { jobId: job.id, projectId, outputPath };
}

test("导出到访达：返回安全相对路径（不含绝对路径），文件真实落盘并 reveal", async () => {
  const h = await makeHarness();
  const { jobId } = createCompletedJob({ ownerId: h.admin.id });
  const exported = await h.call("media/render/export", { jobId, target: "finder", name: "短剧成片" });
  assert.equal(exported.ok, true, JSON.stringify(exported));
  assert.equal(exported.value.target, "finder");
  assert.equal(exported.value.relativePath, "exports/短剧成片.mp4");
  assert.equal(exported.value.fileName, "短剧成片.mp4");
  assert.equal(exported.value.revealed, true);
  assert.equal(JSON.stringify(exported.value).includes(h.dir), false, "返回值不得含绝对路径");
  const onDisk = path.join(h.dir, "dxos", "exports", "短剧成片.mp4");
  assert.ok(fs.existsSync(onDisk), "导出文件必须真实存在");
  assert.equal(fs.readFileSync(onDisk, "utf8"), "fake-mp4-bytes");
  assert.equal(h.revealed.length, 1);
  assert.equal(h.revealed[0], onDisk, "reveal 只接收主进程内的绝对路径");
});

test("导出到访达：同名不覆盖（-1 后缀），第二次仍返回相对路径", async () => {
  const h = await makeHarness();
  const { jobId } = createCompletedJob({ ownerId: h.admin.id });
  const first = await h.call("media/render/export", { jobId, target: "finder", name: "同名" });
  const second = await h.call("media/render/export", { jobId, target: "finder", name: "同名" });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual([first.value.relativePath, second.value.relativePath], ["exports/同名.mp4", "exports/同名-1.mp4"]);
  assert.ok(fs.existsSync(path.join(h.dir, "dxos", "exports", "同名.mp4")));
  assert.ok(fs.existsSync(path.join(h.dir, "dxos", "exports", "同名-1.mp4")));
});

test("导出到资源库：返回 ResourceRef，资源库可读；重复导出同内容去重", async () => {
  const h = await makeHarness();
  const { jobId } = createCompletedJob({ ownerId: h.admin.id });
  const first = await h.call("media/render/export", { jobId, target: "library", name: "成片资源" });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.value.target, "library");
  assert.match(String(first.value.resourceRef), /^resource:\/\/res_/);
  assert.equal(first.value.deduped, false);
  const second = await h.call("media/render/export", { jobId, target: "library", name: "成片资源2" });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.value.deduped, true, "同 checksum 应复用既有资源");
  assert.equal(second.value.resourceRef, first.value.resourceRef);
  const list = h.fixture.resourceService.list({ context: h.fixtureContext, filter: { resourceType: "video" } });
  assert.equal(list.ok, true);
  assert.equal(list.count, 1);
  assert.equal(list.items[0].mimeType, "video/mp4");
  assert.equal(JSON.stringify(first.value).includes(h.dir), false);
});

test("short-drama/export：按 projectId 取最近一条已完成成片；没有成片 → MEDIA_NOT_FOUND", async () => {
  const h = await makeHarness();
  const { projectId } = createCompletedJob({ ownerId: h.admin.id });
  const emptyProject = randomUUID();
  const missing = await h.call("media/short-drama/export", { projectId: emptyProject, target: "finder" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "MEDIA_NOT_FOUND");
  assert.match(missing.message, /还没有可导出的成片/);

  const exported = await h.call("media/short-drama/export", { projectId, target: "finder", name: "短剧导出" });
  assert.equal(exported.ok, true, JSON.stringify(exported));
  assert.equal(exported.value.relativePath, "exports/短剧导出.mp4");

  const byProject = await h.call("media/render/export", { projectId, target: "library" });
  assert.equal(byProject.ok, true, JSON.stringify(byProject));
  assert.match(String(byProject.value.resourceRef), /^resource:\/\/res_/);
});

test("导出拒绝：非法 target / 非法文件名 / 未完成任务 / 未知任务 / 越权任务", async () => {
  const h = await makeHarness();
  const { jobId } = createCompletedJob({ ownerId: h.admin.id });
  const otherUserJob = createCompletedJob({ ownerId: "someone-else", completed: true });
  const queued = createCompletedJob({ ownerId: h.admin.id, completed: false });

  const cases = [
    [{ jobId, target: "shell" }, "MEDIA_INVALID_INPUT", /target 必须是/],
    [{ jobId }, "MEDIA_INVALID_INPUT", /target 必须是/],
    [{ jobId, target: "finder", name: "../evil" }, "MEDIA_INVALID_INPUT", /路径分隔符/],
    [{ jobId, target: "finder", name: "a/b" }, "MEDIA_INVALID_INPUT", /路径分隔符/],
    [{ jobId, target: "finder", name: "/tmp/evil" }, "MEDIA_INVALID_INPUT", /路径分隔符/],
    [{ jobId, target: "finder", name: 123 }, "MEDIA_INVALID_INPUT", /必须是字符串/],
    [{ jobId, target: "finder", name: "" }, "MEDIA_INVALID_INPUT", /不能为空/],
    [{ jobId: queued.jobId, target: "finder" }, "MEDIA_INVALID_INPUT", /尚未完成/],
    [{ jobId: "no-such-job", target: "finder" }, "MEDIA_NOT_FOUND", /不存在/],
    [{ jobId: otherUserJob.jobId, target: "finder" }, "MEDIA_NOT_FOUND", /不存在/],
    [{ target: "finder" }, "MEDIA_INVALID_INPUT", /jobId 或 projectId/],
  ];
  for (const [payload, code, pattern] of cases) {
    const result = await h.call("media/render/export", payload);
    assert.equal(result.ok, false, JSON.stringify(payload));
    assert.equal(result.error, code, JSON.stringify(payload));
    assert.match(result.message, pattern);
  }
});

test("main.cjs 装配契约：media bundle 注入资源库登记桥与访达 reveal（绝对路径只在主进程）", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "electron", "runtime-composition.cjs"), "utf8");
  assert.ok(main.includes('require("./media-resource-registrar.cjs")'), "main.cjs 必须装配 media-resource-registrar");
  assert.ok(main.includes("createMediaResourceRegistrar({"), "登记桥必须由真实 ResourceService 构造");
  assert.ok(main.includes("resourceService: identity.resourceService || null"), "登记桥必须接到身份运行时装配的真实 resourceService");
  const call = main.slice(main.indexOf("mediaBundle = createMediaBundle({"), main.indexOf("registerMediaIpc({"));
  assert.ok(call.includes("resourceRegistrar: mediaResourceRegistrar"), "media bundle 必须注入 resourceRegistrar");
  assert.ok(call.includes("revealExport:"), "media bundle 必须注入访达 reveal 适配器");
  assert.ok(main.includes("shell.showItemInFolder(String(absolutePath))"), "reveal 只能通过受控 shell API 打开访达");
});

test("导出失败结构化：成片文件被删 → NOT_FOUND；未注入 registrar 时 library 不可用但 finder 仍可用", async () => {
  const h = await makeHarness();
  const { jobId, outputPath } = createCompletedJob({ ownerId: h.admin.id });
  fs.rmSync(outputPath, { force: true });
  const missing = await h.call("media/render/export", { jobId, target: "finder" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "MEDIA_NOT_FOUND");
  assert.match(missing.message, /成片文件已不存在/);

  const noRegistrar = await makeHarness({ withRegistrar: false });
  const { jobId: job2 } = createCompletedJob({ ownerId: noRegistrar.admin.id });
  const library = await noRegistrar.call("media/render/export", { jobId: job2, target: "library" });
  assert.equal(library.ok, false);
  assert.equal(library.error, "MEDIA_DEPENDENCY_UNAVAILABLE");
  assert.equal(library.detail.dependency, "resourceRegistrar");
  const finder = await noRegistrar.call("media/render/export", { jobId: job2, target: "finder" });
  assert.equal(finder.ok, true, JSON.stringify(finder));
  assert.equal(finder.value.relativePath.startsWith("exports/"), true);
});
