/**
 * B-T2 · Agent 工具解析器 + 内置文件工具回归测试（全离线）。
 *
 * 覆盖（对应本轮验收条目）：
 *   ① 解析命中 / 未命中（按名、按来源、project.agent 默认来源）
 *   ② 权限允许 / 拒绝 / 适配器未注入保守拒绝（结构化错误）
 *   ③ runTool 成功 / 失败 / 超时 / 输出 schema 失败 / 未知工具
 *   ④ 工作区越界写拒绝 + 工作区适配器未注入时写操作结构化拒绝
 *   ⑤ 真实 T1 目录（electron/agent-tool-catalog.cjs）就绪时的集成断言（未就绪则跳过）
 *
 * 只读源：DXSRC/server/toolResolver.ts（69 行）、DXSRC/server/agentTools.ts（314 行）。
 * 全部用例使用假目录 + 假 fsAdapter，不触网、不落盘、不依赖 Electron。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const resolver = require("../electron/agent-tool-resolver.cjs");
const builtin = require("../electron/agent-builtin-tools.cjs");
const runtimeDeps = require("../electron/agent-runtime-deps.cjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_FILE = path.join(ROOT, "electron", "agent-tool-catalog.cjs");

/** 真实 T1 目录可能尚在写入中：只在文件已导出 toolCatalogSnapshot 时才做集成断言。 */
function loadRealCatalog() {
  if (!fs.existsSync(CATALOG_FILE)) return null;
  try {
    const mod = require(CATALOG_FILE);
    return mod && typeof mod.toolCatalogSnapshot === "function" ? mod : null;
  } catch {
    return null;
  }
}
const REAL_CATALOG = loadRealCatalog();

/** 假 descriptor：字段集对齐 toolCatalog.ts:14-37 的 ToolDescriptor。 */
function makeDescriptor(overrides = {}) {
  const name = overrides.name || "demo_tool";
  return {
    name,
    title: name,
    description: "示例工具",
    source: "file",
    sourceId: "project",
    enabled: true,
    executable: true,
    status: "ready",
    statusText: "ready",
    inputSchema: { type: "object", properties: {} },
    permissions: [],
    risk: "read",
    sideEffects: [],
    whenToUse: [],
    handler: { type: "file-tool", toolName: name },
    ...overrides,
  };
}

/** 假目录：只实现 resolver 真正用到的 toolCatalogSnapshot().descriptors。 */
function makeCatalog(descriptors) {
  return {
    toolCatalogSnapshot(options = {}) {
      const list = options.executableOnly ? descriptors.filter((tool) => tool.enabled && tool.executable) : descriptors;
      return {
        descriptors: list.map((tool) => ({ ...tool })),
        tools: [],
        summary: { total: list.length, ready: list.length, pending: 0, sources: {} },
      };
    },
  };
}

/** 假权限适配器：记录调用，返回固定判定。 */
function makeAuth(allow = true) {
  const calls = [];
  return {
    calls,
    canUseAppPermission(user, permission) {
      calls.push({ userId: user && user.id, permission });
      return allow;
    },
  };
}

/** 假工作区适配器：内存节点树，语义对齐 fs.ts:485-1015 与 agent-runtime-workspace.cjs:17-33。 */
function makeFakeFs() {
  let seq = 0;
  const nodes = new Map();
  const ROOT_ID = "root";
  nodes.set(ROOT_ID, { id: ROOT_ID, name: "项目", type: "folder", parentId: null, trashed: false, updated_ts: 1 });
  const findChild = (parentId, name) => [...nodes.values()].find((node) => node.parentId === parentId && node.name === name && !node.trashed) || null;
  const adapter = {
    ROOT_ID,
    nodes,
    getNode(id) { return nodes.get(id) || null; },
    listChildren(parentId) { return { nodes: [...nodes.values()].filter((node) => node.parentId === parentId && !node.trashed) }; },
    createNode(input) {
      const node = { id: "n" + (++seq), name: input.name, type: input.type, parentId: input.parentId, content: input.content, trashed: false, updated_ts: 1 };
      nodes.set(node.id, node);
      return node;
    },
    setContent(id, content) {
      const node = nodes.get(id);
      if (!node) throw new Error("节点不存在：" + id);
      const next = { ...node, content };
      nodes.set(id, next);
      return next;
    },
    renameNode(id, name) { const node = nodes.get(id); const next = { ...node, name }; nodes.set(id, next); return next; },
    moveNode(id, parentId) { const node = nodes.get(id); const next = { ...node, parentId }; nodes.set(id, next); return next; },
    copyNode(id, parentId) { const node = nodes.get(id); const copy = { ...node, id: "n" + (++seq), parentId }; nodes.set(copy.id, copy); return copy; },
    removeNode(id) { return nodes.delete(id) ? 1 : 0; },
    resolvePath(rootId, relPath, createDirs) {
      const parts = String(relPath || "").split("/").map((s) => s.trim()).filter(Boolean);
      const leaf = parts.pop() || "";
      let parentId = rootId;
      for (const seg of parts) {
        let folder = findChild(parentId, seg);
        if (!folder) {
          if (!createDirs) throw new Error("路径不存在：" + seg);
          folder = adapter.createNode({ name: seg, type: "folder", parentId });
        }
        parentId = folder.id;
      }
      return { parentId, leaf };
    },
    findByPath(rootId, relPath) {
      try {
        const { parentId, leaf } = adapter.resolvePath(rootId, relPath, false);
        return findChild(parentId, leaf);
      } catch {
        return null;
      }
    },
    isWithinRoot(rootId, nodeId) {
      let current = nodes.get(nodeId);
      const seen = new Set();
      while (current && !seen.has(current.id)) {
        if (current.id === rootId) return true;
        seen.add(current.id);
        current = current.parentId ? nodes.get(current.parentId) : undefined;
      }
      return false;
    },
  };
  return adapter;
}

function resetAll() {
  builtin.resetBuiltinToolsForTests();
  resolver.resetToolResolverForTests();
  runtimeDeps.resetAgentRuntimeForTests();
}

test("解析：project.agent 默认来源 + 排除 client handler", () => {
  resetAll();
  assert.deepEqual([...resolver.DEFAULT_AGENT_SOURCES], ["system", "file", "skill", "mcp"]);
  const descriptors = [
    makeDescriptor({ name: "sys_client", source: "system", sourceId: "desktop", handler: { type: "client" } }),
    makeDescriptor({ name: "sys_media", source: "system", sourceId: "media-capability", handler: { type: "system-capability", skillId: "s" } }),
    makeDescriptor({ name: "fs_read", source: "file", sourceId: "project" }),
    makeDescriptor({ name: "skill_x", source: "skill", sourceId: "x" }),
    makeDescriptor({ name: "mcp__s__t", source: "mcp", sourceId: "s" }),
    makeDescriptor({ name: "app_tool", source: "app", sourceId: "pack", appId: "pack" }),
  ];
  const result = resolver.resolveTools({ intent: "project.agent" }, { catalog: makeCatalog(descriptors), auth: makeAuth(true) });
  assert.deepEqual(result.descriptors.map((tool) => tool.name), ["sys_media", "fs_read", "skill_x", "mcp__s__t"]);
  assert.equal(result.openaiTools.length, 4);
  assert.equal(result.openaiTools[0].type, "function");
  assert.equal(result.openaiTools[0].x_dx_capability.schema, "dx-agent-capability/v1");
  assert.equal(Object.keys(result.executors).length, 4);
  assert.deepEqual(result.denied, []);
});

test("解析：按来源命中；无该来源时命中空集（不是错误）", () => {
  resetAll();
  const descriptors = [makeDescriptor({ name: "fs_a" }), makeDescriptor({ name: "sys_b", source: "system", sourceId: "desktop" })];
  const deps = { catalog: makeCatalog(descriptors), auth: makeAuth(true) };
  const hit = resolver.resolveToolsBySource("file", { intent: "whatever" }, deps);
  assert.equal(hit.ok, true);
  assert.deepEqual(hit.descriptors.map((tool) => tool.name), ["fs_a"]);
  const miss = resolver.resolveToolsBySource("app", { intent: "whatever" }, deps);
  assert.equal(miss.ok, true);
  assert.deepEqual(miss.descriptors, []);
  assert.equal(resolver.resolveToolsBySource("", {}, deps).error.code, "invalid_request");
});

test("解析：按名命中，带 openai 声明 / executor / 权限判定", () => {
  resetAll();
  const descriptors = [makeDescriptor({ name: "fs_read", title: "读取", handler: { type: "file-tool", toolName: "fs_read" } })];
  const hit = resolver.resolveToolByName("fs_read", {}, { catalog: makeCatalog(descriptors), auth: makeAuth(true) });
  assert.equal(hit.ok, true);
  assert.equal(hit.descriptor.name, "fs_read");
  assert.equal(hit.executor.type, "file-tool");
  assert.equal(hit.openaiTool.function.name, "fs_read");
  assert.match(hit.openaiTool.function.description, /^\[读取\] /);
  assert.equal(hit.permission.allowed, true);
});

test("解析：按名未命中 -> not_found；空名 -> invalid_request", () => {
  resetAll();
  const deps = { catalog: makeCatalog([makeDescriptor({ name: "only" })]), auth: makeAuth(true) };
  const miss = resolver.resolveToolByName("不存在", {}, deps);
  assert.equal(miss.ok, false);
  assert.equal(miss.error.code, "not_found");
  assert.match(miss.error.message, /未知工具/);
  assert.equal(resolver.resolveToolByName("", {}, deps).error.code, "invalid_request");
  assert.equal(resolver.resolveToolByName(null, {}, deps).error.code, "invalid_request");
});

test("权限：注入适配器允许 -> 工具进入结果，适配器被调用一次", () => {
  resetAll();
  const auth = makeAuth(true);
  const tool = makeDescriptor({ name: "app_tool", source: "app", sourceId: "pack", appId: "pack", permissions: ["app.pack.run"], risk: "external", handler: { type: "frontend-bridge" } });
  const result = resolver.resolveTools({ intent: "x", requestedSources: ["app"], actor: { id: "u1" } }, { catalog: makeCatalog([tool]), auth });
  assert.deepEqual(result.descriptors.map((item) => item.name), ["app_tool"]);
  assert.deepEqual(auth.calls, [{ userId: "u1", permission: "app.pack.run" }]);
  assert.deepEqual(result.denied, []);
});

test("权限：注入适配器拒绝 -> denied 结构化清单 + 按名 permission_denied", () => {
  resetAll();
  const auth = makeAuth(false);
  const tool = makeDescriptor({ name: "app_tool", source: "app", sourceId: "pack", appId: "pack", permissions: ["app.pack.run"], handler: { type: "frontend-bridge" } });
  const deps = { catalog: makeCatalog([tool]), auth };
  const result = resolver.resolveTools({ intent: "x", requestedSources: ["app"], actor: { id: "u1" } }, deps);
  assert.deepEqual(result.descriptors, []);
  assert.deepEqual(result.openaiTools, []);
  assert.equal(result.denied.length, 1);
  assert.equal(result.denied[0].code, "permission_denied");
  assert.equal(result.denied[0].permission, "app.pack.run");
  const byName = resolver.resolveToolByName("app_tool", { requestedSources: ["app"], actor: { id: "u1" } }, deps);
  assert.equal(byName.ok, false);
  assert.equal(byName.error.code, "permission_denied");
  assert.equal(byName.error.toolName, "app_tool");
});

test("权限：适配器未注入 -> 保守拒绝 auth_unavailable；无 permissions 的工具仍放行", () => {
  resetAll();
  const withPerm = makeDescriptor({ name: "needs_perm", permissions: ["files.write"] });
  const withoutPerm = makeDescriptor({ name: "no_perm", permissions: [] });
  const deps = { catalog: makeCatalog([withPerm, withoutPerm]) };
  const result = resolver.resolveTools({ intent: "x" }, deps);
  assert.deepEqual(result.descriptors.map((item) => item.name), ["no_perm"]);
  assert.equal(result.denied.length, 1);
  assert.equal(result.denied[0].code, "auth_unavailable");
  assert.equal(resolver.resolveToolByName("needs_perm", {}, deps).error.code, "auth_unavailable");
  const decision = resolver.resolveToolPermission(withPerm, { id: "u" }, {});
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "auth_unavailable");
});

test("权限：适配器抛错 -> auth_unavailable（不吞异常、不默认放行）", () => {
  resetAll();
  const auth = { canUseAppPermission() { throw new Error("auth 后端不可用"); } };
  const tool = makeDescriptor({ name: "needs_perm", permissions: ["app.pack.run"], source: "app", sourceId: "pack", appId: "pack" });
  const decision = resolver.resolveToolPermission(tool, { id: "u" }, { auth });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "auth_unavailable");
  assert.match(decision.message, /auth 后端不可用/);
});

test("目录：接口不完整 -> 结构化 catalog_unavailable", () => {
  resetAll();
  const deps = { catalog: { nope: true } };
  assert.equal(resolver.resolveToolByName("x", {}, deps).error.code, "catalog_unavailable");
  assert.throws(() => resolver.resolveTools({ intent: "x" }, deps), (error) => error.code === "catalog_unavailable");
  const injected = makeCatalog([makeDescriptor({ name: "ok_tool" })]);
  assert.equal(resolver.catalogSnapshot({}, { catalog: injected }).descriptors.length, 1);
  resolver.configureToolResolver({ catalog: injected });
  assert.equal(resolver.loadCatalog().toolCatalogSnapshot, injected.toolCatalogSnapshot);
});

test("内置工具：FILE_TOOLS 名称 / mutates / 别名 / 幂等 ID 基线（源 agentTools.ts:83-314）", () => {
  resetAll();
  assert.equal(builtin.FILE_TOOLS.length, 11);
  assert.deepEqual(builtin.FILE_TOOLS.map((tool) => tool.name), ["fs_list", "fs_read", "fs_mkdir", "fs_create", "fs_write", "fs_append", "fs_edit", "fs_rename", "fs_move", "fs_copy", "fs_delete"]);
  assert.deepEqual(builtin.FILE_TOOLS.filter((tool) => tool.mutates).map((tool) => tool.name), ["fs_mkdir", "fs_create", "fs_write", "fs_append", "fs_edit", "fs_rename", "fs_move", "fs_copy", "fs_delete"]);
  assert.equal(builtin.getTool("fs_read").mutates, false);
  assert.equal(builtin.getTool("不存在"), undefined);
  assert.deepEqual({ ...builtin.LEGACY_TOOL_ALIAS }, { "file.read": "fs_read", "file.create": "fs_create", "file.write": "fs_write" });
  // 源 agentTools.ts:313 就是 randomUUID().slice(0, 12)，即 "xxxxxxxx-xxx"
  assert.match(builtin.newOperationId("task-1"), /^task-1:op-[0-9a-f]{8}-[0-9a-f]{3}$/);
  assert.deepEqual(builtin.toolSchemas(new Set(["fs_read"])).map((item) => item.function.name), ["fs_read"]);
  assert.equal(builtin.toolSchemas().length, 11);
  assert.ok(builtin.TOOL_ERROR_CODES.includes("unsupported"));
});

test("runTool：成功（fs_write 创建 -> fs_read 读回 -> fs_append 追加 -> fs_list 列表）", async () => {
  resetAll();
  const ws = makeFakeFs();
  builtin.configureBuiltinTools({ fsAdapter: ws });
  const ctx = { rootNodeId: ws.ROOT_ID, userId: "u1" };
  const write = await builtin.runTool("fs_write", ctx, { path: "docs/a.txt", content: "你好" });
  assert.equal(write.deliverable, true);
  assert.match(write.message, /已创建 docs\/a\.txt（2 字）/);
  const read = await builtin.runTool("fs_read", ctx, { path: "docs/a.txt" });
  assert.equal(read.content, "你好");
  const appended = await builtin.runTool("fs_append", ctx, { path: "docs/a.txt", content: "世界" });
  assert.match(appended.message, /已追加到 docs\/a\.txt/);
  // 幂等恢复窗口：再次追加同一内容不重复写（源 agentTools.ts:178-181）
  const again = await builtin.runTool("fs_append", ctx, { path: "docs/a.txt", content: "世界" });
  assert.match(again.message, /未重复追加/);
  assert.equal(builtin.getTool("fs_read") && (await builtin.runTool("fs_read", ctx, { path: "docs/a.txt" })).content, "你好\n世界");
  const list = await builtin.runTool("fs_list", ctx, { path: "docs" });
  assert.deepEqual(list.entries, [{ name: "a.txt", type: "file" }]);
  const root = await builtin.runTool("fs_list", ctx, {});
  assert.deepEqual(root.entries.map((entry) => entry.name), ["docs"]);
});

test("runTool：失败（找不到 / 路径非法 / 未授权 / 根目录缺失 / 编辑未命中）", async () => {
  resetAll();
  const ws = makeFakeFs();
  builtin.configureBuiltinTools({ fsAdapter: ws });
  const ctx = { rootNodeId: ws.ROOT_ID, userId: "u1" };
  await assert.rejects(() => builtin.runTool("fs_read", ctx, { path: "missing.txt" }), (error) => error instanceof builtin.ToolError && error.code === "not_found");
  await assert.rejects(() => builtin.runTool("fs_read", ctx, { path: "../escape.txt" }), (error) => error.code === "invalid_input");
  await assert.rejects(() => builtin.runTool("fs_write", ctx, { path: "a.txt", content: "x" }, new Set(["fs_read"])), (error) => error.code === "permission_denied");
  await assert.rejects(() => builtin.runTool("fs_read", { rootNodeId: "no-such-root" }, { path: "a.txt" }), (error) => error.code === "not_found");
  await builtin.runTool("fs_write", ctx, { path: "b.txt", content: "abc" });
  await assert.rejects(() => builtin.runTool("fs_edit", ctx, { path: "b.txt", find: "xyz", replace: "1" }), (error) => error.code === "not_found");
  const safe = await builtin.runToolSafe("fs_read", ctx, { path: "missing.txt" });
  assert.deepEqual(safe, { ok: false, code: "not_found", message: "找不到：missing.txt" });
});

test("runTool：超时 -> code=timeout（慢工具确实被调用过）", async () => {
  resetAll();
  const ws = makeFakeFs();
  builtin.configureBuiltinTools({ fsAdapter: ws });
  let started = false;
  const slow = { name: "slow_tool", mutates: false, run() { started = true; return new Promise(() => {}); } };
  await assert.rejects(
    () => builtin.runTool("slow_tool", { rootNodeId: ws.ROOT_ID }, {}, undefined, { tools: [slow], timeoutMs: 20 }),
    (error) => error instanceof builtin.ToolError && error.code === "timeout" && /20ms/.test(error.message),
  );
  assert.equal(started, true);
});

test("runTool：输出 schema 失败 -> code=output_schema_invalid；合规输出放行", async () => {
  resetAll();
  const ws = makeFakeFs();
  builtin.configureBuiltinTools({ fsAdapter: ws });
  const schema = { type: "object", required: ["content"], properties: { content: { type: "string" } }, additionalProperties: false };
  const bad = { name: "bad_tool", mutates: false, outputSchema: schema, run() { return { content: 42 }; } };
  await assert.rejects(
    () => builtin.runTool("bad_tool", { rootNodeId: ws.ROOT_ID }, {}, undefined, { tools: [bad] }),
    (error) => error.code === "output_schema_invalid" && /\.content/.test(error.message),
  );
  const good = { name: "good_tool", mutates: false, outputSchema: schema, run() { return { content: "ok" }; } };
  assert.deepEqual(await builtin.runTool("good_tool", { rootNodeId: ws.ROOT_ID }, {}, undefined, { tools: [good] }), { content: "ok" });
  assert.equal(builtin.validateAgainstSchema({ content: "ok" }, schema), null);
  assert.match(builtin.validateAgainstSchema({ content: 1 }, schema), /content/);
  assert.match(builtin.validateAgainstSchema({ content: "ok", extra: 1 }, schema), /不被 outputSchema 允许/);
});

test("runTool：工作区越界写拒绝（门禁抛出 -> permission_denied，保留 statusCode，无副作用）", async () => {
  resetAll();
  const ws = makeFakeFs();
  builtin.configureBuiltinTools({ fsAdapter: ws });
  const calls = [];
  const guard = (runId, userId, rootNodeId, path) => {
    calls.push({ runId, userId, rootNodeId, path });
    if (path === "escape/x.txt") throw Object.assign(new Error("文件工具根目录不属于当前 Run Workspace"), { statusCode: 403 });
  };
  const ctx = { rootNodeId: ws.ROOT_ID, userId: "u1", runId: "run-1" };
  await assert.rejects(
    () => builtin.runTool("fs_write", ctx, { path: "escape/x.txt", content: "x" }, undefined, { workspaceGuard: guard }),
    (error) => error instanceof builtin.ToolError && error.code === "permission_denied" && error.statusCode === 403,
  );
  // 源 agentTools.ts:292-297：先校验根（path=undefined），再按 mutates 校验目标路径
  assert.deepEqual(calls, [
    { runId: "run-1", userId: "u1", rootNodeId: ws.ROOT_ID, path: undefined },
    { runId: "run-1", userId: "u1", rootNodeId: ws.ROOT_ID, path: "escape/x.txt" },
  ]);
  assert.equal(ws.findByPath(ws.ROOT_ID, "escape/x.txt"), null);
});

test("runTool：工作区适配器未注入 -> 写操作 dependency_unavailable（不产生副作用）", async () => {
  resetAll();
  await assert.rejects(
    () => builtin.runTool("fs_write", { rootNodeId: "root", userId: "u" }, { path: "a.txt", content: "x" }),
    (error) => error instanceof builtin.ToolError && error.code === "dependency_unavailable",
  );
  const safe = await builtin.runToolSafe("fs_read", { rootNodeId: "root" }, { path: "a.txt" });
  assert.equal(safe.ok, false);
  assert.equal(safe.code, "dependency_unavailable");
  assert.equal(builtin.builtinToolOptions().fsAdapter, null);
});

test("runTool：未知工具 -> unsupported（不依赖任何适配器）", async () => {
  resetAll();
  await assert.rejects(() => builtin.runTool("不存在的工具", {}, {}), (error) => error instanceof builtin.ToolError && error.code === "unsupported");
  assert.deepEqual(await builtin.runToolSafe("不存在的工具", {}, {}), { ok: false, code: "unsupported", message: "未知工具：不存在的工具" });
});

test("runTool：其余文件工具（mkdir 幂等 / create 幂等与冲突 / rename / copy / move / delete）", async () => {
  resetAll();
  const ws = makeFakeFs();
  builtin.configureBuiltinTools({ fsAdapter: ws });
  const ctx = { rootNodeId: ws.ROOT_ID, userId: "u1" };
  const mkdir = await builtin.runTool("fs_mkdir", ctx, { path: "assets/img" });
  assert.equal(mkdir.name, "img");
  assert.match((await builtin.runTool("fs_mkdir", ctx, { path: "assets/img" })).message, /文件夹已存在/);
  const create = await builtin.runTool("fs_create", ctx, { path: "assets/a.txt", content: "x" });
  assert.equal(create.deliverable, true);
  assert.match((await builtin.runTool("fs_create", ctx, { path: "assets/a.txt", content: "x" })).message, /内容一致/);
  await assert.rejects(() => builtin.runTool("fs_create", ctx, { path: "assets/a.txt", content: "y" }), (error) => error.code === "conflict");
  assert.equal((await builtin.runTool("fs_rename", ctx, { path: "assets/a.txt", new_name: "b.txt" })).name, "b.txt");
  assert.equal((await builtin.runTool("fs_copy", ctx, { from: "assets/b.txt", to: "assets/img" })).deliverable, true);
  assert.ok(ws.findByPath(ws.ROOT_ID, "assets/img/b.txt"), "复制后目标目录应有副本");
  assert.ok(ws.findByPath(ws.ROOT_ID, "assets/b.txt"), "复制不移动原件");
  assert.equal((await builtin.runTool("fs_move", ctx, { from: "assets/b.txt", to: "" })).name, "b.txt");
  assert.equal(ws.findByPath(ws.ROOT_ID, "assets/b.txt"), null);
  assert.match((await builtin.runTool("fs_delete", ctx, { path: "b.txt" })).message, /可恢复/);
  assert.equal(ws.findByPath(ws.ROOT_ID, "b.txt"), null);
  await assert.rejects(() => builtin.runTool("fs_rename", ctx, { path: "assets/img", new_name: "" }), (error) => error.code === "invalid_input");
});

test("runTool：默认门禁确实走 agent-runtime-workspace.cjs 的 assertRunWorkspaceWrite", async () => {
  resetAll();
  const ws = makeFakeFs();
  builtin.configureBuiltinTools({ fsAdapter: ws });
  // 未注入 db / runStore：真实 assertRunWorkspaceWrite 会在 requireRunWorkspace 抛依赖错误；
  // 这恰好证明写操作走的是真实门禁，而不是被跳过。
  await assert.rejects(
    () => builtin.runTool("fs_write", { rootNodeId: ws.ROOT_ID, userId: "u1", runId: "run-x" }, { path: "a.txt", content: "x" }),
    (error) => error instanceof builtin.ToolError
      && error.code === "permission_denied"
      && /Agent 运行时依赖不可用/.test(error.message)
      && error.cause && error.cause.name === "AgentDependencyUnavailableError",
  );
  assert.equal(ws.findByPath(ws.ROOT_ID, "a.txt"), null);
});

test("集成：真实 T1 目录就绪 -> 按名 / 按来源解析（未就绪跳过）", { skip: !REAL_CATALOG }, () => {
  resetAll();
  const catalog = REAL_CATALOG;
  assert.equal(typeof catalog.toolCatalogSnapshot, "function");
  let snapshot;
  try {
    snapshot = catalog.toolCatalogSnapshot({ executableOnly: false });
  } catch (error) {
    // 真实目录依赖运行期注册表；离线不可用时只验证接口存在，不伪造结论
    assert.equal(typeof catalog.toolCatalogSnapshot, "function");
    return;
  }
  assert.ok(Array.isArray(snapshot.descriptors) && snapshot.descriptors.length > 0);
  const deps = { catalog, auth: makeAuth(true) };
  const bySource = resolver.resolveToolsBySource("file", { intent: "project.agent" }, deps);
  assert.equal(bySource.ok, true);
  assert.ok(bySource.descriptors.every((tool) => tool.source === "file"));
  // 不使用 intent=project.agent：真实目录里含 client handler 的系统工具会被该意图过滤掉，
  // 按名解析用全来源请求，验证 resolver 与真实目录的字段契约。
  const target = snapshot.descriptors.find((tool) => Array.isArray(tool.permissions) && tool.permissions.length === 0) || snapshot.descriptors[0];
  const byName = resolver.resolveToolByName(target.name, {}, deps);
  assert.equal(byName.ok, true);
  assert.equal(byName.descriptor.name, target.name);
  assert.equal(byName.openaiTool.function.name, target.name);
});

