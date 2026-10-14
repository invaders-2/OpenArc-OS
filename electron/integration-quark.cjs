/**
 * B7d · 夸克网盘（逐函数移植 server/quark.ts:1-407）。
 *
 * 逐函数对应（源行号）：
 *   quark.ts:15-31    ROOT / CLI / WORK_DIR / DOWNLOAD_DIR / MAX_OUTPUT / CLI_HOME / CLI_CONFIG_FILE / SEARCH_HISTORY_FILE
 *   quark.ts:62-95    ensureDir / 搜索历史读写（readSearchHistoryStore / writeSearchHistoryStore /
 *                     quarkSearchHistory / quarkRecordSearch / quarkClearSearchHistory）
 *   quark.ts:97-116   quarkCliEnv（HOME/APPDATA/XDG 全部重定向进项目 data 目录）
 *   quark.ts:118-146  parseRows / lastResult / throwIfError
 *   quark.ts:148-172  runQuark（spawn node CLI，8MB stdout 上限 + 超时 kill）
 *   quark.ts:174-197  normalizeFile（BrowseFileItem → QuarkFile）
 *   quark.ts:199-210  cliHasAccount
 *   quark.ts:212-296  登录态：quarkStartLogin / quarkStopLogin / quarkStatus
 *   quark.ts:298-346  quarkSearch / quarkBrowse
 *   quark.ts:348-365  quarkDownload
 *   quark.ts:367-383  quarkUpload
 *   quark.ts:385-407  quarkLogout / quarkPaths / quarkCleanDownloads
 *
 * 与源文件的差异（任务书硬约束）：
 *   · 源 CLI 路径固定 server/vendor/quark-drive.cjs；本移植**不复制 486KB 厂商 CLI**，改为
 *     可注入 cliPath / spawnImpl（假 CLI 离线测试）；未配置且未注入即结构化不可用；
 *   · **凭据不落明文**：登录态由厂商 CLI 自己管理（access_token 落 CLI 自己的 config.json，本模块
 *     不写任何明文）；本模块只提供 quarkCredentialStatus()，读取存在性并只回掩码，绝不回传 token；
 *   · 函数名/参数/输出字段与源逐字对应；失败抛带 code 的 Error，由 plugin-service 转结构化。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const { INTEGRATION_ERR_UNAVAILABLE, INTEGRATION_ERR_INVALID_INPUT, INTEGRATION_ERR_NOT_FOUND } = require("./plugin-registry.cjs");
const { maskSecret } = require("./integration-dingtalk.cjs");

const MAX_OUTPUT = 8 * 1024 * 1024;
const CREDENTIAL_REF = "quark.credential";

const asStr = (value, max = 4096) => (typeof value === "string" ? value.slice(0, max) : value == null ? "" : String(value).slice(0, max));
function fail(code, detail) { const error = new Error(detail); error.code = code; return error; }

function createQuarkIntegration(options = {}) {
  const dataDir = options.dataDir ? String(options.dataDir) : null;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const cliPath = options.cliPath ? String(options.cliPath) : null;
  const nodePath = options.nodePath ? String(options.nodePath) : process.execPath;
  const spawnImpl = typeof options.spawnImpl === "function" ? options.spawnImpl : null;
  const spawnLoginImpl = typeof options.spawnLoginImpl === "function" ? options.spawnLoginImpl : null;
  const credentials = options.credentials && typeof options.credentials === "object" ? options.credentials : null;

  const workDir = options.workDir ? String(options.workDir) : (dataDir ? path.join(dataDir, "quark") : path.join(os.tmpdir(), "dxos-quark"));
  const downloadDir = options.downloadDir ? String(options.downloadDir) : path.join(os.tmpdir(), "DXOS", "quark-downloads");
  const cliHome = path.join(workDir, "cli-home");
  const cliConfigFile = path.join(cliHome, "claudecode", "config.json");
  const searchHistoryFile = path.join(workDir, "search-history.json");
  const loginDebugFile = path.join(workDir, "login-debug.log");

  let loginProc = null;
  let loginAuthUrl = "";
  let loginLastExit = null;

  function cliAvailable() { return typeof spawnImpl === "function" || (!!cliPath && fs.existsSync(cliPath)); }

  function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

  // quark.ts:66-95
  function readSearchHistoryStore() {
    try {
      const parsed = JSON.parse(fs.readFileSync(searchHistoryFile, "utf8"));
      return Object.fromEntries(Object.entries(parsed).map(([userId, entries]) => [userId, Array.isArray(entries) ? entries.map(String).filter(Boolean).slice(0, 12) : []]));
    } catch { return {}; }
  }
  function writeSearchHistoryStore(store) {
    ensureDir(workDir);
    fs.writeFileSync(searchHistoryFile, JSON.stringify(store, null, 2) + "\n", "utf8");
  }
  function quarkSearchHistory(userId) { return readSearchHistoryStore()[userId] || []; }
  function quarkRecordSearch(userId, query) {
    const value = String(query || "").trim().slice(0, 80);
    if (!value) return quarkSearchHistory(userId);
    const store = readSearchHistoryStore();
    store[userId] = [value, ...(store[userId] || []).filter((item) => item !== value)].slice(0, 12);
    writeSearchHistoryStore(store);
    return store[userId];
  }
  function quarkClearSearchHistory(userId) {
    const store = readSearchHistoryStore();
    delete store[userId];
    writeSearchHistoryStore(store);
  }

  // quark.ts:100-116
  function quarkCliEnv() {
    const home = path.join(workDir, "home");
    return Object.assign({}, process.env, {
      CLAUDECODE: "1",
      QUARK_DRIVE_HOME: cliHome,
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(workDir, "appdata"),
      LOCALAPPDATA: path.join(workDir, "localappdata"),
      XDG_CONFIG_HOME: path.join(workDir, "config"),
      XDG_CACHE_HOME: path.join(workDir, "cache"),
      XDG_DATA_HOME: path.join(workDir, "data"),
    });
  }

  // quark.ts:118-146
  function parseRows(stdout) {
    const rows = [];
    for (const line of String(stdout || "").split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;
      try {
        const obj = JSON.parse(text);
        if (obj && typeof obj === "object") rows.push(obj);
      } catch { /* 非 JSON 行跳过 */ }
    }
    return rows;
  }
  function lastResult(rows) { return [...rows].reverse().find((row) => row.type === "result") || null; }
  function throwIfError(rows, exitCode, stderr) {
    const result = lastResult(rows);
    if (result && typeof result.code === "number" && result.code !== 0) {
      throw new Error((result.msg || "夸克网盘操作失败") + (result.code ? "（错误码 " + result.code + "）" : ""));
    }
    if (!rows.length && exitCode !== 0) {
      throw new Error((String(stderr || "").trim() || ("命令失败（exit " + exitCode + "）")).slice(0, 600));
    }
  }

  // quark.ts:148-172：注入 spawnImpl 优先；否则真实 spawn node CLI
  function runQuark(args, opts = {}) {
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 120000;
    const cwd = opts.cwd ? String(opts.cwd) : workDir;
    ensureDir(cwd);
    if (typeof spawnImpl === "function") return Promise.resolve(spawnImpl(args, { timeoutMs, cwd, env: quarkCliEnv() }));
    if (!cliAvailable()) return Promise.reject(fail(INTEGRATION_ERR_UNAVAILABLE, "未配置夸克官方 CLI（quark-drive.cjs）路径，且未注入 spawnImpl；本移植不复制厂商 486KB CLI，请配置后重试"));
    return new Promise((resolve, reject) => {
      const child = spawn(nodePath, [cliPath, ...args], { cwd, windowsHide: true, env: quarkCliEnv() });
      let stdout = "";
      let stderr = "";
      let done = false;
      child.stdout.on("data", (chunk) => { if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk) => { if (stderr.length < 256000) stderr += chunk.toString("utf8"); });
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { child.kill(); } catch { /* 忽略 */ }
        reject(new Error("夸克网盘操作超时（" + Math.round(timeoutMs / 1000) + "s）"));
      }, timeoutMs);
      child.once("error", (error) => { if (!done) { done = true; clearTimeout(timer); reject(error); } });
      child.once("close", (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ rows: parseRows(stdout), exitCode: code == null ? 1 : code, stdout, stderr });
      });
    });
  }

  // quark.ts:174-197
  function normalizeFile(raw) {
    const category = Number(raw.category != null ? raw.category : (raw.obj_category != null ? raw.obj_category : -1));
    const includeItems = Number(raw.includeItems != null ? raw.includeItems : (raw.include_items != null ? raw.include_items : 0));
    const isDir = raw.dir === true || raw.is_dir === true || raw.f_type === 0 || category === 0 || String(raw.obj_category || "") === "文件夹";
    return {
      fid: String(raw.fid != null ? raw.fid : (raw.file_id != null ? raw.file_id : (raw.fileId != null ? raw.fileId : (raw.id != null ? raw.id : "")))),
      filename: String(raw.filename != null ? raw.filename : (raw.file_name != null ? raw.file_name : (raw.name != null ? raw.name : "未命名"))),
      size: raw.size != null ? Number(raw.size) : undefined,
      includeItems: includeItems > 0 ? includeItems : undefined,
      category: Number.isFinite(category) && category >= 0 ? category : undefined,
      objCategory: raw.obj_category ? String(raw.obj_category) : undefined,
      updatedAt: raw.updated_at != null ? Number(raw.updated_at) : undefined,
      bigThumbnail: raw.big_thumbnail ? String(raw.big_thumbnail) : undefined,
      pdirFid: raw.pdir_fid != null ? String(raw.pdir_fid) : undefined,
      isDir,
      checkLink: raw.check_link ? String(raw.check_link) : undefined,
    };
  }

  // quark.ts:199-210
  function cliHasAccount() {
    try {
      const config = JSON.parse(fs.readFileSync(cliConfigFile, "utf8"));
      if (typeof config.currentUserId === "string" && config.currentUserId) return true;
      if (config.accounts && typeof config.accounts === "object" && Object.keys(config.accounts).length > 0) return true;
      if (typeof config.access_token === "string" && config.access_token) return true;
      return false;
    } catch { return false; }
  }

  // quark.ts:218-224
  function logLoginDebug(line) {
    try {
      ensureDir(workDir);
      if (!fs.existsSync(loginDebugFile) || fs.statSync(loginDebugFile).size > 1024 * 1024) fs.rmSync(loginDebugFile, { force: true });
      fs.appendFileSync(loginDebugFile, "[" + new Date().toISOString() + "] " + line + "\n");
    } catch { /* 忽略 */ }
  }

  // quark.ts:231-264
  function quarkStartLogin() {
    if (loginProc && loginProc.exitCode == null) return { started: true, alreadyRunning: true };
    if (!cliAvailable() && typeof spawnLoginImpl !== "function") throw fail(INTEGRATION_ERR_UNAVAILABLE, "未配置夸克官方 CLI（quark-drive.cjs）路径，无法启动登录");
    ensureDir(workDir);
    loginAuthUrl = "";
    loginLastExit = null;
    if (typeof spawnLoginImpl === "function") {
      loginProc = spawnLoginImpl({ args: ["login", "--verbose"], cwd: workDir, env: quarkCliEnv() });
      return { started: true };
    }
    const child = spawn(nodePath, [cliPath, "login", "--verbose"], {
      cwd: workDir, windowsHide: true, detached: true, stdio: ["ignore", "ignore", "pipe"], env: quarkCliEnv(),
    });
    child.unref();
    logLoginDebug("spawned pid=" + child.pid + " exe=" + nodePath + " cli=" + cliPath);
    let stderrBuf = "";
    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
      if (stderrBuf.length > 512000) stderrBuf = stderrBuf.slice(-64000);
      if (!loginAuthUrl) {
        const matched = stderrBuf.match(/"authorize_page_url":"([^"]+)"/);
        if (matched && matched[1]) loginAuthUrl = matched[1];
      }
    });
    child.on("error", (error) => {
      loginLastExit = { code: null, signal: null, stderr: "spawn error: " + error.message, at: new Date().toISOString() };
      logLoginDebug("child ERROR: " + error.message);
    });
    child.on("exit", (code, signal) => {
      loginLastExit = { code, signal, stderr: stderrBuf.slice(-1200), at: new Date().toISOString() };
      logLoginDebug("child EXIT code=" + code + " signal=" + signal + " stderr=" + JSON.stringify(stderrBuf.slice(-400)));
    });
    loginProc = child;
    return { started: true };
  }
  function quarkStopLogin() {
    if (loginProc && loginProc.exitCode == null) { try { loginProc.kill(); } catch { /* 忽略 */ } }
    loginProc = null;
    loginAuthUrl = "";
  }

  // quark.ts:274-296
  async function quarkStatus() {
    const pending = !!(loginProc && loginProc.exitCode == null);
    try {
      const { rows } = await runQuark(["get-user-info"], { timeoutMs: 30000 });
      const result = lastResult(rows);
      if (result && result.code === 0) {
        const data = result.data || {};
        const info = data.userInfo || {};
        const user = {
          nickname: String(info.nickname != null ? info.nickname : (data.nickname != null ? data.nickname : (data.user_name != null ? data.user_name : (data.userName != null ? data.userName : (data.name != null ? data.name : ""))))),
          userId: String(info.userId != null ? info.userId : (info.user_id != null ? info.user_id : (data.userId != null ? data.userId : (data.user_id != null ? data.user_id : "")))),
        };
        if (pending) quarkStopLogin();
        loginAuthUrl = "";
        return { loggedIn: true, user };
      }
      if (cliHasAccount()) return { loggedIn: true, user: {}, authUrl: loginAuthUrl || undefined };
      return { loggedIn: false, loginPending: pending, authUrl: loginAuthUrl || undefined, loginPid: loginProc && loginProc.pid, loginExit: loginLastExit };
    } catch (error) {
      if (error && error.code === INTEGRATION_ERR_UNAVAILABLE) throw error;
      if (cliHasAccount()) return { loggedIn: true, user: {} };
      return { loggedIn: false, error: String((error && error.message) || error), loginPending: pending, authUrl: loginAuthUrl || undefined, loginPid: loginProc && loginProc.pid, loginExit: loginLastExit };
    }
  }

  // quark.ts:299-329
  async function quarkSearch(q, category) {
    const keyword = String(q || "").trim().slice(0, 50);
    if (!keyword) throw fail(INTEGRATION_ERR_INVALID_INPUT, "请输入搜索关键词");
    const args = ["search", "--keyword", keyword, "--size", "100", "--stdout-only"];
    if (category != null && Number.isInteger(category) && category >= 0 && category <= 8) args.push("--category", String(category));
    const { rows, exitCode, stderr } = await runQuark(args, { timeoutMs: 60000 });
    throwIfError(rows, exitCode, stderr);
    const result = lastResult(rows);
    const data = (result && result.data) || {};
    let files = [];
    if (Array.isArray(data.file_list)) files = data.file_list.map(normalizeFile);
    files = files.concat(rows.filter((row) => row.type === "list").map((row) => row.data).filter((d) => !!d).map(normalizeFile));
    const artifact = rows.find((row) => row.type === "artifact");
    const artifactPath = artifact && artifact.data && artifact.data.file_path;
    if (artifactPath && typeof artifactPath === "string" && fs.existsSync(artifactPath)) {
      try {
        const all = fs.readFileSync(artifactPath, "utf8").split(/\r?\n/).filter(Boolean)
          .map((line) => { try { return normalizeFile(JSON.parse(line)); } catch { return null; } })
          .filter((item) => !!item);
        if (all.length) files = all;
      } catch { /* 读 artifact 失败则沿用预览 */ }
    }
    const total = Number(data.total != null ? data.total : ((artifact && artifact.data && artifact.data.count) != null ? artifact.data.count : files.length));
    return { files, total, checkAllLink: data.check_all_link ? String(data.check_all_link) : undefined };
  }

  // quark.ts:332-346
  async function quarkBrowse(pdirFid = "0") {
    try {
      const { rows, exitCode, stderr } = await runQuark(["browse", "--pdir-fid", String(pdirFid)], { timeoutMs: 60000 });
      throwIfError(rows, exitCode, stderr);
      const files = rows.filter((row) => row.type === "list").map((row) => row.data).filter((d) => !!d).map(normalizeFile);
      return { mode: "browse", files };
    } catch (error) {
      const message = String((error && error.message) || error);
      if (/browse|浏览器实例|不存在|Unknown command|unknown command|unrecognized|not found/i.test(message)) {
        return { mode: "search", unsupported: true, files: [] };
      }
      throw error;
    }
  }

  // quark.ts:349-365
  async function quarkDownload(fid, outDir) {
    ensureDir(outDir);
    const { rows, exitCode, stderr } = await runQuark(["download", "--fid", String(fid), "--output-dir", outDir, "--overwrite"], { timeoutMs: 5 * 60000 });
    throwIfError(rows, exitCode, stderr);
    const entries = fs.readdirSync(outDir).map((name) => {
      const abs = path.join(outDir, name);
      return { name, abs, mtime: fs.statSync(abs).mtimeMs };
    });
    entries.sort((a, b) => b.mtime - a.mtime);
    const newest = entries[0];
    if (!newest) throw fail(INTEGRATION_ERR_NOT_FOUND, "下载完成但未找到输出文件");
    return newest.abs;
  }

  // quark.ts:368-383
  async function quarkUpload(parentFid, filePath) {
    const args = ["upload", filePath];
    if (parentFid != null && String(parentFid).trim() !== "" && String(parentFid) !== "0") args.push("--parent-fid", String(parentFid).trim());
    const { rows, exitCode, stderr } = await runQuark(args, { timeoutMs: 10 * 60000 });
    throwIfError(rows, exitCode, stderr);
    const result = lastResult(rows);
    const data = (result && result.data) || {};
    return {
      fids: Array.isArray(data.fids) ? data.fids : [],
      fileNames: Array.isArray(data.fileNames) ? data.fileNames : [],
      successCount: Number(data.successCount != null ? data.successCount : 0),
      fileCount: Number(data.fileCount != null ? data.fileCount : 0),
    };
  }

  // quark.ts:386-392
  async function quarkLogout() {
    quarkStopLogin();
    try {
      const { rows, exitCode, stderr } = await runQuark(["unauthorize"], { timeoutMs: 30000 });
      throwIfError(rows, exitCode, stderr);
    } catch { /* 已失效时忽略 */ }
  }

  // quark.ts:395-407
  const quarkPaths = { workDir, downloadDir };
  function quarkCleanDownloads(olderThanMs = 24 * 60 * 60 * 1000) {
    try {
      if (!fs.existsSync(downloadDir)) return;
      const now = clock();
      for (const name of fs.readdirSync(downloadDir)) {
        const abs = path.join(downloadDir, name);
        try { if (fs.statSync(abs).mtimeMs < now - olderThanMs) fs.rmSync(abs, { recursive: true, force: true }); } catch { /* 忽略 */ }
      }
    } catch { /* 忽略 */ }
  }

  /** 凭据投影：绝不回传 token，只回存在性与掩码（登录态由厂商 CLI 自己持有）。 */
  function quarkCredentialStatus() {
    let tokenSet = false, tokenMask = "", configPresent = false, currentUserId = "";
    try {
      const config = JSON.parse(fs.readFileSync(cliConfigFile, "utf8"));
      configPresent = true;
      currentUserId = asStr(config.currentUserId, 200);
      const token = asStr(config.access_token, 4096);
      tokenSet = !!token;
      tokenMask = maskSecret(token);
    } catch { /* 未登录/无配置 */ }
    return {
      ref: CREDENTIAL_REF,
      configFile: cliConfigFile,
      configPresent,
      currentUserId,
      tokenSet,
      tokenMask,
      loggedIn: cliHasAccount(),
      safeStorageAvailable: !!credentials && typeof credentials.available === "function" && credentials.available() === true,
    };
  }

  function status() {
    return { cliConfigured: !!cliPath, cliExists: !!cliPath && fs.existsSync(cliPath), spawnInjected: typeof spawnImpl === "function", workDir, downloadDir, searchHistoryEntries: Object.keys(readSearchHistoryStore()).length };
  }

  return {
    cliPath, workDir, downloadDir, cliConfigFile, searchHistoryFile, quarkPaths,
    cliAvailable, normalizeFile, parseRows, lastResult, throwIfError, cliHasAccount,
    quarkCliEnv, runQuark,
    quarkSearchHistory, quarkRecordSearch, quarkClearSearchHistory,
    quarkStartLogin, quarkStopLogin, quarkStatus,
    quarkSearch, quarkBrowse, quarkDownload, quarkUpload, quarkLogout,
    quarkCleanDownloads, quarkCredentialStatus,
    status,
  };
}

module.exports = { createQuarkIntegration, CREDENTIAL_REF, MAX_OUTPUT };
