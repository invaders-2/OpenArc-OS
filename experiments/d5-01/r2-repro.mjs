/** D5-01 · R2 复现探针：导航 → 持久化 → 正常退出 → 重启恢复 的逐步对照。 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { startSite, startTls } from "./site.mjs";
const require = createRequire(import.meta.url);
const electronPath = require("electron");
const ROOT = path.resolve(decodeURIComponent(path.dirname(new URL(import.meta.url).pathname)), "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-r2-"));
const site = await startSite({ port: 5391 });
const tls = await startTls({ port: 5393 });
const CDP = 9797;
let child = null, browser = null, page = null;
const env = { ...process.env, OPENARC_IDENTITY_ADMIN: "1", OPENARC_DOWNLOADS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "oa-r2-dl-")) };
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_NO_ATTACH_CONSOLE;
async function launch() {
  child = spawn(electronPath, [".", "--user-data-dir=" + userData, "--remote-debugging-port=" + CDP, "--no-sandbox", "--disable-gpu-sandbox", "--in-process-gpu"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
  child.stdout.on("data", () => {}); child.stderr.on("data", () => {});
  let ver = null; const dl = Date.now() + 40000;
  while (!ver && Date.now() < dl) { try { ver = await (await fetch("http://127.0.0.1:" + CDP + "/json/version")).json(); } catch { await sleep(300); } }
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP);
  const ctx = browser.contexts()[0];
  page = null; const end = Date.now() + 30000;
  while (!page && Date.now() < end) { page = ctx.pages().find((p) => p.url().includes("dist/index.html")) || null; if (!page) await sleep(300); }
}
const js = (c) => page.evaluate("(async () => { " + c + " })()");
const setInput = (s, v) => js("const el=document.querySelector(" + JSON.stringify(s) + "); if(!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el," + JSON.stringify(v) + "); el.dispatchEvent(new Event('input',{bubbles:true})); return 'ok';");
const click = (s) => js("const el=document.querySelector(" + JSON.stringify(s) + "); if(!el) return 'missing'; el.click(); return 'ok';");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'x'");
async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await sleep(100); } return false; }
const state = async (tag) => {
  const ls = await js("const out={}; for (let i=0;i<localStorage.length;i++){const k=localStorage.key(i); if(k.startsWith('oa-wins')) out[k]=localStorage.getItem(k);} return JSON.stringify(out)");
  const parsed = JSON.parse(ls);
  const summary = Object.fromEntries(Object.entries(parsed).map(([k, v]) => {
    try { const j = JSON.parse(v); const w = (j.windows || []).find((x) => x.appId === "browser"); return [k, w ? { url: w.meta.url, active: w.meta.activeTabId, tabs: (w.meta.tabs || []).map((t) => t.url) } : "no-browser-window"]; } catch { return [k, "unparsable"]; }
  }));
  const view = browser.contexts()[0].pages().filter((p) => !p.url().includes("dist/index.html")).map((p) => p.url());
  const addr = await js("return document.querySelector('[aria-label=\"网页地址\"]')?.value || ''");
  console.log(tag, JSON.stringify({ address: addr, views: view, persisted: summary }));
};
async function login() {
  await waitFor(async () => (await gate()) !== "checking", 30000);
  if ((await gate()) === "uninitialized" && (await waitSel('[data-d3-id="setup-name"]', 30000))) {
    // 集成分支保留 UI 线已定的"三步初始化向导"（显示名 → 账号 → 密码），末步才提交：
    // 后两步的输入在 DOM 里尚未存在，一次填完再点 setup-submit 不会发生任何事。
    const setupNext = async () => {
      await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-next\"]'); return !!b && !b.disabled;"), 10000);
      await click('[data-d3-id="setup-next"]');
    };
    await setInput('[data-d3-id="setup-name"]', "R2 Admin");
    await setupNext();
    await waitSel('[data-d3-id="setup-identifier"]', 10000);
    await setInput('[data-d3-id="setup-identifier"]', "admin@r2.test");
    await setupNext();
    await waitSel('[data-d3-id="setup-password"]', 10000);
    await setInput('[data-d3-id="setup-password"]', "r2-password-1");
    await setInput('[data-d3-id="setup-confirm"]', "r2-password-1");
    await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-submit\"]'); return !!b && !b.disabled;"), 10000);
    await click('[data-d3-id="setup-submit"]');
    await waitFor(async () => (await gate()) === "unauthenticated", 30000);
  }
  if ((await gate()) === "ready") return;
  await setInput('[data-d3-id="login-identifier"]', "admin@r2.test"); await setInput('[data-d3-id="login-password"]', "r2-password-1");
  await click('[data-d3-id="login-submit"]'); await waitFor(async () => (await gate()) === "ready", 30000);
}
const go = async (u, wait = 1800) => { await setInput('[aria-label="网页地址"]', u); await click(".addressbar .primary"); await sleep(wait); };

await launch(); await login();
await click('[aria-label="打开浏览器"]'); await waitFor(() => js("return !!document.querySelector('[data-browser-window]')"), 20000);
await go(site.base + "/page2"); await state("S1 после /page2".replace("после", "after"));
await go(site.base + "/redirect"); await state("S2 after /redirect(302→/page2)");
await go(site.base + "/page3"); await state("S3 after /page3");
await click('[aria-label="后退"]'); await sleep(1200); await state("S4 after back");
await click('[aria-label="前进"]'); await sleep(1200); await state("S5 after forward");
await go(site.base + "/form"); await go(site.base + "/marker"); await state("S6 after consecutive navigations");
// 证书错误路径（R2 失败现场的关键前置）
if (tls) {
  await go(tls.base + "/", 2500); await state("S6b after cert-error navigation (self-signed)");
  await go(site.base + "/cookie?set=1", 2000); await state("S6c after navigation following cert error");
  await go(site.base + "/page3", 2000); await state("S6d after one more navigation");
}
// 两种退出方式对照：先 SIGKILL（模拟被测门禁之前的做法），再正常退出复核。
const mode = process.env.OA_R2_EXIT || "normal";
if (mode === "kill") {
  await go(site.base + "/cookie?set=1", 1500);
  console.log("BEFORE_KILL", JSON.stringify(await js("const out={}; for (let i=0;i<localStorage.length;i++){const k=localStorage.key(i); if(k.startsWith('oa-wins')) out[k]=localStorage.getItem(k);} return out")));
  try { child.kill("SIGKILL"); } catch {}
  await sleep(800);
} else if (mode === "immediate") {
  // 导航后**立刻**关窗口：检验正常退出路径是否需要人为等待才能持久化。
  await setInput('[aria-label="网页地址"]', site.base + "/page2");
  await click(".addressbar .primary");
  await sleep(120); // 只留一次事件循环的时间，不做"等状态写盘"的人为等待
  await js("window.close(); 'closing'").catch(() => {});
  await sleep(2500);
  console.log("EXITED_CODE", child.exitCode);
  try { child.kill("SIGKILL"); } catch {}
  await sleep(500);
} else {
  await js("window.close(); 'closing'").catch(() => {});
  await sleep(2500);
  console.log("EXITED_CODE", child.exitCode);
  try { child.kill("SIGKILL"); } catch {}
  await sleep(500);
}
await launch(); await login(); await sleep(1500); await state("S7 after restart");
child.kill("SIGKILL"); await site.close(); if (tls) await tls.close();
