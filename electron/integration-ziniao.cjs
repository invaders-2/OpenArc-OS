/**
 * B7d · 紫鸟下载作业（逐函数移植 server/ziniaoDownloadJobs.ts:1-188）+
 *       紫鸟 VC 文件列举（server/lingxingLocalData.ts:275-315）。
 *
 * 逐函数对应（源行号）：
 *   ziniaoDownloadJobs.ts:17-25    STORE_PATH / LEGACY / CONTROL / 常量
 *   ziniaoDownloadJobs.ts:27-61    isTerminal / activeJob / loadJobs / persistJobs / saveJob /
 *                                  clearRetry / scheduleRetry / writeControl
 *   ziniaoDownloadJobs.ts:62-72    toolErrorEntries / conciseError / waitWhilePaused
 *   ziniaoDownloadJobs.ts:74-139   runJob（start_client → 逐店铺 download_vc_summary；限流冷却/停止）
 *   ziniaoDownloadJobs.ts:141-153  listZiniaoDownloadJobs / getZiniaoDownloadJob / startZiniaoDownloadJob
 *   ziniaoDownloadJobs.ts:154-166  controlZiniaoDownloadJob
 *   ziniaoDownloadJobs.ts:167-174  deleteZiniaoDownloadJobs
 *   ziniaoDownloadJobs.ts:175-188  recoverZiniaoDownloadJob
 *   lingxingLocalData.ts:275-315   ziniaoOutputRoot / describeVcFile / listZiniaoVcFiles
 *   lingxingLocalData.ts:267-436 / 1188-1248
 *                                  importZiniaoVcFile / ziniaoVcRows / queryZiniaoVcData
 *                                  已落地到 integration-lingxing-local-data.cjs（同一张 lingxing 本地库），
 *                                  本模块只提供 ziniaoOutputRoot 让导入定位紫鸟保存目录；
 *                                  integration/ziniao/vc/import|rows|query 命令据此分发。
 *
 * 与源文件的差异（任务书硬约束）：
 *   · 源 MCP 调用直接 callDirect('ziniao', ...)；本移植改为**注入 transport(serverId, tool, args)**，
 *     未注入即结构化不可用（INTEGRATION_UNAVAILABLE），绝不假下载；
 *   · 源落 DATA_ROOT；本移植落 <dataDir>（主进程注入）；控制文件目录可注入（测试用临时目录）；
 *   · 凭据走 credential-store（safeStorage），只落 credentialRef + 掩码；
 *   · 源函数名/参数/输出字段逐字保留；失败抛带 code 的 Error，由 plugin-service 转结构化。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");

const { INTEGRATION_ERR_UNAVAILABLE, INTEGRATION_ERR_INVALID_INPUT, INTEGRATION_ERR_NOT_FOUND } = require("./plugin-registry.cjs");
const { maskSecret } = require("./integration-dingtalk.cjs");

const STORE_FILE_NAME = "ziniao-download-jobs.json";
const LEGACY_STORE_FILE_NAME = "ziniao-download-job.json";
const CONTROL_FILE_NAME = "dxos-ziniao-download-control.json";
const CREDENTIAL_REF = "ziniao.credential";
const SAFE_REQUEST_INTERVAL_SECONDS = 30;
const RATE_LIMIT_COOLDOWN_MS = 30 * 60_000;
const MAX_AUTO_RETRIES = 3;

const asStr = (value, max = 4096) => (typeof value === "string" ? value.slice(0, max) : value == null ? "" : String(value).slice(0, max));
function fail(code, detail) { const error = new Error(detail); error.code = code; return error; }

// ══════════════════════════════════════════════════════════════════════
// 厂商路径解析（本仓不随附紫鸟 Python 运行时，只按路径调用）
//   ① 显式注入 runtimePath  ② 环境变量  ③ <userData>/dxos/vendor/ziniao  ④ <应用根>/resources/vendor/ziniao
// ══════════════════════════════════════════════════════════════════════
const VENDOR_DIR_NAME = "vendor";
const ZINIAO_RUNTIME_DIR_NAME = "ziniao";
const ZINIAO_RUNTIME_ENV_KEYS = Object.freeze(["DX_ZINIAO_RUNTIME", "DX_ZINIAO_PYTHON"]);

/** 路径含 `..` 段即越界。 */
function hasTraversal(value) {
  return String(value).split(/[\\/]+/).includes("..");
}

/** 从注入的 dataDir 反推 <userData>/dxos（仅当形如 <dxos>/integrations/<plugin> 时）。 */
function guessDxosRootFromDataDir(dataDir) {
  if (!dataDir) return null;
  const dir = path.resolve(String(dataDir));
  const integrationsDir = path.dirname(dir);
  return path.basename(integrationsDir) === "integrations" ? path.dirname(integrationsDir) : null;
}

/** 文件放置的两个厂商根：用户级优先，随包目录次之。 */
function vendorRoots(options = {}) {
  const roots = [];
  const dxosRoot = options.dxosRoot ? String(options.dxosRoot)
    : options.userDataDir ? path.join(String(options.userDataDir), "dxos")
    : guessDxosRootFromDataDir(options.dataDir);
  if (dxosRoot) roots.push({ source: "userData", dir: path.join(dxosRoot, VENDOR_DIR_NAME) });
  const appDir = options.appDir ? String(options.appDir) : path.join(__dirname, "..");
  roots.push({ source: "bundled", dir: path.join(appDir, "resources", VENDOR_DIR_NAME) });
  return roots;
}

/**
 * 校验候选厂商路径。显式 / 环境变量来源必须存在（否则结构化拒绝，不静默回落）；
 * 放置目录来源不存在则继续下一来源。越界与非文件/目录一律 INTEGRATION_INVALID_INPUT。
 */
function validateVendorCandidate(candidate, expect) {
  const value = String(candidate.path || "");
  if (!value) return null;
  if (hasTraversal(value)) throw fail(INTEGRATION_ERR_INVALID_INPUT, "厂商路径含越界段（..）：" + value);
  if (candidate.mustExist && !path.isAbsolute(value)) throw fail(INTEGRATION_ERR_INVALID_INPUT, "厂商路径必须是绝对路径：" + value);
  let stat = null;
  try { stat = fs.statSync(value); } catch { stat = null; }
  if (!stat) {
    if (candidate.mustExist) throw fail(INTEGRATION_ERR_INVALID_INPUT, "厂商路径不存在：" + value);
    return null;
  }
  if (expect === "file" && !stat.isFile()) throw fail(INTEGRATION_ERR_INVALID_INPUT, "厂商路径不是文件：" + value);
  if (expect === "dir" && !stat.isDirectory()) throw fail(INTEGRATION_ERR_INVALID_INPUT, "厂商路径不是目录：" + value);
  if (expect === "any" && !stat.isFile() && !stat.isDirectory()) throw fail(INTEGRATION_ERR_INVALID_INPUT, "厂商路径既不是文件也不是目录：" + value);
  return { path: value, source: candidate.source };
}

/** 紫鸟 Python 运行时的放置说明（缺依赖时的 detail 必须指出放哪里）。 */
const ZINIAO_VENDOR_HINT = "放置方式（优先级从高到低）：① createZiniaoIntegration({ runtimePath: '<绝对路径>/ziniao-runtime' }) 注入；② 环境变量 DX_ZINIAO_RUNTIME；③ <userData>/dxos/vendor/ziniao/；④ <应用根>/resources/vendor/ziniao/。本移植不随附厂商 Python 运行时。";

/**
 * 解析紫鸟 Python 运行时路径（目录或可执行文件，先命中者胜出）。全部缺失返回 { path: null }。
 * @returns {{ path: string|null, source: string|null }}
 */
function resolveZiniaoRuntime(options = {}) {
  const env = options.env && typeof options.env === "object" ? options.env : process.env;
  const explicit = options.runtimePath ? String(options.runtimePath) : "";
  const envKey = ZINIAO_RUNTIME_ENV_KEYS.find((key) => env && env[key]);
  const candidates = [];
  if (explicit) candidates.push({ source: "explicit", path: explicit, mustExist: true });
  if (envKey) candidates.push({ source: "env:" + envKey, path: String(env[envKey]), mustExist: true });
  for (const root of vendorRoots(options)) candidates.push({ source: root.source, path: path.join(root.dir, ZINIAO_RUNTIME_DIR_NAME), mustExist: false });
  for (const candidate of candidates) {
    const resolved = validateVendorCandidate(candidate, "any");
    if (resolved) return resolved;
  }
  return { path: null, source: null };
}

function createZiniaoIntegration(options = {}) {
  const dataDir = options.dataDir ? String(options.dataDir) : null;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const transport = typeof options.transport === "function" ? options.transport : null;
  const runtimeResolution = resolveZiniaoRuntime(options);
  const runtimePath = runtimeResolution.path;
  const runtimeSource = runtimeResolution.source;
  const credentials = options.credentials && typeof options.credentials === "object" ? options.credentials : null;
  const controlDir = options.controlDir ? String(options.controlDir) : os.tmpdir();
  const outDir = options.outDir ? String(options.outDir) : null;

  const storePath = dataDir ? path.join(dataDir, STORE_FILE_NAME) : null;
  const legacyStorePath = dataDir ? path.join(dataDir, LEGACY_STORE_FILE_NAME) : null;
  const controlPath = path.join(controlDir, CONTROL_FILE_NAME);

  let jobs = null;
  const runners = new Set();
  const retryTimers = new Map();

  function isTerminal(status) { return ["completed", "failed", "stopped"].includes(status); }
  function activeJob() { return loadJobs().find((job) => !isTerminal(job.status)) || null; }

  function loadJobs() {
    if (jobs) return jobs;
    try {
      jobs = storePath && fs.existsSync(storePath) ? JSON.parse(fs.readFileSync(storePath, "utf8")) : [];
    } catch { jobs = []; }
    if (!jobs.length && legacyStorePath && fs.existsSync(legacyStorePath)) {
      try { jobs = [JSON.parse(fs.readFileSync(legacyStorePath, "utf8"))]; } catch { /* 忽略旧格式 */ }
    }
    if (!Array.isArray(jobs)) jobs = [];
    return jobs;
  }
  function persistJobs() {
    if (!storePath) return false;
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const pending = storePath + ".tmp";
    fs.writeFileSync(pending, JSON.stringify(loadJobs(), null, 2), "utf8");
    fs.renameSync(pending, storePath);
    return true;
  }
  function saveJob(job) { job.updatedAt = clock(); persistJobs(); }
  function clearRetry(jobId) { const timer = retryTimers.get(jobId); if (timer) clearTimeout(timer); retryTimers.delete(jobId); }
  function scheduleRetry(job) {
    clearRetry(job.id);
    if (job.status !== "cooldown" || !job.retryAt) return;
    retryTimers.set(job.id, setTimeout(() => {
      retryTimers.delete(job.id);
      if (job.status !== "cooldown") return;
      job.status = "running"; job.retryAt = undefined;
      job.message = "限流冷却结束，正在补抓第 " + (job.currentIndex + 1) + "/" + job.stores.length + " 个店铺…";
      writeControl("running"); saveJob(job); void runJob(job);
    }, Math.max(0, job.retryAt - clock())));
  }
  function writeControl(state) {
    try {
      fs.mkdirSync(path.dirname(controlPath), { recursive: true });
      fs.writeFileSync(controlPath, JSON.stringify({ state, updatedAt: clock() }), "utf8");
    } catch { /* 控制文件失败不阻断任务 */ }
  }
  function toolErrorEntries(cause) {
    const message = String((cause && cause.message) || cause), start = message.indexOf("[", message.indexOf(":") + 1), end = message.lastIndexOf("]");
    if (start >= 0 && end > start) try {
      return JSON.parse(message.slice(start, end + 1));
    } catch { /* 非 JSON 的 MCP 错误 */ }
    return [];
  }
  function conciseError(cause) {
    const entry = toolErrorEntries(cause).find((item) => item.error);
    return (entry && entry.error) || String((cause && cause.message) || cause);
  }
  async function waitWhilePaused(job) { while (job.status === "paused") await new Promise((resolve) => setTimeout(resolve, 400)); }

  function requireTransport() {
    if (typeof transport !== "function") throw fail(INTEGRATION_ERR_UNAVAILABLE, "未注入紫鸟 MCP 传输（transport/callDirect）；注入后可用，绝不假下载。" + ZINIAO_VENDOR_HINT);
  }

  async function runJob(job) {
    if (runners.has(job.id) || isTerminal(job.status)) return;
    runners.add(job.id);
    try {
      job.message = "正在准备紫鸟浏览器自动化环境…"; saveJob(job);
      await transport("ziniao", "start_client", { killExisting: false });
      while (job.currentIndex < job.stores.length) {
        await waitWhilePaused(job);
        if (job.status === "stopping") break;
        const store = job.stores[job.currentIndex];
        store.status = "running"; store.error = null; job.status = "running";
        job.message = "正在下载第 " + (job.currentIndex + 1) + "/" + job.stores.length + " 个店铺：" + store.name;
        writeControl("running"); saveJob(job);
        try {
          const text = await transport("ziniao", "download_vc_summary", { store: store.selector, from: job.from, to: job.to, outDir: job.outDir, requestIntervalSeconds: job.requestIntervalSeconds || SAFE_REQUEST_INTERVAL_SECONDS });
          const entries = JSON.parse(text);
          const success = entries.find((item) => item.file && !item.error), skipped = entries.find((item) => item.skipped), failed = entries.find((item) => item.error);
          store.status = success ? "success" : skipped ? "skipped" : "failed";
          const result = success || skipped || failed;
          store.file = (success && success.file) || null;
          store.files = (success && success.files) || ((success && success.file) ? [success.file] : []);
          store.rowCount = success && success.rowCount;
          store.downloadedDays = result && result.downloadedDays;
          store.skippedExistingDays = result && result.skippedExistingDays;
          store.error = (skipped && skipped.note) || (failed && failed.error) || (success ? null : "该店铺没有生成文件");
          if (failed && /请求次数已超限|page load requests|try again later/i.test(failed.error || "")) throw new Error(failed.error || "VC 请求限流");
        } catch (cause) {
          const message = conciseError(cause);
          const partial = toolErrorEntries(cause).find((item) => item.error);
          if (partial && partial.files && partial.files.length) {
            store.files = partial.files; store.file = partial.file || partial.files[partial.files.length - 1] || null;
            store.rowCount = partial.rowCount; store.downloadedDays = partial.downloadedDays;
            store.skippedExistingDays = partial.skippedExistingDays;
          }
          if (job.status === "stopping") { store.status = "stopped"; store.error = null; break; }
          if (/请求次数已超限|page load requests|try again later/i.test(message)) {
            store.error = message;
            job.rateLimitRetries = (job.rateLimitRetries || 0) + 1;
            if (job.rateLimitRetries > MAX_AUTO_RETRIES) {
              store.status = "paused"; job.status = "paused"; job.retryAt = undefined;
              job.message = "「" + store.name + "」连续触发 VC 限流，已停止自动重试；请稍后在紫鸟 APP 中手动继续。";
              writeControl("paused"); saveJob(job); return;
            }
            const cooldownMs = RATE_LIMIT_COOLDOWN_MS * Math.pow(2, job.rateLimitRetries - 1);
            store.status = "paused"; job.status = "cooldown"; job.retryAt = clock() + cooldownMs;
            job.message = "「" + store.name + "」触发 VC 限流，冷却 " + Math.round(cooldownMs / 60000) + " 分钟后自动补抓；已完成日期会跳过。";
            writeControl("idle"); saveJob(job); scheduleRetry(job); return;
          }
          job.rateLimitRetries = 0;
          store.status = "failed"; store.error = message;
        }
        if (store.status === "success" || store.status === "skipped") job.rateLimitRetries = 0;
        job.currentIndex += 1; saveJob(job);
      }
      if (job.status === "stopping") {
        job.status = "stopped"; job.message = "任务已停止，已完成结果已保留。";
        job.stores.forEach((store) => { if (["pending", "paused", "running"].includes(store.status)) store.status = "stopped"; });
      } else {
        const success = job.stores.filter((store) => store.status === "success").length, skipped = job.stores.filter((store) => store.status === "skipped").length;
        job.status = success || skipped ? "completed" : "failed";
        const existingDays = job.stores.reduce((sum, store) => sum + (store.skippedExistingDays || 0), 0);
        job.message = "任务完成：" + success + " 个成功" + (skipped ? "，" + skipped + " 个无需下载或无数据" : "") + (existingDays ? "，跳过 " + existingDays + " 个已有数据日" : "") + "。";
        job.error = job.status === "failed" ? ((job.stores.find((store) => store.error) || {}).error || "没有店铺生成文件") : "";
      }
      writeControl("idle"); saveJob(job);
    } catch (cause) {
      job.status = "failed"; job.error = conciseError(cause); job.message = "紫鸟下载任务异常结束。"; writeControl("idle"); saveJob(job);
    } finally { runners.delete(job.id); }
  }

  function listZiniaoDownloadJobs() { return [...loadJobs()].sort((a, b) => b.createdAt - a.createdAt); }
  function getZiniaoDownloadJob() { return activeJob() || listZiniaoDownloadJobs()[0] || null; }

  function startZiniaoDownloadJob(input = {}) {
    requireTransport();
    const active = activeJob();
    if (active) throw fail(INTEGRATION_ERR_INVALID_INPUT, active.status === "paused"
      ? "已有暂停的紫鸟下载任务，请在紫鸟 APP 中继续或停止该任务后重试"
      : "已有紫鸟下载任务正在运行，请等待完成或在紫鸟 APP 中停止该任务");
    const stores = Array.isArray(input.stores) ? input.stores : [];
    if (!stores.length) throw fail(INTEGRATION_ERR_INVALID_INPUT, "没有可下载的店铺");
    const now = clock();
    const requestIntervalSeconds = Math.min(120, Math.max(15, Number(input.requestIntervalSeconds) || SAFE_REQUEST_INTERVAL_SECONDS));
    const job = {
      id: randomUUID(), status: "running", from: asStr(input.from, 40), to: asStr(input.to, 40), outDir: String(input.outDir || ""),
      requestIntervalSeconds, stores: stores.map((store) => Object.assign({}, store, { status: "pending" })),
      currentIndex: 0, message: "任务已创建，将按日顺序抓取（请求间隔 " + requestIntervalSeconds + " 秒）…", error: "", createdAt: now, updatedAt: now,
    };
    loadJobs().unshift(job); writeControl("running"); saveJob(job); void runJob(job); return job;
  }

  function controlZiniaoDownloadJob(id, action) {
    const job = loadJobs().find((item) => item.id === id);
    if (!job) throw fail(INTEGRATION_ERR_NOT_FOUND, "紫鸟下载任务不存在");
    if (isTerminal(job.status)) return job;
    if (action === "pause") {
      clearRetry(job.id); job.retryAt = undefined; job.status = "paused";
      job.message = "任务已暂停：当前进度 " + job.currentIndex + "/" + job.stores.length; writeControl("paused");
    } else if (action === "resume") {
      requireTransport();
      if (job.status === "cooldown" && job.retryAt && clock() < job.retryAt) throw fail(INTEGRATION_ERR_INVALID_INPUT, "VC 请求冷却尚未结束，请等待自动恢复，避免再次触发限流");
      clearRetry(job.id); job.retryAt = undefined; job.rateLimitRetries = 0;
      const current = job.stores[job.currentIndex]; if (current && current.status === "paused") current.status = "pending";
      job.status = "running"; job.message = "正在继续下载任务…"; writeControl("running"); void runJob(job);
    } else {
      clearRetry(job.id); job.retryAt = undefined; job.status = "stopping"; job.message = "正在安全停止当前任务…"; writeControl("stopped");
      if (!runners.has(job.id)) { job.status = "stopped"; job.message = "任务已停止，已完成结果已保留。"; }
    }
    saveJob(job); return job;
  }

  function deleteZiniaoDownloadJobs(ids) {
    const selected = new Set(Array.isArray(ids) ? ids.map(String) : []);
    const blocked = loadJobs().filter((job) => selected.has(job.id) && !isTerminal(job.status)).map((job) => job.id);
    if (blocked.length) throw fail(INTEGRATION_ERR_INVALID_INPUT, "进行中或暂停的任务不能删除，请先停止任务");
    const before = loadJobs().length;
    jobs = loadJobs().filter((job) => !selected.has(job.id)); persistJobs();
    return { deleted: before - jobs.length, jobs: listZiniaoDownloadJobs() };
  }

  function recoverZiniaoDownloadJob() {
    const job = activeJob(); if (!job) return null;
    if (job.status === "stopping") { job.status = "stopped"; job.message = "任务已停止。"; saveJob(job); return job; }
    const current = job.stores[job.currentIndex];
    if (job.status === "paused" && job.rateLimitRetries === undefined && /请求次数已超限|page load requests|try again later/i.test((current && current.error) || "")) {
      job.status = "cooldown"; job.rateLimitRetries = 1;
      job.requestIntervalSeconds = Math.max(SAFE_REQUEST_INTERVAL_SECONDS, job.requestIntervalSeconds || 0);
      job.retryAt = Math.max(clock(), job.updatedAt + RATE_LIMIT_COOLDOWN_MS);
      job.message = "「" + (current && current.name) + "」触发 VC 限流，冷却后自动补抓；已完成日期会跳过。";
    }
    if (job.stores[job.currentIndex] && job.stores[job.currentIndex].status === "running") job.stores[job.currentIndex].status = "pending";
    if (job.status === "cooldown") { saveJob(job); scheduleRetry(job); return job; }
    writeControl(job.status === "paused" ? "paused" : "running"); saveJob(job);
    if (typeof transport === "function") void runJob(job);
    return job;
  }

  // ── lingxingLocalData.ts:275-315 逐字（VC 文件列举） ──
  function ziniaoOutputRoot() {
    return path.resolve(outDir || (dataDir ? path.join(dataDir, "ziniao-vc") : os.tmpdir()));
  }
  function describeVcFile(filePath) {
    const info = fs.statSync(filePath);
    const fileName = path.basename(filePath);
    const match = fileName.match(/^VC汇总_(.+)_(\d{8}-\d{8})\.xlsx$/i);
    return { path: filePath, fileName, store: (match && match[1]) || "", dateRange: (match && match[2]) || "", bytes: info.size, updatedAt: info.mtimeMs };
  }
  function listZiniaoVcFiles() {
    const root = ziniaoOutputRoot();
    const files = [];
    if (!fs.existsSync(root)) return { root, files };
    const walk = (directory, depth) => {
      if (depth > 5) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const filePath = path.resolve(directory, entry.name);
        if (entry.isDirectory()) walk(filePath, depth + 1);
        else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".xlsx" && /^VC汇总_/i.test(entry.name)) files.push(describeVcFile(filePath));
      }
    };
    walk(root, 0);
    files.sort((a, b) => b.updatedAt - a.updatedAt);
    return { root, files };
  }

  // ── 凭据（只落 credentialRef；明文进 safeStorage） ──
  const credentialsAvailable = () => !!credentials && typeof credentials.available === "function" && credentials.available() === true;
  function readSecret() {
    if (!credentialsAvailable() || typeof credentials.get !== "function") return "";
    try { return asStr(credentials.get(CREDENTIAL_REF), 4096); } catch { return ""; }
  }
  function saveCredential(input = {}) {
    const secret = asStr(input && input.secret, 4096).trim();
    if (!secret) throw fail(INTEGRATION_ERR_INVALID_INPUT, "凭据不能为空");
    if (!credentialsAvailable() || typeof credentials.put !== "function") throw fail(INTEGRATION_ERR_UNAVAILABLE, "safeStorage 不可用，紫鸟凭据无法加密保存；为不落明文，本功能停用");
    credentials.put(CREDENTIAL_REF, secret);
    return { ref: CREDENTIAL_REF, credentialSet: true, mask: maskSecret(secret) };
  }
  function credentialStatus() {
    const secret = readSecret();
    return { ref: CREDENTIAL_REF, credentialSet: !!secret, mask: maskSecret(secret), safeStorageAvailable: credentialsAvailable() };
  }
  function clearCredential() {
    if (credentialsAvailable() && typeof credentials.delete === "function") { try { credentials.delete(CREDENTIAL_REF); } catch { /* 忽略 */ } }
    return { ref: CREDENTIAL_REF, credentialSet: false };
  }

  /** 运行时解析状态：configured 只看是否解析到路径，available 看路径当前是否真的存在。 */
  function runtimeStatus() {
    return { configured: !!runtimePath, source: runtimeSource, path: runtimePath, available: !!runtimePath && fs.existsSync(runtimePath) };
  }

  /** 显式要求厂商运行时；缺失 / 失效时结构化 INTEGRATION_UNAVAILABLE，并说明放置位置。 */
  function requireRuntime() {
    if (!runtimePath) throw fail(INTEGRATION_ERR_UNAVAILABLE, "紫鸟 Python 运行时未配置；" + ZINIAO_VENDOR_HINT);
    if (!fs.existsSync(runtimePath)) throw fail(INTEGRATION_ERR_UNAVAILABLE, "紫鸟 Python 运行时路径已失效：" + runtimePath + "；" + ZINIAO_VENDOR_HINT);
    return { path: runtimePath, source: runtimeSource };
  }

  function status() {
    return {
      transportInjected: typeof transport === "function",
      dataDir,
      controlPath,
      storePath,
      safeStorageAvailable: credentialsAvailable(),
      credentialSet: !!readSecret(),
      activeJobId: (activeJob() || {}).id || null,
      runtime: runtimeStatus(),
    };
  }

  return {
    CREDENTIAL_REF, storePath, legacyStorePath, controlPath,
    isTerminal, activeJob, loadJobs, persistJobs, toolErrorEntries, conciseError,
    listZiniaoDownloadJobs, getZiniaoDownloadJob, startZiniaoDownloadJob, controlZiniaoDownloadJob,
    deleteZiniaoDownloadJobs, recoverZiniaoDownloadJob,
    listZiniaoVcFiles, describeVcFile, ziniaoOutputRoot,
    saveCredential, credentialStatus, clearCredential,
    runtimePath, runtimeSource, runtimeStatus, requireRuntime,
    status,
    whenIdle: async () => { while (runners.size) await new Promise((resolve) => setTimeout(resolve, 5)); },
    clearRetry, close: () => { for (const timer of retryTimers.values()) clearTimeout(timer); retryTimers.clear(); },
  };
}

module.exports = { createZiniaoIntegration, resolveZiniaoRuntime, ZINIAO_VENDOR_HINT, CREDENTIAL_REF, STORE_FILE_NAME, CONTROL_FILE_NAME };
