/**
 * 逐图阈值覆写（tolerances.json）的加载与合并。
 *
 * 为什么要这层：默认阈值（比例 < 0.5% 且最大通道差 <= 12）对确定性截图够用，
 * 但实测有几帧本身不稳定——深色对照图有整页 ±1~2 级栅格化抖动，流式输出帧带闪烁光标。
 * 这些不是视觉回归，却会被默认阈值误判。这里允许对具体帧做"有理由、有实测证据"的逐图覆写，
 * 而覆写必须显式写在 tolerances.json 里、带 reason 与 measured，报告里也会标出被放宽的帧，
 * 绝不静默放行。
 */
import fs from "node:fs";
import { DEFAULT_THRESHOLDS } from "./verdict.mjs";

const NUMERIC_FIELDS = ["changedRatioMax", "maxChannelDiffMax", "pixelTolerance"];
/* exclude=true 表示该帧实测不稳定、不纳入判定；它不是阈值放宽，仍需 reason 与实测证据。 */
const ALLOWED_META_FIELDS = ["reason", "measured", "exclude"];

/** 合并默认阈值与单图覆写；返回 { thresholds, applied }，applied 记录实际被覆写的字段。 */
export function mergeThresholds(base, override) {
  const thresholds = {
    changedRatioMax: base.changedRatioMax,
    maxChannelDiffMax: base.maxChannelDiffMax,
    pixelTolerance: base.pixelTolerance,
  };
  const applied = [];
  if (override && typeof override === "object") {
    for (const field of NUMERIC_FIELDS) {
      if (Number.isFinite(override[field])) {
        thresholds[field] = override[field];
        applied.push(field);
      }
    }
  }
  return { thresholds, applied };
}

/** 校验单条覆写：必须有非空 reason（防止无理由放宽 / 无理由隔离）。 */
function validateOverride(key, value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["覆写 " + key + " 必须是对象"];
  }
  if (typeof value.reason !== "string" || value.reason.trim() === "") {
    errors.push("覆写 " + key + " 缺少 reason（不允许无理由放宽阈值或隔离）");
  }
  const excluded = value.exclude === true;
  if (value.exclude !== undefined && typeof value.exclude !== "boolean") {
    errors.push("覆写 " + key + " 的 exclude 必须是布尔值");
  }
  for (const field of Object.keys(value)) {
    if (ALLOWED_META_FIELDS.includes(field)) continue;
    if (!NUMERIC_FIELDS.includes(field)) errors.push("覆写 " + key + " 含未知字段 " + field);
    else if (!Number.isFinite(value[field])) errors.push("覆写 " + key + " 的 " + field + " 必须是数字");
  }
  const hasThresholdField = NUMERIC_FIELDS.some((field) => Number.isFinite(value[field]));
  if (!hasThresholdField && !excluded) {
    errors.push("覆写 " + key + " 既没有阈值字段也没有 exclude=true");
  }
  return errors;
}

/**
 * 读取阈值文件。文件不存在按"全部用默认阈值"处理（不是错误）。
 * @returns {{ defaultThresholds: object, overrides: Record<string, object>, errors: string[], path: string|null }}
 */
export function loadTolerances(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { defaultThresholds: DEFAULT_THRESHOLDS, overrides: {}, errors: [], path: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    return { defaultThresholds: DEFAULT_THRESHOLDS, overrides: {}, errors: ["tolerances.json 解析失败：" + String(err)], path: filePath };
  }
  const errors = [];
  const overrideBlock = parsed && typeof parsed.overrides === "object" && parsed.overrides !== null ? parsed.overrides : {};
  for (const [key, value] of Object.entries(overrideBlock)) {
    errors.push(...validateOverride(key, value));
  }
  const { thresholds: defaultThresholds } = mergeThresholds(DEFAULT_THRESHOLDS, parsed && parsed.default ? parsed.default : null);
  return { defaultThresholds, overrides: overrideBlock, errors, path: filePath };
}
