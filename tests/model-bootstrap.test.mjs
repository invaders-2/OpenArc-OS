/** D4-01 Closure A · model:command IPC 边界（白名单 / 可信身份 / write-only / 安全投影）。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createModelFixture } from "./model-fixtures.mjs";
const require = createRequire(import.meta.url);
const { registerModelIpc, disposeModelIpc, MODEL_COMMANDS, MODEL_COMMAND_NOT_ALLOWED } = require("../electron/model-bootstrap.cjs");

const f = await createModelFixture();
after(() => f.close());
const admin = f.adminCtx();
f.store.upsertApp({ appId: "settings", name: "系统设置", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
f.modelService.grantAppModelAccess({ context: admin, appId: "settings", actions: ["model.view", "model.use", "model.manage", "model.test"] });

function makeIpc() {
  const handlers = new Map();
  return { handlers, handle: (ch, fn) => { if (handlers.has(ch)) throw new Error("duplicate handler " + ch); handlers.set(ch, fn); }, removeHandler: (ch) => handlers.delete(ch) };
}
const ipc = makeIpc();
registerModelIpc({ ipcMain: ipc, service: f.modelService, identity: { current: admin.sessionRef }, isTrusted: () => true });
const invoke = (cmd) => ipc.handlers.get("model:command")({}, cmd);

test("A1 · model:command 单一通道 + 显式白名单", () => {
  assert.equal(typeof ipc.handlers.get("model:command"), "function");
  assert.ok(MODEL_COMMANDS.includes("provider/create"));
  assert.ok(!MODEL_COMMANDS.includes("credential/getRaw"));
  assert.ok(!MODEL_COMMANDS.includes("proxy/createCapability"));
});

test("A2 · 未知 / 攻击命令 DENY", async () => {
  for (const c of ["__proto__", "constructor", "credential/getRaw", "proxy/createCapability", "provider/rawFetch", "model/rawSql", "keychain/read", "rawFetch"]) {
    const r = await invoke({ command: c });
    assert.equal(r.ok, false, c);
    assert.equal(r.error, MODEL_COMMAND_NOT_ALLOWED, c);
  }
});

test("A3 · provider/create 走 Domain 校验；安全投影无 secret/credentialRef", async () => {
  const bad = await invoke({ command: "provider/create", payload: { displayName: "bad", baseUrl: "file:///etc/passwd", credentialSecret: "FAKE_MODEL_IPC_SECRET_D401_1" } });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "ENDPOINT_BLOCKED");
  const good = await invoke({ command: "provider/create", payload: { displayName: "IPC", baseUrl: "http://127.0.0.1:9", credentialSecret: "FAKE_MODEL_IPC_SECRET_D401_1" } });
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.equal(JSON.stringify(good).includes("FAKE_MODEL_IPC_SECRET_D401_1"), false);
  assert.equal(JSON.stringify(good).includes("cred_ref"), false);
  const list = await invoke({ command: "provider/list" });
  assert.equal(list.ok, true);
  const item = list.items.find((p) => p.providerId === good.provider.providerId);
  assert.ok(item);
  assert.equal(item.credentialConfigured, true);
  assert.equal("credential_ref" in item, false);
});

test("A4 · credential write-only：set/replace/delete 不回显 secret，DB 不含 raw", async () => {
  const p = await invoke({ command: "provider/create", payload: { displayName: "CredIPC", baseUrl: "http://127.0.0.1:9", credentialSecret: "FAKE_MODEL_IPC_SECRET_D401_2" } });
  const pid = p.provider.providerId;
  const set = await invoke({ command: "credential/set", payload: { providerId: pid, secret: "FAKE_MODEL_IPC_SECRET_D401_3" } });
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(JSON.stringify(set).includes("FAKE_MODEL_IPC_SECRET_D401_3"), false);
  assert.equal(set.credentialVersion, 1);
  const rep = await invoke({ command: "credential/replace", payload: { providerId: pid, secret: "FAKE_MODEL_IPC_SECRET_D401_4" } });
  assert.equal(rep.ok, true);
  assert.equal(rep.credentialVersion, 2);
  assert.equal(JSON.stringify(rep).includes("FAKE_MODEL_IPC_SECRET_D401_4"), false);
  const status = await invoke({ command: "credential/status", payload: { providerId: pid } });
  assert.equal(status.configured, true);
  assert.equal(JSON.stringify(status).includes("FAKE_MODEL_IPC_SECRET_D401"), false);
  assert.equal("credentialRef" in status || "credential_ref" in status, false);
  const dump = JSON.stringify(f.modelStore.providersOfOrg(f.orgId)) + JSON.stringify(f.modelStore.recentCalls(10));
  assert.equal(dump.includes("FAKE_MODEL_IPC_SECRET_D401"), false);
  const del = await invoke({ command: "credential/delete", payload: { providerId: pid } });
  assert.equal(del.ok, true);
  assert.equal(del.configured, false);
});

test("A5 · actor/app 伪造被忽略 + Confused Deputy（host app = settings）", async () => {
  // Renderer 伪造 appId=canvas / userId=admin / role=ADMIN：host 仍是 resource-library，命令正常
  const r = await invoke({ command: "provider/list", payload: { userId: "admin", appId: "canvas", role: "ADMIN" } });
  assert.equal(r.ok, true);
  // canvas 自身没有 model.manage App Grant，但伪造也不改变 host app
  const created = await invoke({ command: "provider/create", payload: { displayName: "Spoof", baseUrl: "http://127.0.0.1:9", appId: "canvas", credentialSecret: "FAKE_MODEL_IPC_SECRET_D401_5" } });
  assert.equal(created.ok, true);
  // Confused Deputy：真实 host=settings 无 manage 时，payload.appId=resource-library 也不能提权
  const settingsGrant = f.store.appGrantsForApp("settings").find((g) => g.resource_type === "model");
  f.authService.revokeAppResourcePermission ? null : null;
  f.modelService.revokeAppModelAccess({ context: admin, grantId: settingsGrant.id });
  const denied = await invoke({ command: "provider/create", payload: { displayName: "Deputy", baseUrl: "http://127.0.0.1:9", appId: "resource-library", credentialSecret: "FAKE_MODEL_IPC_SECRET_D401_5" } });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "PROXY_UNAUTHORIZED");
  f.modelService.grantAppModelAccess({ context: admin, appId: "settings", actions: ["model.view", "model.use", "model.manage", "model.test"] });
});

test("A6 · model safe projection：declared/verified/version，无内部 secret", async () => {
  const p = await invoke({ command: "provider/create", payload: { displayName: "ModelIPC", baseUrl: "http://127.0.0.1:9", credentialSecret: "FAKE_MODEL_IPC_SECRET_D401_6" } });
  const m = await invoke({ command: "model/create", payload: { providerId: p.provider.providerId, remoteModelId: "fake-1", displayName: "F", capabilities: ["chat", "tool-calling"] } });
  assert.equal(m.ok, true, JSON.stringify(m));
  assert.deepEqual(m.model.capabilities, ["chat", "tool-calling"]);
  assert.deepEqual(m.model.verifiedCapabilities, []);
  assert.equal(m.model.version, 1);
  assert.equal(JSON.stringify(m).includes("cred_"), false);
});

test("A7 · defaults/get + set；Proxy 命令不可达", async () => {
  const d = await invoke({ command: "defaults/get" });
  assert.equal(d.ok, true);
  assert.equal("personal" in d, true);
  assert.equal("organization" in d, true);
  for (const c of ["proxy/start", "proxy/createCapability", "proxy/getToken"]) {
    assert.equal((await invoke({ command: c })).error, MODEL_COMMAND_NOT_ALLOWED);
  }
});

test("A8 · dispose / 重复注册：无 duplicate handler", () => {
  disposeModelIpc({ ipcMain: ipc });
  assert.equal(ipc.handlers.has("model:command"), false);
  registerModelIpc({ ipcMain: ipc, service: f.modelService, identity: { current: admin.sessionRef }, isTrusted: () => true });
  registerModelIpc({ ipcMain: ipc, service: f.modelService, identity: { current: admin.sessionRef }, isTrusted: () => true });
  assert.equal(typeof ipc.handlers.get("model:command"), "function");
});

test("A9 · 安全错误投影：非法输入 / 不可信 sender", async () => {
  assert.equal((await invoke({ command: "provider/create", payload: { displayName: "x", baseUrl: "" } })).error, "INVALID_INPUT");
  const ipc2 = makeIpc();
  registerModelIpc({ ipcMain: ipc2, service: f.modelService, identity: { current: null }, isTrusted: () => false });
  await assert.rejects(() => ipc2.handlers.get("model:command")({}, { command: "provider/list" }), /Forbidden/);
});
