/**
 * D5-01 Closure-3 · **主进程内执行类**的执行边界（真实原生视图 + 本地可控站点 + 产品链）。
 *
 * 为什么单独一个门禁：本轮新增的 in-process execution class（受控浏览器导航的 Domain 是 main
 * 进程内的原生 WebContentsView）**不能**因为是同类进程就少掉独立 executor 的死亡 / 停止 /
 * 无副作用证明。这里全部用真实 electron + 真实 WebContentsView + 真实本地站点验证：
 *
 *   P1 claim 前撤权（治理撤 tool 权限）→ 不派发导航、页面零变化
 *   P2 派发后停止（用户取消任务）→ 状态不悬挂、结论不是"未执行"；**迟到完成不覆盖权威未知状态**
 *   P3 执行中关闭标签 → 判不可知、不转向别的标签、任务与调用都有终态
 *   P4 归因：用户自己导航到**同一个地址**时，绝不算作本次执行成功
 *   P5 并发/重复：双击批准只派发一次
 *   P6 地址绑定：两次导航各自用自己的批准与地址，旧批准不得用于新地址
 *
 * 只替代"最后一跳 provider 网络"（本地确定性 provider）；其余全部是产品自己的那条线。
 */
import { chromium } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { startSite } from "./site.mjs";
import { startD4Provider } from "../../tests/fixtures/d4-04-provider.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const ART = path.join(ROOT, "artifacts", "d5-01");
const CDP_PORT = Number(process.env.OA_D501_BOUNDARY_CDP_PORT || 9792);
const ADMIN = { id: "admin@d501-boundary.test", pw: "admin-password-1" };
const PROVIDER_SECRET = "d501-boundary-provider-secret";
const TOOLS = ["tool.browser.read", "tool.browser.navigate"];
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(path.join(ROOT, "dist", "index.html"))) { console.error("缺少 dist/index.html —— 请先 npm run build"); process.exit(1); }
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d501-boundary-"));
const DB_PATH = path.join(userData, "identity.db");
const RECORD = [], CHECKS = [], NOT_VERIFIED = [], OBSERVATIONS = [];
let passed = 0, failed = 0;
function record(section, name, ok, expected, actual) {
  const row = { section, name, status: ok ? "PASS" : "FAIL", expected: String(expected ?? ""), actual: String(actual ?? "").slice(0, 500), at: Date.now() };
  RECORD.push(row); CHECKS.push(row);
  if (ok) passed += 1; else failed += 1;
  console.log((ok ? "  " : "! ") + "[" + row.status + "] " + section + " · " + name + (ok ? "" : " — 期望 " + row.expected + "，实际 " + row.actual));
  return ok;
}
const note = (t) => { OBSERVATIONS.push(t); console.log("   · " + t); };
const notVerified = (n, r) => { NOT_VERIFIED.push({ name: n, reason: r }); console.log("   ? [NOT VERIFIED] " + n + " — " + r); };

let child = null, browser = null, page = null, stderrBuf = "", site = null, provider = null;
const dbAll = (sql) => { const db = new DatabaseSync(DB_PATH, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
const tableRows = (t) => { try { return dbAll("SELECT * FROM " + t); } catch { return []; } };
const callById = (id) => tableRows("side_effect_calls").find((r) => r.call_id === id) || null;
const preOf = (row) => { try { return JSON.parse(String((row && row.preconditions_safe) || "{}")); } catch { return {}; } };

function killOurElectron() { try { spawnSync("pkill", ["-f", userData], { stdio: "ignore" }); } catch { /* ignore */ } }
function killStaleRuns() { try { spawnSync("pkill", ["-f", "oa-d501-boundary-"], { stdio: "ignore" }); } catch { /* ignore */ } }

async function launch() {
  let busy = false;
  for (let i = 0; i < 40; i += 1) {
    busy = await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version").then(() => true).catch(() => false);
    if (!busy) break;
    killStaleRuns();
    await sleep(250);
  }
  if (busy) throw new Error("CDP 端口 " + CDP_PORT + " 已被占用（遗留实例），拒绝复用");
  child = spawn(electronPath, [".", "--user-data-dir=" + userData, "--remote-debugging-port=" + CDP_PORT, ...extraArgs], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OPENARC_IDENTITY_ADMIN: "1" },
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { stderrBuf += String(d); try { fs.appendFileSync(path.join(ART, "d5-01-boundary-stderr.log"), String(d)); } catch { /* ignore */ } });
  let version = null;
  const deadline = Date.now() + 60000;
  while (!version && Date.now() < deadline) { try { version = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version")).json(); } catch { await sleep(300); } }
  if (!version) throw new Error("CDP 未就绪");
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP_PORT);
  const ctx = browser.contexts()[0];
  const end = Date.now() + 40000;
  while (!page && Date.now() < end) { page = ctx.pages().find((p) => p.url().includes("dist/index.html")) || null; if (!page) await sleep(300); }
  if (!page) throw new Error("未找到界面页面");
  return version;
}

const js = (code) => page.evaluate("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const text = (sel) => js("return document.querySelector(" + JSON.stringify(sel) + ")?.textContent || ''");
const attr = (sel, a) => js("return document.querySelector(" + JSON.stringify(sel) + ")?.getAttribute(" + JSON.stringify(a) + ") || ''");
const isDisabled = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); return el ? !!el.disabled : true;");
const click = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'ok';");
/** 入口类点击必须立刻失败：`click` 的返回值一旦被丢弃，入口缺失只会在 20s 超时后表现为安装段 FAIL，看不出原因。 */
async function mustClick(sel, label) {
  const r = await click(sel);
  if (r !== "ok") throw new Error("入口点击失败：" + label + " " + sel + " → " + r);
}
const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : (el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(proto,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true})); return 'ok';");
const value = (sel) => js("return document.querySelector(" + JSON.stringify(sel) + ")?.value || ''");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
const visibleText = (sel) => js("const el = " + (sel ? "document.querySelector(" + JSON.stringify(sel) + ")" : "document.body") + "; return el ? String(el.innerText || '') : ''");
async function waitFor(fn, timeout = 30000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await Promise.resolve(fn())) return true; } catch { /* retry */ } await sleep(100); } return false; }
const waitSel = (sel, ms) => waitFor(() => has(sel), ms || 20000);
const waitGate = (want, ms) => waitFor(async () => (await gate()) === want, ms || 40000);
const bridge = (domain, command) => js("return window.openarc." + domain + ".command(" + JSON.stringify(command) + ")");
const taskGet = (taskId) => bridge("task", { type: "task/get", taskId });
const views = () => browser.contexts()[0].pages().filter((p) => !p.url().includes("dist/index.html"));
const viewByUrl = (part) => views().find((p) => p.url().includes(part)) || null;
async function viewEval(v, code, attempts = 3) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    try { return await v.evaluate("(async () => { " + code + " })()"); } catch (e) {
      last = e;
      if (!/Execution context was destroyed|Target closed|frame was detached/i.test(String(e && e.message))) throw e;
      await sleep(200);
    }
  }
  throw last;
}
const ADDRESS_SEL = '[aria-label="网页地址"]';
/** 站点命中次数：接受完整 URL 或路径（站点本身按 pathname 计数）。 */
const hits = (p) => {
  const key = String(p).startsWith("http") ? new URL(String(p)).pathname : String(p);
  return Number(site.hits()[key] || 0);
};

async function login(who) {
  if (!(await waitSel('[data-d3-id="login-identifier"]', 20000))) return false;
  await setInput('[data-d3-id="login-identifier"]', who.id);
  await setInput('[data-d3-id="login-password"]', who.pw);
  await click('[data-d3-id="login-submit"]');
  return waitGate("ready", 90000);
}
async function openBrowser() { if (await has("[data-browser-window]")) return true; await click('[aria-label="打开浏览器"]'); return waitSel("[data-browser-window]", 20000); }
async function navigate(url) { await setInput(ADDRESS_SEL, url); await click(".addressbar .primary"); }
async function openPanel() { if (await has(".ai-panel")) return true; if (await waitSel(".assistant-pill", 30000)) await click(".assistant-pill"); return waitSel(".ai-panel", 20000); }
async function runTaskViaUI(goal) {
  await openPanel();
  const prev = await attr(".ai-panel", "data-ai-task-id");
  await setInput("[data-ai-goal]", goal);
  if (!(await waitFor(async () => !(await isDisabled("[data-ai-run]")), 60000))) throw new Error("run 按钮一直不可用");
  const c = await click("[data-ai-run]");
  if (c !== "ok") throw new Error("run 点击失败：" + c);
  await waitFor(async () => { const id = await attr(".ai-panel", "data-ai-task-id"); return typeof id === "string" && id.length > 0 && id !== prev; }, 40000);
  return { taskId: await attr(".ai-panel", "data-ai-task-id") };
}
const waitTaskTerminal = (taskId, timeout = 180000) => waitFor(async () => { const g = await taskGet(taskId); const s = g && g.task && g.task.status; return ["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"].includes(s); }, timeout);
const waitApproval = (ms) => waitFor(async () => (await attr("[data-approval-request-id]", "data-approval-request-id")).length > 0, ms || 120000);
const approvalId = () => attr("[data-approval-request-id]", "data-approval-request-id");
async function setPlan(plan) {
  const res = await fetch(provider.baseUrl.replace("/v1", "") + "/__plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: plan || [] }) });
  return res.ok;
}
const viewIdNow = () => attr("[data-ai-control-toggle]", "data-ai-control-view-id");
const controlState = () => attr("[data-ai-control-toggle]", "data-ai-control-state");

/** 跑一次"导航任务"到目标地址，并在审批面板出现后执行 afterApproval。 */
async function navigateTask(url, { goal = "导航", afterApproval = null, viewId = null } = {}) {
  if (viewId && (await controlState()) === "off") { await click("[data-ai-control-toggle]"); await waitFor(async () => (await controlState()) === "on", 10000); }
  const vId = viewId || await viewIdNow();
  await setPlan([{ name: "browser_navigate", args: { viewId: vId, url } }]);
  const run = await runTaskViaUI(goal);
  const seen = await waitApproval(120000);
  const rid = await approvalId();
  if (afterApproval) await afterApproval({ rid, taskId: run.taskId });
  return { ...run, rid, seen };
}

async function main() {
  killStaleRuns();
  site = await startSite();
  provider = await startD4Provider();
  await launch();
  record("boot", "B0 · 真实 electron . 启动并暴露 CDP", !!browser, "CDP 可用", "connected");
  await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gate()), 60000);
  if ((await gate()) === "uninitialized" && (await waitSel('[data-d3-id="setup-name"]', 30000))) {
    // 集成分支保留 UI 线已定的"三步初始化向导"（显示名 → 账号 → 密码），末步才提交：
    // 后两步的输入在 DOM 里尚未存在，一次填完再点 setup-submit 不会发生任何事。
    // 驱动方式与 UI 线探针（tests/fixtures/identity-ui-probe/main.cjs）一致。
    const setupNext = async () => {
      await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-next\"]'); return !!b && !b.disabled;"), 10000);
      await click('[data-d3-id="setup-next"]');
    };
    await setInput('[data-d3-id="setup-name"]', "D5-01 Boundary Admin");
    await setupNext();
    await waitSel('[data-d3-id="setup-identifier"]', 10000);
    await setInput('[data-d3-id="setup-identifier"]', ADMIN.id);
    await setupNext();
    await waitSel('[data-d3-id="setup-password"]', 10000);
    await setInput('[data-d3-id="setup-password"]', ADMIN.pw);
    await setInput('[data-d3-id="setup-confirm"]', ADMIN.pw);
    await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-submit\"]'); return !!b && !b.disabled;"), 10000);
    await click('[data-d3-id="setup-submit"]');
    await waitGate("unauthenticated", 30000);
  }
  record("boot", "B1 · 真实 UI 登录 admin", await login(ADMIN), "ready", await gate());

  /* 真实 UI：确定性 provider + 默认 chat（与 Closure-2 门禁同一条产品路径） */
  await mustClick('[data-dock-id="settings"]', "打开系统设置");
  await waitSel('[data-settings-pane="model"]', 20000);
  await mustClick('[data-settings-pane="model"]', "切到模型/AI 分区");
  await waitSel('[data-d4-01="settings"]', 20000);
  await setInput('[data-d4-01-provider-name]', "D5-01 Boundary Provider");
  await setInput('[data-d4-01-provider-scope]', "ORGANIZATION");
  await setInput('[data-d4-01-provider-url]', provider.baseUrl);
  await setInput('[data-d4-01-provider-secret]', PROVIDER_SECRET);
  await click('[data-d4-01-provider-create]');
  await waitSel('[data-d4-01-provider]', 20000);
  const pid = await js("return Array.from(document.querySelectorAll('[data-d4-01-provider]')).map((e) => e.getAttribute('data-d4-01-provider')).filter(Boolean)[0] || ''");
  await click('[data-d4-01-tab="models"]');
  await waitSel('[data-d4-01-pane="models"]', 20000);
  await setInput('[data-d4-01-model-provider]', pid);
  await setInput('[data-d4-01-model-scope]', "ORGANIZATION");
  await setInput('[data-d4-01-model-remote]', "d501-boundary-local");
  await setInput('[data-d4-01-model-name]', "D5-01 Boundary Local");
  await click('[data-d4-01-model-create]');
  await waitSel('[data-d4-01-model]', 20000);
  const cid = await attr("[data-d4-01-model]", "data-d4-01-model");
  await click('[data-d4-01-tab="defaults"]');
  await waitSel('[data-d4-01-pane="defaults"]', 20000);
  await setInput('[data-d4-01-default-personal-chat]', cid);
  await setInput('[data-d4-01-default-org-chat]', cid);
  record("setup", "B2 · 真实 UI 建立确定性 provider/model 并设为默认 chat", !!pid && !!cid, "provider+model", JSON.stringify({ pid: !!pid, cid: !!cid }));
  await setPlan([]);

  /** 工具权限一律经真实治理桥（grant/revoke 都是产品入口）。 */
  const toolAccess = () => bridge("governance", { type: "governance/getAppToolAccess", appId: "ai" });
  const grantTools = () => bridge("governance", { type: "governance/grantAppToolAccess", appId: "ai", actions: TOOLS });
  const revokeToolGrant = async () => {
    const access = await toolAccess();
    const grantId = access && Array.isArray(access.grants) && access.grants[0] ? access.grants[0].grantId : null;
    if (!grantId) return { ok: false, error: "NO_TOOL_GRANT" };
    return bridge("governance", { type: "governance/revokeAppToolAccess", grantId });
  };
  const granted = await grantTools();
  record("setup", "B3 · 治理授予 ai 两个浏览器工具权限", !!(granted && granted.ok), "granted", JSON.stringify(granted && granted.actions ? granted.actions : granted));

  const FORM = site.base + "/form";
  const PAGE2 = site.base + "/page2";
  const PAGE3 = site.base + "/page3";
  const LATE = site.base + "/late?ms=9000";
  await openBrowser();
  await navigate(FORM);
  await waitFor(() => !!viewByUrl("/form"), 25000);
  if ((await controlState()) === "off") { await click("[data-ai-control-toggle]"); await waitFor(async () => (await controlState()) === "on", 10000); }
  const VIEW = await viewIdNow();
  record("setup", "B4 · 用户在 UI 上显式授权该标签给 AI 控制", (await controlState()) === "on" && !!VIEW, "on + viewId", JSON.stringify({ state: await controlState(), viewId: VIEW }));

  /* ───────────────── P1 · claim 前撤权 → 不派发、页面零变化 ───────────────── */
  {
    const h = hits("/page2");
    const t = await navigateTask(PAGE2, {
      goal: "导航到 page2（审批后撤权）",
      afterApproval: async () => {
        const rev = await revokeToolGrant();
        record("P1", "P1.1 · 审批等待期间真实撤掉 ai 的工具权限（治理入口）", !!(rev && rev.ok), "revoked", JSON.stringify(rev));
        await click('[data-approval-action="approve"]');
      },
    });
    await waitTaskTerminal(t.taskId, 120000);
    const call = callById(t.rid);
    record("P1", "P1.2 · claim 前撤权 → 调用不成功、绝不派发导航", !!call && call.status !== "SUCCEEDED" && hits("/page2") === h, "call≠SUCCEEDED 且 0 新导航", JSON.stringify({ status: call && call.status, error: call && call.error_code, hits: hits("/page2") - h }));
    record("P1", "P1.3 · 页面零变化（真实视图仍在 /form）", (await value(ADDRESS_SEL)) === FORM && !!viewByUrl("/form"), FORM, await value(ADDRESS_SEL));
    const leases = tableRows("side_effect_leases").filter((l) => l.call_id === (call && call.call_id));
    record("P1", "P1.4 · 不留 ACTIVE lease", leases.filter((l) => l.status === "ACTIVE").length === 0, "0 ACTIVE", JSON.stringify(leases.map((l) => l.status)));
    await grantTools();
  }

  /* ───────────────── P2 · 派发后停止 + 迟到完成不覆盖 ───────────────── */
  {
    const h = hits("/late");
    const t = await navigateTask(LATE, {
      goal: "导航到会迟到的地址（随后取消）",
      afterApproval: async () => {
        await click('[data-approval-action="approve"]');
        await waitFor(() => hits("/late") === h + 1, 20000);
        record("P2", "P2.1 · 已真实派发（站点收到请求）", hits("/late") === h + 1, "1 次请求", String(hits("/late") - h));
        await click("[data-ai-cancel]");
      },
    });
    const term = await waitTaskTerminal(t.taskId, 120000);
    // 任务取消与 call 收敛是**两步**：等 call 真正落地终态再断言（测产品，不测竞态）。
    const converged = await waitFor(() => { const c = callById(t.rid); return !!c && ["UNKNOWN_EFFECT", "FAILED", "BLOCKED", "SUCCEEDED", "CANCELLED"].includes(String(c.status)); }, 25000);
    const call = callById(t.rid);
    const got = await taskGet(t.taskId);
    record("P2", "P2.2 · 停止后调用收敛为**结果未知**（不是 FAILED、更不是'未执行'）", term && converged && !!call && call.status === "UNKNOWN_EFFECT", "UNKNOWN_EFFECT", JSON.stringify({ status: call && call.status, error: call && call.error_code }));
    record("P2", "P2.3 · 任务/步骤都有终态（不悬挂）", !!got.task && got.task.status !== "RUNNING" && (got.steps || []).every((s) => s.status !== "RUNNING"), "非 RUNNING", JSON.stringify({ task: got.task.status, steps: (got.steps || []).map((s) => s.status) }));
    record("P2", "P2.4 · 停止不产生第二次派发（站点仍只有 1 次请求）", hits("/late") === h + 1, "1 次请求", String(hits("/late") - h));
    // 等迟到完成真的发生：页面最终会落到 LATE-MARKER，但权威状态不得被它改写
    const landed = await waitFor(() => !!viewByUrl("/late"), 20000);
    const marker = landed ? await viewEval(viewByUrl("/late"), "return document.getElementById('late-marker')?.textContent || ''") : "";
    record("P2", "P2.5 · 迟到完成确实发生了（真实视图已落到迟到页面）", marker === "LATE-MARKER-5a1c", "LATE-MARKER-5a1c", JSON.stringify({ url: viewByUrl("/late") ? viewByUrl("/late").url() : null, marker }));
    await sleep(1500);
    const after = callById(t.rid);
    record("P2", "P2.6 · 迟到完成**绝不覆盖**已经形成的权威未知状态", !!after && after.status === "UNKNOWN_EFFECT", "仍为 UNKNOWN_EFFECT", after && after.status);
    const recovery = tableRows("side_effect_calls").filter((r) => r.call_id === t.rid).map((r) => { try { return JSON.parse(String(r.recovery_safe || "{}")).outcome || null; } catch { return null; } })[0];
    record("P2", "P2.7 · 即时只读恢复结论 = 无结论（不给假结论）", recovery === "INDETERMINATE", "INDETERMINATE", String(recovery));
    const panelText = await visibleText(".ai-panel");
    record("P2", "P2.8 · UI 如实显示停止/未成功，绝不谎称成功", !/SUCCEEDED|已完成/.test(panelText) && /CANCELLED|BLOCKED|停止|已取消/.test(panelText), "如实停止态", panelText.split("\n").join(" ").slice(0, 120));
  }

  /* ───────────────── P3 · 执行中关闭标签 ───────────────── */
  {
    await navigate(PAGE2);
    await waitFor(() => !!viewByUrl("/page2"), 20000);
    const h2 = hits(PAGE2);
    const hL = hits("/late");
    const t = await navigateTask(LATE, {
      goal: "导航到会迟到的地址（随后关标签）",
      afterApproval: async () => {
        await click('[data-approval-action="approve"]');
        await waitFor(() => hits("/late") === hL + 1, 20000);
        await click('[data-tab-active="1"] .tab-close');
        await sleep(300);
      },
    });
    const term = await waitTaskTerminal(t.taskId, 120000);
    const call = callById(t.rid);
    record("P3", "P3.1 · 执行中关闭标签 → 调用判**不可知**并收敛", term && !!call && call.status === "UNKNOWN_EFFECT", "UNKNOWN_EFFECT", JSON.stringify({ status: call && call.status, error: call && call.error_code }));
    record("P3", "P3.2 · 绝不转向别的标签（没有对 /page2 或管理界面的新导航）", hits(PAGE2) === h2 && hits("/late") === hL + 1, "0 额外导航", JSON.stringify({ page2: hits(PAGE2) - h2, late: hits("/late") - hL }));
    const got = await taskGet(t.taskId);
    record("P3", "P3.3 · 任务/步骤终态一致（不悬挂）", !!got.task && got.task.status !== "RUNNING" && (got.steps || []).every((s) => s.status !== "RUNNING"), "非 RUNNING", JSON.stringify({ task: got.task.status, steps: (got.steps || []).map((s) => s.status) }));
    // 结果未知 + 任务 BLOCKED 时，产品必须给出人工核查入口（D4-05 S2 的恢复面板），且结论是"尚无结论"。
    await js("if (!document.querySelector('.ai-panel')) { const b = document.querySelector('.assistant-pill'); if (b) b.click(); } return 'ok';");
    const recoveryShown = await waitFor(async () => (await has("[data-ai-recovery]")) || (await visibleText(".ai-panel")).includes("结果未知"), 15000);
    const rec = await bridge("task", { type: "task/recovery", taskId: t.taskId });
    record("P3", "P3.4 · 结果未知时给出人工核查入口（恢复面板 / task-recovery），结论不冒充", recoveryShown && !!rec && rec.ok === true && (rec.calls || []).every((c) => c.recoveryResult === "NO_CONCLUSION" || c.recoveryResult === "INDETERMINATE"), "恢复入口 + 无结论", JSON.stringify({ panel: recoveryShown, applicable: rec && rec.applicable, calls: (rec && rec.calls ? rec.calls.map((c) => c.recoveryResult) : []) }));
  }

  /* ───────────────── P4 · 归因：本次导航在途时用户自己导航走 ───────────────── */
  {
    await openBrowser();
    const tabs = await js("return document.querySelectorAll('[data-tab]').length");
    if (tabs === 0) { await click('[aria-label="打开浏览器"]'); await waitSel("[data-browser-window]", 20000); }
    await navigate(FORM);
    await waitFor(() => !!viewByUrl("/form"), 25000);
    if ((await controlState()) === "off") { await click("[data-ai-control-toggle]"); await waitFor(async () => (await controlState()) === "on", 10000); }
    const vId = await viewIdNow();
    const ATTRIB = site.base + "/late?ms=9000&once=1";
    const hA = hits("/late");
    const hB = hits("/page2");
    await setPlan([{ name: "browser_navigate", args: { viewId: vId, url: ATTRIB } }]);
    const run = await runTaskViaUI("导航到会迟到的地址（用户随后自己导航走）");
    await waitApproval(120000);
    const rid = await approvalId();
    await click('[data-approval-action="approve"]');
    await waitFor(() => hits("/late") === hA + 1, 20000);
    record("P4", "P4.0 · 本次导航已真实派发（站点收到请求）", hits("/late") === hA + 1, "1 次请求", String(hits("/late") - hA));
    // 用户**自己**把同一个标签导航到另一个地址（真实指针之外的正常产品入口：地址栏）
    await navigate(PAGE2);
    const landed = await waitFor(() => !!viewByUrl("/page2"), 25000);
    const term = await waitTaskTerminal(run.taskId, 150000);
    const converged = await waitFor(() => { const c = callById(rid); return !!c && ["UNKNOWN_EFFECT", "FAILED", "BLOCKED", "SUCCEEDED", "CANCELLED"].includes(String(c.status)); }, 25000);
    const call = callById(rid);
    record("P4", "P4.1 · 用户自己的导航确实落地（真实视图在用户的页面）", landed && (await value(ADDRESS_SEL)).endsWith("/page2") && hits("/page2") === hB + 1, "用户的 /page2 已落地", JSON.stringify({ address: await value(ADDRESS_SEL), page2: hits("/page2") - hB }));
    record("P4", "P4.2 · 本次执行**绝不被记成成功**（没有把自己的导航算作本次结果）", term && converged && !!call && call.status !== "SUCCEEDED", "call≠SUCCEEDED", JSON.stringify({ status: call && call.status, error: call && call.error_code }));
    const conclusion = call && call.status === "FAILED" ? "KNOWN_NO_EFFECT(" + call.error_code + ")" : (call ? String(call.status) : "?");
    record("P4", "P4.3 · 结论是可辩护的：未提交过我们的地址 → 明确未生效；否则不可知", ["FAILED", "UNKNOWN_EFFECT", "BLOCKED"].includes(String(call && call.status)), "FAILED/UNKNOWN_EFFECT/BLOCKED", conclusion);
    record("P4", "P4.4 · 绝不产生第二次派发", hits("/late") === hA + 1, "1 次请求", String(hits("/late") - hA));
  }

  /* ───────────────── P5 · 并发/重复：双击批准只派发一次 ───────────────── */
  {
    await navigate(PAGE2);
    await waitFor(() => !!viewByUrl("/page2"), 20000);
    const h = hits(PAGE3);
    const t = await navigateTask(PAGE3, {
      goal: "导航到 page3（双击批准）",
      afterApproval: async () => {
        await js("const b = document.querySelector('[data-approval-action=\"approve\"]'); if (b) { b.click(); b.click(); } return 'ok';");
      },
    });
    await waitTaskTerminal(t.taskId, 120000);
    await sleep(800);
    const call = callById(t.rid);
    const leases = tableRows("side_effect_leases").filter((l) => l.call_id === (call && call.call_id));
    record("P5", "P5.1 · 双击批准只产生一次派发（站点恰好 +1）", hits("/page3") === h + 1, "+1", String(hits("/page3") - h));
    record("P5", "P5.2 · 恰好 1 次执行 lease、调用 SUCCEEDED", leases.length === 1 && !!call && call.status === "SUCCEEDED", "1 lease + SUCCEEDED", JSON.stringify({ leases: leases.length, status: call && call.status }));
  }

  /* ───────────────── P6 · 地址绑定：旧批准不得用于新地址 ───────────────── */
  {
    // 每次都从**已知起点**开始：先真实导航到 /form，确保"本次目标 ≠ 当前地址"。
    await navigate(FORM);
    await waitFor(() => !!viewByUrl("/form"), 25000);
    // 加 cache-busting 参数：同一会话里重复打开同一地址可能命中缓存而**不产生网络请求**，
    // 那样站点计数就不再等于"派发次数"（本用例要测的正是派发）。
    const PAGE2B = PAGE2 + "?probe=p6a";
    const PAGE3B = PAGE3 + "?probe=p6b";
    const h2 = hits(PAGE2);
    const t2 = await navigateTask(PAGE2B, { goal: "导航到 page2（绑定用例）", afterApproval: async () => { await click('[data-approval-action="approve"]'); } });
    await waitTaskTerminal(t2.taskId, 120000);
    const landed2 = await waitFor(() => !!viewByUrl("/page2"), 25000);
    const c2 = callById(t2.rid);
    const h3 = hits(PAGE3);
    const t3 = await navigateTask(PAGE3B, { goal: "导航到 page3（绑定用例）", afterApproval: async () => { await click('[data-approval-action="approve"]'); } });
    await waitTaskTerminal(t3.taskId, 120000);
    const landed3 = await waitFor(() => !!viewByUrl("/page3"), 25000);
    const c3 = callById(t3.rid);
    const eff2 = (() => { try { return JSON.parse(String(c2 && c2.expected_effects_safe || "[]"))[0] || {}; } catch { return {}; } })();
    const eff3 = (() => { try { return JSON.parse(String(c3 && c3.expected_effects_safe || "[]"))[0] || {}; } catch { return {}; } })();
    record("P6", "P6.1 · 两次导航各自用自己的批准与地址（plan 不同、各自的 plan 里就是各自的地址）", !!c2 && !!c3 && c2.plan_hash !== c3.plan_hash && preOf(c2).url === PAGE2B && preOf(c3).url === PAGE3B, "两次独立绑定", JSON.stringify({ sameHash: !!c2 && !!c3 && c2.plan_hash === c3.plan_hash, u2: preOf(c2).url, u3: preOf(c3).url }));
    record("P6", "P6.1b · 两次都是从**不同地址**出发的真实导航（不是同址 no-op）", eff2.from !== eff2.to && eff3.from !== eff3.to, "from≠to", JSON.stringify({ nav2: { from: eff2.from, to: eff2.to }, nav3: { from: eff3.from, to: eff3.to } }));
    record("P6", "P6.2 · 各自真实落地到自己的地址（真实视图 = 目标）", landed2 && landed3 && hits(PAGE2) === h2 + 1 && hits(PAGE3) === h3 + 1, "each +1 且视图到位", JSON.stringify({ page2: hits(PAGE2) - h2, page3: hits(PAGE3) - h3, landed2, landed3 }));
  }

  const tail = stderrBuf.split("\n").filter((l) => /error|Error|FATAL/.test(l)).filter((l) => !/ExperimentalWarning|SQLite is an experimental/i.test(l)).slice(0, 5);
  record("hygiene", "H1 · 主进程无未处理错误", tail.length === 0, "无错误行", tail.join(" | ") || "clean");

  notVerified("像素级可见性（本门禁只用 CDP + 站点侧证据，不含屏幕截图）", "屏幕级证据见同一轮的可见性门禁 docs/D5-01-CLOSURE3-VISIBILITY-*；本门禁不冒充像素证据。");

  const out = {
    phase: "D5-01 Closure-3",
    title: "主进程内执行类的执行边界（真实原生视图 + 本地站点）",
    testedCommit: process.env.OPENARC_TESTED_COMMIT || null,
    workspaceState: process.env.OPENARC_WORKSPACE_STATE ?? null,
    command: process.env.npm_lifecycle_event ? "npm run " + process.env.npm_lifecycle_event : "node experiments/d5-01/browser-inprocess-boundary-e2e.mjs",
    env: { platform: process.platform, arch: process.arch, node: process.version, electron: require("electron/package.json").version },
    isolation: { userData: "os.tmpdir mkdtemp", site: "本地受控站点 127.0.0.1", provider: "本地确定性 provider（只替代最后一跳网络）" },
    checks: CHECKS, counts: { pass: passed, fail: failed, total: CHECKS.length },
    notVerified: NOT_VERIFIED, observations: OBSERVATIONS, operationRecord: RECORD, at: new Date().toISOString(),
  };
  fs.mkdirSync(ART, { recursive: true });
  fs.writeFileSync(path.join(ART, "d5-01-browser-inprocess-boundary-e2e.json"), JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(ART, "d5-01-browser-inprocess-boundary-record.jsonl"), RECORD.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log("\n结论：" + (failed === 0 ? "PASS" : "FAIL") + " — " + JSON.stringify({ pass: passed, fail: failed, total: CHECKS.length, notVerified: NOT_VERIFIED.length }));
  return failed === 0 ? 0 : 1;
}

killStaleRuns();
let exitCode = 2;
try {
  exitCode = await main();
} catch (e) {
  console.error("门禁异常：" + String((e && e.stack) || e));
  console.error(stderrBuf.split("\n").slice(-25).join("\n"));
  exitCode = 2;
}
try { if (browser) await browser.close().catch(() => {}); } catch { /* ignore */ }
try { if (child) child.kill("SIGKILL"); } catch { /* ignore */ }
killOurElectron();
try { if (site) await site.close(); } catch { /* ignore */ }
try { if (provider) await provider.close(); } catch { /* ignore */ }
process.exit(exitCode);
