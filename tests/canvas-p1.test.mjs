/**
 * task-71 P1：单行参数 / hover 替换 / 顶栏入口 + Agent orb。
 * 替换动作真跑（bundled actions + 假 store）+ 入口契约。
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
const BUNDLE = path.join(ROOT, "node_modules/.cache/oa-p1-" + process.pid + ".mjs");
fs.mkdirSync(path.dirname(BUNDLE), { recursive: true });
await esbuild.build({ entryPoints: [path.join(ROOT, "src/canvas/canvas-next/actions.ts")], bundle: true, format: "esm", platform: "neutral", outfile: BUNDLE, logLevel: "silent" });
const { replaceNodeMedia } = await import(pathToFileURL(BUNDLE).href);
test.after(() => { try { fs.rmSync(BUNDLE, { force: true }); } catch { /* 忽略 */ } });

function storeWith(node) {
  const s = {
    node: (id) => (id === node.id ? node : undefined),
    patch: null, toastMsg: "",
    patchGen(id, fn, opts) { s.patch = { next: fn(node.data.gen), opts }; },
    toast(m) { s.toastMsg = String(m); },
  };
  return s;
}
const mkNode = (kind = "image") => ({
  id: "n1", kind, x: 100, y: 220, w: 200, h: 250, text: "",
  data: { gen: {
    title: "主图", prompt: "保留的提示词", params: { model: "banana-pro", ratio: "1:1" },
    hist: [
      { url: "openarc-asset:old1", w: 512, h: 512 },
      { url: "openarc-asset:old2", w: 512, h: 512, meta: { at: 1 } },
    ], hi: 1, order: ["e_a", "e_b"],
  } },
});

test("R1 替换只换当前版本，其它版本/节点字段都不动", () => {
  const node = mkNode(); const store = storeWith(node);
  assert.equal(replaceNodeMedia(store, node.id, { url: "openarc-asset:new", w: 640, h: 480 }), true);
  const hist = store.patch.next.hist;
  assert.equal(hist.length, 2);
  assert.deepEqual(hist[0], node.data.gen.hist[0], "旧版本不能动");
  assert.equal(hist[1].url, "openarc-asset:new");
  assert.equal(hist[1].w, 640); assert.equal(hist[1].h, 480);
  assert.equal(hist[1].meta.at, 1, "当前版本的其它字段保留");
  assert.equal(hist[1].url === "openarc-asset:old2", false);
  assert.equal(node.x, 100); assert.equal(node.w, 200);
  assert.equal(node.data.gen.prompt, "保留的提示词");
  assert.deepEqual(node.data.gen.order, ["e_a", "e_b"]);
  assert.match(store.toastMsg, /已替换/);
});

test("R2 视频替换时没有新封帧就沿用旧封帧", () => {
  const node = mkNode("video"); node.data.gen.hist[1].frame = "openarc-asset:frame2";
  const store = storeWith(node);
  replaceNodeMedia(store, node.id, { url: "openarc-asset:newvideo" });
  assert.equal(store.patch.next.hist[1].url, "openarc-asset:newvideo");
  assert.equal(store.patch.next.hist[1].frame, "openarc-asset:frame2");
  const s2 = storeWith(mkNode("video"));
  s2.node("n1").data.gen.hist[1].frame = undefined;
  replaceNodeMedia(s2, "n1", { url: "openarc-asset:v3" });
  assert.equal(s2.patch.next.hist[1].frame, "openarc-asset:v3", "没有封帧就拿新素材当封帧");
});

test("R3 边界：节点不存在 / 没给 url 都不改", () => {
  const node = mkNode(); const store = storeWith(node);
  assert.equal(replaceNodeMedia(store, "nope", { url: "x" }), false);
  assert.equal(store.patch, null);
  assert.equal(replaceNodeMedia(store, node.id, {}), false);
  assert.equal(store.patch, null);
});

/* ── 入口契约 ── */
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("C1 单行参数：图片/文本渲染 .gp-line + data-seg，逐段可点，能力都在", () => {
  const src = read("src/canvas/canvas-next/ui/GenPanel.tsx");
  assert.match(src, /className="gp-line"/);
  assert.match(src, /data-seg=\{k\}/);
  const block = src.slice(src.indexOf("const seg = (k: string"), src.indexOf('<div className="gp-in">'));
  for (const k of ["ratio", "count", "style", "camera", "output"]) assert.ok(block.includes('"' + k + '"'), "缺能力段 " + k);
  assert.equal(/kind === "image" \? pill\("count"/.test(src), false, "次数胶囊已从动作区移除");
});

test("C2 hover 替换：按钮 + 菜单三来源 + 画布选择 / 上传 / 素材库都接线", () => {
  const nv = read("src/canvas/canvas-next/ui/NodeView.tsx");
  assert.match(nv, /className="node-replace" data-act="replace"/);
  assert.match(nv, /node\.kind === "image" \|\| node\.kind === "video" \|\| node\.kind === "audio"/);
  const menus = read("src/canvas/canvas-next/ui/menus.tsx");
  const block = menus.slice(menus.indexOf('if (act === "replace")'), menus.indexOf('if (act === "vmenu")'));
  for (const k of ["rep-pick", "rep-up", "rep-lib"]) assert.ok(block.includes('data-k="' + k + '"'), "缺 " + k);
  assert.match(block, /setUI\(\{ replace: n\.id/);
  assert.match(block, /cn:upload", \{ detail: \{ replace: n\.id/);
  assert.match(read("src/canvas/canvas-next/ui/Viewport.tsx"), /if \(nodeEl && st\.ui\.replace\)/);
  assert.match(read("src/canvas/canvas-next/ui/Library.tsx"), /const target = store\.state\.ui\.replace/);
  assert.match(read("src/canvas/canvas-next/actions.ts"), /opts\.replace && store\.node\(opts\.replace\)/);
});

test("C3 顶栏：扩展下拉（Skill/MCP/模型）+ 社区（组织治理），不再有「连接 Agent」", () => {
  const src = read("src/canvas/canvas-next/ui/Chrome.tsx");
  assert.match(src, /id="extBtn"/);
  assert.match(src, /data-ext="skills"/);
  assert.match(src, /data-ext="mcp"/);
  assert.match(src, /ctl\.host\.openApp\("skills"\)/);
  assert.match(src, /id="orgBtn"/);
  assert.match(src, /ctl\.host\.openApp\("organization"\)/);
  assert.equal(/id="connectAgent"/.test(src), false);
});

test("C4 Agent 从顶栏移到右下 orb：悬停名称 + 点击开面板", () => {
  const src = read("src/canvas/canvas-next/ui/Chrome.tsx");
  assert.match(src, /<button id="orb" className="float" aria-label="打开 Agent" title="Agent" data-orb/);
  assert.match(src, /className="orb-name">Agent</);
  assert.match(src, /onClick=\{\(\) => store\.setUI\(\{ agentOpen: true \}\)\}/);
  const css = read("src/canvas/canvas-next/ui/canvas-next.css");
  assert.match(css, /\.cn-root #orb\{position:absolute;right:18px;bottom:18px;width:44px;height:44px;border-radius:50%/);
  assert.match(css, /#orb:hover \.orb-name\{opacity:1;\}/);
});

test("C5 替换按钮不挡轮播/徽标/收藏：位置错开", () => {
  const css = read("src/canvas/canvas-next/ui/canvas-next.css");
  assert.match(css, /\.cn-root \.node-replace\{position:absolute;left:50%;top:8px;/);
  assert.match(css, /\.cn-root \.nbadges\{position:absolute;left:8px;top:8px;/);
  assert.match(css, /\.cn-root \.favstar\{position:absolute;left:auto;right:8px;top:34px;/);
  assert.match(css, /\.cn-root \.vstrip\{position:absolute;right:8px;top:8px;/);
});

test("C6 HostActions 暴露 openApp，画布入口把 onOpenApp 转进去", () => {
  assert.match(read("src/canvas/canvas-next/ui/ctx.tsx"), /openApp\?: \(appId: string\) => void;/);
  assert.match(read("src/canvas/canvas-next/entry.tsx"), /\.\.\.\(latest\.current\.onOpenApp \? \{ openApp: \(id: string\) => latest\.current\.onOpenApp\?\.\(id\) \} : \{\}\)/);
});
