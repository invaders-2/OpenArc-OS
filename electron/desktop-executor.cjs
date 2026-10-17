"use strict";
/**
 * B7j+ · 桌面执行端（automation 的 music_play / music_control / open_app）。
 *
 * 边界：
 *   · 只通过**受控系统 API** 执行：打开应用走 Electron 的 shell.openPath（绝对路径由白名单给出，
 *     不接受任意命令 / URL / 用户拼接的 shell 字符串）；音乐走固定 AppleScript（osascript +
 *     execFile，参数经 argv 传入、不拼进脚本），没有 shell 解释器。
 *   · 应用必须命中显式白名单（id / name / alias，大小写不敏感）。未知应用一律结构化拒绝。
 *   · 参数全部校验：缺失 / 类型不对 / 超长 / 控制字符一律 DESKTOP_INVALID_INPUT；
 *     shell / 音乐控制器未注入一律 DESKTOP_UNAVAILABLE（不伪造成功）。
 *   · 返回值是给人看的结果文本；automation-service 会把它写进运行记录。
 *
 * 依赖注入（production = main.cjs；tests = 假 shell / 假音乐控制器）：
 *   · shell: Electron shell（只用到 openPath）
 *   · apps: [{ id, name?, aliases?, path }] 绝对路径白名单
 *   · musicController: { play({ query, shuffle }) , control({ action }) }（可选；缺失 = 不可用）
 */
const path = require("node:path");
const { execFile: defaultExecFile } = require("node:child_process");

const DESKTOP_ERR_INVALID_INPUT = "DESKTOP_INVALID_INPUT";
const DESKTOP_ERR_APP_NOT_ALLOWED = "DESKTOP_APP_NOT_ALLOWED";
const DESKTOP_ERR_UNAVAILABLE = "DESKTOP_UNAVAILABLE";
const DESKTOP_ERR_EXECUTION_FAILED = "DESKTOP_EXECUTION_FAILED";
const DESKTOP_ERR_NOT_FOUND = "DESKTOP_NOT_FOUND";

const MUSIC_ACTIONS = Object.freeze(["pause", "resume", "next", "prev", "stop"]);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const asRecord = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : null);

function desktopError(code, message, detail) {
  const error = new Error(String(message || code));
  error.name = "DesktopExecutorError";
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function invalidInput(message, detail) {
  return desktopError(DESKTOP_ERR_INVALID_INPUT, message, detail);
}

function unavailable(dependency) {
  return desktopError(DESKTOP_ERR_UNAVAILABLE, "桌面执行端不可用：" + dependency, { dependency });
}

/** 用户输入文本：trim 后非空、长度受限、无控制字符。 */
function requiredText(value, field, maxLength) {
  if (typeof value !== "string") throw invalidInput("参数「" + field + "」必须是字符串", { field });
  const text = value.trim();
  if (!text) throw invalidInput("参数「" + field + "」不能为空", { field });
  if (text.length > maxLength) throw invalidInput("参数「" + field + "」长度不能超过 " + maxLength, { field });
  if (CONTROL_CHARS.test(text)) throw invalidInput("参数「" + field + "」包含非法控制字符", { field });
  return text;
}

/** 白名单注册表：id / name / alias 都能命中，重复键直接报错（避免执行到不确定的目标）。 */
function buildAppIndex(apps) {
  const index = new Map();
  const register = (key, entry) => {
    const normalized = String(key || "").trim().toLowerCase();
    if (!normalized) return;
    if (index.has(normalized) && index.get(normalized) !== entry) {
      throw invalidInput("桌面应用白名单键重复：" + normalized, { app: normalized });
    }
    index.set(normalized, entry);
  };
  const list = [];
  for (const raw of Array.isArray(apps) ? apps : []) {
    const entry = asRecord(raw);
    if (!entry) throw invalidInput("桌面应用白名单项必须是对象");
    const id = String(entry.id || "").trim();
    const target = String(entry.path || "").trim();
    if (!id) throw invalidInput("桌面应用白名单项缺少 id");
    if (!target || !path.isAbsolute(target)) throw invalidInput("桌面应用白名单路径必须是绝对路径", { app: id });
    const app = Object.freeze({ id, name: String(entry.name || id).trim() || id, path: target, aliases: Array.isArray(entry.aliases) ? entry.aliases.map(String) : [] });
    list.push(app);
    register(app.id, app);
    register(app.name, app);
    for (const alias of app.aliases) register(alias, app);
  }
  return { list, lookup: (value) => index.get(String(value || "").trim().toLowerCase()) || null };
}

function createDesktopExecutor({ shell = null, apps = [], musicController = null } = {}) {
  const registry = buildAppIndex(apps);

  function requireShell() {
    if (!shell || typeof shell.openPath !== "function") throw unavailable("shell.openPath");
    return shell;
  }

  async function openPath(target, label) {
    const shellApi = requireShell();
    let result;
    try {
      result = await shellApi.openPath(target);
    } catch (error) {
      throw desktopError(DESKTOP_ERR_EXECUTION_FAILED, "打开「" + label + "」失败：" + String((error && error.message) || error).slice(0, 300), {
        app: label, causeCode: error && typeof error.code === "string" ? error.code : undefined,
      });
    }
    if (typeof result === "string" && result.trim()) {
      throw desktopError(DESKTOP_ERR_EXECUTION_FAILED, "打开「" + label + "」失败：" + result.trim().slice(0, 300), { app: label });
    }
    return "已打开「" + label + "」";
  }

  async function openApp(rawArgs) {
    const args = asRecord(rawArgs) || {};
    const appText = requiredText(args.app, "app", 120);
    const app = registry.lookup(appText);
    if (!app) throw desktopError(DESKTOP_ERR_APP_NOT_ALLOWED, "应用不在桌面白名单内：" + appText, { app: appText });
    return openPath(app.path, app.name);
  }

  function requireMusic() {
    if (!musicController || typeof musicController.play !== "function" || typeof musicController.control !== "function") {
      throw unavailable("musicController");
    }
    return musicController;
  }

  async function musicPlay(rawArgs) {
    const args = asRecord(rawArgs) || {};
    let query = "";
    if (args.query !== undefined && args.query !== null) {
      if (typeof args.query !== "string") throw invalidInput("参数「query」必须是字符串", { field: "query" });
      query = args.query.trim();
      if (query.length > 200) throw invalidInput("参数「query」长度不能超过 200", { field: "query" });
      if (CONTROL_CHARS.test(query)) throw invalidInput("参数「query」包含非法控制字符", { field: "query" });
    }
    if (args.shuffle !== undefined && typeof args.shuffle !== "boolean") throw invalidInput("参数「shuffle」必须是布尔值", { field: "shuffle" });
    const controller = requireMusic();
    const result = await callMusic(controller.play.bind(controller), { query, shuffle: args.shuffle === true });
    return normalizeMusicResult(result, query ? "已开始播放，匹配：" + query : "已继续播放音乐");
  }

  async function musicControl(rawArgs) {
    const args = asRecord(rawArgs) || {};
    const action = requiredText(args.action, "action", 16).toLowerCase();
    if (!MUSIC_ACTIONS.includes(action)) throw invalidInput("不支持的音乐控制动作：" + action, { action, allowed: [...MUSIC_ACTIONS] });
    const controller = requireMusic();
    const result = await callMusic(controller.control.bind(controller), { action });
    return normalizeMusicResult(result, "音乐控制已执行：" + action);
  }

  async function callMusic(fn, payload) {
    try {
      return await fn(payload);
    } catch (error) {
      if (error && typeof error.code === "string" && error.code.startsWith("DESKTOP_")) throw error;
      throw desktopError(DESKTOP_ERR_EXECUTION_FAILED, String((error && error.message) || error || "音乐执行失败").slice(0, 300), {
        causeCode: error && typeof error.code === "string" ? error.code : undefined,
      });
    }
  }

  function normalizeMusicResult(result, fallback) {
    if (typeof result === "string" && result.trim()) return result.trim();
    const record = asRecord(result);
    if (record && typeof record.text === "string" && record.text.trim()) return record.text.trim();
    return fallback;
  }

  return Object.freeze({ openApp, musicPlay, musicControl });
}

/** 受控系统 API 的绝对路径（main.cjs 用它构造白名单，测试不需要）。 */
const MAC_SYSTEM_APPS = Object.freeze([
  { id: "music", name: "音乐", aliases: ["音乐", "music"], path: "/System/Applications/Music.app" },
  { id: "finder", name: "访达", aliases: ["访达", "finder", "files"], path: "/System/Library/CoreServices/Finder.app" },
  { id: "calendar", name: "日历", aliases: ["日历", "calendar"], path: "/System/Applications/Calendar.app" },
  { id: "notes", name: "备忘录", aliases: ["备忘录", "notes"], path: "/System/Applications/Notes.app" },
  { id: "photos", name: "照片", aliases: ["照片", "photos"], path: "/System/Applications/Photos.app" },
  { id: "settings", name: "系统设置", aliases: ["系统设置", "settings"], path: "/System/Applications/System Settings.app" },
  { id: "safari", name: "Safari", aliases: ["safari", "浏览器", "browser"], path: "/Applications/Safari.app" },
]);

/**
 * 音乐控制器 = 固定 AppleScript（没有 shell、没有字符串拼接）：
 *   · play：argv[0] 歌名/歌手关键词；空串 = 继续播放；命中歌名 > 命中歌手；没有命中返回 no-match。
 *   · control：固定枚举 pause/resume/next/prev/stop。
 * 只支持 macOS；非 darwin 由调用方不注入（music 动作结构化不可用）。
 */
const MUSIC_PLAY_SCRIPT = [
  "on run argv",
  "  set q to item 1 of argv",
  '  tell application "Music"',
  '    if q is "" then',
  "      play",
  '      return "resumed"',
  "    end if",
  "    set hits to (every track of library playlist 1 whose name contains q)",
  "    if (count of hits) is 0 then",
  "      set hits to (every track of library playlist 1 whose artist contains q)",
  "    end if",
  '    if (count of hits) is 0 then return "no-match"',
  "    play item 1 of hits",
  '    return "playing:" & (name of item 1 of hits as text) & " - " & (artist of item 1 of hits as text)',
  "  end tell",
  "end run",
].join("\n");

const MUSIC_CONTROL_SCRIPT = [
  "on run argv",
  "  set act to item 2 of argv",
  '  tell application "Music"',
  "    if act is \"pause\" then",
  "      pause",
  "    else if act is \"resume\" then",
  "      play",
  "    else if act is \"next\" then",
  "      next track",
  "    else if act is \"prev\" then",
  "      previous track",
  "    else if act is \"stop\" then",
  "      stop",
  "    else",
  '      return "invalid-action"',
  "    end if",
  "  end tell",
  '  return "ok:" & act',
  "end run",
].join("\n");

function createSystemMusicController({ execFile = defaultExecFile, platform = process.platform, timeoutMs = 8000 } = {}) {
  if (platform !== "darwin") return null;
  if (typeof execFile !== "function") throw unavailable("execFile");

  function runScript(script, argv) {
    return new Promise((resolve, reject) => {
      execFile("/usr/bin/osascript", ["-e", script, ...argv], { timeout: timeoutMs, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          const reason = String((stderr && String(stderr).trim()) || error.message || error).slice(0, 300);
          reject(desktopError(DESKTOP_ERR_EXECUTION_FAILED, "系统音乐控制失败：" + reason, { causeCode: error.code || null }));
          return;
        }
        resolve(String(stdout || "").trim());
      });
    });
  }

  const labelOf = { pause: "已暂停音乐", resume: "已继续播放音乐", next: "已切到下一首", prev: "已切到上一首", stop: "已停止播放" };

  // 随机播放无法由固定脚本安全设置（不同 macOS 版本属性名不同）：接受参数但不谎称已开启。
  const withShuffleNote = (text, shuffle) => (shuffle ? text + "（随机播放需在音乐应用中开启）" : text);

  return Object.freeze({
    async play({ query = "", shuffle = false } = {}) {
      const output = await runScript(MUSIC_PLAY_SCRIPT, [String(query || "")]);
      if (output === "no-match") throw desktopError(DESKTOP_ERR_NOT_FOUND, "没有找到匹配的音乐：" + String(query || ""), { query: String(query || "") });
      if (output === "resumed") return withShuffleNote("已继续播放音乐", shuffle === true);
      if (output.startsWith("playing:")) return withShuffleNote("正在播放：" + output.slice("playing:".length).trim(), shuffle === true);
      return withShuffleNote("已开始播放音乐", shuffle === true);
    },
    async control({ action } = {}) {
      const output = await runScript(MUSIC_CONTROL_SCRIPT, ["", String(action || "")]);
      if (output === "invalid-action") throw invalidInput("不支持的音乐控制动作：" + String(action || ""), { action: String(action || "") });
      return labelOf[action] || "音乐控制已执行：" + String(action || "");
    },
  });
}

module.exports = {
  DESKTOP_ERR_INVALID_INPUT,
  DESKTOP_ERR_APP_NOT_ALLOWED,
  DESKTOP_ERR_UNAVAILABLE,
  DESKTOP_ERR_EXECUTION_FAILED,
  DESKTOP_ERR_NOT_FOUND,
  MUSIC_ACTIONS,
  MAC_SYSTEM_APPS,
  createDesktopExecutor,
  createSystemMusicController,
};
