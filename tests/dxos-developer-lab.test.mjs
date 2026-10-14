/**
 * B7b · 开发者实验室 + 文档/图标资源投影（源 developerLab.ts / developerLabExamples.ts /
 * developerDocs.ts / developerIcon.ts）。全程离线，不联网。
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const lab = require("../electron/developer-lab.cjs");
const { readZip } = require("../electron/canvas-dxos-zip.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oa-developer-lab-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const instance = new lab.DeveloperLab({ rootDir: path.join(tmp, "lab"), idFactory: () => crypto.randomUUID() });

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

// 源 developerLabExamples.ts 三段模板 + manifest 的独立指纹（从只读源一次性算出，写入测试常量）。
const GOMOKU_SHA = Object.freeze({
  "dx-app.json": "81bc13058d2230a2bd2363812b63fc10ced3e6b3ab6f6a74a4b3d58ea243f02c",
  "index.html": "98b168f086c3ce2dbf0de05c0ca7e977119c9844be6b1d397642184dbe191826",
  "assets/app.css": "5101c1a4996d2b09873358c9b2ae1f4b28984f595952cecb31ae8e4a082128c8",
  "assets/app.js": "0aa2575ddc88a4aadf9d887ce311fdefdbb76c2a70dd2998a8a4a9da756605ea",
});

test("示例工程逐字：四个文件与源 SHA-256 完全一致", () => {
  const files = lab.gomokuDeveloperLabFiles();
  assert.deepEqual(files.map((file) => file.path), ["dx-app.json", "index.html", "assets/app.css", "assets/app.js"]);
  for (const file of files) {
    assert.equal(sha256(Buffer.from(file.content, "utf8")), GOMOKU_SHA[file.path], file.path + " 必须与源逐字一致");
  }
  const manifest = JSON.parse(files[0].content);
  assert.equal(manifest.id, "dx-gomoku");
  assert.equal(manifest.name, "五子棋");
  assert.equal(manifest.version, "1.0.0");
  assert.equal(manifest.build, 10000);
  assert.equal(manifest.entry, "index.html");
  assert.equal(manifest.format, "dx-app/v2");
  assert.ok(files[1].content.includes('src="assets/app.js"'));
  assert.ok(files[2].content.includes('html[data-theme="dark"]'));
  assert.ok(files[3].content.includes("class GomokuEngine"));
});

test("模板清单：列出示例模板且不修改源数据", () => {
  const templates = lab.listDeveloperLabTemplates();
  assert.equal(templates.length, 1);
  assert.equal(templates[0].id, "dx-gomoku");
  assert.equal(templates[0].fileCount, 4);
  assert.throws(() => lab.buildDeveloperLabTemplate("nope"), /不存在/);
  const first = lab.buildDeveloperLabTemplate("dx-gomoku");
  first[0].content = "tampered";
  assert.equal(lab.gomokuDeveloperLabFiles()[0].content.length > 0, true);
  assert.notEqual(lab.gomokuDeveloperLabFiles()[0].content, "tampered");
});

test("创建 / 读取 / 列表 / 写文件：检查项随源码重算", () => {
  const draft = instance.createDeveloperLabDraftFromTemplate({ templateId: "dx-gomoku", ownerId: "u1", summary: "第一版" });
  assert.equal(draft.appId, "dx-gomoku");
  assert.equal(draft.ownerId, "u1");
  assert.equal(draft.files.length, 4);
  const byId = Object.fromEntries(draft.checks.map((check) => [check.id, check.status]));
  assert.equal(byId.manifest, "pass");
  assert.equal(byId.entry, "pass");
  assert.equal(byId.theme, "pass");

  const read = instance.readDeveloperLabFile(draft.id, "dx-app.json");
  assert.equal(JSON.parse(read.content).id, "dx-gomoku");
  assert.equal(instance.getDeveloperLabDraft(draft.id).summary, "第一版");
  assert.equal(instance.listDeveloperLabDrafts().length, 1);

  // 写入 index.html：会读 window.parent 属性 → 沙箱检查必须转 fail（源 analyze 的 sandbox 项）。
  const updated = instance.writeDeveloperLabFile(draft.id, "index.html", "<html><head></head><body><script>window.parent.document.title='x'</script></body></html>");
  assert.equal(updated.checks.find((check) => check.id === "sandbox").status, "fail");
  assert.equal(updated.files.find((file) => file.path === "index.html").bytes > 0, true);

  // 直接写一个不存在的文件 / 被禁扩展名一律拒绝。
  assert.throws(() => instance.writeDeveloperLabFile(draft.id, "missing.html", "x"), /不存在/);
  assert.throws(() => instance.writeDeveloperLabFile(draft.id, "evil.sh", "x"), /不支持该文件类型/);
  assert.throws(() => instance.readDeveloperLabFile(draft.id, "../dx-app.json"), /不安全文件路径/);
});

test("图标投影：自动生成、SVG 安全过滤、PNG data URL 校验", () => {
  const icon = lab.autoDeveloperIcon("五子棋", "dx-gomoku");
  assert.match(icon.gradient, /^linear-gradient\(145deg,#[0-9a-f]{6},#[0-9a-f]{6}\)$/);
  assert.match(icon.svg, /^<svg /);
  assert.ok(icon.svg.includes(">五<"), "源取名称的首个字母/数字/文字作为字形");
  assert.deepEqual(lab.autoDeveloperIcon("五子棋", "dx-gomoku"), icon);

  const normalized = lab.normalizeDeveloperIcon({ gradient: "linear-gradient(145deg,#111,#222)", svg: '<svg viewBox="0 0 1 1"></svg>' });
  assert.equal(normalized.gradient, "linear-gradient(145deg,#111,#222)");
  assert.throws(() => lab.normalizeDeveloperIcon({ svg: '<svg><script>alert(1)</script></svg>' }), /不安全内容/);
  assert.throws(() => lab.normalizeDeveloperIcon({ svg: "<div>不是 svg</div>" }), /svg/i);
  assert.equal(lab.normalizeDeveloperIcon(null, false), undefined);
  assert.equal(lab.normalizeDeveloperIcon(null, true).svg, lab.DEVELOPER_ICON_FALLBACK_SVG);

  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from([0, 0, 0, 0])]);
  const dataUrl = lab.pngDataUrl(png);
  assert.match(dataUrl, /^data:image\/png;base64,/);
  assert.throws(() => lab.pngDataUrl(Buffer.from("notpng")), /不是有效的 PNG/);
});

test("zip / preview / previewToken", () => {
  const draft = instance.createDeveloperLabDraftFromTemplate({ templateId: "dx-gomoku", ownerId: "u2" });
  const zipped = instance.developerLabZip(draft.id);
  const entries = readZip(zipped.buffer);
  assert.deepEqual(entries.map((entry) => entry.name).sort(), ["assets/app.css", "assets/app.js", "dx-app.json", "index.html"]);
  assert.equal(entries.find((entry) => entry.name === "index.html").data.toString("utf8").includes("五子棋"), true);

  const preview = instance.developerLabPreview(draft.id, "index.html");
  assert.equal(preview.mime, "text/html");
  assert.equal(preview.data.toString("utf8").includes("GomokuEngine"), false);
  assert.equal(instance.developerLabPreview(draft.id, "assets/app.js").mime, "text/javascript");
  assert.throws(() => instance.developerLabPreview(draft.id, "missing.html"), /预览文件不存在/);

  assert.equal(instance.verifyDeveloperLabPreviewToken(draft.id, draft.previewToken).id, draft.id);
  assert.throws(() => instance.verifyDeveloperLabPreviewToken(draft.id, "wrong"), /凭证无效/);
});

test("草稿归属与删除", () => {
  const draft = instance.createDeveloperLabDraftFromTemplate({ templateId: "dx-gomoku", ownerId: "owner-a" });
  assert.throws(() => instance.setDeveloperLabDraftOwner(draft.id, "owner-b"), /其他账户/);
  const rebound = instance.setDeveloperLabDraftOwner(draft.id, "owner-a");
  assert.equal(rebound.ownerId, "owner-a");
  assert.equal(instance.deleteDeveloperLabDraft(draft.id), true);
  assert.equal(instance.deleteDeveloperLabDraft(draft.id), false);
});

test("清单校验：缺权限声明 / 缺入口 / 非法 appId 一律拒绝", () => {
  const template = lab.gomokuDeveloperLabFiles();
  const manifest = JSON.parse(template[0].content);
  const realtimeManifest = { ...manifest, id: "dx-rt", permissions: [] };
  const files = [
    { path: "dx-app.json", content: JSON.stringify(realtimeManifest) },
    { path: "index.html", content: "<html><body><script>parent.postMessage({action:'realtime.room.join'},'*')</script></body></html>" },
  ];
  const draft = instance.createDeveloperLabDraft({ files, ownerId: "u1" });
  const manifestCheck = draft.checks.find((check) => check.id === "manifest");
  assert.equal(manifestCheck.status, "fail");
  assert.match(manifestCheck.detail, /realtime\.room/);

  assert.throws(() => instance.createDeveloperLabDraft({ files: [{ path: "index.html", content: "x" }], ownerId: "u1" }), /缺少 dx-app\.json/);
  assert.throws(() => instance.createDeveloperLabDraft({
    files: [{ path: "dx-app.json", content: JSON.stringify({ ...manifest, id: "BAD ID" }) }, { path: "index.html", content: "x" }], ownerId: "u1",
  }), /英文小写/);
  assert.throws(() => instance.createDeveloperLabDraft({
    files: [{ path: "dx-app.json", content: JSON.stringify({ ...manifest, entry: "nope.html" }) }], ownerId: "u1",
  }), /缺少入口文件/);
});

// ---------------------------------------------------------------------------
// 文档投影（离线）
// ---------------------------------------------------------------------------

function writeDocsFixture() {
  const dir = path.join(tmp, "docs-" + crypto.randomUUID().slice(0, 8));
  const markdown = Buffer.from("# 开发者文档\n\n离线缓存正文", "utf8");
  const etag = sha256(Buffer.from("etag-body"));
  const manifest = {
    format: "dx-developer-docs-manifest/v1", locale: "zh-CN", etag, updatedAt: 1,
    documents: [{
      slug: "app/hello", category: "app", locale: "zh-CN", title: "Hello", summary: "s", sortOrder: 1,
      version: "1.0.0", sha256: sha256(markdown), byteSize: markdown.byteLength,
      minimumSystemVersion: null, maximumSystemVersion: null, protocolVersions: ["1.0.0"], publishedAt: 1,
    }],
  };
  fs.mkdirSync(path.join(dir, "zh-CN", "app"), { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "zh-CN", "app", "hello.md"), markdown);
  return { dir, manifest, markdown };
}

test("文档投影：本地清单校验 + 正文读取，篡改后拒绝", () => {
  const fixture = writeDocsFixture();
  const cached = lab.cachedDeveloperDocs({ dir: fixture.dir });
  assert.equal(cached.format, "dx-developer-docs-manifest/v1");
  assert.equal(cached.documents.length, 1);

  const doc = lab.developerDocument({ dir: fixture.dir, slug: "app/hello" });
  assert.equal(doc.document.markdown, fixture.markdown.toString("utf8"));
  assert.equal(doc.source, "cache");
  assert.equal(lab.developerDocsCacheStatus({ dir: fixture.dir }).available, true);

  // 篡改正文 → 完整性校验失败 → 缓存整体不可用（不会半读）。
  fs.writeFileSync(path.join(fixture.dir, "zh-CN", "app", "hello.md"), "tampered");
  assert.equal(lab.cachedDeveloperDocs({ dir: fixture.dir }), null);
  assert.throws(() => lab.developerDocument({ dir: fixture.dir, slug: "app/hello" }), /尚无可用的离线开发文档/);

  // 非法清单条目（sha256 不是 64 hex）直接拒绝。
  assert.throws(() => lab.validateDeveloperDocumentManifest({ ...fixture.manifest, documents: [{ ...fixture.manifest.documents[0], sha256: "zzz" }] }), /无效条目/);
  assert.throws(() => lab.developerDocumentPath(fixture.dir, "app/../evil", "zh-CN"), /路径无效/);
});

test("文档远端刷新属 OUT：一律结构化拒绝，不产生任何请求", () => {
  const result = lab.refreshDeveloperDocs();
  assert.equal(result.ok, false);
  assert.equal(result.error, "DEVELOPER_DOCS_REMOTE_DISABLED");
  assert.equal(result.detail, "network-out");
});

// ---------------------------------------------------------------------------
// 命令面
// ---------------------------------------------------------------------------

test("命令面：并入 developer:command，未知命令结构化拒绝", () => {
  const docs = writeDocsFixture();
  const extension = lab.createDeveloperLabExtension({ lab: instance, docsDir: docs.dir });
  assert.equal(extension.channel, "developer:command");
  assert.equal(extension.eventChannel, "developer:event");

  const templates = extension.dispatch({ command: "developer/lab/templates", payload: {} });
  assert.equal(templates.ok, true);
  assert.equal(templates.templates.length, 1);

  const created = extension.dispatch({ command: "developer/lab/createFromTemplate", payload: { templateId: "dx-gomoku", ownerId: "cmd-user" } });
  assert.equal(created.ok, true);
  assert.equal(created.draft.appId, "dx-gomoku");

  const catalog = extension.dispatch({ command: "developer/docs/catalog", payload: {} });
  assert.equal(catalog.ok, true);
  assert.equal(catalog.manifest.documents.length, 1);
  const refresh = extension.dispatch({ command: "developer/docs/refresh", payload: {} });
  assert.equal(refresh.error, "DEVELOPER_DOCS_REMOTE_DISABLED");

  const denied = extension.dispatch({ command: "developer/does-not-exist", payload: {} });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "DEVELOPER_COMMAND_NOT_ALLOWED");

  // 未注入 lab 时结构化不可用，不假执行。
  const empty = lab.createDeveloperLabExtension({});
  const unavailable = empty.dispatch({ command: "developer/lab/list", payload: {} });
  assert.equal(unavailable.error, "DEVELOPER_LAB_UNAVAILABLE");
});

test("命令合流：多个切片共用一个 developer:command，未命中回落 base", async () => {
  const extension = lab.createDeveloperLabExtension({ lab: instance });
  const fakeSlice = {
    channel: "developer:command",
    registry: [{ command: "developer/other/echo", risk: "read", credential: "none", summary: "测试切片" }],
    dispatch: ({ payload }) => ({ ok: true, echoed: payload.value }),
  };
  const handler = lab.combineDeveloperCommandHandlers({ extensions: [extension, fakeSlice] });
  assert.equal(handler.channel, "developer:command");
  assert.equal(handler.eventChannel, "developer:event");
  assert.equal((await handler({}, { command: "developer/other/echo", payload: { value: 7 } })).echoed, 7);
  assert.equal((await handler({}, { command: "developer/lab/templates", payload: {} })).ok, true);
  // 未命中且无 base → 结构化拒绝（不新建域）。
  assert.equal((await handler({}, { command: "developer/unknown", payload: {} })).error, "DEVELOPER_COMMAND_NOT_ALLOWED");
  // 有 base 时回落既有域。
  const withBase = lab.combineDeveloperCommandHandlers({ base: () => ({ ok: true, fromBase: true }), extensions: [extension] });
  assert.equal((await withBase({}, { command: "developer/unknown", payload: {} })).fromBase, true);

  // 下行：只认 developer:event。
  const events = [];
  const wired = lab.wireDeveloperEvents({ extensions: [{ channel: "developer:command", onEvent: (handler2) => handler2({ type: "ping" }) }], send: (event) => events.push(event) });
  assert.deepEqual(wired, ["developer:command"]);
  assert.deepEqual(events, [{ channel: "developer:event", type: "ping" }]);
});

test("一体化装配：四个切片并入唯一 developer:command", async () => {
  const { DeveloperRealtimeHub } = require("../electron/developer-realtime.cjs");
  const all = lab.createDeveloperDomainExtensions({ lab: instance, realtimeHub: new DeveloperRealtimeHub({ authorize: () => true }) });
  assert.equal(all.channel, "developer:command");
  assert.equal(all.eventChannel, "developer:event");
  assert.equal(all.extensions.length, 2);
  assert.ok(all.commandNames.includes("developer/lab/templates"));
  assert.ok(all.commandNames.includes("developer/realtime/stats"));
  const handler = all.combine({});
  assert.equal((await handler({}, { command: "developer/lab/templates", payload: {} })).ok, true);
  assert.equal((await handler({}, { command: "developer/unknown", payload: {} })).error, "DEVELOPER_COMMAND_NOT_ALLOWED");
});
