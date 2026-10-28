/**
 * 市场「立即体验」跳新画布（task-57）：
 *   A) 外壳 shell store 的 canvasTarget / openCanvas / clearCanvasTarget 真跑一遍（bundled + pinia）；
 *   B) 契约：画布窗口把 target 透传、画布入口读到后切画布并回调、市场点模板走 openCanvas 而不是 activateApp("canvas")。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(ROOT, "node_modules/.cache/oa-shell-canvas-target-" + process.pid + ".mjs");

/** xxx.svg?raw 在 Node 里没有 loader：当成文本模块 */
const rawPlugin = {
  name: "raw-asset",
  setup(build) {
    build.onResolve({ filter: /raw$/ }, (args) => ({
      path: path.join(args.resolveDir, args.path.endsWith("?raw") ? args.path.slice(0, -4) : args.path),
      namespace: "raw-asset",
    }));
    build.onLoad({ filter: /.*/, namespace: "raw-asset" }, (args) => ({
      contents: "export default " + JSON.stringify(fs.readFileSync(args.path, "utf8")),
      loader: "js",
    }));
  },
};

fs.mkdirSync(path.dirname(BUNDLE), { recursive: true });
await esbuild.build({
  entryPoints: [path.join(ROOT, "src-vue/stores/shell.ts")],
  bundle: true, format: "esm", platform: "browser", outfile: BUNDLE, logLevel: "silent",
  plugins: [rawPlugin], loader: { ".css": "empty" }, external: ["pinia"],
});
test.after(() => { try { fs.rmSync(BUNDLE, { force: true }); } catch { /* 忽略 */ } });

/* shell store 在 state 初始化时会读 window/localStorage；Node 里给最小桩 */
globalThis.window = {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  addEventListener() {}, removeEventListener() {}, location: { search: "" }, openarc: undefined,
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document = {
  documentElement: { classList: { contains: () => false } },
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
  createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
};
try { Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node" }, configurable: true }); } catch { /* 已有 */ }

const piniaMod = await import(pathToFileURL(path.join(ROOT, "node_modules/pinia/dist/pinia.mjs")).href);
const shellMod = await import(pathToFileURL(BUNDLE).href);

function freshStore() {
  piniaMod.setActivePinia(piniaMod.createPinia());
  return shellMod.useShellStore();
}
const canvasWindows = (store) => store.model.windows.filter((w) => w.appId === "canvas");

test("A1 初始没有待打开的画布", () => {
  const store = freshStore();
  assert.equal(store.canvasTarget, null);
});

test("A2 openCanvas 记下目标并打开/聚焦 AI Studio 窗口", () => {
  const store = freshStore();
  store.openCanvas("cv_market_1");
  assert.equal(store.canvasTarget, "cv_market_1");
  assert.equal(canvasWindows(store).length, 1, "没有画布窗口时要真的打开一个");
  store.clearCanvasTarget();
  assert.equal(store.canvasTarget, null);
});

test("A3 窗口已存在时再开别的画布：只更新 target，不多开窗口", () => {
  const store = freshStore();
  store.openCanvas("cv_a");
  const before = store.model.windows.length;
  store.clearCanvasTarget();
  store.openCanvas("cv_b");
  assert.equal(store.canvasTarget, "cv_b");
  assert.equal(store.model.windows.length, before);
});

test("A4 空 id 不清掉已有目标；clear 幂等", () => {
  const store = freshStore();
  store.openCanvas("cv_keep");
  store.openCanvas("");
  store.openCanvas("   ");
  assert.equal(store.canvasTarget, "cv_keep");
  store.clearCanvasTarget();
  store.clearCanvasTarget();
  assert.equal(store.canvasTarget, null);
});

/* ── B. 契约：三处接线都在，且市场不再只 activateApp ── */
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("B1 WindowLayer 把 canvasTarget 透传给画布窗口，并回调清除", () => {
  const src = read("src-vue/shell/WindowLayer.vue");
  assert.match(src, /openCanvasId:\s*shell\.canvasTarget/);
  assert.match(src, /onCanvasOpened:\s*\(\)\s*=>\s*shell\.clearCanvasTarget\(\)/);
});

test("B2 画布入口接 openCanvasId：切到指定画布后回调，不新建画布", () => {
  const src = read("src/canvas/canvas-next/entry.tsx");
  assert.match(src, /openCanvasId\?:\s*string/);
  assert.match(src, /onCanvasOpened\?:\s*\(/);
  assert.match(src, /if \(!openCanvasId \|\| handledTarget\.current === openCanvasId\) return;/);
  assert.match(src, /setActive\(\{ id, name: found\?\.name \|\| "画布" \}\)/);
  assert.match(src, /latest\.current\.onCanvasOpened\?\.\(id\)/);
  const effect = src.slice(src.indexOf("市场等外部入口的「打开这张画布」"), src.indexOf("if (!active) return <CanvasList"));
  assert.equal(/canvas\/create/.test(effect), false, "打开指定画布不能又建一张");
});

test("B3 市场 applyTemplate 用 openCanvas(canvasId)，不再只 activateApp('canvas')", () => {
  const src = read("src-vue/apps/MarketApp.vue");
  const body = src.slice(src.indexOf("async function applyTemplate(template: MarketTemplate)"));
  const tail = body.slice(0, body.indexOf("\nfunction detailTry"));
  assert.match(tail, /shell\.openCanvas\(canvasId\)/);
  assert.equal(/shell\.activateApp\("canvas"\)/.test(tail), false);
  assert.match(tail, /canvas\/save/, "写入工作流的逻辑保留");
});

test("B4 旧版画布也收下这两个参数（不报错、不使用）", () => {
  const src = read("src/canvas/react-canvas/ReactCanvasApp.tsx");
  assert.match(src, /openCanvasId\?:\s*string;\s*onCanvasOpened\?:\s*\(canvasId\?: string\) => void/);
});
