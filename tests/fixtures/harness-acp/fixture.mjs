/** D4-02B 测试夹具：真实 Model Service + Model Proxy + Fake Provider + HarnessAdapter。 */
import { createRequire } from "node:module";
import { createModelFixture } from "../../model-fixtures.mjs";
import { startFakeProvider } from "../../model-fake-provider.mjs";
const require = createRequire(import.meta.url);
const { ModelProxy } = require("../../../electron/model-proxy.cjs");
const { HarnessAdapter } = require("../../../electron/harness-adapter.cjs");

export const PROVIDER_SECRET = "FAKE_PROVIDER_SECRET_D401_D4_02B_PROBE";

export async function createHarnessFixture({ behavior = "success", maxCalls = 4 } = {}) {
  const f = await createModelFixture();
  const appId = "ai";
  f.store.upsertApp({ appId, name: appId, publisher: "test", status: "enabled", builtIn: 0 });
  f.modelService.grantAppModelAccess({ context: f.adminCtx(), appId, actions: ["model.view", "model.use", "model.manage", "model.test"] });
  const ctx = { sessionRef: f.sessions.admin, appId };
  const fp = await startFakeProvider({ behavior, secretEcho: null });
  const p = f.modelService.createProvider({ context: ctx, displayName: "ACAProbe", baseUrl: fp.baseUrl, credentialSecret: PROVIDER_SECRET });
  if (!p.ok) throw new Error("createProvider failed " + JSON.stringify(p));
  const m = f.modelService.createModel({ context: ctx, providerId: p.provider.providerId, remoteModelId: "remote-fake-1", capabilities: ["chat"] });
  if (!m.ok) throw new Error("createModel failed " + JSON.stringify(m));
  const proxy = new ModelProxy({ modelService: f.modelService, clock: f.clock, ttlMs: 300000 });
  await proxy.start();
  return {
    f, ctx, fp, proxy, modelConfigId: m.model.configId, appId,
    makeAdapter(opts = {}) { return new HarnessAdapter({ modelProxy: proxy, ...opts }); },
    async close() { try { await proxy.stop(); } catch { /* ignore */ } try { await fp.close(); } catch { /* ignore */ } f.close(); },
  };
}

/** 递归读取目录下所有文件字节（latin1），返回 {files, text}。 */
export function readTree(dir) {
  const files = [];
  const visit = (d) => {
    let entries; try { entries = require("node:fs").readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) { const p = require("node:path").join(d, e.name); if (e.isDirectory()) visit(p); else files.push(p); }
  };
  visit(dir);
  const fs = require("node:fs");
  let text = "";
  for (const p of files) { try { text += fs.readFileSync(p).toString("latin1") + "\n"; } catch { /* ignore */ } }
  return { files, text };
}
