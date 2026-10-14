/**
 * UI 视觉回归基线 · 五套 UI 探针统一入口。
 *
 * 既有五套探针（skills / tasks / org / model / mcp）只做"度量对照 + 截图 + 录屏"，
 * 页面布局被改动时它们不会报警。这里补上像素级这一层：
 *   1. 依次运行既有 experiments/dxos-ui-<probe>/run-all.mjs（不改动它们），收集它们产出的截图；
 *   2. 逐张与 experiments/dxos-visual-baseline/baseline/<probe>/<name>.png 比对；
 *   3. 像素比对不引任何依赖：Playwright 打开本地页面，把两张 PNG 以 <img> 画进 canvas，
 *      用 getImageData 在浏览器里算差异（变化像素比例 / 最大通道差 / 包围盒 / 均值差），
 *      Node 侧只做阈值判定；
 *   4. 默认阈值"变化像素比例 < 0.5% 且最大通道差 <= 12"，超阈 exit 非 0，
 *      并打印逐图明细 + 把差异放大图写到 artifacts/dxos-visual-baseline/diff/。
 *
 * 用法：
 *   node experiments/dxos-visual-baseline/run-all.mjs                  # 比对（默认）
 *   node experiments/dxos-visual-baseline/run-all.mjs --update         # 用当前截图刷新 baseline
 *   node experiments/dxos-visual-baseline/run-all.mjs --probe=skills   # 只跑单套
 *   node experiments/dxos-visual-baseline/run-all.mjs --probe=mcp --update
 *
 * 退出码：任一探针失败 / 缺基准 / 度量失败 / 超阈值 → 1。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { resolveChromium, describeChromiumCandidates } from "../lib/chromium.mjs";
import { computeDiffMetrics, renderDiffImage } from "./lib/pixels.mjs";
import {
  DEFAULT_THRESHOLDS,
  formatRatio,
  classifyVerdict,
  classifyDiffKind,
  missingBaselineError,
  resolveImageAction,
  assertInsideBaseline,
  planUpdateWrites,
  summarizeReport,
  parseArgs,
} from "./lib/verdict.mjs";
import { PROBES, resolveProbeSelection } from "./lib/probes.mjs";
import { loadTolerances, mergeThresholds } from "./lib/tolerances.mjs";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "../..");
const BASELINE_DIR = path.join(HERE, "baseline");
const OUT_DIR = path.join(ROOT, "artifacts", "dxos-visual-baseline");
const DIFF_DIR = path.join(OUT_DIR, "diff");
const LOG_DIR = path.join(OUT_DIR, "logs");
const REPORT_PATH = path.join(OUT_DIR, "report.json");
/* 默认阈值口径；逐图覆写来自 tolerances.json（缺省时纯默认，见 lib/tolerances.mjs）。 */
const THRESHOLDS = DEFAULT_THRESHOLDS;
const TOLERANCES_PATH = path.join(HERE, "tolerances.json");
const DIFF_SCALE = 4;

const args = parseArgs(process.argv.slice(2));
if (args.errors.length) {
  for (const e of args.errors) console.error("! 参数错误：" + e);
  process.exit(2);
}
const selection = resolveProbeSelection(PROBES, args.probe);
if (selection.error) {
  console.error("! " + selection.error.message);
  console.error("  " + selection.error.hint);
  process.exit(2);
}

const tolerances = loadTolerances(TOLERANCES_PATH);
if (tolerances.errors.length) {
  for (const e of tolerances.errors) console.error("! tolerances.json 错误：" + e);
  process.exit(2);
}
/** 取某张图的生效阈值：默认 + 该图覆写。返回 { key, thresholds, applied, override }。 */
function thresholdsFor(probeName, imageName) {
  const key = probeName + "/" + imageName;
  const override = tolerances.overrides[key] || null;
  const { thresholds, applied } = mergeThresholds(THRESHOLDS, override);
  return { key, thresholds, applied, override };
}

const startedAt = Date.now();
const mode = args.update ? "update" : "compare";
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });
if (mode === "compare") {
  /* 差异图只反映本次运行：先清空，避免上次的报警图挂在这里误导。 */
  fs.rmSync(DIFF_DIR, { recursive: true, force: true });
}
fs.mkdirSync(DIFF_DIR, { recursive: true });

const chromiumInfo = resolveChromium();
const rel = (p) => path.relative(ROOT, p) || p;
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

console.log("UI 视觉回归基线 · dxos-visual-baseline");
console.log("模式：" + mode + "    探针：" + selection.selected.map((p) => p.name).join(", "));
console.log("默认阈值：变化像素比例 < " + formatRatio(THRESHOLDS.changedRatioMax) + " 且 最大通道差 <= " + THRESHOLDS.maxChannelDiffMax);
if (Object.keys(tolerances.overrides).length) {
  const excludedKeys = Object.keys(tolerances.overrides).filter((k) => tolerances.overrides[k].exclude === true);
  console.log("逐图阈值覆写：" + (Object.keys(tolerances.overrides).length - excludedKeys.length) + " 张，显式隔离：" + excludedKeys.length + " 张（" + rel(TOLERANCES_PATH) + "，报告里逐张标注理由）");
}
console.log("浏览器候选：" + chromiumInfo.path + "（source=" + chromiumInfo.source + "）");
console.log("");

/* ── 1. 跑探针 ─────────────────────────────────────────────────────────────── */

/** 跑一套既有探针；不改它的代码，只作为子进程调用并收尾。 */
function runProbe(probe) {
  const script = path.join(ROOT, "experiments", probe.dir, "run-all.mjs");
  const artDir = path.join(ROOT, "artifacts", probe.dir);
  const reportFile = path.join(artDir, "report.json");
  /* 先删旧报告：探针若在写报告前就崩了，绝不能把上一轮的报告当成本轮结果。 */
  if (fs.existsSync(reportFile)) fs.rmSync(reportFile, { force: true });
  const runStart = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd: ROOT, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (err) => resolve({ probe, script, artDir, reportFile, runStart, exitCode: null, signal: null, stdout, stderr: stderr + String(err) }));
    child.on("close", (code, signal) => resolve({ probe, script, artDir, reportFile, runStart, exitCode: code, signal, stdout, stderr }));
  });
}

/* ── 2. 收集截图（以探针自己写的 report.json.screenshots 为准）────────────── */

function collectScreenshots(run) {
  const result = { names: [], error: null, probeVerdict: null };
  if (!fs.existsSync(run.reportFile)) {
    result.error = {
      code: "PROBE_REPORT_MISSING",
      message: "探针没有产出 report.json：" + rel(run.reportFile),
      hint: "看 " + rel(path.join(LOG_DIR, run.probe.dir + ".log")) + " 定位探针失败原因。",
    };
    return result;
  }
  const stat = fs.statSync(run.reportFile);
  if (stat.mtimeMs < run.runStart) {
    result.error = { code: "PROBE_REPORT_STALE", message: "report.json 早于本轮运行，视为无效：" + rel(run.reportFile) };
    return result;
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(run.reportFile, "utf8"));
  } catch (err) {
    result.error = { code: "PROBE_REPORT_INVALID", message: "report.json 解析失败：" + String(err) };
    return result;
  }
  result.probeVerdict = report.verdict || null;
  const listed = Array.isArray(report.screenshots) ? report.screenshots : [];
  const seen = new Set();
  for (const file of listed) {
    const base = path.basename(file);
    if (seen.has(base)) continue;
    if (!fs.existsSync(file)) continue;
    if (fs.statSync(file).mtimeMs < run.runStart) continue;
    seen.add(base);
    result.names.push(base);
  }
  if (result.names.length === 0) {
    result.error = { code: "PROBE_NO_SCREENSHOT", message: "探针没有产出可比对的截图：" + run.probe.dir };
  }
  return result;
}

/* ── 3. 浏览器差异会话（本地页面 + canvas + getImageData）──────────────────── */

let diffSession = null;

async function openDiffSession() {
  if (diffSession) return diffSession;
  if (!chromiumInfo.path) {
    console.error("! 找不到可用 Chromium，已按优先级尝试：" + describeChromiumCandidates(chromiumInfo.candidates) + "（设置 OA_CHROMIUM 指向可用二进制）");
    process.exit(1);
  }
  const browser = await chromium.launch({ executablePath: chromiumInfo.path });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.setContent("<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\" /><title>dxos-visual-baseline diff</title></head><body></body></html>");
  /* 把同一份纯函数注入页面：浏览器与单测跑的是同一段度量代码。 */
  await page.addScriptTag({
    content:
      "window.__oaDiff = { computeDiffMetrics: " + computeDiffMetrics.toString() + ", renderDiffImage: " + renderDiffImage.toString() + " };",
  });
  diffSession = { browser, page };
  return diffSession;
}

/** 在浏览器里对一对 PNG 取像素并算差异；Node 侧不解码、不算像素。 */
async function comparePair(baselineFile, currentFile, pixelTolerance) {
  const { page } = await openDiffSession();
  const aB64 = fs.readFileSync(baselineFile).toString("base64");
  const bB64 = fs.readFileSync(currentFile).toString("base64");
  return page.evaluate(
    async ({ aB64, bB64, tolerance, diffScale }) => {
      const load = (b64) =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error("PNG 解码失败"));
          img.src = "data:image/png;base64," + b64;
        });
      const [imgA, imgB] = await Promise.all([load(aB64), load(bB64)]);
      if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
        return {
          ok: false,
          error: {
            code: "IMAGE_SIZE_MISMATCH",
            message: "尺寸不一致：基准 " + imgA.width + "×" + imgA.height + "，当前 " + imgB.width + "×" + imgB.height,
          },
          baselineSize: { width: imgA.width, height: imgA.height },
          currentSize: { width: imgB.width, height: imgB.height },
        };
      }
      const width = imgA.width;
      const height = imgA.height;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(imgA, 0, 0);
      const a = ctx.getImageData(0, 0, width, height).data;
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(imgB, 0, 0);
      const b = ctx.getImageData(0, 0, width, height).data;
      const metrics = window.__oaDiff.computeDiffMetrics(a, b, width, height, { pixelTolerance: tolerance });
      let diffDataUrl = null;
      if (metrics.ok && metrics.changedPixels > 0) {
        diffDataUrl = window.__oaDiff.renderDiffImage(a, b, width, height, metrics, { pixelTolerance: tolerance, diffScale });
      }
      return Object.assign({}, metrics, { diffDataUrl });
    },
    { aB64, bB64, tolerance: pixelTolerance, diffScale: DIFF_SCALE },
  );
}

/* ── 4. 跑完所有探针 + 收图 ───────────────────────────────────────────────── */

const probeRuns = [];
for (const probe of selection.selected) {
  process.stdout.write("[探针] " + probe.dir + "（" + probe.label + "）运行中 … ");
  const t0 = Date.now();
  const run = await runProbe(probe);
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  fs.writeFileSync(path.join(LOG_DIR, probe.dir + ".log"), "===== stdout =====\n" + run.stdout + "\n===== stderr =====\n" + run.stderr + "\n");
  const collected = collectScreenshots(run);
  const ok = run.exitCode === 0 && !collected.error;
  console.log((ok ? "OK" : "FAIL") + "  退出码=" + run.exitCode + "  截图=" + collected.names.length + "  用时=" + seconds + "s");
  probeRuns.push({ probe, run, collected, seconds: Number(seconds) });
  if (collected.error) console.log("         · " + collected.error.message);
}
console.log("");

/* ── 5. 判定 / 刷新 ────────────────────────────────────────────────────────── */

const items = [];
const failures = [];
const updates = [];
let updatedExisting = 0;

for (const entry of probeRuns) {
  const { probe, run, collected } = entry;
  if (run.exitCode !== 0) {
    failures.push({ probe: probe.name, name: "（探针退出码 " + run.exitCode + "）", status: "probe-failed", reasons: ["探针退出码 " + run.exitCode + (run.signal ? "，signal " + run.signal : "")] });
    items.push({ probe: probe.name, name: "（探针整体）", status: "probe-failed", reasons: ["探针退出码 " + run.exitCode] });
  }
  if (collected.error) {
    items.push({ probe: probe.name, name: "（截图收集）", status: "collect-error", error: collected.error, reasons: [collected.error.message] });
  }

  const writes = planUpdateWrites({ probe: probe.name, names: collected.names, artifactDir: entry.run.artDir, baselineDir: BASELINE_DIR });

  for (const write of writes) {
    const baselineFile = write.to;
    assertInsideBaseline(baselineFile, BASELINE_DIR);
    const hasBaseline = fs.existsSync(baselineFile);
    const decision = resolveImageAction({ hasBaseline, update: args.update });
    const effective = thresholdsFor(probe.name, write.name);
    const base = { probe: probe.name, name: write.name, baseline: rel(baselineFile), current: rel(write.from) };

    if (decision.action === "update-new" || decision.action === "update-existing") {
      const changed = hasBaseline ? sha256(write.from) !== sha256(baselineFile) : true;
      fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
      fs.copyFileSync(write.from, baselineFile);
      const kind = !hasBaseline ? "added" : changed ? "updated" : "unchanged";
      if (kind === "unchanged") updatedExisting += 1;
      if (kind !== "unchanged") updates.push({ probe: probe.name, name: write.name, kind, baseline: rel(baselineFile), current: rel(write.from) });
      items.push(Object.assign({}, base, { status: kind === "unchanged" ? "unchanged" : "updated", kind, thresholds: effective.thresholds, thresholdOverride: effective.applied.length ? { fields: effective.applied, reason: effective.override.reason } : null }));
      continue;
    }

    if (decision.action === "missing-baseline") {
      const error = missingBaselineError({ probe: probe.name, name: write.name, baselinePath: rel(baselineFile) });
      items.push(Object.assign({}, base, { status: "missing-baseline", error, thresholds: effective.thresholds, reasons: [error.message] }));
      failures.push({ probe: probe.name, name: write.name, status: "missing-baseline", error, reasons: [error.message] });
      continue;
    }

    /* compare */
    const metricsRaw = await comparePair(baselineFile, write.from, effective.thresholds.pixelTolerance);
    const metrics = metricsRaw.ok
      ? {
          ok: true,
          width: metricsRaw.width,
          height: metricsRaw.height,
          totalPixels: metricsRaw.totalPixels,
          changedPixels: metricsRaw.changedPixels,
          changedRatio: metricsRaw.changedRatio,
          maxChannelDiff: metricsRaw.maxChannelDiff,
          meanChannelDiff: metricsRaw.meanChannelDiff,
          bbox: metricsRaw.bbox,
          pixelTolerance: metricsRaw.pixelTolerance,
        }
      : { ok: false, error: metricsRaw.error };

    const excluded = !!(effective.override && effective.override.exclude === true);
    const verdict = excluded
      ? { status: "excluded", reasons: ["已隔离（实测不稳定，不纳入判定）：" + effective.override.reason] }
      : classifyVerdict(metrics, effective.thresholds);
    const kind = classifyDiffKind(metrics, effective.thresholds);
    const item = Object.assign({}, base, {
      status: verdict.status,
      kind,
      reasons: verdict.reasons,
      metrics: metrics.ok ? metrics : null,
      measureError: metrics.ok ? null : metrics.error,
      thresholds: effective.thresholds,
      defaultThresholds: THRESHOLDS,
      /* 被放宽的帧必须显式标记，便于在报告里一眼看到"哪些图不是用默认口径判的"。 */
      thresholdOverride: effective.applied.length ? { fields: effective.applied, reason: effective.override.reason, measured: effective.override.measured || null } : null,
      exclusion: excluded ? { reason: effective.override.reason, measured: effective.override.measured || null } : null,
    });

    if (metrics.ok && metrics.changedPixels > 0 && metricsRaw.diffDataUrl) {
      const diffFile = path.join(DIFF_DIR, probe.name + "__" + write.name);
      const b64 = String(metricsRaw.diffDataUrl).replace(/^data:image\/png;base64,/, "");
      fs.writeFileSync(diffFile, Buffer.from(b64, "base64"));
      item.diffImage = rel(diffFile);
    }

    items.push(item);
    if (verdict.status !== "pass" && verdict.status !== "excluded") failures.push(Object.assign({}, item));
  }
}

/* ── 6. 打印结果 ───────────────────────────────────────────────────────────── */

if (mode === "update") {
  console.log("--update 写入 baseline：" + rel(BASELINE_DIR));
  if (updates.length === 0) {
    console.log("  新增/变更 0 张（" + updatedExisting + " 张与基准逐字节一致）");
  } else {
    for (const u of updates) {
      console.log("  [" + (u.kind === "added" ? "新增" : "更新") + "] " + u.probe + "/" + u.name);
    }
    console.log("  新增/变更 " + updates.length + " 张，未变 " + updatedExisting + " 张");
  }
} else {
  console.log("逐图判定（默认阈值：比例 < " + formatRatio(THRESHOLDS.changedRatioMax) + "，最大差 <= " + THRESHOLDS.maxChannelDiffMax + "；带 * 的帧用了 tolerances.json 覆写）：");
  for (const it of items) {
    if (it.status === "pass") {
      const m = it.metrics || {};
      const bbox = m.bbox ? m.bbox.x + "," + m.bbox.y + " " + m.bbox.width + "×" + m.bbox.height : "—";
      const mark = it.thresholdOverride ? "*" : " ";
      console.log("  [PASS]" + mark + it.probe + "/" + it.name + "  比例=" + formatRatio(m.changedRatio) + "  最大差=" + m.maxChannelDiff + "  均值差=" + (m.meanChannelDiff || 0).toFixed(5) + "  bbox=" + bbox + "  分类=" + it.kind + (it.thresholdOverride ? "  [覆写 " + it.thresholdOverride.fields.join(",") + "]" : ""));
    } else if (it.status === "excluded") {
      const m = it.metrics || {};
      const bbox = m.bbox ? m.bbox.x + "," + m.bbox.y + " " + m.bbox.width + "×" + m.bbox.height : "—";
      const metricsText = it.metrics
        ? "比例=" + formatRatio(m.changedRatio) + "  最大差=" + m.maxChannelDiff + "  均值差=" + m.meanChannelDiff.toFixed(5) + "  bbox=" + bbox
        : "度量失败";
      console.log("  [EXCL] " + it.probe + "/" + it.name + "  " + metricsText + "  （实测不稳定，不纳入判定：见 tolerances.json）");
    } else {
      const m = it.metrics || {};
      const bbox = m.bbox ? m.bbox.x + "," + m.bbox.y + " " + m.bbox.width + "×" + m.bbox.height : "—";
      const metricsText = it.metrics
        ? "比例=" + formatRatio(m.changedRatio) + "  最大差=" + m.maxChannelDiff + "  均值差=" + m.meanChannelDiff.toFixed(5) + "  bbox=" + bbox
        : "度量失败=" + (it.measureError ? it.measureError.message : "—");
      console.log("  [FAIL] " + it.probe + "/" + it.name + "  " + metricsText + "  分类=" + (it.kind || it.status));
      for (const r of it.reasons || []) console.log("         · " + r);
      if (it.diffImage) console.log("         · 差异放大图：" + it.diffImage);
    }
  }
}

const probeFailures = probeRuns.filter((e) => e.run.exitCode !== 0 || e.collected.error);
const verdict = failures.length || probeFailures.length ? "FAIL" : "PASS";
/* update 模式的 item.status 是 added/updated/unchanged，不是通过/失败；结论由探针与写入决定。 */
const summary =
  mode === "update"
    ? { verdict, total: items.length, updated: updates.length, unchanged: updatedExisting, failed: probeFailures.length }
    : Object.assign({}, summarizeReport(items), { verdict });

/* ── 7. report.json ────────────────────────────────────────────────────────── */

const report = {
  tool: "dxos-visual-baseline",
  task: "五套 UI 探针像素级视觉回归基线",
  mode,
  verdict,
  thresholds: {
    default: THRESHOLDS,
    toleranceFile: tolerances.path ? rel(tolerances.path) : null,
    overrideCount: Object.keys(tolerances.overrides).length,
    overrides: tolerances.overrides,
  },
  browser: {
    executablePath: chromiumInfo.path,
    source: chromiumInfo.source,
    candidates: chromiumInfo.candidates.map(([s, p]) => s + "=" + p),
  },
  probes: probeRuns.map((e) => ({
    name: e.probe.name,
    dir: e.probe.dir,
    label: e.probe.label,
    script: rel(e.run.script),
    exitCode: e.run.exitCode,
    signal: e.run.signal,
    seconds: e.seconds,
    screenshotCount: e.collected.names.length,
    probeVerdict: e.collected.probeVerdict,
    screenshotNames: e.collected.names,
    log: rel(path.join(LOG_DIR, e.probe.dir + ".log")),
    error: e.collected.error,
  })),
  updates,
  images: items,
  failures,
  summary: Object.assign({}, summary, { verdict, probeFailures: probeFailures.length }),
  environment: {
    os: os.type() + " " + os.release(),
    node: process.version,
    cwd: ROOT,
  },
  startedAt: new Date(startedAt).toISOString(),
  finishedAt: new Date().toISOString(),
};
fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

console.log("");
console.log("═".repeat(72));
console.log("视觉回归结论：" + verdict + " — " + JSON.stringify(summary));
if (mode === "update") console.log("baseline：" + rel(BASELINE_DIR) + "（新增/变更 " + updates.length + " 张）");
console.log("报告：" + rel(REPORT_PATH));
if (failures.length) {
  console.log("失败明细：");
  for (const f of failures) {
    const m = f.metrics || {};
    const metricsText = f.metrics
      ? "比例=" + formatRatio(m.changedRatio) + " 最大差=" + m.maxChannelDiff + " bbox=" + (m.bbox ? m.bbox.x + "," + m.bbox.y + " " + m.bbox.width + "×" + m.bbox.height : "—")
      : (f.status || "");
    console.log("  · " + f.probe + "/" + f.name + "  " + metricsText + (f.diffImage ? "  → " + f.diffImage : ""));
    for (const r of f.reasons || []) console.log("      - " + r);
  }
}
if (probeFailures.length) {
  console.log("探针失败：");
  for (const e of probeFailures) {
    console.log("  · " + e.probe.dir + " 退出码=" + e.run.exitCode + (e.collected.error ? "  " + e.collected.error.message : ""));
  }
}

if (diffSession) await diffSession.browser.close();
process.exit(verdict === "PASS" ? 0 : 1);
