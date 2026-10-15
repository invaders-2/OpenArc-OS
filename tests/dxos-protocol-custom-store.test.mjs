/**
 * X3 · DX OS 旧版自定义协议仓库（customProtocolStore）移植契约测试。
 * 只读源：DXSRC/protocols.ts:2984-3181。
 * 被测：
 *   · electron/protocol-engine/legacy-custom-protocol-store.cjs（仓库本体）
 *   · electron/protocol-engine/legacy-protocols.cjs（详情/列表 origin 接线）
 *   · electron/protocol-engine/repository.cjs（v2 边界与数据目录接线）
 * 运行：node --test tests/dxos-protocol-custom-store.test.mjs
 * 全程离线：只读写 node:os 临时目录，不联网，不接触真实 userData。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const legacy = require("../electron/protocol-engine/legacy-protocols.cjs");
const store = require("../electron/protocol-engine/legacy-custom-protocol-store.cjs");
const repository = require("../electron/protocol-engine/repository.cjs");

const BUILTIN_PROVIDER_COUNT = 20; // 源 protocols.ts:2589-2982 实测 20（含 cli:dreamina-canvas）
const BUILTIN_MODEL_TOTAL = 29; // 源 protocols.ts:281-2568
const BUILTIN_MODEL_VISIBLE = 25; // 29 - 4 个内部协议（ollama/apimart-gemini/apimart-claude/apimart-media）

function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

/** 每个用例独立的空 store 文件，避免用例间串状态。 */
function useStoreFile(prefix) {
  const dir = tempDir(prefix || "dxos-custom-");
  const file = path.join(dir, "custom-protocols.json");
  store.configureCustomProtocolStore({ storeFile: file });
  return { dir, file };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

function validProvider(id) {
  return { id, label: "我的中转站", runtimeProtocol: "openai", auth: { type: "bearer" } };
}

function validModel(id) {
  return { id, label: "我的图像协议", runtimeProtocol: "openai", capabilities: { "image.generate": true } };
}

function installRepo(storeFile) {
  repository.configureProtocolRepository({ storeFile, packageDirs: [] });
  return storeFile;
}

/** 取 v2 内置协议当模板，只换 id —— 保证 v2 用例拿到的是合法（declarative）条目。 */
function v2ModelFromBuiltin(id) {
  const builtin = repository.getProtocolV2("model", "openai-images");
  assert.ok(builtin && builtin.protocol, "v2 内置 openai-images 必须存在");
  const protocol = JSON.parse(JSON.stringify(builtin.protocol));
  protocol.id = id;
  return protocol;
}

test("空 store：详情列表全部 origin=builtin，内置计数不变（源 :3375/:3385）", () => {
  const { file } = useStoreFile();
  const providers = legacy.listProviderProtocolDetails();
  const models = legacy.listModelProtocolDetails();
  assert.equal(providers.length, BUILTIN_PROVIDER_COUNT);
  assert.equal(models.length, BUILTIN_MODEL_VISIBLE);
  assert.ok(providers.every((item) => item.builtin === true && item.origin === "builtin"));
  assert.ok(models.every((item) => item.builtin === true && item.origin === "builtin"));
  const status = store.customProtocolStoreStatus();
  assert.equal(status.file, file);
  assert.equal(status.loaded, false); // 文件不存在 → 未装载，后续 configure/save 仍可触发
  assert.deepEqual(status.providerIds, []);
  assert.deepEqual(status.modelIds, []);
});

test("写入自建协议：详情/摘要列表可读、origin=custom、builtin=false、executor 清空、原子落盘", () => {
  const { file } = useStoreFile();
  const savedProvider = store.saveCustomProtocol("provider", validProvider("my-relay"));
  const savedModel = store.saveCustomProtocol("model", validModel("my-image"));
  assert.equal(savedProvider.id, "my-relay");
  assert.equal(savedModel.id, "my-image");
  assert.equal(savedProvider.executor, undefined); // 源 :3039-3042 不允许自建条目带 executor

  const provider = legacy.listProviderProtocolDetails().find((item) => item.id === "my-relay");
  assert.ok(provider, "自建 provider 必须能被详情列表读到");
  assert.equal(provider.origin, "custom");
  assert.equal(provider.builtin, false);
  const model = legacy.listModelProtocolDetails().find((item) => item.id === "my-image");
  assert.ok(model, "自建 model 必须能被详情列表读到");
  assert.equal(model.origin, "custom");
  assert.equal(model.builtin, false);
  assert.ok(legacy.listProviderProtocols().some((item) => item.id === "my-relay"));
  assert.ok(legacy.listModelProtocols().some((item) => item.id === "my-image"));

  // 内置表只在原表上追加，builtin 集合本身不变
  assert.equal(legacy.BUILTIN_PROVIDER_PROTOCOL_IDS.size, BUILTIN_PROVIDER_COUNT);
  assert.equal(legacy.BUILTIN_MODEL_PROTOCOL_IDS.size, BUILTIN_MODEL_TOTAL);
  assert.equal(legacy.listProviderProtocolDetails().length, BUILTIN_PROVIDER_COUNT + 1);
  assert.equal(legacy.listModelProtocolDetails().length, BUILTIN_MODEL_VISIBLE + 1);

  // 原子写：无残留 .tmp；文件为合法 JSON，只含这两条，且 executor 不落盘
  assert.equal(fs.existsSync(file + ".tmp"), false);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(parsed.provider), ["my-relay"]);
  assert.deepEqual(Object.keys(parsed.model), ["my-image"]);
  assert.equal("executor" in parsed.model["my-image"], false);
  assert.equal(parsed.model["my-image"].runtimeProtocol, "openai");
});

test("重启装载：custom-protocols.json 里的合法条目被读回并标注 custom", () => {
  const { file } = useStoreFile();
  writeJson(file, {
    provider: { "disk-relay": validProvider("disk-relay") },
    model: { "disk-image": validModel("disk-image") },
  });
  store.configureCustomProtocolStore({ storeFile: file });
  const provider = legacy.listProviderProtocolDetails().find((item) => item.id === "disk-relay");
  assert.equal(provider.origin, "custom");
  assert.equal(provider.builtin, false);
  assert.equal(provider.label, "我的中转站");
  const model = legacy.listModelProtocolDetails().find((item) => item.id === "disk-image");
  assert.equal(model.origin, "custom");
  assert.deepEqual(store.customProtocolStoreStatus().modelIds, ["disk-image"]);
  assert.deepEqual(store.customProtocolStoreStatus().providerIds, ["disk-relay"]);
});

test("损坏 JSON：结构化错误 + 安全忽略，内置表与 origin 不受影响（源 :3154）", () => {
  const { file } = useStoreFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ this is not json", "utf8");
  store.configureCustomProtocolStore({ storeFile: file });
  const providers = legacy.listProviderProtocolDetails();
  assert.equal(providers.length, BUILTIN_PROVIDER_COUNT);
  assert.ok(providers.every((item) => item.origin === "builtin"));
  const status = store.customProtocolStoreStatus();
  assert.equal(status.loaded, false);
  assert.equal(status.lastLoad.ok, false);
  assert.equal(status.lastLoad.error, "STORE_FILE_CORRUPT");
  assert.equal(status.lastLoad.file, file);
  assert.equal(typeof status.lastLoad.detail, "string");
  assert.deepEqual(status.providerIds, []);
});

test("非法条目：逐条安全忽略并记录原因；合法条目照常安装，内置不被覆盖（源 :3141-3152）", () => {
  const { file } = useStoreFile();
  writeJson(file, {
    provider: {
      openai: { id: "openai", label: "试图覆盖内置" },
      "Bad Id": { id: "Bad Id", label: "非法 id" },
      "no-label": { id: "no-label" },
      "no-runtime": { id: "no-runtime", label: "未知运行协议", runtimeProtocol: "does-not-exist" },
      "ok-relay": validProvider("ok-relay"),
    },
    model: {
      "not-object": "just a string",
      "ok-model": validModel("ok-model"),
    },
  });
  store.configureCustomProtocolStore({ storeFile: file });
  const providers = legacy.listProviderProtocolDetails();
  assert.equal(providers.find((item) => item.id === "openai").origin, "builtin");
  assert.deepEqual(providers.filter((item) => item.origin === "custom").map((item) => item.id), ["ok-relay"]);
  assert.equal(legacy.listModelProtocolDetails().find((item) => item.id === "ok-model").origin, "custom");

  const ignored = store.customProtocolStoreStatus().lastLoad.ignored;
  assert.equal(ignored.length, 5); // openai / Bad Id / no-label / no-runtime / not-object
  assert.ok(ignored.some((item) => item.kind === "provider" && item.id === "openai"));
  assert.ok(ignored.some((item) => item.kind === "provider" && item.id === "Bad Id"));
  assert.ok(ignored.every((item) => typeof item.reason === "string" && item.reason.length > 0));
});

test("saveCustomProtocol 非法输入：抛错 + 不落盘 + 不改内置表 + 不留内存假条目", () => {
  const { file } = useStoreFile();
  assert.throws(() => store.saveCustomProtocol("provider", { id: "openai", label: "覆盖" }), /不能覆盖/);
  assert.throws(() => store.saveCustomProtocol("provider", { id: "xx", label: "" }), /label/);
  assert.throws(() => store.saveCustomProtocol("model", { id: "ok-id", label: "x", runtimeProtocol: "nope" }), /运行协议/);
  assert.throws(() => store.saveCustomProtocol("nope", { id: "ok-id", label: "x" }), /kind/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(legacy.listProviderProtocolDetails().length, BUILTIN_PROVIDER_COUNT);
  assert.equal(legacy.listModelProtocolDetails().some((item) => item.id === "ok-id"), false);
  assert.deepEqual(store.customProtocolStoreStatus().modelIds, []);
});

test("removeCustomProtocol：删除自建并落盘；目标不存在时抛错（源 :3170-3179）", () => {
  const { file } = useStoreFile();
  store.saveCustomProtocol("provider", validProvider("removable"));
  assert.ok(legacy.listProviderProtocolDetails().some((item) => item.id === "removable"));
  assert.equal(store.removeCustomProtocol("provider", "REMOVABLE"), "removable"); // id 大小写归一
  assert.equal(legacy.listProviderProtocolDetails().some((item) => item.id === "removable"), false);
  assert.equal(legacy.listProviderProtocolDetails().length, BUILTIN_PROVIDER_COUNT);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).provider), []);
  assert.throws(() => store.removeCustomProtocol("provider", "removable"), /不存在/);
});

test("未配置落盘路径：save 失败关闭，不留内存假条目", () => {
  store.resetCustomProtocolStoreForTests();
  repository.configureProtocolRepository({ storeFile: null, packageDirs: null });
  assert.throws(() => store.saveCustomProtocol("provider", validProvider("ghost")), /未配置落盘路径/);
  assert.equal(legacy.listProviderProtocolDetails().some((item) => item.id === "ghost"), false);
});

test("落点遵循 foundation 约定：<userData>/dxos/custom-protocols.json", () => {
  store.resetCustomProtocolStoreForTests();
  repository.configureProtocolRepository({ storeFile: null, packageDirs: null });
  const userDataDir = tempDir("dxos-userdata-");
  const file = path.join(userDataDir, "dxos", "custom-protocols.json");
  assert.equal(store.customProtocolStoreFilePath(userDataDir), file);
  writeJson(file, { provider: {}, model: { "foundation-model": validModel("foundation-model") } });
  store.configureCustomProtocolStore({ userDataDir });
  const found = legacy.listModelProtocolDetails().find((item) => item.id === "foundation-model");
  assert.ok(found, "必须从 foundation 约定落点装载");
  assert.equal(found.origin, "custom");
  assert.equal(store.customProtocolStoreStatus().file, file);
});

test("源 :3009 环境变量覆盖：DX_CUSTOM_PROTOCOL_FILE 指定落点", () => {
  store.resetCustomProtocolStoreForTests();
  repository.configureProtocolRepository({ storeFile: null, packageDirs: null });
  const dir = tempDir("dxos-env-");
  const file = path.join(dir, "custom-protocols.json");
  writeJson(file, { provider: {}, model: { "env-model": validModel("env-model") } });
  const previous = process.env.DX_CUSTOM_PROTOCOL_FILE;
  process.env.DX_CUSTOM_PROTOCOL_FILE = file;
  try {
    const found = legacy.listModelProtocolDetails().find((item) => item.id === "env-model");
    assert.ok(found, "DX_CUSTOM_PROTOCOL_FILE 指定的 store 必须被装载");
    assert.equal(found.origin, "custom");
    assert.equal(store.customProtocolStoreStatus().file, file);
  } finally {
    if (previous === undefined) delete process.env.DX_CUSTOM_PROTOCOL_FILE;
    else process.env.DX_CUSTOM_PROTOCOL_FILE = previous;
    store.resetCustomProtocolStoreForTests();
  }
});

test("与 dx-protocol/v2 边界：文件/形状/出口独立，同 id 互不遮蔽", () => {
  store.resetCustomProtocolStoreForTests();
  const legacyDir = tempDir("dxos-legacy-");
  const legacyFile = path.join(legacyDir, "custom-protocols.json");
  store.configureCustomProtocolStore({ storeFile: legacyFile });
  store.saveCustomProtocol("model", { ...validModel("shared-id"), label: "旧版共享 id" });
  store.saveCustomProtocol("model", validModel("legacy-only"));

  const v2Dir = tempDir("dxos-v2-");
  const v2File = installRepo(path.join(v2Dir, "custom-protocols-v2.json"));
  repository.saveProtocolV2("model", v2ModelFromBuiltin("shared-id"));
  repository.saveProtocolV2("model", v2ModelFromBuiltin("v2-only"));

  // v2 出口只认自己的仓库
  assert.equal(repository.isCustomProtocolV2("model", "shared-id"), true);
  assert.equal(repository.isCustomProtocolV2("model", "v2-only"), true);
  assert.equal(repository.isCustomProtocolV2("model", "legacy-only"), false);
  assert.ok(repository.listProtocolsV2("model").some((entry) => entry.id === "v2-only"));
  assert.equal(repository.listProtocolsV2("model").some((entry) => entry.id === "legacy-only"), false);

  // 旧版详情列表只看旧版表：v2-only 不出现；shared-id 用旧版定义
  const details = legacy.listModelProtocolDetails();
  assert.equal(details.some((item) => item.id === "v2-only"), false);
  assert.ok(details.some((item) => item.id === "legacy-only" && item.origin === "custom"));
  const shared = details.find((item) => item.id === "shared-id");
  assert.ok(shared);
  assert.equal(shared.origin, "custom");
  assert.equal(shared.label, "旧版共享 id");
  assert.equal(shared.runtimeProtocol, "openai");
  assert.equal(shared.executor, undefined);
  assert.equal(shared.kind, "model-protocol-package");

  // 反之：旧版条目不影响 v2 出口的条目形状
  assert.equal(repository.getProtocolV2("model", "shared-id").protocol.executor.type, "declarative");

  // 文件彼此独立
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(legacyFile, "utf8")).model).sort(), ["legacy-only", "shared-id"]);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(v2File, "utf8")).model).sort(), ["shared-id", "v2-only"]);
});

test("生产接线：配置 v2 仓库后，旧版 store 从同目录 custom-protocols.json 装载", () => {
  store.resetCustomProtocolStoreForTests();
  const dir = tempDir("dxos-wire-");
  const dxosDir = path.join(dir, "dxos");
  writeJson(path.join(dxosDir, "custom-protocols.json"), {
    provider: {},
    model: { "wired-model": validModel("wired-model") },
  });
  installRepo(path.join(dxosDir, "custom-protocols-v2.json"));
  const found = legacy.listModelProtocolDetails().find((item) => item.id === "wired-model");
  assert.ok(found, "v2 仓库同目录的旧版 store 必须被装载（provider-protocol-service.cjs:636-639 接线）");
  assert.equal(found.origin, "custom");
  assert.equal(store.customProtocolStoreStatus().file, path.join(dxosDir, "custom-protocols.json"));
});
