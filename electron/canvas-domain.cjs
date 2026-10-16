/**
 * D5-02 · 无限画布纯领域（无 I/O，无 Electron）。
 *
 * 这一层是**唯一的画布命令处理层**（PLAN §24）：鼠标/快捷键（画布页面内的命令适配器）
 * 与 AI 工具调用（主进程受控工具）都走同一个 applyCommand / 同一份版本检查 / 同一份权限规则。
 * 它不认识 UI，也不认识存储；只认识"文档 + 命令 → 新文档 + 结果"。
 *
 * 文档口径（与 NOVAI 无限画布一致，不改动原画布的数据结构）：
 *   { nodes: [{id, type, x, y, ...}], connections: [{id, from, to}], viewport: {x,y,scale}, logs: [] }
 */
"use strict";

const authz = require("./authorization-domain.cjs");

const REASON = Object.freeze({
  OK: "OK",
  INVALID_INPUT: "INVALID_INPUT",
  NOT_FOUND: "NOT_FOUND",
  REVISION_CONFLICT: "REVISION_CONFLICT",
  READ_ONLY: "READ_ONLY",
  UNSUPPORTED_COMMAND: "UNSUPPORTED_COMMAND",
  LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
  /** 异步 run 的结果写回：目标节点（或整本画布）在生成期间已不存在。结果保留在 run 记录里。 */
  CANVAS_RUN_TARGET_MISSING: "CANVAS_RUN_TARGET_MISSING",
  /** 异步 run 的结果写回：目标节点被并发修改（按节点粒度判定），结果不覆盖用户内容。 */
  CANVAS_RUN_NODE_CONFLICT: "CANVAS_RUN_NODE_CONFLICT",
});

/** 画布命令集合（PLAN §24：添加、编辑、移动、复制、删除、分组、连线、断开、撤销和重做）。*/
const COMMANDS = Object.freeze([
  "node.add", "node.edit", "node.move", "node.copy", "node.delete", "node.group",
  "edge.connect", "edge.disconnect", "undo", "redo",
]);

/** AI 可执行的命令（撤销/重做由历史层处理，见 applyCommand 的 journal 参数）。*/
const AGENT_COMMANDS = Object.freeze(["node.add", "node.edit", "node.move", "node.copy", "node.delete", "node.group", "edge.connect", "edge.disconnect"]);

const LIMITS = Object.freeze({ NODES: 2000, EDGES: 4000, LABEL: 200, PATCH_KEYS: 40, JOURNAL: 50 });

const NODE_TYPES = Object.freeze(["prompt", "image", "llm", "generator", "video", "comfy", "output", "group", "table", "promptGroup"]);

/** node.edit 允许改的字段：身份与结构字段（id/type）绝不允许被改写，避免连接悬空。*/
const EDITABLE_NODE_KEYS = Object.freeze([
  "text", "url", "name", "title", "prompt", "model", "llmProvider", "apiProvider", "mode", "systemPrompt",
  "mediaKind", "w", "h", "width", "height", "x", "y", "items", "refs", "runStatus", "runError", "params",
  "count", "quality", "seed", "ratio", "duration", "resolution", "reverse", "targetType", "targetModel",
]);

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

function emptyDoc() {
  return { nodes: [], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] };
}

/**
 * 归一化文档：只保留画布真正使用的字段，剔除运行期瞬态（running/runError 等由画布自己管）。
 * 超限一律**拒绝**而不是截断 —— 截断会静默丢用户内容。
 */
function normalizeDoc(raw) {
  if (!isObj(raw)) return { ok: false, reason: REASON.INVALID_INPUT };
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const connections = Array.isArray(raw.connections) ? raw.connections : [];
  if (nodes.length > LIMITS.NODES || connections.length > LIMITS.EDGES) return { ok: false, reason: REASON.LIMIT_EXCEEDED };
  const out = emptyDoc();
  const ids = new Set();
  for (const n of nodes) {
    if (!isObj(n)) return { ok: false, reason: REASON.INVALID_INPUT };
    const id = str(n.id, 120);
    if (!id || ids.has(id)) return { ok: false, reason: REASON.INVALID_INPUT };
    ids.add(id);
    const copy = { ...n, id, type: str(n.type, 40) || "image", x: num(n.x), y: num(n.y) };
    delete copy.running;
    delete copy._pending;
    out.nodes.push(copy);
  }
  for (const c of connections) {
    if (!isObj(c)) return { ok: false, reason: REASON.INVALID_INPUT };
    const from = str(c.from, 120);
    const to = str(c.to, 120);
    if (!from || !to) return { ok: false, reason: REASON.INVALID_INPUT };
    if (!ids.has(from) || !ids.has(to)) return { ok: false, reason: REASON.NOT_FOUND };
    if (from === to) return { ok: false, reason: REASON.INVALID_INPUT };
    out.connections.push({ ...c, id: str(c.id, 120) || "c_" + from + "_" + to, from, to });
  }
  out.viewport = isObj(raw.viewport)
    ? { x: num(raw.viewport.x), y: num(raw.viewport.y), scale: Number.isFinite(Number(raw.viewport.scale)) ? Number(raw.viewport.scale) : 1 }
    : { x: 0, y: 0, scale: 1 };
  out.logs = Array.isArray(raw.logs) ? raw.logs.slice(-200) : [];
  return { ok: true, doc: out };
}

function normalizeCommand(raw) {
  if (!isObj(raw) || !COMMANDS.includes(str(raw.type, 40))) return { ok: false, reason: REASON.UNSUPPORTED_COMMAND };
  const type = String(raw.type);
  const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x).slice(0, 200) : []);
  switch (type) {
    case "node.add": {
      if (!isObj(raw.node)) return { ok: false, reason: REASON.INVALID_INPUT };
      const node = { ...raw.node };
      node.id = str(node.id, 120) || null;
      node.type = str(node.type, 40);
      if (!node.type) return { ok: false, reason: REASON.INVALID_INPUT };
      node.x = num(node.x);
      node.y = num(node.y);
      return { ok: true, command: { type, node } };
    }
    case "node.edit": {
      if (!isObj(raw.patch)) return { ok: false, reason: REASON.INVALID_INPUT };
      const keys = Object.keys(raw.patch);
      if (!keys.length || keys.length > LIMITS.PATCH_KEYS) return { ok: false, reason: REASON.INVALID_INPUT };
      const patch = {};
      for (const k of keys) {
        if (k === "id" || k === "type") return { ok: false, reason: REASON.INVALID_INPUT };
        if (!EDITABLE_NODE_KEYS.includes(k)) return { ok: false, reason: REASON.INVALID_INPUT };
        patch[k] = raw.patch[k];
      }
      const id = str(raw.id, 120) || str(raw.nodeId, 120);
      if (!id) return { ok: false, reason: REASON.INVALID_INPUT };
      return { ok: true, command: { type, id, patch } };
    }
    case "node.move": {
      const id = str(raw.id, 120) || str(raw.nodeId, 120);
      if (id) return { ok: true, command: { type, ids: [id], x: num(raw.x, NaN), y: num(raw.y, NaN) } };
      const list = ids(raw.ids);
      if (!list.length) return { ok: false, reason: REASON.INVALID_INPUT };
      return { ok: true, command: { type, ids: list, dx: num(raw.dx), dy: num(raw.dy) } };
    }
    case "node.copy":
    case "node.delete": {
      const single = str(raw.id, 120) || str(raw.nodeId, 120);
      const list = single ? [single] : ids(raw.ids);
      if (!list.length) return { ok: false, reason: REASON.INVALID_INPUT };
      return { ok: true, command: { type, ids: list, dx: num(raw.dx, 40), dy: num(raw.dy, 40), newId: str(raw.newId, 120) || null } };
    }
    case "node.group": {
      const list = ids(raw.ids);
      if (list.length < 2) return { ok: false, reason: REASON.INVALID_INPUT };
      return { ok: true, command: { type, ids: list, title: str(raw.title, LIMITS.LABEL) || "工作流群组", groupId: str(raw.groupId, 120) || null } };
    }
    case "edge.connect": {
      const from = str(raw.from, 120) || str(raw.fromId, 120);
      const to = str(raw.to, 120) || str(raw.toId, 120);
      if (!from || !to || from === to) return { ok: false, reason: REASON.INVALID_INPUT };
      return { ok: true, command: { type, from, to, id: str(raw.id, 120) || null } };
    }
    case "edge.disconnect": {
      const id = str(raw.id, 120);
      const from = str(raw.from, 120) || str(raw.fromId, 120);
      const to = str(raw.to, 120) || str(raw.toId, 120);
      if (!id && !(from && to)) return { ok: false, reason: REASON.INVALID_INPUT };
      return { ok: true, command: { type, id: id || null, from: from || null, to: to || null } };
    }
    default:
      return { ok: true, command: { type } };
  }
}

const findNode = (doc, id) => doc.nodes.find((n) => n.id === id) || null;

/**
 * 纯命令处理：**不改原文档**，返回新文档。
 * @param doc        已归一化的文档
 * @param command    已归一化的命令
 * @param opts.newId 生成新 id 的唯一入口（测试可注入确定性序列）
 */
function applyCommand(doc, command, opts = {}) {
  const nextId = typeof opts.newId === "function" ? opts.newId : (prefix) => prefix + "_" + Math.random().toString(36).slice(2, 8);
  const out = { nodes: doc.nodes.map((n) => ({ ...n })), connections: doc.connections.map((c) => ({ ...c })), viewport: { ...doc.viewport }, logs: (doc.logs || []).slice() };
  switch (command.type) {
    case "node.add": {
      if (out.nodes.length >= LIMITS.NODES) return { ok: false, reason: REASON.LIMIT_EXCEEDED };
      const node = { ...command.node };
      if (!node.id) node.id = nextId(String(node.type || "n"));
      if (findNode(out, node.id)) return { ok: false, reason: REASON.INVALID_INPUT };
      out.nodes.push(node);
      return { ok: true, doc: out, touched: { nodeIds: [node.id] }, result: { node } };
    }
    case "node.edit": {
      const node = findNode(out, command.id);
      if (!node) return { ok: false, reason: REASON.NOT_FOUND };
      Object.assign(node, command.patch);
      return { ok: true, doc: out, touched: { nodeIds: [node.id] }, result: { node } };
    }
    case "node.move": {
      const ids = command.ids;
      const single = ids.length === 1 && Number.isFinite(command.x) && Number.isFinite(command.y);
      const moved = [];
      for (const id of ids) {
        const node = findNode(out, id);
        if (!node) return { ok: false, reason: REASON.NOT_FOUND };
      }
      for (const id of ids) {
        const node = findNode(out, id);
        if (single) { node.x = command.x; node.y = command.y; }
        else { node.x = num(node.x) + command.dx; node.y = num(node.y) + command.dy; }
        moved.push(node.id);
      }
      return { ok: true, doc: out, touched: { nodeIds: moved }, result: { ids: moved } };
    }
    case "node.copy": {
      if (out.nodes.length + command.ids.length > LIMITS.NODES) return { ok: false, reason: REASON.LIMIT_EXCEEDED };
      const created = [];
      for (const id of command.ids) {
        const node = findNode(out, id);
        if (!node) return { ok: false, reason: REASON.NOT_FOUND };
      }
      for (const id of command.ids) {
        const node = findNode(out, id);
        const copy = { ...node, id: command.ids.length === 1 && command.newId ? command.newId : nextId(String(node.type || "n")), x: num(node.x) + command.dx, y: num(node.y) + command.dy };
        if (findNode(out, copy.id)) return { ok: false, reason: REASON.INVALID_INPUT };
        out.nodes.push(copy);
        created.push(copy.id);
      }
      return { ok: true, doc: out, touched: { nodeIds: created }, result: { ids: created } };
    }
    case "node.delete": {
      const removing = new Set(command.ids);
      for (const id of command.ids) if (!findNode(out, id)) return { ok: false, reason: REASON.NOT_FOUND };
      out.nodes = out.nodes.filter((n) => !removing.has(n.id));
      out.connections = out.connections.filter((c) => !removing.has(c.from) && !removing.has(c.to));
      return { ok: true, doc: out, touched: { nodeIds: [...removing], removed: true }, result: { ids: [...removing] } };
    }
    case "node.group": {
      for (const id of command.ids) if (!findNode(out, id)) return { ok: false, reason: REASON.NOT_FOUND };
      const members = command.ids.map((id) => findNode(out, id));
      const minX = Math.min(...members.map((n) => num(n.x)));
      const minY = Math.min(...members.map((n) => num(n.y)));
      const gid = command.groupId || nextId("grp");
      if (findNode(out, gid)) return { ok: false, reason: REASON.INVALID_INPUT };
      const group = { id: gid, type: "group", x: minX - 24, y: minY - 64, w: 420, h: 280, title: command.title, items: command.ids.slice(), runStatus: "", runError: "" };
      if (out.nodes.length >= LIMITS.NODES) return { ok: false, reason: REASON.LIMIT_EXCEEDED };
      out.nodes.push(group);
      return { ok: true, doc: out, touched: { nodeIds: [gid] }, result: { group } };
    }
    case "edge.connect": {
      if (!findNode(out, command.from) || !findNode(out, command.to)) return { ok: false, reason: REASON.NOT_FOUND };
      if (out.connections.some((c) => c.from === command.from && c.to === command.to)) return { ok: false, reason: REASON.INVALID_INPUT };
      if (out.connections.length >= LIMITS.EDGES) return { ok: false, reason: REASON.LIMIT_EXCEEDED };
      const edge = { id: command.id || nextId("c"), from: command.from, to: command.to };
      out.connections.push(edge);
      return { ok: true, doc: out, touched: { edgeIds: [edge.id] }, result: { edge } };
    }
    case "edge.disconnect": {
      const hit = command.id
        ? out.connections.filter((c) => c.id === command.id)
        : out.connections.filter((c) => c.from === command.from && c.to === command.to);
      if (!hit.length) return { ok: false, reason: REASON.NOT_FOUND };
      const drop = new Set(hit.map((c) => c.id));
      out.connections = out.connections.filter((c) => !drop.has(c.id));
      return { ok: true, doc: out, touched: { edgeIds: [...drop], removed: true }, result: { ids: [...drop] } };
    }
    default:
      return { ok: false, reason: REASON.UNSUPPORTED_COMMAND };
  }
}

/**
 * 画布权限规则（**只有一份**）：鼠标路径（保存/命令）与 AI 路径（工具）都调用它。
 * 返回 { allow, actions, source }。
 */
function evaluateCanvasAccess({ actor = {}, entry = null, share = null } = {}) {
  const userId = str(actor.userId || actor.user_id, 120);
  const isSuper = !!actor.isSuper;
  if (!entry) return { allow: false, actions: [], source: "NOT_FOUND" };
  if (isSuper) return { allow: true, actions: [...authz.OWNER_ACTIONS], source: "SUPER_ADMIN" };
  if (entry.owner_user_id === userId) return { allow: true, actions: [...authz.OWNER_ACTIONS], source: "OWNER_POLICY" };
  if (entry.visibility === "ORGANIZATION" && entry.organization_id && entry.organization_id === actor.organizationId)
    return { allow: true, actions: [...authz.PERMISSION_SET.VIEWER], source: "ORG_POLICY" };
  if (share && share.user_id === userId) {
    const role = String(share.role || "VIEWER").toUpperCase();
    const actions = role === "EDITOR" || role === "CONTRIBUTOR" ? [...authz.PERMISSION_SET.CONTRIBUTOR] : [...authz.PERMISSION_SET.VIEWER];
    return { allow: true, actions, source: "SHARE_" + role };
  }
  return { allow: false, actions: [], source: "NO_GRANT" };
}

const canView = (access) => !!access.allow && access.actions.includes(authz.ACTION.READ);
const canEdit = (access) => !!access.allow && access.actions.includes(authz.ACTION.EDIT);

module.exports = {
  REASON, COMMANDS, AGENT_COMMANDS, LIMITS, NODE_TYPES, EDITABLE_NODE_KEYS,
  emptyDoc, normalizeDoc, normalizeCommand, applyCommand, evaluateCanvasAccess, canView, canEdit,
};
