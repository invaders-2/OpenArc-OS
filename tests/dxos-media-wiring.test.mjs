/**
 * B5f · 媒体域依赖接线测试（全离线：假 ipcMain / 假 authorization / 临时 userData，不启动 Electron、不联网）。
 *
 * 覆盖本轮验收条目：
 *   ① 装配契约（源码级）：main.cjs 用已经存在的真实依赖装配 createMediaBundle——
 *      fsAdapter 复用 B6d 的 DX 虚拟文件树、fetchImpl 走主进程 fetch + 出口护栏、
 *      providerStore / modelGateway 走 B2 provider-protocol、viteBuild 如实 null；
 *   ② 装配契约（同一 helper 进程内真跑）：注入 fsAdapter / fetchImpl 后 media/health
 *      的 dependencies 为真，未注入仍为假且 dependencyNotes 给原因；
 *   ③ 端到端：media:command 的「短剧分镜 → 生成分镜图 → 渲染提交」经注入 fsAdapter
 *      真实落 <userData>/dxos/fs（fs.json + blobs）；音乐库扫描真实落 <userData>/dxos/media；
 *   ④ 抠图：本机缺 onnxruntime 时结构化不可用（如实）；注入假 session 后成功；
 *   ⑤ 依赖缺失不降低为假成功：未注入的注入面继续 MEDIA_DEPENDENCY_UNAVAILABLE；
 *   ⑥ 出口护栏：媒体域 fetch 拒绝 api.dx-os.com。
 *
 * 只读源：electron/main.cjs、media-service.cjs、media-bootstrap.cjs、dxos-fs-adapter.cjs、
 *         provider-adapter-bridge.cjs、provider-protocol-service.cjs。
 */
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const mediaDomain = require("../electron/media-domain.cjs");
const mediaStore = require("../electron/media-store.cjs");
const {
  createMediaBundle,
  createMediaProviderStore,
  createMediaModelGateway,
  createGuardedFetch,
  probeIllustratorAvailability,
  probeOnnxAvailability,
} = require("../electron/media-service.cjs");
const { registerMediaIpc } = require("../electron/media-bootstrap.cjs");
const { createDxosFsAdapterForUserData } = require("../electron/agent-service.cjs");
const library = require("../electron/media-library.cjs");
const backgroundRemoval = require("../electron/media-background-removal.cjs");
const shortDrama = require("../electron/media-short-drama.cjs");
const figma = require("../electron/media-figma-preview.cjs");
const illustrator = require("../electron/media-illustrator.cjs");

const tmpDirs = [];
after(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  // 媒体子模块是模块级注入：每个用例后清空，避免共享单例把上一例的依赖带进下一例。
  mediaStore.resetMediaStoreForTests();
  library.resetLibraryForTests();
  backgroundRemoval.configureBackgroundRemoval({ modelDir: null, modelPath: null, models: undefined, onnxRuntime: null, onnxSessionFactory: null, sharpLoader: null, model: null });
  shortDrama.configureShortDrama({ dataDir: null, fsAdapter: null, fetchImpl: null, providerStore: null, modelGateway: null, renderSubmit: null });
  figma.configureFigmaPreview({ dataDir: null, fetchImpl: null, viteBuild: null, vuePlugin: null });
  illustrator.configureIllustrator({ illustratorAvailable: false, dataDir: null, tmpDir: null });
});

const STUB_AUTH = {
  resolveActor: ({ context }) => (context && context.sessionRef
    ? { ok: true, user: { id: "u-b5f" } }
    : { ok: false, error: "no-session" }),
};

/** 假 ipcMain：与 electron/media-bootstrap.cjs:37 的用法一致（handle / removeHandler）。 */
function makeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) { handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
    invoke(channel, event, payload) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error("NO_HANDLER " + channel);
      return fn(event, payload);
    },
  };
}

/** 经 media:command 的调用面（与 tests/dxos-media-ipc.test.mjs 同一手法）。 */
function makeMediaCall(bundle) {
  const ipcMain = makeIpcMain();
  registerMediaIpc({ ipcMain, bundle, identity: { current: "sess-b5f" }, isTrusted: (event) => !!event && event.sender === "trusted", send: () => {} });
  return (command, payload) => ipcMain.invoke("media:command", { sender: "trusted" }, { command, payload });
}

function openBundle(dir, options = {}) {
  mediaStore.resetMediaStoreForTests();
  return createMediaBundle(Object.assign({ userDataDir: dir, authorization: STUB_AUTH, clock: () => Date.now() }, options));
}

// ---------------------------------------------------------------------------
// ① 装配契约（源码级）
// ---------------------------------------------------------------------------
test("装配契约（源码）：main.cjs 用真实依赖装配 media bundle，viteBuild 如实 null、无写死 null 的注入面", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "electron", "main.cjs"), "utf8");

  // 真实依赖装配件必须被 main.cjs 调用（不新造第二套）。
  assert.ok(main.includes("createMediaProviderStore"), "main.cjs 必须复用 createMediaProviderStore（B2 provider-protocol）");
  assert.ok(main.includes("createMediaModelGateway"), "main.cjs 必须复用 createMediaModelGateway（B2 模型出口）");
  assert.ok(main.includes("createGuardedFetch"), "main.cjs 必须用出口护栏包装主进程 fetch");
  assert.ok(main.includes("probeIllustratorAvailability"), "Illustrator 可用性必须由依赖探测给出");
  assert.ok(main.includes("probeOnnxAvailability"), "onnxruntime / 模型文件必须由依赖探测给出");
  assert.match(main, /createDxosFsAdapterForUserData\(app\.getPath\("userData"\)\)/, "fsAdapter 必须复用 B6d 的 <userData>/dxos/fs 装配");

  const call = main.slice(main.indexOf("mediaBundle = createMediaBundle({"), main.indexOf("registerMediaIpc({"));
  assert.ok(call.length > 0, "找不到 mediaBundle 装配块");
  assert.match(call, /fsAdapter:\s*dxosFsAdapter/, "media bundle 必须收到同一份 DX 虚拟文件树");
  assert.match(call, /fetchImpl:\s*mediaFetchImpl/, "media bundle 必须收到受护栏的 fetch");
  assert.match(call, /providerStore:\s*mediaProviderStore/, "media bundle 必须收到 B2 选型面");
  assert.match(call, /modelGateway:\s*mediaModelGateway/, "media bundle 必须收到 B2 模型出口");
  assert.match(call, /illustratorAvailable:\s*probeIllustratorAvailability\(\)/, "illustratorAvailable 必须是探测结果");
  assert.match(call, /viteBuild:\s*null/, "本仓无随包 Vite 构建器时必须如实 null");
  assert.ok(!/fsAdapter:\s*null/.test(call), "media bundle 不得再把 fsAdapter 写死 null");
  assert.ok(!/fetchImpl:\s*null/.test(call), "media bundle 不得再把 fetchImpl 写死 null");
});

// ---------------------------------------------------------------------------
// ② 装配契约（同一 helper 进程内真跑）
// ---------------------------------------------------------------------------
test("进程内真跑：注入 fsAdapter / fetchImpl 后 media/health 为真；未注入仍为假并给出原因", async () => {
  const dir = tempDir("dxos-media-wiring-health-");
  const adapter = createDxosFsAdapterForUserData(dir);
  const fetchImpl = createGuardedFetch(globalThis.fetch);

  const wired = makeMediaCall(openBundle(dir, { fsAdapter: adapter, fetchImpl: fetchImpl }));
  const wiredHealth = await wired("media/health", {});
  assert.equal(wiredHealth.ok, true, JSON.stringify(wiredHealth));
  assert.equal(wiredHealth.value.dependencies.fsAdapter, true);
  assert.equal(wiredHealth.value.dependencies.fetchImpl, true);
  assert.equal(wiredHealth.value.dependencyNotes.fsAdapter, null);
  assert.equal(wiredHealth.value.dependencyNotes.fetchImpl, null);

  const bare = makeMediaCall(openBundle(dir, {}));
  const bareHealth = await bare("media/health", {});
  assert.equal(bareHealth.ok, true, JSON.stringify(bareHealth));
  assert.equal(bareHealth.value.dependencies.fsAdapter, false);
  assert.equal(bareHealth.value.dependencies.fetchImpl, false);
  assert.equal(typeof bareHealth.value.dependencyNotes.fsAdapter, "string");
  assert.match(bareHealth.value.dependencyNotes.fsAdapter, /fsAdapter/);
  assert.match(bareHealth.value.dependencyNotes.fetchImpl, /fetchImpl/);
});

test("进程内真跑：bundle.dependencies 与实际注入同源（注入项为真、未注入项为假并给原因）", () => {
  const dir = tempDir("dxos-media-wiring-deps-");
  const adapter = createDxosFsAdapterForUserData(dir);
  const providerStore = createMediaProviderStore({ providerAdapter: { firstUsable: () => null, all: () => [] } });
  const modelGateway = createMediaModelGateway({ providerProtocol: { service: { async call() { return { ok: true, text: "" }; } } } });
  const bundle = openBundle(dir, {
    fsAdapter: adapter,
    fetchImpl: createGuardedFetch(globalThis.fetch),
    providerStore: providerStore,
    modelGateway: modelGateway,
  });
  assert.equal(bundle.dependencies.fsAdapter, true);
  assert.equal(bundle.dependencies.fetchImpl, true);
  assert.equal(bundle.dependencies.providerStore, true);
  assert.equal(bundle.dependencies.modelGateway, true);
  assert.equal(bundle.dependencies.viteBuild, false);
  assert.equal(bundle.dependencies.illustratorAvailable, false, "未传探测结果时如实 false");
  assert.equal(bundle.dependencies.onnxRuntime, false);
  assert.equal(bundle.dependencies.modelPath, false);
  assert.equal(bundle.dependencyNotes.fsAdapter, null);
  assert.equal(bundle.dependencyNotes.modelGateway, null);
  assert.ok(typeof bundle.dependencyNotes.viteBuild === "string" && bundle.dependencyNotes.viteBuild.includes("Vite"));
  assert.match(bundle.dependencyNotes.onnxRuntime, /onnxruntime-node/);
});

test("装配件：providerStore / modelGateway 只走 B2 出口，缺失即 null（不伪造）", async () => {
  // providerStore：显式桥优先；providerProtocol 里缺 store/service → null。
  const provider = { id: "p1", name: "站点", base_url: "http://127.0.0.1/v1", protocol: "openai", enabled: true, models: [{ model: "m-image", caps: ["image"], protocol: "openai" }] };
  const fromAdapter = createMediaProviderStore({ providerAdapter: { firstUsable: (caps) => (caps === "image" ? provider : null), all: () => [provider] } });
  assert.equal(fromAdapter.firstUsableProvider("image").id, "p1");
  assert.equal(fromAdapter.firstUsableProvider("llm"), null);
  assert.equal(createMediaProviderStore({}), null);
  assert.equal(createMediaProviderStore({ providerProtocol: { store: {}, service: { call() {} } } }), null, "缺 listPublic 的 store 必须如实 null");

  // modelGateway：经 service.call / generateImage / legacyExecute 三个既有出口。
  const dir = tempDir("dxos-media-wiring-gateway-");
  const imageFile = path.join(dir, "gen.png");
  fs.writeFileSync(imageFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const editFile = path.join(dir, "edit.png");
  fs.writeFileSync(editFile, Buffer.from([1, 2, 3, 4]));
  const seen = [];
  const service = {
    async call(input) { seen.push(["call", input]); return { ok: true, text: '{"ok":true}' }; },
    async generateImage(input) { seen.push(["generateImage", input]); return { ok: true, images: [{ mediaPath: imageFile, mime: "image/png" }] }; },
    async legacyExecute(input) { seen.push(["legacyExecute", input]); return { ok: true, images: [{ fileName: "edit.png", mime: "image/png" }] }; },
  };
  const gateway = createMediaModelGateway({ providerProtocol: { service }, mediaDir: dir });
  const chat = await gateway.callChat({ id: "p1" }, "m-llm", { prompt: "你好" }, { temperature: 0.6 }, 5000);
  assert.equal(chat.text, '{"ok":true}');
  assert.equal(seen[0][1].providerId, "p1");
  assert.equal(seen[0][1].params.temperature, 0.6);
  const generated = await gateway.generateImages({ id: "p1" }, "m-image", { prompt: "猫", size: "1024x1536", n: 1 }, 5000);
  assert.equal(generated.images[0].type, "b64");
  assert.equal(Buffer.from(generated.images[0].value, "base64").toString("hex"), "89504e47");
  const edited = await gateway.editImages({ id: "p1" }, "m-image", { prompt: "改", size: "1024x1536", n: 1 }, [{ buf: Buffer.from("x"), mime: "image/png", name: "r.png" }], 5000);
  assert.equal(edited.images[0].type, "b64");
  assert.equal(edited.images[0].value, Buffer.from([1, 2, 3, 4]).toString("base64"));
  assert.equal(seen[2][0], "legacyExecute");
  assert.equal(seen[2][1].action, "editImages");
  assert.equal(createMediaModelGateway({}), null);

  // 出口失败：不返回假文本 / 假图。
  const broken = createMediaModelGateway({ providerProtocol: { service: { async call() { return { ok: false, error: "AUTH_FAILED" }; } } } });
  await assert.rejects(() => broken.callChat({ id: "p1" }, "m", { prompt: "x" }, {}, 1000), (error) => {
    assert.equal(error.code, "MEDIA_INTERNAL");
    assert.equal(error.detail && error.detail.dependency, "modelGateway");
    return true;
  });
});

test("出口护栏：媒体域 fetch 拒绝 api.dx-os.com，本地 / 自配端点放行", async () => {
  const seen = [];
  const guarded = createGuardedFetch(async (url) => { seen.push(url); return { ok: true, status: 200, text: async () => "{}" }; });
  assert.equal(typeof guarded, "function");
  assert.equal(createGuardedFetch(null), null);
  assert.throws(() => guarded("https://api.dx-os.com/v1/models"), (error) => error.code === "MEDIA_FORBIDDEN");
  assert.throws(() => guarded("https://sub.dx-os.com/x"), (error) => error.code === "MEDIA_FORBIDDEN");
  await guarded("http://127.0.0.1:9999/x");
  await guarded("https://example.com/x");
  assert.deepEqual(seen, ["http://127.0.0.1:9999/x", "https://example.com/x"]);
});

test("依赖探测：Illustrator 返回布尔；onnx 探测给出 runtime / modelPath / 原因，不加载即不谎报", () => {
  assert.equal(typeof probeIllustratorAvailability(), "boolean");

  const modelDir = tempDir("dxos-media-wiring-onnx-");
  const empty = probeOnnxAvailability({ modelDir: modelDir });
  assert.equal(typeof empty.available, "boolean");
  assert.equal(empty.modelPath, null);
  assert.equal(typeof empty.reason, "string");

  fs.writeFileSync(path.join(modelDir, "ben2-base-1.0.0.onnx"), Buffer.alloc(8));
  const found = probeOnnxAvailability({ modelDir: modelDir });
  assert.ok(found.modelPath && found.modelPath.endsWith(".onnx"));
  assert.equal(found.available, !!found.runtime && !!found.modelPath, "available 必须等于 runtime && modelPath（不谎报）");
});

// ---------------------------------------------------------------------------
// ③ 端到端：短剧分镜 → 生成分镜图 → 渲染提交（真实落盘）
// ---------------------------------------------------------------------------
test("端到端：media:command 短剧分镜→生成图→渲染提交，经注入 fsAdapter 真落 <userData>/dxos/fs", async () => {
  const dir = tempDir("dxos-media-wiring-drama-");
  const adapter = createDxosFsAdapterForUserData(dir);
  const providerStore = {
    firstUsableProvider(caps) {
      if (caps !== "image") return null;
      return { id: "p-img", name: "假图像站点", base_url: "http://127.0.0.1:9/v1", protocol: "openai", models: [{ model: "m-image", caps: ["image"], protocol: "openai" }] };
    },
  };
  const generated = [];
  const modelGateway = {
    async generateImages(provider, model, params) {
      generated.push({ provider, model, params });
      return { images: [{ type: "b64", value: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).toString("base64"), mime: "image/png" }] };
    },
  };
  const submitted = [];
  const renderSubmit = async (input) => { submitted.push(input); return { id: "job-b5f", status: "queued" }; };

  const call = makeMediaCall(openBundle(dir, {
    fsAdapter: adapter,
    providerStore: providerStore,
    modelGateway: modelGateway,
    mediaExtensions: { renderSubmit: renderSubmit },
  }));

  const created = await call("media/short-drama/create", { name: "B5f 短剧" });
  assert.equal(created.ok, true, JSON.stringify(created));
  const projectId = created.value.project.id;

  const added = await call("media/short-drama/shot/add", { projectId: projectId, shot: { title: "开场", prompt: "雨夜街道，人物撑伞", duration: 2 } });
  assert.equal(added.ok, true, JSON.stringify(added));
  const shotId = added.value.shot.id;

  const image = await call("media/short-drama/shot/image", { projectId: projectId, shotId: shotId });
  assert.equal(image.ok, true, JSON.stringify(image));
  assert.equal(generated.length, 1);
  assert.equal(generated[0].provider.id, "p-img");

  const render = await call("media/short-drama/render", { projectId: projectId });
  assert.equal(render.ok, true, JSON.stringify(render));
  assert.equal(submitted.length, 1);
  assert.equal(render.value.plan.shotCount, 1);
  assert.equal(render.value.job.id, "job-b5f");
  assert.equal(submitted[0].timeline.tracks[0].clips.length, 1);
  assert.ok(submitted[0].timeline.tracks[0].clips[0].assetId, "渲染计划必须带真实素材 id");

  // 真实落盘：fs.json + blobs 都在 <userData>/dxos/fs 下。
  const fsDir = path.join(dir, "dxos", "fs");
  assert.ok(fs.existsSync(path.join(fsDir, "fs.json")), "fs.json 必须真实落盘");
  assert.match(fs.readFileSync(path.join(fsDir, "fs.json"), "utf8"), /B5f 短剧/);
  const blobs = fs.readdirSync(path.join(fsDir, "blobs"));
  assert.ok(blobs.length >= 1, "分镜图 blob 必须真实落盘");
});

// ---------------------------------------------------------------------------
// ④ 端到端：音乐库扫描（真实落盘 <userData>/dxos/media）
// ---------------------------------------------------------------------------
test("端到端：media:command 音乐库扫描，标签缓存真落 <userData>/dxos/media", async () => {
  const dir = tempDir("dxos-media-wiring-library-");
  const musicRoot = path.join(dir, "music");
  fs.mkdirSync(path.join(musicRoot, "专辑"), { recursive: true });
  fs.writeFileSync(path.join(musicRoot, "song-b.mp3"), Buffer.alloc(64));
  fs.writeFileSync(path.join(musicRoot, "专辑", "song-a.flac"), Buffer.alloc(128));
  fs.writeFileSync(path.join(musicRoot, "note.txt"), "not audio");

  const call = makeMediaCall(openBundle(dir, { fetchImpl: createGuardedFetch(globalThis.fetch) }));
  const scanned = await call("media/library/scan", { dirs: [musicRoot] });
  assert.equal(scanned.ok, true, JSON.stringify(scanned));
  assert.equal(scanned.value.tracks.length, 2, "只识别音频扩展名");
  assert.equal(JSON.stringify(scanned.value.tracks).includes(musicRoot), false, "条目不得包含绝对路径");

  const mediaDir = path.join(dir, "dxos", "media");
  assert.ok(fs.existsSync(path.join(mediaDir, "library-tags.json")), "标签缓存必须真实落盘");
  assert.ok(fs.existsSync(path.join(mediaDir, "library-lyrics.json")), "歌词缓存必须真实落盘");
});

// ---------------------------------------------------------------------------
// ⑤ 抠图：缺 onnxruntime 时如实不可用；注入假 session 后成功
// ---------------------------------------------------------------------------
function makeFakeSharp() {
  let ctor;
  const builder = {
    rotate: () => builder,
    removeAlpha: () => builder,
    resize: () => builder,
    raw: () => builder,
    png: () => builder,
    toBuffer: async (out) => {
      if (out && out.resolveWithObject) {
        if (ctor && ctor.raw && ctor.raw.channels === 1) return { data: new Uint8Array(4), info: { width: 2, height: 2, channels: 1 } };
        return { data: Buffer.alloc(2 * 2 * 3), info: { width: 2, height: 2 } };
      }
      if (ctor && ctor.raw && ctor.raw.channels === 4) return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      return Buffer.alloc(2 * 2 * 3);
    },
  };
  const fn = (input, options) => { ctor = options; return builder; };
  fn.kernel = { lanczos3: "lanczos3" };
  return fn;
}

test("抠图：本机缺 onnxruntime 时结构化不可用（如实），注入假 session 后成功", async () => {
  const dir = tempDir("dxos-media-wiring-bg-");
  const probe = probeOnnxAvailability({ modelDir: path.join(dir, "dxos", "media", "background-removal") });
  const model = { id: "ben2-base", name: "BEN2 Base", version: "1.0.0", filename: "ben2-base-1.0.0.onnx", size: 0, inputWidth: 2, inputHeight: 2, normalize: "zero-one", sigmoid: false };

  if (!probe.available) {
    const bare = makeMediaCall(openBundle(dir, { modelDir: probe.modelDir, modelPath: probe.modelPath, onnxRuntime: probe.runtime }));
    const status = await bare("media/background-removal/status", {});
    assert.equal(status.ok, false);
    assert.equal(status.error, "MEDIA_DEPENDENCY_UNAVAILABLE");
    const removed = await bare("media/background-removal/remove", { modelId: "ben2-base", base64: Buffer.from([1, 2, 3, 4]).toString("base64") });
    assert.equal(removed.ok, false);
    assert.equal(removed.error, "MEDIA_DEPENDENCY_UNAVAILABLE", "缺依赖绝不返回假图");
  } else {
    assert.ok(probe.runtime, "available 时必须有 runtime");
  }

  // 注入假 sharp / runtime / session：真实推理路径产出 PNG。
  const runtime = { Tensor: function Tensor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } };
  const session = { inputNames: ["input"], outputNames: ["output"], run: async () => ({ output: { data: new Float32Array([0, 0, 1, 1]) } }) };
  const wired = makeMediaCall(openBundle(dir, {
    mediaExtensions: {
      models: [model],
      modelPath: "/injected/model.onnx",
      onnxRuntime: runtime,
      onnxSessionFactory: async () => session,
      sharpLoader: () => makeFakeSharp(),
    },
  }));
  const status = await wired("media/background-removal/status", {});
  assert.equal(status.ok, true, JSON.stringify(status));
  const removed = await wired("media/background-removal/remove", { modelId: "ben2-base", base64: Buffer.from([0xff, 0xd8, 0xff]).toString("base64") });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(Buffer.from(removed.value.image, "base64url").subarray(0, 4).toString("hex"), "89504e47");
});

// ---------------------------------------------------------------------------
// ⑥ 依赖缺失不降低为假成功
// ---------------------------------------------------------------------------
test("依赖缺失：未注入 fsAdapter / fetchImpl / modelGateway / viteBuild 时仍结构化 MEDIA_DEPENDENCY_UNAVAILABLE", async () => {
  const dir = tempDir("dxos-media-wiring-missing-");

  // 无 fsAdapter：短剧项目列表读不了画布文件系统。
  const noFs = makeMediaCall(openBundle(dir, {}));
  const list = await noFs("media/short-drama/list", {});
  assert.equal(list.ok, false);
  assert.equal(list.error, "MEDIA_DEPENDENCY_UNAVAILABLE");
  assert.match(String(list.detail || ""), /fsAdapter/);

  // 无 fetchImpl：Figma 清单拉取不可用。
  const noFetch = await noFs("media/figma-preview/files", { sourceUrl: "https://example.com/preview.json" });
  assert.equal(noFetch.ok, false);
  assert.equal(noFetch.error, "MEDIA_DEPENDENCY_UNAVAILABLE");
  assert.match(String(noFetch.detail || ""), /fetchImpl/);

  // 无 viteBuild：即使 fetch 有文件也不假构建。
  const noVite = await noFs("media/figma-preview/build", { projectId: "proj-12345678" });
  assert.equal(noVite.ok, false);
  assert.equal(noVite.error, "MEDIA_DEPENDENCY_UNAVAILABLE");
  assert.match(String(noVite.detail || ""), /viteBuild/);

  // 有 providerStore 但无 modelGateway：短剧生图不得假成功。
  const noGateway = makeMediaCall(openBundle(dir, {
    fsAdapter: createDxosFsAdapterForUserData(dir),
    providerStore: {
      firstUsableProvider: () => ({ id: "p1", name: "站点", base_url: "http://127.0.0.1/v1", protocol: "openai", models: [{ model: "m", caps: ["image"], protocol: "openai" }] }),
    },
  }));
  const created = await noGateway("media/short-drama/create", { name: "缺网关" });
  assert.equal(created.ok, true, JSON.stringify(created));
  const added = await noGateway("media/short-drama/shot/add", { projectId: created.value.project.id, shot: { title: "x", prompt: "y", duration: 1 } });
  const image = await noGateway("media/short-drama/shot/image", { projectId: created.value.project.id, shotId: added.value.shot.id });
  assert.equal(image.ok, false);
  assert.equal(image.error, "MEDIA_DEPENDENCY_UNAVAILABLE");
  assert.match(String(image.detail || ""), /modelGateway/);

  // 无 onnx：抠图结构化不可用（上面已覆盖）；此处确认 status 的 message 是依赖语义而非成功。
  const bg = await noFs("media/background-removal/status", {});
  assert.equal(bg.ok, false);
  assert.equal(bg.error, mediaDomain.MEDIA_ERR_DEPENDENCY_UNAVAILABLE);
});
