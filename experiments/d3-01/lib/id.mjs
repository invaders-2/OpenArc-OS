/**
 * D3-01 探针基础设施。
 *
 * 与 D1-05 / D2-01 的 Probe 同口径：**一个探针产出多条用例，不是一个布尔值**，
 * 每条用例都带实测值，产物落 artifacts/d3-01/。
 *
 * 本轮探针**不依赖 Playwright**：身份领域的判据是持久化后的真实状态与命令返回值，
 * 不需要浏览器。UI 侧另有 tests/identity-ui.mjs（真实 Electron + executeJavaScript）。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const ROOT = path.resolve(import.meta.dirname, "../../..");
export const ART = path.join(ROOT, "artifacts", "d3-01");

export const VERDICT = {
  PASS: "PASS",
  FAIL: "FAIL",
  PARTIAL: "PARTIAL",
  NOT_VERIFIED: "NOT VERIFIED",
  BLOCKED: "BLOCKED",
};

export function ensureDirs() {
  fs.mkdirSync(ART, { recursive: true });
}

export function environment() {
  return {
    os: `${os.type()} ${os.release()}`,
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    node: process.version,
    host: "Node（持久层 / 领域层真实路径，非浏览器）",
  };
}

export class Probe {
  constructor(id, title) {
    this.id = id;
    this.title = title;
    this.cases = [];
    this.notes = [];
    this.startedAt = new Date().toISOString();
  }

  case(name, status, detail) {
    this.cases.push({ name, status, detail: detail ?? "" });
    const tag = status === VERDICT.PASS ? "  " : "! ";
    console.log(`${tag}[${status}] ${name}${detail ? ` — ${detail}` : ""}`);
    return status;
  }

  note(text) {
    this.notes.push(text);
    console.log(`   · ${text}`);
  }

  assertAll(list) {
    const pass = list.filter((c) => c.status === VERDICT.PASS).length;
    const fail = list.filter((c) => c.status === VERDICT.FAIL).length;
    this.case(
      `断言 ${list.length} 条：${pass} 通过 / ${fail} 失败`,
      fail === 0 ? VERDICT.PASS : VERDICT.FAIL,
      fail === 0 ? "" : list.filter((c) => c.status === VERDICT.FAIL).map((c) => c.name).join("; "),
    );
    return fail === 0;
  }

  summary() {
    const t = {};
    for (const c of this.cases) t[c.status] = (t[c.status] || 0) + 1;
    return t;
  }

  verdict() {
    const t = this.summary();
    if (t[VERDICT.FAIL]) return VERDICT.FAIL;
    if (t[VERDICT.BLOCKED]) return VERDICT.PARTIAL;
    if (t[VERDICT.PARTIAL] || t[VERDICT.NOT_VERIFIED]) return VERDICT.PARTIAL;
    return VERDICT.PASS;
  }

  write() {
    ensureDirs();
    const out = {
      id: this.id,
      title: this.title,
      verdict: this.verdict(),
      counts: this.summary(),
      environment: environment(),
      notes: this.notes,
      cases: this.cases,
      ...(this.data ? { data: this.data } : {}),
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
    };
    const file = path.join(ART, `${this.id}.json`);
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    return { file, verdict: out.verdict, counts: out.counts };
  }
}

/* ── 夹具 ──────────────────────────────────────────────────────────────── */

/** 可控时钟（§32）：不真的等几个小时，边界 +1ms 也能精确踩到。 */
export function fakeClock(start = 1_700_000_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => {
    now += ms;
    return now;
  };
  clock.set = (v) => {
    now = v;
    return now;
  };
  return clock;
}

export function tempDir(tag = "d3") {
  return fs.mkdtempSync(path.join(os.tmpdir(), `oa-${tag}-`));
}

export function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 已删除 */
  }
}

const { IdentityStore } = require(path.join(ROOT, "electron/identity-store.cjs"));
const { IdentityService } = require(path.join(ROOT, "electron/identity-service.cjs"));
const { IdentityLogger } = require(path.join(ROOT, "electron/identity-log.cjs"));
const { SessionSecretStore, memoryBackend } = require(path.join(ROOT, "electron/session-secret-store.cjs"));

/**
 * 一组真实部件：SQLite 持久层 + 审计日志 + 内存凭据后端 + 服务。
 *
 * **全部是产品代码路径**，没有为探针开的旁路；
 * 只有 clock 与数据库路径是可注入的。
 */
export function makeFixture({ ttlMs, idleMs, clock, allowAdmin = true, dbName = "identity.db" } = {}) {
  const dir = tempDir();
  const logger = new IdentityLogger();
  const store = new IdentityStore({
    path: path.join(dir, dbName),
    clock,
    ttlMs,
    idleMs,
    onAudit: (r) => logger.log(r),
  }).open();
  const secrets = new SessionSecretStore(memoryBackend());
  const service = new IdentityService({ store, secrets, logger, allowAdmin });
  return { dir, store, secrets, logger, service, cleanup: () => cleanup(dir) };
}

/** 初始化 + 登录，返回 sessionRef。 */
export async function bootstrap(service, { identifier = "admin@openarc.local", password = "correct-horse-1", displayName = "Admin" } = {}) {
  await service.dispatch({ type: "identity/initialize", identifier, password, displayName });
  const res = await service.dispatch({ type: "identity/login", identifier, password });
  return { ...res, identifier, password };
}
