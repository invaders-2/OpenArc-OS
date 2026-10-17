/**
 * 图像参数/比例映射与 mime 归一化（2026-10-16）。
 *
 * 覆盖四件事：
 *   ① 比例 + 分辨率 → size 的显式映射（可配置表、显式 size 优先、无信号不造尺寸）
 *   ② provider-adapter.mapImages 的 mime：声明优先 → 魔数嗅探 → 回退
 *   ③ model-domain.sanitizeParams 当前会把图像参数丢掉 —— 记录事实，不改他人占用文件
 *   ④ canvas-service.modelCall 真的把节点 ratio/resolution 映射进请求入参（端到端接线）
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";
import { createResourceFixture } from "./resource-fixtures.mjs";
import { createModelFixture } from "./model-fixtures.mjs";
import { CanvasStore } from "../electron/canvas-store.cjs";
import { CanvasService } from "../electron/canvas-service.cjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const imageParams = require("../electron/image-params.cjs");
const adapter = require("../electron/provider-adapter.cjs");
const modelDomain = require("../electron/model-domain.cjs");

/**
 * 直接执行画布页 static/js/shared/size-policy.js（浏览器全局 IIFE），用桩 fetch 喂进服务端
 * 会下发的策略表，返回页面自己的 NovaSizePolicy。断言走页面真实算法，不放影子实现。
 */
async function loadCanvasSizePolicy(table) {
  const src = fs.readFileSync(path.join(ROOT, "public/novai-canvas/static/js/shared/size-policy.js"), "utf8");
  const sandbox = { window: {}, fetch: async () => ({ ok: true, json: async () => table }) };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "novai-size-policy.js" });
  const nova = sandbox.window.NovaSizePolicy;
  assert.ok(nova && typeof nova.constrain === "function", "画布页 size-policy.js 必须暴露 NovaSizePolicy.constrain");
  await nova.load();
  return nova;
}

/* ─────────────────────────── ① 比例 / 分辨率 → size ─────────────────────────── */

test("① ratio+resolution 显式映射：官方 15 比例（1k）", () => {
  assert.equal(imageParams.resolveImageSize({ ratio: "1:1", resolution: "1k" }), "1024x1024");
  assert.equal(imageParams.resolveImageSize({ ratio: "16:9", resolution: "1k" }), "1536x864");
  assert.equal(imageParams.resolveImageSize({ ratio: "9:16", resolution: "1k" }), "864x1536");
  // 同名键与可读比例等价
  assert.equal(imageParams.resolveImageSize({ ratio: "wide", resolution: "1k" }), "1536x864");
  assert.equal(imageParams.resolveImageSize({ ratio: "story", resolution: "1k" }), "864x1536");
  assert.equal(imageParams.resolveImageSize({ ratio: "portrait", resolution: "1k" }), "1024x1536");
  assert.equal(imageParams.resolveImageSize({ ratio: "landscape", resolution: "1k" }), "1536x1024");
  // 上游 22feb298 新增的官方比例（含 5:4 / 4:5 / 3:1 / 1:3 / 2:1 / 1:2）
  assert.equal(imageParams.resolveImageSize({ ratio: "5:4", resolution: "1k" }), "1280x1024");
  assert.equal(imageParams.resolveImageSize({ ratio: "4:5", resolution: "1k" }), "1024x1280");
  assert.equal(imageParams.resolveImageSize({ ratio: "3:1", resolution: "1k" }), "1536x512");
  assert.equal(imageParams.resolveImageSize({ ratio: "1:3", resolution: "1k" }), "512x1536");
  // 2:1 / 1:2 的官方 1k 像素超过该档像素上限，实际下发按上限等比收窄（官方原值仍在表里）
  assert.equal(imageParams.IMAGE_SIZE_TABLE.landscape21["1k"], "2048x1024");
  assert.equal(imageParams.resolveImageSize({ ratio: "2:1", resolution: "1k" }), "1760x880");
  assert.equal(imageParams.resolveImageSize({ ratio: "1:2", resolution: "1k" }), "880x1760");
});

test("① 分辨率档都会进映射；未给分辨率按 1k；未知分辨率不静默乱给", () => {
  assert.equal(imageParams.resolveImageSize({ ratio: "1:1", resolution: "2k" }), "2048x2048");
  assert.equal(imageParams.resolveImageSize({ ratio: "16:9", resolution: "4k" }), "3840x2160");
  assert.equal(imageParams.resolveImageSize({ ratio: "1:1" }), "1024x1024");
  assert.equal(imageParams.resolveImageSize({ ratio: "1:1", resolution: "banana" }), "1024x1024");
  assert.equal(imageParams.resolveImageSize({ ratio: "nope" }), "1024x1024");
});

test("① 显式 size 优先级最高（含上游自选 auto），ratio/resolution 不得反超", () => {
  assert.equal(imageParams.resolveImageSize({ size: "1536x1024", ratio: "1:1", resolution: "4k" }), "1536x1024");
  assert.equal(imageParams.resolveImageSize({ size: " 1408x768 ", ratio: "9:16", resolution: "1k" }), "1408x768");
  assert.equal(imageParams.resolveImageSize({ size: "auto", ratio: "1:1", resolution: "1k" }), "auto");
});

test("① resolution=auto / custom 的口径", () => {
  assert.equal(imageParams.resolveImageSize({ resolution: "auto", ratio: "1:1" }), "auto");
  assert.equal(imageParams.resolveImageSize({ resolution: "custom", customSize: "1408x768", ratio: "1:1" }), "1408x768");
  assert.equal(imageParams.resolveImageSize({ resolution: "custom", customSize: "not-a-size", ratio: "1:1" }), null);
});

test("① 自定义比例（custom/source）按最长边+像素上限算 16 对齐尺寸", () => {
  assert.equal(imageParams.resolveImageSize({ ratio: "custom", resolution: "1k", customRatio: "16:9" }), "1536x864");
  assert.equal(imageParams.resolveImageSize({ ratio: "custom", resolution: "1k", customRatio: "9:16" }), "864x1536");
  assert.equal(imageParams.resolveImageSize({ ratio: "source", resolution: "2k", customRatio: "4:3" }), "2048x1536");
  // custom 比例解析不出时退回 square，不报错也不造非法值
  assert.equal(imageParams.resolveImageSize({ ratio: "custom", resolution: "1k", customRatio: "" }), "1024x1024");
});

test("① 无信号（既无 size 也无 ratio/resolution）返回 null，不凭空造尺寸", () => {
  assert.equal(imageParams.resolveImageSize({}), null);
  assert.equal(imageParams.resolveImageSize({ size: "  " }), null);
  assert.equal(imageParams.resolveImageSizeFromNode({ type: "generator" }), null);
  assert.equal(imageParams.resolveImageSizeFromNode(null), null);
});

test("① gpt-image-2 用离散枚举表，不产生非法 4096x4096", () => {
  assert.equal(imageParams.resolveImageSize({ ratio: "1:1", resolution: "4k", model: "gpt-image-2" }), "2048x2048");
  assert.equal(imageParams.resolveImageSize({ ratio: "16:9", resolution: "1k", model: "gpt-image-2" }), "1536x1024");
  assert.equal(imageParams.resolveImageSize({ ratio: "5:4", resolution: "2k", model: "gpt-image-2" }), "3840x2160");
  assert.equal(imageParams.resolveImageSize({ ratio: "1:2", resolution: "1k", model: "gpt-image-2" }), "1024x1536");
  // gpt-image-2.5 也算 gpt-image-2 家族（策略按 model_patterns 命中含 "gpt-image-2" 的模型名）
  assert.equal(imageParams.isGptImageModel("openai/gpt-image-2.5"), true);
  assert.equal(imageParams.isGptImageModel("gpt-image-2"), true);
  assert.equal(imageParams.isGptImageModel("gpt-image-2.5-flare"), true);
  assert.equal(imageParams.isGptImageModel("gpt-image-1.5"), false);
  assert.equal(imageParams.isGptImageModel("dall-e-3"), false);
});

test("① 映射表可配置：注入自定义表 / 校验非法表", () => {
  const tables = imageParams.normalizeImageSizeTables({
    generic: { square: { "1k": "512x512" } },
    gptImage: { square: { "1k": "512x512" } },
  });
  assert.equal(imageParams.resolveImageSize({ ratio: "1:1", resolution: "1k", tables }), "512x512");
  // 注入表里没有的比例退回该表的 square
  assert.equal(imageParams.resolveImageSize({ ratio: "wide", resolution: "1k", tables }), "512x512");
  assert.throws(() => imageParams.normalizeImageSizeTables({ generic: { square: { "1k": "1024" } } }), /WxH/);
  assert.throws(() => imageParams.normalizeImageSizeTables({ generic: [] }), /对象/);
});

test("① sizeFromRatio / parseSize / parseRatio 基础契约", () => {
  assert.deepEqual(imageParams.parseSize("1024x1536"), { width: 1024, height: 1536 });
  assert.deepEqual(imageParams.parseSize("1024*1536"), { width: 1024, height: 1536 });
  assert.equal(imageParams.parseSize("1024"), null);
  assert.equal(imageParams.parseRatio("16:9"), 16 / 9);
  assert.equal(imageParams.parseRatio("1.5"), 1.5);
  assert.equal(imageParams.parseRatio(""), null);
  // 1:1 @1k 受像素上限约束：长边 1254 对齐到 1248（不是画布页旧算法的 1536x1248 非方形）
  assert.equal(imageParams.sizeFromRatio(1, "1k"), "1248x1248");
  assert.equal(imageParams.sizeFromRatio(16 / 9, "1k"), "1536x864");
  assert.equal(imageParams.sizeFromRatio(9 / 16, "1k"), "864x1536");
});

test("① 与画布页真源对齐：SIZE_MAP / gpt-image-2 策略约束 / ratio 选项标签", async () => {
  // 经典 canvas.js 已随传统编辑器删除；SIZE_MAP 仍由唯一保留的编辑器 smart-canvas.js 承载，断言口径不变。
  const pageJs = fs.readFileSync(path.join(ROOT, "public/novai-canvas/static/js/smart-canvas.js"), "utf8");
  const pickTable = (name) => {
    const block = new RegExp("const " + name + " = \\{([\\s\\S]*?)\\n\\};").exec(pageJs);
    assert.ok(block, name + " 必须能在画布页找到");
    const rows = {};
    const re = /(\w+):\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(block[1]))) {
      const cells = {};
      const cellRe = /'?(\d?k)'?\s*:\s*'(\d+x\d+)'/g;
      let c;
      while ((c = cellRe.exec(m[2]))) cells[c[1]] = c[2];
      rows[m[1]] = cells;
    }
    return rows;
  };
  /* 上游 22feb298 把 SIZE_MAP 从「通用 9 比例」换成了 APIMart 官方 15 比例表，宿主
     electron/image-params.cjs 的 IMAGE_SIZE_TABLE 已按同一张表对齐。这里仍逐格钉住官方表
     （页面或宿主任何一格被改动都会红），并断言两边**不再有任何差异格**；13 个历史差异格的
     逐格证据在 experiments/dxos-image-size-table-sync + artifacts/dxos-image-size-table-sync。*/
  const PAGE_SIZE_MAP = {
    square: { "1k": "1024x1024", "2k": "2048x2048", "4k": "2880x2880" },
    portrait: { "1k": "1024x1536", "2k": "1360x2048", "4k": "2336x3520" },
    portrait43: { "1k": "768x1024", "2k": "1536x2048", "4k": "2480x3312" },
    landscape43: { "1k": "1024x768", "2k": "2048x1536", "4k": "3312x2480" },
    landscape: { "1k": "1536x1024", "2k": "2048x1360", "4k": "3520x2336" },
    story: { "1k": "864x1536", "2k": "1152x2048", "4k": "2160x3840" },
    wide: { "1k": "1536x864", "2k": "2048x1152", "4k": "3840x2160" },
    ultrawide: { "1k": "2016x864", "2k": "2688x1152", "4k": "3840x1648" },
    ultratall: { "1k": "864x2016", "2k": "1152x2688", "4k": "1648x3840" },
    portrait12: { "1k": "1024x2048", "2k": "1344x2688", "4k": "1920x3840" },
    landscape21: { "1k": "2048x1024", "2k": "2688x1344", "4k": "3840x1920" },
    landscape54: { "1k": "1280x1024", "2k": "2560x2048", "4k": "3216x2576" },
    portrait45: { "1k": "1024x1280", "2k": "2048x2560", "4k": "2576x3216" },
    landscape31: { "1k": "1536x512", "2k": "3072x1024", "4k": "3840x1280" },
    portrait13: { "1k": "512x1536", "2k": "1024x3072", "4k": "1280x3840" },
  };
  // 1) 页面官方表逐格钉住
  assert.deepEqual(pickTable("SIZE_MAP"), PAGE_SIZE_MAP, "smart-canvas.js 的 SIZE_MAP 必须是 APIMart 官方 15 比例表（逐格）");
  // 2) 宿主表与页面表逐格一致：不再有差异格，比例集合也必须完全相同
  const hostTable = JSON.parse(JSON.stringify(imageParams.IMAGE_SIZE_TABLE));
  assert.deepEqual(hostTable, PAGE_SIZE_MAP, "宿主 IMAGE_SIZE_TABLE 必须与上游官方 15 比例表逐格一致");
  assert.deepEqual(Object.keys(hostTable).sort(), Object.keys(PAGE_SIZE_MAP).sort(), "两边比例集合必须一致");
  const divergence = [];
  for (const key of Object.keys(PAGE_SIZE_MAP)) {
    for (const level of ["1k", "2k", "4k"]) {
      if (PAGE_SIZE_MAP[key][level] !== hostTable[key][level]) {
        divergence.push(key + "." + level + ": " + hostTable[key][level] + " -> " + PAGE_SIZE_MAP[key][level]);
      }
    }
  }
  assert.deepEqual(divergence, [], "宿主表与上游官方表不得再有任何差异格");
  // 3) gpt-image-2 的离散枚举上游已从画布页静态表搬到服务端尺寸策略，改用页面 constrain
  //    反向验证宿主表；策略快照的原样值在此处独立钉住。
  assert.deepEqual(
    JSON.parse(JSON.stringify(imageParams.GPT_IMAGE_2_SIZE_POLICY)),
    {
      mode: "enum", autoSize: true,
      options: ["auto", "1024x1024", "1536x1024", "1024x1536", "2048x2048", "2048x1152", "3840x2160", "2160x3840"],
      maxEdge: 3840, maxPixels: 8294400, minPixels: 655360, multipleOf: 16, prefer: "ratio",
      tiers: [
        { id: "1k", maxPixels: 1572864 },
        { id: "2k", maxPixels: 4194304 },
        { id: "4k", maxPixels: 8294400 },
      ],
    },
    "策略枚举必须与上游 gpt-image-2-family 逐字段一致",
  );
  const nova = await loadCanvasSizePolicy({ models: { "gpt-image-2": imageParams.GPT_IMAGE_2_SIZE_POLICY } });
  for (const gptRatio of Object.keys(imageParams.IMAGE_SIZE_TABLE)) {
    for (const gptLevel of ["1k", "2k", "4k"]) {
      assert.equal(
        nova.constrain(imageParams.IMAGE_SIZE_TABLE[gptRatio][gptLevel], "gpt-image-2"),
        imageParams.GPT_IMAGE_SIZE_TABLE[gptRatio][gptLevel],
        "gpt-image-2 " + gptRatio + "." + gptLevel + "：宿主表必须等于画布页策略吸附结果",
      );
    }
  }
  // 4) 比例标签真源：新 UI 不再用 <select>，标签在 apiRatioText 的 map 里；
  //    每个页面比例都必须有可被宿主解析的标签，且与页面表 1k 的宽高比一致。
  const ratioTextSrc = /function apiRatioText\([\s\S]*?const map = \{([\s\S]*?)\};/.exec(pageJs);
  assert.ok(ratioTextSrc, "必须能定位 apiRatioText 的比例标签表");
  const labels = {};
  for (const m of ratioTextSrc[1].matchAll(/(\w+):'([^']+)'/g)) labels[m[1]] = m[2];
  for (const key of Object.keys(PAGE_SIZE_MAP)) {
    assert.ok(labels[key], "比例 " + key + " 必须有标签");
    const parsed = imageParams.parseRatio(labels[key]);
    assert.ok(parsed > 0, "标签必须能被宿主解析：" + key + "=" + labels[key]);
    const [w, h] = PAGE_SIZE_MAP[key]["1k"].split("x").map(Number);
    assert.ok(Math.abs(w / h - parsed) < 0.02, key + " 标签比例与 1k 表不一致：" + labels[key] + " vs " + PAGE_SIZE_MAP[key]["1k"]);
  }
});

/* ─────────────────────────── ② mapImages 的 mime ─────────────────────────── */

const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]).toString("base64");
const PNG_B64 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]).toString("base64");
const WEBP_B64 = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(4)]).toString("base64");
const UNKNOWN_B64 = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c]).toString("base64");

test("② sniffImageMime：ffd8ff→jpeg、89504e47→png、RIFF+WEBP→webp", () => {
  assert.equal(imageParams.sniffImageMime(Buffer.from([0xff, 0xd8, 0xff])), "image/jpeg");
  assert.equal(imageParams.sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(imageParams.sniffImageMime(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])), "image/webp");
  assert.equal(imageParams.sniffImageMime(Buffer.from([1, 2, 3])), null);
});

test("② resolveImageMime：声明优先 > 魔数嗅探 > 回退", () => {
  assert.equal(imageParams.resolveImageMime({ declared: "image/jpeg", base64: PNG_B64 }), "image/jpeg", "声明可信时不被魔数改写");
  assert.equal(imageParams.resolveImageMime({ declared: "image/webp; charset=binary", base64: JPEG_B64 }), "image/webp");
  assert.equal(imageParams.resolveImageMime({ declared: "text/plain", base64: JPEG_B64 }), "image/jpeg", "非 image 声明当没有");
  assert.equal(imageParams.resolveImageMime({ base64: JPEG_B64 }), "image/jpeg");
  assert.equal(imageParams.resolveImageMime({ base64: PNG_B64 }), "image/png");
  assert.equal(imageParams.resolveImageMime({ base64: WEBP_B64 }), "image/webp");
  assert.equal(imageParams.resolveImageMime({ base64: UNKNOWN_B64 }), "image/png", "嗅不出回退");
  assert.equal(imageParams.resolveImageMime({ base64: UNKNOWN_B64, fallback: "image/jpeg" }), "image/jpeg");
});

test("② mapImages：b64 不再硬编码 image/png（修复前是错的）", () => {
  // 上游返回 JPEG 字节，没有声明字段 → 必须嗅成 image/jpeg
  assert.deepEqual(adapter.mapImages({ data: [{ b64_json: JPEG_B64 }] })[0], { b64: JPEG_B64, mime: "image/jpeg" });
  // 声明 mime_type 优先
  assert.equal(adapter.mapImages({ data: [{ b64_json: PNG_B64, mime_type: "image/webp" }] })[0].mime, "image/webp");
  assert.equal(adapter.mapImages({ data: [{ b64_json: PNG_B64, mimeType: "image/jpeg" }] })[0].mime, "image/jpeg");
  // PNG 字节无声明 → image/png
  assert.equal(adapter.mapImages({ data: [{ b64_json: PNG_B64 }] })[0].mime, "image/png");
  // 嗅不出的非空字节 → 仍给 image/png 回退（不抛）
  assert.equal(adapter.mapImages({ data: [{ b64_json: UNKNOWN_B64 }] })[0].mime, "image/png");
  // url 形态不受影响
  assert.deepEqual(adapter.mapImages({ data: [{ url: "https://x.invalid/a.png" }] })[0], { url: "https://x.invalid/a.png" });
  // 非对象 / 空项被过滤
  assert.deepEqual(adapter.mapImages({ data: [null, 7, {}] }), []);
});

/* ─────────────────────────── ③ params 白名单事实 ─────────────────────────── */

test("③ 事实：sanitizeParams 会把图像参数全部丢弃（需另建图像白名单）", () => {
  const clean = modelDomain.sanitizeParams({
    size: "1024x1024", quality: "high", aspect_ratio: "16:9", resolution: "2k",
    response_format: "b64_json", mime_type: "image/jpeg",
    temperature: 0.2, seed: 7,
  });
  // response_format 是既有 chat 白名单成员，会被留下；图像专属键全部被丢
  assert.deepEqual(clean, { response_format: "b64_json", temperature: 0.2, seed: 7 });
  for (const key of ["size", "quality", "aspect_ratio", "resolution", "mime_type"]) {
    assert.equal(key in clean, false, key + " 目前不在 PARAM_ALLOWLIST，会被静默丢弃");
  }
  assert.equal("response_format" in clean, true, "response_format 已在 chat 白名单里，不需要新增");
});

test("③ 图像白名单（另建，不复用 chat 的）：pickImageParams 只留图像键", () => {
  assert.deepEqual(
    imageParams.pickImageParams({ quality: "high", aspect_ratio: "16:9", resolution: "2k", temperature: 0.2, seed: 7, size: "1024x1024", n: 1, mime_type: "" }),
    { quality: "high", aspect_ratio: "16:9", resolution: "2k", n: 1, seed: 7 },
    "尺寸/聊天专属键不进图像白名单，空值剔除",
  );
  assert.equal(imageParams.IMAGE_PARAM_ALLOWLIST.includes("size"), false, "size 是独立参数，不靠 params");
  assert.equal(imageParams.IMAGE_PARAM_ALLOWLIST.includes("temperature"), false, "不复用 chat 参数面");
});

test("③ 对照：adapter 本身不丢 params；丢弃发生在 model-service 的 sanitizeParams", async () => {
  const bodies = [];
  const fakeFetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: JPEG_B64 }] }) };
  };
  const out = await adapter.generateImage({ baseUrl: "https://x.invalid/v1", apiKey: "k", model: "m", prompt: "p", size: "1536x1024", count: 1, params: { quality: "high" }, fetchImpl: fakeFetch });
  assert.equal(out.res.ok, true);
  assert.equal(bodies[0].size, "1536x1024", "size 是独立参数，原样透传");
  assert.equal(bodies[0].quality, "high", "adapter 直接收 params 会原样并入请求体；过滤只发生在 model-service");
  // 若两者都给且 params 里也有 size，params 会覆盖显式 size（顺序 ...size, ...params）——记录这个既有事实
  const bodies2 = [];
  await adapter.generateImage({ baseUrl: "https://x.invalid/v1", apiKey: "k", model: "m", prompt: "p", size: "1024x1024", params: { size: "512x512" }, fetchImpl: async (u, i) => { bodies2.push(JSON.parse(i.body)); return { ok: true, status: 200, json: async () => ({ data: [] }) }; } });
  assert.equal(bodies2[0].size, "512x512");
});

/* ─────────────────────────── ④ canvas-service 接线 ─────────────────────────── */

async function imageFixture() {
  const fx = await createResourceFixture();
  const store = new CanvasStore({ identity: fx.identity, clock: fx.clock });
  const service = new CanvasService({ identity: fx.identity, store, resourceStore: fx.resourceStore, authService: fx.authService, clock: fx.clock });
  const context = { sessionRef: fx.sessions.admin, appId: "canvas", source: "ui" };
  const created = service.createCanvas({ context, title: "画布", icon: "🧩" });
  assert.equal(created.ok, true, JSON.stringify(created));
  const verified = fx.identity.validateSession(fx.sessions.admin, { sensitive: false });
  return { fx, store, service, context, canvasId: created.canvas.canvasId, userId: verified.user.id };
}

function fakeRuntime() {
  const taskService = {
    getTask: () => ({ ok: true, task: { revision: 1, cancelRequested: false, status: "RUNNING" } }),
    getTaskBudget: () => ({ ok: true, remaining: { MODEL_CALLS: 10 }, authorized: {}, consumed: {} }),
    checkModelConfig: () => ({ ok: true }),
    startModelCall: () => ({ ok: true, call: { callId: "call_1" } }),
    completeModelCall: () => ({ ok: true }),
    failModelCall: () => ({ ok: true }),
    recordBudgetConsumption: () => ({ ok: true }),
  };
  const modelService = {
    requests: [],
    async generateImage(input) {
      modelService.requests.push(input);
      return { ok: true, images: [{ dataUrl: "data:image/jpeg;base64," + JPEG_B64 }], requestId: "r1" };
    },
  };
  return { taskService, modelService };
}

async function imageCall(f, nodeFields, callArgs = {}) {
  const nodeId = "gen_" + Math.random().toString(36).slice(2, 7);
  const added = f.service.applyCommand({ context: f.context, canvasId: f.canvasId, baseRevision: f.store.boardById(f.canvasId).revision, command: { type: "node.add", node: { id: nodeId, type: "generator", x: 0, y: 0, ...nodeFields } } });
  assert.equal(added.ok, true, JSON.stringify(added));
  const revision = Number(f.store.boardById(f.canvasId).revision);
  const run = f.store.insertRun({ runId: "run_" + Math.random().toString(36).slice(2, 7), canvasId: f.canvasId, nodeId, kind: "image", actorUserId: f.userId, taskId: "task_1", baseRevision: revision });
  const runtime = fakeRuntime();
  f.service.attachRuntime({ taskService: runtime.taskService, modelService: runtime.modelService });
  const res = await f.service.modelCall({ context: f.context, canvasId: f.canvasId, runId: run.run_id, kind: "image", prompt: "p", ...callArgs });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(runtime.modelService.requests.length, 1);
  return runtime.modelService.requests[0].size;
}

test("④ modelCall：节点的 ratio/resolution 真的映射进 generateImage 的 size", async () => {
  const f = await imageFixture();
  try {
    assert.equal(await imageCall(f, { ratio: "1:1", resolution: "1k" }), "1024x1024");
    assert.equal(await imageCall(f, { ratio: "wide", resolution: "1k" }), "1536x864");
    assert.equal(await imageCall(f, { ratio: "story", resolution: "1k" }), "864x1536");
    assert.equal(await imageCall(f, { ratio: "portrait", resolution: "2k" }), "1360x2048");
    assert.equal(await imageCall(f, { ratio: "5:4", resolution: "1k" }), "1280x1024");
    assert.equal(await imageCall(f, { ratio: "3:1", resolution: "1k" }), "1536x512");
    // 官方 1k 超上限的 21:9 按该档像素上限收窄到与页面一致
    assert.equal(await imageCall(f, { ratio: "21:9", resolution: "1k" }), "1904x816");
  } finally { f.fx.close(); }
});

test("④ modelCall：显式 size 与显式 ratio 参数的优先级", async () => {
  const f = await imageFixture();
  try {
    assert.equal(await imageCall(f, { ratio: "1:1", resolution: "1k" }, { size: "1536x1024" }), "1536x1024", "显式 size 压过节点比例");
    assert.equal(await imageCall(f, { ratio: "1:1", resolution: "1k" }, { ratio: "9:16" }), "864x1536", "显式 ratio 压过节点 ratio");
    assert.equal(await imageCall(f, { ratio: "1:1", resolution: "1k" }, { resolution: "4k" }), "2880x2880", "显式 resolution 压过节点 resolution");
  } finally { f.fx.close(); }
});

test("④ modelCall：节点没有比例/分辨率 → size 为 null（不造尺寸，不改变旧行为）", async () => {
  const f = await imageFixture();
  try {
    assert.equal(await imageCall(f, { type: "generator" }), null);
  } finally { f.fx.close(); }
});

/* ───────────── ⑤ model-service.generateImage 接线：图像参数真到达请求体 ───────────── */

/**
 * 真实 ModelService + 真实 ModelStore，只把 fetch 换成捕获请求体的桩。
 * 一个模型同时声明 chat / image-generation，用来同口径对照两条路径的 params 过滤。
 */
async function generateImageFixture() {
  const bodies = [];
  const f = await createModelFixture({
    fetchImpl: async (url, init) => {
      bodies.push({ url: String(url), body: JSON.parse(init.body) });
      if (String(url).endsWith("/chat/completions")) {
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }], usage: null }) };
      }
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: JPEG_B64, mime_type: "image/jpeg" }] }) };
    },
  });
  f.store.upsertApp({ appId: "settings", name: "系统设置", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
  f.modelService.grantAppModelAccess({ context: f.adminCtx(), appId: "settings", actions: ["model.view", "model.use", "model.manage", "model.test"] });
  const context = { ...f.adminCtx(), appId: "settings" };
  const provider = f.modelService.createProvider({ context, displayName: "ImageStub", baseUrl: "http://127.0.0.1:9", credentialSecret: "FAKE_IMG_PARAMS" });
  assert.equal(provider.ok, true, JSON.stringify(provider));
  const model = f.modelService.createModel({ context, providerId: provider.provider.providerId, remoteModelId: "img-stub", capabilities: ["chat", "image-generation"] });
  assert.equal(model.ok, true, JSON.stringify(model));
  assert.equal(f.modelService.setDefault({ context, capability: "image-generation", configId: model.model.configId }).ok, true);
  assert.equal(f.modelService.setDefault({ context, capability: "chat", configId: model.model.configId }).ok, true);
  return { f, bodies, context, close: () => f.close() };
}

test("⑤ generateImage：quality/resolution/aspect_ratio 等图像参数现在到达请求体", async () => {
  const fx = await generateImageFixture();
  try {
    const out = await fx.f.modelService.generateImage({
      context: fx.context, prompt: "一只猫", size: "1536x1024",
      params: {
        quality: "high", resolution: "2k", aspect_ratio: "16:9", response_format: "b64_json",
        mime_type: "image/jpeg", output_format: "png", style: "vivid", moderation: "low",
        // 对话专属键必须在图像路径继续被丢
        temperature: 0.2, top_p: 0.9, max_tokens: 32, tools: [{ type: "function" }],
      },
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    const body = fx.bodies[0].body;
    assert.equal(fx.bodies[0].url, "http://127.0.0.1:9/images/generations");
    assert.deepEqual(
      {
        quality: body.quality, resolution: body.resolution, aspect_ratio: body.aspect_ratio,
        response_format: body.response_format, mime_type: body.mime_type,
        output_format: body.output_format, style: body.style, moderation: body.moderation,
      },
      {
        quality: "high", resolution: "2k", aspect_ratio: "16:9",
        response_format: "b64_json", mime_type: "image/jpeg",
        output_format: "png", style: "vivid", moderation: "low",
      },
      "接线前这些键被 domain.sanitizeParams 静默丢弃，现在必须原样进请求体",
    );
    for (const key of ["temperature", "top_p", "max_tokens", "tools"]) {
      assert.equal(key in body, false, key + " 是对话专属键，不该出现在图像请求体");
    }
    assert.equal(body.model, "img-stub");
    assert.equal(body.prompt, "一只猫");
    assert.equal(body.size, "1536x1024", "size 仍由独立入参承载");
  } finally { fx.close(); }
});

test("⑤ generateImage：params 里的 size 不覆盖显式 size（size 不在图像白名单）", async () => {
  const fx = await generateImageFixture();
  try {
    await fx.f.modelService.generateImage({ context: fx.context, prompt: "p", size: "1024x1024", params: { size: "512x512", quality: "low" } });
    assert.equal(fx.bodies[0].body.size, "1024x1024", "显式 size 优先，params 不得覆盖");
    assert.equal(fx.bodies[0].body.quality, "low", "同一对象里的合法图像键仍要到达");
    // 没有显式 size 时，params 里的 size 只能被丢弃 → 不发 size 键（交给上游默认），绝不造假尺寸
    await fx.f.modelService.generateImage({ context: fx.context, prompt: "p", params: { size: "512x512" } });
    assert.equal("size" in fx.bodies[1].body, false, "params 的 size 不得成为请求体 size");
  } finally { fx.close(); }
});

test("⑤ 对话路径不放松：chat 仍走 sanitizeParams，图像键被丢、对话键保留", async () => {
  const fx = await generateImageFixture();
  try {
    const out = await fx.f.modelService.chat({
      context: fx.context, messages: [{ role: "user", content: "hi" }],
      params: { temperature: 0.2, seed: 7, quality: "high", aspect_ratio: "16:9", resolution: "2k", mime_type: "image/jpeg" },
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(fx.bodies[0].url, "http://127.0.0.1:9/chat/completions");
    const body = fx.bodies[0].body;
    assert.equal(body.temperature, 0.2);
    assert.equal(body.seed, 7);
    for (const key of ["quality", "aspect_ratio", "resolution", "mime_type"]) {
      assert.equal(key in body, false, key + " 必须在对话路径继续被丢弃（不得顺手放宽）");
    }
  } finally { fx.close(); }
});
