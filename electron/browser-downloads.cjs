/**
 * D5-01 · 浏览器下载记录。
 *
 * 职责只有一件事：把 Electron 的 `DownloadItem` 变成**可安全投影给渲染进程**的记录，
 * 并保证文件真实落盘。它不拥有任何窗口/标签状态（那是 Window Manager 的）。
 *
 * 两条硬约束：
 *   1. **记录按会话键（用户）隔离** —— list/clear 一律带 sessionKey，
 *      退出或切账号后另一个用户看不到前一个用户的下载信息（A04）。
 *   2. 记录里只有 safe 字段：文件名 / 去凭据 URL / 落盘路径 / 字节数 / 状态 / 时间。
 *      没有 cookie、没有 Authorization、没有 profile 路径以外的内部对象。
 *
 * 每个用户一份下载目录（`<downloadsDir>/<sessionKey>/`），
 * 因此"另一个用户"不仅看不到记录，磁盘上也不在同一个目录里。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { shell } = require("electron");

/** 文件名安全化：去掉路径分隔符与控制字符，保留长度上限。 */
function safeFilename(name, fallback = "download") {
  const base = String(name || "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\/]/g, "_").trim();
  const trimmed = base.replace(/^\.+/, "").slice(0, 120);
  return trimmed || fallback;
}

/** 同名文件不覆盖：a.txt → a (1).txt（与系统"另存为"的默认行为一致）。 */
function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length) || "download";
  let candidate = path.join(dir, filename);
  for (let i = 1; fs.existsSync(candidate); i += 1) candidate = path.join(dir, `${stem} (${i})${ext}`);
  return candidate;
}

/** 来源 URL 去凭据；解析失败就退回空串（绝不把原始串直接塞进记录）。 */
function safeSourceURL(raw) {
  try {
    const u = new URL(String(raw || ""));
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return "";
  }
}

class BrowserDownloads {
  /**
   * @param opts.dir      下载根目录（每个 sessionKey 一个子目录）
   * @param opts.onEvent  状态事件回调（由 controller 转发给渲染进程）
   * @param opts.log      日志
   */
  constructor({ dir, onEvent, log } = {}) {
    this.dir = dir;
    this.onEvent = typeof onEvent === "function" ? onEvent : () => {};
    this.log = typeof log === "function" ? log : () => {};
    /** downloadId → safe 记录 */
    this.records = new Map();
    /** downloadId → Electron DownloadItem（不投影给渲染进程） */
    this.items = new Map();
    this.seq = 0;
  }

  #dirFor(sessionKey) {
    const key = String(sessionKey || "shared").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    return path.join(this.dir, key);
  }

  #emit(record) {
    this.onEvent({
      type: "download-state",
      downloadId: record.downloadId,
      state: record.state,
      filename: record.filename,
      received: record.received,
      total: record.total,
      sessionKey: record.sessionKey,
    });
  }

  /** 接住一个 will-download：设置落盘路径、跟踪进度、完成/失败都留记录。 */
  attach(item, { sessionKey, appId } = {}) {
    const dir = this.#dirFor(sessionKey);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const filename = safeFilename(item.getFilename());
    const savePath = uniquePath(dir, filename);
    item.setSavePath(savePath);
    const record = {
      downloadId: "dl_" + crypto.randomBytes(8).toString("hex"),
      sessionKey: String(sessionKey || "shared"),
      appId: appId ? String(appId) : null,
      filename,
      source: safeSourceURL(item.getURL()),
      savePath,
      state: "progressing",
      received: 0,
      total: Math.max(0, Number(item.getTotalBytes()) || 0),
      startedAt: Date.now(),
      endedAt: null,
    };
    this.records.set(record.downloadId, record);
    this.items.set(record.downloadId, item);
    this.log(`download: 开始 ${record.filename} → ${savePath}`);
    this.#emit(record);
    item.on("updated", (_e, state) => {
      record.received = Number(item.getReceivedBytes()) || 0;
      record.total = Math.max(0, Number(item.getTotalBytes()) || 0);
      // updated 只回报 progressing / interrupted；结束状态由 done 定。
      if (state === "interrupted") record.state = "interrupted";
      this.#emit(record);
    });
    item.once("done", (_e, state) => {
      record.state = state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "interrupted";
      record.received = Number(item.getReceivedBytes()) || 0;
      record.total = Math.max(0, Number(item.getTotalBytes()) || 0);
      record.endedAt = Date.now();
      this.log(`download: ${record.filename} → ${record.state}（${record.received}/${record.total}）`);
      this.#emit(record);
    });
    return record.downloadId;
  }

  /** 只返回该会话键的记录（A04：不跨用户）。 */
  list(sessionKey) {
    const key = String(sessionKey || "shared");
    return [...this.records.values()]
      .filter((r) => r.sessionKey === key)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((r) => ({ ...r }));
  }

  get(downloadId) {
    const r = this.records.get(String(downloadId || ""));
    return r ? { ...r } : null;
  }

  /** 打开 / 定位 / 取消 / 移除记录。只有 completed 的文件可打开或定位。 */
  act(action, downloadId, sessionKey) {
    const id = String(downloadId || "");
    const record = this.records.get(id);
    if (!record) return { error: "下载不存在" };
    // 跨会话键的动作一律拒绝（另一个用户不能操作本用户的下载）。
    if (String(sessionKey || "shared") !== record.sessionKey) return { error: "下载不存在" };
    const item = this.items.get(id);
    if (action === "open") {
      if (record.state !== "completed") return { error: "下载尚未完成" };
      void shell.openPath(record.savePath);
      return { ok: true };
    }
    if (action === "reveal") {
      if (record.state !== "completed") return { error: "下载尚未完成" };
      shell.showItemInFolder(record.savePath);
      return { ok: true };
    }
    if (action === "cancel") {
      if (record.state !== "progressing") return { error: "下载已结束" };
      try { item?.cancel(); } catch { /* 已结束的竞态忽略 */ }
      return { ok: true };
    }
    if (action === "remove") {
      if (record.state === "progressing") return { error: "下载进行中" };
      this.records.delete(id);
      this.items.delete(id);
      return { ok: true };
    }
    return { error: "未知动作" };
  }

  /** 清空该会话键的**已完成**记录（进行中的不动）。 */
  clear(sessionKey) {
    const key = String(sessionKey || "shared");
    let removed = 0;
    for (const [id, r] of [...this.records]) {
      if (r.sessionKey !== key || r.state === "progressing") continue;
      this.records.delete(id);
      this.items.delete(id);
      removed += 1;
    }
    return { ok: true, removed };
  }
}

module.exports = { BrowserDownloads, safeFilename, uniquePath, safeSourceURL };
