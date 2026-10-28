/**
 * 移除模型（model/delete ↔ ModelService.deleteModel）的离线单测。
 *
 * 锁死的行为：
 *   ① 成功：行真的没了、providers.json 的模型清单同步减掉、写 model.deleted 审计、
 *      canvas/models（画布唯一模型面）不再返回它；
 *   ② 镜像失败：整行按原字段原样插回（config_id / status / capabilities / verified_capabilities /
 *      version / created_at 都不变，既有默认模型不悬空），并如实返回 PROVIDER_MIRROR_FAILED；
 *   ③ 非管理员：删组织级模型 → PROXY_UNAUTHORIZED，行与审计零变化；App 没有 model.manage 同样拒；
 *   ④ IPC：model:command 白名单里有 model/delete，透传 configId；
 *   ⑤ 不存在的 configId 幂等 ok:true changed:false（前端重试不会报假错）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModelFixture } from "./model-fixtures.mjs";

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { registerModelIpc, MODEL_COMMANDS } = require("../electron/model-bootstrap.cjs");
const { createProviderProtocolBundle } = require("../electron/provider-protocol-service.cjs");
const { memoryCredentialBackend } = require("../electron/credential-store.cjs");
const { createModelProviderBridge, MIRROR_ERROR } = require("../electron/model-provider-bridge.cjs");
const domain = require("../electron/model-domain.cjs");

const SECRET = "sk-dxos-model-delete-0000000000001";
const LOCAL = "http://127.0.0.1:9/v1";

const f = await createModelFixture();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-model-delete-"));
const bundle = createProviderProtocolBundle({ userDataDir: dir, backend: memoryCredentialBackend() });
f.modelService.providerProtocol = bundle;
const bridge = createModelProviderBridge({ modelStore: f.modelStore, credentialStore: f.credentialStore, providerProtocol: bundle, userDataDir: dir, clock: f.clock });
f.modelService.providerBridge = bridge;
bundle.service.setProviderIdResolver((providerId) => bridge.resolveProviderProtocolId(providerId));
after(() => { try { f.close(); } catch { /* ignore */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

f.store.upsertApp({ appId: "settings", name: "系统设置", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
f.store.upsertApp({ appId: "canvas", name: "无限画布", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
f.modelService.grantAppModelAccess({ context: f.adminCtx(), appId: "settings", actions: ["model.view", "model.use", "model.manage", "model.test"] });
f.modelService.grantAppModelAccess({ context: f.adminCtx(), appId: "canvas", actions: ["model.view", "model.use"] });

const admin = () => ({ ...f.adminCtx(), appId: "settings" });
const asAlice = () => ({ sessionRef: f.sessions.alice, appId: "settings", source: "ui" });
const canvasCtx = () => ({ sessionRef: f.sessions.admin, appId: "canvas", source: "ui" });
const auditRows = () => f.identity.connection.prepare("SELECT * FROM authorization_audit WHERE action = 'model.deleted' ORDER BY id").all();
const mirroredModels = (providerId) => {
  const ppId = bridge.resolveProviderProtocolId(providerId);
  const entry = ppId ? bundle.store.load().find((p) => p.id === ppId) : null;
  return entry ? entry.models.map((m) => m.model) : null;
};

function makeProvider({ scope = "PERSONAL", context = admin(), models = [["del-model", ["chat"]]] } = {}) {
  const created = f.modelService.createProvider({ context, displayName: "删除-" + scope, baseUrl: LOCAL, scope, credentialSecret: SECRET });
  assert.equal(created.ok, true, JSON.stringify(created));
  const providerId = created.provider.providerId;
  const configIds = [];
  for (const [remoteModelId, capabilities] of models) {
    const m = f.modelService.createModel({ context, providerId, remoteModelId, displayName: remoteModelId, capabilities, scope });
    assert.equal(m.ok, true, JSON.stringify(m));
    configIds.push(m.model.configId);
  }
  return { providerId, configId: configIds[0], configIds };
}

test("D1 · 删除成功：行没了 + providers.json 同步 + 审计 + 画布模型面不再返回它", () => {
  const { providerId, configId, configIds } = makeProvider({ models: [["keep-model", ["chat"]], ["drop-model", ["chat"]]] });
  const dropId = configIds[1];
  assert.deepEqual(mirroredModels(providerId).sort(), ["drop-model", "keep-model"]);
  const canvasBefore = f.modelService.listModelsForUse({ context: canvasCtx() });
  assert.equal(canvasBefore.ok, true, JSON.stringify(canvasBefore));
  assert.ok(canvasBefore.models.some((m) => m.configId === dropId), "删除前画布能看到它");

  const auditsBefore = auditRows().length;
  const res = f.modelService.deleteModel({ context: admin(), configId: dropId });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.changed, true);
  assert.equal(res.configId, dropId);
  assert.equal(f.modelStore.configById(dropId), null, "行必须真的没了");
  assert.ok(f.modelStore.configById(configId), "同服务商的其它模型不受影响");
  assert.deepEqual(mirroredModels(providerId), ["keep-model"], "providers.json 的模型清单同步减掉");

  const audits = auditRows();
  assert.equal(audits.length, auditsBefore + 1, "必须写 model.deleted 审计");
  const audit = audits[audits.length - 1];
  assert.equal(audit.resource_ref, dropId);
  assert.equal(audit.decision, "ALLOW");
  assert.equal(JSON.parse(audit.old_permissions)[0], "drop-model");

  const canvasAfter = f.modelService.listModelsForUse({ context: canvasCtx() });
  assert.equal(canvasAfter.ok, true);
  assert.equal(canvasAfter.models.some((m) => m.configId === dropId), false, "删除后画布不再返回它（只显示已加入的）");
  assert.ok(canvasAfter.models.some((m) => m.configId === configId));

  // 幂等：再删一次不报错
  assert.deepEqual(f.modelService.deleteModel({ context: admin(), configId: dropId }), { ok: true, changed: false });
  assert.equal(auditRows().length, audits.length, "幂等删除不重复写审计");
});

test("D2 · 镜像失败：原行按原字段插回（config_id/status/能力/已验证/版本/创建时间不变），并如实回错", () => {
  const { providerId, configIds } = makeProvider({ models: [["keep-model", ["chat"]], ["rollback-model", ["chat", "tool-calling"]]] });
  const target = configIds[1];
  // 造一条"不是默认新建值"的行：停用 + 已验证能力 + 改名，回滚必须连这些一起保住
  f.modelStore.transactSync(() => f.modelStore.updateConfig(target, { displayName: "回滚模型", status: "disabled" }));
  f.modelStore.transactSync(() => f.modelStore.updateConfig(target, { verifiedCapabilities: ["chat"] }));
  const before = f.modelStore.configById(target);
  assert.equal(before.status, "disabled");
  assert.deepEqual(JSON.parse(before.verified_capabilities), ["chat"]);
  const auditsBefore = auditRows().length;

  const originalPersist = bundle.store.persist;
  bundle.store.persist = () => { throw new Error("disk-full"); };
  try {
    const res = f.modelService.deleteModel({ context: admin(), configId: target });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.error, MIRROR_ERROR);
  } finally {
    bundle.store.persist = originalPersist;
  }

  const restored = f.modelStore.configById(target);
  assert.ok(restored, "镜像失败必须把被删的行插回来");
  for (const key of ["config_id", "provider_id", "organization_id", "owner_user_id", "scope", "display_name", "remote_model_id", "capabilities", "verified_capabilities", "status", "version", "created_at", "updated_at"]) {
    assert.equal(restored[key], before[key], "回滚后 " + key + " 必须与删除前一致");
  }
  assert.deepEqual(mirroredModels(providerId).sort(), ["keep-model", "rollback-model"], "镜像里模型仍在（桥回滚成功）");
  assert.equal(auditRows().length, auditsBefore, "失败路径不得写删除审计");

  // 恢复后仍能正常删（说明没有留下半写状态）
  const ok = f.modelService.deleteModel({ context: admin(), configId: target });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(f.modelStore.configById(target), null);
});

test("D3 · 非管理员：删组织级模型被拒，行与审计零变化；App 无 model.manage 同样被拒", () => {
  const orgProvider = makeProvider({ scope: "ORGANIZATION", models: [["org-model", ["chat"]]] });
  const auditsBefore = auditRows().length;
  const denied = f.modelService.deleteModel({ context: asAlice(), configId: orgProvider.configId });
  assert.equal(denied.ok, false, JSON.stringify(denied));
  assert.equal(denied.error, domain.ERROR_CODE.PROXY_UNAUTHORIZED);
  assert.ok(f.modelStore.configById(orgProvider.configId), "被拒后模型必须还在");
  assert.equal(auditRows().length, auditsBefore, "被拒不得写审计");

  // 非本人的个人模型：alice 删 admin 的个人模型
  const personal = makeProvider({ scope: "PERSONAL", models: [["admin-personal", ["chat"]]] });
  const denied2 = f.modelService.deleteModel({ context: asAlice(), configId: personal.configId });
  assert.equal(denied2.error, domain.ERROR_CODE.PROXY_UNAUTHORIZED);
  assert.ok(f.modelStore.configById(personal.configId));

  // 没有 model.manage 授权的 App（canvas）不能删
  const denied3 = f.modelService.deleteModel({ context: canvasCtx(), configId: personal.configId });
  assert.equal(denied3.error, domain.ERROR_CODE.PROXY_UNAUTHORIZED);
  assert.ok(f.modelStore.configById(personal.configId));

  // Super Admin 删组织级模型成功
  const okOrg = f.modelService.deleteModel({ context: admin(), configId: orgProvider.configId });
  assert.equal(okOrg.ok, true, JSON.stringify(okOrg));
  assert.equal(f.modelStore.configById(orgProvider.configId), null);
});

test("D4 · IPC：model/delete 在白名单里并透传 configId（成功 / 不存在 / 缺参数）", async () => {
  assert.ok(MODEL_COMMANDS.includes("model/delete"), "MODEL_COMMANDS 必须登记 model/delete");
  const identity = { current: f.sessions.admin };
  const ipc = { handlers: new Map(), handle(ch, fn) { this.handlers.set(ch, fn); }, removeHandler(ch) { this.handlers.delete(ch); } };
  registerModelIpc({ ipcMain: ipc, service: f.modelService, identity, isTrusted: () => true });
  const invoke = (cmd) => ipc.handlers.get("model:command")({}, cmd);

  const { configId } = makeProvider({ models: [["ipc-model", ["chat"]]] });
  const ok = await invoke({ command: "model/delete", payload: { configId } });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(f.modelStore.configById(configId), null);

  const again = await invoke({ command: "model/delete", payload: { configId } });
  assert.deepEqual(again, { ok: true, changed: false }, "重复删同一个 configId 幂等");

  const missing = await invoke({ command: "model/delete", payload: {} });
  assert.deepEqual(missing, { ok: true, changed: false }, "缺 configId 不抛、不误删");
});

test("D5 · 删除默认模型不偷偷改默认：defaults 仍指向它，解析如实失败", () => {
  const { configId } = makeProvider({ models: [["default-model", ["chat"]]] });
  assert.equal(f.modelService.setDefault({ context: admin(), capability: "chat", configId, scope: "PERSONAL" }).ok, true);
  assert.equal(f.modelService.deleteModel({ context: admin(), configId }).ok, true);
  const defaults = f.modelService.getDefaults({ context: admin() });
  assert.equal(defaults.personal.chat, configId, "删除后默认仍指向旧 config（不静默换成别的模型）");
  assert.equal(f.modelService.resolveModel({ context: admin(), capability: "chat" }).error, domain.ERROR_CODE.MODEL_CONFIG_UNAVAILABLE);
});
