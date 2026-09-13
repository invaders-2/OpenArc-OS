/** D3-04C 探针基础设施。产物落 artifacts/d3-04c/。 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
export const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const ART = path.join(ROOT, "artifacts", "d3-04c");
export { createResourceFixture, reopenResourceRuntime, tempRoot, resourceDomain, searchDomain } from "../../tests/resource-fixtures.mjs";
export { pw } from "../../tests/device-fixtures.mjs";
export const VERDICT = { PASS: "PASS", FAIL: "FAIL", PARTIAL: "PARTIAL" };
export function environment() {
  return { os: os.type() + " " + os.release(), platform: process.platform, arch: process.arch, node: process.version };
}
export class Probe {
  constructor(id, title) { this.id = id; this.title = title; this.cases = []; this.notes = []; }
  case(name, status, detail) { this.cases.push({ name, status, detail: detail === undefined ? "" : String(detail) }); console.log((status === "PASS" ? "  " : "! ") + "[" + status + "] " + name + (detail ? " — " + detail : "")); return status; }
  assert(name, cond, detail) { return this.case(name, cond ? "PASS" : "FAIL", detail); }
  note(t) { this.notes.push(t); console.log("   · " + t); }
  summary() { const t = {}; for (const c of this.cases) t[c.status] = (t[c.status] || 0) + 1; return t; }
  verdict() { const t = this.summary(); if (t.FAIL) return "FAIL"; if (t.PARTIAL) return "PARTIAL"; return "PASS"; }
  finish() {
    fs.mkdirSync(ART, { recursive: true });
    const out = { id: this.id, title: this.title, verdict: this.verdict(), counts: this.summary(), environment: environment(), notes: this.notes, cases: this.cases, finishedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(ART, this.id + ".json"), JSON.stringify(out, null, 2));
    console.log("\n结论：" + out.verdict + " — " + JSON.stringify(out.counts));
    return out;
  }
}
