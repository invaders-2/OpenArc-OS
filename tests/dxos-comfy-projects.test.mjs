/**
 * B7e2 · ComfyUI 项目 / 工作流绑定测试（全离线：本地临时目录 + 假 sharp；不联网）。
 *
 * 覆盖任务书验收点：
 *   ① 项目 CRUD（创建 / 列表剥离 workflow / 读取 / 更新 / 删除 / 不存在）；
 *   ② RunningHub 项目（kind / targetUrl 校验 / 实例 mode 检测）；
 *   ③ 工作流校验 + 20MB 上限来源、structuredClone 隔离；
 *   ④ 封面：假 sharp 落盘、替换删旧、删除项目清封面；sharp 缺失结构化不可用；
 *   ⑤ 存储：JSON 数组 + .bak 备份；错误统一 { ok:false, error, detail }。
 *
 * 只读源：server/comfyProjects.ts:1-161；electron/comfy-projects.cjs。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createComfyProjects, isRunningHubUrl, normalizeWorkflow, STORE_FILE_NAME, COVER_DIR_NAME } = require("../electron/comfy-projects.cjs");

const tmpDirs = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-comfy-")); tmpDirs.push(dir); return dir; }

const WORKFLOW = { nodes: [{ id: 1, type: "KSampler", widgets_values: [20] }], links: [] };

function fakeSharpFactory(calls) {
  return (buffer) => ({
    rotate() { calls.push("rotate"); return this; },
    resize(width, height, options) { calls.push(["resize", width, height, options]); return this; },
    webp(options) { calls.push(["webp", options]); return this; },
    async toFile(target) { calls.push(["toFile", target]); fs.writeFileSync(target, Buffer.from("WEBP-BYTES")); },
  });
}

// ── ① CRUD ────────────────────────────────────────────────────────────────
test("CRUD：创建 / 列表剥离 workflow / 读取 / 更新 / 删除 / 不存在", async () => {
  const dataDir = tempDir();
  const store = createComfyProjects({ dataDir, clock: (() => { let value = 1000; return () => (value += 10); })() });

  const created = await store.saveComfyProject("owner-1", { name: "项目 A", description: " 说明 ", workflow: WORKFLOW, workflowName: "a.json" });
  assert.equal(created.ok, true, JSON.stringify(created));
  const id = created.value.id;
  assert.equal(created.value.kind, "comfyui");
  assert.equal(created.value.ownerId, "shared");
  assert.equal(created.value.name, "项目 A");
  assert.equal(created.value.description, "说明", "description 去空白");
  assert.ok(fs.existsSync(path.join(dataDir, STORE_FILE_NAME)));

  const listed = await store.listComfyProjects("owner-1");
  assert.equal(listed.ok, true);
  assert.equal(listed.value.items.length, 1);
  assert.equal(listed.value.items[0].workflow, undefined, "列表必须剥离 workflow");
  assert.equal(listed.value.items[0].id, id);

  const got = await store.getComfyProject("owner-1", id);
  assert.equal(got.ok, true);
  assert.equal(got.value.workflow.nodes.length, 1);

  const updated = await store.saveComfyProject("owner-1", { id, name: "项目 B", workflow: WORKFLOW });
  assert.equal(updated.value.name, "项目 B");
  assert.equal(updated.value.createdAt, created.value.createdAt, "createdAt 必须保持");
  assert.ok(updated.value.updatedAt > created.value.updatedAt);

  const removed = await store.deleteComfyProject("owner-1", id);
  assert.equal(removed.ok, true);
  assert.equal((await store.listComfyProjects("owner-1")).value.items.length, 0);
  const missing = await store.getComfyProject("owner-1", id);
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "INTEGRATION_NOT_FOUND");
});

test("存储：JSON 数组 + 第二次写入产生 .bak 备份；structuredClone 与入参隔离", async () => {
  const dataDir = tempDir();
  const store = createComfyProjects({ dataDir });
  const input = { name: "A", workflow: structuredClone(WORKFLOW) };
  const created = await store.saveComfyProject("o", input);
  input.workflow.nodes[0].widgets_values[0] = 999;
  const got = await store.getComfyProject("o", created.value.id);
  assert.equal(got.value.workflow.nodes[0].widgets_values[0], 20, "入参后续修改不得影响已存工作流");

  await store.saveComfyProject("o", { name: "B", workflow: WORKFLOW });
  assert.ok(fs.existsSync(path.join(dataDir, STORE_FILE_NAME + ".bak")), "第二次写入必须产生 .bak");
  const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, STORE_FILE_NAME), "utf8"));
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 2, "未带 id 的保存会新建项目");
});

// ── ② RunningHub 项目 ─────────────────────────────────────────────────────
test("RunningHub：kind / targetUrl 规范化与校验 / 实例 mode 检测", async () => {
  const dataDir = tempDir();
  const store = createComfyProjects({
    dataDir,
    loadComfyConfig: () => ({ instances: [{ id: "rh-1", mode: "runninghub" }] }),
  });
  const rh = await store.saveComfyProject("o", { name: "RH 项目", kind: "runninghub", targetUrl: "https://www.runninghub.ai/project/1?x=1" });
  assert.equal(rh.ok, true, JSON.stringify(rh));
  assert.equal(rh.value.kind, "runninghub");
  assert.equal(rh.value.targetUrl, "https://www.runninghub.ai/project/1?x=1");
  assert.equal(rh.value.workflow, undefined, "RunningHub 项目不保存工作流");

  const invalid = await store.saveComfyProject("o", { name: "坏", kind: "runninghub", targetUrl: "https://evil.example/x" });
  assert.equal(invalid.error, "INTEGRATION_INVALID_INPUT");
  assert.match(invalid.detail, /RunningHub/);

  const byInstance = await store.saveComfyProject("o", { name: "实例项目", instanceId: "rh-1", targetUrl: "https://www.runninghub.cn/p/2" });
  assert.equal(byInstance.value.kind, "runninghub", "实例 mode=runninghub 时自动判定");
  assert.equal(byInstance.value.targetUrl, "https://www.runninghub.cn/p/2");

  const unknownInstance = await store.saveComfyProject("o", { name: "缺实例", instanceId: "nope", workflow: WORKFLOW });
  assert.equal(unknownInstance.error, "INTEGRATION_INVALID_INPUT");
  assert.match(unknownInstance.detail, /实例不存在/);
});

test("URL 判定：仅 https + runninghub.ai / runninghub.cn", () => {
  assert.equal(isRunningHubUrl("https://www.runninghub.ai/x"), true);
  assert.equal(isRunningHubUrl("https://runninghub.cn/x"), true);
  assert.equal(isRunningHubUrl("http://www.runninghub.ai/x"), false, "非 https 拒绝");
  assert.equal(isRunningHubUrl("https://notrunninghub.ai/x"), false);
  assert.equal(isRunningHubUrl("https://runninghub.ai.evil.example/x"), false);
  assert.equal(isRunningHubUrl("not a url"), false);
});

// ── ③ 工作流校验 ──────────────────────────────────────────────────────────
test("工作流校验：非对象 / 缺 nodes / 空 nodes 都结构化拒绝", async () => {
  assert.throws(() => normalizeWorkflow(null), /工作流必须是 JSON 对象/);
  assert.throws(() => normalizeWorkflow({}), /包含 nodes/);
  assert.throws(() => normalizeWorkflow({ nodes: [] }), /没有节点/);
  const dataDir = tempDir();
  const store = createComfyProjects({ dataDir });
  const invalid = await store.saveComfyProject("o", { name: "无工作流" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, "INTEGRATION_INVALID_INPUT");
  assert.match(invalid.detail, /工作流/);
  const emptyNodes = await store.saveComfyProject("o", { name: "空节点", workflow: { nodes: [] } });
  assert.equal(emptyNodes.error, "INTEGRATION_INVALID_INPUT");
  assert.match(emptyNodes.detail, /没有节点/);
});

// ── ④ 封面 ────────────────────────────────────────────────────────────────
test("封面：假 sharp 落盘 / 替换删旧 / 删除项目清封面 / 读取校验", async () => {
  const dataDir = tempDir();
  const calls = [];
  const store = createComfyProjects({ dataDir, sharpLoader: () => fakeSharpFactory(calls) });
  const created = await store.saveComfyProject("o", { name: "带封面", workflow: WORKFLOW });
  const id = created.value.id;

  const cover = await store.saveComfyProjectCover("o", id, { buffer: Buffer.from("PNGDATA"), mime: "image/png" });
  assert.equal(cover.ok, true, JSON.stringify(cover));
  assert.match(cover.value.coverUrl, /^\/api\/comfyui\/project-covers\/[a-f0-9-]+\.webp$/);
  assert.ok(fs.existsSync(path.join(dataDir, COVER_DIR_NAME, path.basename(cover.value.coverUrl))));
  assert.deepEqual(calls.find((entry) => Array.isArray(entry) && entry[0] === "resize").slice(1), [1200, 675, { fit: "cover", withoutEnlargement: true }]);
  assert.equal(calls.some((entry) => entry === "rotate"), true);

  const fetched = await store.getComfyProjectCover("o", path.basename(cover.value.coverUrl));
  assert.equal(fetched.ok, true);
  assert.equal(fs.existsSync(fetched.value.path), true);

  const firstFile = path.join(dataDir, COVER_DIR_NAME, path.basename(cover.value.coverUrl));
  const replaced = await store.saveComfyProjectCover("o", id, { buffer: Buffer.from("PNG2"), mime: "image/webp" });
  assert.equal(replaced.ok, true);
  assert.equal(fs.existsSync(firstFile), false, "替换封面必须删除旧文件");

  const badMime = await store.saveComfyProjectCover("o", id, { buffer: Buffer.from("x"), mime: "text/plain" });
  assert.equal(badMime.error, "INTEGRATION_INVALID_INPUT");
  const tooBig = await store.saveComfyProjectCover("o", id, { buffer: Buffer.alloc(10 * 1024 * 1024 + 1), mime: "image/png" });
  assert.equal(tooBig.error, "INTEGRATION_INVALID_INPUT");

  const secondFile = path.join(dataDir, COVER_DIR_NAME, path.basename(replaced.value.coverUrl));
  assert.equal((await store.deleteComfyProject("o", id)).ok, true);
  assert.equal(fs.existsSync(secondFile), false, "删除项目必须清封面");
  const badName = await store.getComfyProjectCover("o", "../../etc/passwd");
  assert.equal(badName.error, "INTEGRATION_NOT_FOUND");
});

test("封面：sharp 惰性加载失败 → INTEGRATION_UNAVAILABLE（不写文件、不加入依赖）", async () => {
  const dataDir = tempDir();
  const store = createComfyProjects({ dataDir, sharpLoader: () => { throw new Error("Cannot find module 'sharp'"); } });
  const created = await store.saveComfyProject("o", { name: "x", workflow: WORKFLOW });
  const cover = await store.saveComfyProjectCover("o", created.value.id, { buffer: Buffer.from("x"), mime: "image/png" });
  assert.equal(cover.ok, false);
  assert.equal(cover.error, "INTEGRATION_UNAVAILABLE");
  assert.match(cover.detail, /sharp/);
  assert.equal(fs.existsSync(path.join(dataDir, COVER_DIR_NAME)), false, "失败不得留下封面目录内容");
});
