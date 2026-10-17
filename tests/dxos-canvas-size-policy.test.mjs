/**
 * DXOS-CANVAS-SIZE-POLICY · 画布尺寸策略端点 + 页面 apiImageSize 算法修复的纯离线单测。
 *
 * 覆盖：
 *   A. 桥显式登记 GET /api/ai/size-policy → model.sizePolicy；未登记端点仍 501、出网仍拒；
 *   B. 宿主策略表与页面 shared/size-policy.js 的期望形状一致，值与 electron/image-params.cjs 唯一真源同源
 *      （同一个策略对象引用，不是又抄一份）；
 *   C. 直接执行页面真实的 apiImageSize（从 public/novai-canvas/static/js/smart-canvas.js 抽取函数/常量文本 +
 *      加载真实的 shared/size-policy.js），断言 15 个具名比例 × 3 档位 + custom 用例比例正确且不超该档像素上限，
 *      并逐条钉住修复前的错误值（对照表）。经典 canvas.js 已随传统编辑器删除（第 13 处 vendor 改动）；
 *      页面算法与宿主 image-params.sizeFromRatio 的口径不变，断言未放宽。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BRIDGE_SOURCE = fs.readFileSync(path.join(ROOT, "public/novai-canvas/openarc-bridge.js"), "utf8");
const SIZE_POLICY_SOURCE = fs.readFileSync(path.join(ROOT, "public/novai-canvas/static/js/shared/size-policy.js"), "utf8");
const CANVAS_JS_SOURCE = fs.readFileSync(path.join(ROOT, "public/novai-canvas/static/js/smart-canvas.js"), "utf8");
const imageParams = require("../electron/image-params.cjs");

const tick = () => new Promise((r) => setTimeout(r, 0));

/* ───────────────────────── 1. 桥：GET /api/ai/size-policy 显式登记 ───────────────────────── */

class FakeStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return Array.from(this.map.keys())[i] ?? null; }
  getItem(k) { return this.map.has(String(k)) ? this.map.get(String(k)) : null; }
  setItem(k, v) { this.map.set(String(k), String(v)); }
  removeItem(k) { this.map.delete(String(k)); }
  clear() { this.map.clear(); }
}
class FakeCustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }

function loadBridge() {
  const posted = [];
  const listeners = {};
  class FakeXHR {}
  class FakeWebSocket {}
  const win = {
    top: null, self: null, window: null,
    parent: { postMessage: (msg) => { posted.push(msg); } },
    location: { href: "openarc-canvas://bundle/static/canvas.html", origin: "openarc-canvas://bundle", hash: "" },
    localStorage: new FakeStorage(),
    sessionStorage: new FakeStorage(),
    XMLHttpRequest: FakeXHR,
    WebSocket: FakeWebSocket,
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: () => {},
    dispatchEvent: () => true,
    fetch: async () => new Response("", { status: 200 }),
  };
  win.top = win; win.self = win; win.window = win;
  const doc = { documentElement: { setAttribute: () => {} }, addEventListener: () => {}, removeEventListener: () => {} };
  const sandbox = {
    window: win, document: doc, console,
    Response, ReadableStream, TextEncoder, TextDecoder, URL, DOMException, CustomEvent: FakeCustomEvent,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    FormData: undefined, FileReader: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(BRIDGE_SOURCE, sandbox, { filename: "openarc-bridge.js" });
  const fire = (data) => { for (const fn of listeners.message || []) fn({ data, source: null }); };
  fire({ ch: "openarc.canvas", dir: "host->canvas", kind: "hello", token: "tok1", readOnly: false, canEdit: true, canvasId: "cv1", accountKey: "k1", reducedMotion: false });
  const lastCall = (method) => [...posted].reverse().find((m) => m.kind === "call" && m.method === method) || null;
  return { win, posted, fire, lastCall };
}
const json = async (res) => { const t = await res.text(); try { return JSON.parse(t); } catch { return t; } };

/** 与宿主 buildSizePolicyTable 同一口径的策略表（gpt 家族 + 普通模型）。*/
const POLICY_TABLE = imageParams.buildSizePolicyTable([
  { key: "gpt-image-2", model: "gpt-image-2" },
  { key: "openai/gpt-image-2.5", model: "openai/gpt-image-2.5" },
  { key: "flux-pro", model: "flux-pro" },
]);

test("A1 · 桥登记 GET /api/ai/size-policy → model.sizePolicy（带实例 token、无参数）", async () => {
  const b = loadBridge();
  const p = b.win.fetch("/api/ai/size-policy", { method: "GET", headers: { Accept: "application/json" } });
  await tick();
  const call = b.lastCall("model.sizePolicy");
  assert.ok(call, "必须登记为 model.sizePolicy");
  assert.equal(call.token, "tok1");
  assert.equal(Object.keys(call.params || {}).length, 0, "策略端点无参数");
  assert.equal(call.stream, undefined);
  b.fire({ ch: "openarc.canvas", dir: "host->canvas", kind: "result", id: call.id, ok: true, value: POLICY_TABLE });
  const res = await p;
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.format, "novai-size-policy/v1");
  assert.deepEqual(Object.keys(body.models).sort(), ["gpt-image-2", "openai/gpt-image-2.5"]);
  assert.equal(body.models["gpt-image-2"].mode, "enum");
  assert.equal(body.models["flux-pro"], undefined, "非 gpt 模型走 default，不进 models");
  // 端点同时下发尺寸表投影：页面 normalizeTable 忽略未知字段，探针/测试用它逐格核对
  assert.deepEqual(body.sizes, JSON.parse(JSON.stringify(imageParams.IMAGE_SIZE_TABLE)), "端点 sizes 必须等于宿主官方 15 比例表");
  assert.deepEqual(body.gptSizes, JSON.parse(JSON.stringify(imageParams.GPT_IMAGE_SIZE_TABLE)), "端点 gptSizes 必须等于宿主派生表");
  assert.equal(Object.keys(body.sizes).length, 15);
});

test("A2 · 只加登记项：非 GET / 未登记端点仍 501，出网仍拒", async () => {
  const b = loadBridge();
  const post = await b.win.fetch("/api/ai/size-policy", { method: "POST", body: "{}" });
  assert.equal(post.status, 501);
  assert.equal((await json(post)).error, "OPENARC_UNSUPPORTED");
  for (const url of ["/api/agent/plan", "/api/image/upscale"]) {
    const res = await b.win.fetch(url, { method: "POST", body: "{}" });
    assert.equal(res.status, 501, url);
    assert.equal((await json(res)).error, "OPENARC_UNSUPPORTED", url);
  }
  const egress = await b.win.fetch("https://example.com/steal");
  assert.equal(egress.status, 501);
  assert.equal((await json(egress)).error, "OPENARC_EGRESS_BLOCKED");
  assert.equal(b.lastCall("model.sizePolicy"), null, "POST 不能落到策略出口");
});

/* ───────────────────── 2. 策略表：形状 / 同源 / 页面真的按它会吸附 ───────────────────── */

async function loadNova(table) {
  const sandbox = { window: {}, fetch: async () => ({ ok: true, json: async () => table }) };
  vm.createContext(sandbox);
  vm.runInContext(SIZE_POLICY_SOURCE, sandbox, { filename: "size-policy.js" });
  const nova = sandbox.window.NovaSizePolicy;
  assert.ok(nova && typeof nova.constrain === "function");
  await nova.load();
  return nova;
}

test("B1 · 策略表字段与 shared/size-policy.js 的 normalizeTable 期望一致", () => {
  assert.equal(POLICY_TABLE.format, imageParams.SIZE_POLICY_FORMAT);
  assert.equal(imageParams.SIZE_POLICY_FORMAT, "novai-size-policy/v1");
  const free = POLICY_TABLE.default;
  for (const key of ["mode", "hintOnly", "maxEdge", "maxPixels", "minPixels", "multipleOf", "options", "prefer", "autoSize", "defaultLevel", "tiers"]) {
    assert.ok(key in free, "default 缺字段 " + key);
  }
  assert.equal(free.mode, "free");
  assert.deepEqual(JSON.parse(JSON.stringify(free.tiers)), [
    { id: "1k", maxPixels: 1572864 },
    { id: "2k", maxPixels: 4194304 },
    { id: "4k", maxPixels: 8294400 },
  ]);
  const gpt = POLICY_TABLE.models["gpt-image-2"];
  assert.equal(gpt, imageParams.GPT_IMAGE_2_SIZE_POLICY, "策略必须与唯一真源同一个对象（不另写一份）");
  assert.equal(POLICY_TABLE.sizes, imageParams.IMAGE_SIZE_TABLE, "sizes 必须与唯一真源同一个对象");
  assert.equal(POLICY_TABLE.gptSizes, imageParams.GPT_IMAGE_SIZE_TABLE, "gptSizes 必须与唯一真源同一个对象");
  assert.equal(Object.keys(POLICY_TABLE.sizes).length, 15);
});

test("B2 · 页面 NovaSizePolicy 按策略表生效：gpt 家族 enum，普通模型 free + 同一份 tiers", async () => {
  const nova = await loadNova(POLICY_TABLE);
  assert.equal(nova.isEnum("gpt-image-2"), true);
  assert.equal(nova.policy("gpt-image-2").mode, "enum", "加载到真策略后不再是 free");
  assert.deepEqual(nova.enumOptions("gpt-image-2"), [...imageParams.GPT_IMAGE_2_SIZE_POLICY.options]);
  assert.deepEqual(nova.enumOptions("openai/gpt-image-2.5"), [...imageParams.GPT_IMAGE_2_SIZE_POLICY.options]);
  assert.equal(nova.policy("flux-pro").mode, "free", "普通模型走 default（free）");
  assert.equal(nova.policy("flux-pro").tiers.length, 3, "default 也带档位像素上限");
  // 真策略下的吸附：4k 方图不再送 4096x4096
  assert.equal(nova.constrain("4096x4096", "gpt-image-2"), "2048x2048");
  // 空表（未加载/端点 501）时页面退回默认 free —— 这正是要修的缺陷现场
  const empty = await loadNova(null);
  assert.equal(empty.policy("gpt-image-2").mode, "free");
  assert.equal(empty.constrain("4096x4096", "gpt-image-2"), "4096x4096");
});

/* ───────────────── 3. 页面真实 apiImageSize：从 canvas.js 抽文本执行 ───────────────── */

function extractFunction(srcText, name) {
  const re = new RegExp("(?:^|\\n)(?:async\\s+)?function\\s+" + name + "\\s*\\(");
  const m = re.exec(srcText);
  assert.ok(m, "canvas.js 必须能找到函数 " + name);
  const start = m.index + (m[0].charAt(0) === "\n" ? 1 : 0);
  let depth = 0;
  let i = srcText.indexOf("{", start);
  for (; i < srcText.length; i += 1) {
    if (srcText[i] === "{") depth += 1;
    else if (srcText[i] === "}") { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  assert.ok(depth === 0, "函数 " + name + " 抽取失败");
  return srcText.slice(start, i);
}
function extractConst(srcText, name) {
  const idx = srcText.indexOf("const " + name + " ");
  assert.ok(idx >= 0, "canvas.js 必须能找到常量 " + name);
  let depth = 0;
  let i = srcText.indexOf("=", idx);
  for (; i < srcText.length; i += 1) {
    const c = srcText[i];
    if (c === "{" || c === "[" || c === "(") depth += 1;
    else if (c === "}" || c === "]" || c === ")") depth -= 1;
    else if (c === ";" && depth === 0) { i += 1; break; }
  }
  return srcText.slice(idx, i);
}

async function loadPageApiImageSize() {
  const code = [
    extractConst(CANVAS_JS_SOURCE, "SIZE_MAP"),
    extractConst(CANVAS_JS_SOURCE, "API_RES_LEVELS"),
    extractConst(CANVAS_JS_SOURCE, "RES_LONG_SIDE"),
    extractConst(CANVAS_JS_SOURCE, "RES_PIXEL_LIMIT_FALLBACK"),
    extractFunction(CANVAS_JS_SOURCE, "parseRatioValue"),
    extractFunction(CANVAS_JS_SOURCE, "parseSizePair"),
    extractFunction(CANVAS_JS_SOURCE, "resPixelLimitFor"),
    extractFunction(CANVAS_JS_SOURCE, "fitApiSizePair"),
    extractFunction(CANVAS_JS_SOURCE, "oaTierFit"),
    extractFunction(CANVAS_JS_SOURCE, "apiImageSize"),
    "window.__apiImageSize = apiImageSize;",
  ].join("\n");
  const sandbox = { window: {}, fetch: async () => ({ ok: true, json: async () => POLICY_TABLE }) };
  vm.createContext(sandbox);
  vm.runInContext(SIZE_POLICY_SOURCE, sandbox, { filename: "size-policy.js" });
  await sandbox.window.NovaSizePolicy.load();
  sandbox.NovaSizePolicy = sandbox.window.NovaSizePolicy;
  /* 这两条只在「SIZE_MAP 没覆盖的 0.5k/1.5k/3k」分支才会被调用；本文件只断言 1k/2k/4k，
     用同形状的桩保证抽取出来的函数体可执行。真正的逐档像素表由页面的 MODEL_TIER_PIXELS 承担。*/
  sandbox.parseSizeValue = (value) => {
    const m = /^(\d+)\s*[xX*]\s*(\d+)$/.exec(String(value || "").trim());
    return m ? { width: m[1], height: m[2] } : null;
  };
  sandbox.modelTierPixelFor = () => "";
  vm.runInContext(code, sandbox, { filename: "smart-canvas-apiImageSize.js" });
  return sandbox.window.__apiImageSize;
}

const NAMED_RATIOS = {
  square: 1,
  portrait: 2 / 3,
  portrait43: 3 / 4,
  landscape43: 4 / 3,
  landscape: 3 / 2,
  story: 9 / 16,
  wide: 16 / 9,
  ultrawide: 21 / 9,
  ultratall: 9 / 21,
  portrait12: 1 / 2,
  landscape21: 2 / 1,
  landscape54: 5 / 4,
  portrait45: 4 / 5,
  landscape31: 3 / 1,
  portrait13: 1 / 3,
};
const RATIO_TOLERANCE = 0.025;
const TIER_LIMIT = { "1k": 1572864, "2k": 4194304, "4k": 8294400 };
const pairOf = (size) => { const m = /^(\d+)x(\d+)$/.exec(size); assert.ok(m, "尺寸形状 WxH：" + size); return { w: Number(m[1]), h: Number(m[2]) }; };

test("C1 · 页面 apiImageSize：15 个具名比例 × 3 档位 = 45 格 比例正确 + 不超该档像素上限 + 与宿主逐格一致", async () => {
  const apiImageSize = await loadPageApiImageSize();
  const rows = [];
  for (const [key, ratio] of Object.entries(NAMED_RATIOS)) {
    for (const level of ["1k", "2k", "4k"]) {
      const size = apiImageSize(key, level, "", "", "flux-pro");
      const { w, h } = pairOf(size);
      const err = Math.abs(w / h - ratio);
      const area = w * h;
      rows.push({ key, level, size, ratio: Number((w / h).toFixed(4)), err: Number(err.toFixed(5)), over: area > TIER_LIMIT[level] });
      assert.ok(err <= RATIO_TOLERANCE, key + "@" + level + " 比例偏差 " + err + " > " + RATIO_TOLERANCE + "（" + size + "）");
      assert.ok(area <= TIER_LIMIT[level], key + "@" + level + " 超过该档像素上限：" + size + "=" + area + " > " + TIER_LIMIT[level]);
      assert.equal(size, imageParams.resolveImageSize({ ratio: key, resolution: level }), "宿主 resolveImageSize 必须与页面 apiImageSize 逐格一致：" + key + "@" + level);
      assert.equal(
        apiImageSize(key, level, "", "", "gpt-image-2"),
        imageParams.resolveImageSize({ ratio: key, resolution: level, model: "gpt-image-2" }),
        "gpt-image-2 宿主派生表必须与页面逐格一致：" + key + "@" + level,
      );
    }
  }
  assert.equal(rows.length, 45);
  assert.equal(apiImageSize("square", "4k", "", "", "flux-pro"), "2880x2880", "square@4k 官方值正好是 4k 档上限");
  // 官方表原值留在 IMAGE_SIZE_TABLE；超过档位像素上限的格子由宿主/页面同口径收窄后再下发。
  assert.equal(imageParams.IMAGE_SIZE_TABLE.ultrawide["1k"], "2016x864", "官方原值必须保留在表里");
  assert.equal(apiImageSize("ultrawide", "1k", "", "", "flux-pro"), "1904x816");
  assert.equal(imageParams.resolveImageSize({ ratio: "ultrawide", resolution: "1k" }), "1904x816");
  // 枚举模型（gpt-image-2）仍由宿主策略吸附，不被档位收窄抢先改掉：4K 方图 → 2048x2048。
  assert.equal(apiImageSize("square", "4k", "", "", "gpt-image-2"), "2048x2048", "gpt-image-2 的 4K 方图必须吸附到宿主策略的 2048x2048");
});

test("C2 · 页面 apiImageSize：custom/customRatio 按比例对称求解（修复前后对照表）", async () => {
  const apiImageSize = await loadPageApiImageSize();
  const cases = [
    { ratio: "1:1", level: "1k", before: "1536x1248", after: "1248x1248" },
    { ratio: "4:3", level: "1k", before: "1536x1072", after: "1440x1072" },
    { ratio: "3:4", level: "1k", before: "1072x1536", after: "1072x1440" },
    { ratio: "1:1", level: "4k", before: "3840x2880", after: "2880x2880" },
    { ratio: "3:2", level: "4k", before: "3840x2336", after: "3520x2336" },
    { ratio: "2:3", level: "4k", before: "2336x3840", after: "2336x3520" },
  ];
  const table = [];
  for (const c of cases) {
    const size = apiImageSize("custom", c.level, c.ratio, "", "flux-pro");
    const parts = c.ratio.split(":").map(Number);
    const target = parts[0] / parts[1];
    const { w, h } = pairOf(size);
    const err = Math.abs(w / h - target);
    table.push({ ratio: c.ratio, level: c.level, before: c.before, after: size, err: Number(err.toFixed(5)), over: w * h > TIER_LIMIT[c.level] });
    assert.equal(size, c.after, "custom " + c.ratio + "@" + c.level + " 应为 " + c.after + "（修复前 " + c.before + "）");
    assert.ok(err <= RATIO_TOLERANCE, "custom " + c.ratio + "@" + c.level + " 比例偏差 " + err);
    assert.ok(w * h <= TIER_LIMIT[c.level], "custom " + c.ratio + "@" + c.level + " 超上限：" + size);
    assert.notEqual(size, c.before, "修复前的错误值不能再出现");
  }
  assert.deepEqual(table.map((r) => r.after), ["1248x1248", "1440x1072", "1072x1440", "2880x2880", "3520x2336", "2336x3520"]);
  // 与宿主 sizeFromRatio 同一口径（同一比例必须给同一个 16 对齐结果）
  for (const level of ["1k", "2k", "4k"]) {
    assert.equal(apiImageSize("custom", level, "1:1", "", "flux-pro"), imageParams.sizeFromRatio(1, level));
  }
});
