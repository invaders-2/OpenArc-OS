"use strict";
/**
 * 全局 AI 工作文件夹（第 2 期）。
 *
 * 一个专门给 AI 用的文件夹：读 / 列 / 搜不用审批；写文件和运行命令走既有 SideEffectAuthority
 * （先审批、再执行、再核验），而且只能落在这个文件夹里。
 *
 * 边界：
 *   · 路径一律是相对工作文件夹的路径；绝对路径、".." 越界、经符号链接跳出文件夹一律拒绝。
 *   · `.openarc/` 是内部目录（写入前的备份放这里），AI 不能写。
 *   · 写入的正文 / 命令随 plan 持久化，执行只读这份快照并按哈希复核，绝不再从模型入参取。
 *   · 命令在工作文件夹里跑，有时长和输出上限；环境变量去掉疑似密钥的项。
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const INTERNAL_DIR = ".openarc";
const MAX_LIST_ENTRIES = 300;
const MAX_READ_CHARS = 30000;
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 50;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_FILES = 2000;
const SKIP_DIRS = new Set([".git", "node_modules", INTERNAL_DIR, ".DS_Store"]);
const EXEC_DEFAULT_TIMEOUT_S = 60;
const EXEC_MAX_TIMEOUT_S = 300;
const EXEC_OUTPUT_MAX = 20000;
const SECRET_ENV = /(key|token|secret|password|passwd|credential|auth|cookie|session|OPENARC_)/i;

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

function defaultWorkspaceDir() {
  return process.env.OPENARC_WORKSPACE_DIR ? path.resolve(process.env.OPENARC_WORKSPACE_DIR) : path.join(os.homedir(), "OpenArc Workspace");
}

function wsError(code, detail = null) { return Object.assign(new Error(code), { code, detail }); }

/** 相对路径 → 绝对路径（必须仍在工作文件夹里；已存在的部分按真实路径复核，防符号链接跳出）。 */
function resolveInside(root, rel, { forWrite = false } = {}) {
  const raw = typeof rel === "string" ? rel.trim() : "";
  const text = raw === "" ? "." : raw.replace(/\\/g, "/");
  if (path.isAbsolute(text) || /^[A-Za-z]:/.test(text) || text.includes("\0")) throw wsError("WORKSPACE_PATH_INVALID");
  const abs = path.resolve(root, text);
  const relOut = path.relative(root, abs);
  if (relOut.startsWith("..") || path.isAbsolute(relOut)) throw wsError("WORKSPACE_PATH_OUTSIDE");
  const parts = relOut ? relOut.split(path.sep) : [];
  if (forWrite && (parts[0] === INTERNAL_DIR || !relOut)) throw wsError("WORKSPACE_PATH_RESERVED");
  // 找到最深的已存在祖先，按真实路径确认它仍在工作文件夹内。
  let probe = abs;
  while (!fs.existsSync(probe) && probe !== root) probe = path.dirname(probe);
  const realRoot = fs.realpathSync(root);
  const realProbe = fs.realpathSync(probe);
  const back = path.relative(realRoot, realProbe);
  if (back.startsWith("..") || path.isAbsolute(back)) throw wsError("WORKSPACE_PATH_OUTSIDE");
  return { abs, rel: parts.join("/") || "." };
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

function fileSha(abs) {
  try { return sha256(fs.readFileSync(abs)); } catch { return null; }
}

function cleanEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) if (!SECRET_ENV.test(k)) out[k] = v;
  return out;
}

function tail(text, max) { return text.length > max ? "…[前面省略 " + (text.length - max) + " 字]\n" + text.slice(-max) : text; }

function createAgentWorkspace({ root = null, clock = null, logger = null } = {}) {
  const now = typeof clock === "function" ? clock : () => Date.now();
  const dir = path.resolve(root || defaultWorkspaceDir());
  const ensure = () => { fs.mkdirSync(dir, { recursive: true }); return dir; };

  function list({ path: rel = ".", depth = 1 } = {}) {
    ensure();
    const { abs, rel: base } = resolveInside(dir, rel);
    if (!fs.existsSync(abs)) throw wsError("WORKSPACE_NOT_FOUND");
    if (!fs.statSync(abs).isDirectory()) throw wsError("WORKSPACE_NOT_A_DIRECTORY");
    const maxDepth = Math.min(4, Math.max(1, Number(depth) || 1));
    const entries = [];
    let truncated = false;
    const walk = (folder, relFolder, level) => {
      let items = [];
      try { items = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
      items.sort((a, b) => a.name.localeCompare(b.name));
      for (const ent of items) {
        if (entries.length >= MAX_LIST_ENTRIES) { truncated = true; return; }
        if (level === 1 && relFolder === "" && ent.name === INTERNAL_DIR) continue;
        const relPath = relFolder ? relFolder + "/" + ent.name : ent.name;
        const full = path.join(folder, ent.name);
        if (ent.isDirectory()) {
          entries.push({ path: relPath, type: "dir" });
          if (level < maxDepth && !SKIP_DIRS.has(ent.name)) walk(full, relPath, level + 1);
        } else if (ent.isFile()) {
          let size = 0; try { size = fs.statSync(full).size; } catch { /* ignore */ }
          entries.push({ path: relPath, type: "file", size });
        }
      }
    };
    walk(abs, base === "." ? "" : base, 1);
    return { root: "工作文件夹", path: base, entries, truncated };
  }

  function read({ path: rel, offset = 0, maxChars = MAX_READ_CHARS } = {}) {
    ensure();
    const { abs, rel: clean } = resolveInside(dir, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw wsError("WORKSPACE_NOT_FOUND");
    const size = fs.statSync(abs).size;
    const fd = fs.openSync(abs, "r");
    let buf;
    try { buf = Buffer.alloc(Math.min(size, MAX_READ_BYTES)); fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
    if (looksBinary(buf)) return { path: clean, size, binary: true, text: "", truncated: false, note: "二进制文件，没有可读文本。" };
    const all = buf.toString("utf8");
    const start = Math.max(0, Number(offset) || 0);
    const limit = Math.min(MAX_READ_CHARS, Math.max(200, Number(maxChars) || MAX_READ_CHARS));
    const text = all.slice(start, start + limit);
    return { path: clean, size, binary: false, offset: start, text, truncated: start + limit < all.length || size > MAX_READ_BYTES, untrusted: true };
  }

  function search({ query, path: rel = ".", maxResults = MAX_SEARCH_RESULTS } = {}) {
    ensure();
    const q = typeof query === "string" ? query.trim().toLowerCase() : "";
    if (!q) throw wsError("WORKSPACE_QUERY_REQUIRED");
    const { abs, rel: base } = resolveInside(dir, rel);
    const limit = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Number(maxResults) || MAX_SEARCH_RESULTS));
    const results = [];
    let files = 0;
    let truncated = false;
    const visit = (full, relPath) => {
      if (results.length >= limit || files >= MAX_SEARCH_FILES) { truncated = true; return; }
      let st; try { st = fs.statSync(full); } catch { return; }
      if (st.isDirectory()) {
        let items = []; try { items = fs.readdirSync(full).sort(); } catch { return; }
        for (const name of items) { if (SKIP_DIRS.has(name)) continue; visit(path.join(full, name), relPath ? relPath + "/" + name : name); }
        return;
      }
      if (!st.isFile()) return;
      files += 1;
      if (relPath.toLowerCase().includes(q)) results.push({ path: relPath, line: 0, text: "（文件名匹配）" });
      if (st.size > MAX_SEARCH_FILE_BYTES || results.length >= limit) return;
      let buf; try { buf = fs.readFileSync(full); } catch { return; }
      if (looksBinary(buf)) return;
      const lines = buf.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length && results.length < limit; i += 1) {
        if (lines[i].toLowerCase().includes(q)) results.push({ path: relPath, line: i + 1, text: lines[i].trim().slice(0, 200) });
      }
    };
    if (!fs.existsSync(abs)) throw wsError("WORKSPACE_NOT_FOUND");
    visit(abs, base === "." ? "" : base);
    return { query: q, results, truncated: truncated || results.length >= limit, untrusted: true };
  }

  /** 写入前的现状（plan 用）：文件是否存在 + 当前内容哈希。 */
  function snapshot(rel) {
    ensure();
    const { abs, rel: clean } = resolveInside(dir, rel, { forWrite: true });
    const existed = fs.existsSync(abs);
    if (existed && !fs.statSync(abs).isFile()) throw wsError("WORKSPACE_NOT_A_FILE");
    return { abs, rel: clean, existed, sha: existed ? fileSha(abs) : null };
  }

  /** 执行写入：现状必须和批准时一致；覆盖前先备份到 .openarc/backups。 */
  function writeApproved({ rel, content, expectedSha, callId }) {
    const snap = snapshot(rel);
    if ((snap.sha || "absent") !== (expectedSha || "absent")) throw wsError("SIDE_EFFECT_PRECONDITION_CHANGED");
    let backup = null;
    if (snap.existed) {
      const backupDir = path.join(ensure(), INTERNAL_DIR, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      backup = path.join(backupDir, String(callId || now()).replace(/[^A-Za-z0-9_-]/g, "_") + "-" + path.basename(snap.abs));
      fs.copyFileSync(snap.abs, backup);
    }
    fs.mkdirSync(path.dirname(snap.abs), { recursive: true });
    const tmp = snap.abs + ".openarc-tmp-" + process.pid;
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, snap.abs);
    return { path: snap.rel, bytes: Buffer.byteLength(content, "utf8"), created: !snap.existed, backup: backup ? path.relative(dir, backup).split(path.sep).join("/") : null };
  }

  function currentSha(rel) {
    const { abs } = resolveInside(dir, rel, { forWrite: true });
    return fs.existsSync(abs) ? fileSha(abs) : null;
  }

  /** 在工作文件夹里运行一段命令（已批准）。非零退出码照实返回，不当成"没执行"。 */
  function exec({ script, timeoutSec = EXEC_DEFAULT_TIMEOUT_S, signal = null }) {
    ensure();
    const timeoutMs = Math.min(EXEC_MAX_TIMEOUT_S, Math.max(1, Number(timeoutSec) || EXEC_DEFAULT_TIMEOUT_S)) * 1000;
    const win = process.platform === "win32";
    const started = now();
    return new Promise((resolve) => {
      let child;
      try {
        child = win
          ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", script], { cwd: dir, env: cleanEnv(), windowsHide: true })
          : spawn("/bin/sh", ["-c", script], { cwd: dir, env: cleanEnv(), detached: true });
      } catch (e) {
        resolve({ started: false, error: "WORKSPACE_EXEC_SPAWN_FAILED", detail: String((e && e.message) || e).slice(0, 200) });
        return;
      }
      let stdout = ""; let stderr = ""; let timedOut = false; let done = false;
      const cap = (s) => (s.length > EXEC_OUTPUT_MAX * 4 ? s.slice(-EXEC_OUTPUT_MAX * 4) : s);
      child.stdout.on("data", (d) => { stdout = cap(stdout + String(d)); });
      child.stderr.on("data", (d) => { stderr = cap(stderr + String(d)); });
      const kill = () => { try { if (!win && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* ignore */ } };
      const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
      const onAbort = () => kill();
      if (signal) signal.addEventListener?.("abort", onAbort, { once: true });
      const finish = (exitCode, sig) => {
        if (done) return; done = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener?.("abort", onAbort);
        resolve({ started: true, exitCode: exitCode == null ? null : Number(exitCode), signal: sig || null, timedOut, durationMs: now() - started, stdout: tail(stdout, EXEC_OUTPUT_MAX), stderr: tail(stderr, EXEC_OUTPUT_MAX) });
      };
      child.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ started: false, error: "WORKSPACE_EXEC_SPAWN_FAILED", detail: String((e && e.message) || e).slice(0, 200) }); } });
      child.on("close", finish);
    });
  }

  return { dir, ensure, list, read, search, snapshot, writeApproved, currentSha, exec };
}

/**
 * Tool adapter provider（executionProvider = "Workspace"）。
 * 只读：workspace.list / workspace.read / workspace.search（ControlledToolProxy 只读路径）。
 * 写入：workspace.write（可逆写入，覆盖前备份）/ workspace.exec（外部副作用，结果靠执行应答确认）。
 */
function createWorkspaceProvider({ workspace }) {
  if (!workspace) return null;
  const fail = (e) => ({ ok: false, error: (e && e.code) || "WORKSPACE_FAILED" });
  return {
    toolIds: ["workspace.list", "workspace.read", "workspace.search", "workspace.write", "workspace.exec"],
    async prepare() { return { plan: { provider: "Workspace" } }; },
    async plan({ args, contract }) {
      const toolId = contract && contract.toolId;
      try {
        if (toolId === "workspace.write") {
          const content = typeof (args && args.content) === "string" ? args.content : null;
          if (content == null) return null;
          const snap = workspace.snapshot(args.path);
          const contentSha256 = sha256(content);
          const bytes = Buffer.byteLength(content, "utf8");
          return {
            targets: ["workspace:" + snap.rel],
            preconditions: { targetType: "workspace-file", targetRef: snap.rel, expectedHash: snap.sha || "absent", content, contentSha256, bytes },
            expectedEffects: [{ action: snap.existed ? "overwrite" : "create", path: snap.rel, bytes }],
          };
        }
        if (toolId === "workspace.exec") {
          const script = typeof (args && args.script) === "string" ? args.script : "";
          if (!script.trim()) return null;
          const timeoutSec = Math.min(EXEC_MAX_TIMEOUT_S, Math.max(1, Number(args.timeoutSec) || EXEC_DEFAULT_TIMEOUT_S));
          return {
            targets: ["workspace:exec"],
            preconditions: { targetType: "workspace-exec", targetRef: "workspace", script, contentSha256: sha256(script), timeoutSec },
            expectedEffects: [{ action: "exec", scriptDigest: sha256(script).slice(0, 16), timeoutSec }],
          };
        }
      } catch { return null; }
      return null;
    },
    async execute({ args, contract, preconditions, callId, signal }) {
      const toolId = contract && contract.toolId;
      try {
        if (toolId === "workspace.write") {
          const content = preconditions && typeof preconditions.content === "string" ? preconditions.content : null;
          if (content == null || preconditions.contentSha256 !== sha256(content)) return { ok: false, knownNoEffect: true, error: "SIDE_EFFECT_PRECONDITION_CHANGED" };
          let res;
          try { res = workspace.writeApproved({ rel: preconditions.targetRef, content, expectedSha: preconditions.expectedHash === "absent" ? null : preconditions.expectedHash, callId }); }
          catch (e) {
            if (e && (e.code === "SIDE_EFFECT_PRECONDITION_CHANGED" || String(e.code || "").startsWith("WORKSPACE_PATH"))) return { ok: false, knownNoEffect: true, error: e.code };
            return { ok: false, ambiguous: true, error: "SIDE_EFFECT_UNKNOWN_EFFECT" };
          }
          return { ok: true, result: { ...res, contentSha256: preconditions.contentSha256, forModel: { path: res.path, bytes: res.bytes, created: res.created } } };
        }
        if (toolId === "workspace.exec") {
          const script = preconditions && typeof preconditions.script === "string" ? preconditions.script : "";
          if (!script || preconditions.contentSha256 !== sha256(script)) return { ok: false, knownNoEffect: true, error: "SIDE_EFFECT_PRECONDITION_CHANGED" };
          const res = await workspace.exec({ script, timeoutSec: preconditions.timeoutSec, signal });
          if (!res.started) return { ok: false, knownNoEffect: true, error: res.error || "WORKSPACE_EXEC_SPAWN_FAILED" };
          const out = { exitCode: res.exitCode, timedOut: res.timedOut, durationMs: res.durationMs, stdout: res.stdout, stderr: res.stderr };
          return { ok: true, result: { ...out, scriptSha256: preconditions.contentSha256, forModel: out } };
        }
        // —— 只读 ——
        if (toolId === "workspace.list") return { ok: true, result: workspace.list(args || {}) };
        if (toolId === "workspace.read") return { ok: true, result: workspace.read(args || {}) };
        if (toolId === "workspace.search") return { ok: true, result: workspace.search(args || {}) };
        return { ok: false, error: "TOOL_EXECUTION_FAILED" };
      } catch (e) { return fail(e); }
    },
    async verify({ result, contract, preconditions }) {
      const toolId = contract && contract.toolId;
      if (toolId === "workspace.write") {
        let sha = null;
        try { sha = workspace.currentSha(preconditions.targetRef); } catch { return { ok: false, detail: { reason: "VERIFIER_UNAVAILABLE" } }; }
        const applied = !!sha && sha === preconditions.contentSha256;
        return { ok: applied, applied, detail: { path: preconditions.targetRef, matches: applied } };
      }
      if (toolId === "workspace.exec") {
        const ok = !!result && result.scriptSha256 === preconditions.contentSha256 && (typeof result.exitCode === "number" || result.timedOut === true);
        return { ok, applied: ok, detail: { basis: "EXTERNAL_ACKNOWLEDGED", exitCode: result ? result.exitCode : null, timedOut: !!(result && result.timedOut) } };
      }
      return { ok: !!result, detail: {} };
    },
    /** UNKNOWN_EFFECT 恢复核查（只读）。写文件按哈希三态判定；命令的效果无法观测。 */
    async recoveryVerify({ call, preconditions }) {
      if (call && call.toolId === "workspace.write" && preconditions && preconditions.targetRef) {
        let sha = null;
        try { sha = workspace.currentSha(preconditions.targetRef); } catch { return { outcome: "INDETERMINATE", reason: "READ_BACK_FAILED" }; }
        if (sha && sha === preconditions.contentSha256) return { outcome: "APPLIED", reason: "CONTENT_MATCHES" };
        if ((sha || "absent") === preconditions.expectedHash) return { outcome: "NOT_APPLIED", reason: "FILE_UNCHANGED" };
        return { outcome: "INDETERMINATE", reason: "FILE_CHANGED_OTHERWISE" };
      }
      return { outcome: "INDETERMINATE", reason: "EXTERNAL_EFFECT_UNOBSERVABLE" };
    },
  };
}

module.exports = { createAgentWorkspace, createWorkspaceProvider, defaultWorkspaceDir, resolveInside, INTERNAL_DIR, EXEC_MAX_TIMEOUT_S };
