"use strict";
/**
 * DX 虚拟文件树 · 共享盘 / 部门盘 / 快照 / 搜索 / 统计的受控桥。
 *
 * 为什么挂在 platform:command（新命令，不新增 preload 顶层键）：
 *   · 本仓 preload 顶层键被 experiments/dxos-e2e 的冻结契约逐字断言，新增顶层键会破坏既有契约；
 *     而 platform 域本身就是"系统级只读/受控数据面"（诊断、数据保护、存储统计），
 *     共享盘浏览 / 子树快照 / 搜索 / 统计放在这里不引入第二套系统能力。
 *   · 命令只返回安全节点投影（id/name/type/mime/size/parentId/share），绝不返回 blob、内容正文或磁盘绝对路径。
 *   · 权限：public 共享盘对所有已登录用户可读；department:<id> 只对本部门成员与超管可读；
 *     个人节点只对 owner 可读；快照恢复（destructive）只允许 超管 / 节点 owner / 该部门管理员。
 *
 * 快照不落盘、不进 IPC：snapshotSubtree 可能包含 base64 blob，直接过桥会放大到几十 MB。
 * 这里只把快照保存在主进程内存（每用户最多 10 个），响应仅回 snapshotId + nodeCount。
 */
const { randomUUID } = require("node:crypto");

const MAX_SNAPSHOT_NODES = 5000;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_SNAPSHOTS_PER_USER = 10;
const MAX_LIST_CHILDREN = 2000;
const MAX_SEARCH_LIMIT = 100;

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error, detail = null) => ({ ok: false, error: String(error), detail });

function nodeView(node) {
  if (!node) return null;
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    mime: node.mime || null,
    size: node.size == null ? null : Number(node.size),
    parentId: node.parentId == null ? null : node.parentId,
    share: node.share || null,
    ownerId: node.ownerId || null,
    system: node.system === true,
    createdAt: node.created_ts == null ? null : Number(node.created_ts),
    updatedAt: node.updated_ts == null ? null : Number(node.updated_ts),
  };
}

function createFilesSharedBridge({ fsStore = null, clock = null } = {}) {
  if (!fsStore || typeof fsStore.getNode !== "function") {
    return Object.freeze({ available: false,
      roots: () => fail("DEPENDENCY_UNAVAILABLE", "fsStore"),
      list: () => fail("DEPENDENCY_UNAVAILABLE", "fsStore"),
      search: () => fail("DEPENDENCY_UNAVAILABLE", "fsStore"),
      stats: () => fail("DEPENDENCY_UNAVAILABLE", "fsStore"),
      snapshotCreate: () => fail("DEPENDENCY_UNAVAILABLE", "fsStore"),
      snapshotRestore: () => fail("DEPENDENCY_UNAVAILABLE", "fsStore"),
    });
  }
  const now = typeof clock === "function" ? clock : () => Date.now();
  const snapshots = new Map(); // snapshotId → { ownerId, rootId, snapshot, nodeCount, createdAt }

  function contextOf(context) {
    const userId = context && context.userId != null ? String(context.userId) : null;
    if (!userId) return null;
    const departmentIds = Array.isArray(context.departmentIds) ? context.departmentIds.map(String) : [];
    const adminDeptIds = Array.isArray(context.adminDeptIds) ? context.adminDeptIds.map(String) : [];
    return { userId, isSuper: context.isSuper === true || (context.actor && context.actor.role === "ADMIN") || false, departmentIds, adminDeptIds };
  }

  function shareRoots(actor) {
    const roots = [];
    try { roots.push(fsStore.ensurePublicRoot()); } catch { /* 公共盘建不出来时不伪造 */ }
    for (const departmentId of actor.departmentIds) {
      if (!departmentId) continue;
      try { roots.push(fsStore.ensureDepartmentRoot(departmentId, "部门")); } catch { /* 单个部门失败不影响其它共享区 */ }
    }
    // 超管：把系统根下所有部门盘都列出来（普通成员只看自己部门）。
    try {
      if (actor.isSuper) {
        const systemRoot = fsStore.ensureSystemRoot();
        const children = fsStore.listChildren(systemRoot.id).nodes || [];
        for (const node of children) if (typeof node.share === "string" && node.share.startsWith("department:")) roots.push(node);
      }
    } catch { /* 列不出来就只回已知共享区 */ }
    const seen = new Set();
    return roots.filter((node) => node && node.id && !node.trashed && !seen.has(node.id) && seen.add(node.id))
      .filter((node) => visible(node, actor))
      .map(nodeView);
  }

  function visible(node, actor) {
    if (!node || node.trashed) return false;
    try { if (typeof fsStore.isInTrash === "function" && fsStore.isInTrash(node.id)) return false; } catch { return false; }
    if (node.ownerId && String(node.ownerId) === actor.userId) return true;
    let share = typeof node.share === "string" ? node.share : null;
    if (!share && typeof fsStore.shareZoneOf === "function") {
      try { share = fsStore.shareZoneOf(node.id) || null; } catch { share = null; }
    }
    if (!share) return false;
    if (share === "public") return true;
    if (!share.startsWith("department:")) return false; // canvas:/asset-library: 标记不是全局共享盘
    const departmentId = share.slice("department:".length);
    return actor.isSuper || actor.departmentIds.includes(departmentId);
  }

  function writable(node, actor) {
    if (actor.isSuper) return true;
    if (node.ownerId && String(node.ownerId) === actor.userId) return true;
    const share = typeof node.share === "string" ? node.share : null;
    if (share && share.startsWith("department:")) return actor.adminDeptIds.includes(share.slice("department:".length));
    return false;
  }

  function visibleNode(actor, nodeId) {
    const id = String(nodeId || "").trim();
    if (!id) return fail("INVALID_INPUT", "nodeId");
    const node = fsStore.getNode(id);
    if (!node) return fail("NOT_FOUND", "node");
    if (!visible(node, actor)) return fail("FORBIDDEN", "没有读取权限");
    return ok({ node });
  }

  function roots({ context } = {}) {
    const actor = contextOf(context);
    if (!actor) return fail("UNAUTHENTICATED");
    return ok({ roots: shareRoots(actor) });
  }

  function list({ context, nodeId } = {}) {
    const actor = contextOf(context);
    if (!actor) return fail("UNAUTHENTICATED");
    const target = visibleNode(actor, nodeId);
    if (!target.ok) return target;
    const node = target.node;
    let children = [];
    if (node.type === "folder") {
      try { children = (fsStore.listChildren(node.id).nodes || []).filter((child) => !child.trashed).slice(0, MAX_LIST_CHILDREN).map(nodeView); }
      catch { return fail("INTERNAL", "listChildren"); }
    }
    return ok({ node: nodeView(node), children });
  }

  function search({ context, nodeId, query, limit } = {}) {
    const actor = contextOf(context);
    if (!actor) return fail("UNAUTHENTICATED");
    const target = visibleNode(actor, nodeId);
    if (!target.ok) return target;
    if (target.node.type !== "folder") return fail("INVALID_INPUT", "node-is-not-folder");
    const q = String(query || "").trim();
    if (!q) return ok({ results: [] });
    const max = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Number(limit) || 50));
    const results = fsStore.searchNodes(target.node.id, q, { limit: max }).map((row) => ({
      id: row.id, name: row.name, type: row.type, path: row.path,
      ...(row.snippet ? { snippet: String(row.snippet).slice(0, 240) } : {}),
    }));
    return ok({ results });
  }

  function stats({ context, nodeId } = {}) {
    const actor = contextOf(context);
    if (!actor) return fail("UNAUTHENTICATED");
    const target = visibleNode(actor, nodeId);
    if (!target.ok) return target;
    let bytes = 0;
    let entries = 0;
    try {
      bytes = Number(fsStore.subtreeByteSize(target.node.id)) || 0;
      entries = (fsStore.subtree(target.node.id, 12) || []).length;
    } catch { return fail("INTERNAL", "stats"); }
    return ok({ nodeId: target.node.id, bytes, entries });
  }

  function snapshotCreate({ context, nodeId, reason } = {}) {
    const actor = contextOf(context);
    if (!actor) return fail("UNAUTHENTICATED");
    const target = visibleNode(actor, nodeId);
    if (!target.ok) return target;
    if (target.node.type !== "folder") return fail("INVALID_INPUT", "node-is-not-folder");
    let snapshot;
    try { snapshot = fsStore.snapshotSubtree(target.node.id); }
    catch (error) { return fail("NOT_FOUND", String((error && error.message) || error)); }
    const nodeCount = Array.isArray(snapshot.nodes) ? snapshot.nodes.length : 0;
    const blobBytes = Object.values(snapshot.blobs || {}).reduce((sum, base64) => sum + Buffer.byteLength(String(base64), "base64"), 0);
    if (nodeCount > MAX_SNAPSHOT_NODES) return fail("LIMIT_EXCEEDED", "nodes=" + nodeCount);
    if (blobBytes > MAX_SNAPSHOT_BYTES) return fail("LIMIT_EXCEEDED", "blobBytes=" + blobBytes);
    const snapshotId = "snap_" + randomUUID();
    snapshots.set(snapshotId, { ownerId: actor.userId, rootId: target.node.id, snapshot, nodeCount, createdAt: now(), reason: String(reason || "").slice(0, 200) });
    const mine = [...snapshots.entries()].filter(([, item]) => item.ownerId === actor.userId).sort((a, b) => a[1].createdAt - b[1].createdAt);
    while (mine.length > MAX_SNAPSHOTS_PER_USER) {
      const oldest = mine.shift();
      snapshots.delete(oldest[0]);
    }
    return ok({ snapshotId, nodeId: target.node.id, nodeCount, bytes: blobBytes, createdAt: now() });
  }

  function snapshotRestore({ context, snapshotId } = {}) {
    const actor = contextOf(context);
    if (!actor) return fail("UNAUTHENTICATED");
    const id = String(snapshotId || "").trim();
    if (!/^snap_[A-Za-z0-9-]{8,80}$/.test(id)) return fail("INVALID_INPUT", "snapshotId");
    const stored = snapshots.get(id);
    if (!stored || stored.ownerId !== actor.userId) return fail("NOT_FOUND", "snapshot");
    const target = visibleNode(actor, stored.rootId);
    if (!target.ok) return fail("NOT_FOUND", "snapshot-root");
    if (!writable(target.node, actor)) return fail("FORBIDDEN", "没有恢复权限");
    let restored = 0;
    try { restored = fsStore.restoreSubtreeSnapshot(stored.rootId, stored.snapshot); }
    catch (error) { return fail("CONFLICT", String((error && error.message) || error)); }
    snapshots.delete(id);
    return ok({ snapshotId: id, nodeId: stored.rootId, restored: Number(restored) || 0 });
  }

  return Object.freeze({ available: true, roots, list, search, stats, snapshotCreate, snapshotRestore });
}

module.exports = { createFilesSharedBridge, MAX_SNAPSHOT_NODES, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOTS_PER_USER };
