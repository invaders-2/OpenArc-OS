/** D4-01 Closure D · 真实 macOS secure backend / 跨进程重启探针宿主。
 *
 * 每个 phase 都是一次独立的 Electron 主进程：同一 userData（同一 identity.db + credentials/），
 * 真实 safeStorage 落盘。Harness 依次 spawn 4 个 phase，并把上一 phase 的
 * 旧 capability（token/port）通过 env 传给下一 phase，验证"旧 capability 重启后 DENY"。
 *
 * 绝不打印 raw secret；只回布尔/计数/非敏感标识。
 */
"use strict";
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const ROOT = path.resolve(__dirname, "../../..");
const { createIdentityService } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));
const { createModelBundle } = require(path.join(ROOT, "electron/model-bootstrap.cjs"));

const PHASE = process.env.OA_PHASE || "1";
const USERDATA = process.env.OA_USERDATA || "";
const PROVIDER_URL = process.env.OA_PROVIDER_URL || "";
const SECRET_V1 = process.env.OA_SECRET_V1 || "";
const SECRET_V2 = process.env.OA_SECRET_V2 || "";
const SECRET_V3 = process.env.OA_SECRET_V3 || "";
const OLD_TOKEN = process.env.OA_OLD_TOKEN || "";
const OLD_PORT = Number(process.env.OA_OLD_PORT || "0");
const OLD_EXPIRES = Number(process.env.OA_OLD_EXPIRES || "0");
const ADMIN = "admin@openarc.test";
const PW = "admin-password-1";
const APP = "settings";
const SECRETS = [SECRET_V1, SECRET_V2, SECRET_V3].filter(Boolean);

const report = { phase: PHASE, checks: [], errors: [], state: {} };
const out = (l) => process.stdout.write(l + "\n");
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: !!ok, detail: String(detail === undefined ? "" : detail).slice(0, 300) });
  out((ok ? "PASS" : "FAIL") + " " + name + (detail ? " :: " + detail : ""));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 任何 raw secret / 敏感响应都不得被序列化出去。
const noSecret = (obj) => { const s = typeof obj === "string" ? obj : JSON.stringify(obj === undefined ? null : obj); return !SECRETS.some((x) => s.includes(x)); };

function walk(dir, acc = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile()) acc.push(p);
  }
  return acc;
}
/** 递归扫描目录里是否有任一 raw secret 落盘（二进制安全）。只回相对路径，不回 secret。 */
function scanPlaintext(dir) {
  const hits = [];
  for (const f of walk(dir)) {
    let buf; try { buf = fs.readFileSync(f); } catch { continue; }
    for (let i = 0; i < SECRETS.length; i += 1) {
      if (buf.includes(Buffer.from(SECRETS[i], "utf8"))) hits.push({ file: path.relative(dir, f), secretIndex: i });
    }
  }
  return hits;
}
function listCredentialFiles(dir) {
  try { return fs.readdirSync(path.join(dir, "credentials")).filter((f) => f.endsWith(".bin")); } catch { return []; }
}

async function httpPost(baseUrl, token, body, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
  try {
    const res = await fetch(String(baseUrl).replace(/\/$/, "") + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    let json = null; try { json = await res.json(); } catch { /* ignore */ }
    return { ok: true, status: res.status, json };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally { clearTimeout(t); }
}

async function boot() {
  const identity = createIdentityService({ userDataDir: USERDATA, safeStorage, allowAdmin: true });
  const init = await identity.store.initialize({ identifier: ADMIN, password: PW, displayName: "Admin" });
  if (init && init.ok === false && init.error !== "ALREADY_INITIALIZED") throw new Error("initialize failed: " + init.error);
  const login = await identity.store.login({ identifier: ADMIN, password: PW });
  if (!login || login.ok === false) throw new Error("login failed: " + (login && login.error));
  SECRETS.forEach((s) => identity.logger.registerSecret(s));
  return { identity, login, context: { sessionRef: login.session.ref, appId: APP } };
}

function settingsGrant(identity) {
  const app = identity.authStore.appById(APP);
  const grants = identity.authStore.appGrantsForApp(APP).filter((g) => g.resource_type === "model");
  const actions = grants.flatMap((g) => (typeof g.actions === "string" ? JSON.parse(g.actions) : g.actions || [])).sort();
  return { app, actions };
}

async function phase1() {
  const { identity, login, context } = await boot();
  check("D1.1 · 真实 macOS secure backend 可用", identity.credentialStore.available() === true && identity.credentialStore.backend.kind === "electron-safe-storage", "kind=" + identity.credentialStore.backend.kind);
  const g = settingsGrant(identity);
  check("D1.2 · settings App Principal 已注册（built-in/enabled）", !!(g.app && g.app.built_in === 1 && String(g.app.status).toLowerCase() === "enabled"), JSON.stringify(g.app && { builtIn: g.app.built_in, status: g.app.status }));
  check("D1.3 · settings Model 权限为最小四权", JSON.stringify(g.actions) === JSON.stringify(["model.manage", "model.test", "model.use", "model.view"]), JSON.stringify(g.actions));

  const created = identity.modelService.createProvider({ context, displayName: "Keychain D4-01", baseUrl: PROVIDER_URL, scope: "PERSONAL", credentialSecret: SECRET_V1 });
  check("D1.4 · 建 Provider + 写入 credential（返回不含 raw secret）", created.ok === true && noSecret(created), JSON.stringify(created).slice(0, 140));
  if (!created.ok) throw new Error("createProvider: " + created.error);
  const providerId = created.provider.providerId;

  const model = identity.modelService.createModel({ context, providerId, remoteModelId: "fake-model", capabilities: ["chat"], scope: "PERSONAL" });
  check("D1.5 · 建 Model Config（chat）", model.ok === true, JSON.stringify(model).slice(0, 120));
  const configId = model.model.configId;
  identity.modelService.setDefault({ context, capability: "chat", configId, scope: "PERSONAL" });
  const defaults = identity.modelService.getDefaults({ context });
  check("D1.6 · chat 默认指向该 config", defaults.ok === true && defaults.personal.chat === configId, JSON.stringify(defaults.personal));

  const status1 = identity.modelService.credentialStatusForProvider({ context, providerId });
  check("D1.7 · credential/status = CONFIGURED v1", status1.ok === true && status1.configured === true && status1.credentialVersion === 1 && status1.storeAvailable === true, JSON.stringify(status1));

  const test = await identity.modelService.testConnection({ context, configId });
  check("D1.8 · 真实调用成功（credential 被 Provider 接受）", test.ok === true && test.credentialAccepted === true, JSON.stringify(test));
  check("D1.9 · test 响应不含 raw secret", noSecret(test), "");

  const files = listCredentialFiles(USERDATA);
  check("D1.10 · secure backend 落盘为 credentials/*.bin", files.length === 1, "count=" + files.length);
  let mode = null;
  try { mode = (fs.statSync(path.join(USERDATA, "credentials", files[0])).mode & 0o777).toString(8); } catch { /* ignore */ }
  check("D1.11 · blob 文件权限 0600", mode === "600", "mode=" + mode);
  const leak1 = scanPlaintext(USERDATA);
  check("D1.12 · 全 userData 无 raw secret 明文", leak1.length === 0, JSON.stringify(leak1));

  const started = await identity.modelProxy.start();
  const issued = identity.modelProxy.issueCapability({ context, configId, maxCalls: 5, ttlMs: 10 * 60 * 1000 });
  check("D1.13 · 旧 proxy 签发 capability", issued.ok === true, JSON.stringify(issued).slice(0, 120));
  const token = issued.capability.token;
  const call = await httpPost(started.baseUrl, token, { capability: "chat", messages: [{ role: "user", content: "hi" }] });
  check("D1.14 · 经 proxy 调用成功", call.ok === true && call.status === 200 && call.json && call.json.ok === true, JSON.stringify(call.json).slice(0, 120));
  check("D1.15 · proxy 响应不含 raw secret", noSecret(call.json), "");

  const calls = identity.modelService.recentCalls(50);
  check("D1.16 · model_call_records 不含 raw secret", noSecret(calls), "n=" + calls.length);
  check("D1.17 · 审计日志不含 raw secret", identity.logger.leaks().length === 0, "leaks=" + identity.logger.leaks().length);

  const configBefore = identity.modelStore.configById(configId);
  report.state = { providerId, configId, configVersion: configBefore.version, credentialVersion: 1, oldToken: token, oldPort: started.port, oldExpiresAt: issued.capability.expiresAt, oldMaxCalls: issued.capability.maxCalls, userId: login.user.id };
  await identity.modelProxy.stop();
  identity.store.close();
}

async function phase2() {
  const { identity, login, context } = await boot();
  check("D2.1 · 重启后 secure backend 仍可用", identity.credentialStore.available() === true && identity.credentialStore.backend.kind === "electron-safe-storage", "kind=" + identity.credentialStore.backend.kind);

  const providers = identity.modelService.listProviders({ context });
  const trimSlash = (u) => String(u || "").replace(/\/$/, "");
  check("D2.2 · Provider 元数据跨重启保留", providers.ok === true && providers.items.length === 1 && trimSlash(providers.items[0].baseUrl) === trimSlash(PROVIDER_URL) && providers.items[0].credentialConfigured === true, JSON.stringify(providers.items).slice(0, 200));
  const providerId = providers.items[0].providerId;
  const models = identity.modelService.listModels({ context });
  const config = models.items[0];
  const configId = config.configId;
  check("D2.3 · Model Config 跨重启保留", config.remoteModelId === "fake-model" && config.capabilities.includes("chat"), JSON.stringify(config).slice(0, 160));
  check("D2.4 · config.version 无改动不漂移", config.version === Number(process.env.OA_EXPECT_CONFIG_VERSION || 0), "v=" + config.version);
  const defaults = identity.modelService.getDefaults({ context });
  check("D2.5 · chat 默认跨重启保留", defaults.personal.chat === configId, JSON.stringify(defaults.personal));
  const g = settingsGrant(identity);
  check("D2.6 · settings App identity/权限跨重启保留", !!(g.app && g.app.built_in === 1) && JSON.stringify(g.actions) === JSON.stringify(["model.manage", "model.test", "model.use", "model.view"]), JSON.stringify(g.actions));

  const status = identity.modelService.credentialStatusForProvider({ context, providerId });
  check("D2.7 · credential/status 跨重启 = CONFIGURED v1", status.configured === true && status.credentialVersion === 1 && status.storeAvailable === true, JSON.stringify(status));
  check("D2.8 · 重启后无 raw secret 明文落盘", scanPlaintext(USERDATA).length === 0, "");

  const chat = await identity.modelService.chat({ context, configId, messages: [{ role: "user", content: "after-restart-v1" }], capability: "chat" });
  check("D2.9 · 重启后 credential 仍可用于真实调用", chat.ok === true, JSON.stringify(chat).slice(0, 140));
  check("D2.10 · 调用响应不含 raw secret", noSecret(chat), "");

  // 旧 capability 在被使用前先确认它未过期、未耗尽 —— 因此 DENY 只能归因于"重启"。
  const oldStillValid = OLD_EXPIRES > Date.now();
  check("D2.11 · 旧 capability 未过期（DENY 不因 TTL）", oldStillValid, "expiresInMs=" + (OLD_EXPIRES - Date.now()));

  // 旧进程端口在新进程启动前必须已释放。
  const dead = await httpPost("http://127.0.0.1:" + OLD_PORT, "irrelevant", { capability: "chat", messages: [] });
  check("D2.12 · 重启后旧 proxy endpoint 已关闭（connection refused）", dead.ok === false, "err=" + (dead.error || "").slice(0, 60));

  const started = await identity.modelProxy.start();
  check("D2.13 · 新进程 Model Proxy 重新启动", started.port > 0 && started.baseUrl.startsWith("http://127.0.0.1:"), started.baseUrl);
  const oldAttempt = await httpPost(started.baseUrl, OLD_TOKEN, { capability: "chat", messages: [{ role: "user", content: "old-cap" }] });
  check("D2.14 · 旧 capability 打新 proxy → DENY", oldAttempt.ok === true && oldAttempt.status === 401 && oldAttempt.json && oldAttempt.json.error === "PROXY_UNAUTHORIZED", JSON.stringify(oldAttempt.json));

  const issued = identity.modelProxy.issueCapability({ context, configId, maxCalls: 2 });
  const newToken = issued.capability.token;
  const newCall = await httpPost(started.baseUrl, newToken, { capability: "chat", messages: [{ role: "user", content: "new-cap" }] });
  check("D2.15 · 新 capability 打新 proxy → PASS", newCall.ok === true && newCall.status === 200 && newCall.json && newCall.json.ok === true, JSON.stringify(newCall.json).slice(0, 120));
  const portA = started.port;

  const replaced = identity.modelService.replaceProviderCredential({ context, providerId, secret: SECRET_V2 });
  check("D2.16 · replace → credentialVersion++ (v2)", replaced.ok === true && replaced.credentialVersion === 2, JSON.stringify(replaced));
  check("D2.17 · replace 后无 raw secret 明文落盘", scanPlaintext(USERDATA).length === 0, "");
  const status2 = identity.modelService.credentialStatusForProvider({ context, providerId });
  check("D2.18 · replace 后 status = CONFIGURED v2", status2.configured === true && status2.credentialVersion === 2, JSON.stringify(status2));

  // stop / start：旧端口释放，新监听端口不同 → 无端口/socket/handler 泄漏。
  await identity.modelProxy.stop();
  check("D2.19 · stop 后 server 句柄已释放", identity.modelProxy.server === null && identity.modelProxy.baseUrl === null, "");
  const afterStop = await httpPost("http://127.0.0.1:" + portA, newToken, { capability: "chat", messages: [] });
  check("D2.20 · stop 后旧端口 connection refused", afterStop.ok === false, "err=" + (afterStop.error || "").slice(0, 60));
  const restarted = await identity.modelProxy.start();
  check("D2.21 · 再次 start 端口已变化", restarted.port !== portA, "old=" + portA + " new=" + restarted.port);
  const issued2 = identity.modelProxy.issueCapability({ context, configId, maxCalls: 1 });
  const call2 = await httpPost(restarted.baseUrl, issued2.capability.token, { capability: "chat", messages: [{ role: "user", content: "restart-cap" }] });
  check("D2.22 · 再次 start 后 capability 可用", call2.ok === true && call2.status === 200 && call2.json.ok === true, JSON.stringify(call2.json).slice(0, 100));
  await identity.modelProxy.stop();
  const afterStop2 = await httpPost("http://127.0.0.1:" + restarted.port, issued2.capability.token, { capability: "chat", messages: [] });
  check("D2.23 · 第二次 stop 后端口释放", afterStop2.ok === false, "");

  const calls = identity.modelService.recentCalls(50);
  check("D2.24 · model_call_records / 日志不含 raw secret", noSecret(calls) && identity.logger.leaks().length === 0, "n=" + calls.length);
  report.state = { newPort: restarted.port, credentialVersion: 2 };
  identity.store.close();
}

async function phase3() {
  const { identity, login, context } = await boot();
  const providers = identity.modelService.listProviders({ context });
  const providerId = providers.items[0].providerId;
  const configId = identity.modelService.listModels({ context }).items[0].configId;

  const status = identity.modelService.credentialStatusForProvider({ context, providerId });
  check("D3.1 · replace 结果跨重启保留 = v2", status.configured === true && status.credentialVersion === 2, JSON.stringify(status));
  const chat = await identity.modelService.chat({ context, configId, messages: [{ role: "user", content: "after-restart-v2" }], capability: "chat" });
  check("D3.2 · 重启后使用 v2 credential 真实调用成功", chat.ok === true, JSON.stringify(chat).slice(0, 120));

  const del = identity.modelService.deleteProviderCredential({ context, providerId });
  check("D3.3 · delete credential → changed", del.ok === true && del.changed === true && del.configured === false, JSON.stringify(del));
  const statusAfter = identity.modelService.credentialStatusForProvider({ context, providerId });
  check("D3.4 · delete 后 status = DELETED / configured=false", statusAfter.configured === false && statusAfter.status === "DELETED", JSON.stringify(statusAfter));
  const chatAfter = await identity.modelService.chat({ context, configId, messages: [{ role: "user", content: "after-delete" }], capability: "chat" });
  check("D3.5 · delete 后调用 DENY CREDENTIAL_MISSING", chatAfter.ok === false && chatAfter.error === "CREDENTIAL_MISSING", JSON.stringify(chatAfter));
  check("D3.6 · delete 后无 raw secret 明文落盘", scanPlaintext(USERDATA).length === 0, "");
  check("D3.7 · 日志 / call records 不含 raw secret", identity.logger.leaks().length === 0 && noSecret(identity.modelService.recentCalls(50)), "");
  report.state = { providerId };
  identity.store.close();
}

async function phase4() {
  const { identity, login, context } = await boot();
  const providers = identity.modelService.listProviders({ context });
  const provider = providers.items[0];
  const configId = identity.modelService.listModels({ context }).items[0].configId;
  check("D4.1 · delete 结果跨重启保留（provider 元数据仍在）", provider.credentialConfigured === true, JSON.stringify(provider).slice(0, 140));
  const status = identity.modelService.credentialStatusForProvider({ context, providerId: provider.providerId });
  check("D4.2 · 重启后 status 仍为 DELETED / configured=false", status.configured === false && status.status === "DELETED", JSON.stringify(status));
  const chat = await identity.modelService.chat({ context, configId, messages: [{ role: "user", content: "after-delete-restart" }], capability: "chat" });
  check("D4.3 · 旧 credential 未复活：DENY CREDENTIAL_MISSING", chat.ok === false && chat.error === "CREDENTIAL_MISSING", JSON.stringify(chat));

  // DB 有 credentialRef、secure item 缺失 → 合法故障态，必须安全失败。
  const created = identity.modelService.createProvider({ context, displayName: "Missing Item", baseUrl: PROVIDER_URL, scope: "PERSONAL", credentialSecret: SECRET_V3 });
  if (!created.ok) { check("D4.4 · 建 missing-item provider", false, JSON.stringify(created)); throw new Error("createProvider missing: " + created.error); }
  const providerId2 = created.provider.providerId;
  const model2 = identity.modelService.createModel({ context, providerId: providerId2, remoteModelId: "fake-model-2", capabilities: ["chat"], scope: "PERSONAL" });
  const configId2 = model2.model.configId;
  const p2 = identity.modelStore.providerById(providerId2);
  const ref = p2.credential_ref;
  const binPath = path.join(USERDATA, "credentials", ref + ".bin");
  let removed = false;
  try { fs.rmSync(binPath, { force: true }); removed = !fs.existsSync(binPath); } catch { /* ignore */ }
  check("D4.4 · 直接删除 secure item（保留 DB credentialRef）", removed === true && !!ref, "refPresent=" + !!ref);
  const statusMissing = identity.modelService.credentialStatusForProvider({ context, providerId: providerId2 });
  check("D4.5 · DB 元数据仍 CONFIGURED（recording 层不误报）", statusMissing.configured === true && statusMissing.status === "CONFIGURED" && statusMissing.credentialVersion === 1, JSON.stringify(statusMissing));
  let threw = false; let chatMissing = null;
  try { chatMissing = await identity.modelService.chat({ context, configId: configId2, messages: [{ role: "user", content: "missing-item" }], capability: "chat" }); } catch (e) { threw = true; }
  check("D4.6 · secure item 缺失 → 安全失败 CREDENTIAL_MISSING（不抛栈）", threw === false && chatMissing && chatMissing.ok === false && chatMissing.error === "CREDENTIAL_MISSING", JSON.stringify(chatMissing));
  check("D4.7 · 缺失态不落任何 plaintext fallback", scanPlaintext(USERDATA).length === 0 && !fs.existsSync(binPath), "");

  // safeStorage 不可用：模型凭证边界必须 CREDENTIAL_STORE_UNAVAILABLE，绝不落盘。
  const nbDir = path.join(USERDATA, "no-backend");
  const nb = createModelBundle({ identityStore: identity.store, authorization: identity.authorization, authStore: identity.authStore, userDataDir: nbDir, safeStorage: null });
  check("D4.8 · 无安全后端 → store 不可用", nb.credentialStore.available() === false, "kind=" + (nb.credentialStore.backend ? nb.credentialStore.backend.kind : "null"));
  const nbCreate = nb.credentialStore.createSync({ ownerUserId: login.user.id, organizationId: login.user.team_id, scope: "PERSONAL", providerOrigin: "http://127.0.0.1:9", providerConfigId: null, secret: SECRET_V3 });
  check("D4.9 · 无安全后端 → CREDENTIAL_STORE_UNAVAILABLE（无明文 fallback）", nbCreate.ok === false && nbCreate.error === "CREDENTIAL_STORE_UNAVAILABLE", JSON.stringify(nbCreate));
  check("D4.10 · 无安全后端不创建 credentials 目录", !fs.existsSync(path.join(nbDir, "credentials")), "");
  check("D4.11 · 日志不含 raw secret", identity.logger.leaks().length === 0, "");
  report.state = { providerId2 };
  identity.store.close();
}

async function main() {
  if (!USERDATA) throw new Error("OA_USERDATA 缺失");
  app.setPath("userData", USERDATA);
  await app.whenReady();
  if (PHASE === "1") await phase1();
  else if (PHASE === "2") await phase2();
  else if (PHASE === "3") await phase3();
  else if (PHASE === "4") await phase4();
  else throw new Error("未知 phase: " + PHASE);
}

main()
  .catch((e) => { report.errors.push(String((e && e.stack) || e)); check("phase " + PHASE + " 整体未抛异常", false, String(e && e.message).slice(0, 200)); })
  .finally(() => {
    out("RESULT " + JSON.stringify(report));
    app.quit();
  });
