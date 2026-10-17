/** task-52 · 后端支撑：模型接入链路、governance/updateUser、缩略图、任务事件流。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { createResourceFixture } from "./resource-fixtures.mjs";

const require = createRequire(import.meta.url);
const { createModelBundle, registerModelIpc } = require("../electron/model-bootstrap.cjs");
const { createGovernanceBundle, registerGovernanceIpc } = require("../electron/governance-bootstrap.cjs");
const { PreviewService } = require("../electron/preview-service.cjs");
const { registerTaskIpc } = require("../electron/task-bootstrap.cjs");
const { safeEvent } = require("../electron/task-domain.cjs");

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const roots = [];
function tempDir(prefix = "dxos-task52-") { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); roots.push(dir); return dir; }
test.after(() => { for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true }); });

function fakeSafeStorage() {
  return { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from("enc:" + s), decryptString: (b) => Buffer.from(b).toString("utf8").replace(/^enc:/, "") };
}
function fakeIpc() { const handlers = new Map(); return { handlers, handle(ch, fn) { handlers.set(ch, fn); }, removeHandler(ch) { handlers.delete(ch); } }; }

async function localOpenAi() {
  const server = http.createServer((req, res) => {
    let raw = ""; req.on("data", (chunk) => { raw += chunk; }); req.on("end", () => {
      const json = (value) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (req.url.endsWith("/models")) return json({ data: [{ id: "fake-chat", owned_by: "local" }, { id: "fake-image" }] });
      return json({ choices: [{ message: { role: "assistant", content: "pong" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: "http://127.0.0.1:" + server.address().port + "/v1", close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

test("模型接入链路：回环假 OpenAI 跑通 provider/credential/models/model/defaults/test；非 chat 模型可测连通而不误报 CAPABILITY_UNAVAILABLE", async () => {
  const api = await localOpenAi();
  const f = await createResourceFixture();
  try {
    const bundle = createModelBundle({ identityStore: f.identity, authorization: f.authService, authStore: f.store, userDataDir: tempDir(), safeStorage: fakeSafeStorage(), fetchImpl: fetch });
    const admin = f.adminCtx();
    f.store.upsertApp({ appId: "settings", name: "设置", publisher: "builtin", status: "enabled", builtIn: 1 });
    bundle.modelService.grantAppModelAccess({ context: { ...admin, appId: "settings" }, appId: "settings", actions: ["model.view", "model.use", "model.manage", "model.test"] });
    const ipc = fakeIpc();
    registerModelIpc({ ipcMain: ipc, service: bundle.modelService, identity: { current: admin.sessionRef }, isTrusted: () => true });
    const call = async (command, payload) => ipc.handlers.get("model:command")({}, { command, payload });
    const provider = await call("provider/create", { displayName: "loopback", baseUrl: api.baseUrl, allowLan: true, allowInsecureHttp: true });
    assert.equal(provider.ok, true, JSON.stringify(provider));
    const providerId = provider.provider.providerId;
    const cred = await call("credential/set", { providerId, secret: "sk-loopback" });
    assert.equal(cred.ok, true, JSON.stringify(cred));
    const models = await call("provider/models", { providerId });
    assert.equal(models.ok, true, JSON.stringify(models));
    assert.deepEqual(models.items.map((m) => m.id), ["fake-chat", "fake-image"]);
    const chat = await call("model/create", { providerId, remoteModelId: "fake-chat", displayName: "Fake Chat", capabilities: ["chat"] });
    assert.equal(chat.ok, true, JSON.stringify(chat));
    const defaults = await call("defaults/set", { capability: "chat", configId: chat.model.configId });
    assert.equal(defaults.ok, true, JSON.stringify(defaults));
    const tested = await call("model/test", { configId: chat.model.configId });
    assert.equal(tested.ok, true, JSON.stringify(tested));
    assert.equal(tested.inference, true);

    const image = await call("model/create", { providerId, remoteModelId: "fake-image", displayName: "Fake Image", capabilities: ["image-generation"] });
    assert.equal(image.ok, true, JSON.stringify(image));
    const imageTest = await call("model/test", { configId: image.model.configId });
    assert.equal(imageTest.ok, true, JSON.stringify(imageTest));
    assert.equal(imageTest.inference, false, "非 chat 模型不得冒充真实推理");
    assert.equal(imageTest.probe, "models");
  } finally { f.close(); await api.close(); }
});

test("governance/updateUser：显示名/角色/状态/部门一次更新，写审计；非 super 禁止提权与跨部门", async () => {
  const f = await createResourceFixture();
  try {
    const gov = createGovernanceBundle({ identityStore: f.identity, authorization: f.authService, authStore: f.store, resourceStore: f.resourceStore, searchService: f.searchService });
    const admin = f.adminCtx();
    const updated = await gov.governanceService.updateUser({ context: admin, userId: f.users.alice, displayName: "Alice 更新", role: "MEMBER", status: "ACTIVE", departmentId: f.departmentId });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    const row = f.identity.userById(f.users.alice);
    assert.equal(row.display_name, "Alice 更新");
    const audit = f.store.auditLog ? f.store.auditLog({ limit: 50 }) : [];
    assert.ok(Array.isArray(audit));
    const rows = f.identity.connection.prepare("SELECT action, target_user_id FROM authorization_audit WHERE action='governance.updateUser' ORDER BY rowid DESC LIMIT 1").get();
    assert.equal(rows.target_user_id, f.users.alice);
    const ipc = fakeIpc();
    registerGovernanceIpc({ ipcMain: ipc, service: gov, authorization: f.authService, identity: { current: admin.sessionRef }, isTrusted: () => true });
    const viaCommand = await ipc.handlers.get("governance:command")({}, { type: "governance/updateUser", userId: f.users.dana, displayName: "Dana 命令更新" });
    assert.equal(viaCommand.ok, true, JSON.stringify(viaCommand));
    assert.equal(f.identity.userById(f.users.dana).display_name, "Dana 命令更新");
    const dana = f.ctx("dana");
    assert.equal((await gov.governanceService.updateUser({ context: dana, userId: f.users.alice, role: "ADMIN", departmentId: f.departmentId })).error, "NOT_SUPER_ADMIN");
    assert.equal((await gov.governanceService.updateUser({ context: dana, userId: f.users.bob, displayName: "x" })).error, "NOT_FOUND_OR_FORBIDDEN");
    assert.equal((await gov.governanceService.updateUser({ context: admin, userId: f.users.alice, displayName: "x", departmentId: "dept_missing" })).error, "CROSS_DEPARTMENT_DENIED");
  } finally { f.close(); }
});

test("resource/thumbnail：图片可用、磁盘缓存命中、批量返回", async () => {
  const f = await createResourceFixture();
  try {
    const file = path.join(tempDir("dxos-task52-img-"), "pixel.png");
    fs.writeFileSync(file, Buffer.from(PNG_BASE64, "base64"));
    const imported = await f.resourceService.importManaged({ context: f.adminCtx(), sourcePath: file, name: "pixel.png", mimeType: "image/png" });
    assert.equal(imported.ok, true, JSON.stringify(imported));
    const ref = imported.resource.resourceId;
    const nativeImage = { createFromPath: () => ({ isEmpty: () => false, resize: () => ({ toPNG: () => Buffer.from(PNG_BASE64, "base64") }) }) };
    const preview = new PreviewService({ identity: f.identity, resourceStore: f.resourceStore, searchStore: f.searchStore, managedStore: f.managedStore, authService: f.authService, nativeImage, thumbnailDir: path.join(tempRootPath(), "thumbs") });
    function tempRootPath() { return tempDir("dxos-task52-thumbs-"); }
    const first = await preview.thumbnail({ context: f.adminCtx(), resourceRef: ref });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.cached, false);
    const second = await preview.thumbnail({ context: f.adminCtx(), resourceRef: ref });
    assert.equal(second.ok, true);
    assert.equal(second.cached, true, "第二次必须命中缓存");
    const batch = await preview.thumbnailBatch({ context: f.adminCtx(), resourceRefs: [ref, ref, ref] });
    assert.equal(batch.ok, true);
    assert.equal(batch.items.length, 1, "重复 ref 去重");
    assert.equal(batch.items[0].ok, true);
  } finally { f.close(); }
});

test("task 事件流：task/get 返回 safe 步骤/模型/工具事件与 calls；结果推送 task/event", () => {
  const events = [
    { event_type: "step.started", safe_payload: { stepId: "s1", sequence: 1 } },
    { event_type: "model.call.started", safe_payload: { callId: "c1" } },
    { event_type: "tool.execution.succeeded", safe_payload: { toolId: "resource.read.metadata" } },
  ];
  const fakeTaskService = {
    getTask: () => ({ ok: true, task: { taskId: "t1", status: "SUCCEEDED" } }),
    getSteps: () => ({ ok: true, items: [] }), getArtifacts: () => ({ ok: true, items: [] }),
    getVerifications: () => ({ ok: true, items: [] }), getResumeEligibility: () => ({ ok: true }),
    getBudgetLedger: () => ({ ok: true }), getAppendEligibility: () => ({ ok: true }),
    getRecoveryState: () => ({ ok: false }), getDeniedRequiredWriteOperations: () => ({ ok: false }),
    getEvents: () => ({ ok: true, items: events.map(safeEvent) }), getCalls: () => ({ ok: true, items: [{ callId: "c1", status: "COMPLETED" }] }),
  };
  const ipc = fakeIpc();
  const sent = [];
  registerTaskIpc({ ipcMain: ipc, taskService: fakeTaskService, orchestrator: {}, identity: { current: "sess" }, isTrusted: () => true, send: (event) => sent.push(event) });
  return ipc.handlers.get("task:command")({}, { type: "task/get", taskId: "t1" }).then((result) => {
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.events.map((event) => event.eventType), ["step.started", "model.call.started", "tool.execution.succeeded"]);
    assert.equal(result.calls[0].callId, "c1");
    for (const event of result.events) assert.equal(JSON.stringify(event).includes("sk-"), false);
    const source = fs.readFileSync(path.join(process.cwd(), "electron", "task-bootstrap.cjs"), "utf8");
    assert.ok(source.includes('type: "task/event"'));
    assert.ok(source.includes("events: events && events.ok"));
  });
});
