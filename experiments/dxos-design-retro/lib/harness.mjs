/**
 * OpenArc 设计语言回溯复查探针 · 真机底座。
 *
 * 方法与运行时口径照搬 experiments/dxos-ui-photos/lib/harness.mjs（不改该文件）：
 *   · --user-data-dir=<临时目录> + --remote-debugging-port=<空闲端口> 启动真实产品入口 dist/vue.html；
 *   · CDP Emulation.setDeviceMetricsOverride 钉视图尺寸 + deviceScaleFactor=2；
 *   · 外观（主题 / 减少动态）走真实设置面板，并回读 .desktop 的 dark / reduced 类名；
 *   · 每张截图断言像素尺寸；收工对真实 profile 做只读快照比对。
 *
 * 硬约束：不联网（只连本机 CDP）；不改产品代码；不新增依赖；不 git commit；收工自清理。
 */
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

export async function waitFor(fn, timeoutMs, stepMs) {
  const step = stepMs || 150;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if (await fn()) return true; } catch (err) { /* 重试 */ }
    if (Date.now() >= deadline) return false;
    await sleep(step);
  }
}

/* ── 真实 profile 只读快照 ──────────────────────────────────────────── */
export function resolveRealProfilePath() {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "openarc-os");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "openarc-os");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "openarc-os");
}

function statOf(p) {
  try { const s = fs.statSync(p); return { exists: true, mtimeMs: Math.round(s.mtimeMs), size: s.size, ino: s.ino }; }
  catch (err) { return { exists: false }; }
}

function walk(dir, base, acc) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    let st;
    try { st = fs.lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) { acc.push({ path: path.relative(base, full), type: "symlink", target: fs.readlinkSync(full) }); continue; }
    if (st.isDirectory()) { walk(full, base, acc); continue; }
    if (st.isFile()) {
      let sha256 = null;
      try { sha256 = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex"); } catch { /* unreadable */ }
      acc.push({ path: path.relative(base, full), size: st.size, mtimeMs: Math.round(st.mtimeMs), sha256 });
    }
  }
  return acc;
}

export function snapshotProfile(dir) {
  if (!fs.existsSync(dir)) return { dir, exists: false, count: 0, files: [] };
  const files = walk(dir, dir, []).sort((a, b) => String(a.path).localeCompare(String(b.path)));
  return { dir, exists: true, count: files.length, files };
}

export function diffProfileSnapshots(before, after) {
  const changed = [];
  if (before.exists !== after.exists) return [before.dir + " exists " + before.exists + "→" + after.exists];
  if (!before.exists) return [];
  const mapA = new Map(after.files.map((f) => [f.path, f]));
  if (before.files.length !== after.files.length) changed.push(before.dir + " file-count " + before.files.length + "→" + after.files.length);
  for (const f of before.files) {
    const g = mapA.get(f.path);
    if (!g) { changed.push(before.dir + " removed " + f.path); continue; }
    if (f.size !== g.size || f.mtimeMs !== g.mtimeMs || f.sha256 !== g.sha256) changed.push(before.dir + " changed " + f.path);
  }
  return changed;
}

/* ── 截图 ─────────────────────────────────────────────────────────── */
export function pngSize(file) {
  const buf = fs.readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

export async function shoot(cdp, file) {
  const res = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(res.data, "base64"));
  return pngSize(file);
}

export async function shootClip(cdp, file, rect) {
  const res = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    clip: { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.max(1, rect.width), height: Math.max(1, rect.height), scale: 1 },
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(res.data, "base64"));
  return pngSize(file);
}

/* ── 启动 / 收工 ──────────────────────────────────────────────────── */
export async function launchElectron(opts) {
  const { ROOT, electronPath, chromium, userDataDir } = opts;
  const port = await freePort();
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  Object.assign(env, opts.env || {});
  const args = [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + port];
  const child = spawn(electronPath, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += String(d); });
  child.stderr.on("data", (d) => { stderr += String(d); });
  const ready = await waitFor(async () => {
    try { const r = await fetch("http://127.0.0.1:" + port + "/json/version"); return r.ok; } catch { return false; }
  }, 60000, 300);
  if (!ready) {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
    throw new Error("CDP 未就绪：" + stderr.slice(-500));
  }
  const browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
  return {
    child, browser, port, userDataDir,
    launchCommand: "electron . --user-data-dir=<isolated-temp> --remote-debugging-port=" + port,
    out: () => ({ stdout, stderr }),
  };
}

export async function awaitExit(child, timeoutMs) {
  const ended = await waitFor(() => child.exitCode != null || child.signalCode != null, timeoutMs || 20000, 200);
  if (!ended) {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    await waitFor(() => child.exitCode != null || child.signalCode != null, 5000, 200);
  }
  return { exited: ended, code: child.exitCode == null ? null : child.exitCode, signal: child.signalCode || null };
}

/* ── 页内原语 ─────────────────────────────────────────────────────── */
export const gate = (page) => page.evaluate(() => {
  const d = document.querySelector(".desktop");
  return d ? d.getAttribute("data-identity-gate") || "no-attr" : "no-root";
});

export const has = (page, sel) => page.evaluate((s) => !!document.querySelector(s), sel);
export const count = (page, sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
export const text = (page, sel) => page.evaluate((s) => (document.querySelector(s)?.textContent || "").trim(), sel);
export const attr = (page, sel, name) => page.evaluate((a) => document.querySelector(a[0])?.getAttribute(a[1]) ?? null, [sel, name]);

export async function waitForSel(page, sel, timeout) {
  const deadline = Date.now() + (timeout || 12000);
  while (Date.now() < deadline) { if (await has(page, sel)) return true; await sleep(70); }
  return false;
}

export async function setInput(page, sel, value) {
  return page.evaluate((a) => {
    const el = document.querySelector(a[0]);
    if (!el) return "missing";
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, a[1]);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return "ok";
  }, [sel, value]);
}

export async function clickSel(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return "missing";
    if (el.disabled) return "disabled";
    el.click();
    return "ok";
  }, sel);
}

export async function clickText(page, containerSel, label) {
  return page.evaluate((a) => {
    const scope = a[0] ? document.querySelector(a[0]) : document;
    if (!scope) return false;
    const nodes = Array.prototype.slice.call(scope.querySelectorAll("button"));
    for (const n of nodes) {
      if ((n.textContent || "").trim() === a[1]) { n.click(); return true; }
    }
    return false;
  }, [containerSel, label]);
}

/* ── 登录 / 初始化（照搬 dxos-ui-settings 的选择器） ─────────────── */
export const IDENT = "design-retro@openarc.local";
export const PW = "design-retro-password-1";
export const SETUP_NAME = "Design Retro";

export async function ensureSession(page) {
  let g = await gate(page);
  if (g === "ready") return g;
  const waitGate = async (want, timeout) => {
    const list = Array.isArray(want) ? want : [want];
    const t0 = Date.now();
    let last = "?";
    while (Date.now() - t0 < (timeout || 30000)) {
      try { last = await gate(page); if (list.indexOf(last) >= 0) return last; } catch { /* navigating */ }
      await sleep(120);
    }
    return "TIMEOUT(last=" + last + ")";
  };
  const waitEnabled = async (sel, timeout) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeout || 8000)) {
      const d = await page.evaluate((s) => document.querySelector(s)?.disabled, sel);
      if (d === false) return true;
      await sleep(80);
    }
    return false;
  };
  g = await waitGate(["uninitialized", "unauthenticated", "ready"], 30000);
  if (g === "ready") return g;
  if (g === "unauthenticated") {
    await setInput(page, '[data-d3-id="login-identifier"]', IDENT);
    await setInput(page, '[data-d3-id="login-password"]', PW);
    await waitEnabled('[data-d3-id="login-submit"]');
    await clickSel(page, '[data-d3-id="login-submit"]');
    return waitGate("ready", 30000);
  }
  await setInput(page, '[data-d3-id="setup-name"]', SETUP_NAME);
  await waitEnabled('[data-d3-id="setup-next"]'); await clickSel(page, '[data-d3-id="setup-next"]');
  await waitForSel(page, '[data-d3-id="setup-identifier"]');
  await setInput(page, '[data-d3-id="setup-identifier"]', IDENT);
  await waitEnabled('[data-d3-id="setup-next"]'); await clickSel(page, '[data-d3-id="setup-next"]');
  await waitForSel(page, '[data-d3-id="setup-password"]');
  await setInput(page, '[data-d3-id="setup-password"]', PW);
  await setInput(page, '[data-d3-id="setup-confirm"]', PW);
  await waitEnabled('[data-d3-id="setup-submit"]'); await clickSel(page, '[data-d3-id="setup-submit"]');
  await waitGate("unauthenticated", 20000);
  await setInput(page, '[data-d3-id="login-identifier"]', IDENT);
  await setInput(page, '[data-d3-id="login-password"]', PW);
  await waitEnabled('[data-d3-id="login-submit"]'); await clickSel(page, '[data-d3-id="login-submit"]');
  return waitGate("ready", 30000);
}

/* ── 外观：主题 / 减少动态（真实设置面板） ───────────────────────── */
export const SETTINGS_WIN = 'section.window[aria-label="系统设置窗口"]';

export async function openSettings(page) {
  if (await has(page, SETTINGS_WIN)) return true;
  await clickSel(page, '[aria-label="打开系统设置"]');
  return waitForSel(page, SETTINGS_WIN, 12000);
}

export async function openSettingsPane(page, pane) {
  const ok = await openSettings(page);
  if (!ok) return false;
  await clickSel(page, SETTINGS_WIN + ' [data-settings-pane="' + pane + '"]');
  return waitForSel(page, '[data-settings-active="' + pane + '"]', 12000);
}

export async function setTheme(page, theme) {
  const dark = theme === "dark";
  await openSettingsPane(page, "appearance");
  await clickText(page, SETTINGS_WIN + ' [aria-label="外观"]', dark ? "深色" : "浅色");
  const settled = await waitFor(async () => (await page.evaluate(() => document.querySelector(".desktop")?.classList.contains("dark"))) === dark, 6000, 120);
  /* 关掉设置窗口：它会盖住被取证的应用窗口，导致截图与"合成背景"取到的是设置面板。 */
  await closeWindow(page, SETTINGS_WIN);
  return settled;
}

export async function setReducedMotion(page, on) {
  await openSettingsPane(page, "appearance");
  await page.evaluate((a) => {
    const win = document.querySelector(a[0]);
    if (!win) return false;
    const sw = win.querySelector('button[role="switch"][aria-label="减少动态效果"]');
    if (!sw) return false;
    if ((sw.getAttribute("aria-checked") === "true") !== a[1]) sw.click();
    return true;
  }, [SETTINGS_WIN, on]);
  const settled = await waitFor(async () => (await page.evaluate(() => document.querySelector(".desktop")?.classList.contains("reduced"))) === on, 6000, 120);
  await closeWindow(page, SETTINGS_WIN);
  return settled;
}

export async function closeWindow(page, winSel) {
  await page.evaluate((s) => {
    const win = document.querySelector(s);
    const btn = win ? win.querySelector(".window-title button") : null;
    if (btn) btn.click();
  }, winSel);
  await waitFor(async () => !(await has(page, winSel)), 6000, 120);
}

/** 视口：1440×900 + DSF 2 → 截图 2880×1800（与既有探针同一口径）。 */
export async function setViewport(cdp, size) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: size.dsf, mobile: false });
  await sleep(200);
}

/** 把窗口拉到视口内（不依赖最大化，对齐 DESIGN_SYSTEM §6 的最小尺寸）。 */
export async function fitWindow(page, winSel, margin) {
  const m = margin == null ? 12 : margin;
  return page.evaluate((a) => {
    const win = document.querySelector(a[0]);
    if (!win) return null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const maxBtn = win.querySelector(".maximize");
    const label = maxBtn ? maxBtn.getAttribute("aria-label") : "";
    if (label && label.indexOf("还原") === 0) { maxBtn.click(); return "restored"; }
    win.style.left = a[1] + "px";
    win.style.top = a[1] + "px";
    win.style.width = Math.max(320, vw - a[1] * 2) + "px";
    win.style.height = Math.max(240, vh - a[1] * 2) + "px";
    return "fitted";
  }, [winSel, m]);
}
