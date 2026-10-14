/**
 * B4a2 · 技能执行器回归测试（全离线）。
 *
 * 覆盖本轮验收条目：
 *   ① 每个内置技能至少一条用例（chat / writing / rewrite / code / analysis / generate_image /
 *      midjourney / upscale_image / generate_video / edit_image / batch_image_group_process /
 *      describe_image / text_to_speech / transcribe_audio / generate_music）
 *   ② 请求参数断言（modelAdapter / mediaAdapter / cliRuntime 收到的 provider/model/params）
 *   ③ 产物落盘调用断言（fsAdapter.createNode / saveBlob / ensureFolder / resolvePath）
 *   ④ 失败与取消路径（模型 ok:false、媒体空产物、signal 已中止）
 *   ⑤ 未注入依赖时的结构化 AGENT_DEPENDENCY_UNAVAILABLE（mediaAdapter / fsAdapter / providerAdapter /
 *      modelAdapter / cliRuntime / artworkAdapter），不返回假图片 / 假路径
 *   ⑥ procedure 多技能编排全链路（writing + generate_image + finish），含 read_skill_resource
 *   ⑦ 纯函数（buildGroups / combinations / runPool / mediaExt / parseDataMedia / normalizeVideoRefs）
 *
 * 全部用例使用 os.tmpdir 临时目录 + 纯内存假适配器，不触网、不执行 DX OS、不依赖 Electron。
 * 只读源：server/skills.ts:705-2298、shared/agentProtocolParams.ts。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const runner = require("../electron/skill-runner.cjs");
const store = require("../electron/skill-store.cjs");

const {
  AGENT_DEPENDENCY_UNAVAILABLE,
  configureSkillRunner,
  resetSkillRunnerForTests,
  isJimengCliProvider,
  resolveImageTarget,
  resolveVideoTarget,
  resolveAudioTarget,
  mediaExt,
  parseDataMedia,
  normalizeVideoRefs,
  buildGroups,
  combinations,
  runPool,
  protocolParamsFromAgentArgs,
  procedureTools,
  runSkill,
  runGenerateImage,
  runGenerateVideo,
  generateMusicArtwork,
  generateArtistsArtwork,
} = runner;

const { SKILLS, configureSkillStore, resetSkillStoreForTests, saveCustomSkill } = store;

const tmpDirs = [];

afterEach(() => {
  resetSkillRunnerForTests();
  resetSkillStoreForTests();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

// ── 假适配器 ────────────────────────────────────────────────────────────────
function makeProviderAdapter() {
  const providers = [
    {
      id: "p_llm", name: "文本站点", base_url: "http://127.0.0.1:1/v1", api_key: "k",
      protocol: "openai", source: "api", enabled: true, sort: 1, created_ts: 1,
      models: [
        { model: "m-llm", caps: ["llm"], protocol: "openai" },
        { model: "m-vision", caps: ["llm", "llm.chat.vision"], protocol: "openai" },
      ],
    },
    {
      id: "p_media", name: "媒体站点", base_url: "http://127.0.0.1:2/v1", api_key: "k",
      protocol: "openai", source: "api", enabled: true, sort: 2, created_ts: 2,
      models: [
        { model: "m-img", caps: ["image"], protocol: "openai" },
        { model: "m-vid", caps: ["video"], protocol: "openai" },
        { model: "m-aud", caps: ["audio"], protocol: "openai" },
      ],
    },
    {
      id: "p_jimeng", name: "即梦CLI", protocol: "cli:jimeng", source: "cli", cli_tool: "jimeng",
      enabled: true, sort: 3, created_ts: 3,
      models: [
        { model: "jimeng-5.0Pro", caps: ["image", "image.upscale"], protocol: "cli:jimeng" },
        { model: "seedance2.0fast", caps: ["video"], protocol: "cli:jimeng" },
      ],
    },
    {
      id: "p_mj", name: "MJ站点", base_url: "http://127.0.0.1:3/v1", api_key: "k",
      protocol: "midjourney", source: "api", enabled: true, sort: 4, created_ts: 4,
      models: [{ model: "mj-6.1", caps: ["image"], protocol: "midjourney" }],
    },
  ];
  return {
    providers,
    firstUsable: (kind) => providers.find((p) => p.enabled && (p.models || []).some((m) => (m.caps || []).includes(kind))) || null,
    all: () => providers.slice(),
    autoFallback: () => true,
    revealProvider: (id) => providers.find((p) => p.id === id) || null,
  };
}

function makeModel(options) {
  const opts = options || {};
  const calls = [];
  let procedureRound = 0;
  return {
    calls,
    async call(req) {
      calls.push(req);
      if (req.tools && req.tools.length) {
        if (opts.procedureScript) {
          const script = opts.procedureScript;
          const round = script[procedureRound] || script[script.length - 1] || [];
          procedureRound++;
          return { ok: true, text: "", toolCalls: round };
        }
        return { ok: true, text: "", toolCalls: [] };
      }
      if (opts.failText) return { ok: false, error: opts.failText };
      return { ok: true, text: opts.text || ("TEXT:" + req.model) };
    },
  };
}

function makeMedia(options) {
  const opts = options || {};
  const calls = {
    generateImages: [], generateVideos: [], editImages: [], describeImage: [],
    submitMidjourney: [], getMidjourneyTask: [], submitMidjourneyAction: [], submitMidjourneyModal: [],
    generateSpeech: [], transcribeAudio: [], generateMusic: [], validateProtocolParameters: [],
  };
  const b64 = Buffer.from("IMG_BYTES").toString("base64");
  const imageList = () => opts.images || [{ type: "b64", value: b64 }];
  const media = {
    calls,
    async generateImages(provider, model, args) {
      calls.generateImages.push({ provider, model, args });
      if (opts.failGenerateImages) throw new Error("媒体生成失败");
      return { images: opts.emptyImages ? [] : imageList() };
    },
    async generateVideos(provider, model, args, signal, timeoutMs) {
      calls.generateVideos.push({ provider, model, args, timeoutMs });
      if (opts.emptyVideos) return { videos: [] };
      return { videos: opts.videos || [{ type: "url", value: "https://cdn.example/v.mp4" }] };
    },
    async editImages(provider, model, args, inputs) {
      calls.editImages.push({ provider, model, args, inputs });
      if (opts.failEditImages) throw new Error("组编辑失败");
      return { images: imageList() };
    },
    async describeImage(provider, model, dataUrl, prompt) {
      calls.describeImage.push({ provider, model, dataUrl, prompt });
      return opts.describeText === undefined ? "画面描述" : opts.describeText;
    },
    async submitMidjourney(provider, model, payload, timeoutMs) {
      calls.submitMidjourney.push({ provider, model, payload, timeoutMs });
      return { taskId: "mj1", status: "queued" };
    },
    async getMidjourneyTask(provider, taskId, timeoutMs) {
      calls.getMidjourneyTask.push({ provider, taskId, timeoutMs });
      if (opts.mjPending) return { status: "running", images: [] };
      return { status: "succeeded", images: imageList() };
    },
    async submitMidjourneyAction(provider, payload, timeoutMs) {
      calls.submitMidjourneyAction.push({ provider, payload, timeoutMs });
      return { taskId: "mj1", status: "running" };
    },
    async submitMidjourneyModal(provider, payload, timeoutMs) {
      calls.submitMidjourneyModal.push({ provider, payload, timeoutMs });
      return { taskId: "mj1", status: "running" };
    },
    async generateSpeech(provider, model, params) {
      calls.generateSpeech.push({ provider, model, params });
      return { data: Buffer.from("AUDIO"), mime: "audio/mpeg" };
    },
    async transcribeAudio(provider, model, input, params) {
      calls.transcribeAudio.push({ provider, model, input, params });
      return { text: "转写文本" };
    },
    async generateMusic(provider, model, params) {
      calls.generateMusic.push({ provider, model, params });
      return { audios: [{ value: "https://cdn.example/m.mp3" }] };
    },
    async validateProtocolParameters(protocol, model, intent, params, counts) {
      calls.validateProtocolParameters.push({ protocol, model, intent, params, counts });
    },
  };
  if (opts.declarativeImage) {
    media.runDeclarativeImageSkill = async () => ({ images: imageList(), taskId: "dt1", executor: "declarative" });
  }
  return media;
}

function makeCli(options) {
  const opts = options || {};
  const calls = { generateJimengImage: [], generateJimengVideo: [], upscaleJimengImage: [], queryJimengMedia: [], tempMediaFile: [] };
  class JimengPendingError extends Error {
    constructor(submitId) {
      super("即梦排队中");
      this.name = "JimengPendingError";
      this.submit_id = submitId;
    }
  }
  return {
    calls,
    JimengPendingError,
    tempMediaFile(buf, mime, ext) {
      calls.tempMediaFile.push({ mime, ext });
      return "/tmp/media" + ext;
    },
    async generateJimengImage(prompt, model, size, imagePaths) {
      calls.generateJimengImage.push({ prompt, model, size, imagePaths: imagePaths || [] });
      if (opts.pendingImage) throw new JimengPendingError("j-pending");
      return { images: ["https://cdn.example/j.png"], submit_id: "j1" };
    },
    async upscaleJimengImage(imagePath, resolution, submit) {
      calls.upscaleJimengImage.push({ imagePath, resolution, submit });
      return { images: ["https://cdn.example/up.png"], submit_id: "u1" };
    },
    async generateJimengVideo(prompt, model, o) {
      calls.generateJimengVideo.push({ prompt, model, o });
      return { videos: ["https://cdn.example/j.mp4"], submit_id: "v1" };
    },
    async queryJimengMedia(submitId, kind) {
      calls.queryJimengMedia.push({ submitId, kind });
      if (opts.queryPending) return { status: "running", message: "排队中" };
      if (opts.queryFailed) return { status: "failed", error: "失败原因" };
      return { status: "succeeded", urls: ["https://cdn.example/q.png"] };
    },
  };
}

function makeFs() {
  const nodes = new Map();
  const blobs = new Map();
  const calls = { ensureFolder: [], resolvePath: [], createNode: [], saveBlob: [] };
  let seq = 0;
  let seedSeq = 0;
  function ensureFolder(name, rootId) {
    const id = "folder_" + name;
    calls.ensureFolder.push({ name, rootId });
    if (!nodes.has(id)) nodes.set(id, { id, name, type: "folder", parentId: rootId === undefined ? null : rootId });
    return id;
  }
  function resolvePath(rootId, p, create) {
    calls.resolvePath.push({ rootId, path: p, create });
    const idx = p.lastIndexOf("/");
    const leaf = idx >= 0 ? p.slice(idx + 1) : p;
    const dir = idx >= 0 ? p.slice(0, idx) : "root";
    return { parentId: ensureFolder(dir, rootId), leaf };
  }
  function createNode(input) {
    const id = "node_" + (++seq);
    const node = Object.assign({ id }, input);
    nodes.set(id, node);
    calls.createNode.push(node);
    return node;
  }
  function saveBlob(id, buf) {
    blobs.set(id, Buffer.from(buf));
    calls.saveBlob.push(id);
  }
  function readBlob(id) {
    return blobs.has(id) ? blobs.get(id) : null;
  }
  function getNode(id) {
    return nodes.get(id) || null;
  }
  function findByPath(rootId, p) {
    const leaf = p.split("/").pop();
    for (const n of nodes.values()) if (n.type === "file" && (n.name === p || n.name === leaf)) return n;
    return null;
  }
  function seedFile(name, mime, content, explicitId) {
    const nodeId = explicitId || (String(++seedSeq).padStart(8, "0") + "-1111-1111-1111-111111111111");
    nodes.set(nodeId, { id: nodeId, name, type: "file", mime, parentId: null, size: content.length });
    blobs.set(nodeId, Buffer.from(content));
    return nodeId;
  }
  return { nodes, blobs, calls, ensureFolder, resolvePath, createNode, saveBlob, readBlob, getNode, findByPath, seedFile };
}

function makeArtwork(options) {
  const opts = options || {};
  const calls = { artworkTargets: 0, putArtwork: [], scan: 0 };
  return {
    calls,
    async artworkTargets() {
      calls.artworkTargets++;
      return {
        artists: opts.artists || ["歌手A"],
        albums: opts.albums || [{ artist: "歌手A", album: "专辑A", key: "k1" }],
      };
    },
    putArtwork(kind, name, buf) {
      calls.putArtwork.push({ kind, name, bytes: buf.length });
    },
    async scan() {
      calls.scan++;
    },
  };
}

function makeFetch() {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      headers: { get: () => "image/png" },
      arrayBuffer: async () => {
        const b = Buffer.from("REMOTE_BYTES");
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
    };
  };
  impl.calls = calls;
  return impl;
}

function setup(over) {
  const o = over || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-skill-runner-"));
  tmpDirs.push(dir);
  const providerAdapter = o.providerAdapter === undefined ? makeProviderAdapter() : o.providerAdapter;
  configureSkillStore({ dataDir: dir, providerAdapter: providerAdapter });
  const fsAdapter = o.fsAdapter === undefined ? makeFs() : o.fsAdapter;
  const mediaAdapter = o.mediaAdapter === undefined ? makeMedia(o.media) : o.mediaAdapter;
  const modelAdapter = o.modelAdapter === undefined ? makeModel(o.model) : o.modelAdapter;
  const cliRuntime = o.cliRuntime === undefined ? makeCli(o.cli) : o.cliRuntime;
  const fetchImpl = o.fetchImpl === undefined ? makeFetch() : o.fetchImpl;
  const artworkAdapter = o.artworkAdapter === undefined ? makeArtwork(o.artwork) : o.artworkAdapter;
  configureSkillRunner({
    skillStore: store,
    providerAdapter: providerAdapter,
    modelAdapter: modelAdapter,
    cliRuntime: cliRuntime,
    mediaAdapter: mediaAdapter,
    fsAdapter: fsAdapter,
    artworkAdapter: artworkAdapter,
    clock: () => 1000,
    fetchImpl: fetchImpl,
  });
  return { dir, providerAdapter, fsAdapter, mediaAdapter, modelAdapter, cliRuntime, fetchImpl, artworkAdapter };
}

// ── ① 文本类五个内置技能（逐个用例）────────────────────────────────────────
for (const skillId of ["chat", "writing", "rewrite", "code", "analysis"]) {
  test("内置技能 " + skillId + "：走 modelAdapter.call，instruction 与 systemPrompt 与源一致", async () => {
    const env = setup();
    const builtin = SKILLS.find((s) => s.id === skillId);
    const res = await runSkill(skillId, { instruction: skillId + "-指令" }, {});
    assert.equal(res.text, "TEXT:m-llm");
    assert.equal(res.meta.provider, "文本站点");
    assert.equal(res.meta.model, "m-llm");
    assert.equal(typeof res.meta.latencyMs, "number");
    assert.equal(env.modelAdapter.calls.length, 1);
    const req = env.modelAdapter.calls[0];
    assert.equal(req.providerId, "p_llm");
    assert.equal(req.model, "m-llm");
    assert.equal(req.stream, false);
    assert.deepEqual(req.messages, [{ role: "user", content: skillId + "-指令" }]);
    assert.deepEqual(req.params, { system: builtin.systemPrompt });
  });
}

// ── generate_image ─────────────────────────────────────────────────────────
test("generate_image（非 CLI）：mediaAdapter.generateImages 请求参数 + b64 落盘为 SkillImage", async () => {
  const env = setup();
  const res = await runSkill("generate_image", { prompt: "一只猫", size: "1792x1024", n: 2 }, {});
  assert.equal(env.mediaAdapter.calls.generateImages.length, 1);
  const call = env.mediaAdapter.calls.generateImages[0];
  assert.equal(call.provider.id, "p_media");
  assert.equal(call.model, "m-img");
  assert.deepEqual(call.args, { prompt: "一只猫", size: "1792x1024", n: 2 });
  assert.equal(res.images.length, 1);
  assert.match(res.images[0].url, /^\/api\/fs\/raw\//);
  assert.equal(env.fsAdapter.calls.ensureFolder[0].name, "生成图片");
  assert.equal(env.fsAdapter.calls.createNode[0].mime, "image/png");
  assert.equal(env.fsAdapter.calls.saveBlob.length, 1);
  assert.match(res.text, /已生成 1 张图片/);
  assert.equal(res.meta.executor, "legacy");
});

test("generate_image：给出 path 时按 resolvePath 落盘并用指定文件名", async () => {
  const env = setup({
    media: { images: [{ type: "b64", value: Buffer.from("X").toString("base64") }, { type: "b64", value: Buffer.from("Y").toString("base64") }] },
  });
  const res = await runSkill("generate_image", { prompt: "图", path: "角色/苏离.png" }, {});
  assert.equal(env.fsAdapter.calls.resolvePath[0].path, "角色/苏离.png");
  assert.equal(env.fsAdapter.calls.resolvePath[0].create, true);
  assert.deepEqual(env.fsAdapter.calls.createNode.map((n) => n.name), ["苏离-1.png", "苏离-2.png"]);
  assert.equal(res.images.length, 2);
  assert.match(res.text, /已按路径「角色\/苏离.png」保存/);
});

test("generate_image：即梦 CLI provider 走 cliRuntime.generateJimengImage", async () => {
  const env = setup();
  const res = await runSkill("generate_image", { prompt: "画", size: "1024x1024", n: 1 }, { imageProviderId: "p_jimeng", imageModel: "jimeng-5.0Pro" });
  assert.equal(env.mediaAdapter.calls.generateImages.length, 0);
  assert.equal(env.cliRuntime.calls.generateJimengImage.length, 1);
  assert.deepEqual(env.cliRuntime.calls.generateJimengImage[0], { prompt: "画", model: "jimeng-5.0Pro", size: "1024x1024", imagePaths: [] });
  assert.equal(env.fetchImpl.calls[0], "https://cdn.example/j.png");
  assert.equal(res.images.length, 1);
});

test("generate_image：注入声明式路由时优先于 legacy 媒体调用", async () => {
  const env = setup({ media: { declarativeImage: true } });
  const res = await runSkill("generate_image", { prompt: "x" }, {});
  assert.equal(env.mediaAdapter.calls.generateImages.length, 0);
  assert.equal(res.meta.executor, "declarative");
  assert.equal(res.meta.taskId, "dt1");
});

test("generate_image：接口返回空图片时报错（不伪造产物）", async () => {
  setup({ media: { emptyImages: true } });
  await assert.rejects(() => runSkill("generate_image", { prompt: "x" }, {}), /未返回任何图片/);
});

test("generate_image：缺少 prompt / 未知技能 / 已停用技能均明确报错", async () => {
  setup();
  await assert.rejects(() => runSkill("generate_image", {}, {}), /缺少 prompt/);
  await assert.rejects(() => runSkill("no_such_skill", {}, {}), /未知技能/);
});

// ── midjourney ─────────────────────────────────────────────────────────────
test("midjourney：imagine 提交后等待完成并保存图片", async () => {
  const env = setup();
  const res = await runSkill("midjourney", { operation: "imagine", prompt: "赛博朋克", size: "16:9" }, {});
  assert.equal(env.mediaAdapter.calls.submitMidjourney.length, 1);
  const sub = env.mediaAdapter.calls.submitMidjourney[0];
  assert.equal(sub.provider.protocol, "midjourney");
  assert.equal(sub.model, "mj-6.1");
  assert.equal(sub.payload.prompt, "赛博朋克");
  assert.equal(sub.payload.size, "16:9");
  assert.equal(sub.payload.mode, "imagine");
  assert.equal(env.mediaAdapter.calls.getMidjourneyTask.length, 1);
  assert.equal(res.images.length, 1);
  assert.match(res.text, /Midjourney 任务已完成/);
  assert.equal(res.meta.taskId, "mj1");
});

test("midjourney：wait=false 只提交并返回 task_id", async () => {
  const env = setup();
  const res = await runSkill("midjourney", { operation: "imagine", prompt: "x", wait: false }, {});
  assert.equal(env.mediaAdapter.calls.getMidjourneyTask.length, 0);
  assert.equal(res.meta.taskId, "mj1");
  assert.equal(res.meta.status, "queued");
  assert.equal(res.images, undefined);
});

test("midjourney：status 查询仍在运行", async () => {
  const env = setup({ media: { mjPending: true } });
  const res = await runSkill("midjourney", { operation: "status", task_id: "mj1" }, {});
  assert.equal(env.mediaAdapter.calls.submitMidjourney.length, 0);
  assert.equal(res.meta.status, "running");
  assert.match(res.text, /仍在运行/);
});

test("midjourney：不支持的 operation 明确报错", async () => {
  setup();
  await assert.rejects(() => runSkill("midjourney", { operation: "nope" }, {}), /不支持 Midjourney operation/);
});

// ── upscale_image ──────────────────────────────────────────────────────────
test("upscale_image：即梦 CLI 放大并落盘（tempMediaFile + 4k）", async () => {
  const env = setup();
  const id = env.fsAdapter.seedFile("src.png", "image/png", Buffer.from("SRC"));
  const res = await runSkill("upscale_image", { image: id, resolution: "4k" }, { imageProviderId: "p_jimeng", imageModel: "jimeng-5.0Pro" });
  assert.equal(env.cliRuntime.calls.tempMediaFile.length, 1);
  assert.equal(env.cliRuntime.calls.upscaleJimengImage.length, 1);
  assert.equal(env.cliRuntime.calls.upscaleJimengImage[0].resolution, "4k");
  assert.equal(env.cliRuntime.calls.upscaleJimengImage[0].submit.deferPending, true);
  assert.equal(res.images.length, 1);
  assert.match(res.text, /已放大到 4K/);
});

test("upscale_image：status 查询排队中", async () => {
  const env = setup({ cli: { queryPending: true } });
  const res = await runSkill("upscale_image", { operation: "status", submit_id: "s1" }, { imageProviderId: "p_jimeng", imageModel: "jimeng-5.0Pro" });
  assert.equal(env.cliRuntime.calls.queryJimengMedia[0].kind, "image");
  assert.equal(res.meta.status, "running");
  assert.match(res.text, /排队/);
});

test("upscale_image：非即梦 provider 明确拒绝", async () => {
  const pa = makeProviderAdapter();
  pa.providers.push({
    id: "p_ups", name: "超分站", base_url: "http://127.0.0.1:4/v1", api_key: "k", protocol: "openai",
    source: "api", enabled: true, sort: 5, created_ts: 5,
    models: [{ model: "m-ups", caps: ["image", "image.upscale"], protocol: "openai" }],
  });
  setup({ providerAdapter: pa });
  await assert.rejects(() => runSkill("upscale_image", { image: "x" }, { imageProviderId: "p_ups" }), /仅支持即梦 CLI/);
});

// ── generate_video ─────────────────────────────────────────────────────────
test("generate_video（非 CLI）：mediaAdapter.generateVideos 参数、校验与落盘", async () => {
  const env = setup();
  const res = await runSkill("generate_video", { prompt: "海浪", duration: 8, aspect_ratio: "9:16" }, {});
  assert.equal(env.mediaAdapter.calls.generateVideos.length, 1);
  const call = env.mediaAdapter.calls.generateVideos[0];
  assert.equal(call.provider.id, "p_media");
  assert.equal(call.model, "m-vid");
  assert.equal(call.args.prompt, "海浪");
  assert.equal(call.args.duration, 8);
  assert.equal(call.args.aspect_ratio, "9:16");
  assert.equal(call.timeoutMs, 900000);
  assert.equal(env.mediaAdapter.calls.validateProtocolParameters.length, 1);
  assert.equal(res.videos.length, 1);
  assert.equal(res.meta.capability, "video.text_to_video");
  assert.equal(env.fsAdapter.calls.ensureFolder[0].name, "生成视频");
  assert.match(res.text, /已生成 1 个视频/);
});

test("generate_video：即梦 CLI 用 tempMediaFile 传参考图（image_to_video）", async () => {
  const env = setup();
  const imgId = env.fsAdapter.seedFile("ref.png", "image/png", Buffer.from("IMG"));
  const res = await runSkill("generate_video", { prompt: "动起来", image: imgId }, { providerId: "p_jimeng", model: "seedance2.0fast" });
  assert.equal(env.mediaAdapter.calls.generateVideos.length, 0);
  assert.equal(env.cliRuntime.calls.tempMediaFile.length, 1);
  const call = env.cliRuntime.calls.generateJimengVideo[0];
  assert.equal(call.model, "seedance2.0fast");
  assert.deepEqual(call.o.imagePaths, ["/tmp/media.png"]);
  assert.equal(res.meta.capability, "video.image_to_video");
  assert.equal(res.meta.imageRefs, 1);
});

test("generate_video：不支持的 mode 明确报错", async () => {
  setup();
  await assert.rejects(() => runSkill("generate_video", { prompt: "x", mode: "hoverboard" }, {}), /不支持的视频 mode/);
});

// ── edit_image ─────────────────────────────────────────────────────────────
test("edit_image：解析参考图并走 mediaAdapter.editImages，产物落盘", async () => {
  const env = setup();
  const imgId = env.fsAdapter.seedFile("a.png", "image/png", Buffer.from("A"));
  const res = await runSkill("edit_image", { image: [imgId], prompt: "换背景" }, {});
  assert.equal(env.mediaAdapter.calls.editImages.length, 1);
  const call = env.mediaAdapter.calls.editImages[0];
  assert.equal(call.args.prompt, "换背景");
  assert.equal(call.inputs.length, 1);
  assert.equal(call.inputs[0].mime, "image/png");
  assert.equal(res.images.length, 1);
  assert.equal(res.meta.refs, 1);
});

test("edit_image：即梦 CLI provider 走 generateJimengImage(imagePaths)", async () => {
  const env = setup();
  const imgId = env.fsAdapter.seedFile("a.png", "image/png", Buffer.from("A"));
  const res = await runSkill("edit_image", { image: [imgId], prompt: "改" }, { imageProviderId: "p_jimeng", imageModel: "jimeng-5.0Pro" });
  assert.equal(env.mediaAdapter.calls.editImages.length, 0);
  assert.equal(env.cliRuntime.calls.generateJimengImage[0].imagePaths.length, 1);
  assert.equal(res.images.length, 1);
});

// ── batch_image_group_process ──────────────────────────────────────────────
test("batch_image_group_process：all_each 每组独立编辑并汇总", async () => {
  const env = setup();
  const ids = [
    env.fsAdapter.seedFile("a.png", "image/png", Buffer.from("A")),
    env.fsAdapter.seedFile("b.png", "image/png", Buffer.from("B")),
    env.fsAdapter.seedFile("c.png", "image/png", Buffer.from("C")),
  ];
  const res = await runSkill("batch_image_group_process", { image: ids, prompt: "精修", groupMode: "all_each", concurrency: 2, retryCount: 0 }, {});
  assert.equal(env.mediaAdapter.calls.editImages.length, 3);
  assert.equal(res.meta.ok, 3);
  assert.equal(res.meta.fail, 0);
  assert.equal(res.images.length, 3);
  assert.match(res.text, /成功 3/);
});

test("batch_image_group_process：failurePolicy=continue 汇总失败组", async () => {
  const env = setup({ media: { failEditImages: true } });
  const ids = [
    env.fsAdapter.seedFile("a.png", "image/png", Buffer.from("A")),
    env.fsAdapter.seedFile("b.png", "image/png", Buffer.from("B")),
  ];
  const res = await runSkill("batch_image_group_process", { image: ids, prompt: "精修", groupMode: "all_each", concurrency: 1, retryCount: 0 }, {});
  assert.equal(res.meta.ok, 0);
  assert.equal(res.meta.fail, 2);
  assert.match(res.text, /失败组/);
});

// ── describe_image ─────────────────────────────────────────────────────────
test("describe_image：resolveVisionTarget + mediaAdapter.describeImage（dataUrl 传参）", async () => {
  const env = setup();
  const imgId = env.fsAdapter.seedFile("p.png", "image/png", Buffer.from("PIX"));
  const res = await runSkill("describe_image", { image: imgId, prompt: "画了什么" }, {});
  assert.equal(env.mediaAdapter.calls.describeImage.length, 1);
  const call = env.mediaAdapter.calls.describeImage[0];
  assert.equal(call.provider.id, "p_llm");
  assert.equal(call.model, "m-vision");
  assert.match(call.dataUrl, /^data:image\/png;base64,/);
  assert.equal(call.prompt, "画了什么");
  assert.equal(res.text, "画面描述");
  assert.equal(res.meta.provider, "文本站点");
});

// ── text_to_speech ─────────────────────────────────────────────────────────
test("text_to_speech：generateSpeech 参数 + 音频落盘", async () => {
  const env = setup();
  const res = await runSkill("text_to_speech", { text: "你好", voice: "nova", speed: 1.5, format: "wav" }, {});
  assert.equal(env.mediaAdapter.calls.generateSpeech.length, 1);
  const call = env.mediaAdapter.calls.generateSpeech[0];
  assert.equal(call.provider.base_url, "http://127.0.0.1:2/v1");
  assert.equal(call.model, "m-aud");
  assert.equal(call.params.input, "你好");
  assert.equal(call.params.voice, "nova");
  assert.equal(call.params.speed, 1.5);
  assert.equal(call.params.response_format, "wav");
  assert.equal(res.audios.length, 1);
  assert.equal(env.fsAdapter.calls.ensureFolder[0].name, "生成音频");
  assert.match(res.audios[0].name, /^audio_1000_1\./);
});

// ── transcribe_audio ───────────────────────────────────────────────────────
test("transcribe_audio：translate 传递 + 文本结果", async () => {
  const env = setup();
  const audioId = env.fsAdapter.seedFile("v.mp3", "audio/mpeg", Buffer.from("AUD"));
  const res = await runSkill("transcribe_audio", { audio: audioId, operation: "translate", language: "zh" }, {});
  assert.equal(env.mediaAdapter.calls.transcribeAudio.length, 1);
  const call = env.mediaAdapter.calls.transcribeAudio[0];
  assert.equal(call.provider.base_url, "http://127.0.0.1:2/v1");
  assert.equal(call.model, "m-aud");
  assert.equal(call.params.translate, true);
  assert.equal(call.params.language, "zh");
  assert.equal(call.input.mime, "audio/mpeg");
  assert.equal(res.text, "转写文本");
  assert.equal(res.meta.operation, "translate");
});

test("transcribe_audio：不支持的 operation 明确报错", async () => {
  setup();
  await assert.rejects(() => runSkill("transcribe_audio", { audio: "x", operation: "summarize" }, {}), /不支持的音频文字操作/);
});

// ── generate_music ─────────────────────────────────────────────────────────
test("generate_music：generateMusic 参数 + 音频落盘", async () => {
  const env = setup();
  const res = await runSkill("generate_music", { prompt: "lofi", title: "夜", instrumental: true }, {});
  assert.equal(env.mediaAdapter.calls.generateMusic.length, 1);
  const call = env.mediaAdapter.calls.generateMusic[0];
  assert.equal(call.provider.base_url, "http://127.0.0.1:2/v1");
  assert.equal(call.model, "m-aud");
  assert.equal(call.params.prompt, "lofi");
  assert.equal(call.params.title, "夜");
  assert.equal(call.params.instrumental, true);
  assert.equal(env.fetchImpl.calls[0], "https://cdn.example/m.mp3");
  assert.equal(res.audios.length, 1);
});

// ── procedure 全链路 ───────────────────────────────────────────────────────
function saveProcedureSkill(over) {
  return saveCustomSkill(Object.assign({
    id: "flow_demo",
    name: "演示流程",
    description: "两步演示",
    systemPrompt: "你是流程执行器",
    v2: {
      triggers: ["演示"],
      inputs: ["主题"],
      steps: [{ title: "写作", detail: "先写" }, { title: "配图", detail: "再画" }],
      allowedTools: ["writing", "generate_image"],
      permissions: { readsFiles: false, writesFiles: false, network: false, sensitive: [] },
      output: "成果",
      checks: [],
      version: 1,
    },
  }, over || {}));
}

test("procedure：writing + generate_image + finish 全链路（含图片收集与执行记录）", async () => {
  const env = setup({
    model: {
      procedureScript: [
        [
          { id: "c1", name: "writing", arguments: JSON.stringify({ instruction: "写一首诗" }) },
          { id: "c2", name: "generate_image", arguments: JSON.stringify({ prompt: "配图" }) },
        ],
        [{ id: "c3", name: "finish", arguments: JSON.stringify({ summary: "全部完成" }) }],
      ],
    },
  });
  saveProcedureSkill();
  const res = await runSkill("flow_demo", { instruction: "做一份演示" }, {});
  assert.match(res.text, /全部完成/);
  assert.match(res.text, /执行记录/);
  assert.match(res.text, /writing/);
  assert.match(res.text, /generate_image/);
  assert.equal(res.images.length, 1);
  assert.equal(res.meta.steps, 2);
  assert.equal(env.mediaAdapter.calls.generateImages.length, 1);
  const procCall = env.modelAdapter.calls.find((c) => c.tools && c.tools.length);
  assert.match(procCall.params.system, /执行规则/);
});

test("procedure：procedureTools 只暴露白名单基础技能 + finish", () => {
  setup();
  const names = procedureTools(["writing", "not_a_skill", "generate_image"], false).map((t) => t.function.name);
  assert.deepEqual(names, ["writing", "generate_image", "finish"]);
  const withResource = procedureTools([], true).map((t) => t.function.name);
  assert.ok(withResource.includes("read_skill_resource"));
  assert.equal(withResource[withResource.length - 1], "finish");
});

test("procedure：read_skill_resource 读取 Skill 自带资源", async () => {
  setup({
    model: {
      procedureScript: [
        [{ id: "r1", name: "read_skill_resource", arguments: JSON.stringify({ path: "refs/a.md" }) }],
        [{ id: "f1", name: "finish", arguments: JSON.stringify({ summary: "读完" }) }],
      ],
    },
  });
  saveProcedureSkill({
    id: "flow_res",
    name: "资源流程",
    description: "资源",
    source: {
      format: "agentskills/v1",
      sourcePath: "x",
      instructions: "i",
      files: [{ path: "refs/a.md", content: "模板内容" }],
      metadata: {},
    },
  });
  const res = await runSkill("flow_res", { instruction: "按资源执行" }, {});
  assert.match(res.text, /读取 Skill 资源 refs\/a.md/);
  assert.match(res.text, /读完/);
});

// ── 失败与取消路径 ─────────────────────────────────────────────────────────
test("失败路径：modelAdapter 返回 ok:false 时抛出结构化错误", async () => {
  setup({ model: { failText: "ENDPOINT_BLOCKED" } });
  await assert.rejects(() => runSkill("chat", { instruction: "x" }, {}), /ENDPOINT_BLOCKED/);
});

test("取消路径：已中止 signal 在 runSkill 入口抛 ABORT_ERR", async () => {
  setup();
  await assert.rejects(() => runSkill("writing", { instruction: "x" }, { signal: { aborted: true } }), (error) => error.code === "ABORT_ERR");
});

test("取消路径：procedure 每轮循环检查 signal", async () => {
  const signal = { aborted: false };
  let round = 0;
  const modelAdapter = {
    calls: [],
    async call(req) {
      this.calls.push(req);
      if (req.tools && req.tools.length) {
        round++;
        if (round === 1) {
          signal.aborted = true;
          return { ok: true, text: "", toolCalls: [{ id: "c1", name: "writing", arguments: JSON.stringify({ instruction: "x" }) }] };
        }
        return { ok: true, text: "", toolCalls: [] };
      }
      return { ok: true, text: "TEXT" };
    },
  };
  setup({ modelAdapter: modelAdapter });
  saveProcedureSkill();
  await assert.rejects(() => runSkill("flow_demo", { instruction: "做" }, { signal }), (error) => error.code === "ABORT_ERR");
});

// ── 依赖缺失：结构化 AGENT_DEPENDENCY_UNAVAILABLE ──────────────────────────
function assertDependency(promiseFactory, dependency) {
  return assert.rejects(promiseFactory, (error) => {
    assert.equal(error.code, AGENT_DEPENDENCY_UNAVAILABLE, dependency + " code");
    assert.equal(error.dependency, dependency, "dependency 名称");
    return true;
  });
}

test("依赖缺失：未注入 mediaAdapter → 结构化拒绝，不伪造产物", async () => {
  const env = setup({ mediaAdapter: null });
  const imgId = env.fsAdapter.seedFile("p.png", "image/png", Buffer.from("P"));
  await assertDependency(() => runSkill("generate_image", { prompt: "x" }, {}), "mediaAdapter");
  await assertDependency(() => runSkill("midjourney", { operation: "imagine", prompt: "x" }, {}), "mediaAdapter");
  await assertDependency(() => runSkill("describe_image", { image: imgId }, {}), "mediaAdapter");
});

test("依赖缺失：未注入 fsAdapter → 落盘拒绝，不返回假路径", async () => {
  setup({ fsAdapter: null });
  await assertDependency(
    () => runSkill("generate_image", { prompt: "x" }, { imageProviderId: "p_jimeng", imageModel: "jimeng-5.0Pro" }),
    "fsAdapter",
  );
});

test("依赖缺失：providerAdapter / modelAdapter / cliRuntime / artworkAdapter", async () => {
  setup({ providerAdapter: null });
  await assertDependency(() => runSkill("generate_image", { prompt: "x" }, {}), "providerAdapter");

  setup({ modelAdapter: null });
  await assertDependency(() => runSkill("chat", { instruction: "x" }, {}), "modelAdapter");

  setup({ cliRuntime: null });
  await assertDependency(() => runSkill("upscale_image", { image: "x" }, { imageProviderId: "p_jimeng", imageModel: "jimeng-5.0Pro" }), "cliRuntime");

  setup({ artworkAdapter: null });
  await assertDependency(() => generateMusicArtwork(), "artworkAdapter");
});

// ── artwork ────────────────────────────────────────────────────────────────
test("artwork：generateMusicArtwork 生成歌手/专辑插画并扫描", async () => {
  const env = setup();
  const res = await generateMusicArtwork();
  assert.deepEqual(res, { artists: 1, albums: 1, failed: 0 });
  assert.deepEqual(env.artworkAdapter.calls.putArtwork.map((c) => [c.kind, c.name]), [["artist", "歌手A"], ["album", "k1"]]);
  assert.equal(env.artworkAdapter.calls.scan, 1);
  assert.equal(env.mediaAdapter.calls.generateImages.length, 2);
});

test("artwork：generateArtistsArtwork 只处理歌手", async () => {
  const env = setup({ artwork: { artists: ["A", "B"] } });
  const res = await generateArtistsArtwork();
  assert.deepEqual(res, { artists: 2, failed: 0 });
  assert.equal(env.artworkAdapter.calls.putArtwork.length, 2);
  assert.equal(env.mediaAdapter.calls.generateImages.length, 2);
});

// ── 纯函数 ─────────────────────────────────────────────────────────────────
test("纯函数：buildGroups / combinations / mediaExt / parseDataMedia / normalizeVideoRefs / protocolParams", () => {
  assert.deepEqual(buildGroups(["a", "b", "c"], "sequential", 2, "run"), [["a", "b"], ["c"]]);
  assert.deepEqual(buildGroups(["a", "b", "c"], "sequential", 2, "skip"), [["a", "b"]]);
  assert.throws(() => buildGroups(["a", "b", "c"], "sequential", 2, "error"), /不足一组/);
  assert.deepEqual(buildGroups(["a", "b", "c"], "all_in_one", 1, "run"), [["a", "b", "c"]]);
  assert.deepEqual(combinations(["a", "b", "c"], 2), [["a", "b"], ["a", "c"], ["b", "c"]]);
  assert.equal(mediaExt("audio/mpeg"), "mp3");
  assert.equal(mediaExt("application/octet-stream", "https://x/y.webm?z=1"), "webm");
  assert.equal(parseDataMedia("data:image/png;base64,AAAA", "image").mime, "image/png");
  assert.throws(() => parseDataMedia("data:audio/mpeg;base64,AAAA", "image"), /不是图片/);
  assert.deepEqual(normalizeVideoRefs([{ ref: "a", role: "first_frame" }, "b"]), [{ ref: "a", role: "first_frame" }, { ref: "b" }]);
  assert.deepEqual(normalizeVideoRefs(undefined), []);
  const params = protocolParamsFromAgentArgs({ path: "p", size: "1", n: 2, extra: 3 }, ["path", "size", "n"]);
  assert.deepEqual(params, { extra: 3 });
});

test("纯函数：runPool 并发上限与结果顺序", async () => {
  let active = 0;
  let peak = 0;
  const out = await runPool([1, 2, 3, 4, 5], 2, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10]);
  assert.ok(peak <= 2, "并发不应超过 2，实际 " + peak);
});

// ── resolve* 选型 ──────────────────────────────────────────────────────────
test("resolve*：按能力选型并返回 ResolvedProvider 形状", () => {
  const pa = makeProviderAdapter();
  setup({ providerAdapter: pa });
  const image = resolveImageTarget({});
  assert.equal(image.provider.id, "p_media");
  assert.equal(image.model, "m-img");
  assert.equal(image.providerName, "媒体站点");
  assert.deepEqual(image.provider, { id: "p_media", base_url: "http://127.0.0.1:2/v1", api_key: "k", protocol: "openai" });

  const video = resolveVideoTarget({});
  assert.equal(video.model, "m-vid");
  const audio = resolveAudioTarget({});
  assert.equal(audio.model, "m-aud");

  assert.equal(isJimengCliProvider(pa.providers[2]), true);
  assert.equal(isJimengCliProvider(pa.providers[0]), false);
});
