/**
 * 视觉回归的判定逻辑（纯函数，可被 tests/dxos-visual-baseline.test.mjs 直接单测）。
 *
 * 分工：浏览器负责算像素度量（lib/pixels.mjs），Node 侧只做阈值判定与动作规划。
 * 这一层刻意不碰文件系统（除了 planUpdateWrites / assertInsideBaseline 只做路径字符串运算），
 * 让"超阈值是否报警""baseline 缺失是否静默通过""--update 会写到哪"都能脱离浏览器验证。
 */
import path from "node:path";

/** 默认阈值：变化像素比例必须严格小于 0.5%，且最大通道差 <= 12。 */
export const DEFAULT_THRESHOLDS = Object.freeze({
  changedRatioMax: 0.005,
  maxChannelDiffMax: 12,
  pixelTolerance: 0,
});

/** 把比例渲染成人话百分比（用于日志与 report）。 */
export function formatRatio(ratio) {
  if (!Number.isFinite(ratio)) return "—";
  return (ratio * 100).toFixed(4) + "%";
}

/**
 * 阈值判定：比例超限和最大通道差超限都会各自产生一条 reason（两条都超就报两条）。
 * @returns {{ status: "pass" | "fail" | "error", reasons: string[] }}
 */
export function classifyVerdict(metrics, thresholds) {
  const t = thresholds || DEFAULT_THRESHOLDS;
  if (!metrics || metrics.ok !== true) {
    const detail = metrics && metrics.error ? metrics.error.message : "缺少有效度量";
    return { status: "error", reasons: ["像素度量失败：" + detail] };
  }
  const reasons = [];
  /* 阈值口径是"严格小于"：恰好等于 0.5% 也算超限。 */
  if (!(metrics.changedRatio < t.changedRatioMax)) {
    reasons.push("变化像素比例 " + formatRatio(metrics.changedRatio) + " 不低于阈值 " + formatRatio(t.changedRatioMax));
  }
  if (!(metrics.maxChannelDiff <= t.maxChannelDiffMax)) {
    reasons.push("最大通道差 " + metrics.maxChannelDiff + " 超过阈值 " + t.maxChannelDiffMax);
  }
  return { status: reasons.length ? "fail" : "pass", reasons };
}

/**
 * 差异分类：给报告一个人能读的标签。
 *   identical         逐通道零差异（连 pixelTolerance 之下的抖动都没有）
 *   within-threshold  有变化但比例与最大差都在阈值内（渲染噪声 / 时间戳 / 亚像素抖动）
 *   localized-change  差异集中在小于 5% 画面面积的包围盒里
 *   widespread-change 差异包围盒覆盖 >= 5% 画面（版面级改动）
 */
export function classifyDiffKind(metrics, thresholds) {
  const t = thresholds || DEFAULT_THRESHOLDS;
  if (!metrics || metrics.ok !== true) return "error";
  /* 注意：changedPixels 是"超过 pixelTolerance"的像素数，可能为 0 而原始通道仍有差。 */
  if (!metrics.changedPixels) return metrics.maxChannelDiff === 0 ? "identical" : "within-threshold";
  const { status } = classifyVerdict(metrics, t);
  if (status === "pass") return "within-threshold";
  const bboxArea = metrics.bbox ? metrics.bbox.width * metrics.bbox.height : metrics.totalPixels;
  const areaRatio = metrics.totalPixels > 0 ? bboxArea / metrics.totalPixels : 1;
  return areaRatio < 0.05 ? "localized-change" : "widespread-change";
}

/** baseline 缺失时的结构化错误：绝不返回"通过"，让调用方必须显式处理。 */
export function missingBaselineError({ probe, name, baselinePath }) {
  return {
    code: "BASELINE_MISSING",
    message: "基准图缺失：" + probe + "/" + name + "（" + baselinePath + "）",
    hint: "先运行 node experiments/dxos-visual-baseline/run-all.mjs --update 采集基准；缺失基准按失败处理，不静默通过。",
  };
}

/** 单图动作规划：compare 模式缺基准 → missing-baseline；update 模式永远只写基准目录。 */
export function resolveImageAction({ hasBaseline, update }) {
  if (update) return { action: hasBaseline ? "update-existing" : "update-new" };
  if (!hasBaseline) return { action: "missing-baseline" };
  return { action: "compare" };
}

/** 断言目标路径落在 baseline 目录内：--update 只允许写这里，防止越界覆盖截图源目录。 */
export function assertInsideBaseline(targetPath, baselineDir) {
  const target = path.resolve(targetPath);
  const root = path.resolve(baselineDir);
  const rel = path.relative(root, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("拒绝写入 baseline 目录之外：" + target + "（baseline 根：" + root + "）");
  }
  return target;
}

/** 规划 --update 的写入：每一项都给出源与目标，目标必定在 baseline/<probe>/ 下。 */
export function planUpdateWrites({ probe, names, artifactDir, baselineDir }) {
  return names.map((name) => ({
    probe,
    name,
    from: path.join(artifactDir, name),
    to: path.join(baselineDir, probe, name),
  }));
}

/**
 * 汇总报告总判定：任一失败项（探针失败 / 缺基准 / 超阈值 / 度量失败）即 FAIL。
 * status="excluded" 是显式隔离帧（实测不稳定、已在 tolerances.json 登记理由），
 * 它既不静默通过也不计入失败，但会单独计数并在报告里逐张列出。 */
export function summarizeReport(items) {
  const failed = items.filter((it) => it.status !== "pass" && it.status !== "excluded");
  const excluded = items.filter((it) => it.status === "excluded");
  const passed = items.filter((it) => it.status === "pass");
  return {
    verdict: failed.length ? "FAIL" : "PASS",
    total: items.length,
    passed: passed.length,
    failed: failed.length,
    excluded: excluded.length,
  };
}

/** CLI 参数解析：只认识 --update / --probe=<name>，其余按错误报出（不猜、不忽略）。 */
export function parseArgs(argv) {
  const out = { update: false, probe: null, errors: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (raw === "--update") {
      out.update = true;
      continue;
    }
    let value = null;
    if (raw.startsWith("--probe=")) {
      value = raw.slice("--probe=".length);
    } else if (raw === "--probe") {
      /* 同时接受 --probe=<name> 与 --probe <name>，两种写法指向同一语义。 */
      value = i + 1 < argv.length ? argv[i + 1] : null;
      i += 1;
    } else {
      out.errors.push("未知参数：" + raw);
      continue;
    }
    const trimmed = value == null ? "" : String(value).trim();
    if (!trimmed) out.errors.push("--probe 缺少值");
    else if (out.probe) out.errors.push("--probe 重复指定：" + out.probe + " / " + trimmed);
    else out.probe = trimmed;
  }
  return out;
}
