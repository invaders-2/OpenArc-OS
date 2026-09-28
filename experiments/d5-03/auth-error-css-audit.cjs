/**
 * .auth-error 样式审计：按**选择器**提取规则体，不靠行号。
 *
 * 由来（第六批门禁脚本修正 · 假阳性 1）：第五批 auth-error-visual.mjs 的 V7b 用
 * `split("\n").slice(2464, 2472)` 硬切 src/styles.css。第六批把 .auth-error 从 2465 挪到
 * 2471-2478 之后，这个切片只剩注释 + margin-top 一条声明 —— "规则无 transition/animation"
 * 变成半空断言（恒真、假绿）。本模块只做文本解析与计数：不读库、不写文件、不改产品代码。
 *
 * 旧口径（legacyLineSlice / legacyCssChanged）在此**保留仅供反证对照**，
 * 任何判定都不使用它们。
 */
"use strict";
const fs = require("node:fs");

const stripComments = (css) => String(css).replace(/\/\*[\s\S]*?\*\//g, "");

/** 精确选择器（逗号列表按项精确匹配）的全部规则体。 */
function extractRuleBodies(cssText, selector) {
  const css = stripComments(cssText);
  const bodies = [];
  const re = /([^{}]*)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const selectors = m[1].split(",").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
    if (selectors.includes(selector)) bodies.push(m[2].trim());
  }
  return bodies;
}

const norm = (s) => String(s).replace(/\s*:\s*/, ": ").replace(/\s+/g, " ").trim();

/** 规则体的声明数与声明名（按顶层分号切）。 */
function declarationsOf(body) {
  const decls = String(body).split(";").map((d) => d.trim()).filter(Boolean);
  return { count: decls.length, names: decls.map((d) => (d.split(":")[0] || "").trim()).filter(Boolean), text: decls.map(norm).join("; ") };
}

const MOTION_DECL = /^(transition|animation)(-[a-z-]+)?\s*:/;

/** 规则体里是否有 transition / animation 声明。 */
function hasMotionDeclaration(body) {
  return String(body).split(";").map((d) => d.trim()).filter(Boolean).some((d) => MOTION_DECL.test(d));
}

/** 旧口径复现（反证对照专用）：按 1-based 行号闭区间硬切。 */
function legacyLineSlice(cssText, startLine, endLine) {
  return String(cssText).split("\n").slice(startLine - 1, endLine).join("\n");
}

/** 旧口径复现（反证对照专用）：本批 diff 里出现 .css 文件即判定"改了样式"。 */
const legacyCssChanged = (files) => (files || []).some((f) => String(f).endsWith(".css"));

/** 规则体所在行号区间。**仅供报告披露，不参与任何判定**（选择器优先，行号只是事后描述）。 */
function ruleLineRange(cssText, selector) {
  const lines = String(cssText).split("\n");
  const start = lines.findIndex((l) => l.trim().startsWith(selector + " {") || l.trim() === selector + "{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) { if (ch === "{") depth += 1; else if (ch === "}") depth -= 1; }
    if (depth === 0 && i >= start) return { startLine: start + 1, endLine: i + 1 };
  }
  return null;
}

/**
 * 统一 diff 文本里**新增**的 transition / animation 声明（第六批重基线判据）。
 * 只看 + 行（排除 +++ 头），按分号切分后逐条精确匹配声明名，注释先剥掉。
 */
function countAddedMotionDeclarations(diffText) {
  const added = String(diffText || "").split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
  const hits = [];
  for (const line of added) {
    for (const d of stripComments(line).split(";").map((x) => x.trim()).filter(Boolean)) if (MOTION_DECL.test(d)) hits.push(norm(d));
  }
  return { addedLines: added.length, declarations: hits, count: hits.length };
}

/** 读文件并给出该选择器的完整审计行。 */
function readRule(cssPath, selector) {
  const cssText = fs.readFileSync(cssPath, "utf8");
  const bodies = extractRuleBodies(cssText, selector);
  const body = bodies.length === 1 ? bodies[0] : (bodies[0] || "");
  const d = declarationsOf(body);
  return {
    selector, file: cssPath, bodies, body,
    declarations: d.count, declarationNames: d.names, text: d.text,
    hasMotion: hasMotionDeclaration(body),
    lineRange: ruleLineRange(cssText, selector),
  };
}

module.exports = { stripComments, extractRuleBodies, declarationsOf, hasMotionDeclaration, legacyLineSlice, legacyCssChanged, ruleLineRange, countAddedMotionDeclarations, readRule, MOTION_DECL };
