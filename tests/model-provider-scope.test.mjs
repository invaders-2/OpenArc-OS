/**
 * D4-01 · provider/update 的 scope：权限、归属不变量、模型同步迁移、审计、镜像一致。
 *
 * 只读核对建立的事实：
 *   · model_providers / model_configs 都有 scope 与 owner_user_id；provider 另有 organization_id。
 *   · electron/model-service.cjs #authorize：ORGANIZATION 的 MANAGE 非 Super 拒；PERSONAL 非本人拒。
 *   · provider/protocol 出口（providers.json）**没有 scope / 可见性字段**，normalizeProvider 会把未知字段丢掉；
 *     可见性只由 ModelStore 的 #authorize 裁决，镜像只是传输描述符。
 *
 * 本用例锁死的行为：
 *   ① 非 Super 的任何范围变更 → PROXY_UNAUTHORIZED，库与审计零变化；
 *   ② 非法 scope → INVALID_INPUT，库零变化；
 *   ③ Super 改到 ORGANIZATION：scope 落库、owner_user_id 置空、其下模型一并迁移、写授权审计；
 *   ④ 改回 PERSONAL：owner_user_id 设为操作者、模型一并回到操作者，#authorize 语义仍成立；
 *   ⑤ 同值 scope 不算变更，非 Super 改自己个人服务商的其他字段仍可用；
 *   ⑥ model:command IPC 透传 scope；
 *   ⑦ providers.json 不携带范围/可见性字段（两库不产生互相矛盾的 scope）；
 *   ⑧ 镜像失败时范围与模型归属一起回滚，绝不半写。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createModelFixture } from "./model-fixtures.mjs";

const require = createRequire(import.meta.url);
const { registerModelIpc } = require("../electron/model-bootstrap.cjs");
const { createProviderProtocolBundle } = require("../electron/provider-protocol-service.cjs");
const { memoryCredentialBackend } = require("../electron/credential-store.cjs");
const { createModelProviderBridge, MIRROR_ERROR } = require("../electron/model-provider-bridge.cjs");
const domain = require("../electron/model-domain.cjs");

const SECRET = "sk-dxos-provider-scope-0000000000000001";

const f = await createModelFixture();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-provider-scope-"));
const bundle = createProviderProtocolBundle({ userDataDir: dir, backend: memoryCredentialBackend() });
f.modelService.providerProtocol = bundle;
const bridge = createModelProviderBridge({ modelStore: f.modelStore, credentialStore: f.credentialStore, providerProtocol: bundle, userDataDir: dir, clock: f.clock });
f.modelService.providerBridge = bridge;
bundle.service.setProviderIdResolver((providerId) => bridge.resolveProviderProtocolId(providerId));
after(() => { try { f.close(); } catch { /* ignore */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

f.store.upsertApp({ appId: "settings", name: "系统设置", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
f.modelService.grantAppModelAccess({ context: f.adminCtx(), appId: "settings", actions: ["model.view", "model.use", "model.manage", "model.test"] });

const admin = () => ({ ...f.adminCtx(), appId: "settings" });
const asAlice = () => ({ sessionRef: f.sessions.alice, appId: "settings", source: "ui" });
const LOCAL = "http://127.0.0.1:9/v1";

const auditRows = () => f.identity.connection.prepare("SELECT * FROM authorization_audit WHERE action = 'model.providerScopeChanged' ORDER BY id").all();
const ppEntries = () => bundle.store.load();
const ppFile = path.join(dir, "dxos", "providers.json");
const mapFile = path.join(dir, "dxos", "model-provider-map.json");

function makeProvider(context, scope = "PERSONAL", withModel = false) {
  const created = f.modelService.createProvider({ context, displayName: "范围-" + scope, baseUrl: LOCAL, scope, credentialSecret: SECRET });
  assert.equal(created.ok, true, JSON.stringify(created));
  const providerId = created.provider.providerId;
  let configId = null;
  if (withModel) {
    const model = f.modelService.createModel({ context, providerId, remoteModelId: "scope-model", capabilities: ["chat"], scope });
    assert.equal(model.ok, true, JSON.stringify(model));
    configId = model.model.configId;
  }
  return { providerId, configId };
}

test("SC1 · 非 Super 把个人服务商改成组织 → PROXY_UNAUTHORIZED，库/审计零变化", () => {
  const { providerId } = makeProvider(asAlice(), "PERSONAL");
  const before = f.modelStore.providerById(providerId);
  assert.equal(before.scope, "PERSONAL");
  assert.equal(before.owner_user_id, f.users.alice);
  const beforeAudits = auditRows().length;

  const res = f.modelService.updateProvider({ context: asAlice(), providerId, scope: "ORGANIZATION" });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, domain.ERROR_CODE.PROXY_UNAUTHORIZED);

  const after = f.modelStore.providerById(providerId);
  assert.equal(after.scope, "PERSONAL", "被拒后 scope 不得变化");
  assert.equal(after.owner_user_id, f.users.alice, "被拒后归属不得变化");
  assert.equal(auditRows().length, beforeAudits, "被拒不得写范围变更审计");
});

test("SC2 · 非法 scope → INVALID_INPUT，库零变化（Super 与非 Super 同一口径）", () => {
  const { providerId } = makeProvider(admin(), "PERSONAL");
  for (const bad of ["TEAM", "organization", "", 0]) {
    const res = f.modelService.updateProvider({ context: admin(), providerId, scope: bad });
    assert.equal(res.ok, false, JSON.stringify({ bad, res }));
    assert.equal(res.error, domain.ERROR_CODE.INVALID_INPUT, "非法 scope " + JSON.stringify(bad));
    assert.equal(res.detail, "invalid-scope");
  }
  const alice = makeProvider(asAlice(), "PERSONAL");
  const denied = f.modelService.updateProvider({ context: asAlice(), providerId: alice.providerId, scope: "NOPE" });
  assert.equal(denied.error, domain.ERROR_CODE.INVALID_INPUT);
  assert.equal(f.modelStore.providerById(providerId).scope, "PERSONAL");
  assert.equal(f.modelStore.providerById(alice.providerId).scope, "PERSONAL");
});

test("SC3 · Super 改到 ORGANIZATION：scope/organization_id/owner_user_id + 模型同步迁移 + 审计", () => {
  const { providerId, configId } = makeProvider(admin(), "PERSONAL", true);
  const orgBefore = f.modelStore.providerById(providerId).organization_id;
  const auditsBefore = auditRows().length;

  const res = f.modelService.updateProvider({ context: admin(), providerId, scope: "ORGANIZATION" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.provider.scope, "ORGANIZATION", "返回值必须如实反映新范围");

  const provider = f.modelStore.providerById(providerId);
  assert.equal(provider.scope, "ORGANIZATION");
  assert.equal(provider.organization_id, orgBefore, "organization_id 不变（组织归属不搬家）");
  assert.equal(provider.owner_user_id, null, "组织所有 → owner_user_id 置空");

  const config = f.modelStore.configById(configId);
  assert.equal(config.scope, "ORGANIZATION", "其下模型一并转为组织，绝不留半迁移组合");
  assert.equal(config.owner_user_id, null);

  const audits = auditRows();
  assert.equal(audits.length, auditsBefore + 1, "范围变更必须写一条授权审计");
  const row = audits[audits.length - 1];
  assert.equal(row.resource_ref, providerId, "审计记 providerId");
  assert.equal(row.actor_user_id, f.users.admin, "审计记操作者");
  assert.equal(row.decision, "ALLOW");
  assert.equal(row.permission_source, "SUPER_ADMIN");
  assert.deepEqual(JSON.parse(row.old_permissions), ["PERSONAL"]);
  assert.deepEqual(JSON.parse(row.new_permissions), ["ORGANIZATION"]);
});

test("SC4 · 改回 PERSONAL：owner 设为操作者、模型一并回到操作者，#authorize 语义仍成立", () => {
  const { providerId, configId } = makeProvider(admin(), "PERSONAL", true);
  assert.equal(f.modelService.updateProvider({ context: admin(), providerId, scope: "ORGANIZATION" }).ok, true);
  assert.equal(f.modelService.updateProvider({ context: admin(), providerId, scope: "PERSONAL" }).ok, true);

  const provider = f.modelStore.providerById(providerId);
  assert.equal(provider.scope, "PERSONAL");
  assert.equal(provider.owner_user_id, f.users.admin, "个人所有 → owner_user_id 为当前操作者");
  const config = f.modelStore.configById(configId);
  assert.equal(config.scope, "PERSONAL");
  assert.equal(config.owner_user_id, f.users.admin);

  // 个人配置非本人不可见/不可改（#authorize 既有语义）
  const list = f.modelService.listProviders({ context: asAlice() });
  assert.equal(list.items.some((p) => p.providerId === providerId), false, "非本人不得看到个人服务商");
  const denied = f.modelService.updateProvider({ context: asAlice(), providerId, displayName: "hijack" });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, domain.ERROR_CODE.PROXY_UNAUTHORIZED);
  assert.equal(f.modelStore.providerById(providerId).display_name, provider.display_name);
});

test("SC5 · 同值 scope 不算变更，非 Super 改自己个人服务商其他字段仍可用", () => {
  const { providerId } = makeProvider(asAlice(), "PERSONAL");
  const res = f.modelService.updateProvider({ context: asAlice(), providerId, displayName: "改名保留个人", scope: "PERSONAL" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.provider.scope, "PERSONAL");
  assert.equal(f.modelStore.providerById(providerId).display_name, "改名保留个人");
});

test("SC6 · model:command IPC 透传 scope（Super 成功 / 非 Super 被拒）", async () => {
  const identity = { current: f.sessions.admin };
  const ipc = { handlers: new Map(), handle(ch, fn) { this.handlers.set(ch, fn); }, removeHandler(ch) { this.handlers.delete(ch); } };
  registerModelIpc({ ipcMain: ipc, service: f.modelService, identity, isTrusted: () => true });
  const invoke = (cmd) => ipc.handlers.get("model:command")({}, cmd);
  const { providerId } = makeProvider(admin(), "PERSONAL");

  const okRes = await invoke({ command: "provider/update", payload: { providerId, scope: "ORGANIZATION" } });
  assert.equal(okRes.ok, true, JSON.stringify(okRes));
  assert.equal(okRes.provider.scope, "ORGANIZATION");

  const aliceRes = f.modelService.createProvider({ context: asAlice(), displayName: "本地个人", baseUrl: LOCAL, scope: "PERSONAL" });
  assert.equal(aliceRes.ok, true, JSON.stringify(aliceRes));
  identity.current = f.sessions.alice;
  const denied = await invoke({ command: "provider/update", payload: { providerId: aliceRes.provider.providerId, scope: "ORGANIZATION" } });
  assert.equal(denied.ok, false, JSON.stringify(denied));
  assert.equal(denied.error, "PROXY_UNAUTHORIZED");
  assert.equal(f.modelStore.providerById(aliceRes.provider.providerId).scope, "PERSONAL");
});

test("SC7 · 镜像一致：providers.json 不携带范围/可见性字段，scope 变更不改镜像出口口径", () => {
  const { providerId, configId } = makeProvider(admin(), "PERSONAL", true);
  const ppId = bridge.resolveProviderProtocolId(providerId);
  assert.ok(ppId, "创建后必须有显式映射");
  const beforeEntry = ppEntries().find((p) => p.id === ppId);
  assert.ok(beforeEntry, "providers.json 必须有镜像条目");
  for (const key of ["scope", "owner_user_id", "organization_id"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(beforeEntry, key), false, "镜像不得携带 " + key);
    assert.equal(Object.prototype.hasOwnProperty.call(beforeEntry, "ownerUserId"), false);
  }
  const rawBefore = fs.readFileSync(ppFile, "utf8");
  assert.equal(/\"(scope|owner_user_id|organization_id)\"\s*:/.test(rawBefore), false, "providers.json 磁盘上不得出现可见性字段");

  assert.equal(f.modelService.updateProvider({ context: admin(), providerId, scope: "ORGANIZATION" }).ok, true);
  const afterEntry = ppEntries().find((p) => p.id === ppId);
  assert.ok(afterEntry, "scope 变更后镜像条目仍在");
  assert.equal(afterEntry.enabled, true);
  assert.equal(bridge.resolveProviderProtocolId(providerId), ppId, "映射不变（改名/改范围不换 id）");
  assert.equal(JSON.parse(fs.readFileSync(mapFile, "utf8")).providers[providerId], ppId);
  assert.equal(JSON.stringify(afterEntry), JSON.stringify(beforeEntry), "镜像描述符与 scope 无关：变更前后逐字一致");
  assert.equal(afterEntry.models.map((m) => m.model).includes("scope-model"), true, "模型仍按其能力投影到镜像");
  assert.equal(f.modelStore.configById(configId).scope, "ORGANIZATION");
});

test("SC8 · 镜像失败时范围与模型归属一起回滚，绝不半写", () => {
  const { providerId, configId } = makeProvider(admin(), "PERSONAL", true);
  const originalPersist = bundle.store.persist;
  bundle.store.persist = () => { throw new Error("disk-full"); };
  try {
    const res = f.modelService.updateProvider({ context: admin(), providerId, scope: "ORGANIZATION" });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.error, MIRROR_ERROR);
    const provider = f.modelStore.providerById(providerId);
    assert.equal(provider.scope, "PERSONAL", "镜像失败必须回滚 provider scope");
    assert.equal(provider.owner_user_id, f.users.admin, "镜像失败必须回滚归属");
    const config = f.modelStore.configById(configId);
    assert.equal(config.scope, "PERSONAL", "镜像失败必须回滚模型 scope");
    assert.equal(config.owner_user_id, f.users.admin);
  } finally {
    bundle.store.persist = originalPersist;
  }
  // 恢复后仍可正常改范围
  const ok = f.modelService.updateProvider({ context: admin(), providerId, scope: "ORGANIZATION" });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(f.modelStore.providerById(providerId).scope, "ORGANIZATION");
});
