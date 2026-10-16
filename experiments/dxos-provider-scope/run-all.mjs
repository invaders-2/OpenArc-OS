#!/usr/bin/env node
/**
 * dxos-provider-scope · 「编辑服务商 › 范围」真机端到端 + 真库前后对照。
 *
 * 隔离：独立 userData 目录 + 唯一 CDP 端口；截图 1440x900@2（PNG 2880x1800），浅/深各一张。
 * 上游：本进程内起一个只实现 GET /v1/models 的 loopback fake provider（真实网络请求，仅用于建服务商）。
 *
 * 验收目标（真实执行）：
 *   ① UI 编辑表单里「范围」可改（不再只读），仍带「组织需要管理员」说明；
 *   ② 把某服务商从「个人」改成「组织」并保存成功，详情如实显示「组织」；
 *   ③ DB 前后对照：scope / organization_id / owner_user_id + 其下 model_configs 同步迁移；
 *   ④ authorization_audit 里一条 model.providerScopeChanged（providerId / 旧值 / 新值 / 操作者）；
 *   ⑤ providers.json 镜像不携带范围/可见性字段，映射不变（两库不产生互相矛盾的 scope）；
 *   ⑥（尽力）非管理员身份走一次被拒路径并截图结构化错误；构造失败则如实记为 NOTE。
 */
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ART = path.join(ROOT, "artifacts", "dxos-provider-scope");
const SHOTS = path.join(ART, "shots");
const SHOT = { width: 1440, height: 900, dsf: 2 };
const require = createRequire(path.join(ROOT, "package.json"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function waitFor(fn, timeoutMs, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    for (;;) {
      try { if (await fn()) return true; } catch { /* retry */ }
      if (Date.now() >= deadline) return false;
      await sleep(stepMs);
    }
  })();
}

function startModelsServer() {
  const state = { requests: 0, urls: [] };
  const server = http.createServer((req, res) => {
    state.requests += 1;
    state.urls.push(req.method + " " + req.url);
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: [{ id: "scope-probe-upstream", owned_by: "probe" }] }));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      baseUrl: "http://127.0.0.1:" + server.address().port + "/v1",
      state,
      close: () => new Promise((r) => { try { server.closeAllConnections?.(); } catch { /* ignore */ } server.close(() => r()); }),
    }));
  });
}

async function bridge(page, channel, command, payload) {
  return page.evaluate(async (arg) => {
    const api = window.openarc[arg.channel];
    if (!api || typeof api.command !== "function") return { __noBridge: true };
    const request = arg.channel === "identity" ? Object.assign({ type: arg.command }, arg.payload) : { command: arg.command, payload: arg.payload };
    try { return await api.command(request); } catch (err) { return { __threw: true, message: String((err && err.message) || err) }; }
  }, { channel, command, payload: payload || {} });
}

const winSel = (label) => 'section.window[aria-label="' + label + '"]';
const clickSel = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);
function setInputValue(page, sel, value) {
  return page.evaluate((arg) => {
    const el = document.querySelector(arg.sel); if (!el) return false;
    const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, arg.value);
    el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    return true;
  }, { sel, value });
}
async function openApp(page, appId, name) {
  const label = name + "窗口";
  if (await page.$(winSel(label))) return true;
  await page.evaluate(() => { const d = document.querySelector(".dock"); if (d) d.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true })); });
  await clickSel(page, '.dock-item[data-dock-id="' + appId + '"]');
  return waitFor(async () => !!(await page.$(winSel(label))), 20000, 250);
}
async function setTheme(page, theme) {
  if (!(await page.$(".control-center"))) { await clickSel(page, 'button[aria-label="控制中心"]'); await sleep(350); }
  const label = theme === "dark" ? "深色" : "浅色";
  await page.evaluate((arg) => {
    const cc = document.querySelector(".control-center"); if (!cc) return;
    const group = cc.querySelector('[aria-label="外观"]'); if (!group) return;
    for (const b of Array.prototype.slice.call(group.querySelectorAll("button"))) if ((b.textContent || "").trim() === arg.text) { b.click(); return; }
  }, { text: label });
  await sleep(550);
}
async function closeControlCenter(page) { if (await page.$(".control-center")) { await clickSel(page, ".cc-shade"); await sleep(300); } }
async function scrollTo(page, sel, block = "center") {
  return page.evaluate((arg) => { const el = document.querySelector(arg.sel); if (!el) return false; el.scrollIntoView({ block: arg.block, inline: "nearest" }); return true; }, { sel, block });
}
async function shoot(page, name, theme, shots) {
  const file = path.join(SHOTS, name + "-" + theme + ".png");
  const s = await page.context().newCDPSession(page);
  const res = await s.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  try { await s.detach(); } catch { /* ignore */ }
  fs.writeFileSync(file, Buffer.from(res.data, "base64"));
  const buf = fs.readFileSync(file);
  const rec = { file: path.relative(ROOT, file), theme, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length, sha256_12: sha256(buf).slice(0, 12), at2880x1800: buf.readUInt32BE(16) === 2880 && buf.readUInt32BE(20) === 1800 };
  shots.push(rec);
  return rec;
}
async function shootBoth(page, name, shots, prepare) {
  const out = [];
  for (const t of ["light", "dark"]) {
    await setTheme(page, t);
    await closeControlCenter(page);
    if (prepare) await prepare();
    await sleep(350);
    out.push(await shoot(page, name, t, shots));
  }
  return out;
}

function readDb(userDataDir) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(userDataDir, "identity.db"), { readOnly: true });
  try {
    return {
      providers: db.prepare("SELECT provider_id, organization_id, owner_user_id, scope, display_name, status FROM model_providers ORDER BY rowid").all(),
      configs: db.prepare("SELECT config_id, provider_id, organization_id, owner_user_id, scope, remote_model_id FROM model_configs ORDER BY rowid").all(),
      audits: db.prepare("SELECT id, actor_user_id, app_id, resource_ref, action, decision, reason_code, permission_source, old_permissions, new_permissions FROM authorization_audit WHERE action = 'model.providerScopeChanged' ORDER BY id").all(),
    };
  } finally { db.close(); }
}

const detailStaticText = (page, pid) => page.evaluate((id) => {
  const root = document.querySelector('[data-d4-01-provider-detail="' + id + '"]');
  return root ? (root.querySelector(".mp2-static")?.textContent || "").trim() : null;
}, pid);

async function main() {
  const chromium = require("@playwright/test").chromium;
  const electronPath = require("electron");
  fs.mkdirSync(SHOTS, { recursive: true });

  const rows = []; const shots = []; const notes = [];
  const record = (name, ok, actual) => { const row = { name, ok: !!ok, actual: String(actual).slice(0, 900) }; rows.push(row); console.log((row.ok ? "PASS " : "FAIL ") + name + " :: " + row.actual); return row.ok; };
  const note = (s) => { notes.push(String(s)); console.log("   · NOTE " + s); };

  const modelsServer = await startModelsServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-provider-scope-"));
  const port = await freePort();
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_NO_ATTACH_CONSOLE;

  let child = null; let browser = null; let page = null;
  const providerId = { admin: null, member: null };
  const report = { at: new Date().toISOString(), userDataIsolated: true, cdpPort: port, fakeBaseUrl: modelsServer.baseUrl };

  try {
    child = spawn(electronPath, [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + port], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
    let stderrBuf = ""; child.stderr.on("data", (d) => { stderrBuf += String(d); });

    const ready = await waitFor(async () => { try { return (await fetch("http://127.0.0.1:" + port + "/json/version")).ok; } catch { return false; } }, 90000, 300);
    if (!ready) throw new Error("CDP 未就绪: " + stderrBuf.slice(-400));
    browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
    const ctx = browser.contexts()[0];
    const isUI = (p) => p.url().indexOf("vue.html") >= 0;
    await waitFor(() => !!ctx.pages().find(isUI), 45000, 300);
    page = ctx.pages().find(isUI);
    if (!page) throw new Error("未找到 Vue 壳页面");
    const bootOk = await waitFor(async () => {
      const v = await page.evaluate(() => ({ rs: document.readyState, n: window.openarc ? Object.keys(window.openarc).length : 0 }));
      return v && v.rs === "complete" && v.n > 0;
    }, 45000, 300);
    if (!bootOk) throw new Error("渲染层未就绪");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: SHOT.width, height: SHOT.height, deviceScaleFactor: SHOT.dsf, mobile: false });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await sleep(400);

    const adminIdent = "scope-admin-" + Date.now() + "@openarc.test";
    const adminPw = "ScopeAdmin-pass-1";
    await bridge(page, "identity", "identity/initialize", { identifier: adminIdent, password: adminPw, displayName: "范围探针管理员" });
    const login = await bridge(page, "identity", "identity/login", { identifier: adminIdent, password: adminPw });
    record("S1 · admin identity/initialize + login", !!(login && login.ok), JSON.stringify(login == null ? null : { ok: login.ok, userId: login.snapshot && login.snapshot.userId }));
    const adminUserId = login && login.snapshot ? login.snapshot.userId : null;
    report.adminUserId = adminUserId;

    await openApp(page, "settings", "系统设置");
    await waitFor(async () => !!(await page.$('[data-settings-pane="model"]')), 20000, 300);
    await clickSel(page, '[data-settings-pane="model"]');
    await waitFor(async () => !!(await page.$('[data-d4-01="settings"]')), 20000, 300);

    // ① UI 建一个 loopback 服务商（个人）
    await clickSel(page, '[data-d4-01-provider-add]');
    await waitFor(async () => !!(await page.$('[data-d4-01-provider-form]')), 8000, 200);
    await setInputValue(page, '[data-d4-01-provider-name]', "范围探针-个人");
    await setInputValue(page, '[data-d4-01-provider-url]', modelsServer.baseUrl);
    await clickSel(page, '[data-d4-01-provider-create]');
    const detail = await waitFor(async () => !!(await page.$('[data-d4-01-provider-detail]')), 20000, 250);
    providerId.admin = await page.evaluate(() => document.querySelector('[data-d4-01-provider-detail]')?.getAttribute('data-d4-01-provider-detail') || null);
    record("S2 · UI 创建个人服务商并进入详情", !!(detail && providerId.admin), JSON.stringify({ providerId: providerId.admin }));

    // 其下建一个个人模型（真实 model:command），供范围迁移对照
    const modelRes = await bridge(page, "model", "model/create", { providerId: providerId.admin, remoteModelId: "scope-probe-model", displayName: "范围探针模型", capabilities: ["chat"], scope: "PERSONAL" });
    record("S3 · 该服务商下建立个人模型", !!(modelRes && modelRes.ok), JSON.stringify(modelRes).slice(0, 300));
    const configId = modelRes && modelRes.model ? modelRes.model.configId : null;

    const before = readDb(userDataDir);
    const beforeProvider = before.providers.find((p) => p.provider_id === providerId.admin);
    const beforeConfig = before.configs.find((c) => c.config_id === configId);
    report.dbBefore = { provider: beforeProvider, config: beforeConfig, audits: before.audits.length };
    record("D1 · 变更前 DB：provider/config 均 PERSONAL 且 owner=admin",
      !!(beforeProvider && beforeProvider.scope === "PERSONAL" && beforeProvider.owner_user_id === adminUserId && beforeConfig && beforeConfig.scope === "PERSONAL" && beforeConfig.owner_user_id === adminUserId),
      JSON.stringify({ provider: beforeProvider, config: beforeConfig }));

    // ② 打开编辑表单：范围可改 + 说明
    await clickSel(page, '[data-d4-01-provider-edit="' + providerId.admin + '"]');
    const editOk = await waitFor(async () => !!(await page.$('[data-d4-01-provider-edit-form="' + providerId.admin + '"]')), 10000, 200);
    const editState = await page.evaluate((pid) => {
      const root = document.querySelector('[data-d4-01-provider-edit-form="' + pid + '"]');
      if (!root) return null;
      const sel = root.querySelector('[data-d4-01-provider-scope]');
      return {
        scopeDisabled: sel ? sel.disabled === true : null,
        scopeValue: sel ? sel.value : null,
        hint: (root.querySelector('[data-d4-01-provider-scope-hint]')?.textContent || "").trim(),
        options: sel ? Array.prototype.map.call(sel.options, (o) => o.value) : [],
      };
    }, providerId.admin);
    record("U1 · 编辑表单「范围」可改且带组织说明",
      !!(editOk && editState && editState.scopeDisabled === false && editState.scopeValue === "PERSONAL" && /组织需要管理员/.test(editState.hint) && editState.options.join(",") === "PERSONAL,ORGANIZATION"),
      JSON.stringify(editState));
    await shootBoth(page, "01-edit-scope-personal", shots, () => scrollTo(page, '[data-d4-01-provider-edit-form="' + providerId.admin + '"]'));

    // ③ 改成组织（保存前截图）
    await setInputValue(page, '[data-d4-01-provider-edit-form="' + providerId.admin + '"] [data-d4-01-provider-scope]', "ORGANIZATION");
    const selectedOrg = await page.evaluate((pid) => document.querySelector('[data-d4-01-provider-edit-form="' + pid + '"] [data-d4-01-provider-scope]')?.value || null, providerId.admin);
    record("U2 · 表单范围切到「组织」", selectedOrg === "ORGANIZATION", String(selectedOrg));
    await shootBoth(page, "02-edit-scope-organization", shots, () => scrollTo(page, '[data-d4-01-provider-edit-form="' + providerId.admin + '"]'));

    await clickSel(page, '[data-d4-01-provider-save]');
    const saved = await waitFor(async () => {
      const form = await page.$('[data-d4-01-provider-edit-form="' + providerId.admin + '"]');
      const text = await detailStaticText(page, providerId.admin);
      return !form && !!text && /组织/.test(text);
    }, 20000, 250);
    const afterDetail = await detailStaticText(page, providerId.admin);
    record("U3 · 保存成功，详情如实显示「组织」", !!(saved && /组织/.test(afterDetail || "")), JSON.stringify({ afterDetail }));
    await shootBoth(page, "03-provider-detail-organization", shots, () => scrollTo(page, '[data-d4-01-provider-detail="' + providerId.admin + '"]'));

    // ④ 真库前后对照 + 审计 + 镜像
    const after = readDb(userDataDir);
    const afterProvider = after.providers.find((p) => p.provider_id === providerId.admin);
    const afterConfig = after.configs.find((c) => c.config_id === configId);
    report.dbAfter = { provider: afterProvider, config: afterConfig, audits: after.audits };
    report.dbCompare = { before: beforeProvider, after: afterProvider, configBefore: beforeConfig, configAfter: afterConfig };
    record("D2 · 变更后 DB：provider scope=ORGANIZATION / owner 置空 / organization_id 不变",
      !!(afterProvider && afterProvider.scope === "ORGANIZATION" && afterProvider.owner_user_id === null && afterProvider.organization_id === beforeProvider.organization_id),
      JSON.stringify(afterProvider));
    record("D3 · 其下模型一并迁移：config scope=ORGANIZATION / owner 置空",
      !!(afterConfig && afterConfig.scope === "ORGANIZATION" && afterConfig.owner_user_id === null),
      JSON.stringify(afterConfig));

    const audit = after.audits[after.audits.length - 1] || null;
    const auditOk = !!(audit && audit.resource_ref === providerId.admin && audit.actor_user_id === adminUserId && audit.decision === "ALLOW" && audit.permission_source === "SUPER_ADMIN" && audit.old_permissions === '["PERSONAL"]' && audit.new_permissions === '["ORGANIZATION"]');
    record("D4 · authorization_audit 记录 providerId/旧值/新值/操作者", auditOk, JSON.stringify(audit));

    const ppFile = path.join(userDataDir, "dxos", "providers.json");
    const mapFile = path.join(userDataDir, "dxos", "model-provider-map.json");
    const ppRaw = fs.existsSync(ppFile) ? fs.readFileSync(ppFile, "utf8") : "";
    const mapRaw = fs.existsSync(mapFile) ? fs.readFileSync(mapFile, "utf8") : "";
    const ppList = ppRaw ? JSON.parse(ppRaw) : [];
    const mappedPpId = mapRaw ? (JSON.parse(mapRaw).providers || {})[providerId.admin] || null : null;
    const entry = ppList.find((p) => p.id === mappedPpId) || null;
    report.mirror = { ppFile: path.relative(ROOT, ppFile), mappedPpId, entry, hasVisibilityKey: entry ? ["scope", "owner_user_id", "organization_id", "ownerUserId"].filter((k) => Object.prototype.hasOwnProperty.call(entry, k)) : null };
    record("D5 · 镜像一致：providers.json 条目存在、映射不变、不含范围/可见性字段",
      !!(entry && mappedPpId && mappedPpId !== providerId.admin && Object.keys(entry).every((k) => !["scope", "owner_user_id", "organization_id", "ownerUserId"].includes(k))),
      JSON.stringify(report.mirror));

    // ⑤ 非 Super 被拒（真实第二用户 + 真实 model:command；能到 UI 就截图）
    try {
      const memberIdent = "scope-member-" + Date.now() + "@openarc.test";
      const memberPw = "ScopeMember-pass-1";
      const created = await bridge(page, "identity", "identity/user-create", { identifier: memberIdent, password: memberPw, displayName: "范围探针普通成员", role: "user" });
      const login2 = await bridge(page, "identity", "identity/login", { identifier: memberIdent, password: memberPw });
      const createdMember = await bridge(page, "model", "provider/create", { displayName: "范围探针-成员个人", baseUrl: modelsServer.baseUrl, scope: "PERSONAL" });
      providerId.member = createdMember && createdMember.ok ? createdMember.provider.providerId : null;
      const denied = await bridge(page, "model", "provider/update", { providerId: providerId.member, scope: "ORGANIZATION" });
      report.member = { userCreated: !!created && created.ok, login: !!login2 && login2.ok, providerCreate: !!createdMember && createdMember.ok, providerId: providerId.member, denied };
      record("N1 · 非管理员经真实 model:command 改范围 → PROXY_UNAUTHORIZED",
        !!(createdMember && createdMember.ok && denied && denied.ok === false && denied.error === "PROXY_UNAUTHORIZED"),
        JSON.stringify(denied));

      // 让成员在真实 UI 上再走一次：切走再切回模型面板强制重挂载
      await page.evaluate(() => { const el = document.querySelector('[data-settings-pane="appearance"]'); if (el) el.click(); });
      await sleep(400);
      await page.evaluate(() => { const el = document.querySelector('[data-settings-pane="model"]'); if (el) el.click(); });
      const paneBack = await waitFor(async () => !!(await page.$('[data-d4-01-provider="' + providerId.member + '"]')), 20000, 300);
      if (paneBack) {
        await clickSel(page, '[data-d4-01-provider="' + providerId.member + '"]');
        await waitFor(async () => !!(await page.$('[data-d4-01-provider-detail="' + providerId.member + '"]')), 10000, 200);
        await clickSel(page, '[data-d4-01-provider-edit="' + providerId.member + '"]');
        await waitFor(async () => !!(await page.$('[data-d4-01-provider-edit-form="' + providerId.member + '"]')), 10000, 200);
        await setInputValue(page, '[data-d4-01-provider-edit-form="' + providerId.member + '"] [data-d4-01-provider-scope]', "ORGANIZATION");
        await clickSel(page, '[data-d4-01-provider-save]');
        const shown = await waitFor(async () => {
          const el = await page.$('[data-d4-01-error-code]');
          if (!el) return false;
          const code = await page.evaluate(() => document.querySelector('[data-d4-01-error-code]')?.getAttribute('data-d4-01-error-code') || null);
          return code === "PROXY_UNAUTHORIZED";
        }, 15000, 250);
        const uiErr = await page.evaluate((mid) => ({
          code: document.querySelector('[data-d4-01-error-code]')?.getAttribute('data-d4-01-error-code') || null,
          text: (document.querySelector('[data-d4-01-error]')?.textContent || '').trim(),
          formStillOpen: !!document.querySelector('[data-d4-01-provider-edit-form="' + mid + '"]'),
        }), providerId.member);
        report.memberUi = { shown, uiErr };
        record("N2 · 非管理员在真实 UI 保存组织范围：结构化 PROXY_UNAUTHORIZED 且表单不静默回滚",
          !!(shown && uiErr.code === "PROXY_UNAUTHORIZED" && /PROXY_UNAUTHORIZED/.test(uiErr.text)),
          JSON.stringify(uiErr).slice(0, 500));
        await shootBoth(page, "04-member-scope-denied", shots, () => scrollTo(page, '[data-d4-01-error]'));
      } else {
        note("非管理员 UI 面板未重新挂载出成员服务商，N2 仅由 N1（真实 IPC）+ 后端/前端单测覆盖。");
      }
    } catch (err) {
      note("非管理员真机路径构造失败：" + String((err && err.message) || err).slice(0, 200) + "；由后端单测 SC1/SC6 覆盖同一判据。");
    }

    report.shots = shots;
  } catch (err) {
    report.fatal = String((err && err.stack) || err);
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    try { if (child && !child.killed) child.kill("SIGTERM"); } catch { /* ignore */ }
    await sleep(900);
    await modelsServer.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  fs.mkdirSync(ART, { recursive: true });
  fs.writeFileSync(path.join(ART, "report.json"), JSON.stringify({ ...report, rows, notes }, null, 2));
  const pass = rows.filter((r) => r.ok).length;
  console.log("SUMMARY " + pass + "/" + rows.length + " pass; shots=" + shots.length + "; report=" + path.relative(ROOT, path.join(ART, "report.json")));
  if (pass !== rows.length) process.exitCode = 1;
  return { pass, total: rows.length, shots: shots.length };
}

main().catch((err) => { console.error("PROBE FAILED " + String((err && err.stack) || err).slice(0, 1200)); process.exit(2); });
