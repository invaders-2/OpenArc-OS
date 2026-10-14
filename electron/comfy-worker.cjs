"use strict";
/**
 * B7e1 · ComfyUI 受监督子进程（唯一重活执行入口）。
 *
 * 为什么单独一个子进程：启动 ComfyUI（Python 常驻服务）、上传素材、提交 /prompt、轮询
 * /history 都可能持续数十秒并占用大量内存与网络。按任务硬约束，重活不得阻塞主进程，
 * 必须走受监督子进程：本文件由 comfy-service.cjs 经 electron/dxos-foundation-runner.cjs
 * （executor-launcher.cjs 的 Node / utilityProcess 两条实现）启动，超时 / 取消 / 输出上限 /
 * 退出码全部由 runner 归一化。
 *
 * 与 electron/video-render-worker.cjs 同一形态：stdout 只写本协议行，绝不回显 ComfyUI 原始日志。
 *   OPENARC_COMFY_RESULT <json>     恰好一行，进程结束前的最终结果
 *   OPENARC_COMFY_PROGRESS <json>   上传 / 提交 / 轮询过程中的进度行（可零到多行）
 *
 * 子进程自持 deadline：runner 用 SIGKILL 结束本进程时，ComfyUI 孙进程不会被自动带走。
 * 因此 instance-start 在 runner 超时前先按本进程 deadline kill 自己拉起的服务器；
 * instance-stop 按启动时落下的 pid 文件精确停止，绝不按端口猜进程。
 *
 * ## 来源（只读参照 DX OS 0.5.1 app.asar.unpacked/server，行号为源行号）
 *   · comfyui.ts:411-420  子进程退出错误文案（去掉 ANSI 取最后一行）
 *   · comfyui.ts:431-460  端口探测 / 可监听校验
 *   · comfyui.ts:462-515  Windows 端口占用者定位 / killTree
 *   · comfyui.ts:581-639  buildArgs + spawn（本文件把 spawn 移进受监督 worker）
 *   · comfyui.ts:642-679  stopComfyInstance（按 pid 停止 + 等端口关闭）
 *   · comfyWorkflows.ts:685-719  uploadInput / readComfyHistoryItem
 *   · comfyWorkflows.ts:793-935  executeRun（上传 → 裁剪 → 提交 → 轮询 → 结果）
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const comfyDomain = require("./comfy-domain.cjs");
const workflow = require("./comfy-workflow.cjs");

const RESULT_PREFIX = "OPENARC_COMFY_RESULT ";
const PROGRESS_PREFIX = "OPENARC_COMFY_PROGRESS ";
const MAX_SPEC_BYTES = 64 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120000;
/** 子进程自持 deadline 比 runner 提前的余量：保证被拉起的 ComfyUI 由本进程亲手 kill。 */
const DEADLINE_MARGIN_MS = 1000;

/** 统一结果出口：先 flush stdout 再退出，避免管道被 exit 截断（与 media worker 同形）。 */
function emitResult(payload) {
  const line = RESULT_PREFIX + JSON.stringify(payload) + "\n";
  let done = false;
  const finish = () => { if (done) return; done = true; process.exit(0); };
  try {
    process.stdout.write(line, finish);
  } catch {
    finish();
  }
  setTimeout(finish, 500).unref?.();
}

function emitProgress(payload) {
  try { process.stdout.write(PROGRESS_PREFIX + JSON.stringify(payload) + "\n"); } catch { /* 进度行丢失不改变运行结果 */ }
}

function asStr(value, max = 512) {
  return typeof value === "string" ? value.slice(0, max) : value == null ? "" : String(value).slice(0, max);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// op: probe —— 依赖探测（纯离线，不联网、不启动服务）
// ---------------------------------------------------------------------------
async function opProbe(spec) {
  const pythonPath = asStr(spec.pythonPath, 1024);
  const mainPath = asStr(spec.mainPath, 1024);
  const pythonExists = !!pythonPath && fs.existsSync(pythonPath);
  const mainExists = !!mainPath && fs.existsSync(mainPath);
  let pythonVersion = null;
  let pythonError = null;
  if (pythonExists) {
    const result = spawnSync(pythonPath, ["--version"], { timeout: 10000, encoding: "utf8", windowsHide: true });
    if (result.error) pythonError = asStr(result.error.message, 300);
    else pythonVersion = asStr((result.stdout || result.stderr || "").split(/\r?\n/)[0], 120) || null;
  }
  return {
    ok: true,
    result: {
      platform: process.platform,
      pythonPath: pythonExists ? pythonPath : null,
      pythonExists: pythonExists,
      pythonVersion: pythonVersion,
      pythonError: pythonError,
      mainPath: mainExists ? mainPath : null,
      mainExists: mainExists,
    },
  };
}

// ---------------------------------------------------------------------------
// 端口 / 进程工具（源 comfyui.ts:431-515）
// ---------------------------------------------------------------------------
async function isComfyUiUrl(baseUrl) {
  try {
    const response = await fetch(baseUrl + "/system_stats", { signal: AbortSignal.timeout(1800) });
    if (!response.ok) return false;
    const body = await response.json();
    return !!body && typeof body === "object" && ("system" in body || "devices" in body);
  } catch {
    return false;
  }
}

function killTree(pid) {
  if (!pid) return { ok: false, error: "no-pid" };
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, encoding: "utf8" });
    return { ok: !result.error && result.status === 0, error: asStr((result.error && result.error.message) || result.stderr || result.stdout, 300) };
  }
  try { process.kill(pid, "SIGKILL"); return { ok: true, error: "" }; }
  catch (error) { return { ok: false, error: asStr(error && error.message, 300) }; }
}

function readInstanceRecord(stateDir, instanceId) {
  const file = path.join(stateDir, instanceId + ".json");
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function writeInstanceRecord(stateDir, instanceId, record) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, instanceId + ".json");
  const temp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(record, null, 2), "utf8");
  fs.renameSync(temp, file);
  return file;
}

function removeInstanceRecord(stateDir, instanceId) {
  try { fs.rmSync(path.join(stateDir, instanceId + ".json"), { force: true }); } catch { /* 删除失败不改变停止结果 */ }
}

// ---------------------------------------------------------------------------
// op: instance-start —— 受监督启动本机 ComfyUI（源 comfyui.ts:581-640）
// ---------------------------------------------------------------------------
async function opInstanceStart(spec) {
  const pythonPath = asStr(spec.pythonPath, 1024);
  const mainPath = asStr(spec.mainPath, 1024);
  const rootDir = asStr(spec.rootDir, 1024);
  const instanceId = asStr(spec.instanceId, 80);
  const stateDir = asStr(spec.stateDir, 1024);
  const port = Math.max(1, Math.min(65535, Math.floor(Number(spec.port) || 0)));
  const listen = asStr(spec.listen, 80) || "127.0.0.1";
  const timeoutMs = Number.isFinite(spec.timeoutMs) ? Math.max(0, spec.timeoutMs) : DEFAULT_TIMEOUT_MS;
  if (!pythonPath || !fs.existsSync(pythonPath)) {
    return { ok: false, error: comfyDomain.COMFY_ERR_DEPENDENCY_UNAVAILABLE, dependency: "comfy.python", message: "找不到 ComfyUI Python 运行时：" + (pythonPath || "未配置") };
  }
  if (!mainPath || !fs.existsSync(mainPath)) {
    return { ok: false, error: comfyDomain.COMFY_ERR_DEPENDENCY_UNAVAILABLE, dependency: "comfy.install", message: "找不到 ComfyUI main.py：" + (mainPath || "未配置") };
  }
  if (!instanceId || !stateDir) return { ok: false, error: comfyDomain.COMFY_ERR_INVALID_INPUT, message: "instance-start 需要 instanceId 与 stateDir" };

  const args = [
    mainPath,
    ...workflow.parseComfyArgs(spec.extraArgs),
    "--listen", listen,
    "--cuda-device", String(Math.max(0, Math.floor(Number(spec.gpu) || 0))),
    "--port", String(port),
  ];
  const outputDir = asStr(spec.outputDir, 1024);
  if (outputDir) args.push("--output-directory", outputDir);

  let child = null;
  let stderr = "";
  try {
    child = spawn(pythonPath, args, {
      cwd: rootDir || path.dirname(mainPath),
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    });
  } catch (error) {
    return { ok: false, error: comfyDomain.COMFY_ERR_DEPENDENCY_UNAVAILABLE, dependency: "comfy.python", message: "无法启动 ComfyUI：" + asStr(error && error.message, 300) };
  }
  if (child.stderr) child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-4000); });
  let exited = false;
  let exitCode = null;
  child.on("exit", (code) => { exited = true; exitCode = code; });
  const pid = child.pid == null ? null : child.pid;
  try { child.unref(); } catch { /* unref 失败不影响启动 */ }

  const base = "http://127.0.0.1:" + port;
  const deadline = Date.now() + Math.max(1000, timeoutMs - DEADLINE_MARGIN_MS);
  while (Date.now() < deadline) {
    if (await isComfyUiUrl(base)) {
      const record = { pid: pid, port: port, baseUrl: base, instanceId: instanceId, startedAt: Date.now() };
      const file = writeInstanceRecord(stateDir, instanceId, record);
      return { ok: true, result: { pid: pid, port: port, url: base, status: "running", recordFile: file } };
    }
    if (exited) {
      return { ok: false, error: comfyDomain.COMFY_ERR_CHILD_FAILED, message: "ComfyUI 启动即退出（exit " + exitCode + "）" + (stderr ? "：" + stderr.split(/\r?\n/).filter(Boolean).slice(-1)[0].slice(0, 300) : "") };
    }
    emitProgress({ phase: "starting", port: port, elapsedMs: timeoutMs - Math.max(0, deadline - Date.now()) });
    await delay(1200);
  }
  killTree(pid);
  return { ok: false, error: comfyDomain.COMFY_ERR_TIMEOUT, message: "等待 ComfyUI 启动超时（" + timeoutMs + "ms），已结束进程 " + pid };
}

// ---------------------------------------------------------------------------
// op: instance-stop —— 按 pid 精确停止（源 comfyui.ts:642-679）
// ---------------------------------------------------------------------------
async function opInstanceStop(spec) {
  const instanceId = asStr(spec.instanceId, 80);
  const stateDir = asStr(spec.stateDir, 1024);
  const port = Math.max(0, Math.min(65535, Math.floor(Number(spec.port) || 0)));
  const timeoutMs = Number.isFinite(spec.timeoutMs) ? Math.max(1000, spec.timeoutMs) : 30000;
  if (!instanceId || !stateDir) return { ok: false, error: comfyDomain.COMFY_ERR_INVALID_INPUT, message: "instance-stop 需要 instanceId 与 stateDir" };
  const record = readInstanceRecord(stateDir, instanceId);
  if (!record || !record.pid) {
    return { ok: true, result: { stopped: false, reason: "未找到由本应用启动的 ComfyUI 进程记录（不按端口猜进程）", pid: null } };
  }
  const result = killTree(record.pid);
  const deadline = Date.now() + timeoutMs;
  let closed = false;
  while (Date.now() < deadline) {
    if (port > 0) closed = !(await isComfyUiUrl("http://127.0.0.1:" + port));
    else closed = true;
    if (closed) break;
    await delay(400);
  }
  if (!closed) {
    return { ok: false, error: comfyDomain.COMFY_ERR_TIMEOUT, message: "停止失败：端口 " + port + " 仍在监听" + (result.error ? "（" + result.error + "）" : ""), pid: record.pid };
  }
  removeInstanceRecord(stateDir, instanceId);
  return { ok: true, result: { stopped: true, pid: record.pid, killError: result.ok ? null : result.error } };
}

// ---------------------------------------------------------------------------
// op: run —— 上传 → 提交 /prompt → 轮询 /history（源 comfyWorkflows.ts:793-935）
// ---------------------------------------------------------------------------
async function uploadOne(base, upload) {
  const bytes = Buffer.from(asStr(upload.base64, MAX_UPLOAD_BYTES * 2), "base64");
  if (!bytes.length) throw new Error("上传素材为空：" + asStr(upload.name, 120));
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error("上传素材超过 " + MAX_UPLOAD_BYTES + " 字节上限");
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(bytes)], { type: asStr(upload.mime, 120) || "application/octet-stream" }), asStr(upload.name, 200));
  const response = await fetch(base + "/upload/image", { method: "POST", body: form, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error("上传输入素材失败：HTTP " + response.status);
  const result = await response.json();
  return { name: asStr(result && result.name, 200), subfolder: asStr(result && result.subfolder, 200) };
}

async function readComfyHistoryItem(base, promptId, attempt) {
  const read = async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (!response) return { data: null, reachable: false };
    if (!response.ok) return { data: null, reachable: true };
    const data = await response.json().catch(() => null);
    return { data: data, reachable: true };
  };
  const direct = await read(base + "/history/" + encodeURIComponent(promptId));
  if (direct.data && direct.data[promptId]) return { item: direct.data[promptId], reachable: true };
  // 部分分支 / 反向代理不支持 /history/:id，但全量 /history 仍可用（源 comfyWorkflows.ts:714-718）。
  if (attempt % 5 !== 0) return { item: null, reachable: direct.reachable };
  const fallback = await read(base + "/history?max_items=200");
  return { item: fallback.data && fallback.data[promptId] ? fallback.data[promptId] : null, reachable: direct.reachable || fallback.reachable };
}

async function opRun(spec) {
  const base = asStr(spec.baseUrl, 512).replace(/\/+$/, "");
  const prompt = spec.prompt && typeof spec.prompt === "object" ? structuredClone(spec.prompt) : null;
  const outputs = Array.isArray(spec.outputs) ? spec.outputs : [];
  const uploads = Array.isArray(spec.uploads) ? spec.uploads : [];
  const timeoutMs = Number.isFinite(spec.timeoutMs) ? Math.max(1000, spec.timeoutMs) : 30 * 60 * 1000;
  if (!base || !prompt) return { ok: false, error: comfyDomain.COMFY_ERR_INVALID_INPUT, message: "run 需要 baseUrl 与 prompt" };
  const deadline = Date.now() + Math.max(1000, timeoutMs - DEADLINE_MARGIN_MS);
  try {
    for (const upload of uploads) {
      emitProgress({ phase: "uploading", fieldId: asStr(upload.fieldId, 80) });
      const stored = await uploadOne(base, upload);
      const target = prompt[upload.nodeId];
      if (target && target.inputs) target.inputs[asStr(upload.input, 120)] = stored.subfolder ? stored.subfolder + "/" + stored.name : stored.name;
    }
    emitProgress({ phase: "submitting" });
    const queued = await fetch(base + "/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: prompt, client_id: "dxos-" + asStr(spec.runId, 80) }),
      signal: AbortSignal.timeout(30000),
    });
    if (!queued.ok) return { ok: false, error: comfyDomain.COMFY_ERR_CHILD_FAILED, message: "提交工作流失败：HTTP " + queued.status };
    const body = await queued.json();
    const promptId = asStr(body && body.prompt_id, 200);
    if (!promptId) return { ok: false, error: comfyDomain.COMFY_ERR_CHILD_FAILED, message: asStr(body && body.error, 300) || "ComfyUI 没有返回 prompt_id" };
    emitProgress({ phase: "submitted", promptId: promptId });

    let attempt = 0;
    let connectionFailures = 0;
    while (Date.now() < deadline) {
      await delay(1000);
      attempt += 1;
      const history = await readComfyHistoryItem(base, promptId, attempt);
      connectionFailures = history.reachable ? 0 : connectionFailures + 1;
      if (connectionFailures >= 3) return { ok: false, error: comfyDomain.COMFY_ERR_CHILD_FAILED, message: "与 ComfyUI 实例的连接已中断（" + base + "）" };
      const item = history.item;
      if (!item) { emitProgress({ phase: "polling", promptId: promptId, attempt: attempt }); continue; }
      if (item.status && item.status.status_str === "error") return { ok: false, error: comfyDomain.COMFY_ERR_CHILD_FAILED, message: "ComfyUI 执行失败，请查看实例日志" };
      const completed = (item.status && item.status.completed === true)
        || ["success", "completed"].includes(String(item.status && item.status.status_str || "").toLowerCase())
        || Object.keys(item.outputs || {}).length > 0;
      if (!completed) continue;
      const results = workflow.comfyResultsFromHistory({ outputs: outputs }, item);
      emitProgress({ phase: "completed", promptId: promptId, count: results.length });
      return { ok: true, result: { promptId: promptId, results: results } };
    }
    return { ok: false, error: comfyDomain.COMFY_ERR_TIMEOUT, message: "工作流运行超时" };
  } catch (error) {
    return { ok: false, error: comfyDomain.COMFY_ERR_CHILD_FAILED, message: asStr(error && error.message, 500) };
  }
}

const OPS = Object.freeze({
  probe: opProbe,
  "instance-start": opInstanceStart,
  "instance-stop": opInstanceStop,
  run: opRun,
});

async function main() {
  const op = process.argv[2];
  const specPath = process.argv[3];
  if (!Object.prototype.hasOwnProperty.call(OPS, op)) {
    emitResult({ ok: false, error: comfyDomain.COMFY_ERR_INVALID_INPUT, message: "未知 ComfyUI 子进程操作：" + String(op) });
    return;
  }
  let spec = {};
  if (specPath) {
    try {
      const stat = fs.statSync(specPath);
      if (stat.size > MAX_SPEC_BYTES) {
        emitResult({ ok: false, error: comfyDomain.COMFY_ERR_INVALID_INPUT, message: "ComfyUI spec 超过大小上限" });
        return;
      }
      spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
    } catch (error) {
      emitResult({ ok: false, error: comfyDomain.COMFY_ERR_INVALID_INPUT, message: "ComfyUI worker 无法读取 spec：" + asStr(error && error.message, 300) });
      return;
    }
  }
  try {
    emitResult(await OPS[op](spec || {}));
  } catch (error) {
    emitResult({ ok: false, error: comfyDomain.COMFY_ERR_INTERNAL, message: asStr(error && error.message, 500) });
  }
}

if (require.main === module) main();

module.exports = { RESULT_PREFIX, PROGRESS_PREFIX, OPS };
