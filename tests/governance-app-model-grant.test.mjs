/**
 * D5-02 D1 · 画布 App 的 model.use 授予：投影 → 撤销真实生效 → 重新授予恢复。
 *
 * 复现 experiments/d5-02/canvas-e2e.mjs 第 267-278 行的授权链：
 *   model-bootstrap seed（canvas baseline）→ governance/getAppAccess 拿到含 model.use 的 grantId
 *   → governance/revokeAppAccess → 画布身份的模型调用 PROXY_UNAUTHORIZED
 *   → governance/grantAppAccess 重新授予 → 放行。
 *
 * 生产调用点是 CanvasService.startRun（electron/canvas-service.cjs:346）：它用 appId=canvas
 * 调 ModelService.resolveModel，并把 PROXY_UNAUTHORIZED 原样交给 canvas/run 调用方。
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
const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d5-02-model-seed-"));
after(() => {
  f.close();
  try { fs.rmSync(seedDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const admin = f.adminCtx();
const alice = f.ctx("alice");
/** settings 是 Model 面的宿主 App（最小四权），provisioning 走它，与 model-bootstrap 一致。 */
const host = { sessionRef: admin.sessionRef, appId: "settings", source: "ui" };
const canvasCtx = { sessionRef: admin.sessionRef, appId: "canvas", source: "ui" };

// 生产 seed 路径：createModelBundle 装配时按组织写入内置 App 的 model baseline（含 canvas）。
createModelBundle({ identityStore: f.identity, authorization: f.authService, authStore: f.store, userDataDir: seedDir, clock: f.clock });

// 画布生成要先有一个可解析的默认模型（provider → config → ORGANIZATION default）。
const provider = f.modelService.createProvider({ context: host, displayName: "CanvasSeedProbe", baseUrl: "http://127.0.0.1:9", scope: "ORGANIZATION", credentialSecret: "FAKE_D502_CANVAS_SEED" });
assert.equal(provider.ok, true, JSON.stringify(provider));
const config = f.modelService.createModel({ context: host, providerId: provider.provider.providerId, remoteModelId: "canvas-chat", capabilities: ["chat"], scope: "ORGANIZATION" });
assert.equal(config.ok, true, JSON.stringify(config));
assert.equal(f.modelService.setDefault({ context: host, capability: "chat", configId: config.model.configId, scope: "ORGANIZATION" }).ok, true);

// 画布还要有一条资源命名空间的授予，用来证明两种 namespace 在同一投影里互不串味。
const text = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "D502CanvasSeed", content: "d5-02" });
assert.equal(text.ok, true, JSON.stringify(text));
const textResourceId = text.resource.resourceId;
assert.equal(f.governanceService.grantAppAccess({ context: admin, appId: "canvas", resourceId: textResourceId, actions: ["resource.read", "resource.view"] }).ok, true);

/** 与 CanvasService.startRun 同一条授权调用。 */
const canvasResolve = () => f.modelService.resolveModel({ context: canvasCtx, capability: "chat" });
const modelGrantOf = (view) => view.grants.find((g) => g.resourceType === "model" && Array.isArray(g.actions) && g.actions.includes("model.use")) || null;
const otherAppGrants = () => Object.fromEntries(["ai", "browser", "resource-library", "image-generator"].map((appId) => [appId, f.store.appGrantsForApp(appId).length]));
let modelGrantId = null;

test("D1-a · getAppAccess 如实列出画布 App 真实持有的 model.use 授予句柄", () => {
  const view = f.governanceService.getAppAccess({ context: admin, appId: "canvas" });
  assert.equal(view.ok, true, JSON.stringify(view));
  const grant = modelGrantOf(view);
  assert.ok(grant, "画布缺少含 model.use 的授予：" + JSON.stringify(view.grants));
  assert.deepEqual([...grant.actions].sort(), ["model.use", "model.view"]);
  assert.equal(grant.grantId, f.store.appGrantsForApp("canvas").find((g) => g.resource_type === "model").id);
  // 同一个投影里 resource 授予仍按原样列出，且两个 namespace 不互相污染
  const resourceGrant = view.grants.find((g) => g.resourceId === textResourceId);
  assert.ok(resourceGrant, JSON.stringify(view.grants));
  assert.deepEqual([...resourceGrant.actions].sort(), ["resource.read", "resource.view"]);
  modelGrantId = grant.grantId;
  console.log("[D1-a] getAppAccess(canvas).grants =", JSON.stringify(view.grants.map((g) => ({ grantId: g.grantId, resourceType: g.resourceType, actions: g.actions }))));
});

test("D1-b · 用该 grantId 撤销后，画布模型调用被拒且撤销是真删不是空操作", () => {
  assert.ok(modelGrantId, "D1-a 未拿到 model.use 的 grantId");
  assert.equal(canvasResolve().ok, true, "撤销前画布应被放行");
  const othersBefore = otherAppGrants();
  const rev = f.governanceService.revokeAppAccess({ context: admin, grantId: modelGrantId });
  assert.equal(rev.ok, true, JSON.stringify(rev));
  assert.equal(rev.changed, true);
  assert.equal(f.store.appGrantById(modelGrantId), null, "撤销后 DB 里仍存在该 grant");
  assert.deepEqual(otherAppGrants(), othersBefore, "撤销波及了无关 App 的授予");
  const denied = canvasResolve();
  assert.equal(denied.ok, false, JSON.stringify(denied));
  assert.equal(denied.error, "PROXY_UNAUTHORIZED");
  // 同表上的 resource 授予不受影响：撤的只是 model 句柄
  const still = f.governanceService.getAppAccess({ context: admin, appId: "canvas" });
  assert.ok(still.grants.some((g) => g.grantId && g.resourceId === textResourceId));
  assert.equal(modelGrantOf(still), null);
  console.log("[D1-b] revoke", JSON.stringify({ grantId: modelGrantId, ok: rev.ok, changed: rev.changed, rowAfter: f.store.appGrantById(modelGrantId) }), "→ resolveModel", JSON.stringify(denied));
});

test("D1-c · 重新授予 model 权限后画布恢复；恢复的是真授权（可再次撤销生效）", () => {
  const othersBefore = otherAppGrants();
  const reg = f.governanceService.grantAppAccess({ context: admin, appId: "canvas", resourceType: "model", scope: "ORGANIZATION", actions: ["model.view", "model.use"] });
  assert.equal(reg.ok, true, JSON.stringify(reg));
  assert.deepEqual(otherAppGrants(), othersBefore, "重新授予给无关 App 多写了 grant");
  const restored = canvasResolve();
  assert.equal(restored.ok, true, JSON.stringify(restored));
  console.log("[D1-c] re-grant", JSON.stringify({ ok: reg.ok, grantId: reg.grant.id, actions: reg.grant.actions }), "→ resolveModel", JSON.stringify({ ok: restored.ok, modelConfigId: restored.snapshot && restored.snapshot.modelConfigId }));
  const view = f.governanceService.getAppAccess({ context: admin, appId: "canvas" });
  const again = modelGrantOf(view);
  assert.ok(again, "重新授予后投影里仍看不到 model.use：" + JSON.stringify(view.grants));
  assert.equal(f.governanceService.revokeAppAccess({ context: admin, grantId: again.grantId }).ok, true);
  assert.equal(canvasResolve().error, "PROXY_UNAUTHORIZED");
  console.log("[D1-c] 再次撤销同一句柄 → resolveModel PROXY_UNAUTHORIZED（恢复的是真授权）");
});

test("D1-d · namespace 不串门：model 动作写不进 resource 授予，resource/tool 动作也写不进 model 授予", () => {
  const asResource = f.governanceService.grantAppAccess({ context: admin, appId: "canvas", resourceId: textResourceId, actions: ["model.use"] });
  assert.equal(asResource.ok, false);
  assert.equal(asResource.error, "INVALID_INPUT");
  const asModel = f.governanceService.grantAppAccess({ context: admin, appId: "canvas", resourceType: "model", actions: ["resource.read"] });
  assert.equal(asModel.ok, false);
  assert.equal(asModel.error, "INVALID_INPUT");
  const asModelTool = f.governanceService.grantAppAccess({ context: admin, appId: "canvas", resourceType: "model", actions: ["tool.resource.search"] });
  assert.equal(asModelTool.ok, false);
  assert.equal(asModelTool.error, "INVALID_INPUT");
  const asModelMixed = f.governanceService.grantAppAccess({ context: admin, appId: "canvas", resourceType: "model", actions: ["model.use", "resource.read"] });
  assert.equal(asModelMixed.ok, false);
  // 普通成员不能经 model namespace 授予任何 App
  const member = f.governanceService.grantAppAccess({ context: alice, appId: "canvas", resourceType: "model", actions: ["model.use"] });
  assert.equal(member.ok, false);
});
