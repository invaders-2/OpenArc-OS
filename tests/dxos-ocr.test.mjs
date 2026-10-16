/**
 * DX OS 0.6.1 · OCR 域移植测试（全离线：无 Electron、无网络、无 sharp 真实依赖）。
 *
 * 覆盖任务书验收面：
 *   · normalizePaddleOcr 的多种响应形状（layoutParsingResults / layout_parsing_results / pages / res_list / 顶层 result）
 *   · errorCode 非 0 抛错
 *   · 无 provider 时结构化不可用（含"怎么配"提示）
 *   · 并发闸门拒绝（全局 4 / 单用户 2）
 *   另覆盖：请求地址构造与结果地址白名单、300s/32MB/24M 像素常量、ocr:command trusted 边界与事件信封、
 *           requestPaddleOcr 的提交→轮询→JSONL 下载通路（注入假 sharp + 假 fetch）。
 *
 * 只读源：server/ocr.ts、server/ocrRoutes.ts、shared/ocr.ts。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const domain = require("../electron/ocr-domain.cjs");
const service = require("../electron/ocr-service.cjs");
const { registerOcrIpc, disposeOcrIpc, OCR_NOT_READY } = require("../electron/ocr-bootstrap.cjs");
const { ProviderProtocolStore } = require("../electron/provider-protocol-store.cjs");
const { memoryCredentialBackend } = require("../electron/credential-store.cjs");

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 单页 rec_texts+rec_polys 的 PP-StructureV3 形状。 */
function ocrPage({ width = 200, height = 100, texts = ["你好"], polys = [[[10, 20], [110, 20], [110, 60], [10, 60]]], scores = [0.98] } = {}) {
  return { prunedResult: { width, height, overall_ocr_res: { rec_texts: texts, rec_polys: polys, rec_scores: scores } } };
}

function makeStore({ withProvider = true, protocol = domain.OCR_PROTOCOL, model = domain.OCR_MODEL, apiKey = "aistudio-token-abcd1234" } = {}) {
  const store = new ProviderProtocolStore({ file: null, backend: memoryCredentialBackend() });
  let id = null;
  if (withProvider) {
    const created = store.create({
      name: "PaddleOCR",
      baseUrl: "https://paddleocr.aistudio-app.com",
      protocol,
      models: [{ model }],
      apiKey,
    });
    id = created.id;
  }
  return { store, id };
}

const CONVERTED_PNG = Buffer.from("fake-converted-png-bytes");
const RAW_PIXELS = Buffer.alloc(1400 * 900 * 3, 255);

/** 与 sharp 同形的极简假实现：转换走 png()，颜色估计走 raw()。 */
function fakeSharp() {
  return (input, opts) => {
    void input;
    void opts;
    const api = {
      rawCalled: false,
      rotate() { return api; },
      png() { return api; },
      resize() { return api; },
      removeAlpha() { return api; },
      raw() { api.rawCalled = true; return api; },
      async toBuffer() {
        if (api.rawCalled) return { data: RAW_PIXELS, info: { width: 1400, height: 900, channels: 3 } };
        return { data: CONVERTED_PNG, info: { width: 200, height: 100 } };
      },
    };
    return api;
  };
}

/** ocr-service 的 sharpLoader 约定：loader 返回 sharp 同形函数。 */
const SHARP_LOADER = () => fakeSharp();

const RESULT_JSONL = JSON.stringify({ result: { layoutParsingResults: [ocrPage()] } });

/** 三跳假 fetch：POST jobs → GET jobs/:id → GET 结果 JSONL。 */
function makeFetch({ submitErrorCode = 0, jobId = "job-1", state = "done", jsonl = RESULT_JSONL, headersSeen = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = typeof url === "string" ? url : (url && url.href) || String(url);
    calls.push({ url: href, init });
    if (init.headers) headersSeen.push(init.headers);
    if (init.method === "POST") {
      return new Response(JSON.stringify({ errorCode: submitErrorCode, data: { jobId } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (/\/api\/v2\/ocr\/jobs\//.test(href)) {
      const payload = state === "done"
        ? { errorCode: 0, data: { state: "done", resultUrl: { jsonUrl: "https://paddleocr-prod.bcebos.com/result.jsonl" } } }
        : { errorCode: 0, data: { state } };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(jsonl, { status: 200, headers: { "content-type": "text/plain" } });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function makeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) { handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
    async invoke(channel, event, payload) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error("NO_HANDLER " + channel);
      return fn(event, payload);
    },
  };
}

const TRUSTED_SENDER = { id: "trusted-web-contents" };
const TRUSTED_URL = "file:///Application/OpenArc%20OS/index.html";
const trustedEvent = () => ({ sender: TRUSTED_SENDER, senderFrame: { url: TRUSTED_URL } });
const fakeEvent = () => ({ sender: { id: "evil" }, senderFrame: { url: "https://evil.example/" } });
const trustedGate = (event) => !!event && event.sender === TRUSTED_SENDER && !!event.senderFrame && event.senderFrame.url === TRUSTED_URL;

const IMAGE_B64 = Buffer.from("fake-input-image-bytes").toString("base64");

// ---------------------------------------------------------------------------
// ① normalizePaddleOcr：五种响应形状
// ---------------------------------------------------------------------------

test("normalize：layoutParsingResults（result 包裹）", () => {
  const out = domain.normalizePaddleOcr({ result: { layoutParsingResults: [ocrPage()] } }, 200, 100);
  assert.equal(out.engine, "paddleocr-vl-api");
  assert.equal(out.text, "你好");
  assert.equal(out.regions.length, 1);
  assert.deepEqual(out.regions[0].bbox, { x: 10, y: 20, width: 100, height: 40 });
  assert.equal(out.regions[0].polygon.length, 4);
  assert.equal(out.regions[0].confidence, 98);
  assert.equal(out.width, 200);
  assert.equal(out.height, 100);
});

test("normalize：layout_parsing_results（下划线别名）", () => {
  const out = domain.normalizePaddleOcr({ layout_parsing_results: [ocrPage({ texts: ["别名"], polys: [[[1, 2], [51, 2], [51, 22], [1, 22]]] })] }, 200, 100);
  assert.equal(out.text, "别名");
  assert.deepEqual(out.regions[0].bbox, { x: 1, y: 2, width: 50, height: 20 });
});

test("normalize：pages", () => {
  const out = domain.normalizePaddleOcr({ result: { pages: [ocrPage()] } }, 200, 100);
  assert.equal(out.regions.length, 1);
  assert.equal(out.regions[0].text, "你好");
});

test("normalize：res_list", () => {
  const out = domain.normalizePaddleOcr({ res_list: [ocrPage()] }, 200, 100);
  assert.equal(out.regions.length, 1);
  assert.equal(out.regions[0].text, "你好");
});

test("normalize：顶层（无 result 包裹）与 result.text 兜底", () => {
  const bare = domain.normalizePaddleOcr(ocrPage(), 200, 100);
  assert.equal(bare.text, "你好", "response.result 缺失时 result = response 自身");
  const textOnly = domain.normalizePaddleOcr({ result: { text: "纯文本结果" } }, 200, 100);
  assert.deepEqual(textOnly.regions, []);
  assert.equal(textOnly.text, "纯文本结果");
  const markdown = domain.normalizePaddleOcr({ result: { markdown: { text: "<b>markdown</b>" } } }, 200, 100);
  assert.equal(markdown.text, "markdown", "markdown 走 cleanText 去标签");
});

test("normalize：错误码 / 标签过滤 / 去重 / 归一化坐标 / bbox 对象 / 扁平 poly", () => {
  // 归一化坐标（全 0..1）按目标宽高还原。
  const normalized = domain.normalizePaddleOcr(
    { result: { layoutParsingResults: [ocrPage({ width: 1000, height: 500, polys: [[[0.1, 0.2], [0.5, 0.2], [0.5, 0.4], [0.1, 0.4]]] })] } },
    1000,
    500,
  );
  assert.deepEqual(normalized.regions[0].bbox, { x: 100, y: 100, width: 400, height: 100 });

  // parsing_res_list：block_label=image 跳过，block_bbox 对象形态，扁平 poly 形态。
  const items = domain.normalizePaddleOcr(
    {
      result: {
        layoutParsingResults: [
          { prunedResult: { width: 200, height: 100, parsing_res_list: [
            { block_label: "image", block_content: "忽略我", block_bbox: { x: 0, y: 0, width: 10, height: 10 } },
            { block_label: "text", block_content: "<p>标题</p>", block_bbox: { x: 10, y: 10, width: 60, height: 20 }, font_size: 18, font_color: "#112233", font_family: "Songti" },
            { label: "text", block_content: "扁平", block_bbox: [10, 20, 110, 20, 110, 60, 10, 60] },
            { label: "text", block_content: "扁平", block_bbox: [10, 20, 110, 20, 110, 60, 10, 60] },
          ] } },
        ],
      },
    },
    200,
    100,
  );
  assert.deepEqual(items.regions.map((r) => r.text), ["标题", "扁平"], "image 标签被过滤，重复文本+近同位置去重");
  assert.equal(items.regions[0].style.color, "#112233");
  assert.equal(items.regions[0].style.colorSource, "api");
  assert.equal(items.regions[0].style.fontSize, 18);
  assert.equal(items.regions[0].style.fontSizeSource, "api");
  assert.equal(items.regions[1].polygon.length, 4);
});

// ---------------------------------------------------------------------------
// ② errorCode 非 0 抛错
// ---------------------------------------------------------------------------

test("errorCode 非 0 抛错；0 / '0' 放行", () => {
  assert.throws(() => domain.normalizePaddleOcr({ errorCode: 1 }, 10, 10), (err) => err.code === domain.OCR_ERR_PROVIDER_FAILED);
  assert.throws(() => domain.normalizePaddleOcr({ errorCode: "2" }, 10, 10), /PaddleOCR 服务返回识别错误/);
  assert.doesNotThrow(() => domain.normalizePaddleOcr({ errorCode: 0, text: "ok" }, 10, 10));
  assert.doesNotThrow(() => domain.normalizePaddleOcr({ errorCode: "0", text: "ok" }, 10, 10));
});

// ---------------------------------------------------------------------------
// ③ 请求地址构造 / 结果地址白名单 / 配置检查
// ---------------------------------------------------------------------------

test("paddleOcrJobUrl：补路径、旧部署改道、危险地址拒绝", () => {
  assert.equal(domain.paddleOcrJobUrl("https://paddleocr.aistudio-app.com").href, domain.OCR_BASE_URL);
  assert.equal(domain.paddleOcrJobUrl("https://paddleocr.aistudio-app.com/api/v2/ocr/jobs/").pathname.replace(/\/+$/, ""), "/api/v2/ocr/jobs", "已带 jobs 路径时不重复追加（源 ocr.ts:94 保留原尾斜杠）");
  assert.equal(domain.paddleOcrJobUrl("https://n1vetck2y2l078qb.aistudio-app.com").href, domain.OCR_BASE_URL, "旧版 AIStudio 部署改道官方 jobs API");
  assert.throws(() => domain.paddleOcrJobUrl("http://paddleocr.aistudio-app.com"), /HTTPS/);
  assert.throws(() => domain.paddleOcrJobUrl("https://user:pass@paddleocr.aistudio-app.com"), /HTTPS/);
  assert.throws(() => domain.paddleOcrJobUrl("https://paddleocr.aistudio-app.com?k=1"), /HTTPS/);
});

test("paddleResultUrl：只信任百度域名白名单", () => {
  assert.equal(domain.paddleResultUrl("https://paddleocr-prod.bcebos.com/a.jsonl").hostname, "paddleocr-prod.bcebos.com");
  assert.equal(domain.paddleResultUrl("https://aistudio.baidu.com/a.jsonl").hostname, "aistudio.baidu.com");
  assert.throws(() => domain.paddleResultUrl("https://evil.example/a.jsonl"), /不受信任/);
  assert.throws(() => domain.paddleResultUrl("http://paddleocr-prod.bcebos.com/a.jsonl"), /不受信任/);
  assert.throws(() => domain.paddleResultUrl(""), /不受信任/);
});

test("verifyPaddleOcrConfiguration：配置形状与缺 Key", () => {
  const ok = domain.verifyPaddleOcrConfiguration({ base_url: "https://paddleocr.aistudio-app.com", api_key: "token" });
  assert.equal(ok.protocol, "paddleocr-vl");
  assert.deepEqual(ok.models, ["PP-StructureV3"]);
  assert.equal(ok.verification, "configuration");
  assert.throws(() => domain.verifyPaddleOcrConfiguration({ base_url: "https://paddleocr.aistudio-app.com", api_key: "  " }), /Access Token/);
});

test("常量与命令表：32MB / 24M 像素 / 300s / 全局 4 / 单用户 2 / 两条命令", () => {
  assert.equal(domain.OCR_MAX_BYTES, 32 * 1024 * 1024);
  assert.equal(domain.OCR_MAX_PIXELS, 24 * 1024 * 1024);
  assert.equal(domain.OCR_TIMEOUT_MS, 300000);
  assert.equal(domain.OCR_MAX_CONCURRENCY, 4);
  assert.equal(domain.OCR_MAX_USER_CONCURRENCY, 2);
  assert.deepEqual(domain.OCR_MODES, ["detect", "recognize"]);
  assert.deepEqual(domain.listOcrCommands().map((c) => c.command), ["ocr/providers", "ocr/recognize"]);
  assert.equal(domain.ocrCommandRequiresCredential("ocr/recognize"), true);
});

// ---------------------------------------------------------------------------
// ④ 并发闸门
// ---------------------------------------------------------------------------

test("闸门：全局 4 与单用户 2，释放后可再取", () => {
  const gate = service.createOcrGate();
  const held = [];
  for (let i = 0; i < 4; i++) held.push(gate.tryAcquire("user-" + i));
  assert.ok(held.every(Boolean));
  assert.equal(gate.tryAcquire("user-9"), null, "全局超过 4 拒绝");
  held[0].release();
  const again = gate.tryAcquire("user-9");
  assert.ok(again, "释放一个名额后可再取");
  again.release();
  for (const lease of held.slice(1)) lease.release();

  const perUser = service.createOcrGate();
  const a = perUser.tryAcquire("u-1");
  const b = perUser.tryAcquire("u-1");
  assert.ok(a && b);
  assert.equal(perUser.tryAcquire("u-1"), null, "单用户超过 2 拒绝");
  assert.ok(perUser.tryAcquire("u-2"), "其它用户不受影响");
  a.release();
  assert.ok(perUser.tryAcquire("u-1"), "释放后恢复");
});

test("闸门（端到端）：同一会话第 3 次 ocr/recognize 回 OCR_BUSY", async () => {
  const { store } = makeStore();
  const bundle = service.createOcrBundle({ providerStore: store, fetchImpl: makeFetch(), sharpLoader: SHARP_LOADER });
  const held = [bundle.gate.tryAcquire("u-busy"), bundle.gate.tryAcquire("u-busy")];
  const res = await bundle.execute("ocr/recognize", { image: IMAGE_B64 }, { sessionRef: "u-busy" });
  assert.equal(res.ok, false);
  assert.equal(res.error, domain.OCR_ERR_BUSY);
  assert.equal(res.message, "OCR 任务较多，请稍后重试");
  for (const lease of held) lease.release();
  const after = await bundle.execute("ocr/recognize", { image: IMAGE_B64 }, { sessionRef: "u-busy" });
  assert.equal(after.ok, true, "释放后识别成功");
});

// ---------------------------------------------------------------------------
// ⑤ providers 命令与无 provider 的结构化不可用
// ---------------------------------------------------------------------------

test("ocr/providers：能力与上限上报", async () => {
  const { store, id } = makeStore();
  const bundle = service.createOcrBundle({ providerStore: store });
  const res = await bundle.execute("ocr/providers", {}, { sessionRef: "sess-1" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.available, true);
  assert.equal(res.value.local, false);
  assert.equal(res.value.maxBytes, 32 * 1024 * 1024);
  assert.equal(res.value.maxPixels, 24 * 1024 * 1024);
  assert.equal(res.value.boundingBoxes, true);
  assert.deepEqual(res.value.modes, ["detect", "recognize"]);
  assert.deepEqual(res.value.providers, [{ id, name: "PaddleOCR" }]);
});

test("无 provider：结构化 OCR_UNAVAILABLE 且带「怎么配」提示，绝不假成功", async () => {
  const empty = makeStore({ withProvider: false });
  const bundle = service.createOcrBundle({ providerStore: empty.store, fetchImpl: makeFetch(), sharpLoader: SHARP_LOADER });
  const res = await bundle.execute("ocr/recognize", { image: IMAGE_B64 }, { sessionRef: "sess-1" });
  assert.equal(res.ok, false);
  assert.equal(res.error, domain.OCR_ERR_UNAVAILABLE);
  assert.match(res.message, /请先在「系统设置 › 模型与服务商」中添加并启用 PaddleOCR/);
  assert.match(res.detail.hint, /base_url/);
  assert.match(res.detail.hint, /paddleocr-vl/);
  assert.match(res.detail.hint, /PP-StructureV3/);
  assert.equal(res.detail.keyUrl, domain.OCR_KEY_URL);

  // 有 provider 但缺 Key（未配置密钥）同样结构化不可用。
  const noKey = new ProviderProtocolStore({ file: null, backend: memoryCredentialBackend() });
  noKey.create({ name: "PaddleOCR", baseUrl: "https://paddleocr.aistudio-app.com", protocol: domain.OCR_PROTOCOL, models: [{ model: domain.OCR_MODEL }] });
  const noKeyBundle = service.createOcrBundle({ providerStore: noKey, fetchImpl: makeFetch(), sharpLoader: SHARP_LOADER });
  const noKeyRes = await noKeyBundle.execute("ocr/recognize", { image: IMAGE_B64 }, { sessionRef: "sess-1" });
  assert.equal(noKeyRes.ok, false);
  assert.equal(noKeyRes.error, domain.OCR_ERR_UNAVAILABLE);
  assert.match(noKeyRes.detail.hint, /PP-StructureV3/, "缺 Key 与完全没有供应商都给出同一份配置提示");
});

test("providers：协议或模型不匹配的供应商不算可用（源 ocrRoutes.ts:14 过滤）", async () => {
  const wrongProtocol = makeStore({ protocol: "openai" });
  const wrongModel = makeStore({ model: "gpt-4o" });
  for (const fixture of [wrongProtocol, wrongModel]) {
    const bundle = service.createOcrBundle({ providerStore: fixture.store });
    const res = await bundle.execute("ocr/providers", {}, { sessionRef: "sess-1" });
    assert.equal(res.value.available, false);
    assert.deepEqual(res.value.providers, []);
  }
});

// ---------------------------------------------------------------------------
// ⑥ requestPaddleOcr 通路（注入假 sharp + 假 fetch）
// ---------------------------------------------------------------------------

test("recognize：提交→轮询→JSONL 下载→OcrResult，Authorization 为小写 bearer", async () => {
  const { store } = makeStore();
  const headersSeen = [];
  const fetchImpl = makeFetch({ headersSeen });
  const bundle = service.createOcrBundle({ providerStore: store, fetchImpl, sharpLoader: SHARP_LOADER });
  const res = await bundle.execute("ocr/recognize", { image: IMAGE_B64 }, { sessionRef: "sess-1" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.engine, "paddleocr-vl-api");
  assert.equal(res.value.text, "你好");
  assert.equal(res.value.regions.length, 1);
  assert.equal(res.value.width, 200);
  assert.equal(res.value.height, 100);
  assert.equal(fetchImpl.calls.length, 3, "提交 + 轮询 + 结果下载");
  assert.equal(fetchImpl.calls[0].url, domain.OCR_BASE_URL);
  assert.equal(fetchImpl.calls[0].init.method, "POST");
  assert.match(fetchImpl.calls[1].url, /\/api\/v2\/ocr\/jobs\/job-1$/);
  assert.equal(fetchImpl.calls[2].url, "https://paddleocr-prod.bcebos.com/result.jsonl");
  assert.match(headersSeen[0].Authorization, /^bearer /);
  assert.equal(fetchImpl.calls.reduce((sum, call) => sum + (call.init.redirect === "error" ? 1 : 0), 0), 3, "全部 redirect:error");
  assert.equal(fetchImpl.calls.some((call) => call.url.includes("paddleocr-prod") && call.init.headers && call.init.headers.Authorization !== undefined), false, "结果下载绝不带 Token（源 ocr.ts:158-159）");
});

test("recognize：includeImage 走 base64url 出口（无 + / =，绕开 foundation 路径替换）", async () => {
  const { store } = makeStore();
  const bundle = service.createOcrBundle({ providerStore: store, fetchImpl: makeFetch(), sharpLoader: SHARP_LOADER });
  const res = await bundle.execute("ocr/recognize", { image: IMAGE_B64, includeImage: true }, { sessionRef: "sess-1" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.image.mime, "image/png");
  assert.equal(res.value.image.bytes, CONVERTED_PNG.length);
  assert.equal(res.value.image.data, CONVERTED_PNG.toString("base64url"));
  assert.equal(/[+/=]/.test(res.value.image.data), false);
});

test("recognize：结果 errorCode 非 0 → OCR_PROVIDER_FAILED（不假成功）", async () => {
  const { store } = makeStore();
  const fetchImpl = makeFetch({ jsonl: JSON.stringify({ errorCode: 1 }) });
  const bundle = service.createOcrBundle({ providerStore: store, fetchImpl, sharpLoader: SHARP_LOADER });
  const res = await bundle.execute("ocr/recognize", { image: IMAGE_B64 }, { sessionRef: "sess-1" });
  assert.equal(res.ok, false);
  assert.equal(res.error, domain.OCR_ERR_PROVIDER_FAILED);
  assert.match(res.message, /PaddleOCR 服务返回识别错误/);
});

test("recognize：任务 failed / 未知状态回结构化失败", async () => {
  const { store } = makeStore();
  for (const state of ["failed", "queued"]) {
    const bundle = service.createOcrBundle({ providerStore: store, fetchImpl: makeFetch({ state }), sharpLoader: SHARP_LOADER });
    const res = await bundle.execute("ocr/recognize", { image: IMAGE_B64 }, { sessionRef: "sess-1" });
    assert.equal(res.ok, false);
    assert.equal(res.error, domain.OCR_ERR_PROVIDER_FAILED);
  }
});

test("recognize：缺图 / 空图 / 超 32MB 回 OCR_INVALID_INPUT", async () => {
  const { store } = makeStore();
  const bundle = service.createOcrBundle({ providerStore: store, fetchImpl: makeFetch(), sharpLoader: SHARP_LOADER });
  for (const payload of [{}, { image: "" }, { image: "!!!!" }, { bytes: [] }]) {
    const res = await bundle.execute("ocr/recognize", payload, { sessionRef: "sess-1" });
    assert.equal(res.ok, false, JSON.stringify(payload));
    assert.equal(res.error, domain.OCR_ERR_INVALID_INPUT);
  }
  assert.throws(() => service.decodeOcrImage({ bytes: Buffer.alloc(domain.OCR_MAX_BYTES + 1) }), (err) => err.code === domain.OCR_ERR_INVALID_INPUT && /32 MB/.test(err.message));
});

test("resolveSharp：注入优先；惰性 require 失败 → OCR_DEPENDENCY_UNAVAILABLE（绝不假图）", () => {
  const injectedSharp = () => undefined;
  assert.equal(service.resolveSharp(() => injectedSharp), injectedSharp, "注入的 loader 生效");
  let installed = true;
  try {
    require.resolve("sharp");
  } catch {
    installed = false;
  }
  if (installed) {
    assert.equal(typeof service.resolveSharp(null), "function", "本机装有 sharp：惰性 require 成功（sharp 非直接依赖）");
  } else {
    assert.throws(() => service.resolveSharp(null), (err) => err.code === domain.OCR_ERR_DEPENDENCY_UNAVAILABLE && /sharp/.test(err.message));
  }
});

// ---------------------------------------------------------------------------
// ⑦ bootstrap：trusted 边界 / 白名单 / 未装配 / dispose / 事件信封
// ---------------------------------------------------------------------------

function makeBundle() {
  const { store } = makeStore();
  return service.createOcrBundle({ providerStore: store, fetchImpl: makeFetch(), sharpLoader: SHARP_LOADER });
}

test("bootstrap：缺 isTrusted / 伪造 sender 一律 Forbidden，且先于 bundle 判空", async () => {
  const ipcMain = makeIpcMain();
  registerOcrIpc({ ipcMain, bundle: makeBundle(), identity: { current: "sess-1" } });
  await assert.rejects(() => ipcMain.invoke("ocr:command", trustedEvent(), { command: "ocr/providers" }), /Forbidden/);
  disposeOcrIpc({ ipcMain });
  registerOcrIpc({ ipcMain, bundle: null, isTrusted: trustedGate, identity: { current: "sess-1" } });
  await assert.rejects(() => ipcMain.invoke("ocr:command", fakeEvent(), { command: "ocr/providers" }), /Forbidden/);
  const notReady = await ipcMain.invoke("ocr:command", trustedEvent(), { command: "ocr/providers" });
  assert.equal(notReady.ok, false);
  assert.equal(notReady.error, OCR_NOT_READY);
});

test("bootstrap：白名单 / command 与 type 两种写法 / 非对象载荷", async () => {
  const ipcMain = makeIpcMain();
  registerOcrIpc({ ipcMain, bundle: makeBundle(), isTrusted: trustedGate, identity: { current: "sess-1" } });
  const bad = await ipcMain.invoke("ocr:command", trustedEvent(), { command: "ocr/nope" });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "OCR_COMMAND_NOT_ALLOWED");
  const notObject = await ipcMain.invoke("ocr:command", trustedEvent(), "not-an-object");
  assert.equal(notObject.ok, false);
  assert.equal(notObject.error, "OCR_INVALID_INPUT");
  const byCommand = await ipcMain.invoke("ocr:command", trustedEvent(), { command: "ocr/providers", payload: {} });
  assert.equal(byCommand.ok, true, JSON.stringify(byCommand));
  const byType = await ipcMain.invoke("ocr:command", trustedEvent(), { type: "ocr/providers", payload: {} });
  assert.equal(byType.ok, true);
});

test("bootstrap：identity.current 为空 → OCR_UNAUTHENTICATED（fail closed，忽略 payload.userId）", async () => {
  const ipcMain = makeIpcMain();
  registerOcrIpc({ ipcMain, bundle: makeBundle(), isTrusted: trustedGate, identity: { current: null } });
  const unauth = await ipcMain.invoke("ocr:command", trustedEvent(), { command: "ocr/providers", payload: { userId: "attacker", role: "ADMIN" } });
  assert.equal(unauth.ok, false);
  assert.equal(unauth.error, "OCR_UNAUTHENTICATED");
});

test("bootstrap：ocr:event 为 P1 六字段且 sequence 单调", async () => {
  const ipcMain = makeIpcMain();
  const events = [];
  registerOcrIpc({ ipcMain, bundle: makeBundle(), isTrusted: trustedGate, identity: { current: "sess-1" }, send: (event) => events.push(event) });
  await ipcMain.invoke("ocr:command", trustedEvent(), { command: "ocr/providers", payload: {} });
  await ipcMain.invoke("ocr:command", trustedEvent(), { command: "ocr/providers", payload: {} });
  assert.equal(events.length, 4, "每条命令 begin + completed");
  let last = 0;
  for (const event of events) {
    assert.equal(event.channel, "ocr:event");
    assert.equal(event.domain, "ocr");
    assert.equal(event.kind, "progress");
    assert.equal(typeof event.at, "number");
    assert.ok(event.sequence > last);
    last = event.sequence;
  }
  assert.deepEqual(events.map((event) => event.payload.phase), ["begin", "completed", "begin", "completed"]);
});

test("bootstrap：dispose 移除 handler，可重复注册", async () => {
  const ipcMain = makeIpcMain();
  const bundle = makeBundle();
  registerOcrIpc({ ipcMain, bundle, isTrusted: trustedGate, identity: { current: "sess-1" } });
  assert.equal(ipcMain.handlers.has("ocr:command"), true);
  disposeOcrIpc({ ipcMain });
  assert.equal(ipcMain.handlers.has("ocr:command"), false);
  await assert.rejects(() => ipcMain.invoke("ocr:command", trustedEvent(), { command: "ocr/providers" }), /NO_HANDLER/);
  registerOcrIpc({ ipcMain, bundle, isTrusted: trustedGate, identity: { current: "sess-1" } });
  assert.equal(ipcMain.handlers.has("ocr:command"), true);
});
