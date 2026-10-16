/* ══════════════════════════════════════════════════════════════════════════
   OpenArc OS · Windows 标题栏候选方案 —— 示意图渲染器

   怎么跑（仓库根目录，无需构建、无需新依赖，只用已装的 Playwright）：
       node experiments/win-titlebar-options/render.mjs

   产物（全部写在 artifacts/win-titlebar-options/shots/）：
       option-a-native-titlebar-{light,dark}.png       1280 × 168 CSS px @2x
       option-b-custom-fluent-caption-{light,dark}.png 1280 × 118 CSS px @2x
       option-c-titlebar-overlay-{light,dark}.png      1280 × 118 CSS px @2x
       option-d-status-quo-{light,dark}.png            1280 × 118 CSS px @2x
       caption-states-{light,dark}.png                 caption 按钮状态细节（4× 放大）
       overview-{light,dark}.png                       四个方案纵向对照
       manifest.json                                   文件名 / CSS 尺寸 / 像素尺寸 / 字节数

   渲染口径：
     · 视口 1280×800（真实窗口尺寸），deviceScaleFactor=2，只 clip 顶部若干行；
     · 壁纸/顶栏/字色全部取自 src/design-system/tokens.css 与 src/styles.css 的权威值；
     · Windows 侧数值是公开口径近似（标题栏 32px、caption 46×32、close hover #c42b1c）。
   ══════════════════════════════════════════════════════════════════════════ */
import { chromium } from "playwright";
import { resolveChromium, describeChromiumCandidates } from "../lib/chromium.mjs";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "../..");
const MOCK_URL = pathToFileURL(path.join(HERE, "mock", "index.html")).href;
const OUT = path.join(ROOT, "artifacts", "win-titlebar-options", "shots");
const W = 1280;
const SCALE = 2;

/** 每个方案的可视高度 = 该方案的 chrome 高度 + 应用顶栏 38px + 下方 80px。 */
const OPTIONS = [
  { id: "A", slug: "a-native-titlebar", clip: 168, label: "方案 A · 原生标题栏（frame:true + 系统菜单栏）" },
  { id: "B", slug: "b-custom-fluent-caption", clip: 118, label: "方案 B · 自绘 Windows 风 caption 按钮" },
  { id: "C", slug: "c-titlebar-overlay", clip: 118, label: "方案 C · titleBarOverlay（窗口按钮由系统绘制）" },
  { id: "D", slug: "d-status-quo", clip: 118, label: "方案 D · 保持现状（完全没有窗口按钮）" },
];
const THEMES = ["light", "dark"];

const chromiumInfo = resolveChromium();
if (!chromiumInfo.path) {
  console.error("找不到可用 Chromium，已按优先级尝试：" + describeChromiumCandidates(chromiumInfo.candidates));
  process.exit(1);
}
console.log("Chromium: " + chromiumInfo.source + " → " + chromiumInfo.path);

/** 读 PNG IHDR，拿真实像素尺寸（不靠 deviceScaleFactor 反推）。 */
function pngSize(file) {
  const b = fs.readFileSync(file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: chromiumInfo.path });
const manifest = [];

async function shot({ option, theme, mode = "window", file, height, label, pageUrl = MOCK_URL }) {
  const page = await browser.newPage({
    viewport: { width: W, height: mode === "states" ? 520 : 800 },
    deviceScaleFactor: SCALE,
  });
  await page.goto(pageUrl + "?option=" + option + "&theme=" + theme + (mode === "states" ? "&mode=states" : ""));
  await page.waitForFunction(() => window.__MOCK_READY__ === true);
  await page.evaluate(() => document.fonts && document.fonts.ready);
  const opts = { path: file };
  if (height) {
    opts.clip = { x: 0, y: 0, width: W, height };
  } else {
    const full = await page.evaluate(() => ({
      w: document.documentElement.scrollWidth,
      h: document.documentElement.scrollHeight,
    }));
    if (full.w > W) console.warn("  ! 内容宽 " + full.w + "px 超过 " + W + "px，已按 " + W + "px 裁");
    opts.clip = { x: 0, y: 0, width: W, height: full.h };
  }
  await page.screenshot(opts);
  const size = pngSize(file);
  manifest.push({
    file: path.relative(ROOT, file),
    option,
    theme,
    mode,
    label: label || null,
    css: { width: W, height: height || null },
    pixels: size,
    bytes: fs.statSync(file).size,
  });
  await page.close();
  console.log("  ✓ " + path.relative(ROOT, file) + "  " + size.width + "×" + size.height + "px  " + fs.statSync(file).size + "B");
}

console.log("\n── 单方案示意图 ──");
for (const theme of THEMES) {
  for (const opt of OPTIONS) {
    await shot({
      option: opt.id,
      theme,
      file: path.join(OUT, "option-" + opt.slug + "-" + theme + ".png"),
      height: opt.clip,
      label: opt.label,
    });
  }
}

console.log("\n── caption 状态细节图 ──");
for (const theme of THEMES) {
  await shot({
    option: "B",
    theme,
    mode: "states",
    file: path.join(OUT, "caption-states-" + theme + ".png"),
    label: "Windows caption 按钮状态（4× 放大）",
  });
}

console.log("\n── 四方案对照图 ──");
for (const theme of THEMES) {
  const rows = OPTIONS.map((opt) => {
    const file = path.join(OUT, "option-" + opt.slug + "-" + theme + ".png");
    const b64 = fs.readFileSync(file).toString("base64");
    return (
      '<section class="row"><header>' + opt.label + '</header>' +
      '<img src="data:image/png;base64,' + b64 + '" width="' + W + '" /></section>'
    );
  }).join("");
  const bg = theme === "dark" ? "#0d0d0f" : "#f4f4f5";
  const fg = theme === "dark" ? "#f2f2f4" : "#1b1b1b";
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    "html,body{margin:0;padding:0;background:" + bg + ";font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei UI',sans-serif}" +
    ".wrap{width:" + W + "px;padding:0 0 24px}" +
    ".row{margin:0 0 18px}.row header{height:34px;display:flex;align-items:center;padding:0 16px;font-size:13px;font-weight:500;color:" + fg + ";border-bottom:1px solid rgba(128,128,128,.25)}" +
    ".row img{display:block;margin:12px auto 0;width:" + W + "px;box-shadow:0 4px 18px rgba(0,0,0,.18)}" +
    "</style></head><body><div class='wrap'>" + rows + "</div></body></html>";
  const page = await browser.newPage({ viewport: { width: W, height: 800 }, deviceScaleFactor: SCALE });
  await page.setContent(html, { waitUntil: "load" });
  const file = path.join(OUT, "overview-" + theme + ".png");
  await page.screenshot({ path: file, fullPage: true });
  const size = pngSize(file);
  manifest.push({
    file: path.relative(ROOT, file),
    option: "ALL",
    theme,
    mode: "overview",
    label: "四方案对照",
    css: { width: W, height: null },
    pixels: size,
    bytes: fs.statSync(file).size,
  });
  console.log("  ✓ " + path.relative(ROOT, file) + "  " + size.width + "×" + size.height + "px  " + fs.statSync(file).size + "B");
  await page.close();
}

await browser.close();

const manifestPath = path.join(OUT, "manifest.json");
fs.writeFileSync(manifestPath, JSON.stringify({ generatedAt: new Date().toISOString(), renderer: "experiments/win-titlebar-options/render.mjs", shots: manifest }, null, 2) + "\n");
console.log("\n清单：" + path.relative(ROOT, manifestPath) + "（" + manifest.length + " 张）");
