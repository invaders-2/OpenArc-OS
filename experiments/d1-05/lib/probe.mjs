// D1-05 共用探针基础设施。
//
// 设计约束（来自本轮任务书）：
//   - 全部使用 fake data / 临时目录 / localhost / 测试证书；
//   - 不碰用户真实文件或密钥；
//   - 每项结论必须带证据，不能靠"理论上应该安全"。
//
// 结论口径（五档，必须明确区分）：
//   PASS          —— 本机真实验证通过
//   FAIL          —— 本机真实验证不通过
//   PARTIAL       —— 部分通过 / 有明确未覆盖分支
//   NOT VERIFIED  —— 未取得证据（如 Windows）
//   BLOCKED       —— 环境不允许验证

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

// lib/probe.mjs → experiments/d1-05/lib → 上溯三层才是仓库根
export const ROOT = path.resolve(import.meta.dirname, "../../..");
export const ART = path.join(ROOT, "artifacts", "d1-05");
export const SANDBOX = path.join(ART, "sandbox");
export const PROFILES_DIR = path.join(SANDBOX, "profiles");
export const TLS = path.join(ART, "tls");
export const TMP = path.join(ART, "tmp");

export const VERDICT = {
  PASS: "PASS",
  FAIL: "FAIL",
  PARTIAL: "PARTIAL",
  NOT_VERIFIED: "NOT VERIFIED",
  BLOCKED: "BLOCKED",
};

export function ensureDirs() {
  for (const d of [
    ART,
    SANDBOX,
    path.join(SANDBOX, "allowed"),
    path.join(SANDBOX, "denied"),
    PROFILES_DIR,
    TLS,
    TMP,
  ])
    fs.mkdirSync(d, { recursive: true });
}

export function environment() {
  return {
    os: `${os.type()} ${os.release()}`,
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model,
    ramGB: Math.round(os.totalmem() / 1024 ** 3),
    node: process.version,
    hostname: os.hostname(),
    loadavg: os.loadavg().map((n) => +n.toFixed(2)),
    user: os.userInfo().username,
    uid: process.getuid ? process.getuid() : null,
  };
}

/** 生成一次性假密钥。格式刻意做成"像真密钥"，用于验证脱敏。 */
export function fakeSecret(label = "OPENARC_D1_05_SECRET") {
  const rand = crypto.randomBytes(24).toString("base64url");
  return { name: `${label}_${crypto.randomBytes(4).toString("hex")}`, value: `sk-fake-d105-${rand}` };
}

/**
 * 只用于取证的对账指纹。**禁止**把密钥明文或其前缀写进产物/日志，
 * 所以凡是需要在报告里指代某个密钥，一律用这个函数。
 */
export function sha256(s, len = 16) {
  return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, len);
}

/** 一串文本里是否有密钥形态（用于"日志里出现明文"的判定）。 */
export function containsSecret(haystack, secret) {
  if (!secret) return false;
  return String(haystack).includes(secret);
}

/** 把一整棵目录树里的文件内容全部读出来，用于"磁盘上能不能搜到明文"。 */
export function grepTree(dir, needle, opts = {}) {
  const hits = [];
  const maxBytes = opts.maxBytes ?? 4 * 1024 * 1024;
  let scanned = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) {
        hits.push({ path: p, kind: "symlink-target-not-followed" });
        continue;
      }
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!e.isFile()) continue;
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (st.size > maxBytes) {
        hits.push({ path: p, kind: "skipped-too-large", size: st.size });
        continue;
      }
      scanned++;
      let buf;
      try {
        buf = fs.readFileSync(p);
      } catch {
        hits.push({ path: p, kind: "unreadable" });
        continue;
      }
      if (buf.includes(Buffer.from(needle))) hits.push({ path: p, kind: "PLAINTEXT-HIT" });
    }
  };
  walk(dir);
  // 只回指纹，绝不回明文片段——产物本身也不能成为泄漏面。
  return { needleSha256: sha256(needle), scannedFiles: scanned, hits };
}

export class Probe {
  constructor(id, title) {
    this.id = id;
    this.title = title;
    this.cases = [];
    this.notes = [];
    this.secrets = [];
    this.startedAt = new Date().toISOString();
    ensureDirs();
  }

  /**
   * 登记一个"绝不允许出现在产物里"的明文。
   * write() 落盘前会强制扫描并脱敏，产物本身不能成为新的泄漏面。
   */
  registerSecret(value, label = "secret") {
    if (value) this.secrets.push({ value: String(value), label });
    return this;
  }

  /** 记一条判定。detail 里禁止放真实密钥。 */
  case(name, verdict, detail = {}, expected = undefined) {
    const row = { name, verdict, expected, ...detail };
    this.cases.push(row);
    const mark = verdict === VERDICT.PASS ? "PASS" : verdict === VERDICT.FAIL ? "**FAIL**" : verdict;
    console.log(`  [${mark}] ${name}${detail.note ? " — " + detail.note : ""}`);
    return row;
  }

  /** 一个 case 里做多个断言时，用来汇总：全过 PASS，否则 FAIL。 */
  assertAll(name, asserter) {
    const failed = [];
    const detail = asserter((cond, label, extra) => {
      if (!cond) failed.push(label + (extra ? ` (${extra})` : ""));
    });
    return this.case(name, failed.length ? VERDICT.FAIL : VERDICT.PASS, {
      ...detail,
      failures: failed.length ? failed : undefined,
    });
  }

  note(text) {
    this.notes.push(text);
  }

  summary() {
    const counts = {};
    for (const c of this.cases) counts[c.verdict] = (counts[c.verdict] || 0) + 1;
    const worst = this.cases.some((c) => c.verdict === VERDICT.FAIL)
      ? VERDICT.FAIL
      : this.cases.some((c) => c.verdict === VERDICT.PARTIAL)
        ? VERDICT.PARTIAL
        : this.cases.length
          ? VERDICT.PASS
          : VERDICT.NOT_VERIFIED;
    return {
      id: this.id,
      title: this.title,
      verdict: worst,
      counts,
      cases: this.cases,
      notes: this.notes,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  write() {
    const file = path.join(ART, `${this.id}.json`);

    // ① 落盘前扫描：有没有登记过的明文混进了产物
    const firstPass = JSON.stringify(this.summary(), null, 2);
    const leaks = [];
    for (const { value, label } of this.secrets) {
      const n = firstPass.split(value).length - 1;
      if (n) leaks.push({ label, occurrences: n, sha256: sha256(value, 12) });
    }
    this.case(
      "产物自查：落盘前扫描已登记密钥明文",
      leaks.length === 0 ? VERDICT.PASS : VERDICT.PARTIAL,
      {
        registeredSecrets: this.secrets.length,
        leaks,
        note: leaks.length
          ? "产物序列化结果中曾出现明文，已在写入前强制替换为占位符；该条判为 PARTIAL。"
          : "序列化结果中未出现任何已登记的密钥明文，产物可直接落盘。",
      }
    );

    // ② 最终序列化 + 强制脱敏（即使上面判了 PARTIAL，落盘内容也不含明文）
    let json = JSON.stringify(this.summary(), null, 2);
    let replaced = 0;
    for (const { value, label } of this.secrets) {
      if (json.includes(value)) {
        replaced += json.split(value).length - 1;
        json = json.split(value).join(`«REDACTED:${label}»`);
      }
    }
    fs.writeFileSync(file, json);

    const s = this.summary();
    console.log(`\n== ${this.id} 结论：${s.verdict} — ${JSON.stringify(s.counts)}`);
    if (replaced) console.log(`   产物写盘前强制脱敏 ${replaced} 处明文`);
    console.log(`   产物：${path.relative(ROOT, file)}\n`);
    return s;
  }
}

/**
 * 收集子进程输出（不注入 shell）。用于替代系统工具做取证，如 security / sandbox-exec / clang。
 * 注意：被信号杀死时 code 为 null，必须同时看 signal（例如 SIGXCPU / SIGXFSZ）。
 */
export function execFile(file, args, opts = {}) {
  return new Promise((resolve) => {
    const cp = spawn(file, args, { ...opts, shell: false });
    let out = "",
      err = "";
    cp.stdout?.on("data", (d) => (out += d));
    cp.stderr?.on("data", (d) => (err += d));
    cp.on("error", (e) => resolve({ code: -1, signal: null, out, err: String(e), error: true }));
    cp.on("close", (code, signal) => resolve({ code, signal, out, err }));
  });
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
