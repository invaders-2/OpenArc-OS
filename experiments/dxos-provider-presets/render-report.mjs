#!/usr/bin/env node
/** dxos-provider-presets · report.json → REPORT.md（真机验收报告）。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ART = path.join(ROOT, "artifacts", "dxos-provider-presets");
const report = JSON.parse(fs.readFileSync(path.join(ART, "report.json"), "utf8"));

const lines = [];
lines.push("# dxos-provider-presets · 真机验收报告");
lines.push("");
lines.push("生成时间：" + report.at + "　·　Electron：" + report.electron + "　·　CDP 端口：" + report.cdpPort);
lines.push("");
lines.push("## 结果");
lines.push("");
lines.push("- 总览：PASS=" + report.passed + "，FAIL=" + report.failed + (report.ok ? "（通过）" : "（未通过）"));
lines.push("");
for (const row of report.rows) {
  lines.push("- " + (row.ok ? "PASS" : "FAIL") + " · **" + row.name + "** — 期望：" + row.expected + "；实际：" + row.actual);
}
lines.push("");
lines.push("## 预设（真机读回）");
lines.push("");
lines.push("| id | adapterType | 凭据形态 | 协议状态 | 品牌图标 |");
lines.push("|---|---|---|---|---|");
for (const p of report.evidence.presets || []) {
  lines.push("| " + p.id + " | " + p.adapter + " | " + p.mode + " | " + p.status + " | " + (p.logo || "（无品牌资源，彩色首字母回退）") + " |");
}
lines.push("");
const shotGroups = ["p1Shots", "p2Shots", "p3Shots", "p4Shots", "p5Shots"];
const allShots = [];
for (const key of shotGroups) for (const s of report.evidence[key] || []) allShots.push(s);
if (report.evidence.narrowShot) allShots.push(report.evidence.narrowShot);
lines.push("## 截图（" + Array.from(new Set(allShots.map((s) => s.width + "x" + s.height))).join(" / ") + "）");
lines.push("");
for (const s of allShots) lines.push("- " + s.file + "（" + s.width + "x" + s.height + "）");
lines.push("");
lines.push("## 页面错误");
lines.push("");
lines.push("- console error：" + JSON.stringify(report.evidence.consoleErrors || []));
lines.push("- pageerror：" + JSON.stringify(report.evidence.pageErrors || []));
lines.push("");
lines.push("## 复跑");
lines.push("");
lines.push("    npm run build");
lines.push("    node experiments/dxos-provider-presets/run.mjs");
lines.push("    node experiments/dxos-provider-presets/render-report.mjs");
lines.push("");
fs.writeFileSync(path.join(ART, "REPORT.md"), lines.join("\n"), "utf8");
console.log("已写 " + path.relative(ROOT, path.join(ART, "REPORT.md")));
