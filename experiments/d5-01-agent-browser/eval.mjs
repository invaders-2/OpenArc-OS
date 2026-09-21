/**
 * D5-01 · agent-browser 兼容性验证（独立测试设施，不改产品代码）。
 *
 * 目的：确认 vercel-labs/agent-browser 能否控制 **OpenArc 内置浏览器（真实标签页）**，
 * 为正式选型提供依据。本轮不做模型自主规划，全部是确定性操作。
 *
 * 连接方式：真实 `electron .` 以 `--remote-debugging-port`（仅本机、仅本次运行）启动，
 * agent-browser 用 `--cdp <port>` 连上去，并用 `--pin-tab` 把会话钉在指定标签上。
 *
 * 只用本地受控站点（experiments/d5-01/site.mjs）+ 独立测试账号 + 临时浏览器数据目录。
 */
import { chromium } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { startSite } from "../d5-01/site.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(decodeURIComponent(here), "../..");
const ART = path.join(ROOT, "artifacts", "d5-01-agent-browser");
const AB_BIN = process.env.OA_AGENT_BROWSER_BIN || "/tmp/oa-agentbrowser/node_modules/.bin/agent-browser";
const AB_VERSION = process.env.OA_AGENT_BROWSER_VERSION || "0.38.1";
const CDP_PORT = Number(process.env.OA_D501_AB_CDP_PORT || 9795);
const ADMIN = { id: "admin@d501.test", pw: "admin-password-1" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d501-ab-"));
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d501-ab-dl-"));
// 会话 socket 路径有 103 字节上限：HOME 与 socket 目录都必须短（临时长路径会让会话名"过长"）。
const abHome = "/tmp/oa-ab-home";
fs.mkdirSync(abHome, { recursive: true });
const abSock = "/tmp/oa-ab-sock";
fs.mkdirSync(abSock, { recursive: true });

const CHECKS = [];
const RECORD = [];
let pass = 0;
let fail = 0;
function record(section, name, ok, expected, actual) {
  const row = { section, name, status: ok ? "PASS" : "FAIL", expected: String(expected ?? ""), actual: String(actual ?? "").slice(0, 600), at: Date.now() };
  CHECKS.push(row);
  if (ok) pass += 1;
  else fail += 1;
  console.log((ok ? "  " : "! ") + "[" + row.status + "] " + section + " · " + name + (ok ? "" : " — 期望 " + row.expected + "，实际 " + row.actual));
  return ok;
}

/** 跑一次 agent-browser（独立 HOME，避免污染用户配置）。 */
function ab(args, { timeoutMs = 90000 } = {}) {
  const started = Date.now();
  try {
    const stdout = execFileSync(AB_BIN, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      env: { ...process.env, HOME: abHome, AGENT_BROWSER_SOCKET_DIR: abSock, AGENT_BROWSER_NAMESPACE: "d501", ELECTRON_RUN_AS_NODE: undefined },
    });
    const row = { args, code: 0, stdout: stdout.trim(), at: Date.now() - started };
    RECORD.push(row);
    return row;
  } catch (e) {
    const row = { args, code: e.status == null ? -1 : e.status, stdout: String(e.stdout || "").trim(), stderr: String(e.stderr || "").trim().slice(0, 400), at: Date.now() - started };
    RECORD.push(row);
    return row;
  }
}
const abJson = (row) => { try { return JSON.parse(row.stdout); } catch { return null; } };
const session = ["--session", "s1", "--cdp", String(CDP_PORT)];

let child = null;
let browser = null;
let page = null;
async function launch() {
  child = spawn(electronPath, [".", "--user-data-dir=" + userData, "--remote-debugging-port=" + CDP_PORT, ...extraArgs], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OPENARC_IDENTITY_ADMIN: "1", OPENARC_DOWNLOADS_DIR: downloads, ELECTRON_RUN_AS_NODE: undefined, ELECTRON_NO_ATTACH_CONSOLE: undefined },
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  let version = null;
  const deadline = Date.now() + 40000;
  while (!version && Date.now() < deadline) { try { version = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version")).json(); } catch { await sleep(300); } }
  if (!version) throw new Error("CDP 未就绪");
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP_PORT);
  const ctx = browser.contexts()[0];
  page = null;
  const end = Date.now() + 30000;
  while (!page && Date.now() < end) { page = ctx.pages().find((p) => p.url().includes("dist/index.html")) || null; if (!page) await sleep(300); }
  if (!page) throw new Error("未找到 OpenArc 界面页");
}
async function stop() { try { await browser?.close(); } catch { /* ignore */ } try { child?.kill("SIGKILL"); } catch { /* ignore */ } await sleep(400); }

const js = (code) => page.evaluate("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const attr = (sel, a) => js("return document.querySelector(" + JSON.stringify(sel) + ")?.getAttribute(" + JSON.stringify(a) + ") || ''");
const click = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; el.click(); return 'ok';");
const setInput = (sel, value) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el," + JSON.stringify(value) + "); el.dispatchEvent(new Event('input',{bubbles:true})); return 'ok';");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
async function waitFor(fn, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch { /* retry */ } await sleep(120); } return false; }
const waitSel = (sel, ms) => waitFor(() => has(sel), ms);
async function targets() { const r = await fetch("http://127.0.0.1:" + CDP_PORT + "/json/list"); return (await r.json()).filter((t) => t.type === "page").map((t) => ({ id: t.id, url: t.url, title: t.title })); }

async function main() {
  const site = await startSite();
  try {
    await launch();
    await waitFor(async () => (await gate()) !== "checking", 30000);
    if ((await gate()) === "uninitialized") {
      await setInput('[data-d3-id="setup-name"]', "D5-01 Agent Admin");
      await setInput('[data-d3-id="setup-identifier"]', ADMIN.id);
      await setInput('[data-d3-id="setup-password"]', ADMIN.pw);
      await setInput('[data-d3-id="setup-confirm"]', ADMIN.pw);
      await click('[data-d3-id="setup-submit"]');
      await waitFor(async () => (await gate()) === "unauthenticated", 30000);
    }
    await setInput('[data-d3-id="login-identifier"]', ADMIN.id);
    await setInput('[data-d3-id="login-password"]', ADMIN.pw);
    await click('[data-d3-id="login-submit"]');
    await waitFor(async () => (await gate()) === "ready", 30000);

    /* ═══ 前置：真实内置标签页 ═══ */
    await click('[aria-label="打开浏览器"]');
    const opened = await waitSel("[data-browser-window]", 20000);
    await setInput('[aria-label="网页地址"]', site.base + "/form");
    await click(".addressbar .primary");
    await sleep(2500);
    const t0 = await targets();
    const formTarget = t0.find((t) => t.url.includes("/form"));
    record("precondition", "P0 · 真实 electron . 内置浏览器已具备真实标签页", opened && !!formTarget, "存在 WebContentsView 标签（/form）", JSON.stringify(t0.map((t) => t.url)));

    // 第二个标签（用产品自己的新标签入口）
    await click("[data-tab-new]");
    await waitFor(async () => (await js("return document.querySelectorAll('[data-tab]').length")) === 2, 10000);
    await setInput('[aria-label="网页地址"]', site.base + "/page2");
    await click(".addressbar .primary");
    await sleep(2000);
    const t1 = await targets();
    const page2Target = t1.find((t) => t.url.includes("/page2"));
    // 切回 t1：让"产品活动标签"就是后面被 Agent 钉住的 /form 标签，
    // 这样"用户切换焦点"与"Agent 的目标"才是一个有意义的对照。
    await js("document.querySelector('[data-tab=t1] .tab-main').click()");
    await sleep(600);
    record("precondition", "P1 · 两个标签各自有独立 CDP target", !!formTarget && !!page2Target, "两个 target", JSON.stringify(t1.map((t) => t.url)));

    /* ═══ 1 · 连接与目标选择 ═══ */
    const list = ab([...session, "tab", "list", "--json"]);
    const listJson = abJson(list);
    record("connect", "C1 · agent-browser 可通过 CDP 连接内置浏览器并列出标签", list.code === 0 && !!listJson, "exit 0 + JSON", JSON.stringify(list.stdout).slice(0, 200));
    const listedTargets = Array.isArray(listJson) ? listJson : listJson?.data?.tabs || listJson?.tabs || [];
    record("connect", "C2 · 目标清单同时包含 OpenArc 界面页与网页标签（可见范围）", listedTargets.some((t) => String(t.url || "").includes("index.html")) && listedTargets.some((t) => String(t.url || "").includes("/form")), "界面页 + 网页都在清单里", JSON.stringify(listedTargets.map((t) => t.url)));

    // 绑定顺序是**必须**的：无绑定直接 --pin-tab 会让 CLI 调 Target.createTarget
    // （Electron 的 CDP 不支持该端点，直接报 "Not supported"）。
    // 先 list 建立会话 → tab <targetId> 绑定 → 之后所有命令带 --pin-tab。
    ab([...session, "tab", "list", "--json"]);
    const bind = ab([...session, "tab", formTarget.id, "--json"]);
    const pinned = ab([...session, "--pin-tab", "get", "url", "--json"]);
    record("connect", "C3 · 把控制会话钉在指定网页标签（targetId + --pin-tab）", bind.code === 0 && pinned.code === 0, "exit 0", JSON.stringify({ bind: bind.stdout.slice(0, 100), pinned: pinned.stdout.slice(0, 100) }));

    const where = ab([...session, "--pin-tab", "eval", "JSON.stringify({ href: location.href, shell: !!document.querySelector('[data-browser-window]'), form: !!document.getElementById('submit') })", "--json"]);
    const whereJson = abJson(where);
    const payload = whereJson?.data?.result ?? whereJson?.result ?? whereJson?.data ?? whereJson;
    const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
    record("connect", "C4 · 操作落在指定网页标签，而不是 OpenArc 管理界面", where.code === 0 && parsed?.form === true && parsed?.shell === false && String(parsed?.href || "").includes("/form"), "网页 /form 且无外壳 DOM", JSON.stringify(parsed));

    /* ═══ 2 · 读 / 点 / 输入 / 滚动 / 导航 ═══ */
    const title = ab([...session, "--pin-tab", "get", "title", "--json"]);
    record("actions", "A1 · 读页面标题", title.code === 0 && /FORM/.test(title.stdout), "FORM", title.stdout.slice(0, 80));
    const fill = ab([...session, "--pin-tab", "fill", "#name", "openarc-agent", "--json"]);
    const value = ab([...session, "--pin-tab", "get", "value", "#name", "--json"]);
    record("actions", "A2 · 输入文本并读回", fill.code === 0 && /openarc-agent/.test(value.stdout), "openarc-agent", value.stdout.slice(0, 80));
    const btn = ab([...session, "--pin-tab", "click", "#submit", "--json"]);
    const echo = ab([...session, "--pin-tab", "get", "text", "#echo", "--json"]);
    record("actions", "A3 · 点击按钮并取得可核查结果（页面自身状态变化）", btn.code === 0 && /echo:openarc-agent/.test(echo.stdout), "echo:openarc-agent", echo.stdout.slice(0, 80));
    const scroll = ab([...session, "--pin-tab", "scroll", "down", "600", "--json"]);
    const scrollY = ab([...session, "--pin-tab", "eval", "String(Math.round(window.scrollY))", "--json"]);
    record("actions", "A4 · 滚动页面", scroll.code === 0 && /[1-9][0-9]{2,}/.test(scrollY.stdout), "scrollY > 0", scrollY.stdout.slice(0, 60));
    // 导航：open/goto 在本组合（Electron CDP + pin-tab）**会挂起不返回**。
    // 如实记录：命令本身超时（exit -1），但导航动作确实发生 —— 由随后的 get url 证实。
    const nav = ab([...session, "--pin-tab", "open", site.base + "/page2", "--json"], { timeoutMs: 30000 });
    // 挂起的命令会把 daemon 占住：后续命令要重试到它恢复（这正是"停止/接管"要处理的状态）。
    let url = { code: -1, stdout: "" };
    for (let i = 0; i < 8; i += 1) {
      url = ab([...session, "--pin-tab", "get", "url", "--json"], { timeoutMs: 20000 });
      if (url.code === 0) break;
      await sleep(3000);
    }
    const navigated = /\/page2/.test(url.stdout);
    record("actions", "A5 · 导航到指定 URL（命令返回）", nav.code === 0, "exit 0", JSON.stringify({ code: nav.code, out: nav.stdout.slice(0, 120), err: nav.stderr.slice(0, 120) }));
    record("actions", "A5b · 导航动作是否真的生效（命令挂起后的实际结果）", navigated, "URL 变为 /page2", url.stdout.slice(0, 140));
    // 回到 /form（用产品自己的导航；此时活动标签就是 t1 = 被钉住的标签）
    await setInput('[aria-label="网页地址"]', site.base + "/form");
    await click(".addressbar .primary");
    await sleep(1800);

    /* ═══ 6 · 刷新 / 导航后的旧 ref（必须在关标签之前做） ═══ */
    const snap1 = ab([...session, "--pin-tab", "snapshot", "-i", "--json"]);
    const staleRef = (() => { try { const j = JSON.parse(snap1.stdout); const refs = j?.data?.refs || {}; const first = Object.keys(refs)[0]; return first ? "@" + first : null; } catch { return null; } })();
    // 刷新由**产品**执行（reload 命令在本组合里同样可能挂起），这与"用户刷新页面"是同一场景。
    await click('[aria-label="刷新"]');
    await sleep(1500);
    let staleResult = "no-ref";
    if (staleRef) {
      const stale = ab([...session, "--pin-tab", "click", staleRef, "--json"]);
      staleResult = JSON.stringify({ code: stale.code, stdout: String(stale.stdout || "").slice(0, 120), stderr: String(stale.stderr || "").slice(0, 120) });
      const snap2 = ab([...session, "--pin-tab", "snapshot", "-i", "--json"]);
      const freshRef = (() => { try { const j = JSON.parse(snap2.stdout); const refs = j?.data?.refs || {}; const first = Object.keys(refs).find((k) => k !== (staleRef || "").replace("@", "")); return first ? "@" + first : null; } catch { return null; } })();
      const fresh = freshRef ? ab([...session, "--pin-tab", "click", freshRef, "--json"]) : { code: -1 };
      record("stale", "R1 · 刷新后旧 ref 不产生错误点击，重新快照后可用", fresh.code === 0, "重新识别页面", JSON.stringify({ staleRef, stale: staleResult.slice(0, 160), freshRef, freshCode: fresh.code }));
    } else {
      record("stale", "R1 · 刷新后旧 ref 不产生错误点击，重新快照后可用", false, "snapshot 产出 @e ref", snap1.stdout.slice(0, 120));
    }

    /* ═══ 3 · 双标签 + 用户切换焦点 ═══ */
    // 让用户在 OpenArc 里切到第二个标签（真实 UI 点击），Agent 仍应操作原标签
    const pathOf = (row) => { try { const j = JSON.parse(row.stdout); return String(j?.data?.result ?? j?.result ?? ""); } catch { return ""; } };
    const before3 = ab([...session, "--pin-tab", "eval", "location.pathname", "--json"]);
    await js("document.querySelector('[data-tab=t2] .tab-main').click()");
    await sleep(800);
    const after3 = ab([...session, "--pin-tab", "eval", "location.pathname", "--json"]);
    const p1v = pathOf(before3);
    const p2v = pathOf(after3);
    record("two-tabs", "T1 · 用户切换活动标签后，Agent 仍操作被钉住的标签", after3.code === 0 && p2v === p1v && /^\//.test(p2v), "与 before 相同的站内路径", JSON.stringify({ before: p1v, after: p2v }));
    const otherTabUntouched = await js("return document.querySelector('[data-tab=t2]')?.getAttribute('data-tab-active')");
    record("two-tabs", "T2 · 用户的标签状态未被 Agent 改写（界面活动标签仍是 t2）", otherTabUntouched === "1", "t2 active", String(otherTabUntouched));

    /* ═══ 4 · 指定标签关闭 → 旧控制对象失效（不转向别的标签） ═══ */
    const beforeClose = ab([...session, "--pin-tab", "eval", "location.href", "--json"]);
    await js("document.querySelector('[data-tab=t1] .tab-close').click()");
    await sleep(1200);
    const afterClose = ab([...session, "--pin-tab", "eval", "location.href", "--json"]);
    const goneCode = (() => { const j = abJson(afterClose); return j?.code || j?.error?.code || (afterClose.stdout.match(/tab_gone/) ? "tab_gone" : null); })();
    record("tab-gone", "G1 · 被钉住的标签关闭后，控制命令明确失败（tab_gone）", afterClose.code !== 0 && String(afterClose.stdout + afterClose.stderr).includes("tab_gone"), "exit≠0 + tab_gone", JSON.stringify({ code: afterClose.code, out: afterClose.stdout.slice(0, 160), err: afterClose.stderr.slice(0, 160), goneCode }));
    const targetsAfterClose = await targets();
    record("tab-gone", "G2 · 旧控制对象没有自动转向其它标签（t2 页面未被操作）", !!targetsAfterClose.find((t) => t.url.includes("/page2")) && !targetsAfterClose.find((t) => t.url.includes("/form")), "只剩 t2", JSON.stringify(targetsAfterClose.map((t) => t.url)));

    /* ═══ 7 · 登出 / 切账号 → 旧控制会话不能继续 ═══ */
    await click('[data-d3-id="topbar-logout"]');
    await waitFor(async () => (await gate()) === "unauthenticated", 20000);
    await sleep(1200);
    const afterLogout = ab([...session, "--pin-tab", "eval", "location.href", "--json"]);
    const logoutTargets = await targets();
    record("logout", "L1 · 登出后旧控制会话不能再操作（标签已被释放）", afterLogout.code !== 0, "exit≠0", JSON.stringify({ code: afterLogout.code, out: afterLogout.stdout.slice(0, 140), err: afterLogout.stderr.slice(0, 140) }));
    record("logout", "L2 · 旧会话没有悄悄接管 OpenArc 界面页", !logoutTargets.find((t) => t.url.includes("/form") || t.url.includes("/page2")), "无网页标签残留", JSON.stringify(logoutTargets.map((t) => t.url)));

    /* ═══ 边界 · 控制连接能看到什么 / 权限隔离缺失 ═══ */
    const inv = ab([...session, "tab", "list", "--json"]);
    const invJson = abJson(inv);
    const invList = Array.isArray(invJson) ? invJson : invJson?.data?.tabs || invJson?.tabs || [];
    record("boundary", "B1 · 如实记录：控制连接能看到 OpenArc 界面页 target", invList.some((t) => String(t.url || "").includes("index.html")), "界面页在清单中", JSON.stringify(invList.map((t) => t.url)));
    const uiTarget = logoutTargets.find((t) => t.url.includes("index.html"));
    let uiReach = { code: -1, stdout: "" };
    if (uiTarget) {
      ab(["--session", "s2", "--cdp", String(CDP_PORT), "tab", uiTarget.id, "--json"]);
      uiReach = ab(["--session", "s2", "--cdp", String(CDP_PORT), "eval", "document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'none'", "--json"]);
    }
    record("boundary", "B2 · 如实记录：标签固定**不等于**权限隔离（可另行绑到界面页）", uiReach.code === 0, "能读到界面页 DOM（预期为真，作为正式接入阻塞登记）", JSON.stringify({ code: uiReach.code, out: uiReach.stdout.slice(0, 120) }));
    let portListen = "";
    try { portListen = execFileSync("lsof", ["-nP", "-iTCP:" + CDP_PORT, "-sTCP:LISTEN"], { encoding: "utf8" }).trim(); } catch { portListen = ""; }
    record("boundary", "B3 · 调试端口只在本机监听（127.0.0.1）", /127\.0\.0\.1:\d+/.test(portListen) && !/\*:\d+/.test(portListen), "127.0.0.1 监听", portListen.split("\n").slice(-1)[0] || "无监听");
  } finally {
    await stop();
    try { await site.close(); } catch { /* ignore */ }
  }

  let portAfter = "";
  try { portAfter = execFileSync("lsof", ["-nP", "-iTCP:" + CDP_PORT, "-sTCP:LISTEN"], { encoding: "utf8" }).trim(); } catch { portAfter = ""; }
  record("boundary", "B4 · 产品退出后调试端口关闭", portAfter === "", "无监听", portAfter || "已关闭");
  let productFlag = "";
  try { productFlag = execFileSync("grep", ["-rn", "remote-debugging", "electron/main.cjs", "package.json"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch { productFlag = ""; }
  record("boundary", "B5 · 常规产品启动不永久开放调试端口", productFlag === "", "产品入口/脚本无 remote-debugging", productFlag || "无");

  const out = {
    phase: "D5-01",
    title: "agent-browser 兼容性验证（OpenArc 内置浏览器真实标签页）",
    testedCommit: process.env.OPENARC_TESTED_COMMIT || null,
    agentBrowser: { version: AB_VERSION, license: "Apache-2.0", dependencies: [], bin: AB_BIN, connection: "--cdp <port>（本机 127.0.0.1，仅本次运行）+ --pin-tab <targetId>" },
    counts: { pass, fail, total: CHECKS.length },
    checks: CHECKS,
    commands: RECORD.map((r) => ({ args: r.args, code: r.code, stdout: String(r.stdout).slice(0, 300), stderr: String(r.stderr || "").slice(0, 200), ms: r.at })),
    at: new Date().toISOString(),
  };
  fs.mkdirSync(ART, { recursive: true });
  fs.writeFileSync(path.join(ART, "agent-browser-eval.json"), JSON.stringify(out, null, 2));
  console.log("\n结论：" + (fail === 0 ? "PASS" : "FAIL") + " — " + JSON.stringify({ pass, fail, total: CHECKS.length }));
  process.exit(fail === 0 ? 0 : 1);
}

await main().catch((e) => { console.error("EVAL_THREW", e && e.stack ? e.stack : e); process.exit(2); });
