"use strict";
/**
 * B-T2 · Agent 内置文件工具（源 agentTools.ts 逐函数移植）。
 *
 * 源（DXSRC = DX OS.app/Contents/Resources/app.asar.unpacked/server）：
 *   · agentTools.ts:15-17   ToolErrorCode
 *   · agentTools.ts:19-25   ToolError
 *   · agentTools.ts:27-35   ToolResult
 *   · agentTools.ts:37-51   ToolContext / ToolDef
 *   · agentTools.ts:53-81   relPath / requireInRoot / findFile / ensureParent / str / PATH_DESC
 *   · agentTools.ts:83-272  FILE_TOOLS（11 个）
 *   · agentTools.ts:274-285 TOOL_MAP / toolSchemas / getTool
 *   · agentTools.ts:287-303 runTool（写入门禁见 :292-299）
 *   · agentTools.ts:305-314 LEGACY_TOOL_ALIAS / newOperationId
 *
 * 依赖替换：
 *   · 源 import fs.ts 全部函数     -> fsAdapter 注入（契约见 agent-runtime-workspace.cjs:17-33）
 *   · 源 assertRunWorkspaceWrite   -> require ./agent-runtime-workspace.cjs:121（可用 workspaceGuard 覆盖）
 *   · 源 import randomUUID         -> node:crypto（同源）
 *   · fsAdapter 未注入：文件工具一律抛 ToolError(code='dependency_unavailable')，不伪造成功
 *
 * T2 扩展（源没有、本轮验收要求）：
 *   · runTool 支持 timeoutMs / AbortSignal -> code='timeout' / 'cancelled'
 *   · runTool 支持 outputSchema 校验       -> code='output_schema_invalid'
 *   · registry / workspaceGuard / timeoutMs 可注入，供离线测试（默认仍是 FILE_TOOLS + 真实门禁）
 */
const { randomUUID } = require("node:crypto");
const { hasDependency, requireDependency } = require("./agent-runtime-deps.cjs");

/** 源 agentTools.ts:15-17 的六个码 + T2 扩展四码。 */
const TOOL_ERROR_CODES = Object.freeze([
  "invalid_input", "not_found", "permission_denied", "conflict", "unsupported", "internal",
  "timeout", "cancelled", "dependency_unavailable", "output_schema_invalid",
]);

/** 源 agentTools.ts:19-25。扩展：extra.statusCode / cause / detail 原样保留。 */
class ToolError extends Error {
  constructor(code, message, extra) {
    super(String(message));
    this.name = "ToolError";
    this.code = String(code);
    if (extra && typeof extra === "object") {
      if (extra.statusCode !== undefined) this.statusCode = extra.statusCode;
      if (extra.cause !== undefined) this.cause = extra.cause;
      if (extra.detail !== undefined) this.detail = extra.detail;
    }
  }
}

/** 结构化错误投影：模型边界 / IPC 只依赖这一层，不解析 Error 文本。 */
function toToolErrorPayload(error) {
  if (error instanceof ToolError) {
    return {
      ok: false, code: error.code, message: error.message,
      ...(error.statusCode !== undefined ? { statusCode: error.statusCode } : {}),
      ...(error.detail !== undefined ? { detail: error.detail } : {}),
    };
  }
  return { ok: false, code: "internal", message: String((error && error.message) || error) };
}

/** 把 fsAdapter / 工作区门禁抛出的普通 Error 统一成 ToolError（保留原始 cause / statusCode）。 */
function asToolError(error, fallbackCode) {
  if (error instanceof ToolError) return error;
  return new ToolError(fallbackCode, String((error && error.message) || error), {
    cause: error,
    statusCode: error && error.statusCode,
  });
}

/** 本地注入点：默认全 null；fsAdapter 也会回退到 agent-runtime-deps 的注入。 */
let builtinOptions = { fsAdapter: null, workspaceGuard: null, timeoutMs: 30000 };

function configureBuiltinTools(patch = {}) {
  const next = { ...builtinOptions };
  for (const key of ["fsAdapter", "workspaceGuard", "timeoutMs"]) if (patch[key] !== undefined) next[key] = patch[key];
  builtinOptions = next;
  return { ...builtinOptions };
}

function resetBuiltinToolsForTests() {
  builtinOptions = { fsAdapter: null, workspaceGuard: null, timeoutMs: 30000 };
  return { ...builtinOptions };
}

function builtinToolOptions() {
  return { ...builtinOptions };
}

/** fsAdapter：本地注入优先，其次 agent-runtime-deps；都没有则结构化拒绝。 */
function fsAdapterOrNull() {
  if (builtinOptions.fsAdapter) return builtinOptions.fsAdapter;
  if (hasDependency("fsAdapter")) return requireDependency("fsAdapter");
  return null;
}

function fs() {
  const adapter = fsAdapterOrNull();
  if (!adapter) throw new ToolError("dependency_unavailable", "工作区适配器未注入：fsAdapter 不可用，拒绝执行文件工具");
  return adapter;
}

/** 写操作前置检查：适配器缺失时必须在产生任何副作用之前失败。 */
function requireWorkspaceAdapterForWrite() {
  fs();
}

/** 默认门禁 = 真实 Run Workspace 门禁；测试可注入 workspaceGuard 覆盖。 */
function defaultWorkspaceGuard() {
  return require("./agent-runtime-workspace.cjs").assertRunWorkspaceWrite;
}

/** 源 agentTools.ts:53-60。 */
function relPath(raw) {
  const normalized = String(raw === undefined || raw === null ? "" : raw).replace(/\\/g, "/").trim();
  const parts = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized) || parts.some((p) => !p || p === "." || p === "..")) {
    throw new ToolError("invalid_input", "文件路径必须是项目根目录内的规范相对路径");
  }
  return normalized;
}

/** 源 agentTools.ts:62-64。 */
function requireInRoot(ctx, nodeId) {
  if (!fs().isWithinRoot(ctx.rootNodeId, nodeId)) throw new ToolError("permission_denied", "目标不在项目目录内");
}

/** 源 agentTools.ts:66-72。 */
function findFile(ctx, path) {
  const node = fs().findByPath(ctx.rootNodeId, path);
  if (!node) throw new ToolError("not_found", "找不到：" + path);
  requireInRoot(ctx, node.id);
  if (node.system) throw new ToolError("permission_denied", "系统共享文件夹不能修改");
  return node;
}

/** 源 agentTools.ts:74-78。 */
function ensureParent(ctx, path) {
  const target = fs().resolvePath(ctx.rootNodeId, path, true);
  if (!target.leaf) throw new ToolError("invalid_input", "文件路径不能为空");
  return target;
}

/** 源 agentTools.ts:80-81。 */
const str = (description) => ({ type: "string", description });
const PATH_DESC = "项目根目录内的规范相对路径，如 assets/app.js；不得为空、使用绝对路径或包含 ./、../、重复斜线；不得写入 .ccs-ai、.agent-workspaces 系统目录";

/** 源 agentTools.ts:83-272。11 个工具，name/description/mutates/parameters/run 逐字段对照。 */
const FILE_TOOLS = [
  {
    name: "fs_list",
    description: "列出项目内某个文件夹的内容（path 留空为项目根目录）",
    mutates: false,
    parameters: { type: "object", properties: { path: str("文件夹路径，留空为根目录") } },
    run(ctx, args) {
      const path = String(args.path === undefined || args.path === null ? "" : args.path).trim();
      const folder = path ? findFile(ctx, relPath(path)) : fs().getNode(ctx.rootNodeId);
      if (!folder || folder.type !== "folder") throw new ToolError("not_found", "不是文件夹：" + (path || "(根目录)"));
      const entries = fs().listChildren(folder.id).nodes.map((n) => ({ name: n.name, type: n.type }));
      return { message: (path || "(根目录)") + " 共 " + entries.length + " 项", entries };
    },
  },
  {
    name: "fs_read",
    description: "读取项目内一个文本文件的内容（不能解析图片、视频或音频；媒体内容必须调用对应 Skill，并直接传项目相对路径）",
    mutates: false,
    parameters: { type: "object", properties: { path: str(PATH_DESC) }, required: ["path"] },
    run(ctx, args) {
      const node = findFile(ctx, relPath(args.path));
      if (node.type !== "file") throw new ToolError("invalid_input", "不是文件：" + args.path);
      return { nodeId: node.id, name: node.name, message: "已读取 " + args.path, content: node.content === undefined || node.content === null ? "" : node.content };
    },
  },
  {
    name: "fs_mkdir",
    description: "在项目内创建文件夹（多级路径自动创建）",
    mutates: true,
    parameters: { type: "object", properties: { path: str("文件夹路径，如 docs/图片") }, required: ["path"] },
    run(ctx, args) {
      const path = relPath(args.path);
      const existing = fs().findByPath(ctx.rootNodeId, path);
      if (existing) {
        if (existing.type !== "folder") throw new ToolError("conflict", "同名文件已存在：" + path);
        return { nodeId: existing.id, name: existing.name, message: "文件夹已存在：" + path };
      }
      const target = ensureParent(ctx, path);
      const node = fs().createNode({ name: target.leaf, type: "folder", parentId: target.parentId });
      return { nodeId: node.id, name: node.name, message: "已创建文件夹 " + path };
    },
  },
  {
    name: "fs_create",
    description: "在项目内新建文本文件并写入内容（文件已存在时报错，改用 fs_write 覆盖）",
    mutates: true,
    parameters: { type: "object", properties: { path: str(PATH_DESC), content: str("完整文件内容") }, required: ["path", "content"] },
    run(ctx, args) {
      const path = relPath(args.path);
      const content = String(args.content === undefined || args.content === null ? "" : args.content);
      const existing = fs().findByPath(ctx.rootNodeId, path);
      if (existing) {
        // 幂等恢复窗口：内容一致视为本操作已完成（源 agentTools.ts:135-138）
        if (existing.type === "file" && existing.content === content) {
          return { nodeId: existing.id, name: existing.name, message: "文件已存在且内容一致：" + path, deliverable: true };
        }
        throw new ToolError("conflict", "文件已存在：" + path + "（覆盖请用 fs_write）");
      }
      const target = ensureParent(ctx, path);
      const node = fs().createNode({ name: target.leaf, type: "file", parentId: target.parentId, content });
      return { nodeId: node.id, name: node.name, message: "已创建 " + path + "（" + content.length + " 字）", deliverable: true };
    },
  },
  {
    name: "fs_write",
    description: "覆盖写入项目内的文本文件（不存在则创建）",
    mutates: true,
    parameters: { type: "object", properties: { path: str(PATH_DESC), content: str("完整文件内容") }, required: ["path", "content"] },
    run(ctx, args) {
      const path = relPath(args.path);
      const content = String(args.content === undefined || args.content === null ? "" : args.content);
      const existing = fs().findByPath(ctx.rootNodeId, path);
      if (existing) {
        if (existing.type !== "file") throw new ToolError("conflict", "目标是文件夹：" + path);
        requireInRoot(ctx, existing.id);
        const node = fs().setContent(existing.id, content);
        return { nodeId: node.id, name: node.name, message: "已写入 " + path + "（" + content.length + " 字）", deliverable: true };
      }
      const target = ensureParent(ctx, path);
      const node = fs().createNode({ name: target.leaf, type: "file", parentId: target.parentId, content });
      return { nodeId: node.id, name: node.name, message: "已创建 " + path + "（" + content.length + " 字）", deliverable: true };
    },
  },
  {
    name: "fs_append",
    description: "在项目内文本文件末尾追加内容（不存在则创建）",
    mutates: true,
    parameters: { type: "object", properties: { path: str(PATH_DESC), content: str("要追加的内容") }, required: ["path", "content"] },
    run(ctx, args) {
      const path = relPath(args.path);
      const add = String(args.content === undefined || args.content === null ? "" : args.content);
      const existing = fs().findByPath(ctx.rootNodeId, path);
      if (existing) {
        if (existing.type !== "file") throw new ToolError("conflict", "目标是文件夹：" + path);
        const cur = existing.content === undefined || existing.content === null ? "" : existing.content;
        // 崩溃恢复窗口的幂等保护：内容已以待追加文本结尾时视为已完成（源 agentTools.ts:178-181）
        if (add && cur.endsWith(add)) {
          return { nodeId: existing.id, name: existing.name, message: "内容已存在于 " + path + " 末尾，未重复追加", deliverable: true };
        }
        const node = fs().setContent(existing.id, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + add);
        return { nodeId: node.id, name: node.name, message: "已追加到 " + path + "（+" + add.length + " 字）", deliverable: true };
      }
      const target = ensureParent(ctx, path);
      const node = fs().createNode({ name: target.leaf, type: "file", parentId: target.parentId, content: add });
      return { nodeId: node.id, name: node.name, message: "已创建 " + path + "（" + add.length + " 字）", deliverable: true };
    },
  },
  {
    name: "fs_edit",
    description: "在项目内文本文件中查找并替换文本（find 必须精确匹配现有内容）",
    mutates: true,
    parameters: {
      type: "object",
      properties: { path: str(PATH_DESC), find: str("要被替换的原文"), replace: str("替换后的文本"), all: { type: "boolean", description: "是否替换全部匹配，默认只替换第一处" } },
      required: ["path", "find", "replace"],
    },
    run(ctx, args) {
      const node = findFile(ctx, relPath(args.path));
      if (node.type !== "file") throw new ToolError("invalid_input", "不是文件：" + args.path);
      const find = String(args.find === undefined || args.find === null ? "" : args.find);
      if (!find) throw new ToolError("invalid_input", "需要提供 find");
      const cur = node.content === undefined || node.content === null ? "" : node.content;
      if (!cur.includes(find)) throw new ToolError("not_found", "文件中没有找到要替换的文本：" + find.slice(0, 60));
      const replace = String(args.replace === undefined || args.replace === null ? "" : args.replace);
      const next = args.all ? cur.split(find).join(replace) : cur.replace(find, replace);
      const saved = fs().setContent(node.id, next);
      return { nodeId: saved.id, name: saved.name, message: "已修改 " + args.path, deliverable: true };
    },
  },
  {
    name: "fs_rename",
    description: "重命名项目内的文件或文件夹",
    mutates: true,
    parameters: { type: "object", properties: { path: str(PATH_DESC), new_name: str("新名字（不含路径）") }, required: ["path", "new_name"] },
    run(ctx, args) {
      const node = findFile(ctx, relPath(args.path));
      const newName = String(args.new_name === undefined || args.new_name === null ? "" : args.new_name).trim();
      if (!newName) throw new ToolError("invalid_input", "新名字不能为空");
      const saved = fs().renameNode(node.id, newName);
      return { nodeId: saved.id, name: saved.name, message: "已重命名为 " + saved.name };
    },
  },
  {
    name: "fs_move",
    description: "把项目内的文件/文件夹移动到项目内另一个文件夹",
    mutates: true,
    parameters: { type: "object", properties: { from: str("源路径"), to: str("目标文件夹路径，留空为项目根") }, required: ["from"] },
    run(ctx, args) {
      const node = findFile(ctx, relPath(args.from));
      const toPath = String(args.to === undefined || args.to === null ? "" : args.to).trim();
      let parentId = ctx.rootNodeId;
      if (toPath) {
        const folder = findFile(ctx, relPath(toPath));
        if (folder.type !== "folder") throw new ToolError("invalid_input", "目标不是文件夹：" + toPath);
        parentId = folder.id;
      }
      const saved = fs().moveNode(node.id, parentId);
      return { nodeId: saved.id, name: saved.name, message: "已移动 " + args.from + " → " + (toPath || "(根目录)") };
    },
  },
  {
    name: "fs_copy",
    description: "在项目内复制文件或文件夹",
    mutates: true,
    parameters: { type: "object", properties: { from: str("源路径"), to: str("目标文件夹路径，留空为项目根") }, required: ["from"] },
    run(ctx, args) {
      const node = findFile(ctx, relPath(args.from));
      const toPath = String(args.to === undefined || args.to === null ? "" : args.to).trim();
      let parentId = ctx.rootNodeId;
      if (toPath) {
        const folder = findFile(ctx, relPath(toPath));
        if (folder.type !== "folder") throw new ToolError("invalid_input", "目标不是文件夹：" + toPath);
        parentId = folder.id;
      }
      const saved = fs().copyNode(node.id, parentId);
      return { nodeId: saved.id, name: saved.name, message: "已复制 " + args.from + " → " + (toPath || "(根目录)"), deliverable: node.type === "file" };
    },
  },
  {
    name: "fs_delete",
    description: "删除项目内的文件或文件夹（移入废纸篓，可恢复）",
    mutates: true,
    parameters: { type: "object", properties: { path: str(PATH_DESC) }, required: ["path"] },
    run(ctx, args) {
      const node = findFile(ctx, relPath(args.path));
      fs().removeNode(node.id);
      return { nodeId: node.id, name: node.name, message: "已删除 " + args.path + "（在废纸篓可恢复）" };
    },
  },
];

/** 源 agentTools.ts:274。 */
const TOOL_MAP = new Map(FILE_TOOLS.map((t) => [t.name, t]));

/** 源 agentTools.ts:276-281。暴露给模型的 OpenAI function 声明（按白名单过滤）。 */
function toolSchemas(allow) {
  return FILE_TOOLS
    .filter((t) => !allow || allow.has(t.name))
    .map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

/** 源 agentTools.ts:283-285。 */
function getTool(name) {
  return TOOL_MAP.get(name);
}

/** T2 扩展：每次调用的工具表可覆盖（默认仍是内置 FILE_TOOLS），供离线测试与后续批次注入。 */
function resolveToolRegistry(runOptions) {
  const source = runOptions && (runOptions.registry || runOptions.tools);
  if (!source) return TOOL_MAP;
  if (source instanceof Map) return source;
  if (Array.isArray(source)) return new Map(source.map((t) => [t.name, t]));
  return new Map(Object.entries(source));
}

/** JSON 值的运行时类型（null 单列，便于 outputSchema 报错可读）。 */
function runtimeType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** T2 扩展：JSON-Schema 子集校验（type/required/properties/additionalProperties/items/enum），返回首个错误文本或 null。 */
function validateAgainstSchema(value, schema, pointer) {
  if (!schema || typeof schema !== "object") return null;
  const p = pointer || "$";
  if (schema.type !== undefined) {
    const actual = runtimeType(value);
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = expected.includes(actual) || (expected.includes("integer") && actual === "number" && Number.isInteger(value));
    if (!ok) return p + " 期望类型 " + JSON.stringify(schema.type) + "，实际 " + actual;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => item === value)) return p + " 不在 enum 内";
  if (runtimeType(value) === "object") {
    for (const key of Array.isArray(schema.required) ? schema.required : []) if (!(key in value)) return p + "." + key + " 缺少必填字段";
    const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    for (const [key, sub] of Object.entries(props)) {
      if (!(key in value)) continue;
      const nested = validateAgainstSchema(value[key], sub, p + "." + key);
      if (nested) return nested;
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in props)) return p + "." + key + " 不被 outputSchema 允许";
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i += 1) {
      const nested = validateAgainstSchema(value[i], schema.items, p + "[" + i + "]");
      if (nested) return nested;
    }
  }
  return null;
}

/** T2 扩展：输出不符合 outputSchema 时抛结构化错误，绝不把坏结果交给模型。 */
function assertOutputSchema(tool, result) {
  if (!tool || !tool.outputSchema) return;
  const detail = validateAgainstSchema(result, tool.outputSchema, "$");
  if (detail) throw new ToolError("output_schema_invalid", "工具输出不符合 outputSchema：" + tool.name + " · " + detail, { detail });
}

/** T2 扩展：异步工具的超时 / 取消（同步返回值原样透传）。 */
function withTimeout(value, timeoutMs, signal, name) {
  if (!value || typeof value.then !== "function") return Promise.resolve(value);
  const ms = Number(timeoutMs);
  const useTimer = Number.isFinite(ms) && ms > 0;
  if (!useTimer && !signal) return value;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === "function") signal.removeEventListener("abort", onAbort);
    };
    const fail = (error) => { if (settled) return; settled = true; cleanup(); reject(error); };
    const done = (result) => { if (settled) return; settled = true; cleanup(); resolve(result); };
    const onAbort = () => fail(new ToolError("cancelled", "工具执行已取消：" + name));
    if (useTimer) {
      timer = setTimeout(() => fail(new ToolError("timeout", "工具执行超时（" + ms + "ms）：" + name, { detail: ms })), ms);
    }
    if (signal) { if (signal.aborted) { onAbort(); return; } if (typeof signal.addEventListener === "function") signal.addEventListener("abort", onAbort, { once: true }); }
    value.then(done, (error) => fail(asToolError(error, "internal")));
  });
}

/** 源 agentTools.ts:292-299 的门禁调用顺序：先根，再按 mutates 逐路径校验。 */
function gateRunWorkspaceWrite(ctx, tool, args, runOptions) {
  const guard = (runOptions && runOptions.workspaceGuard) || builtinOptions.workspaceGuard || defaultWorkspaceGuard();
  const invoke = (path) => {
    try {
      return guard(ctx.runId, ctx.userId, ctx.rootNodeId, path);
    } catch (error) {
      throw asToolError(error, "permission_denied");
    }
  };
  invoke(undefined);
  if (!tool.mutates) return;
  const primary = args.path === undefined || args.path === null ? args.from : args.path;
  invoke(relPath(primary));
  if (args.to) invoke(relPath(args.to));
  if (tool.name === "fs_rename") invoke(relPath(args.new_name));
}

/**
 * 源 agentTools.ts:287-303 + T2 扩展。
 * 执行前检查（未知工具 / 白名单 / 工作区门禁 / 根目录）+ 执行 + 超时 + 输出 schema。
 */
async function runTool(name, ctx, args, allow, runOptions) {
  const toolName = String(name);
  const toolArgs = args && typeof args === "object" ? args : {};
  const tool = resolveToolRegistry(runOptions).get(toolName);
  if (!tool) throw new ToolError("unsupported", "未知工具：" + toolName);
  if (allow && !allow.has(toolName)) throw new ToolError("permission_denied", "工具未授权：" + toolName);
  const context = ctx && typeof ctx === "object" ? ctx : {};
  // 写操作必须在任何副作用前确认工作区适配器已注入；未注入直接结构化拒绝。
  if (tool.mutates) requireWorkspaceAdapterForWrite();
  if (context.runId) gateRunWorkspaceWrite(context, tool, toolArgs, runOptions);
  const root = fs().getNode(context.rootNodeId);
  if (!root || root.type !== "folder" || root.trashed) throw new ToolError("not_found", "项目根文件夹不存在");
  const timeoutMs = runOptions && runOptions.timeoutMs !== undefined ? runOptions.timeoutMs : builtinOptions.timeoutMs;
  const signal = (runOptions && runOptions.signal) || context.signal;
  const value = await withTimeout(Promise.resolve().then(() => tool.run(context, toolArgs)), timeoutMs, signal, toolName);
  assertOutputSchema(tool, value);
  return value;
}

/** 结构化包装：调用方拿 { ok, result } 或 { ok:false, code, message }，不解析异常文本。 */
async function runToolSafe(name, ctx, args, allow, runOptions) {
  try {
    return { ok: true, result: await runTool(name, ctx, args, allow, runOptions) };
  } catch (error) {
    return toToolErrorPayload(error);
  }
}

/** 源 agentTools.ts:305-310。旧 M2 action 工具名 → 新注册表名。 */
const LEGACY_TOOL_ALIAS = Object.freeze({
  "file.read": "fs_read",
  "file.create": "fs_create",
  "file.write": "fs_write",
});

/** 源 agentTools.ts:312-314。 */
function newOperationId(taskId) {
  return String(taskId) + ":op-" + randomUUID().slice(0, 12);
}

module.exports = {
  // 错误与结构化投影
  ToolError,
  TOOL_ERROR_CODES,
  toToolErrorPayload,
  asToolError,
  // 注入点
  configureBuiltinTools,
  resetBuiltinToolsForTests,
  builtinToolOptions,
  // 工具目录
  FILE_TOOLS,
  TOOL_MAP,
  toolSchemas,
  getTool,
  // 执行
  runTool,
  runToolSafe,
  validateAgainstSchema,
  assertOutputSchema,
  // 兼容与幂等
  LEGACY_TOOL_ALIAS,
  newOperationId,
  PATH_DESC,
};


