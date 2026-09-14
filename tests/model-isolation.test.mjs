/**
 * D4-01 Closure F · User B / Organization 模型边界（真实授权 + 真实 model:command IPC）。
 *
 * 关闭 Closure C 遗留的 "User B UI isolation = PARTIAL / NOT VERIFIED"：
 *   · User A 的 Personal Provider / Model / Default / Credential 对 User B 不可见、不可改、不可调用；
 *   · Organization Provider / Model 对授权用户可见安全 metadata，但不可见 credential / credentialRef / secret；
 *   · 普通用户对 Organization 的 mutation 一律 DENY；
 *   · settings 是真实 trusted App Principal（最小四权），不是借 resource-library 的权。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import { createModelFixture } from "./model-fixtures.mjs";
import { startFakeProvider } from "./model-fake-provider.mjs";

const require = createRequire(import.meta.url);
const { registerModelIpc, HOST_APP_ID, MODEL_COMMANDS } = require("../electron/model-bootstrap.cjs");

const SECRET = "FAKE_PROVIDER_SECRET_D401_ISO_" + crypto.randomBytes(8).toString("hex");
const providers = [];
const f = await createModelFixture({ timeoutMs: 3000 });
after(async () => { for (const p of providers) { try { await p.close(); } catch { /* ignore */ } } f.close(); });

const admin = f.adminCtx();
f.store.upsertApp({ appId: "settings", name: "系统设置", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
f.modelService.grantAppModelAccess({ context: admin, appId: "settings", actions: ["model.view", "model.use", "model.manage", "model.test"] });

const identity = { current: admin.sessionRef };
const ipc = { handlers: new Map(), handle(ch, fn) { this.handlers.set(ch, fn); }, removeHandler(ch) { this.handlers.delete(ch); } };
registerModelIpc({ ipcMain: ipc, service: f.modelService, identity, isTrusted: () => true });
const invoke = (cmd) => ipc.handlers.get("model:command")({}, cmd);
const asA = () => { identity.current = admin.sessionRef; };
const asB = () => { identity.current = f.sessions.alice; };

let personalProviderId = null; let personalConfigId = null; let orgProviderId = null; let orgConfigId = null;

test("ISO1 · User A 建立 Personal + Organization Provider/Model/Default", async () => {
  asA();
  const fp = await startFakeProvider({ behavior: "success", secretEcho: SECRET });
  providers.push(fp);
  const p = await invoke({ command: "provider/create", payload: { displayName: "A Private", baseUrl: fp.baseUrl, credentialSecret: SECRET } });
  assert.equal(p.ok, true, JSON.stringify(p));
  personalProviderId = p.provider.providerId;
  const m = await invoke({ command: "model/create", payload: { providerId: personalProviderId, remoteModelId: "fake-1", displayName: "A Private Model", capabilities: ["chat"] } });
  assert.equal(m.ok, true);
  personalConfigId = m.model.configId;
  await invoke({ command: "defaults/set", payload: { capability: "chat", configId: personalConfigId, scope: "PERSONAL" } });

  const op = await invoke({ command: "provider/create", payload: { displayName: "Org Shared", baseUrl: fp.baseUrl, scope: "ORGANIZATION", credentialSecret: SECRET } });
  assert.equal(op.ok, true, JSON.stringify(op));
  orgProviderId = op.provider.providerId;
  const om = await invoke({ command: "model/create", payload: { providerId: orgProviderId, remoteModelId: "fake-org", displayName: "Org Shared Model", capabilities: ["chat"], scope: "ORGANIZATION" } });
  assert.equal(om.ok, true);
  orgConfigId = om.model.configId;
  const od = await invoke({ command: "defaults/set", payload: { capability: "chat", configId: orgConfigId, scope: "ORGANIZATION" } });
  assert.equal(od.ok, true, JSON.stringify(od));
});

test("ISO2 · User B provider/list 看不到 A 的 private，只看到 Organization 安全 metadata", async () => {
  asB();
  const list = await invoke({ command: "provider/list" });
  assert.equal(list.ok, true, JSON.stringify(list));
  const ids = list.items.map((p) => p.providerId);
  assert.equal(ids.includes(personalProviderId), false, "B 不得看到 A 的 private provider");
  assert.ok(ids.includes(orgProviderId), "B 应看到 Organization provider");
  const org = list.items.find((p) => p.providerId === orgProviderId);
  assert.equal("credentialRef" in org || "credential_ref" in org, false, "org provider 不得暴露 credentialRef");
  assert.equal(JSON.stringify(org).includes(SECRET), false);
  assert.equal(JSON.stringify(org).includes("cred_"), false);
  // 允许的安全 metadata
  for (const k of ["displayName", "baseUrl", "endpointScope", "scope", "status"]) assert.ok(k in org, k);
});

test("ISO3 · User B model/list 看不到 A 的 private，只看到 Organization 安全 metadata", async () => {
  asB();
  const list = await invoke({ command: "model/list" });
  assert.equal(list.ok, true);
  const ids = list.items.map((m) => m.configId);
  assert.equal(ids.includes(personalConfigId), false);
  assert.ok(ids.includes(orgConfigId));
  const org = list.items.find((m) => m.configId === orgConfigId);
  assert.deepEqual(org.capabilities, ["chat"]);
  assert.equal("credentialRef" in org || "credential_ref" in org, false);
  assert.equal(JSON.stringify(list).includes(SECRET), false);
});

test("ISO4 · User B 不能修改/删除/调用 A 的 private 资源", async () => {
  asB();
  const upd = await invoke({ command: "model/update", payload: { configId: personalConfigId, displayName: "hijack" } });
  assert.equal(upd.ok, false, JSON.stringify(upd));
  const st = await invoke({ command: "model/setStatus", payload: { configId: personalConfigId, status: "disabled" } });
  assert.equal(st.ok, false, JSON.stringify(st));
  const tst = await invoke({ command: "model/test", payload: { configId: personalConfigId } });
  assert.equal(tst.ok, false, JSON.stringify(tst));
  const rep = await invoke({ command: "credential/replace", payload: { providerId: personalProviderId, secret: "FAKE_PROVIDER_SECRET_D401_ISO_HIJACK" } });
  assert.equal(rep.ok, false, JSON.stringify(rep));
  const del = await invoke({ command: "credential/delete", payload: { providerId: personalProviderId } });
  assert.equal(del.ok, false, JSON.stringify(del));
  const pupd = await invoke({ command: "provider/update", payload: { providerId: personalProviderId, displayName: "hijack" } });
  assert.equal(pupd.ok, false, JSON.stringify(pupd));
  // A 的资源未被改动
  assert.equal(f.modelStore.configById(personalConfigId).display_name, "A Private Model");
  assert.equal(f.modelStore.credentialByRef(f.modelStore.providerById(personalProviderId).credential_ref).status, "CONFIGURED");
});

test("ISO5 · User B 查询 A 的 private credential status 不泄漏 secure backend metadata", async () => {
  asB();
  const status = await invoke({ command: "credential/status", payload: { providerId: personalProviderId } });
  assert.equal(JSON.stringify(status).includes(SECRET), false);
  assert.equal(status.configured === true, false, "不得暴露 A 的 credential 已配置状态: " + JSON.stringify(status));
  assert.equal(status.credentialVersion == null, true, "不得暴露 A 的 credential version: " + JSON.stringify(status));
  assert.equal(status.manageable === false, true, "manageable 必须为 false: " + JSON.stringify(status));
});

test("ISO6 · User B 查询 Organization credential status 不泄漏 secure backend metadata", async () => {
  asB();
  const status = await invoke({ command: "credential/status", payload: { providerId: orgProviderId } });
  assert.equal(status.manageable === false, true, "普通用户对 org 不可 manage: " + JSON.stringify(status));
  assert.equal(status.credentialVersion == null, true, JSON.stringify(status));
  assert.equal(JSON.stringify(status).includes(SECRET), false);
});

test("ISO7 · User B 对 Organization mutation 一律 DENY", async () => {
  asB();
  const u = await invoke({ command: "provider/update", payload: { providerId: orgProviderId, displayName: "hijack-org" } });
  assert.equal(u.ok, false, JSON.stringify(u));
  const cd = await invoke({ command: "credential/delete", payload: { providerId: orgProviderId } });
  assert.equal(cd.ok, false, JSON.stringify(cd));
  const d = await invoke({ command: "defaults/set", payload: { capability: "chat", configId: orgConfigId, scope: "ORGANIZATION" } });
  assert.equal(d.ok, false, JSON.stringify(d));
  const ms = await invoke({ command: "model/setStatus", payload: { configId: orgConfigId, status: "disabled" } });
  assert.equal(ms.ok, false, JSON.stringify(ms));
  assert.equal(f.modelStore.providerById(orgProviderId).display_name, "Org Shared");
  assert.equal(f.modelStore.configById(orgConfigId).status, "enabled");
});

test("ISO8 · User B defaults/get 看不到 A 的 Personal default，但能看到 Organization default", async () => {
  asB();
  const d = await invoke({ command: "defaults/get" });
  assert.equal(d.ok, true);
  assert.equal(d.personal.chat, undefined, "B 不得继承 A 的 personal default: " + JSON.stringify(d.personal));
  assert.equal(d.organization.chat, orgConfigId);
  assert.equal(d.canManageOrganization, false);
});

test("ISO9 · User B 全部响应无 raw secret / credentialRef / Authorization", async () => {
  asB();
  const responses = [];
  for (const command of ["provider/list", "model/list", "defaults/get"]) responses.push(await invoke({ command }));
  responses.push(await invoke({ command: "credential/status", payload: { providerId: personalProviderId } }));
  responses.push(await invoke({ command: "credential/status", payload: { providerId: orgProviderId } }));
  const blob = JSON.stringify(responses);
  assert.equal(blob.includes(SECRET), false);
  assert.equal(blob.includes("cred_"), false);
  assert.equal(/Bearer\s/.test(blob), false);
});

test("ISO10 · settings 是真实 trusted App Principal（最小四权），不是借权", async () => {
  assert.equal(HOST_APP_ID, "settings");
  const grants = f.store.appGrantsForApp("settings").filter((g) => g.resource_type === "model");
  assert.equal(grants.length, 1);
  const raw = grants[0].actions;
  const actions = Array.isArray(raw) ? raw : JSON.parse(raw || "[]");
  assert.deepEqual([...actions].sort(), ["model.manage", "model.test", "model.use", "model.view"].sort());
  // 伪造 payload.appId=canvas 不改变 host app，也不提权；canvas 自身无 model grant → DENY
  asB();
  const forged = await invoke({ command: "provider/list", payload: { appId: "canvas", userId: admin.userId, role: "ADMIN" } });
  assert.equal(forged.ok, true, "host 仍是 settings");
  const canvasCreate = f.modelService.createProvider({ context: { sessionRef: f.sessions.alice, appId: "canvas" }, displayName: "x", baseUrl: "http://127.0.0.1:9", credentialSecret: SECRET });
  assert.equal(canvasCreate.ok, false, JSON.stringify(canvasCreate));
  // 白名单仍无 credential 读取 / proxy 能力
  assert.equal(MODEL_COMMANDS.some((c) => /secret|raw|token|proxy/i.test(c)), false);
});
