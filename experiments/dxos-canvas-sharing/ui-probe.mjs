#!/usr/bin/env node
/**
 * DXOS-CANVAS-SHARING · P2 真机多账号验收（宿主共享面板 + 列表入口 + 权限变化自动刷新）。
 *
 * 真实 Electron 两个进程（同一隔离 userData，两个并发账号）+ 真实产品 UI：
 *   A 进程：管理员（超管），建账号 / 建画布 / 授共享 / 在面板里改角色、移除、切可见性、转移；
 *   B 进程：查看者 / 编辑者 / 管理共享 三种普通 MEMBER 账号依次登录（既有 identity 命令，不改产品代码）。
 *
 * 覆盖（对应任务第 5 条）：
 *   V  查看者：能打开、页面真只读、面板只有我的角色 + 可见性、DOM 里没有其他成员 ID/名字；
 *   E  编辑者：能编辑并保存、共享命令被拒、面板无管理控件；
 *   M  管理共享：能加/删成员、改角色、切可见性，不能删画布/转移所有者；
 *   L  撤销/降级：A 改角色后 B 的已打开页面自动变只读；A 移除共享后 B 自动回到列表；
 *   O  组织可见：显式编辑者仍可编辑（bug1 回归）；
 *   X  跨组织/停用用户不能被共享（命令拒绝 + 候选人排除）；
 *   0 console error / 0 pageerror；浅/深 + 窄窗截图。
 *
 * 用法：node experiments/dxos-canvas-sharing/ui-probe.mjs
 * 证据：artifacts/dxos-canvas-sharing/real-device.json / REAL-DEVICE.md / shots/**
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const ART = path.join(ROOT, "artifacts", "dxos-canvas-sharing");
const SHOTS = path.join(ART, "shots");
const PORT_A = Number(process.env.OA_SHARE_CDP_A || 9881);
const PORT_B = Number(process.env.OA_SHARE_CDP_B || 9882);
const NL = String.fromCharCode(10);
const ADMIN = { id: "admin@oa-share.test", pw: "oa-share-admin-1", name: "共享管理员" };
const USERS = {
  viewer: { id: "viewer@oa-share.test", pw: "oa-share-viewer-1", name: "查看者小周" },
  editor: { id: "editor@oa-share.test", pw: "oa-share-editor-1", name: "编辑者小吴" },
  manager: { id: "manager@oa-share.test", pw: "oa-share-manager-1", name: "管理者小郑" },
  candidate: { id: "candidate@oa-share.test", pw: "oa-share-candidate-1", name: "候选成员小陈" },
  disabled: { id: "disabled@oa-share.test", pw: "oa-share-disabled-1", name: "停用成员小停" },
  outsider: { id: "outsider@oa-share.test", pw: "oa-share-outsider-1", name: "外组织小外" },
};
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHECKS = [];
let passed = 0, failed = 0;
function check(name, ok, expected, actual) {
  const row = { name, status: ok ? "PASS" : "FAIL", expected: String(expected == null ? "" : expected), actual: typeof actual === "string" ? actual : (actual === undefined ? "" : JSON.stringify(actual)) };
  CHECKS.push(row);
  if (ok) passed += 1; else failed += 1;
  console.log((ok ? "  [PASS] " : "! [FAIL] ") + name + (ok ? "" : " -- 期望 " + row.expected + "，实际 " + row.actual.slice(0, 900)));
  return ok;
}
const note = (text) => console.log("   · " + text);

function realProfilePath() {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "openarc-os");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "openarc-os");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "openarc-os");
}
const statOf = (p) => { try { const s = fs.statSync(p); return { mtimeMs: Math.round(s.mtimeMs), size: s.size, ino: s.ino }; } catch { return { exists: false }; } };
function snapshotProfile(dir) {
  const out = { path: dir, exists: fs.existsSync(dir), identity: {}, topLevel: {} };
  for (const name of ["identity.db", "identity.db-wal", "identity.db-shm"]) out.identity[name] = statOf(path.join(dir, name));
  try { for (const name of fs.readdirSync(dir)) out.topLevel[name] = statOf(path.join(dir, name)); } catch { /* ignore */ }
  return out;
}

let userDataDir = null;
const instances = { a: null, b: null };
const consoleErrors = [];
const pageErrors = [];
const netFails = [];

async function launch(tag, port) {
  const childEnv = { ...process.env, OPENARC_IDENTITY_ADMIN: "1" };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;
  const child = spawn(electronPath, [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + port, ...extraArgs], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: childEnv,
  });
  let stderr = "";
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { stderr += String(d); });
  let version = null;
  const deadline = Date.now() + 90000;
  while (!version && Date.now() < deadline) {
    try { version = await (await fetch("http://127.0.0.1:" + port + "/json/version")).json(); } catch { await sleep(300); }
  }
  if (!version) throw new Error("CDP 未就绪（" + tag + "）：" + stderr.slice(-1200));
  const browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
  const ctx = browser.contexts()[0];
  const isUI = (p) => p.url().includes("/dist/index.html") || p.url().includes("/dist/vue.html");
  let page = null;
  const end = Date.now() + 60000;
  while (!page && Date.now() < end) { page = ctx.pages().find(isUI) || null; if (!page) await sleep(300); }
  if (!page) throw new Error("未找到界面页面（" + tag + "）：" + JSON.stringify(ctx.pages().map((p) => p.url())));
  page.on("dialog", (d) => { void d.dismiss().catch(() => {}); });
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push({ instance: tag, text: m.text().slice(0, 400) }); });
  page.on("pageerror", (e) => { pageErrors.push({ instance: tag, text: String(e.message).slice(0, 400) }); });
  page.on("requestfailed", (r) => { const u = r.url(); if (!u.includes("devtools") && !u.includes("chrome-extension")) netFails.push({ instance: tag, url: u.slice(0, 200), error: String((r.failure() && r.failure().errorText) || "") }); });
  const cdp = await ctx.newCDPSession(page);
  try { await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false }); } catch { /* ignore */ }
  const inst = { tag, port, child, browser, page, cdp, stderr: () => stderr };
  instances[tag] = inst;
  return inst;
}

const js = (inst, code) => inst.page.evaluate("(async () => { " + code + " })()");
const gate = (inst) => js(inst, "const d=document.querySelector('.desktop'); return d ? d.getAttribute('data-identity-gate') : 'no-root';");
async function waitFor(fn, timeout = 30000, step = 200) { const end = Date.now() + timeout; for (;;) { try { if (await Promise.resolve(fn())) return true; } catch { /* retry */ } if (Date.now() >= end) return false; await sleep(step); } }
async function identity(inst, payload) { return await inst.page.evaluate(async (p) => { try { return await window.openarc.identity.command(p); } catch (e) { return { ok: false, error: "THREW", detail: String((e && e.message) || e) }; } }, payload); }
async function canvas(inst, payload) { return await inst.page.evaluate(async (p) => { try { return await window.openarc.canvas.command(p); } catch (e) { return { ok: false, error: "THREW", detail: String((e && e.message) || e) }; } }, payload); }

const frameBy = (inst, needle) => inst.page.frames().find((f) => f.url().includes(needle)) || null;
const listFrame = (inst) => frameBy(inst, "openarc-canvas://bundle/static/canvas-list.html");
const smartFrame = (inst) => frameBy(inst, "openarc-canvas://bundle/static/smart-canvas.html");
async function inFrame(f, code) {
  if (!f) return { __noFrame: true };
  try { return JSON.parse((await f.evaluate("(async () => { return JSON.stringify(await (async () => { " + code + " })()); })()")) || "null"); }
  catch (e) { return { __error: String((e && e.message) || e).slice(0, 300) }; }
}
const shotDir = () => { fs.mkdirSync(SHOTS, { recursive: true }); };
async function shot(inst, name) {
  shotDir();
  const p = path.join(SHOTS, name + ".png");
  try { await inst.page.screenshot({ path: p }); } catch { /* ignore */ }
  return path.relative(ROOT, p);
}
async function resizeNative(inst, width, height) {
  try {
    const cdp = await inst.page.context().newCDPSession(inst.page);
    const got = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", { windowId: got.windowId, bounds: { width, height } });
    return true;
  } catch (e) {
    try { await inst.cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false }); return "emulation"; } catch { return false; }
  }
}
async function openCanvasApp(inst) {
  const clicked = await js(inst, "const el = document.querySelector('[data-dock-id=canvas]') || document.querySelector('[aria-label=打开AI Studio]'); if (!el) return false; el.click(); return true;");
  if (!clicked) return false;
  return await waitFor(() => js(inst, "return !!document.querySelector('[data-canvas-host]')"), 30000);
}
async function waitCard(inst, canvasId) {
  const f = listFrame(inst);
  if (!f) return false;
  return await waitFor(async () => {
    const f2 = listFrame(inst);
    if (!f2) return false;
    const hit = await inFrame(f2, "return !!Array.prototype.slice.call(document.querySelectorAll('#cardsGrid .project-card')).filter(function(c){ return c.getAttribute('data-canvas-id') === " + JSON.stringify(canvasId) + "; })[0];");
    return hit === true;
  }, 25000);
}
async function openCard(inst, canvasId) {
  const f = listFrame(inst);
  if (!f) return false;
  if (!(await waitCard(inst, canvasId))) return false;
  const clicked = await inFrame(f, "const card = Array.prototype.slice.call(document.querySelectorAll('#cardsGrid .project-card')).filter(function(c){ return c.getAttribute('data-canvas-id') === " + JSON.stringify(canvasId) + "; })[0]; if (!card) return 'no-card'; card.click(); return 'clicked';");
  if (clicked !== "clicked") return false;
  return await waitFor(() => !!smartFrame(inst) && !listFrame(inst), 45000);
}
async function openShareFromList(inst, canvasId) {
  const f = listFrame(inst);
  if (!f) { console.log("   · openShareFromList: no list frame"); return false; }
  if (!(await waitCard(inst, canvasId))) { console.log("   · openShareFromList: card not found " + canvasId); return false; }
  const clicked = await inFrame(f, "const card = Array.prototype.slice.call(document.querySelectorAll('#cardsGrid .project-card')).filter(function(c){ return c.getAttribute('data-canvas-id') === " + JSON.stringify(canvasId) + "; })[0]; if (!card) return 'no-card'; card.querySelector('.card-more-btn').click(); const item = card.querySelector('[data-action=share]'); if (!item) return 'no-item'; item.click(); return 'clicked';");
  if (clicked !== "clicked") { console.log("   · openShareFromList: click result " + JSON.stringify(clicked)); return false; }
  const opened = await waitFor(() => js(inst, "const p=document.querySelector('[data-canvas-share-panel]'); return !!p && p.getAttribute('data-canvas-share-ready') === '1';"), 30000);
  if (!opened) console.log("   · openShareFromList: panel not ready within 30s (target " + canvasId + ")");
  return opened;
}
async function closePanel(inst) {
  await inst.page.keyboard.press("Escape");
  return await waitFor(() => js(inst, "return !document.querySelector('[data-canvas-share-panel]')"), 8000);
}
async function panelInfo(inst) {
  return await js(inst, "const p = document.querySelector('[data-canvas-share-panel]'); if (!p) return null; const e = document.querySelector('[data-canvas-share-entry]'); const l = document.querySelector('[data-canvas-share-layer]'); const me = p.querySelector('[data-canvas-share-my-role]'); return { mode: p.getAttribute('data-canvas-share-mode'), canManage: p.getAttribute('data-canvas-share-can-manage'), source: p.getAttribute('data-canvas-share-source'), visibility: p.getAttribute('data-canvas-share-visibility'), members: p.querySelectorAll('[data-share-member]').length, ownerRow: !!p.querySelector('[data-share-owner]'), myRole: me ? me.getAttribute('data-canvas-share-my-role') : null, hasAdd: !!p.querySelector('[data-share-add]'), hasVisibility: !!p.querySelector('[data-share-visibility]'), hasTransfer: !!p.querySelector('[data-share-transfer-open]'), memberIds: Array.prototype.map.call(p.querySelectorAll('[data-share-member]'), function(el){ return el.getAttribute('data-share-member'); }), text: String(p.innerText || '').slice(0, 2000), entry: e ? e.getAttribute('data-canvas-share-entry-label') : null, open: l ? l.getAttribute('data-canvas-share-open') : null };");
}
async function accessOf(inst, canvasId) {
  const r = await canvas(inst, { type: "canvas/access/get", canvasId });
  return r && r.ok ? r : { ok: false, error: (r && r.error) || "UNKNOWN" };
}
async function nodeInfo(inst, canvasId) {
  const r = await canvas(inst, { type: "canvas/get", canvasId });
  return r && r.ok ? { revision: Number(r.canvas.revision || 0), nodes: (r.canvas.doc.nodes || []).length, ids: (r.canvas.doc.nodes || []).map((n) => n.id) } : { error: r && r.error };
}

async function main() {
  fs.mkdirSync(ART, { recursive: true });
  const realProfile = realProfilePath();
  const profileBefore = snapshotProfile(realProfile);
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-share-ui-"));

  const a = await launch("a", PORT_A);
  const b = await launch("b", PORT_B);
  await waitFor(async () => (await gate(a)) === "uninitialized", 60000);
  const gateA0 = await gate(a);
  const gateB0 = await gate(b);
  check("A0 · 两个真实 Electron 进程（同一隔离 userData）都停在未初始化门禁", gateA0 === "uninitialized" && gateB0 === "uninitialized", "uninitialized ×2", { a: gateA0, b: gateB0 });

  const init = await identity(a, { type: "identity/initialize", identifier: ADMIN.id, password: ADMIN.pw, displayName: ADMIN.name });
  check("A1 · identity/initialize 真实建库", !!(init && init.ok), "ok:true", init && init.error);
  const login = await identity(a, { type: "identity/login", identifier: ADMIN.id, password: ADMIN.pw });
  check("A2 · identity/login（管理员）", !!(login && login.ok && login.snapshot && login.snapshot.sessionRef), "ok + snapshot", login && (login.error || (login.snapshot || {}).role));
  await waitFor(async () => (await gate(a)) === "ready", 30000);

  const users = {};
  for (const [key, u] of Object.entries(USERS)) {
    const created = await identity(a, { type: "identity/user-create", identifier: u.id, password: u.pw, displayName: u.name });
    if (!created || !created.ok) throw new Error("创建账号失败 " + key + "：" + JSON.stringify(created));
    users[key] = { ...u, userId: created.user.id, role: created.user.role };
  }
  const disabled = await identity(a, { type: "identity/user-update", userId: users.disabled.userId, status: "disabled" });
  check("A3 · 既有身份命令创建 6 个普通 MEMBER + 停用 1 个（产品判定 role=user，不是 ADMIN）",
    disabled && disabled.ok && Object.values(users).every((u) => u.role === "user"),
    "user-create → role=user；user-update status=disabled", Object.fromEntries(Object.entries(users).map(([k, u]) => [k, u.role])));

  const db = new DatabaseSync(path.join(userDataDir, "identity.db"));
  try {
    db.exec("PRAGMA busy_timeout=5000");
    db.prepare("INSERT OR IGNORE INTO teams (id, name, root, created_at) VALUES (?,?,0,?)").run("team_foreign_share", "外组织（夹具）", Date.now());
    db.prepare("UPDATE users SET team_id = ? WHERE id = ?").run("team_foreign_share", users.outsider.userId);
  } finally { db.close(); }

  const created = {};
  const titles = { role: "共享画布", org: "组织可见画布", revoke: "撤销共享画布", transfer: "转移所有者画布", empty: "空共享画布" };
  for (const key of ["role", "org", "revoke", "transfer", "empty"]) {
    const r = await canvas(a, { type: "canvas/create", title: titles[key], icon: "🧩", kind: "smart" });
    if (!r || !r.ok) throw new Error("创建画布失败 " + key + "：" + JSON.stringify(r));
    created[key] = r.canvas.canvasId;
  }
  const seed = async (canvasId, nodeId) => {
    const got = await canvas(a, { type: "canvas/get", canvasId });
    return await canvas(a, { type: "canvas/save", canvasId, baseRevision: Number(got.canvas.revision || 1), doc: { nodes: [{ id: nodeId, type: "image", x: 120, y: 120, w: 320, h: 240, images: [] }], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] } });
  };
  for (const [key, id] of Object.entries(created)) await seed(id, "seed_" + key);
  const share = async (canvasId, userId, role) => canvas(a, { type: "canvas/share", canvasId, userId, role });
  await share(created.role, users.viewer.userId, "VIEWER");
  await share(created.role, users.editor.userId, "EDITOR");
  await share(created.role, users.manager.userId, "MANAGER");
  await share(created.org, users.editor.userId, "EDITOR");
  await share(created.revoke, users.editor.userId, "EDITOR");
  await share(created.transfer, users.manager.userId, "MANAGER");
  const orgVis = await canvas(a, { type: "canvas/visibility", canvasId: created.org, visibility: "ORGANIZATION" });
  const roleAccess = await accessOf(a, created.role);
  check("A4 · 5 本画布 + 三档共享 + 组织可见已落库", !!orgVis.ok && !!roleAccess.ok && (roleAccess.access.source === "SUPER_ADMIN" || roleAccess.access.source === "OWNER_POLICY") && roleAccess.capabilities.canManage === true, "owner/super canManage + org visibility", { orgVisibility: orgVis.canvas && orgVis.canvas.visibility, source: roleAccess.access && roleAccess.access.source });

  await openCanvasApp(a);
  const listUp = await waitFor(() => !!listFrame(a), 30000);
  check("A5 · 打开画布应用（列表页 canvas-list.html）", listUp && !!(await listFrame(a)), "canvas-list.html", listUp);

  const menuOpen = await (async () => {
    if (!(await waitCard(a, created.role))) return false;
    const f = listFrame(a);
    return (await inFrame(f, "const card = Array.prototype.slice.call(document.querySelectorAll('#cardsGrid .project-card')).filter(function(c){ return c.getAttribute('data-canvas-id') === " + JSON.stringify(created.role) + "; })[0]; if (!card) return false; card.scrollIntoView({ block: 'center' }); window.scrollBy(0, -180); card.querySelector('.card-more-btn').click(); return !!card.querySelector('[data-action=share]');")) === true;
  })();
  await sleep(600);
  const listEntryShot = await shot(a, "list-share-menu-light");
  const shareClicked = await (async () => {
    const f = listFrame(a);
    return await inFrame(f, "const card = Array.prototype.slice.call(document.querySelectorAll('#cardsGrid .project-card')).filter(function(c){ return c.getAttribute('data-canvas-id') === " + JSON.stringify(created.role) + "; })[0]; if (!card) return 'no-card'; const item = card.querySelector('[data-action=share]'); if (!item) return 'no-item'; item.click(); return 'clicked';");
  })();
  const fromList = shareClicked === "clicked" && await waitFor(() => js(a, "const p=document.querySelector('[data-canvas-share-panel]'); return !!p && p.getAttribute('data-canvas-share-ready') === '1';"), 30000);
  let info = await panelInfo(a);
  check("A6 · 列表卡片菜单有「共享…」，点击经桥打开宿主共享面板（页面不改外观）", menuOpen && fromList && info && info.open === created.role, "菜单项存在 + data-canvas-share-open = " + created.role, { menuOpen, shareClicked, fromList, info });
  check("A7 · 管理员面板：完整成员列表（3 人）+ 改角色/移除/可见性/转移入口",
    !!info && info.mode === "manage" && info.members === 3 && info.hasAdd && info.hasVisibility && info.hasTransfer && info.ownerRow,
    "manage + members=3 + add/visibility/transfer", info && { mode: info.mode, members: info.members, hasAdd: info.hasAdd, hasVisibility: info.hasVisibility, hasTransfer: info.hasTransfer, ownerRow: info.ownerRow });
  const rowCheck = await js(a, "const rows=Array.prototype.slice.call(document.querySelectorAll('[data-share-member]')); return rows.length===3 && rows.every(function(r){ const t=String(r.innerText||''); return !!r.querySelector('.canvas-share-avatar') && t.indexOf('加入于') >= 0 && t.indexOf('正常') >= 0 && !!r.querySelector('[data-share-role]') && !!r.querySelector('[data-share-remove]'); });");
  check("A8 · 成员行含头像/名字/角色/加入时间/状态（ACTIVE）", rowCheck === true, "3 行 × 头像/加入于/正常/角色下拉/移除", rowCheck);

  await a.page.click('[data-share-visibility=ORGANIZATION]');
  const visOk = await waitFor(async () => (await panelInfo(a)).visibility === "ORGANIZATION", 8000);
  const flashOk = await waitFor(() => js(a, "const f=document.querySelector('[data-canvas-share-flash]'); return !!f && String(f.innerText).indexOf('组织内可见') >= 0;"), 5000);
  const flashText = await js(a, "const f=document.querySelector('[data-canvas-share-flash]'); return f?String(f.innerText):'';");
  const visDb = await canvas(a, { type: "canvas/access/get", canvasId: created.role });
  check("A9 · 可见性切换即时生效并提示（私有 → 组织内可见）", visOk && flashOk && flashText.indexOf("组织内可见") >= 0 && visDb.visibility === "ORGANIZATION", "ORGANIZATION + 提示文案", { visOk, flashOk, flashText, visibility: visDb.visibility });
  await a.page.click('[data-share-visibility=PRIVATE]');
  await waitFor(async () => (await panelInfo(a)).visibility === "PRIVATE", 8000);

  await a.page.click("[data-share-add]");
  await a.page.fill("[data-share-search]", "candidate");
  await waitFor(() => js(a, "return !!document.querySelector('[data-share-candidate]')"), 10000);
  const candidateIds = await js(a, "return Array.prototype.map.call(document.querySelectorAll('[data-share-candidate]'), function(b){return b.getAttribute('data-share-candidate');});");
  check("A10 · 候选搜索只来自 canvas/share/candidates（搜到候选成员）", candidateIds.length === 1 && candidateIds[0] === users.candidate.userId, "1 个候选 = candidate", candidateIds);
  await a.page.selectOption("[data-share-add-role]", "MANAGER");
  const addShot = await shot(a, "admin-candidate-light");
  await a.page.click("[data-share-candidate=" + users.candidate.userId + "]");
  const added = await waitFor(() => js(a, "return !!document.querySelector('[data-share-member=" + users.candidate.userId + "]')"), 10000);
  const addedRow = await js(a, "const r=document.querySelector('[data-share-member=" + users.candidate.userId + "]'); return r?{role:r.getAttribute('data-share-member-role'), text:String(r.innerText)}:null;");
  check("A11 · 添加成员（选「管理共享」）→ 行内出现", added && addedRow && addedRow.role === "MANAGER", "MANAGER 行", addedRow);

  await a.page.selectOption("[data-share-role=" + users.candidate.userId + "]", "VIEWER");
  const roleChanged = await waitFor(async () => (await js(a, "const r=document.querySelector('[data-share-member=" + users.candidate.userId + "]'); return r?r.getAttribute('data-share-member-role'):null;")) === "VIEWER", 8000);
  check("A12 · 行内改角色（管理共享 → 查看者）", roleChanged, "VIEWER", roleChanged);

  await a.page.click("[data-share-remove=" + users.candidate.userId + "]");
  const ask = await waitFor(() => js(a, "return !!document.querySelector('[data-share-remove-confirm=" + users.candidate.userId + "]')"), 5000);
  await a.page.click("[data-share-remove-cancel=" + users.candidate.userId + "]");
  const cancelled = await waitFor(() => js(a, "return !document.querySelector('[data-share-remove-confirm=" + users.candidate.userId + "]') && !!document.querySelector('[data-share-member=" + users.candidate.userId + "]')"), 5000);
  await a.page.click("[data-share-remove=" + users.candidate.userId + "]");
  await waitFor(() => js(a, "return !!document.querySelector('[data-share-remove-confirm=" + users.candidate.userId + "]')"), 5000);
  await a.page.click("[data-share-remove-confirm=" + users.candidate.userId + "]");
  const removed = await waitFor(() => js(a, "return !document.querySelector('[data-share-member=" + users.candidate.userId + "]')"), 10000);
  check("A13 · 移除成员是两步确认：先确认态 → 取消保留 → 再确认移除", ask && cancelled && removed, "ask → cancel(保留) → confirm(移除)", { ask, cancelled, removed });

  await closePanel(a);
  await openShareFromList(a, created.empty);
  const emptyReady = await waitFor(() => js(a, "const e=document.querySelector('[data-canvas-share-empty]'); return !!e;"), 8000);
  const emptyText = await js(a, "const e=document.querySelector('[data-canvas-share-empty]'); return e?String(e.innerText):'';");
  const emptyShot = await shot(a, "admin-empty-light");
  check("A14 · 空态（还没有共享给任何人）", emptyReady && String(emptyText).indexOf("还没有共享给任何人") >= 0, "空态文案", emptyText);
  await closePanel(a);

  await openShareFromList(a, created.transfer);
  await waitFor(() => js(a, "return !!document.querySelector('[data-share-transfer-target]')"), 8000);
  await a.page.selectOption("[data-share-transfer-target]", users.manager.userId);
  await a.page.click("[data-share-transfer-open]");
  const transferConfirm = await waitFor(() => js(a, "return !!document.querySelector('[data-share-transfer-confirm]')"), 5000);
  const transferShot = await shot(a, "admin-transfer-confirm-light");
  await a.page.click("[data-share-transfer-confirm]");
  const transferred = await waitFor(async () => {
    const r = await canvas(a, { type: "canvas/shares", canvasId: created.transfer });
    return r && r.ok && r.owner && r.owner.userId === users.manager.userId;
  }, 10000);
  const transferFlashOk = await waitFor(() => js(a, "const f=document.querySelector('[data-canvas-share-flash]'); return !!f && String(f.innerText).indexOf('所有权已转移') >= 0;"), 5000);
  const transferFlash = await js(a, "const f=document.querySelector('[data-canvas-share-flash]'); return f?String(f.innerText):'';");
  check("A15 · 转移所有者：二次确认后真实转移（owner = 管理共享账号）", transferConfirm && transferred && transferFlashOk && transferFlash.indexOf("所有权已转移") >= 0, "owner=manager + 提示", { transferConfirm, transferred, transferFlashOk, transferFlash });
  await closePanel(a);

  await openShareFromList(a, created.role);
  await shot(a, "admin-panel-light");
  await js(a, "const d=document.querySelector('.desktop'); if(d) d.classList.add('dark'); return true;");
  await sleep(300);
  const darkShot = await shot(a, "admin-panel-dark");
  await js(a, "const d=document.querySelector('.desktop'); if(d) d.classList.remove('dark'); return true;");
  await closePanel(a);
  const narrow = await resizeNative(a, 720, 800);
  await waitFor(() => js(a, "return window.innerWidth <= 740"), 6000);
  await openCard(a, created.role);
  await waitFor(() => js(a, "return !!document.querySelector('[data-canvas-share-entry]')"), 30000);
  await sleep(1200);
  await a.page.click("[data-canvas-share-entry]");
  await waitFor(() => js(a, "const p=document.querySelector('[data-canvas-share-panel]'); return !!p && p.getAttribute('data-canvas-share-ready') === '1';"), 10000);
  const narrowEntry = await js(a, "const e=document.querySelector('[data-canvas-share-entry]'); if(!e) return null; const cs=getComputedStyle(e); const label=e.querySelector('.canvas-share-entry__label'); const p=document.querySelector('[data-canvas-share-panel]'); return { width: cs.width, label: label ? getComputedStyle(label).display : null, panel: p ? getComputedStyle(p).width : null, inner: window.innerWidth };");
  const narrowShot = await shot(a, "admin-panel-narrow");
  const narrowPanel = await js(a, "const p=document.querySelector('[data-canvas-share-panel]'); if(!p) return null; const r=p.getBoundingClientRect(); return { w: Math.round(r.width), right: Math.round(window.innerWidth - r.right), left: Math.round(r.left), vw: window.innerWidth };");
  check("A16 · 窄窗（720px）入口收成图标、面板不横向溢出",
    !!narrowEntry && parseFloat(narrowEntry.width) <= 42 && narrowEntry.label === "none" && !!narrowPanel && narrowPanel.w <= narrowPanel.vw - 8 && narrowPanel.left >= 0,
    "入口 40px + 面板 <= 视口-8", { narrow, narrowEntry, narrowPanel });
  await closePanel(a);
  await inFrame(smartFrame(a), "const b=document.querySelector('.smart-back'); if(b) b.click(); return true;");
  await waitFor(() => !!listFrame(a) && !smartFrame(a), 20000);
  await resizeNative(a, 1440, 900);
  await waitFor(() => js(a, "return window.innerWidth > 900"), 6000);

  const bLogin = async (key) => {
    const u = USERS[key];
    await identity(b, { type: "identity/logout" });
    await waitFor(async () => (await gate(b)) === "unauthenticated", 20000);
    const r = await identity(b, { type: "identity/login", identifier: u.id, password: u.pw });
    await waitFor(async () => (await gate(b)) === "ready", 30000);
    return r;
  };
  const viewerLogin = await bLogin("viewer");
  check("B1 · B 进程用既有 identity/login 登录查看者（MEMBER）", !!(viewerLogin && viewerLogin.ok && viewerLogin.snapshot && viewerLogin.snapshot.role === "MEMBER"), "ok + role=MEMBER", viewerLogin && (viewerLogin.error || (viewerLogin.snapshot || {}).role));
  await openCanvasApp(b);
  await waitFor(() => !!listFrame(b), 30000);
  await openCard(b, created.role);
  const viewerPage = await waitFor(async () => { const s = await inFrame(smartFrame(b), "return { ro: window.__openarcBridge.isReadOnly(), attr: document.documentElement.getAttribute('data-openarc-readonly') };"); return s && s.ro === true && s.attr === "1"; }, 30000);
  const viewerCtx = await inFrame(smartFrame(b), "return { ro: window.__openarcBridge.isReadOnly(), attr: document.documentElement.getAttribute('data-openarc-readonly'), canEdit: window.__openarcBridge.context.canEdit, canvasId: window.__openarcBridge.context.canvasId };");
  check("V1 · 查看者打开画布：页面真只读（data-openarc-readonly=1 + bridge readOnly）", viewerPage && viewerCtx.ro === true && viewerCtx.attr === "1" && viewerCtx.canEdit === false, "readOnly + attr=1", viewerCtx);
  const viewerBefore = await nodeInfo(b, created.role);
  const viewerEdit = await inFrame(smartFrame(b), "const r = await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'viewer_probe', type:'image', x:10, y:10 } }, null); return { result: r, has: !!window.__openarcCanvas.getNode('viewer_probe') };");
  const viewerSave = await (async () => { const got = await canvas(b, { type: "canvas/get", canvasId: created.role }); return await canvas(b, { type: "canvas/save", canvasId: created.role, baseRevision: got.canvas.revision, doc: got.canvas.doc }); })();
  const viewerAfter = await nodeInfo(b, created.role);
  const viewerShare = await canvas(b, { type: "canvas/share", canvasId: created.role, userId: users.candidate.userId, role: "VIEWER" });
  check("V2 · 查看者编辑被拒：页面命令 READ_ONLY + 后端保存 READ_ONLY + 节点数不变",
    viewerEdit && viewerEdit.result && viewerEdit.result.ok === false && viewerEdit.result.error === "READ_ONLY" && viewerEdit.has === false && viewerSave.ok === false && viewerSave.error === "READ_ONLY" && viewerBefore.nodes === viewerAfter.nodes && viewerShare.ok === false && viewerShare.error === "READ_ONLY",
    "READ_ONLY ×3 + 节点数不变", { viewerEdit, viewerSave: { ok: viewerSave.ok, error: viewerSave.error }, viewerBefore, viewerAfter, viewerShare: { ok: viewerShare.ok, error: viewerShare.error } });

  const viewerEntryLabel = await js(b, "const e=document.querySelector('[data-canvas-share-entry]'); return e?e.getAttribute('data-canvas-share-entry-label'):null;");
  await b.page.click("[data-canvas-share-entry]");
  await waitFor(() => js(b, "const p=document.querySelector('[data-canvas-share-panel]'); return !!p && p.getAttribute('data-canvas-share-ready') === '1';"), 10000);
  const viewerPanel = await panelInfo(b);
  const viewerBody = await js(b, "return String(document.body.innerText || '');");
  const leaks = [users.editor.name, users.editor.id, users.manager.name, users.manager.id, users.viewer.userId, users.editor.userId, users.manager.userId].filter((s) => viewerBody.includes(s));
  check("V3 · 查看者面板：只有「我的角色 + 可见性说明」，没有成员列表/其他成员 ID",
    !!viewerPanel && viewerPanel.mode === "readonly" && viewerPanel.members === 0 && viewerPanel.ownerRow === false && viewerPanel.hasAdd === false && viewerPanel.hasVisibility === false && viewerPanel.hasTransfer === false && viewerPanel.myRole === "查看者" && leaks.length === 0,
    "readonly + members=0 + myRole=查看者 + 0 泄漏", { viewerPanel, leaks });
  check("V4 · 只读入口展示角色（不是「共享」管理入口）", viewerEntryLabel === "只读共享", "只读共享", viewerEntryLabel);
  const viewerPanelShot = await shot(b, "viewer-panel-light");
  await closePanel(b);

  await bLogin("editor");
  await openCanvasApp(b);
  await waitFor(() => !!listFrame(b), 30000);
  await openCard(b, created.role);
  const editorPage = await waitFor(async () => { const s = await inFrame(smartFrame(b), "return { ro: window.__openarcBridge.isReadOnly(), attr: document.documentElement.getAttribute('data-openarc-readonly') };"); return s && s.ro === false; }, 30000);
  const editorPageCtx = await inFrame(smartFrame(b), "return { ro: window.__openarcBridge.isReadOnly(), attr: document.documentElement.getAttribute('data-openarc-readonly'), canEdit: window.__openarcBridge.context.canEdit };");
  check("E1 · 编辑者打开画布：页面可编辑（readOnly=false）", editorPage && editorPageCtx.ro === false && editorPageCtx.canEdit === true, "canEdit=true", editorPageCtx);
  const editorAdd = await inFrame(smartFrame(b), "const r = await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'editor_probe', type:'image', x:20, y:20 } }, null); return { result: r, has: !!window.__openarcCanvas.getNode('editor_probe') };");
  const editorSaved = await waitFor(async () => { const n = await nodeInfo(b, created.role); return n.ids && n.ids.indexOf("editor_probe") >= 0 ? n : null; }, 15000);
  const editorSaveDirect = await (async () => { const got = await canvas(b, { type: "canvas/get", canvasId: created.role }); return await canvas(b, { type: "canvas/save", canvasId: created.role, baseRevision: got.canvas.revision, doc: got.canvas.doc }); })();
  check("E2 · 编辑者能编辑并保存（页面命令 + 后端 PUT 保存成功，节点已落库）",
    editorAdd && editorAdd.result && editorAdd.result.ok === true && editorAdd.has === true && !!editorSaved && editorSaveDirect.ok === true,
    "applyCommand ok + node 落库 + canvas/save ok", { editorAdd, editorSaved: !!editorSaved, editorSaveDirect: { ok: editorSaveDirect.ok, error: editorSaveDirect.error } });
  const editorShare = await canvas(b, { type: "canvas/share", canvasId: created.role, userId: users.candidate.userId, role: "VIEWER" });
  const editorVisibility = await canvas(b, { type: "canvas/visibility", canvasId: created.role, visibility: "ORGANIZATION" });
  const editorEntryLabel = await js(b, "const e=document.querySelector('[data-canvas-share-entry]'); return e?e.getAttribute('data-canvas-share-entry-label'):null;");
  await b.page.click("[data-canvas-share-entry]");
  await waitFor(() => js(b, "const p=document.querySelector('[data-canvas-share-panel]'); return !!p && p.getAttribute('data-canvas-share-ready') === '1';"), 10000);
  const editorPanel = await panelInfo(b);
  check("E3 · 编辑者不能改共享（命令 READ_ONLY），面板不给管理入口（只显示我的角色）",
    editorShare.ok === false && editorShare.error === "READ_ONLY" && editorVisibility.ok === false && editorVisibility.error === "READ_ONLY" && editorEntryLabel === "编辑者" && !!editorPanel && editorPanel.mode === "readonly" && editorPanel.members === 0 && editorPanel.myRole === "编辑者" && editorPanel.hasAdd === false,
    "READ_ONLY ×2 + readonly panel + 编辑者", { editorShare: { ok: editorShare.ok, error: editorShare.error }, editorVisibility: { ok: editorVisibility.ok, error: editorVisibility.error }, editorEntryLabel, editorPanel });
  const editorPanelShot = await shot(b, "editor-panel-light");
  await closePanel(b);

  await inFrame(smartFrame(b), "const b=document.querySelector('.smart-back'); if(b) b.click(); return true;");
  await waitFor(() => !!listFrame(b) && !smartFrame(b), 20000);
  await openCard(b, created.org);
  const orgAccess = await accessOf(b, created.org);
  const orgPage = await waitFor(async () => { const s = await inFrame(smartFrame(b), "return { ro: window.__openarcBridge.isReadOnly(), attr: document.documentElement.getAttribute('data-openarc-readonly') };"); return s && s.ro === false; }, 30000);
  const orgAdd = await inFrame(smartFrame(b), "const r = await window.__openarcCanvas.applyCommand({ type: 'node.add', node: { id: 'org_editor_probe', type: 'image', x: 30, y: 30 } }, null); return r;");
  check("O1 · bug1 回归：组织可见 + 显式编辑者 → canEdit=true（页面仍可编辑，不被组织只读降级）",
    orgAccess.ok && orgAccess.access.source === "SHARE_EDITOR" && orgAccess.capabilities.canEdit === true && orgPage && orgAdd && orgAdd.ok === true,
    "source=SHARE_EDITOR + canEdit=true + 页面编辑成功", { source: orgAccess.access && orgAccess.access.source, canEdit: orgAccess.capabilities && orgAccess.capabilities.canEdit, orgPage, orgAdd: orgAdd && orgAdd.ok });
  await inFrame(smartFrame(b), "const b=document.querySelector('.smart-back'); if(b) b.click(); return true;");
  await waitFor(() => !!listFrame(b) && !smartFrame(b), 20000);

  await bLogin("manager");
  await openCanvasApp(b);
  await waitFor(() => !!listFrame(b), 30000);
  await openCard(b, created.role);
  await waitFor(async () => (await inFrame(smartFrame(b), "return window.__openarcBridge.isReadOnly()")) === false, 30000);
  const managerEntryLabel = await js(b, "const e=document.querySelector('[data-canvas-share-entry]'); return e?e.getAttribute('data-canvas-share-entry-label'):null;");
  await b.page.click("[data-canvas-share-entry]");
  await waitFor(() => js(b, "const p=document.querySelector('[data-canvas-share-panel]'); return !!p && p.getAttribute('data-canvas-share-ready') === '1';"), 10000);
  const managerPanel = await panelInfo(b);
  check("M1 · 管理共享：面板有成员列表/添加/改角色/移除/可见性，但没有转移所有者入口",
    managerEntryLabel === "共享" && !!managerPanel && managerPanel.mode === "manage" && managerPanel.members >= 3 && managerPanel.hasAdd && managerPanel.hasVisibility && managerPanel.hasTransfer === false && managerPanel.ownerRow === true,
    "manage + 成员 + 无转移", { managerEntryLabel, managerPanel: managerPanel && { mode: managerPanel.mode, members: managerPanel.members, hasAdd: managerPanel.hasAdd, hasVisibility: managerPanel.hasVisibility, hasTransfer: managerPanel.hasTransfer } });
  const managerVisibility = await canvas(b, { type: "canvas/visibility", canvasId: created.role, visibility: "ORGANIZATION" });
  await waitFor(async () => (await panelInfo(b)).visibility === "ORGANIZATION", 8000);
  const managerRole = await canvas(b, { type: "canvas/share/update", canvasId: created.role, userId: users.viewer.userId, role: "EDITOR" });
  const managerAdd = await canvas(b, { type: "canvas/share", canvasId: created.role, userId: users.candidate.userId, role: "VIEWER" });
  const managerRemove = await canvas(b, { type: "canvas/share/remove", canvasId: created.role, userId: users.candidate.userId });
  await waitFor(async () => (await panelInfo(b)).members >= 2, 8000);
  const managerTrash = await canvas(b, { type: "canvas/trash", canvasId: created.role });
  const managerTransfer = await canvas(b, { type: "canvas/owner/transfer", canvasId: created.role, newOwnerUserId: users.viewer.userId });
  check("M2 · 管理共享能加/删成员、改角色、切可见性（命令真实成功）",
    managerVisibility.ok && managerRole.ok && managerAdd.ok && managerRemove.ok && managerRemove.removed === true,
    "visibility/update/add/remove ok", { managerVisibility: managerVisibility.ok, managerRole: managerRole.ok, managerAdd: managerAdd.ok, managerRemove: { ok: managerRemove.ok, removed: managerRemove.removed } });
  check("M3 · 管理共享不能删画布、不能转移所有者（命令 READ_ONLY）",
    managerTrash.ok === false && managerTrash.error === "READ_ONLY" && managerTransfer.ok === false && managerTransfer.error === "READ_ONLY",
    "READ_ONLY ×2", { trash: { ok: managerTrash.ok, error: managerTrash.error }, transfer: { ok: managerTransfer.ok, error: managerTransfer.error } });
  await js(b, "const d=document.querySelector('.desktop'); if(d) d.classList.add('dark'); return true;");
  await sleep(300);
  const managerPanelDark = await shot(b, "manager-panel-dark");
  await js(b, "const d=document.querySelector('.desktop'); if(d) d.classList.remove('dark'); return true;");
  await closePanel(b);
  await canvas(a, { type: "canvas/share/update", canvasId: created.role, userId: users.viewer.userId, role: "VIEWER" });

  await bLogin("editor");
  await openCanvasApp(b);
  await waitFor(() => !!listFrame(b), 30000);
  await openCard(b, created.revoke);
  await waitFor(async () => (await inFrame(smartFrame(b), "return window.__openarcBridge.isReadOnly()")) === false, 30000);
  await openShareFromList(a, created.revoke);
  await waitFor(() => js(a, "return !!document.querySelector('[data-share-role=" + users.editor.userId + "]')"), 8000);
  const t0 = Date.now();
  await a.page.selectOption("[data-share-role=" + users.editor.userId + "]", "VIEWER");
  const flipped = await waitFor(async () => { const s = await inFrame(smartFrame(b), "return { ro: window.__openarcBridge.isReadOnly(), attr: document.documentElement.getAttribute('data-openarc-readonly') };"); return s && s.ro === true && s.attr === "1"; }, 12000);
  const flipMs = Date.now() - t0;
  const flipNotice = await js(b, "const h=document.querySelector('[data-canvas-host]'); return { notice: h?h.getAttribute('data-canvas-asset-notice-text'):null };");
  check("L1 · 降级（编辑者→查看者）：对方已打开页面在 " + flipMs + "ms 内自动变只读（无需刷新页面）",
    flipped && flipMs < 6000, "< 6000ms + attr=1", { flipped, flipMs, notice: flipNotice });
  const flipShot = await shot(b, "revoke-downgraded-readonly-light");

  const t1 = Date.now();
  await a.page.click("[data-share-remove=" + users.editor.userId + "]");
  await waitFor(() => js(a, "return !!document.querySelector('[data-share-remove-confirm=" + users.editor.userId + "]')"), 5000);
  await a.page.click("[data-share-remove-confirm=" + users.editor.userId + "]");
  const backToList = await waitFor(async () => !!listFrame(b) && !smartFrame(b), 15000);
  const backMs = Date.now() - t1;
  const backNotice = await js(b, "const h=document.querySelector('[data-canvas-host]'); return { notice: h?h.getAttribute('data-canvas-asset-notice-text'):null };");
  check("L2 · 撤销共享：对方已打开页面在 " + backMs + "ms 内自动返回列表（NOT_FOUND_OR_FORBIDDEN，不是停在旧文档）",
    backToList && backMs < 10000 && String(backNotice.notice || "").indexOf("不可访问") >= 0, "< 10000ms + 返回列表 + 提示", { backToList, backMs, notice: backNotice });
  const backShot = await shot(b, "revoke-back-to-list-light");
  await closePanel(a);

  const crossOrg = await canvas(a, { type: "canvas/share", canvasId: created.role, userId: users.outsider.userId, role: "VIEWER" });
  const disabledShare = await canvas(a, { type: "canvas/share", canvasId: created.role, userId: users.disabled.userId, role: "VIEWER" });
  const candidates = await canvas(a, { type: "canvas/share/candidates", canvasId: created.role, query: "", limit: 50 });
  const candidateList = (candidates.items || []).map((i) => i.userId);
  check("X1 · 跨组织/停用账号不能被共享（target-org / target-disabled），候选人里也不出现",
    crossOrg.ok === false && crossOrg.error === "INVALID_INPUT" && crossOrg.detail === "target-org" && disabledShare.ok === false && disabledShare.error === "INVALID_INPUT" && disabledShare.detail === "target-disabled" && !candidateList.includes(users.outsider.userId) && !candidateList.includes(users.disabled.userId),
    "INVALID_INPUT target-org / target-disabled + 候选排除", { crossOrg: { ok: crossOrg.ok, error: crossOrg.error, detail: crossOrg.detail }, disabled: { ok: disabledShare.ok, error: disabledShare.error, detail: disabledShare.detail }, candidateList });

  await openCard(a, created.role);
  await waitFor(() => js(a, "return !!document.querySelector('[data-canvas-share-entry]')"), 30000);
  const entryShot = await shot(a, "canvas-share-entry-light");
  await a.page.click("[data-canvas-share-entry]");
  await waitFor(() => js(a, "const p=document.querySelector('[data-canvas-share-panel]'); return !!p && p.getAttribute('data-canvas-share-ready') === '1';"), 10000);
  const panelInCanvas = await panelInfo(a);
  await shot(a, "admin-panel-in-canvas-light");
  await a.page.keyboard.press("Escape");
  const focusBack = await waitFor(() => js(a, "return document.activeElement && document.activeElement.hasAttribute && document.activeElement.hasAttribute('data-canvas-share-entry')"), 5000);
  check("A17 · 画布内右上角入口打开同一面板；Esc 关闭后焦点回到入口按钮",
    !!panelInCanvas && panelInCanvas.open === created.role && focusBack, "panel + focus back", { panel: panelInCanvas && panelInCanvas.open, focusBack });

  await sleep(800);
  const expectedConsole = /Failed to load resource: the server responded with a status of 404/;
  const consoleErrorsReal = consoleErrors.filter((e) => !expectedConsole.test(e.text));
  check("Z1 · 0 console error（不含撤销路径预期的 404 资源日志）", consoleErrorsReal.length === 0, "0", consoleErrorsReal.slice(0, 8));
  check("Z2 · 0 pageerror", pageErrors.length === 0, "0", pageErrors.slice(0, 8));

  const result = {
    ok: failed === 0,
    admin: { identifier: ADMIN.id, userId: (login.snapshot || {}).userId || null },
    users: Object.fromEntries(Object.entries(users).map(([k, u]) => [k, { userId: u.userId, role: u.role }])),
    canvases: created,
    checks: CHECKS,
    consoleErrors, pageErrors, netFails: netFails.slice(0, 20),
    screenshots: { listEntry: listEntryShot, adminLight: path.relative(ROOT, path.join(SHOTS, "admin-panel-light.png")), adminDark: darkShot, adminNarrow: narrowShot, adminEmpty: emptyShot, adminCandidate: addShot, adminTransfer: transferShot, viewer: viewerPanelShot, editor: editorPanelShot, managerDark: managerPanelDark, downgraded: flipShot, backToList: backShot, entry: entryShot },
    timing: { downgradeMs: flipMs, revokeToListMs: backMs },
  };
  try { await a.browser.close(); } catch { /* ignore */ }
  try { await b.browser.close(); } catch { /* ignore */ }
  await sleep(800);
  for (const inst of Object.values(instances)) { try { inst.child.kill("SIGTERM"); } catch { /* ignore */ } }
  await sleep(1200);
  for (const inst of Object.values(instances)) { try { inst.child.kill("SIGKILL"); } catch { /* ignore */ } }

  const profileAfter = snapshotProfile(realProfile);
  const changed = [];
  for (const name of new Set([...Object.keys(profileBefore.identity), ...Object.keys(profileAfter.identity)])) if (JSON.stringify(profileBefore.identity[name]) !== JSON.stringify(profileAfter.identity[name])) changed.push("identity:" + name);
  for (const name of new Set([...Object.keys(profileBefore.topLevel), ...Object.keys(profileAfter.topLevel)])) if (JSON.stringify(profileBefore.topLevel[name]) !== JSON.stringify(profileAfter.topLevel[name])) changed.push("top:" + name);
  result.profile = { realProfileUnchanged: changed.length === 0, changed };
  check("Z3 · 真实 profile 未被写入（隔离 userData 之外零改动）", changed.length === 0, "unchanged", changed.slice(0, 10));

  result.passed = passed;
  result.failed = failed;
  fs.writeFileSync(path.join(ART, "real-device.json"), JSON.stringify(result, null, 2) + NL);
  const lines = [];
  lines.push("# 画布共享 · 真机多账号验收（P2）", "");
  lines.push("两个真实 Electron 进程（同一隔离 userData；A=管理员，B=普通 MEMBER 依次查看者→编辑者→管理共享）。", "");
  lines.push("| 结果 | 检查 | 期望 | 实际 |");
  lines.push("| --- | --- | --- | --- |");
  for (const c of CHECKS) lines.push("| " + (c.status === "PASS" ? "PASS" : "FAIL") + " | " + c.name.split("|").join(" / ") + " | " + c.expected.split("|").join(" / ").slice(0, 260) + " | " + c.actual.split("|").join(" / ").slice(0, 500) + " |");
  lines.push("", "PASS " + passed + " / FAIL " + failed, "");
  lines.push("## 截图", "");
  for (const [k, v] of Object.entries(result.screenshots)) lines.push("- " + k + ": " + v);
  lines.push("", "## 计时", "");
  lines.push("- 降级（EDITOR→VIEWER）→ 已打开页面变只读：" + flipMs + "ms");
  lines.push("- 撤销共享 → 已打开页面返回列表：" + backMs + "ms");
  fs.writeFileSync(path.join(ART, "REAL-DEVICE.md"), lines.join(NL) + NL);
  console.log(NL + "PASS " + passed + " / FAIL " + failed);
  if (userDataDir && fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true });
  if (failed) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error("PROBE ERROR: " + String((err && err.stack) || err));
  try { for (const inst of Object.values(instances)) { try { await inst.browser.close(); } catch { /* ignore */ } } } catch { /* ignore */ }
  for (const inst of Object.values(instances)) { try { inst.child.kill("SIGKILL"); } catch { /* ignore */ } }
  process.exit(1);
});
