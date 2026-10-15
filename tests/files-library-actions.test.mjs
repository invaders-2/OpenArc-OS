/**
 * Z2 · 访达窗口「加入资源库 / 导出」纯逻辑契约单测（不启动浏览器、不依赖 DOM）。
 *
 * 测的是**界面真正在用**的那一份 src/governance/filesLibraryActions.ts：
 *   · 入口可用性判定：未选中 / 只有文件夹 / 未入资源库 / 多选 / 进行中 / 桥缺失；
 *   · 错误码 → 人话文案（未登记码有兜底，不把原始码当正文）；
 *   · 命令载荷按键白名单构造（folderId / 条目 id 只允许 [A-Za-z0-9_-]，单批上限 200）；
 *   · 命令白名单与 electron/resource-bootstrap.cjs 的 RENDERER_COMMANDS 逐条对齐；
 *   · 全工程只有一份实现（FilesApp 已删除，命令字面量只出现在白名单与共享模块里）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
  ALLOWED_PAYLOAD_KEYS,
  LIBRARY_ENTRIES,
  LIBRARY_ENTRY_LABEL,
  LIBRARY_ERROR_TEXT,
  LIBRARY_REASON,
  RESOURCE_LIBRARY_COMMANDS,
  codeOfError,
  exportComputerSuccessText,
  exportResourcePayload,
  exportResourceSuccessText,
  exportToComputerPayload,
  importFromFilesPayload,
  libraryEntryAvailability,
  libraryErrorText,
  linkFromFilesPayload,
  payloadKeysAllowed,
  revealSourcePayload,
  runAddFromFiles,
  runExportResource,
  runExportToComputer,
  runRevealSource,
  safeFolderId,
  safeIds,
  selectionStats,
  toolbarEntryAvailability,
} from "../src/governance/filesLibraryActions.ts";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const { RENDERER_COMMANDS, registerResourceIpc } = require(path.join(ROOT, "electron/resource-bootstrap.cjs"));

const CTX = { hasResourceBridge: true, hasFilesBridge: true, busy: false };
const NONE = { fileCount: 0, folderCount: 0, knownResourceCount: 0, knownLinkedCount: 0 };
const ONE_FILE = { fileCount: 1, folderCount: 0, knownResourceCount: 0, knownLinkedCount: 0 };
const ONE_FOLDER = { fileCount: 0, folderCount: 1, knownResourceCount: 0, knownLinkedCount: 0 };
const MANAGED_KNOWN = { fileCount: 1, folderCount: 0, knownResourceCount: 1, knownLinkedCount: 0 };
const LINKED_KNOWN = { fileCount: 1, folderCount: 0, knownResourceCount: 1, knownLinkedCount: 1 };

/* ── 1. 入口可用性判定 ─────────────────────────────────────────────────── */

test("未选中：所有入口禁用，且原因不是空话", () => {
  for (const entry of LIBRARY_ENTRIES) {
    const av = libraryEntryAvailability(entry, NONE, CTX);
    assert.equal(av.enabled, false, entry + " 未选中必须禁用");
    assert.ok(av.reason.length > 0, entry + " 禁用必须给原因");
  }
  assert.equal(libraryEntryAvailability("add-managed", NONE, CTX).reason, LIBRARY_REASON.noSelection);
  assert.equal(toolbarEntryAvailability(NONE, CTX).enabled, false);
  assert.equal(toolbarEntryAvailability(NONE, CTX).reason, LIBRARY_REASON.noSelection);
});

test("只选中文件夹：加入资源库 / 导出到电脑都禁用，原因是「文件夹不能加入资源库」", () => {
  assert.equal(libraryEntryAvailability("add-managed", ONE_FOLDER, CTX).enabled, false);
  assert.equal(libraryEntryAvailability("add-managed", ONE_FOLDER, CTX).reason, LIBRARY_REASON.noFile);
  assert.equal(libraryEntryAvailability("export-computer", ONE_FOLDER, CTX).enabled, false);
  assert.equal(libraryEntryAvailability("export-computer", ONE_FOLDER, CTX).reason, LIBRARY_REASON.noFile);
  // 工具栏只要有选中（哪怕只有文件夹）就可打开菜单，让用户看到每项的原因。
  assert.equal(toolbarEntryAvailability(ONE_FOLDER, CTX).enabled, true);
});

test("选中一个文件：加入资源库 / 导出到电脑可用；导出资源要先入资源库", () => {
  assert.equal(libraryEntryAvailability("add-managed", ONE_FILE, CTX).enabled, true);
  assert.equal(libraryEntryAvailability("add-linked", ONE_FILE, CTX).enabled, true);
  assert.equal(libraryEntryAvailability("export-computer", ONE_FILE, CTX).enabled, true);
  const exp = libraryEntryAvailability("export-resource", ONE_FILE, CTX);
  assert.equal(exp.enabled, false);
  assert.equal(exp.reason, LIBRARY_REASON.notInLibrary);
  assert.equal(libraryEntryAvailability("export-resource", MANAGED_KNOWN, CTX).enabled, true);
});

test("导出资源 / 显示源文件只认「本窗口刚加入过」的单个文件", () => {
  const multi = { fileCount: 2, folderCount: 0, knownResourceCount: 2, knownLinkedCount: 2 };
  assert.equal(libraryEntryAvailability("export-resource", multi, CTX).reason, LIBRARY_REASON.needSingle);
  assert.equal(libraryEntryAvailability("reveal-source", multi, CTX).reason, LIBRARY_REASON.needLinked);
  assert.equal(libraryEntryAvailability("reveal-source", MANAGED_KNOWN, CTX).reason, LIBRARY_REASON.needLinked);
  assert.equal(libraryEntryAvailability("reveal-source", LINKED_KNOWN, CTX).enabled, true);
});

test("进行中：所有入口禁用，原因是「正在处理」；工具栏也禁用", () => {
  const busy = { hasResourceBridge: true, hasFilesBridge: true, busy: true };
  for (const entry of LIBRARY_ENTRIES) {
    const av = libraryEntryAvailability(entry, LINKED_KNOWN, busy);
    assert.equal(av.enabled, false, entry + " 进行中必须禁用");
    assert.equal(av.reason, LIBRARY_REASON.busy);
  }
  assert.equal(toolbarEntryAvailability(LINKED_KNOWN, busy).enabled, false);
  assert.equal(toolbarEntryAvailability(LINKED_KNOWN, busy).reason, LIBRARY_REASON.busy);
});

test("桥缺失：资源入口与文件导出分别给出各自的原因", () => {
  const noResource = { hasResourceBridge: false, hasFilesBridge: true, busy: false };
  const noFiles = { hasResourceBridge: true, hasFilesBridge: false, busy: false };
  assert.equal(libraryEntryAvailability("add-managed", ONE_FILE, noResource).reason, LIBRARY_REASON.noResourceBridge);
  assert.equal(libraryEntryAvailability("export-computer", ONE_FILE, noResource).enabled, true);
  assert.equal(libraryEntryAvailability("export-computer", ONE_FILE, noFiles).reason, LIBRARY_REASON.noFilesBridge);
  assert.equal(libraryEntryAvailability("add-managed", ONE_FILE, noFiles).enabled, true);
});

test("selectionStats：按选中项种类与已知资源引用统计", () => {
  const refs = { e1: { storageMode: "MANAGED" }, e2: { storageMode: "LINKED" } };
  const stats = selectionStats(
    [
      { kind: "file", id: "e1" },
      { kind: "file", id: "e2" },
      { kind: "file", id: "e3" },
      { kind: "folder", id: "f1" },
    ],
    refs,
  );
  assert.deepEqual(stats, { fileCount: 3, folderCount: 1, knownResourceCount: 2, knownLinkedCount: 1 });
});

/* ── 2. 错误码 → 文案 ─────────────────────────────────────────────────── */

test("错误码 → 人话文案：已登记码逐条有正文，未登记码有兜底", () => {
  assert.equal(libraryErrorText("NO_BRIDGE"), LIBRARY_ERROR_TEXT.NO_BRIDGE);
  assert.equal(libraryErrorText("IMPORTER_UNAVAILABLE"), LIBRARY_ERROR_TEXT.IMPORTER_UNAVAILABLE);
  assert.equal(libraryErrorText("NOT_FOUND_OR_FORBIDDEN"), LIBRARY_ERROR_TEXT.NOT_FOUND_OR_FORBIDDEN);
  for (const code of Object.keys(LIBRARY_ERROR_TEXT)) {
    assert.ok(LIBRARY_ERROR_TEXT[code].length > 0, code + " 文案不能为空");
    assert.ok(!LIBRARY_ERROR_TEXT[code].includes(code), code + " 正文不能回显原始码");
  }
  assert.equal(libraryErrorText("SOMETHING_UNKNOWN"), "资源库操作失败，请重试");
  assert.equal(libraryErrorText(undefined), "资源库操作失败，请重试");
});

test("codeOfError：缺失 / 非字符串一律收敛成 INTERNAL_ERROR", () => {
  assert.equal(codeOfError("X"), "X");
  assert.equal(codeOfError(""), "INTERNAL_ERROR");
  assert.equal(codeOfError(undefined), "INTERNAL_ERROR");
  assert.equal(codeOfError({ error: "X" }), "INTERNAL_ERROR");
});

test("成功文案说清结果落点", () => {
  assert.match(exportResourceSuccessText(128), /128 字节/);
  assert.match(exportComputerSuccessText(2, "/tmp/out"), /\/tmp\/out/);
  assert.match(exportComputerSuccessText(2, null), /你刚选择的文件夹/);
});

/* ── 3. 命令白名单与载荷键白名单 ───────────────────────────────────────── */

test("新增命令已登记进主进程 RENDERER_COMMANDS 白名单", () => {
  for (const cmd of RESOURCE_LIBRARY_COMMANDS) {
    assert.ok(RENDERER_COMMANDS.includes(cmd), "主进程白名单缺少 " + cmd);
  }
  assert.ok(RENDERER_COMMANDS.includes("resource/importFromFiles"));
  assert.ok(RENDERER_COMMANDS.includes("resource/linkFromFiles"));
});

test("载荷键白名单：操作者身份 / 路径字段不在表内", () => {
  assert.ok(payloadKeysAllowed("resource/importFromFiles", { type: "resource/importFromFiles", folderId: "desktop", ids: ["e1"] }));
  assert.equal(payloadKeysAllowed("resource/importFromFiles", { type: "resource/importFromFiles", folderId: "desktop", ids: [], appId: "files" }), false);
  assert.equal(payloadKeysAllowed("resource/importFromFiles", { type: "resource/importFromFiles", folderId: "desktop", ids: [], sessionRef: "s", path: "/etc/passwd" }), false);
  assert.equal(payloadKeysAllowed("files/exportTo", { folderId: "desktop", ids: ["e1"] }), true);
  assert.equal(payloadKeysAllowed("files/exportTo", { folderId: "desktop", ids: [], userId: "u1" }), false);
  assert.equal(payloadKeysAllowed("resource/unknown", {}), false);
  for (const keys of Object.values(ALLOWED_PAYLOAD_KEYS)) {
    for (const forbidden of ["sessionRef", "userId", "role", "appId", "path", "sourcePath", "token"]) {
      assert.equal(keys.includes(forbidden), false, forbidden + " 不得出现");
    }
  }
});

test("载荷构造：folderId / 条目 id 只允许 [A-Za-z0-9_-]，去重且有上限", () => {
  assert.equal(safeFolderId("desktop"), "desktop");
  assert.equal(safeFolderId("../etc"), "");
  assert.equal(safeFolderId("a/b"), "");
  assert.deepEqual(safeIds(["e1", "e1", "e2", "../x", 7, ""]), ["e1", "e2"]);
  const many = Array.from({ length: 260 }, (_, i) => "e" + i);
  assert.equal(safeIds(many).length, 200);

  assert.deepEqual(importFromFilesPayload("desktop", ["e1"]), { type: "resource/importFromFiles", folderId: "desktop", ids: ["e1"] });
  assert.deepEqual(linkFromFilesPayload("desktop", ["e1"]), { type: "resource/linkFromFiles", folderId: "desktop", ids: ["e1"] });
  assert.deepEqual(exportResourcePayload(" resource://res_1 "), { type: "resource/export", resourceRef: "resource://res_1" });
  assert.deepEqual(revealSourcePayload("resource://res_1"), { type: "resource/revealSource", resourceRef: "resource://res_1" });
  assert.deepEqual(exportToComputerPayload("desktop", ["e1"]), { folderId: "desktop", ids: ["e1"] });
  for (const payload of [importFromFilesPayload("desktop", ["e1"]), linkFromFilesPayload("desktop", ["e1"]), exportResourcePayload("resource://res_1")]) {
    const cmd = String(payload.type);
    assert.ok(payloadKeysAllowed(cmd, payload), cmd + " 载荷键必须过白名单");
  }
});

/* ── 4. 命令执行（只经桥，异常收敛） ───────────────────────────────────── */

test("runAddFromFiles：成功返回资源并给「落在资源库哪里」的反馈", async () => {
  const calls = [];
  const bridge = {
    command: async (cmd) => {
      calls.push(cmd);
      return { ok: true, resources: [{ resourceId: "resource://res_1", storageMode: "MANAGED", name: "a.txt" }], skipped: [], count: 1 };
    },
  };
  const res = await runAddFromFiles(bridge, "desktop", ["e1"], "import");
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]).sort(), ["folderId", "ids", "type"]);
  assert.equal(calls[0].type, "resource/importFromFiles");
  assert.match(res.text, /资源库/);
  assert.match(res.text, /Managed/);
  assert.equal(res.resources.length, 1);
});

test("runAddFromFiles：链接模式与部分失败都如实回报", async () => {
  const bridge = { command: async () => ({ ok: true, resources: [{ resourceId: "resource://res_2", storageMode: "LINKED" }], skipped: [{ id: "e9", error: "NOT_FOUND" }], count: 1 }) };
  const res = await runAddFromFiles(bridge, "desktop", ["e1", "e9"], "link");
  assert.equal(res.ok, true);
  assert.equal(res.skipped, 1);
  assert.match(res.text, /Linked/);
  assert.match(res.text, /跳过 1 个/);
});

test("runAddFromFiles：桥缺失 / 抛异常 / 结构化失败都收敛成码 + 人话", async () => {
  assert.equal((await runAddFromFiles(undefined, "desktop", ["e1"], "import")).code, "NO_BRIDGE");
  const throwing = { command: async () => { throw new Error("boom: /Users/secret"); } };
  const thrown = await runAddFromFiles(throwing, "desktop", ["e1"], "import");
  assert.equal(thrown.code, "INTERNAL_ERROR");
  assert.equal(thrown.text, LIBRARY_ERROR_TEXT.INTERNAL_ERROR);
  const denied = { command: async () => ({ ok: false, error: "NOT_FOUND_OR_FORBIDDEN" }) };
  const res = await runAddFromFiles(denied, "desktop", ["e1"], "import");
  assert.equal(res.ok, false);
  assert.equal(res.code, "NOT_FOUND_OR_FORBIDDEN");
  assert.equal(res.text, LIBRARY_ERROR_TEXT.NOT_FOUND_OR_FORBIDDEN);
});

test("runExportResource / runRevealSource：成功与取消都有明确反馈", async () => {
  const okBridge = { command: async () => ({ ok: true, bytes: 42 }) };
  const ok = await runExportResource(okBridge, "resource://res_1");
  assert.equal(ok.ok, true);
  assert.match(ok.text, /42 字节/);
  const cancel = { command: async () => ({ ok: false, error: "CANCELLED" }) };
  const c = await runExportResource(cancel, "resource://res_1");
  assert.equal(c.ok, false);
  assert.equal(c.code, "CANCELLED");
  assert.equal(c.text, LIBRARY_ERROR_TEXT.CANCELLED);
  const rev = await runRevealSource(okBridge, "resource://res_1");
  assert.equal(rev.ok, true);
});

test("runExportToComputer：走 files.exportTo，成功回传真实落点", async () => {
  const calls = [];
  const bridge = { exportTo: async (folderId, ids) => { calls.push({ folderId, ids }); return { ok: true, count: 2, dest: "/Users/me/Desktop/out" }; } };
  const res = await runExportToComputer(bridge, "desktop", ["e1", "e2"]);
  assert.equal(res.ok, true);
  assert.equal(calls[0].folderId, "desktop");
  assert.deepEqual(calls[0].ids, ["e1", "e2"]);
  assert.match(res.text, /\/Users\/me\/Desktop\/out/);
  assert.equal((await runExportToComputer(undefined, "desktop", ["e1"])).code, "FILES_UNAVAILABLE");
  assert.equal((await runExportToComputer(bridge, "desktop", [])).code, "NO_SELECTION");
});

/* ── 5. 只有一份实现 ──────────────────────────────────────────────────── */

test("FilesApp 已删除，命令字面量只出现在白名单与共享模块里", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "src/governance/FilesApp.tsx")), false, "废弃的 FilesApp 不能留下第二套实现");
  const srcFiles = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(tsx|ts)$/.test(name)) srcFiles.push(p);
    }
  };
  walk(path.join(ROOT, "src"));
  const owners = (needle) => srcFiles.filter((p) => fs.readFileSync(p, "utf8").includes(needle)).map((p) => path.relative(ROOT, p)).sort();
  assert.deepEqual(owners("resource/importFromFiles"), ["src/governance/filesLibraryActions.ts"]);
  assert.deepEqual(owners("resource/linkFromFiles"), ["src/governance/filesLibraryActions.ts"]);
  assert.deepEqual(owners("resource/export"), ["src/governance/filesLibraryActions.ts"]);
  assert.deepEqual(owners("resource/revealSource"), ["src/governance/filesLibraryActions.ts"]);
  // 错误码文案也只有一份
  assert.deepEqual(owners("资源库操作失败，请重试"), ["src/governance/filesLibraryActions.ts"]);
});

/* ── 6. resource/importFromFiles · resource/linkFromFiles 主进程契约 ───── */

function makeHandler(opts) {
  const handlers = {};
  const ipcMain = { handle: (name, fn) => { handlers[name] = fn; } };
  registerResourceIpc(Object.assign({ ipcMain, identity: { current: "s1" }, isTrusted: () => true }, opts));
  return (command) => handlers["resource:command"]({}, command);
}

test("resource/importFromFiles：路径只在主进程解析，渲染层拿不到路径", async () => {
  const calls = [];
  const service = {
    importManaged: async (args) => {
      calls.push(args);
      return { ok: true, resource: { resourceId: "resource://res_1", storageMode: "MANAGED", name: "a.txt" } };
    },
  };
  const call = makeHandler({ service, resolveFile: (folderId, id) => (id === "e1" ? { path: "/private/tmp/oa/a.txt", name: "a.txt" } : null) });
  const res = await call({ type: "resource/importFromFiles", folderId: "desktop", ids: ["e1", "e9"] });
  assert.equal(res.ok, true);
  assert.equal(res.resources.length, 1);
  assert.equal(res.count, 1);
  assert.deepEqual(res.skipped, [{ id: "e9", error: "NOT_FOUND" }]);
  assert.equal(calls[0].sourcePath, "/private/tmp/oa/a.txt");
  assert.equal(calls[0].name, "a.txt");
  // 默认 App 主体仍是内置 resource-library（不给渲染层自报 appId 的机会）
  assert.equal(calls[0].context.appId, "resource-library");
  assert.equal(JSON.stringify(res).includes("/private/tmp"), false, "路径不得回渲染层");
});

test("resource/linkFromFiles：复用 createLinked，不复制内容", async () => {
  const calls = [];
  const service = { createLinked: (args) => { calls.push(args); return { ok: true, resource: { resourceId: "resource://res_2", storageMode: "LINKED" } }; } };
  const call = makeHandler({ service, resolveFile: () => ({ path: "/private/tmp/oa/b.txt", name: "b.txt" }) });
  const res = await call({ type: "resource/linkFromFiles", folderId: "desktop", ids: ["e1"] });
  assert.equal(res.ok, true);
  assert.equal(calls[0].sourcePath, "/private/tmp/oa/b.txt");
  assert.equal(JSON.stringify(res).includes("/private/tmp"), false, "路径不得回渲染层");
});

test("resource/importFromFiles：未注入文件解析器 / 非法入参一律结构化拒绝", async () => {
  const service = { importManaged: async () => ({ ok: true, resource: { resourceId: "resource://res_1" } }) };
  const noResolver = makeHandler({ service, resolveFile: null });
  assert.equal((await noResolver({ type: "resource/importFromFiles", folderId: "desktop", ids: ["e1"] })).error, "IMPORTER_UNAVAILABLE");
  const call = makeHandler({ service, resolveFile: () => null });
  assert.equal((await call({ type: "resource/importFromFiles", folderId: "", ids: ["e1"] })).error, "INVALID_INPUT");
  assert.equal((await call({ type: "resource/importFromFiles", folderId: "desktop", ids: [] })).error, "INVALID_INPUT");
  // 没在白名单里的命令依旧是 INVALID_INPUT（暴露面没有扩大）
  assert.equal((await call({ type: "resource/rawRead", folderId: "desktop", ids: ["e1"] })).error, "INVALID_INPUT");
});

test("resource/importFromFiles：全部失败时返回第一条结构化错误，不做乐观成功", async () => {
  const service = { importManaged: async () => ({ ok: false, error: "DISK_SPACE_INSUFFICIENT" }) };
  const call = makeHandler({ service, resolveFile: () => ({ path: "/private/tmp/oa/c.txt", name: "c.txt" }) });
  const res = await call({ type: "resource/importFromFiles", folderId: "desktop", ids: ["e1"] });
  assert.equal(res.ok, false);
  assert.equal(res.error, "DISK_SPACE_INSUFFICIENT");
  assert.equal(res.skipped.length, 1);
});
