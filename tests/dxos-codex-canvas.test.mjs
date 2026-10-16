/**
 * DX OS 0.6.1 · codex-canvas 中继 + 安装器移植验收。
 *
 * 被测（产品真实代码，非替身）：
 *   · electron/codex-canvas-relay.cjs      —— 源 server/index.ts:1225-1259 + server/codexCanvas.ts:82-106
 *   · electron/codex-canvas-installer.cjs  —— 源 server/codexCanvasInstaller.ts:1-69（惰性探测）
 *   · electron/codex-canvas-bootstrap.cjs  —— 源的 fetch 换成进程内调用既有 canvas 服务
 *
 * 覆盖验收：正确密钥可解密、错密钥/错 iv/超长 data 拒绝、nonce 重放拒绝、
 * 白名单外路由拒绝、未激活时只接受 /connect；外加安装器结构化依赖不可用与真实画布进程内分发。
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { createResourceFixture } from "./resource-fixtures.mjs";

const require = createRequire(import.meta.url);
const relayModule = require("../electron/codex-canvas-relay.cjs");
const installer = require("../electron/codex-canvas-installer.cjs");
const bootstrap = require("../electron/codex-canvas-bootstrap.cjs");
const { CanvasDxosStore } = require("../electron/canvas-dxos-store.cjs");
const { CanvasStore } = require("../electron/canvas-store.cjs");
const { CanvasService } = require("../electron/canvas-service.cjs");

const { createCodexCanvasRelay, sealRelayEnvelope, openRelayEnvelope, relayIdForCode, MAX_DATA_BYTES } = relayModule;

function pairOnce(relay) {
  return relay.pair({ user: { id: "u1", username: "alice" }, sessionId: "s1", canvasId: "cv1" });
}
function connectEnvelope(code) {
  return sealRelayEnvelope(code, { method: "POST", path: "/connect", code });
}
function activeEnvelope(code, method, path, body) {
  return sealRelayEnvelope(code, { method, path, body });
}
/** 建一个只回显 path 的中继；calls 记录每次进程内 dispatch，用于断言"拒绝的路由不进 dispatch"。 */
function echoRelay(overrides = {}) {
  const calls = [];
  const relay = createCodexCanvasRelay({
    dispatch: async ({ method, path }) => { calls.push({ method, path }); return { status: 200, body: { ok: true, path } }; },
    ...overrides,
  });
  return { relay, calls };
}
async function activate(relay) {
  const pair = pairOnce(relay);
  const result = await relay.relay(connectEnvelope(pair.code));
  assert.equal(result.ok, true, "激活必须成功：" + JSON.stringify(result));
  return pair;
}

test("(1) 正确密钥：/connect 激活后 /snapshot 经进程内 dispatch 返回可解密结果", async () => {
  const { relay, calls } = echoRelay();
  const pair = pairOnce(relay);

  const connected = await relay.relay(connectEnvelope(pair.code));
  assert.equal(connected.ok, true);
  // 响应信封只有 iv/data（源 index.ts:1254-1257），id 不出现在响应里。
  assert.equal("id" in connected, false);
  const activation = openRelayEnvelope(pair.code, connected);
  assert.equal(activation.status, 200);
  assert.equal(activation.body.ok, true);
  assert.equal(activation.body.username, "alice");
  assert.equal(activation.body.canvas.id, "cv1");

  const snapshot = await relay.relay(activeEnvelope(pair.code, "GET", "/snapshot"));
  assert.equal(snapshot.ok, true);
  const opened = openRelayEnvelope(pair.code, snapshot);
  assert.deepEqual(opened, { status: 200, body: { ok: true, path: "/snapshot" } });
  assert.deepEqual(calls, [{ method: "GET", path: "/snapshot" }]);
});

test("(2) 错密钥 / 错 iv / 超长 data 一律拒绝，且不触发 dispatch", async () => {
  const { relay, calls } = echoRelay();
  const pair = pairOnce(relay);

  // 错密钥：id 仍指向真实配对（sha256(code)），但密文用另一把 key 封。
  const wrongKey = sealRelayEnvelope("some-other-pairing-code", { method: "POST", path: "/connect", code: pair.code });
  wrongKey.id = relayIdForCode(pair.code);
  const r1 = await relay.relay(wrongKey);
  assert.equal(r1.ok, false);
  assert.equal(r1.error, "DECRYPT_FAILED");

  const valid = sealRelayEnvelope(pair.code, { method: "POST", path: "/connect", code: pair.code });
  // 错 iv：长度不为 12 直接拒（源 index.ts:1230）。
  const r2 = await relay.relay({ ...valid, iv: Buffer.alloc(11).toString("base64") });
  assert.equal(r2.error, "INVALID_ENVELOPE");
  const r3 = await relay.relay({ ...valid, iv: Buffer.alloc(13).toString("base64") });
  assert.equal(r3.error, "INVALID_ENVELOPE");
  // 长度对但值错：GCM 认证失败。
  const r4 = await relay.relay({ ...valid, iv: crypto.randomBytes(12).toString("base64") });
  assert.equal(r4.error, "DECRYPT_FAILED");

  // data 过短：< 17 字节（16 tag + ≥1 密文）拒（源 index.ts:1230）。
  const tooShort = await relay.relay({ ...valid, data: Buffer.alloc(16).toString("base64") });
  assert.equal(tooShort.error, "INVALID_ENVELOPE");
  // 超长 data：> 3MB 拒（源 index.ts:1230）。
  const oversized = await relay.relay({ id: relayIdForCode(pair.code), iv: crypto.randomBytes(12).toString("base64"), data: Buffer.alloc(MAX_DATA_BYTES + 1).toString("base64") });
  assert.equal(oversized.error, "INVALID_ENVELOPE");
  assert.equal(calls.length, 0, "所有非法信封都不得进入 dispatch");
});

test("(3) nonce 重放：同一 iv 第二次拒绝，换新 iv 仍可通行", async () => {
  const { relay, calls } = echoRelay();
  const pair = await activate(relay);

  const request = activeEnvelope(pair.code, "GET", "/snapshot");
  const first = await relay.relay(request);
  assert.equal(first.ok, true);
  const replay = await relay.relay(request);
  assert.equal(replay.ok, false);
  assert.equal(replay.error, "REPLAY_REJECTED");
  const fresh = await relay.relay(activeEnvelope(pair.code, "GET", "/snapshot"));
  assert.equal(fresh.ok, true);
  assert.equal(calls.length, 2, "重放不得再次 dispatch");

  // 撤销后同一授权立即失效（源 codexCanvas.ts:119-124）。
  relay.revoke({ userId: "u1", canvasId: "cv1" });
  const revoked = await relay.relay(activeEnvelope(pair.code, "GET", "/snapshot"));
  assert.equal(revoked.error, "SESSION_EXPIRED");
});

test("(4) 白名单外路由拒绝，images 正则精确匹配，拒绝不进 dispatch", async () => {
  const { relay, calls } = echoRelay();
  const pair = await activate(relay);

  const denied = [
    ["POST", "/evil"],
    ["POST", "/snapshot"], // 方法不在白名单
    ["GET", "/nodes/find"], // 方法不在白名单
    ["GET", "/generation/images?taskId=../etc/passwd"], // 正则不放行路径穿越
    ["GET", "/generation/images"], // 缺 taskId
    ["GET", "/generation/images?taskId="], // taskId 空
    ["GET", "/generation/images?taskId=" + "a".repeat(101)], // taskId 超 100
    ["POST", "/generation/images?taskId=abc"], // images 只允许 GET
  ];
  for (const [method, path] of denied) {
    const result = await relay.relay(activeEnvelope(pair.code, method, path));
    assert.equal(result.ok, false, method + " " + path + " 必须被拒");
    assert.equal(result.error, "ROUTE_NOT_ALLOWED", method + " " + path);
  }

  // 下划线不在 taskId 字符集里，必须被拒。
  const underscore = await relay.relay(activeEnvelope(pair.code, "GET", "/generation/images?taskId=abc_123"));
  assert.equal(underscore.error, "ROUTE_NOT_ALLOWED");
  // 源正则允许的 images 路由必须放行。
  const allowedExact = await relay.relay(activeEnvelope(pair.code, "GET", "/generation/images?taskId=task-001"));
  assert.equal(allowedExact.ok, true);
  assert.deepEqual(calls, [{ method: "GET", path: "/generation/images?taskId=task-001" }]);
});

test("(5) 未激活时只接受 POST /connect + 正确 code", async () => {
  const { relay, calls } = echoRelay();
  const pair = pairOnce(relay);

  // 激活前任何白名单路由都被拒。
  const before = await relay.relay(activeEnvelope(pair.code, "GET", "/snapshot"));
  assert.equal(before.error, "PAIR_REQUIRED");
  // POST /connect 但 code 不对，同样被拒。
  const wrongCode = await relay.relay(sealRelayEnvelope(pair.code, { method: "POST", path: "/connect", code: "not-the-code" }));
  assert.equal(wrongCode.error, "PAIR_REQUIRED");
  assert.equal(relay.inspect().channels, 0);
  assert.equal(calls.length, 0);

  // 正确 code 才激活。
  const connected = await relay.relay(connectEnvelope(pair.code));
  assert.equal(connected.ok, true);
  assert.equal(relay.inspect().channels, 1);
});

test("(6) 未知 / 非法 id 与超时语义（40s 默认，execute 单独超时）", async () => {
  const { relay } = echoRelay();
  const pair = pairOnce(relay);
  const valid = sealRelayEnvelope(pair.code, { method: "POST", path: "/connect", code: pair.code });

  const unknown = await relay.relay({ ...valid, id: "f".repeat(64) });
  assert.equal(unknown.error, "SESSION_EXPIRED");
  const malformed = await relay.relay({ ...valid, id: "xyz" });
  assert.equal(malformed.error, "INVALID_SESSION");

  // 超时：默认路线用 timeoutMs，/generation/execute 用 executeTimeoutMs（源 index.ts:1250）。
  const stuck = createCodexCanvasRelay({ dispatch: () => new Promise(() => {}), timeoutMs: 2_000, executeTimeoutMs: 15 });
  const stuckPair = await activate(stuck);
  const executeTimeout = await stuck.relay(activeEnvelope(stuckPair.code, "POST", "/generation/execute", {}));
  assert.equal(executeTimeout.error, "TIMEOUT");

  const slow = createCodexCanvasRelay({ dispatch: () => new Promise(() => {}), timeoutMs: 15, executeTimeoutMs: 2_000 });
  const slowPair = await activate(slow);
  const defaultTimeout = await slow.relay(activeEnvelope(slowPair.code, "POST", "/cards", { cards: [] }));
  assert.equal(defaultTimeout.error, "TIMEOUT");
});

test("(7) 安装器惰性探测：codex CLI / MCP SDK / 桥接缺失都是结构化结果", async () => {
  const none = { env: {}, exists: () => false, requireFn: { resolve: () => { throw new Error("missing"); } }, bridgeEntry: "/nope/bridge.cjs" };
  const status = installer.codexCanvasInstallStatus({ deps: none });
  assert.equal(status.ok, false);
  assert.equal(status.codex.available, false);
  assert.equal(status.mcpSdk.available, false);
  assert.equal(status.bridge.available, false);

  // 未安装 codex → CLI_UNAVAILABLE，并说明缺什么、怎么装。
  const cli = await installer.installCodexCanvasMcp({ port: 12345, deps: none });
  assert.equal(cli.ok, false);
  assert.equal(cli.error, "CLI_UNAVAILABLE");
  assert.ok(cli.missing.includes("codex"), "必须点名缺 codex");
  assert.ok(cli.install.some((line) => /codex/i.test(line)), "必须给出安装说明");

  // 有 codex、有桥接，但 MCP SDK 不可解析 → MCP_SDK_UNAVAILABLE。
  const sdkMissing = { env: {}, exists: (p) => p === "/fake/codex" || p === "/fake/bridge.cjs", codexBin: "/fake/codex", bridgeEntry: "/fake/bridge.cjs", requireFn: { resolve: () => { throw new Error("no sdk"); } } };
  const sdkResult = await installer.installCodexCanvasMcp({ port: 1, deps: sdkMissing });
  assert.equal(sdkResult.error, "MCP_SDK_UNAVAILABLE");
  assert.ok(sdkResult.missing.includes("@modelcontextprotocol/sdk"));

  // 有 codex、有 SDK，但桥接入口不存在 → BRIDGE_UNAVAILABLE。
  const bridgeMissing = { env: {}, exists: (p) => p === "/fake/codex", codexBin: "/fake/codex", bridgeEntry: "/no/bridge.cjs", requireFn: { resolve: () => "/x" } };
  const bridgeResult = await installer.installCodexCanvasMcp({ port: 1, deps: bridgeMissing });
  assert.equal(bridgeResult.error, "BRIDGE_UNAVAILABLE");
  assert.ok(bridgeResult.missing.some((p) => /bridge/.test(p)));

  // 桥接就绪：setup 复刻源 codexCanvasInstaller.ts:46-51 的 command/args/manualCommand。
  const ready = { env: { DX_DESKTOP_MCP_NODE: "/fake/node" }, exists: (p) => p === "/fake/bridge.cjs", bridgeEntry: "/fake/bridge.cjs", requireFn: { resolve: () => "/x" } };
  const setup = installer.codexCanvasMcpSetup({ port: 9999, deps: ready });
  assert.equal(setup.ok, true);
  assert.equal(setup.command, "/fake/node");
  assert.deepEqual(setup.args, ["/fake/bridge.cjs", "9999"]);
  assert.match(setup.manualCommand, /^codex mcp add dxos-canvas -- /);

  // 显式配置的桥接文件不在 = 安装包缺件（源 codexCanvasInstaller.ts:24）。
  const packagedMissing = installer.codexCanvasMcpSetup({ port: 1, deps: { env: { DX_DESKTOP_MCP_BRIDGE: "/gone/bridge.cjs" }, exists: () => false } });
  assert.equal(packagedMissing.error, "BRIDGE_UNAVAILABLE");
  assert.match(packagedMissing.detail, /缺少 Codex 桥接程序/);
});

test("(8) 进程内分发真实落到既有 canvas 服务（无 HTTP，不新建画布）", async () => {
  const fx = await createResourceFixture();
  try {
    const store = new CanvasDxosStore({ identity: fx.identity, clock: fx.clock });
    const canvasStore = new CanvasStore({ identity: fx.identity, clock: fx.clock });
    const canvasService = new CanvasService({ identity: fx.identity, store: canvasStore, resourceStore: fx.resourceStore, resourceService: fx.resourceService, authService: fx.authService, clock: fx.clock });
    const domain = bootstrap.createCodexCanvasDomain({ identity: fx.identity, canvasService });

    const created = canvasService.createCanvas({ context: { sessionRef: fx.sessions.admin, appId: "canvas" }, title: "中继画布" });
    assert.equal(created.ok, true, JSON.stringify(created));
    const canvasId = created.canvas.canvasId;

    const paired = domain.pair({ context: { sessionRef: fx.sessions.admin }, canvasId });
    assert.equal(paired.ok, true, JSON.stringify(paired));
    const connect = await domain.relay(sealRelayEnvelope(paired.code, { method: "POST", path: "/connect", code: paired.code }));
    assert.equal(connect.ok, true, JSON.stringify(connect));

    const snapshot = await domain.relay(activeEnvelope(paired.code, "GET", "/snapshot"));
    const view = openRelayEnvelope(paired.code, snapshot);
    assert.equal(view.status, 200);
    assert.equal(view.body.canvas.id, canvasId);
    assert.equal(view.body.canvas.title, "中继画布");
    assert.equal(Array.isArray(view.body.canvas.cards), true);

    // 写操作经既有 canvas 命令层真实落库。
    const cards = await domain.relay(activeEnvelope(paired.code, "POST", "/cards", { cards: [{ id: "n1", kind: "prompt", x: 10, y: 20, title: "节点一" }] }));
    const written = openRelayEnvelope(paired.code, cards);
    assert.equal(written.status, 200, JSON.stringify(written));
    const after = openRelayEnvelope(paired.code, await domain.relay(activeEnvelope(paired.code, "GET", "/snapshot")));
    assert.equal(after.body.canvas.cards.length, 1);
    assert.equal(after.body.canvas.cards[0].id, "n1");
    assert.equal(after.body.canvas.cards[0].title, "节点一");

    // 云能力在本仓 OUT：结构化 501，不伪造模型/生成结果（约束 3）。
    const cloud = openRelayEnvelope(paired.code, await domain.relay(activeEnvelope(paired.code, "GET", "/image-models")));
    assert.equal(cloud.status, 501);
    assert.equal(cloud.body.error, "CLOUD_DISABLED");
  } finally {
    fx.close();
  }
});

test("(9) 独立域 codexCanvas:command 的 trusted 边界与命令白名单", async () => {
  const ipcMain = {
    handlers: new Map(),
    handle(channel, fn) { this.handlers.set(channel, fn); },
    removeHandler(channel) { this.handlers.delete(channel); },
  };
  const seen = [];
  bootstrap.registerCodexCanvasIpc({
    ipcMain,
    domain: { execute: async (command, payload, context) => { seen.push([command, context.sessionRef, context.appId]); return { ok: true, command }; } },
    isTrusted: (event) => !!(event && event.trusted === true),
    identity: { current: "s-admin" },
  });
  assert.equal(ipcMain.handlers.size, 1);
  assert.ok(ipcMain.handlers.has("codexCanvas:command"));
  const handler = ipcMain.handlers.get("codexCanvas:command");

  await assert.rejects(() => handler({ trusted: false }, { command: "codexCanvas/status" }), /Forbidden/);
  const allowed = await handler({ trusted: true }, { command: "codexCanvas/status", payload: {} });
  assert.equal(allowed.ok, true);
  const denied = await handler({ trusted: true }, { command: "codexCanvas/explode", payload: {} });
  assert.equal(denied.error, "CODEX_CANVAS_COMMAND_NOT_ALLOWED");
  // sessionRef/appId 只来自主进程注入，忽略渲染层自报。
  assert.deepEqual(seen, [["codexCanvas/status", "s-admin", "canvas"]]);

  bootstrap.disposeCodexCanvasIpc({ ipcMain });
  assert.equal(ipcMain.handlers.size, 0);
});

test("(10) 密钥派生与路由表与源逐字节一致（防走样）", () => {
  const expectedKey = crypto.createHash("sha256").update("dxos-canvas-relay/v1:" + "pair-code").digest("hex");
  assert.equal(relayModule.deriveRelayKey("pair-code").toString("hex"), expectedKey);
  assert.deepEqual([...relayModule.RELAY_ROUTES], [
    "GET /snapshot", "GET /image-models", "POST /nodes/find", "POST /nodes/get",
    "POST /nodes/rename", "POST /nodes/edit", "POST /connections/change",
    "POST /cards", "POST /generation/preview", "POST /generation/execute",
    "POST /generation/query",
  ]);
  assert.equal(relayModule.IMAGE_ROUTE_PATTERN.test("/generation/images?taskId=abc-123"), true);
  assert.equal(relayModule.IMAGE_ROUTE_PATTERN.test("/generation/images?taskId=abc_123"), false);
  assert.equal(relayModule.DEFAULT_TIMEOUT_MS, 40_000);
  assert.equal(relayModule.EXECUTE_TIMEOUT_MS, 130_000);
  assert.equal(relayModule.MAX_DATA_BYTES, 3_000_000);
});
