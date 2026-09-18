/**
 * 系统回收站 · 真实 Electron 截图与端到端验证（2026-09-18）。
 *
 * 跑的是**产品真实主进程** electron/main.cjs + 真实 preload + 真实 dist 页面，
 * 身份/文件服务都是真装配。用途：
 *   1. 截图：程序坞含回收站 / 回收站空态 / 回收站有内容，写入 docs/snapshots/。
 *   2. 端到端：桌面文件经右键「删除」进入回收站 → 回收站窗口恢复 / 永久删除（含确认 Dialog）。
 *   3. 兼容性：模拟老 oa-dock（不含 trash）→ 刷新后回收站自动出现。
 *
 * 运行（本机 Chromium 沙箱无法初始化，必须带这三项）：
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/trash-snapshots.cjs \
 *     --no-sandbox --disable-gpu-sandbox --in-process-gpu
 */
"use strict";
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SNAP_DIR = path.join(ROOT, "docs", "snapshots");
const ART_DIR = path.join(ROOT, "artifacts", "d2-02");

const IDENT = "trash-snap@openarc.local";
const PW = "trash-snap-password-1";
const NAME = "回收站验证";

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-trash-snap-"));
app.setPath("userData", userDataDir);

// 先在真实文件服务里放一个桌面文件（在应用启动前落盘，启动后的 refreshFiles 就能看到）
const { createFileService } = require(path.join(ROOT, "electron", "file-service.cjs"));
const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-trash-seed-"));
const SEED_NAME = "季度报告.txt";
const seedSrc = path.join(seedDir, SEED_NAME);
fs.writeFileSync(seedSrc, "OpenArc OS 系统回收站演示文件\n");
const seeder = createFileService({ userDataDir });
const seededEntry = seeder.importPaths("desktop", [seedSrc]).added[0];

require(path.join(ROOT, "electron", "main.cjs"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { id: "trash-snapshots", cases: [], errors: [], screenshots: [] };
const out = (line) => process.stdout.write(line + "\n");
const check = (name, ok, detail = "") => {
  report.cases.push({ id: name, ok: !!ok, detail: String(detail) });
  out((ok ? "PASS " : "FAIL ") + name + (detail ? " :: " + detail : ""));
};

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  let last = "?";
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = "throw:" + e.message;
    }
    if (Date.now() - t0 > ms) throw new Error("等待超时：" + label + "（last=" + last + "）");
    await sleep(120);
  }
}

app.whenReady().then(async () => {
  try {
    const win = await waitFor(() => BrowserWindow.getAllWindows()[0], 30000, "外壳窗口");
    await waitFor(() => !win.webContents.isLoading(), 30000, "页面加载完成");
    const js = (code) => win.webContents.executeJavaScript("(async () => { " + code + " })()");
    const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
    const shot = async (name) => {
      await sleep(400);
      const img = await win.webContents.capturePage();
      const file = path.join(SNAP_DIR, name);
      fs.mkdirSync(SNAP_DIR, { recursive: true });
      fs.writeFileSync(file, img.toPNG());
      report.screenshots.push(name);
      out("shot " + name);
    };
    const clickByText = (selector, text) =>
      js(
        "const el = [...document.querySelectorAll(" + JSON.stringify(selector) +
          ")].find((b) => (b.textContent || '').trim() === " + JSON.stringify(text) +
          "); if (!el) return false; el.click(); return true;",
      );

    await waitFor(() => js("return !!document.querySelector('.desktop')"), 30000, "desktop 根节点");
    let g = await gate();
    if (g === "uninitialized") {
      const res = await js(
        "return window.openarc.identity.command({ type: 'identity/initialize', identifier: " +
          JSON.stringify(IDENT) + ", password: " + JSON.stringify(PW) + ", displayName: " + JSON.stringify(NAME) + " })",
      );
      if (!res || res.ok === false) throw new Error("identity/initialize 失败：" + JSON.stringify(res));
    }
    const login = await js(
      "return window.openarc.identity.command({ type: 'identity/login', identifier: " +
        JSON.stringify(IDENT) + ", password: " + JSON.stringify(PW) + " })",
    );
    if (!login || login.ok === false) throw new Error("identity/login 失败：" + JSON.stringify(login));
    await waitFor(async () => (await gate()) === "ready", 30000, "身份门 ready");
    await sleep(600);

    // ── 1. 程序坞含回收站（位置：分隔线右侧、全局 AI 之后 = 最右端） ──
    const dockLabels = await js(
      "return [...document.querySelectorAll('.dock .dock-item')].map((b) => b.getAttribute('aria-label'))",
    );
    check("dock.hasTrash", dockLabels.includes("打开回收站"), JSON.stringify(dockLabels));
    check("dock.trashIsLast", dockLabels[dockLabels.length - 1] === "打开回收站", "最右端是 " + dockLabels[dockLabels.length - 1]);
    check("dock.aiBeforeTrash", dockLabels.indexOf("打开全局 AI") >= 0 && dockLabels.indexOf("打开全局 AI") < dockLabels.indexOf("打开回收站"), JSON.stringify(dockLabels));
    const dividerAfterApps = await js(
      "const dock = document.querySelector('.dock'); const kids = [...dock.children]; const d = kids.findIndex((k) => k.classList.contains('dock-divider')); const t = kids.findIndex((k) => k.classList.contains('dock-item') && k.getAttribute('aria-label') === '打开回收站'); return d >= 0 && t > d;",
    );
    check("dock.trashAfterDivider", dividerAfterApps === true, "回收站必须画在 .dock-divider 之后");
    // 桌面文件真实出现（种子导入）
    const desktopCount = await js("return document.querySelectorAll('.desktop-file').length");
    check("desktop.seededFileVisible", desktopCount === 1, "桌面文件数 " + desktopCount);
    await shot("2026-09-18-trash-dock.png");

    // ── 2. 回收站窗口空态 ──
    check("open.trashWindow", (await js("document.querySelector('.dock-item[aria-label=\"打开回收站\"]').click(); return true")) === true);
    await waitFor(
      () => js("return [...document.querySelectorAll('.pane-title')].some((e) => e.textContent.trim() === '回收站')"),
      15000,
      "回收站窗口",
    );
    const emptyText = await js("return document.querySelector('.empty-content p')?.textContent?.trim() || ''");
    check("trash.emptyText", emptyText === "回收站是空的。", JSON.stringify(emptyText));
    await shot("2026-09-18-trash-empty.png");

    // 回收站窗口保持打开：删除后 refreshTrash() 会让它实时显示新条目（截图即"有内容"）。
    // 桌面文件的右键是直接 dispatch contextmenu，不依赖命中测试，窗口压住也能触发。

    // ── 3. 桌面右键「删除」→ 真进回收站（不是永久删除） ──
    const menuOpen = await js(
      "const el = document.querySelector('.desktop-file'); if (!el) return false; const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2), button: 2 })); return true;",
    );
    check("desktop.menuOpened", menuOpen === true);
    await waitFor(() => js("return !!document.querySelector('.context-menu')"), 8000, "桌面右键菜单");
    const hitDelete = await clickByText(".context-menu button[role=\"menuitem\"]", "删除");
    check("desktop.clickDelete", hitDelete === true);
    await waitFor(async () => (await js("return document.querySelectorAll('.desktop-file').length")) === 0, 8000, "桌面条目消失");
    await sleep(300);
    const trashAfterDelete = await js("return (await window.openarc.files.trashList()).entries.length");
    check("trash.receivedDesktopDelete", trashAfterDelete === 1, "回收站条目数 " + trashAfterDelete);

    // ── 4. 回收站有内容（截图） ──
    await js("document.querySelector('.dock-item[aria-label=\"打开回收站\"]').click(); return true");
    await waitFor(() => js("return !!document.querySelector('.file-cell[data-entry-id]')"), 8000, "回收站条目");
    const cellName = await js("return document.querySelector('.file-cell .file-name')?.textContent?.trim() || ''");
    check("trash.showsDeletedName", cellName === SEED_NAME, JSON.stringify(cellName));
    await shot("2026-09-18-trash-content.png");

    // ── 5. 恢复：条目回到桌面，回收站清空 ──
    await js("document.querySelector('.file-cell[data-entry-id]').click(); return true");
    await waitFor(() => js("return !!document.querySelector('.file-cell.selected')"), 5000, "选中条目");
    const restoreClick = await clickByText(".split-nav", "恢复");
    check("trash.clickRestore", restoreClick === true);
    await waitFor(async () => (await js("return (await window.openarc.files.trashList()).entries.length")) === 0, 8000, "回收站清空");
    const desktopBack = await js("return document.querySelectorAll('.desktop-file').length");
    check("trash.restoredToDesktop", desktopBack === 1, "桌面文件数 " + desktopBack);

    // ── 6. 永久删除必须有二次确认；确认后物理删除 ──
    // 再删一次进回收站（同一个真实入口）
    await js(
      "const el = document.querySelector('.desktop-file'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2), button: 2 })); return true;",
    );
    await waitFor(() => js("return !!document.querySelector('.context-menu')"), 8000, "菜单");
    await clickByText(".context-menu button[role=\"menuitem\"]", "删除");
    await sleep(400);
    await js("document.querySelector('.dock-item[aria-label=\"打开回收站\"]').click(); return true");
    await waitFor(() => js("return !!document.querySelector('.file-cell[data-entry-id]')"), 8000, "回收站条目");
    await js("document.querySelector('.file-cell[data-entry-id]').click(); return true");
    await clickByText(".split-nav", "永久删除");
    await waitFor(() => js("return !!document.querySelector('.dialog')"), 8000, "永久删除确认 Dialog");
    const dialogTitle = await js("return document.querySelector('.dialog .dialog-heading strong')?.textContent?.trim() || ''");
    check("trash.purgeConfirmDialog", dialogTitle === "永久删除", JSON.stringify(dialogTitle));
    const confirmed = await clickByText(".dialog-footer button", "永久删除");
    check("trash.purgeConfirmButton", confirmed === true);
    await waitFor(async () => (await js("return (await window.openarc.files.trashList()).entries.length")) === 0, 8000, "永久删除完成");
    check("trash.purged", true, "永久删除后回收站为空");

    // ── 7. 老用户 oa-dock 迁移：不含 trash 也要自动出现 ──
    await js("localStorage.setItem('oa-dock', JSON.stringify(['home','files','settings'])); localStorage.removeItem('oa-dock-trash'); return true;");
    win.webContents.reload();
    await waitFor(() => !win.webContents.isLoading(), 20000, "重载完成");
    await waitFor(() => js("return !!document.querySelector('.desktop')"), 20000, "重载后 desktop");
    // 重载后身份门可能 ready / locked / unauthenticated
    let g2 = await gate();
    if (g2 === "uninitialized") {
      await js("return window.openarc.identity.command({ type: 'identity/initialize', identifier: " + JSON.stringify(IDENT) + ", password: " + JSON.stringify(PW) + ", displayName: " + JSON.stringify(NAME) + " })");
      g2 = await gate();
    }
    if (g2 === "locked") {
      await js("return window.openarc.identity.command({ type: 'identity/unlock', password: " + JSON.stringify(PW) + " })");
    } else if (g2 === "unauthenticated" || g2 === "uninitialized") {
      await js("return window.openarc.identity.command({ type: 'identity/login', identifier: " + JSON.stringify(IDENT) + ", password: " + JSON.stringify(PW) + " })");
    }
    await waitFor(async () => (await gate()) === "ready", 20000, "重载后 identity ready");
    await sleep(400);
    const migrated = await js("return JSON.parse(localStorage.getItem('oa-dock') || '[]')");
    check("dockMigration.autoAddsTrash", Array.isArray(migrated) && migrated.includes("trash"), JSON.stringify(migrated));
    const migratedDom = await js("return !!document.querySelector('.dock-item[aria-label=\"打开回收站\"]')");
    check("dockMigration.domHasTrash", migratedDom === true);
    const marker = await js("return localStorage.getItem('oa-dock-trash')");
    check("dockMigration.markerWritten", marker === "1", String(marker));
  } catch (error) {
    report.errors.push(String((error && error.stack) || error));
    out("PROBE ERROR: " + String(error));
  }

  fs.mkdirSync(ART_DIR, { recursive: true });
  fs.writeFileSync(path.join(ART_DIR, "trash-snapshots.json"), JSON.stringify(report, null, 2));
  const failed = report.cases.filter((c) => !c.ok).length;
  out("\n=== 回收站截图/端到端 ===");
  out("通过 " + (report.cases.length - failed) + "/" + report.cases.length + "，错误 " + report.errors.length);
  app.exit(failed || report.errors.length ? 1 : 0);
});
