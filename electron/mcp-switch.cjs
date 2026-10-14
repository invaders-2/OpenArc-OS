/**
 * B4e · MCP 工具调用显式开关（默认关闭）。
 *
 * 为什么单独一层：D5-03 第一批把"工具调用"整体关死（electron/mcp-client.cjs:832-834
 * 恒回 MCP_TOOL_INVOCATION_NOT_ENABLED），B4d 也只交付"审批优先、可注入传输"的路径。
 * 本层把"是否允许发起 MCP 工具调用"变成一个**用户显式打开**的持久开关，
 * 默认 false；开关关闭时 mcp-agent-tools 在审批之前就 fail closed（0 次传输）。
 *
 * 落盘约定（对齐本仓既有开关写法）：
 *   · 路径 = <userData>/dxos/mcp.json —— electron/dxos-foundation-paths.cjs:17 的 DXOS_LAYOUT.files 已登记它，
 *     路径只由 resolveDxosPaths 解析，不在这里拼字符串；
 *   · 形状 = { version, updatedAt, tools: { invocationEnabled: boolean }, ...未知顶层键原样保留 }；
 *   · 默认 / 读坏 / 缺 userDataDir 一律安全的 false（fail closed），绝不静默打开；
 *   · 写入走 临时文件 + rename（与 electron/plugin-registry.cjs:456-475 同一口径）。
 *
 * 只读快照 snapshot() 不含本机路径：本机路径永不过 IPC。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { resolveDxosPaths } = require("./dxos-foundation-paths.cjs");

const STATE_VERSION = 1;
/** D5-03 旧版 mcp.json 是服务器数组（integration-dingtalk.cjs:118-132 只读迁移）；沿用同名文件。 */
const FILE_KEY = "mcp.json";
const SWITCH_UNAVAILABLE = "MCP_SWITCH_UNAVAILABLE";

function defaultState() {
  return { version: STATE_VERSION, tools: { invocationEnabled: false } };
}

/**
 * @param {object} options
 * @param {string} [options.userDataDir]  Electron userData；缺省 → 开关不可持久化（恒 false）。
 * @param {()=>number} [options.clock]
 * @param {(event:string, detail:object)=>void} [options.logger] 只记事件与原因，不记路径/内容。
 */
function createMcpSwitch({ userDataDir = null, clock = null, logger = null } = {}) {
  const now = typeof clock === "function" ? clock : () => Date.now();
  const log = typeof logger === "function" ? logger : null;
  let filePath = null;
  try {
    if (userDataDir) filePath = resolveDxosPaths(userDataDir).file[FILE_KEY] || null;
  } catch {
    filePath = null;
  }
  let rawState = null;

  function readState() {
    if (rawState) return rawState;
    rawState = defaultState();
    if (!filePath) return rawState;
    try {
      if (!fs.existsSync(filePath)) return rawState;
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      // 旧版 mcp.json 可能是服务器数组或非对象：不静默覆盖，原样留在 legacy 下，等显式写入时再落新形状。
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        rawState = { ...defaultState(), legacy: parsed };
        return rawState;
      }
      // 保留未知顶层键与 tools 下的未知键，只规范化 invocationEnabled 这一个布尔。
      if (!parsed.tools || typeof parsed.tools !== "object" || Array.isArray(parsed.tools)) parsed.tools = {};
      parsed.tools.invocationEnabled = parsed.tools.invocationEnabled === true;
      if (parsed.version == null) parsed.version = STATE_VERSION;
      rawState = parsed;
    } catch (error) {
      // 读坏不重置磁盘：内存回退默认（全关），只有显式写入才会覆盖；原因留日志。
      if (log) { try { log("mcp-switch-read-failed", { message: String((error && error.message) || error).slice(0, 200) }); } catch { /* 忽略 */ } }
      rawState = defaultState();
    }
    return rawState;
  }

  /** 唯一判据：严格 === true 才算打开。 */
  function isToolInvocationEnabled() {
    return readState().tools.invocationEnabled === true;
  }

  /** 只读快照：不含 filePath（本机路径不出主进程）。 */
  function snapshot() {
    return { enabled: isToolInvocationEnabled(), version: STATE_VERSION };
  }

  function setToolInvocationEnabled(enabled) {
    const next = enabled === true;
    if (!filePath) {
      return { ok: false, error: SWITCH_UNAVAILABLE, detail: "缺少 userDataDir：开关无法持久化", persisted: false, enabled: false };
    }
    const state = readState();
    state.version = STATE_VERSION;
    state.tools = { ...(state.tools && typeof state.tools === "object" ? state.tools : {}), invocationEnabled: next };
    state.updatedAt = now();
    const temp = filePath + "." + process.pid + "." + Date.now() + ".tmp";
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(state, null, 2), "utf8");
      fs.renameSync(temp, filePath);
      return { ok: true, enabled: next, persisted: true };
    } catch (error) {
      try { fs.rmSync(temp, { force: true }); } catch { /* 忽略 */ }
      if (log) { try { log("mcp-switch-write-failed", { message: String((error && error.message) || error).slice(0, 200) }); } catch { /* 忽略 */ } }
      return { ok: false, error: SWITCH_UNAVAILABLE, detail: "开关写入失败", persisted: false, enabled: isToolInvocationEnabled() };
    }
  }

  return { filePath, isToolInvocationEnabled, setToolInvocationEnabled, snapshot, readState };
}

module.exports = { createMcpSwitch, STATE_VERSION, FILE_KEY, SWITCH_UNAVAILABLE, defaultState };
