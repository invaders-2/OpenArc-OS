#!/usr/bin/env node
/**
 * DXOS-CANVAS-REVENDOR-NEXT · 智能画布移植锚点探针（只读，不改 bundle）。
 *
 * 目的：vendor 脚本的干跑只校验「脚本补丁锚点」；守卫/适配器/只读闸依赖的是**另一个面**
 * （DOM id、IIFE 内函数名、localStorage 键、结构收尾）。上游一改，那些锚点会静默失效。
 * 本探针把它们一次性列出来：MUST = 现在必须存在；ABSENT = 已知上游已移除/从未存在（只记录，不判失败）。
 *
 * 用法：OA_NOVAI_SRC=<本地目录> node experiments/dxos-canvas-revendor-next/anchor-probe.mjs [--json]
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const LOCAL_SRC = process.env.OA_NOVAI_SRC || "";
const SRC = LOCAL_SRC || "/tmp/novai-canvas-src";
const JSON_OUT = process.argv.includes("--json");

function resolveStaticRoot() {
  const direct = path.join(SRC, "static");
  if (fs.existsSync(direct)) return direct;
  if (!LOCAL_SRC) throw new Error("源 static/ 不存在：" + direct);
  const hits = [];
  for (const e of fs.readdirSync(SRC, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const sub = path.join(SRC, e.name, "static");
    if (fs.existsSync(path.join(sub, "canvas-list.html"))) hits.push(sub);
  }
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error("多个候选 static/：" + hits.join("、"));
  throw new Error("源 static/ 不存在：" + direct);
}

const STATIC = resolveStaticRoot();
const jsText = fs.readFileSync(path.join(STATIC, "js", "smart-canvas.js"), "utf8");
const htmlText = fs.readFileSync(path.join(STATIC, "smart-canvas.html"), "utf8");
const jsLines = jsText.split("\n");
const htmlLines = htmlText.split("\n");

function lineOf(text, lines, needle) {
  const i = lines.findIndex((l) => l.includes(needle));
  return i < 0 ? null : i + 1;
}
function exists(text, needle) { return text.includes(needle) ? (lineOf(text, text === jsText ? jsLines : htmlLines, needle)) : null; }

/** MUST：守卫/适配器/只读闸/门禁现在必须能落到的锚点 */
const MUST = [
  // ── 页面（DOM）──
  ["html", "smart-canvas.html <head>", "<head"],
  ["html", "smart-canvas.html #engineSelect", "id=\"engineSelect\""],
  ["html", "smart-canvas.html #dynamicParams", "id=\"dynamicParams\""],
  ["html", "smart-canvas.html #runBtn", "id=\"runBtn\""],
  ["html", "smart-canvas.html #cascadeRunBtn", "id=\"cascadeRunBtn\""],
  ["html", "smart-canvas.html #smartTitle", "id=\"smartTitle\""],
  ["html", "smart-canvas.html #smartSaveState", "id=\"smartSaveState\""],
  ["html", "smart-canvas.html #chatModelSelect", "id=\"chatModelSelect\""],
  ["html", "smart-canvas.html #agentImageProviderSelect", "id=\"agentImageProviderSelect\""],
  ["html", "smart-canvas.html data-create-type=\"video\"", "data-create-type=\"video\""],
  ["html", "smart-canvas.js script 标签（适配层/守卫注入点）", "/static/js/smart-canvas.js"],
  // ── IIFE 内：真源/兜底 ──
  ["js", "DEFAULT_VIDEO_MODELS", "const DEFAULT_VIDEO_MODELS = ["],
  ["js", "volcengineProvider()", "function volcengineProvider()"],
  ["js", "modelscopeImageModels()", "function modelscopeImageModels()"],
  ["js", "MS_GEN_MODELS", "const MS_GEN_MODELS = {"],
  ["js", "resolveChatModel()", "function resolveChatModel("],
  ["js", "comfyInstanceCount", "let comfyInstanceCount ="],
  ["js", "initChatModel()", "function initChatModel("],
  // ── IIFE 内：平台/模型 UI ──
  ["js", "renderUnifiedPlatformControl()", "function renderUnifiedPlatformControl("],
  ["js", "applyUnifiedPlatform()", "function applyUnifiedPlatform("],
  ["js", "renderProviderControl()", "function renderProviderControl("],
  ["js", "renderModelControl()", "function renderModelControl("],
  ["js", "renderDynamicParams()", "function renderDynamicParams("],
  ["js", "setDynamicSetting()", "function setDynamicSetting("],
  ["js", "syncRunButtonState()", "function syncRunButtonState("],
  // ── IIFE 内：编辑入口（只读闸）──
  ["js", "pushUndo()", "function pushUndo()"],
  ["js", "capturePendingUndo()", "function capturePendingUndo()"],
  ["js", "commitPendingUndo()", "function commitPendingUndo()"],
  ["js", "performUndo()", "function performUndo()"],
  ["js", "performRedo()", "function performRedo()"],
  ["js", "deleteNode()", "function deleteNode("],
  ["js", "createNodeFromMenu()", "function createNodeFromMenu("],
  ["js", "createImageNodeAt()", "function createImageNodeAt("],
  ["js", "groupSelectedNodes()", "function groupSelectedNodes()"],
  ["js", "ungroupNode()", "function ungroupNode("],
  ["js", "addNodeToSmartGroup()", "function addNodeToSmartGroup("],
  ["js", "duplicateSelectedSmartNodes()", "function duplicateSelectedSmartNodes()"],
  ["js", "pasteNodes()", "function pasteNodes()"],
  ["js", "pasteAssetsFromInbox()", "function pasteAssetsFromInbox()"],
  ["js", "nudgeSelectedSmartNodes()", "function nudgeSelectedSmartNodes("],
  ["js", "alignSelectedSmartNodes()", "function alignSelectedSmartNodes("],
  ["js", "arrangeSelectedSmartNodes()", "function arrangeSelectedSmartNodes("],
  ["js", "handlePortDrop()", "function handlePortDrop("],
  ["js", "finishNodeResize()", "function finishNodeResize()"],
  ["js", "handleSmartImageDropPayload()", "async function handleSmartImageDropPayload("],
  ["js", "pickLocalMediaForNode()", "function pickLocalMediaForNode("],
  ["js", "applyAgentCanvasOps()", "function applyAgentCanvasOps("],
  ["js", "agentPlanAction()", "async function agentPlanAction("],
  ["js", "runGeneration()", "async function runGeneration()"],
  ["js", "runSmartNodeToolbarAction()", "function runSmartNodeToolbarAction("],
  ["js", "rerunSmartNode()", "async function rerunSmartNode("],
  ["js", "saveCanvas()", "async function saveCanvas()"],
  ["js", "restoreCanvasVersion()", "async function restoreCanvasVersion("],
  ["js", "deleteCanvasVersion()", "async function deleteCanvasVersion("],
  ["js", "createPromptTemplateGroup()", "async function createPromptTemplateGroup()"],
  ["js", "renamePromptTemplateGroup()", "async function renamePromptTemplateGroup("],
  ["js", "deletePromptTemplate()", "async function deletePromptTemplate()"],
  ["js", "saveSmartPromptTextFromComposer()", "function saveSmartPromptTextFromComposer("],
  ["js", "apiImageSize()", "function apiImageSize("],
  ["js", "SIZE_MAP", "const SIZE_MAP = {"],
  // ── 结构收尾 / 既有测试钩子 ──
  ["js-tail", "IIFE 收尾 })();（lastIndexOf，适配层/封堵注入点）", "})();"],
  ["js", "window.__smartAgentTestHooks（已暴露的只读面）", "window.__smartAgentTestHooks = {"],
  // ── localStorage 第二来源 ──
  ["js", "smart_chat_model", "'smart_chat_model'"],
  ["js", "smart_chat_provider", "'smart_chat_provider'"],
  ["js", "smart_agent_image_provider", "'smart_agent_image_provider'"],
  ["js", "smart_canvas_recent_run_settings_v1", "smart_canvas_recent_run_settings_v1"],
];

/** ABSENT：已知在本地上游不存在（引用它 = 死锚点）；只记录，不判失败 */
const ABSENT = [
  ["js", "apiKindToggle（本地源码 0 命中；apiKind 改为按节点类型）", "apiKindToggle"],
  ["js", "syncApiKindToggleVisibility（本地源码 0 命中）", "syncApiKindToggleVisibility"],
  ["js", "gpt-4o-mini（本地源码 0 命中，旧 pin 有 3 处）", "gpt-4o-mini"],
  ["js", "canvas_custom_image_models（经典编辑器专用键，智能画布不读）", "canvas_custom_image_models"],
  ["js", "canvas_image_models_ordered（同上）", "canvas_image_models_ordered"],
  ["js", "canvas_chat_models_ordered（同上）", "canvas_chat_models_ordered"],
];

function check(kind, name, needle) {
  const isTail = kind === "js-tail";
  const text = kind === "html" ? htmlText : jsText;
  const lines = kind === "html" ? htmlLines : jsLines;
  if (isTail) {
    const idx = text.lastIndexOf(needle);
    const line = idx < 0 ? null : text.slice(0, idx).split("\n").length;
    return { scope: kind, name, needle, status: idx >= 0 ? "hit" : "MISS", line };
  }
  const idx = text.indexOf(needle);
  return { scope: kind, name, needle, status: idx >= 0 ? "hit" : "MISS", line: idx < 0 ? null : lineOf(text, lines, needle) };
}

const must = MUST.map(([k, n, s]) => check(k, n, s));
const absent = ABSENT.map(([k, n, s]) => check(k, n, s));
const mustMiss = must.filter((r) => r.status === "MISS");
let gitHead = null;
try { gitHead = execFileSync("git", ["-C", path.dirname(STATIC), "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* 非 git */ }
const report = {
  capturedAt: new Date().toISOString(),
  staticDir: STATIC,
  gitHead,
  must: { total: must.length, miss: mustMiss.length },
  mustAnchors: must,
  absentAnchors: absent,
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("=== 智能画布移植锚点探针（只读）===");
  console.log("static/   : " + STATIC);
  console.log("git HEAD  : " + (gitHead || "(非 git)"));
  console.log("抓取时间  : " + report.capturedAt);
  console.log("");
  console.log("[MUST] " + must.length + " 条，MISS " + mustMiss.length + " 条");
  for (const r of must) console.log("  [" + r.status + "] " + r.scope + " · " + r.name + (r.line ? "  @L" + r.line : ""));
  console.log("");
  console.log("[ABSENT（引用即死锚点）]");
  for (const r of absent) console.log("  [" + (r.status === "MISS" ? "absent" : "存在!L" + r.line) + "] " + r.scope + " · " + r.name);
  console.log("");
  console.log("ANCHOR_PROBE_JSON " + JSON.stringify({ capturedAt: report.capturedAt, staticDir: STATIC, gitHead, mustMiss: mustMiss.map((r) => r.name), absentPresent: absent.filter((r) => r.status === "hit").map((r) => r.name) }));
}

process.exitCode = mustMiss.length ? 1 : 0;
