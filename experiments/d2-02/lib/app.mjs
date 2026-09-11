/**
 * D2-02 探针基础设施。
 *
 * 直接用上 D2-01 已经跑通的"起静态服务 + 起 Chromium"链路 —— 不重复造。
 * 与 D2-01 的唯一差别是：**这里打开的是真实产品页 `dist/index.html`**，
 * 不是设计系统 gallery。D2-02 要验收的是产品自身对组件的消费（§41），
 * 只有打开产品页才算数。
 */
import path from "node:path";
import fs from "node:fs";
import { VERDICT, serveDist, launch, sleep, environment, CHROMIUM } from "../../d2-01/lib/ds.mjs";

export { VERDICT, serveDist, launch, sleep, environment, CHROMIUM };

export const ROOT = path.resolve(import.meta.dirname, "../../..");
export const ART = path.join(ROOT, "artifacts", "d2-02");
export const PORT = Number(process.env.OA_PORT || 5231);

/** 真实产品页。localStorage 由探针按需预置。 */
export const appUrl = () => `http://127.0.0.1:${PORT}/index.html`;

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
    console.log(`${status === VERDICT.PASS ? "  " : "! "}[${status}] ${name}${detail ? ` — ${detail}` : ""}`);
    return status;
  }

  /** 断言：ok 为真放 PASS，否则 FAIL 并带上 detail。 */
  assert(name, ok, detail = "") {
    return this.case(name, ok ? VERDICT.PASS : VERDICT.FAIL, ok ? "" : detail);
  }

  note(text) {
    this.notes.push(text);
    console.log(`   · ${text}`);
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
    fs.mkdirSync(ART, { recursive: true });
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
