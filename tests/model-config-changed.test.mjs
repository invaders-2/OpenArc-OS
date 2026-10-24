/**
 * 模型配置变更下行事件（model:event 的 payload.type = "model/configChanged"）。
 *
 * 为什么必须有：画布（canvas-next）把模型目录缓存在内存里，删掉模型后柜面/设置页都对，
 * 画布下拉还留着它，必须重载页面。主进程在 model/create|update|setStatus|delete **成功后**
 * 广播一条只带 id 的失效信号，渲染层据此作废缓存并重拉。
 *
 * 本用例锁的行为：
 *   ① 四条写入命令成功后各发一条（action = created/updated/status/deleted），信封走既有 P1 通道；
 *   ② 失败 / 被拒（非管理员）不发；
 *   ③ payload 只有 type/action/configId/providerId，绝无 baseUrl / 凭据；
 *   ④ 宿主没注入发送口（wireModelEvents 未调用）时静默跳过，命令结果不受影响；
 *   ⑤ 渲染层接线（bridge 订阅 + 作废缓存 + focus 兜底、store 重拉、types 声明）不从源码删掉。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createModelFixture } from "./model-fixtures.mjs";

const require = createRequire(import.meta.url);
const { registerModelIpc, MODEL_COMMANDS, wireModelEvents } = require("../electron/model-bootstrap.cjs");
const { createProviderProtocolBundle } = require("../electron/provider-protocol-service.cjs");
const { memoryCredentialBackend } = require("../electron/credential-store.cjs");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const SECRET = "sk-dxos-model-config-changed-0001";
const LOCAL = "http://127.0.0.1:9/v1";

const f = await createModelFixture();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-model-changed-"));
const bundle = createProviderProtocolBundle({ userDataDir: dir, backend: memoryCredentialBackend() });
f.modelService.providerProtocol = bundle;
after(() => { try { f.close(); } catch { /* ignore */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

f.store.upsertApp({ appId: "settings", name: "系统设置", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
f.modelService.grantAppModelAccess({ context: f.adminCtx(), appId: "settings", actions: ["model.view", "model.use", "model.manage", "model.test"] });

const sent = [];
assert.equal(wireModelEvents({ service: f.modelService, send: (event) => sent.push(event) }), true, "宿主注入后发送口就位");
const identity = { current: f.sessions.admin };
const ipc = { handlers: new Map(), handle(ch, fn) { this.handlers.set(ch, fn); }, removeHandler(ch) { this.handlers.delete(ch); } };
registerModelIpc({ ipcMain: ipc, service: f.modelService, identity, isTrusted: () => true });
const invoke = (command, payload) => ipc.handlers.get("model:command")({}, { command, payload });
const take = () => sent.splice(0, sent.length);
const admin = () => ({ ...f.adminCtx(), appId: "settings" });

function makeProvider(scope = "PERSONAL") {
  const created = f.modelService.createProvider({ context: admin(), displayName: "变更-" + scope, baseUrl: LOCAL, scope, credentialSecret: SECRET });
  assert.equal(created.ok, true, JSON.stringify(created));
  return created.provider.providerId;
}

test("E1 · create / update / setStatus / delete 成功后各广播一条失效信号（P1 信封，只带 id）", async () => {
  assert.ok(MODEL_COMMANDS.includes("model/create") && MODEL_COMMANDS.includes("model/delete"));
  const providerId = makeProvider();
  take();

  const created = await invoke("model/create", { providerId, remoteModelId: "changed-model", capabilities: ["chat"] });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(sent.length, 1, "create 后必须有一条");
  const createdEvent = sent[0];
  assert.equal(createdEvent.channel, "model:event");
  assert.equal(createdEvent.domain, "model");
  assert.equal(createdEvent.kind, "progress");
  assert.equal(typeof createdEvent.sequence, "number");
  assert.equal(createdEvent.payload.type, "model/configChanged");
  assert.equal(createdEvent.payload.action, "created");
  assert.equal(createdEvent.payload.configId, created.model.configId);
  assert.equal(createdEvent.payload.providerId, providerId);
  assert.deepEqual(Object.keys(createdEvent.payload).sort(), ["action", "configId", "providerId", "type"], "payload 只带这四个字段");

  const configId = created.model.configId;
  const updated = await invoke("model/update", { configId, displayName: "改名" });
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.equal(sent.at(-1).payload.action, "updated");
  assert.equal(sent.at(-1).payload.configId, configId);

  const status = await invoke("model/setStatus", { configId, status: "disabled" });
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.equal(sent.at(-1).payload.action, "status");

  const deleted = await invoke("model/delete", { configId });
  assert.equal(deleted.ok, true, JSON.stringify(deleted));
  assert.equal(sent.at(-1).payload.action, "deleted");
  assert.equal(sent.at(-1).payload.configId, configId);
  assert.equal(sent.at(-1).payload.providerId, providerId, "删除也要能定位到服务商");
  assert.equal(f.modelStore.configById(configId), null);
});

test("E2 · 失败 / 被拒不广播；payload 不含地址与凭据", async () => {
  const providerId = makeProvider();
  take();
  // 不存在的 configId：deleteModel 幂等 ok，但没有真正删除 → 不广播
  const noop = await invoke("model/delete", { configId: "mcf_does_not_exist" });
  assert.deepEqual(noop, { ok: true, changed: false });
  assert.equal(sent.length, 0, "幂等空删不广播");

  // 缺参数 / 非法输入
  assert.equal((await invoke("model/create", { providerId, remoteModelId: "" })).ok, false);
  assert.equal(sent.length, 0);

  // 非管理员删组织级模型：被拒，不广播
  const orgProvider = makeProvider("ORGANIZATION");
  const orgModel = f.modelService.createModel({ context: admin(), providerId: orgProvider, remoteModelId: "org-changed", capabilities: ["chat"], scope: "ORGANIZATION" });
  assert.equal(orgModel.ok, true, JSON.stringify(orgModel));
  take();
  identity.current = f.sessions.alice;
  const denied = await invoke("model/delete", { configId: orgModel.model.configId });
  identity.current = f.sessions.admin;
  assert.equal(denied.ok, false, JSON.stringify(denied));
  assert.equal(denied.error, "PROXY_UNAUTHORIZED");
  assert.equal(sent.length, 0, "被拒不得广播");
  assert.ok(f.modelStore.configById(orgModel.model.configId), "被拒后模型还在");

  // 成功写入的事件里不得出现密钥 / 地址
  const ok = await invoke("model/create", { providerId, remoteModelId: "clean-model", capabilities: ["chat"] });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const raw = JSON.stringify(sent);
  for (const forbidden of [SECRET, "127.0.0.1", LOCAL, "credential"]) assert.equal(raw.includes(forbidden), false, "事件不得含 " + forbidden);
  take();
});

test("E3 · 宿主没注入发送口时静默跳过，命令结果不受影响", async () => {
  const { service } = bundle;
  const original = service.emit;
  service.emit = null;
  try {
    const providerId = makeProvider();
    const created = await invoke("model/create", { providerId, remoteModelId: "no-sink-model", capabilities: ["chat"] });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(sent.length, 0, "没有发送口就不发，也不抛");
    assert.equal((await invoke("model/delete", { configId: created.model.configId })).ok, true);
    assert.equal(sent.length, 0);
  } finally {
    service.emit = original;
    take();
  }
});

test("E4 · 渲染层接线：桥订阅 model/configChanged、作废缓存并重拉；focus 兜底", () => {
  const bridge = read("src/canvas/canvas-next/backend/bridge.ts");
  assert.ok(bridge.includes('p.type !== "model/configChanged"'), "桥必须只认这条失效信号");
  assert.ok(/modelCache = null/.test(bridge), "收到信号要作废 modelCache");
  assert.ok(bridge.includes("invalidateModels()"), "缓存作废后要通知订阅方");
  assert.ok(bridge.includes('window.addEventListener("focus"') && bridge.includes('window.addEventListener("visibilitychange"'), "focus / visibilitychange 兜底");
  assert.ok(bridge.includes("onModelsChanged"), "桥要暴露订阅入口");

  const types = read("src/canvas/canvas-next/backend/types.ts");
  assert.ok(/onModelsChanged\?\(cb: \(\) => void\): \(\) => void/.test(types), "CanvasBackend 声明可选订阅方法");

  const store = read("src/canvas/canvas-next/store.ts");
  assert.ok(/async reloadModels\(\)/.test(store), "store 要有最小重拉入口");
  assert.ok(store.includes("this.backend.onModelsChanged(") && store.includes("void this.reloadModels()"), "store 订阅后重拉 models");
  assert.ok(store.includes("this.watchModelDirectory()"), "load() 时建立订阅");

  const main = read("electron/main.cjs");
  assert.ok(main.includes('"model:event"'), "下行通道仍是既有 model:event（未新增通道）");
});

test("E5 · 拉取弹窗批量操作接线：每个分类页有全选/清空，顶部有清空已选，纯逻辑来自 buildBulkPick", () => {
  const panel = read("src-vue/settings/RemoteModelsPanel.vue");
  for (const sel of ["data-d4-01-remote-select-section", "data-d4-01-remote-clear-section", "data-d4-01-remote-clear-all"]) {
    assert.ok(panel.includes(sel), "缺少 " + sel);
  }
  assert.ok(panel.includes('t("全选本类")') && panel.includes('t("清空本类")') && panel.includes('t("清空已选")'), "批量按钮文案");
  assert.ok(panel.includes("buildBulkPick"), "批量勾选只来自纯逻辑");
  assert.ok(panel.includes('emit("set-picks"'), "批量一次整体回传 picked/dropped，不逐行触发");
  const settings = read("src-vue/settings/ModelSettings.vue");
  assert.ok(settings.includes("@set-picks=\"onSetPicks\""), "ModelSettings 要接 set-picks");
  assert.ok(settings.includes("function onSetPicks("), "要有 onSetPicks 处理");
});
