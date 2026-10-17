/** task-64 · canvas/models 的 video-generation transport 按真实装配判断。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createModelFixture } from "./model-fixtures.mjs";
import { createResourceFixture } from "./resource-fixtures.mjs";

const require = createRequire(import.meta.url);
const { createModelBundle } = require("../electron/model-bootstrap.cjs");

test("transports.video-generation：未挂协议引擎 false；挂载且可 legacyExecute 才 true", async () => {
  const f = await createModelFixture();
  try {
    const admin = f.adminCtx();
    const ctx = { ...admin, appId: "canvas" };
    const before = f.modelService.listModelsForUse({ context: ctx });
    assert.equal(before.ok, true, JSON.stringify(before));
    assert.equal(before.transports["video-generation"], false, "没有 providerProtocol 时不得假称视频已接通");
    assert.equal(before.transports.chat, true);
    assert.equal(before.transports["image-generation"], true);

    f.modelService.providerProtocol = { service: { legacyExecute: async () => ({ ok: true, videos: [] }) } };
    const after = f.modelService.listModelsForUse({ context: ctx });
    assert.equal(after.transports["video-generation"], true, "协议引擎可执行视频时必须接通");

    f.modelService.providerProtocol = { service: {} };
    const broken = f.modelService.listModelsForUse({ context: ctx });
    assert.equal(broken.transports["video-generation"], false, "service 存在但没有执行入口仍为 false");
  } finally { f.close(); }
});

test("真实 createModelBundle 装配下 video transport 为 true", async () => {
  const f = await createResourceFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-task64-bundle-"));
  try {
    const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from("enc:" + s), decryptString: (b) => Buffer.from(b).toString("utf8").replace(/^enc:/, "") };
    const bundle = createModelBundle({ identityStore: f.identity, authorization: f.authService, authStore: f.store, userDataDir: dir, safeStorage, fetchImpl: fetch });
    const list = bundle.modelService.listModelsForUse({ context: { ...f.adminCtx(), appId: "canvas" } });
    assert.equal(list.ok, true, JSON.stringify(list));
    assert.equal(list.transports["video-generation"], true, "createModelBundle 必须挂载可执行视频的 providerProtocol");
  } finally {
    f.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("transports 不影响 models / defaultsState 投影", async () => {
  const f = await createModelFixture();
  try {
    const admin = f.adminCtx();
    f.store.upsertApp({ appId: "canvas", name: "无限画布", publisher: "builtin", status: "enabled", builtIn: 1 });
    f.modelService.grantAppModelAccess({ context: { ...admin, appId: "canvas" }, appId: "canvas", actions: ["model.view", "model.use"] });
    f.modelService.providerProtocol = { service: { legacyExecute: async () => ({ ok: true }) } };
    const list = f.modelService.listModelsForUse({ context: { ...admin, appId: "canvas" } });
    assert.equal(list.ok, true);
    assert.deepEqual(list.transports, { chat: true, "image-generation": true, "video-generation": true });
    assert.ok(Array.isArray(list.models));
    assert.ok(list.defaultsState && typeof list.defaultsState === "object");
  } finally { f.close(); }
});
