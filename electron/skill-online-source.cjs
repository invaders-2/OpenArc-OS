"use strict";
/**
 * task-36 D09 · ModelScope 在线技能来源配置（查询/设置），不新增 IPC 命令。
 * 文件：<userData>/dxos/skill-packs/online-source.json；默认 disabled、无来源。
 * 只保存来源元数据，不保存 token；安装仍必须显式注入 onlineInstaller。
 */
const fs = require("node:fs");
const path = require("node:path");
const { resolveDxosPaths } = require("./dxos-foundation-paths.cjs");

const FILE_NAME = "online-source.json";
const VERSION = 1;
const MAX_SOURCE_LENGTH = 12000;

function sourceFile(userDataDir) {
  const root = userDataDir ? resolveDxosPaths(userDataDir).root : null;
  return root ? path.join(root, "skill-packs", FILE_NAME) : null;
}

function normalizeSource(value) {
  const raw = String(value == null ? "" : value).trim();
  if (raw.length > MAX_SOURCE_LENGTH) throw new Error("在线来源过长");
  if (!raw) return "";
  if (!/(?:https:\/\/(?:www\.)?modelscope\.cn\/(?:collections|skills)\/|npx\s+skills\s+add|\bmodelscope\s+download\b)/i.test(raw)) {
    throw new Error("在线来源必须是 ModelScope skill/collection 地址或 npx skills add 命令");
  }
  return raw;
}

function createOnlineSourceConfig({ userDataDir = null } = {}) {
  const file = sourceFile(userDataDir);
  function read() {
    if (!file) return { version: VERSION, enabled: false, source: "", updatedAt: 0 };
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return {
        version: VERSION,
        enabled: parsed.enabled === true,
        source: typeof parsed.source === "string" ? parsed.source.slice(0, MAX_SOURCE_LENGTH) : "",
        updatedAt: Number(parsed.updatedAt) || 0,
      };
    } catch { return { version: VERSION, enabled: false, source: "", updatedAt: 0 }; }
  }
  function write(next) {
    if (!file) throw new Error("缺少 userDataDir，无法持久化在线来源");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + "." + process.pid + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(temporary, file);
    return next;
  }
  function get() { return read(); }
  function set({ enabled = false, source = "" } = {}) {
    const next = { version: VERSION, enabled: enabled === true, source: normalizeSource(source), updatedAt: Date.now() };
    if (next.enabled && !next.source) throw new Error("启用在线来源前必须设置 ModelScope 来源");
    return write(next);
  }
  function clear() { return write({ version: VERSION, enabled: false, source: "", updatedAt: Date.now() }); }
  return { get, set, clear, file };
}

module.exports = { createOnlineSourceConfig, normalizeSource, FILE_NAME };
