/**
 * B7e2 后续 · CLI 协议族 legacy 执行器端口集成测试（node:test，离线，无真实 CLI、无外网）。
 *
 * 覆盖：
 *   ① 未安装（CLI 探测为 false）→ 不注册端口，执行器仍回 LEGACY_DEPENDENCY_UNAVAILABLE；
 *   ② 已安装 → 注册 cliJimeng / cliCodex / cliGemini，legacy 执行器真的走到 B3 适配器（图片生成 / 编辑、
 *      视频生成、对话、图片理解、模型目录）；
 *   ③ 部分安装 → 只注册已安装的端口，其余协议保持结构化拒绝；
 *   ④ 端口层失败语义：未知动作 / 适配器抛错 → 结构化错误，绝不假成功；
 *   ⑤ options.install === false → 只探测不注册。
 *
 * 只读源：DX OS 0.5.1 server/protocols.ts:3649-3652 / 5287-5302 / 6043-6061 / 6516-6544 / 6636-6645。
 * 端口实现：electron/legacy-cli-ports.cjs；注册表：electron/legacy-executor-ports.cjs。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const images = require("../electron/protocol-engine/legacy-executor-images.cjs");
const media = require("../electron/protocol-engine/legacy-executor-media.cjs");
const chat = require("../electron/protocol-engine/legacy-executor-chat.cjs");
const ports = require("../electron/legacy-executor-ports.cjs");
const { createLegacyCliPorts, installLegacyCliPorts, LEGACY_CLI_PORT_NAMES } = require("../electron/legacy-cli-ports.cjs");

const tmpDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-cli-ports-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  ports.clearLegacyExecutorPorts();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

/** 假 CLI-1（即梦）适配器：只在内存里返回源形状，绝不 spawn。 */
function fakeTools({ installed = true, dir } = {}) {
  return {
    jimengCliInstalled: () => installed,
    whichImpl: () => (installed ? "/fake/dreamina" : null),
    tempMediaFile: (buf, mime, ext) => {
      const file = path.join(dir, "ref-" + String(Math.random()).slice(2) + ext);
      fs.writeFileSync(file, buf);
      return file;
    },
    generateJimengImage: async (prompt, model, size, imagePaths) => ({ images: ["https://cdn.example/jimeng.png"], raw: { prompt, model, size, imagePaths: imagePaths || [] } }),
    generateJimengVideo: async (prompt, model, opts) => ({ videos: ["https://cdn.example/jimeng.mp4"], raw: { prompt, model, opts } }),
    probeJimengCli: () => ({ ok: installed, installed }),
  };
}

/** 假 CLI-2（Codex / Gemini）适配器：不 spawn、不联网、不读本机登录态。 */
function fakeBridge({ installed = true, dir } = {}) {
  return {
    agentCliInstalled: () => installed,
    generateCodexImage: async (prompt, model, size) => ({ images: ["data:image/png;base64,AAAA"], raw: { prompt, model, size } }),
    editCodexImage: async (prompt, refs, model, size) => ({ images: ["data:image/png;base64,BBBB"], raw: { prompt, model, size, refs: refs.slice() } }),
    generateGeminiCliImage: async (prompt, model, size, timeoutMs) => ({ images: ["data:image/png;base64,CCCC"], raw: { prompt, model, size, timeoutMs } }),
    editGeminiCliImage: async (prompt, refs, model, size, timeoutMs) => ({ images: ["data:image/png;base64,DDDD"], raw: { prompt, model, size, timeoutMs, refs: refs.slice() } }),
    runAgentCliChat: async (tool, prompt, model, timeoutMs, options = {}) => ({ text: "reply-from-" + tool, latencyMs: 3, raw: { prompt, model, timeoutMs, imagePaths: options.imagePaths || [] } }),
    agentCliModels: async () => ({ model_items: [{ model: "codex-llm", type: "llm" }, { model: "gpt-image-2", type: "image" }] }),
  };
}

const providerOf = (protocol) => ({ id: "stub", protocol, base_url: "https://example.invalid", api_key: "FAKE" });
const refInput = () => ({ buf: Buffer.from("x"), mime: "image/png", name: "x.png" });

test("未安装：三个 CLI 端口都不注册，legacy 执行器仍回结构化 LEGACY_DEPENDENCY_UNAVAILABLE", async () => {
  const dir = tempDir();
  const result = installLegacyCliPorts({ tools: fakeTools({ installed: false, dir }), bridge: fakeBridge({ installed: false, dir }) });
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.skipped, [...LEGACY_CLI_PORT_NAMES].sort());
  assert.deepEqual(result.installed, { cliJimeng: false, cliCodex: false, cliGemini: false });
  for (const name of LEGACY_CLI_PORT_NAMES) assert.ok(result.reasons[name].length > 0, name + " 必须写明未安装原因");
  assert.deepEqual(ports.listLegacyExecutorPorts(), []);

  const gen = await images.generateImages(providerOf("cli:jimeng"), "jimeng-5.0Pro", { prompt: "猫" }, 1000);
  assert.equal(gen.ok, false);
  assert.equal(gen.error, "LEGACY_DEPENDENCY_UNAVAILABLE");
  assert.match(gen.detail, /cliJimeng/);

  const video = await media.generateVideos(providerOf("cli:jimeng"), "seedance2.0fast", { prompt: "猫" }, undefined, 1000);
  assert.equal(video.error, "LEGACY_DEPENDENCY_UNAVAILABLE");
  assert.match(video.detail, /cliJimeng/);

  const edit = await media.editImages(providerOf("cli:codex"), "gpt-image-2", { prompt: "改" }, [refInput()], 1000);
  assert.equal(edit.error, "LEGACY_DEPENDENCY_UNAVAILABLE");
  assert.match(edit.detail, /cliCodex/);

  const called = await chat.callChat(providerOf("cli:gemini"), "auto", { prompt: "hi" });
  assert.equal(called.error, "LEGACY_DEPENDENCY_UNAVAILABLE");
  assert.match(called.detail, /CLI/);

  const catalog = await chat.fetchModelCatalog(providerOf("cli:codex"));
  assert.equal(catalog.error, "LEGACY_DEPENDENCY_UNAVAILABLE");

  const described = await chat.describeImage(providerOf("cli:codex"), "gpt-5", "data:image/png;base64,AAAA", "描述");
  assert.equal(described.error, "LEGACY_DEPENDENCY_UNAVAILABLE");
});

test("已安装：注册三个端口；图片生成 / 编辑、视频、对话、图片理解、模型目录真的走到 B3 适配器", async () => {
  const dir = tempDir();
  const tools = fakeTools({ installed: true, dir });
  const bridge = fakeBridge({ installed: true, dir });
  const result = installLegacyCliPorts({ tools, bridge });
  assert.deepEqual(result.applied, [...LEGACY_CLI_PORT_NAMES].sort());
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(ports.listLegacyExecutorPorts(), [...LEGACY_CLI_PORT_NAMES].sort());

  // ① 即梦文生图（源 protocols.ts:5287-5294）
  const gen = await images.generateImages(providerOf("cli:jimeng"), "jimeng-5.0Pro", { prompt: "猫", size: "1024x1024" }, 1000);
  assert.deepEqual(gen.images, [{ type: "url", value: "https://cdn.example/jimeng.png" }]);
  assert.equal(gen.raw.model, "jimeng-5.0Pro");

  // ② 即梦图生图：参考图落临时文件后交给适配器（源 6516-6525）
  const jimengEdit = await media.editImages(providerOf("cli:jimeng"), "jimeng-5.0Pro", { prompt: "改" }, [refInput()], 1000);
  assert.equal(jimengEdit.images[0].value, "https://cdn.example/jimeng.png");
  assert.equal(jimengEdit.raw.imagePaths.length, 1);
  assert.match(jimengEdit.raw.imagePaths[0], /ref-.*\.png$/);

  // ③ 即梦视频（源 6043-6061）
  const video = await media.generateVideos(providerOf("cli:jimeng"), "seedance2.0fast", { prompt: "猫", duration: 8 }, undefined, 1000);
  assert.deepEqual(video.videos, [{ type: "url", value: "https://cdn.example/jimeng.mp4" }]);
  assert.equal(video.raw.opts.duration, 8);

  // ④ Codex 图片编辑：临时参考图在 finally 清理（源 6532-6534）
  const codexEdit = await media.editImages(providerOf("cli:codex"), "gpt-image-2", { prompt: "改" }, [refInput()], 1000);
  assert.equal(codexEdit.images[0].value, "data:image/png;base64,BBBB");
  assert.equal(codexEdit.raw.refs.length, 1);
  assert.equal(fs.existsSync(codexEdit.raw.refs[0]), false, "参考图临时文件必须被清理");

  // ⑤ Gemini 文生图（源 5299-5302）
  const geminiGen = await images.generateImages(providerOf("cli:gemini"), "gemini-3.1-flash-image", { prompt: "猫" }, 1000);
  assert.equal(geminiGen.images[0].value, "data:image/png;base64,CCCC");

  // ⑥ Codex 对话 / 流式对话 / 图片理解（源 3649-3652 / 6636-6645）
  const called = await chat.callChat(providerOf("cli:codex"), "gpt-5", { system: "S", prompt: "hi" }, {}, 1000);
  assert.equal(called.text, "reply-from-codex");
  assert.match(called.raw.prompt, /系统要求/);
  const deltas = [];
  const streamed = await chat.streamChat(providerOf("cli:codex"), "gpt-5", { prompt: "hi" }, {}, (t) => deltas.push(t), 1000);
  assert.deepEqual(deltas, ["reply-from-codex"]);
  assert.equal(streamed.usage, undefined);
  const described = await chat.describeImage(providerOf("cli:gemini"), "auto", "data:image/png;base64,AAAA", "描述这张图");
  assert.equal(described, "reply-from-gemini");

  // ⑦ CLI 原生模型目录（agentCliModels）
  const catalog = await chat.fetchModelCatalog(providerOf("cli:codex"));
  assert.deepEqual(catalog, [{ model: "codex-llm", name: undefined, type: "llm" }, { model: "gpt-image-2", name: undefined, type: "image" }]);
});

test("部分安装：只注册已安装端口，其余协议保持结构化拒绝", async () => {
  const dir = tempDir();
  const tools = fakeTools({ installed: true, dir });
  const bridge = fakeBridge({ installed: false, dir });
  const result = installLegacyCliPorts({ tools, bridge });
  assert.deepEqual(result.applied, ["cliJimeng"]);
  assert.deepEqual(result.skipped, ["cliCodex", "cliGemini"]);
  assert.deepEqual(ports.listLegacyExecutorPorts(), ["cliJimeng"]);

  const jimeng = await images.generateImages(providerOf("cli:jimeng"), "jimeng-5.0Pro", { prompt: "猫" }, 1000);
  assert.equal(jimeng.images[0].value, "https://cdn.example/jimeng.png");

  const codex = await images.generateImages(providerOf("cli:codex"), "gpt-image-2", { prompt: "猫" }, 1000);
  assert.equal(codex.error, "LEGACY_DEPENDENCY_UNAVAILABLE");
  assert.match(codex.detail, /cliCodex/);

  const gemini = await images.generateImages(providerOf("cli:gemini"), "gemini-3.1-flash-image", { prompt: "猫" }, 1000);
  assert.equal(gemini.error, "LEGACY_DEPENDENCY_UNAVAILABLE");
  assert.match(gemini.detail, /cliGemini/);
});

test("端口失败语义：未知动作 / 适配器抛错都返回结构化错误，绝不假成功", async () => {
  const dir = tempDir();
  const bridge = fakeBridge({ installed: true, dir });
  bridge.generateCodexImage = async () => { throw new Error("模拟 CLI 崩溃"); };
  const result = installLegacyCliPorts({ tools: fakeTools({ installed: true, dir }), bridge });
  assert.equal(result.applied.includes("cliCodex"), true);

  const port = ports.getLegacyExecutorPort("cliJimeng");
  const unknown = await port("bogus.operation", {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, "LEGACY_CLI_UNKNOWN_OPERATION");

  const failed = await images.generateImages(providerOf("cli:codex"), "gpt-image-2", { prompt: "猫" }, 1000);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "LEGACY_CLI_EXECUTION_FAILED");
  assert.match(failed.detail, /模拟 CLI 崩溃/);

  const codePort = ports.getLegacyExecutorPort("cliCodex");
  const noRefs = await codePort("image.edit", { provider: providerOf("cli:codex"), model: "gpt-image-2", params: { prompt: "x" }, inputs: [] });
  assert.equal(noRefs.ok, false);
  assert.equal(noRefs.error, "LEGACY_CLI_INVALID_INPUT");
});

test("options.install === false：只探测不注册（端口表保持空）", () => {
  const dir = tempDir();
  const result = installLegacyCliPorts({ tools: fakeTools({ installed: true, dir }), bridge: fakeBridge({ installed: true, dir }), install: false });
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.skipped, [...LEGACY_CLI_PORT_NAMES].sort());
  assert.deepEqual(result.installed, { cliJimeng: true, cliCodex: true, cliGemini: true });
  assert.deepEqual(ports.listLegacyExecutorPorts(), []);
  const created = createLegacyCliPorts({ tools: fakeTools({ installed: false, dir }), bridge: fakeBridge({ installed: false, dir }) });
  assert.equal(created.ports.cliJimeng instanceof Function || typeof created.ports.cliJimeng === "function", true);
});
