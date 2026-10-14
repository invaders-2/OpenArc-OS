/**
 * 自证工具：用 Playwright canvas 在指定 PNG 上注入可控差异，用来证明探针真的会报警、exit≠0。
 * 只做人工自检，不参与 run-all.mjs 的常规流程，也不是单测的一部分。
 *
 * 用法：
 *   node experiments/dxos-visual-baseline/self-check.mjs <png> block   # 40×40 小块（比例 0.03%，触发最大通道差条款）
 *   node experiments/dxos-visual-baseline/self-check.mjs <png> band    # 整宽 60px 横带（比例 3.33%，触发比例+最大差条款）
 *
 * 典型自证流程（README §4 有真实输出）：
 *   cp baseline/org/07-ready.png /tmp/bak.png
 *   node self-check.mjs baseline/org/07-ready.png block
 *   node run-all.mjs --probe=org            # 期望 exit 1
 *   cp /tmp/bak.png baseline/org/07-ready.png
 *   node run-all.mjs --probe=org            # 期望 exit 0
 */
import fs from "node:fs";
import { chromium } from "playwright";
import { resolveChromium } from "../../lib/chromium.mjs";

const target = process.argv[2];
const mode = process.argv[3] || "block";
const b64 = fs.readFileSync(target).toString("base64");
const info = resolveChromium();
const browser = await chromium.launch({ executablePath: info.path });
const page = await browser.newPage();
await page.goto("about:blank");
const out = await page.evaluate(
  async ({ b64, mode }) => {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = "data:image/png;base64," + b64;
    });
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    ctx.fillStyle = "#ff0000";
    if (mode === "band") {
      /* 整宽 60px 横带：面积占比 60/1800 = 3.33% > 0.5%，用来触发"变化像素比例"条款。 */
      ctx.fillRect(0, 900, img.width, 60);
    } else {
      /* 40×40 小块：面积占比 0.031% < 0.5%，只触发"最大通道差"条款。 */
      ctx.fillRect(200, 200, 40, 40);
    }
    return c.toDataURL("image/png");
  },
  { b64, mode },
);
fs.writeFileSync(target, Buffer.from(out.replace(/^data:image\/png;base64,/, ""), "base64"));
await browser.close();
console.log("mutated " + target + " mode=" + mode);
