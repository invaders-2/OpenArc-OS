"use strict";
/**
 * 对话列表的个人整理：重命名、置顶、从列表删除（隐藏）。
 *
 * 任务本身（步骤、产物、审计）不动 —— 这里只记每个用户自己的显示偏好，存在 userData/chat-prefs.json。
 * 「删除」= 从对话列表移除；任务记录和审计照常保留（治理要求可追溯）。
 */
const fs = require("node:fs");
const path = require("node:path");

const MAX_TITLE = 80;
const MAX_ITEMS = 5000;
const ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;

function createChatPrefs({ file } = {}) {
  let cache = null;
  const load = () => {
    if (cache) return cache;
    try { cache = JSON.parse(fs.readFileSync(file, "utf8")); } catch { cache = {}; }
    if (!cache || typeof cache !== "object" || Array.isArray(cache)) cache = {};
    return cache;
  };
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(cache));
      fs.renameSync(tmp, file);
    } catch { /* 偏好写不进去不影响对话 */ }
  };
  const mine = (userId) => {
    const all = load();
    const key = String(userId || "");
    if (!all[key] || typeof all[key] !== "object") all[key] = { titles: {}, pinned: [], hidden: [] };
    const p = all[key];
    if (!p.titles || typeof p.titles !== "object") p.titles = {};
    if (!Array.isArray(p.pinned)) p.pinned = [];
    if (!Array.isArray(p.hidden)) p.hidden = [];
    return p;
  };

  function get({ userId } = {}) {
    if (!userId) return { ok: false, error: "TASK_FORBIDDEN" };
    const p = mine(userId);
    return { ok: true, titles: { ...p.titles }, pinned: [...p.pinned], hidden: [...p.hidden] };
  }

  /** action: rename（title 为空 = 恢复原标题）/ pin / unpin / hide / unhide */
  function update({ userId, taskId, action, title = "" } = {}) {
    if (!userId) return { ok: false, error: "TASK_FORBIDDEN" };
    const id = String(taskId || "");
    if (!ID_RE.test(id)) return { ok: false, error: "INVALID_INPUT" };
    const p = mine(userId);
    const drop = (list) => list.filter((x) => x !== id);
    switch (String(action || "")) {
      case "rename": {
        const t = String(title || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, MAX_TITLE);
        if (t) p.titles[id] = t; else delete p.titles[id];
        break;
      }
      case "pin": p.pinned = [id, ...drop(p.pinned)].slice(0, 50); break;
      case "unpin": p.pinned = drop(p.pinned); break;
      case "hide": p.hidden = [id, ...drop(p.hidden)].slice(0, MAX_ITEMS); p.pinned = drop(p.pinned); break;
      case "unhide": p.hidden = drop(p.hidden); break;
      default: return { ok: false, error: "INVALID_INPUT" };
    }
    save();
    return get({ userId });
  }

  return { get, update };
}

module.exports = { createChatPrefs };
