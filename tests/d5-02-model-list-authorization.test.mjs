/**
 * D5-02 第二批 · 渲染层模型清单的授权口径（listModelsForUse）。
 *
 * 冻结契约：**列表与调用同一口径**。resolveModel 会因 App 停用 / grant 撤销 / 配置或 provider 停用
 * 而拒绝调用；列表也必须同步消失，否则界面就是"看着能用、点了报错"。
 * 与 resolveModel 的既有语义无关的部分（默认值、解析顺序）本用例不改、不断言。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createModelFixture } from "./model-fixtures.mjs";

const require = createRequire(import.meta.url);
const { createModelBundle } = require("../electron/model-bootstrap.cjs");

const f = await createModelFixture();
const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d502-list-seed-"));
after(() => {
  f.close();
  try { fs.rmSync(seedDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const admin = f.adminCtx();
const host = { sessionRef: admin.sessionRef, appId: "settings", source: "ui" };
const canvasCtx = { sessionRef: admin.sessionRef, appId: "canvas", source: "ui" };
createModelBundle({ identityStore: f.identity, authorization: f.authService, authStore: f.store, userDataDir: seedDir, clock: f.clock });

const provider = f.modelService.createProvider({ context: host, displayName: "ListProbe", baseUrl: "http://127.0.0.1:9", scope: "ORGANIZATION", credentialSecret: "FAKE_D502_LIST" });
assert.equal(provider.ok, true, JSON.stringify(provider));
const providerId = provider.provider.providerId;
const config = f.modelService.createModel({ context: host, providerId, remoteModelId: "list-chat", displayName: "List Chat", capabilities: ["chat", "image-generation"], scope: "ORGANIZATION" });
assert.equal(config.ok, true, JSON.stringify(config));
const configId = config.model.configId;
// 与 governance-app-model-grant 一致：给一个可解析的默认模型，撤权后 resolveModel 才走到授权判定。
assert.equal(f.modelService.setDefault({ context: host, capability: "chat", configId, scope: "ORGANIZATION" }).ok, true);

const list = () => f.modelService.listModelsForUse({ context: canvasCtx });
const ids = () => (list().models || []).map((m) => m.configId);
const grantId = () => (f.store.appGrantsForApp("canvas", f.orgId).find((g) => g.resource_type === "model" && JSON.parse(g.actions || "[]").includes("model.use")) || {}).id;

test("L1 · 有 model.use 授权时列表含模型与供应商显示名，且不含地址/凭据", () => {
  const res = list();
  assert.equal(res.ok, true, JSON.stringify(res));
  const item = res.models.find((m) => m.configId === configId);
  assert.ok(item, "列表缺少已授权模型：" + JSON.stringify(res.models));
  assert.equal(item.providerId, providerId);
  assert.equal(item.providerName, "ListProbe");
  const dump = JSON.stringify(res);
  for (const leak of ["127.0.0.1", "FAKE_D502_LIST", "credential", "baseUrl", "base_url"]) {
    assert.equal(dump.includes(leak), false, "列表泄漏了 " + leak + "：" + dump.slice(0, 400));
  }
});

test("L2 · 撤销 model.use 后列表不再显示该模型（列表与 resolveModel 同一口径）", () => {
  const gid = grantId();
  assert.ok(gid, "未拿到 canvas 的 model.use grantId");
  const rev = f.governanceService.revokeAppAccess({ context: admin, grantId: gid });
  assert.equal(rev.ok, true, JSON.stringify(rev));
  const denied = f.modelService.resolveModel({ context: canvasCtx, capability: "chat" });
  assert.equal(denied.ok, false, "撤权后 resolveModel 仍放行");
  assert.equal(denied.error, "PROXY_UNAUTHORIZED");
  assert.deepEqual(ids(), [], "撤权后列表仍显示模型：" + JSON.stringify(list().models));
  console.log("[L2] revoke →", JSON.stringify({ resolveModel: denied.error, listed: ids().length }));
});

test("L3 · 重新授予后列表恢复（并且是真授权）", () => {
  const reg = f.governanceService.grantAppAccess({ context: admin, appId: "canvas", resourceType: "model", scope: "ORGANIZATION", actions: ["model.view", "model.use"] });
  assert.equal(reg.ok, true, JSON.stringify(reg));
  assert.ok(ids().includes(configId), "重新授予后列表里没有模型：" + JSON.stringify(ids()));
});

test("L4 · App 停用 / 模型停用 / provider 停用，列表与调用同时消失", () => {
  const disableApp = () => f.store.upsertApp({ appId: "canvas", name: "无限画布", publisher: "openarc-builtin", status: "disabled", builtIn: 1 });
  const enableApp = () => f.store.upsertApp({ appId: "canvas", name: "无限画布", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
  disableApp();
  assert.deepEqual(ids(), [], "App 停用后列表仍显示模型");
  assert.equal(f.modelService.resolveModel({ context: canvasCtx, capability: "chat" }).ok, false);
  enableApp();
  assert.ok(ids().includes(configId), "App 恢复后列表没有恢复");

  assert.equal(f.modelService.setModelStatus({ context: host, configId, status: "disabled" }).ok, true);
  assert.deepEqual(ids(), [], "模型停用后列表仍显示该模型");
  assert.equal(f.modelService.setModelStatus({ context: host, configId, status: "enabled" }).ok, true);

  assert.equal(f.modelService.setProviderStatus({ context: host, providerId, status: "disabled" }).ok, true);
  assert.deepEqual(ids(), [], "provider 停用后列表仍显示其模型");
  assert.equal(f.modelService.setProviderStatus({ context: host, providerId, status: "enabled" }).ok, true);
  assert.ok(ids().includes(configId), "provider 恢复后列表没有恢复");
});

test("L5 · 别人的 PERSONAL 配置不出现在我的可用清单里", () => {
  const aliceCtx = { ...f.ctx("alice"), appId: "settings" };
  const p = f.modelService.createProvider({ context: aliceCtx, displayName: "AlicePersonal", baseUrl: "http://127.0.0.1:9", scope: "PERSONAL", credentialSecret: "FAKE_D502_ALICE" });
  assert.equal(p.ok, true, JSON.stringify(p));
  const c = f.modelService.createModel({ context: aliceCtx, providerId: p.provider.providerId, remoteModelId: "alice-chat", displayName: "Alice Chat", capabilities: ["chat"], scope: "PERSONAL" });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(ids().includes(c.model.configId), false, "画布列表里出现了别人的 PERSONAL 模型");
  console.log("[L5] personal isolation →", JSON.stringify({ listed: ids().length, aliceConfig: c.model.configId }));
});
