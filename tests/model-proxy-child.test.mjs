/** D4-01 · Independent child credential isolation（真实 OS child process）。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createModelFixture } from "./model-fixtures.mjs";
import { startFakeProvider } from "./model-fake-provider.mjs";
const require = createRequire(import.meta.url);
const { ModelProxy } = require("../electron/model-proxy.cjs");

const SECRET = "FAKE_PROVIDER_SECRET_D401_CHILD_551122";
const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "model-proxy-child.mjs");

const f = await createModelFixture();
const proxy = new ModelProxy({ modelService: f.modelService, clock: f.clock });
const _servers = [];
after(async () => { await proxy.stop(); for (const s of _servers) { try { await s.close(); } catch { /* ignore */ } } f.close(); });
const admin = f.adminCtx();
const ai = { sessionRef: admin.sessionRef, appId: "ai" };
f.modelService.grantAppModelAccess({ context: admin, appId: "ai", actions: ["model.view", "model.use", "model.manage", "model.test"] });
await proxy.start();

function runChild(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

test("Child Credential Isolation：child → Proxy → Provider；Provider 收到 key，child 从未收到", async () => {
  const fp = await startFakeProvider({ behavior: "success", secretEcho: SECRET });
  _servers.push(fp);
  const p = f.modelService.createProvider({ context: ai, displayName: "ChildFake", baseUrl: fp.baseUrl, credentialSecret: SECRET });
  assert.equal(p.ok, true, JSON.stringify(p));
  const m = f.modelService.createModel({ context: ai, providerId: p.provider.providerId, remoteModelId: "fake-1", capabilities: ["chat", "tool-calling"] });
  assert.equal(m.ok, true);
  const cap = proxy.issueCapability({ context: ai, configId: m.model.configId, maxCalls: 3 });
  assert.equal(cap.ok, true);
  const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME, D4_PROXY_URL: proxy.baseUrl, D4_PROXY_TOKEN: cap.capability.token };
  const run = await runChild(childEnv);
  assert.equal(run.code, 0, JSON.stringify(run));
  const line = run.out.split("\n").find((l) => l.startsWith("CHILD_RESULT "));
  assert.ok(line, "child 应输出 CHILD_RESULT: " + run.out);
  const result = JSON.parse(line.slice("CHILD_RESULT ".length));
  assert.equal(result.status, 200);
  assert.equal(result.text, "hello from fake");
  // Provider 收到真实 key
  assert.equal(fp.state.authHeaders[0], "Bearer " + SECRET);
  // child env / argv / stdout / stderr 均无 key
  const surface = JSON.stringify(childEnv) + "\n" + run.out + "\n" + run.err + "\n" + JSON.stringify([CHILD]);
  assert.equal(surface.includes(SECRET), false, "child 不得持有 provider secret");
});

test("Child 消费 capability：maxCalls=1 时 child 成功后 parent 再调用 EXHAUSTED", async () => {
  const fp = await startFakeProvider({ behavior: "success", secretEcho: SECRET });
  _servers.push(fp);
  const p = f.modelService.createProvider({ context: ai, displayName: "ChildFake2", baseUrl: fp.baseUrl, credentialSecret: SECRET });
  const m = f.modelService.createModel({ context: ai, providerId: p.provider.providerId, remoteModelId: "fake-1", capabilities: ["chat"] });
  const cap = proxy.issueCapability({ context: ai, configId: m.model.configId, maxCalls: 1 });
  const run = await runChild({ PATH: process.env.PATH, HOME: process.env.HOME, D4_PROXY_URL: proxy.baseUrl, D4_PROXY_TOKEN: cap.capability.token });
  assert.equal(run.code, 0, JSON.stringify(run));
  assert.ok(run.out.includes("\"status\":200"));
  const again = await fetch(proxy.baseUrl + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + cap.capability.token }, body: JSON.stringify({ messages: [] }) });
  assert.equal(again.status, 429);
});
