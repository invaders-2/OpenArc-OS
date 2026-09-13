/**
 * D3-04A 探针基础设施。产物落 artifacts/d3-04a/。
 * 场景夹具复用 tests/resource-fixtures.mjs，保证探针与单测跑同一套服务。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const ART = path.join(ROOT, "artifacts", "d3-04a");

export { createResourceFixture, reopenResourceRuntime, tempRoot, resourceDomain } from "../../tests/resource-fixtures.mjs";
export { pairDevice, pw } from "../../tests/device-fixtures.mjs";

export const VERDICT = { PASS: "PASS", FAIL: "FAIL", PARTIAL: "PARTIAL", NOT_VERIFIED: "NOT VERIFIED", BLOCKED: "BLOCKED" };

export function environment() {
  return { os: os.type() + " " + os.release(), platform: process.platform, arch: process.arch, cpus: os.cpus().length, node: process.version, host: "Node（领域层 / 持久层真实路径）" };
}

export class Probe {
  constructor(id, title) {
    this.id = id;
    this.title = title;
    this.cases = [];
    this.notes = [];
  }
  case(name, status, detail) {
    this.cases.push({ name, status, detail: detail === undefined ? "" : String(detail) });
    console.log((status === VERDICT.PASS ? "  " : "! ") + "[" + status + "] " + name + (detail ? " — " + detail : ""));
    return status;
  }
  assert(name, condition, detail) {
    return this.case(name, condition ? VERDICT.PASS : VERDICT.FAIL, detail);
  }
  note(text) {
    this.notes.push(text);
    console.log("   · " + text);
  }
  summary() {
    const t = {};
    for (const c of this.cases) t[c.status] = (t[c.status] || 0) + 1;
    return t;
  }
  verdict() {
    const t = this.summary();
    if (t[VERDICT.FAIL]) return VERDICT.FAIL;
    if (t[VERDICT.BLOCKED] || t[VERDICT.PARTIAL] || t[VERDICT.NOT_VERIFIED]) return VERDICT.PARTIAL;
    return VERDICT.PASS;
  }
  finish() {
    fs.mkdirSync(ART, { recursive: true });
    const out = { id: this.id, title: this.title, verdict: this.verdict(), counts: this.summary(), environment: environment(), notes: this.notes, cases: this.cases, finishedAt: new Date().toISOString() };
    const file = path.join(ART, this.id + ".json");
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    console.log("\n结论：" + out.verdict + " — " + JSON.stringify(out.counts));
    console.log("产物：" + file);
    return out;
  }
}
