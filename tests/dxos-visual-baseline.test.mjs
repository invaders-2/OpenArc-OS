/**
 * Dx-UI 视觉回归基线 · 纯逻辑单测。
 *
 * 只测不依赖浏览器的部分：像素度量数学、阈值判定、差异分类、缺失基准的结构化报错、
 * --update 的写入规划与目录守卫、CLI 参数解析。真实像素比对由
 * experiments/dxos-visual-baseline/run-all.mjs 端到端跑（见该目录 README 的自证输出）。
 *
 * 运行：node --test tests/dxos-visual-baseline.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { computeDiffMetrics, renderDiffImage } from "../experiments/dxos-visual-baseline/lib/pixels.mjs";
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
} from "../experiments/dxos-visual-baseline/lib/verdict.mjs";
import { PROBES, resolveProbeSelection } from "../experiments/dxos-visual-baseline/lib/probes.mjs";
import { mergeThresholds, loadTolerances } from "../experiments/dxos-visual-baseline/lib/tolerances.mjs";
import fs from "node:fs";
import os from "node:os";

/** 造一幅纯色 RGBA 图。 */
function solid(width, height, [r, g, b, a = 255]) {
  const buf = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = a;
  }
  return buf;
}

/** 在副本上把指定像素改成给定值。 */
function withPixels(base, width, points) {
  const buf = Uint8ClampedArray.from(base);
  for (const p of points) {
    const i = (p.y * width + p.x) * 4;
    buf[i] = p.rgba[0];
    buf[i + 1] = p.rgba[1];
    buf[i + 2] = p.rgba[2];
    buf[i + 3] = p.rgba[3] === undefined ? 255 : p.rgba[3];
  }
  return buf;
}

/* ── 像素度量 ─────────────────────────────────────────────────────────────── */

test("computeDiffMetrics：完全相同的两图 → 0 变化、bbox 为 null", () => {
  const a = solid(10, 8, [10, 20, 30]);
  const b = solid(10, 8, [10, 20, 30]);
  const m = computeDiffMetrics(a, b, 10, 8);
  assert.equal(m.ok, true);
  assert.equal(m.totalPixels, 80);
  assert.equal(m.changedPixels, 0);
  assert.equal(m.changedRatio, 0);
  assert.equal(m.maxChannelDiff, 0);
  assert.equal(m.meanChannelDiff, 0);
  assert.equal(m.bbox, null);
});

test("computeDiffMetrics：单像素变化 → 包围盒精确、均值按通道数摊薄", () => {
  const width = 100;
  const height = 100;
  const a = solid(width, height, [0, 0, 0]);
  const b = withPixels(a, width, [{ x: 7, y: 9, rgba: [30, 0, 0] }]);
  const m = computeDiffMetrics(a, b, width, height);
  assert.equal(m.changedPixels, 1);
  assert.equal(m.changedRatio, 1 / 10000);
  assert.equal(m.maxChannelDiff, 30);
  assert.deepEqual(m.bbox, { x: 7, y: 9, width: 1, height: 1 });
  // 30 / (10000 像素 × 4 通道)
  assert.equal(m.meanChannelDiff, 30 / 40000);
});

test("computeDiffMetrics：多像素变化的包围盒覆盖最左上与最右下", () => {
  const width = 20;
  const height = 20;
  const a = solid(width, height, [0, 0, 0]);
  const b = withPixels(a, width, [
    { x: 2, y: 3, rgba: [5, 5, 5] },
    { x: 15, y: 17, rgba: [5, 5, 5] },
    { x: 15, y: 3, rgba: [5, 5, 5] },
  ]);
  const m = computeDiffMetrics(a, b, width, height);
  assert.equal(m.changedPixels, 3);
  assert.deepEqual(m.bbox, { x: 2, y: 3, width: 14, height: 15 });
});

test("computeDiffMetrics：pixelTolerance 之下的抖动不算变化像素", () => {
  const width = 50;
  const height = 50;
  const a = solid(width, height, [100, 100, 100]);
  const b = withPixels(a, width, [{ x: 1, y: 1, rgba: [103, 100, 100] }]);
  const strict = computeDiffMetrics(a, b, width, height);
  const tolerant = computeDiffMetrics(a, b, width, height, { pixelTolerance: 4 });
  assert.equal(strict.changedPixels, 1);
  assert.equal(tolerant.changedPixels, 0);
  assert.equal(tolerant.maxChannelDiff, 3, "容差只影响变化像素，不影响最大通道差");
});

test("computeDiffMetrics：缓冲区/尺寸非法 → 结构化错误而不是抛异常", () => {
  const a = solid(4, 4, [0, 0, 0]);
  assert.equal(computeDiffMetrics(a, solid(4, 4, [0, 0, 0]), 4, 4).ok, true);
  assert.equal(computeDiffMetrics(a, solid(3, 4, [0, 0, 0]), 4, 4).ok, false);
  assert.equal(computeDiffMetrics(a, solid(4, 4, [0, 0, 0]), 4, 4).error, undefined);
  const bad = computeDiffMetrics(a, solid(3, 4, [0, 0, 0]), 4, 4);
  assert.equal(bad.error.code, "PIXEL_BUFFER_SIZE");
  assert.equal(computeDiffMetrics(null, a, 4, 4).error.code, "PIXEL_BUFFER_MISSING");
  assert.equal(computeDiffMetrics(a, a, 0, 4).error.code, "IMAGE_SIZE_INVALID");
});

test("注入浏览器的函数源码必须自包含（可被 toString 后重新求值）", () => {
  for (const fn of [computeDiffMetrics, renderDiffImage]) {
    const src = fn.toString();
    assert.equal(typeof new Function("return (" + src + ");")(), "function");
    assert.equal(/\bimport\b|\brequire\(/.test(src), false, "注入源码不得含模块引用");
  }
});

/* ── 阈值判定 ─────────────────────────────────────────────────────────────── */

function metricsOf(overrides) {
  return Object.assign(
    {
      ok: true,
      width: 200,
      height: 200,
      totalPixels: 40000,
      changedPixels: 1,
      changedRatio: 1 / 40000,
      maxChannelDiff: 1,
      meanChannelDiff: 0,
      bbox: { x: 0, y: 0, width: 1, height: 1 },
      pixelTolerance: 0,
    },
    overrides,
  );
}

test("classifyVerdict：阈值内通过", () => {
  const v = classifyVerdict(metricsOf({}), DEFAULT_THRESHOLDS);
  assert.equal(v.status, "pass");
  assert.deepEqual(v.reasons, []);
});

test("classifyVerdict：比例恰好 0.5% 判失败（口径是严格小于）", () => {
  const at = classifyVerdict(metricsOf({ changedPixels: 200, changedRatio: 0.005 }), DEFAULT_THRESHOLDS);
  assert.equal(at.status, "fail");
  assert.equal(at.reasons.length, 1);
  assert.match(at.reasons[0], /变化像素比例/);
  const below = classifyVerdict(metricsOf({ changedPixels: 199, changedRatio: 199 / 40000 }), DEFAULT_THRESHOLDS);
  assert.equal(below.status, "pass");
});

test("classifyVerdict：最大通道差 12 通过、13 失败（口径是 <= 12）", () => {
  assert.equal(classifyVerdict(metricsOf({ maxChannelDiff: 12 }), DEFAULT_THRESHOLDS).status, "pass");
  const over = classifyVerdict(metricsOf({ maxChannelDiff: 13 }), DEFAULT_THRESHOLDS);
  assert.equal(over.status, "fail");
  assert.match(over.reasons[0], /最大通道差 13/);
});

test("classifyVerdict：两项同时超限 → 两条 reason 都报", () => {
  const v = classifyVerdict(metricsOf({ changedPixels: 30000, changedRatio: 0.75, maxChannelDiff: 200 }), DEFAULT_THRESHOLDS);
  assert.equal(v.status, "fail");
  assert.equal(v.reasons.length, 2);
});

test("classifyVerdict：度量失败 → error，绝不判通过", () => {
  const v = classifyVerdict({ ok: false, error: { code: "PIXEL_BUFFER_SIZE", message: "长度不符" } }, DEFAULT_THRESHOLDS);
  assert.equal(v.status, "error");
  assert.notEqual(v.status, "pass");
  assert.match(v.reasons[0], /长度不符/);
});

test("formatRatio：比例渲染为百分比字符串", () => {
  assert.equal(formatRatio(0), "0.0000%");
  assert.equal(formatRatio(0.005), "0.5000%");
  assert.equal(formatRatio(NaN), "—");
});

/* ── 差异分类 ─────────────────────────────────────────────────────────────── */

test("classifyDiffKind：无差异 / 阈值内 / 局部 / 全局", () => {
  assert.equal(classifyDiffKind(metricsOf({ changedPixels: 0, changedRatio: 0, maxChannelDiff: 0, bbox: null })), "identical");
  // 容差把变化像素压到 0，但原始通道仍有差 → 不能叫 identical
  assert.equal(classifyDiffKind(metricsOf({ changedPixels: 0, changedRatio: 0, maxChannelDiff: 2, bbox: null, pixelTolerance: 4 })), "within-threshold");
  assert.equal(classifyDiffKind(metricsOf({})), "within-threshold");
  // 单像素但通道差很大 → 局部变化
  assert.equal(classifyDiffKind(metricsOf({ maxChannelDiff: 200 })), "localized-change");
  // 大面积且超差 → 全局变化
  assert.equal(
    classifyDiffKind(metricsOf({ changedPixels: 20000, changedRatio: 0.5, maxChannelDiff: 200, bbox: { x: 0, y: 0, width: 200, height: 200 } })),
    "widespread-change",
  );
  assert.equal(classifyDiffKind({ ok: false, error: { code: "x", message: "y" } }), "error");
});

/* ── baseline 缺失：结构化报错，不静默通过 ─────────────────────────────────── */

test("resolveImageAction：compare 模式缺基准 → missing-baseline（不通过）", () => {
  const d = resolveImageAction({ hasBaseline: false, update: false });
  assert.equal(d.action, "missing-baseline");
  assert.notEqual(d.action, "compare");
  const err = missingBaselineError({ probe: "skills", name: "01-loading.png", baselinePath: "baseline/skills/01-loading.png" });
  assert.equal(err.code, "BASELINE_MISSING");
  assert.match(err.message, /基准图缺失：skills\/01-loading.png/);
  assert.match(err.hint, /--update/);
});

test("缺基准的场景整体判 FAIL（不是空集静默通过）", () => {
  const decision = resolveImageAction({ hasBaseline: false, update: false });
  const item =
    decision.action === "missing-baseline"
      ? { probe: "org", name: "07-ready.png", status: "missing-baseline", reasons: [missingBaselineError({ probe: "org", name: "07-ready.png", baselinePath: "b" }).message] }
      : { status: "pass" };
  const summary = summarizeReport([item]);
  assert.equal(summary.verdict, "FAIL");
  assert.equal(summary.passed, 0);
  assert.equal(summary.failed, 1);
});

test("resolveImageAction：update 模式只产出写入动作，永远不报缺基准", () => {
  assert.equal(resolveImageAction({ hasBaseline: false, update: true }).action, "update-new");
  assert.equal(resolveImageAction({ hasBaseline: true, update: true }).action, "update-existing");
  assert.equal(resolveImageAction({ hasBaseline: true, update: false }).action, "compare");
});

/* ── --update 只写 baseline 目录 ───────────────────────────────────────────── */

test("planUpdateWrites：目标全部落在 baseline/<probe>/ 下", () => {
  const baselineDir = path.join("/repo", "experiments", "dxos-visual-baseline", "baseline");
  const artifactDir = path.join("/repo", "artifacts", "dxos-ui-org");
  const writes = planUpdateWrites({ probe: "org", names: ["01-loading.png", "compare-org.png"], artifactDir, baselineDir });
  assert.equal(writes.length, 2);
  for (const w of writes) {
    assert.equal(path.dirname(w.to), path.join(baselineDir, "org"));
    assert.equal(w.from, path.join(artifactDir, w.name));
    assert.equal(assertInsideBaseline(w.to, baselineDir), path.resolve(w.to));
  }
});

test("assertInsideBaseline：越界目标必须抛错（目录外 / 上跳 / 根目录本身）", () => {
  const baselineDir = path.join("/repo", "experiments", "dxos-visual-baseline", "baseline");
  assert.throws(() => assertInsideBaseline(path.join("/repo", "artifacts", "x.png"), baselineDir), /拒绝写入 baseline 目录之外/);
  assert.throws(() => assertInsideBaseline(path.join(baselineDir, "..", "..", "x.png"), baselineDir), /拒绝写入 baseline 目录之外/);
  assert.throws(() => assertInsideBaseline(baselineDir, baselineDir), /拒绝写入 baseline 目录之外/);
  assert.equal(assertInsideBaseline(path.join(baselineDir, "mcp", "01.png"), baselineDir), path.join(baselineDir, "mcp", "01.png"));
});

/* ── CLI 参数与探针选择 ───────────────────────────────────────────────────── */

test("parseArgs：--update / --probe=<name> / 组合", () => {
  assert.deepEqual(parseArgs([]), { update: false, probe: null, errors: [] });
  assert.deepEqual(parseArgs(["--update"]), { update: true, probe: null, errors: [] });
  assert.deepEqual(parseArgs(["--probe=skills"]), { update: false, probe: "skills", errors: [] });
  assert.deepEqual(parseArgs(["--probe", "skills"]), { update: false, probe: "skills", errors: [] });
  assert.equal(parseArgs(["--probe"]).errors.length, 1);
  assert.deepEqual(parseArgs(["--probe=skills", "--update"]), { update: true, probe: "skills", errors: [] });
  assert.equal(parseArgs(["--probe="]).errors.length, 1);
  assert.equal(parseArgs(["--probe=skills", "--probe=org"]).errors.length, 1);
  assert.equal(parseArgs(["--nope"]).errors.length, 1);
});

test("resolveProbeSelection：短名 / 目录名 / 未知名", () => {
  assert.equal(resolveProbeSelection(PROBES, null).selected.length, PROBES.length);
  assert.deepEqual(resolveProbeSelection(PROBES, "skills").selected.map((p) => p.dir), ["dxos-ui-skills"]);
  assert.deepEqual(resolveProbeSelection(PROBES, "dxos-ui-mcp").selected.map((p) => p.name), ["mcp"]);
  const bad = resolveProbeSelection(PROBES, "nope");
  assert.equal(bad.selected.length, 0);
  assert.equal(bad.error.code, "PROBE_UNKNOWN");
  assert.match(bad.error.hint, /skills/);
});

test("PROBES：恰好覆盖五套既有探针且短名唯一", () => {
  assert.equal(PROBES.length, 5);
  assert.deepEqual(PROBES.map((p) => p.dir), ["dxos-ui-skills", "dxos-ui-tasks", "dxos-ui-org", "dxos-ui-model", "dxos-ui-mcp"]);
  assert.equal(new Set(PROBES.map((p) => p.name)).size, 5);
});

/* ── 汇总 ─────────────────────────────────────────────────────────────────── */

test("summarizeReport：全通过 → PASS；任一失败 → FAIL", () => {
  assert.equal(summarizeReport([{ status: "pass" }, { status: "pass" }]).verdict, "PASS");
  const s = summarizeReport([{ status: "pass" }, { status: "fail" }]);
  assert.equal(s.verdict, "FAIL");
  assert.equal(s.total, 2);
  assert.equal(s.passed, 1);
  assert.equal(s.failed, 1);
});
/* ── 逐图阈值覆写：必须有理由，不能无理由放宽 ─────────────────────────────── */

test("mergeThresholds：默认阈值 + 单字段覆写", () => {
  const plain = mergeThresholds(DEFAULT_THRESHOLDS, null);
  assert.deepEqual(plain.thresholds, DEFAULT_THRESHOLDS);
  assert.deepEqual(plain.applied, []);

  const merged = mergeThresholds(DEFAULT_THRESHOLDS, { pixelTolerance: 3, reason: "深色图 ±2 抖动" });
  assert.equal(merged.thresholds.pixelTolerance, 3);
  assert.equal(merged.thresholds.maxChannelDiffMax, DEFAULT_THRESHOLDS.maxChannelDiffMax, "未覆写字段保持默认");
  assert.deepEqual(merged.applied, ["pixelTolerance"]);

  const both = mergeThresholds(DEFAULT_THRESHOLDS, { changedRatioMax: 0.5, maxChannelDiffMax: 160, pixelTolerance: 0, reason: "x" });
  assert.equal(both.applied.length, 3, "pixelTolerance=0 是有意义的值，也要算覆写");
});

test("loadTolerances：缺文件 → 纯默认，不算错误", () => {
  const missing = path.join(os.tmpdir(), "dxos-vb-not-exist-" + Date.now() + ".json");
  const r = loadTolerances(missing);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.overrides, {});
  assert.deepEqual(r.defaultThresholds, DEFAULT_THRESHOLDS);
});

test("loadTolerances：覆写缺 reason / 未知字段 / 空覆写 → 结构化错误", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-vb-"));
  const file = path.join(dir, "tolerances.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      overrides: {
        "org/01.png": { maxChannelDiffMax: 20 },
        "org/02.png": { reason: "有理由", nonsense: 1 },
        "org/03.png": { reason: "只写了理由" },
        "org/04.png": { reason: "合法", pixelTolerance: 2 },
      },
    }),
  );
  const r = loadTolerances(file);
  assert.equal(r.errors.length, 4, JSON.stringify(r.errors));
  assert.match(r.errors.join(" "), /org\/01\.png 缺少 reason/);
  assert.match(r.errors.join(" "), /未知字段 nonsense/);
  assert.match(r.errors.join(" "), /org\/02\.png 既没有阈值字段也没有 exclude=true/);
  assert.match(r.errors.join(" "), /org\/03\.png 既没有阈值字段也没有 exclude=true/);
  assert.ok(r.overrides["org/04.png"], "合法覆写仍被保留");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadTolerances：损坏 JSON → 结构化错误而不是抛异常", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-vb-"));
  const file = path.join(dir, "tolerances.json");
  fs.writeFileSync(file, "{ not json");
  const r = loadTolerances(file);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /解析失败/);
  fs.rmSync(dir, { recursive: true, force: true });
});
/* ── 显式隔离帧：只测量、不纳入判定，也不算静默通过 ─────────────────────── */

test("summarizeReport：excluded 帧单独计数，不影响 PASS/FAIL", () => {
  const s = summarizeReport([{ status: "pass" }, { status: "excluded" }]);
  assert.equal(s.verdict, "PASS");
  assert.equal(s.passed, 1);
  assert.equal(s.excluded, 1);
  assert.equal(s.failed, 0);
  // 隔离 + 真失败 → 仍然 FAIL
  assert.equal(summarizeReport([{ status: "excluded" }, { status: "fail" }]).verdict, "FAIL");
  // 隔离不算通过
  assert.notEqual(summarizeReport([{ status: "excluded" }]).passed, 1);
});

test("loadTolerances：exclude=true 需带 reason，且不要求阈值字段", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-vb-"));
  const file = path.join(dir, "tolerances.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      overrides: {
        "model/11.png": { exclude: true, reason: "取消中状态滚动竞态" },
        "model/12.png": { exclude: true },
      },
    }),
  );
  const r = loadTolerances(file);
  assert.equal(r.errors.length, 1, JSON.stringify(r.errors));
  assert.match(r.errors[0], /model\/12\.png 缺少 reason/);
  assert.ok(r.overrides["model/11.png"], "合法的隔离项被保留");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("mergeThresholds：不把 exclude 当成阈值字段", () => {
  const merged = mergeThresholds(DEFAULT_THRESHOLDS, { exclude: true, reason: "x" });
  assert.deepEqual(merged.applied, []);
  assert.deepEqual(merged.thresholds, DEFAULT_THRESHOLDS);
});
