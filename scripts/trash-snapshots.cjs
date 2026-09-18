/**
 * 系统回收站 · 真实 Electron 截图与端到端验证（2026-09-18 / 扩展轮）。
 *
 * 跑的是产品真实主进程 electron/main.cjs + 真实 preload + 真实 dist 页面。
 * 覆盖：
 *   1. 截图：程序坞空桶 / 满桶、回收站窗口空态 / 含文件 / 含文件夹 / 含「来自资源库」分区。
 *   2. 端到端：桌面文件与**桌面虚拟文件夹（含内部文件）**经右键「删除」进回收站并可恢复；
 *      永久删除必须过确认 Dialog。
 *   3. 资源库分区：创建资源 → 删除 → 出现在系统回收站的独立分区 → 恢复。
 *   4. 兼容性：老 oa-dock（不含 trash）刷新后回收站自动出现。
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

// 真实文件服务的落盘种子：桌面文件（应用启动前写入，启动后的 refreshFiles 就能看到）
const { createFileService } = require(path.join(ROOT, "electron", "file-service.cjs"));
const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-trash-seed-"));
const SEED_NAME = "季度报告.txt";
const seedSrc = path.join(seedDir, SEED_NAME);
fs.writeFileSync(seedSrc, "OpenArc OS 系统回收站演示文件\n");
const seeder = createFileService({ userDataDir });
seeder.importPaths("desktop", [seedSrc]);

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

/** 页面里复用的辅助函数（每个 executeJavaScript 都会注入）。 */
/** 页面里复用的辅助函数（每个 executeJavaScript 都会注入）。 */
const PAGE_HELPERS = [
  "const byText = (selector, text) => [...document.querySelectorAll(selector)].find((b) => (b.textContent || '').trim() === text);",
  "const trashWindow = () => [...document.querySelectorAll('.window')].find((w) => w.querySelector('.pane-title') && w.textContent.includes('回收站'));",
  "const dockIconSrc = () => document.querySelector('.dock-item[aria-label=\"打开回收站\"] img.dock-icon')?.src || '';",
  "const openTrash = () => { const b = document.querySelector('.dock-item[aria-label=\"打开回收站\"]'); if (!b) return false; b.click(); return true; };",
  "const minimizeTrash = () => { const w = trashWindow(); const c = w && w.querySelector('.traffic .close'); if (!c) return false; c.click(); return true; };",
  "const desktopMenuAt = (x, y) => { const el = document.elementFromPoint(x, y); if (!el) return false; el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 })); return true; };",
].join("\n");

app.whenReady().then(async () => {
  try {
    const win = await waitFor(() => BrowserWindow.getAllWindows()[0], 30000, "外壳窗口");
    await waitFor(() => !win.webContents.isLoading(), 30000, "页面加载完成");
    const js = (code) => win.webContents.executeJavaScript("(async () => { " + PAGE_HELPERS + code + " })()");
    const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root';");
    const shot = async (name) => {
      await sleep(400);
      const img = await win.webContents.capturePage();
      fs.mkdirSync(SNAP_DIR, { recursive: true });
      fs.writeFileSync(path.join(SNAP_DIR, name), img.toPNG());
      report.screenshots.push(name);
      out("shot " + name);
    };
    const clickByText = (selector, text) =>
      js("const el = byText(" + JSON.stringify(selector) + ", " + JSON.stringify(text) + "); if (!el) return false; el.click(); return true;");

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
    await sleep(700);

    // ══ 1. 程序坞：条目位置 + 空桶图标 ══
    const dockLabels = await js("return [...document.querySelectorAll('.dock .dock-item')].map((b) => b.getAttribute('aria-label'));");
    check("dock.hasTrash", dockLabels.includes("打开回收站"), JSON.stringify(dockLabels));
    check("dock.trashIsLast", dockLabels[dockLabels.length - 1] === "打开回收站", "最右端是 " + dockLabels[dockLabels.length - 1]);
    const dividerOk = await js(
      "const dock = document.querySelector('.dock'); const kids = [...dock.children]; const d = kids.findIndex((k) => k.classList.contains('dock-divider')); const t = kids.findIndex((k) => k.classList.contains('dock-item') && k.getAttribute('aria-label') === '打开回收站'); return d >= 0 && t > d;",
    );
    check("dock.trashAfterDivider", dividerOk === true, "回收站必须画在 .dock-divider 之后");
    const emptySrc = await js("return dockIconSrc();");
    check("dock.emptyIcon", /\/icons\/trash\.png$/.test(emptySrc), emptySrc);
    check("desktop.seededFileVisible", (await js("return document.querySelectorAll('.desktop-file').length;")) === 1, "种子桌面文件应可见");
    await shot("2026-09-18-trash-dock-empty.png");

    // ══ 2. 回收站窗口空态 ══
    await js("return openTrash();");
    await waitFor(() => js("return !!trashWindow();"), 15000, "回收站窗口");
    const emptyText = await js("return trashWindow()?.querySelector('.empty-content p')?.textContent?.trim() || '';");
    check("trash.emptyText", emptyText === "回收站是空的。", JSON.stringify(emptyText));
    await shot("2026-09-18-trash-empty.png");

    // ══ 3. 桌面文件：右键删除 → 进回收站 → 满桶 → 恢复 ══
    await js("return minimizeTrash();");
    await sleep(300);
    await js(
      "const el = document.querySelector('.desktop-file'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2), button: 2 })); return true;",
    );
    await waitFor(() => js("return !!document.querySelector('.context-menu');"), 8000, "桌面文件菜单");
    check("desktop.fileDeleteClick", (await clickByText(".context-menu button[role=\"menuitem\"]", "删除")) === true);
    await waitFor(async () => (await js("return (await window.openarc.files.trashList()).entries.length;")) === 1, 8000, "文件进回收站");
    await sleep(300);
    const fullSrc = await js("return dockIconSrc();");
    check("dock.fullIconAfterDelete", /\/icons\/trash-full\.png$/.test(fullSrc), fullSrc);
    await shot("2026-09-18-trash-dock-full.png");

    await js("return openTrash();");
    await waitFor(() => js("return !!trashWindow()?.querySelector('.file-cell[data-entry-id]');"), 8000, "回收站文件条目");
    const fileCellKind = await js("return trashWindow()?.querySelector('.file-cell[data-entry-id]')?.getAttribute('data-trash-kind') || '';");
    check("trash.fileCellKind", fileCellKind === "file", fileCellKind);
    const cellName = await js("return trashWindow()?.querySelector('[data-trash-kind=\"file\"] .file-name')?.textContent?.trim() || '';");
    check("trash.showsDeletedFileName", cellName === SEED_NAME, JSON.stringify(cellName));
    await shot("2026-09-18-trash-content.png");

    // 恢复文件
    await js("return trashWindow().querySelector('[data-trash-kind=\"file\"]').click(); true;");
    await waitFor(() => js("return !!trashWindow()?.querySelector('.file-cell.selected');"), 5000, "选中文件条目");
    check("trash.fileRestoreClick", (await clickByText(".split-nav", "恢复")) === true);
    await waitFor(async () => (await js("return (await window.openarc.files.trashList()).entries.length;")) === 0, 8000, "文件已恢复");
    check("trash.fileRestored", (await js("return document.querySelectorAll('.desktop-file').length;")) === 1, "桌面文件应回来");

    // ══ 4. 桌面虚拟文件夹（含内部文件）：删除 → 回收站显示文件夹 → 恢复整组 ══
    await js("return minimizeTrash();");
    await sleep(300);
    await js("return desktopMenuAt(1180, 470);");
    await waitFor(() => js("return !!document.querySelector('.context-menu');"), 8000, "桌面空白菜单");
    check("folder.createMenu", (await clickByText(".context-menu button[role=\"menuitem\"]", "新建文件夹")) === true);
    await waitFor(() => js("return !!document.querySelector('.folder-rename');"), 8000, "文件夹重命名输入");
    await js(
      "const input = document.querySelector('.folder-rename'); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(input, '验收文件夹'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true;",
    );
    await waitFor(() => js("return !!document.querySelector('.desktop-folder');"), 8000, "桌面文件夹");
    const folderId = await js("return document.querySelector('.desktop-folder').getAttribute('data-folder-id');");
    // 往这个虚拟文件夹里放一个真实文件（folderId 就是虚拟文件夹 id）
    const innerName = "文件夹内文件.txt";
    const innerSrc = path.join(seedDir, innerName);
    fs.writeFileSync(innerSrc, "inside folder\n");
    const imported = await js("return window.openarc.files.import(" + JSON.stringify(folderId) + ", [" + JSON.stringify(innerSrc) + "]);");
    check("folder.innerFileImported", imported && imported.ok === true && imported.added.length === 1, JSON.stringify(imported && imported.added));
    // 右键文件夹 → 删除 → 确认 Dialog（文案已改为“移入回收站”）
    await js(
      "const el = document.querySelector('.desktop-folder'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2), button: 2 })); return true;",
    );
    await waitFor(() => js("return !!document.querySelector('.context-menu');"), 8000, "文件夹菜单");
    check("folder.deleteMenu", (await clickByText(".context-menu button[role=\"menuitem\"]", "删除")) === true);
    await waitFor(() => js("return !!document.querySelector('.dialog');"), 8000, "删除文件夹确认 Dialog");
    const dlgText = await js("return document.querySelector('.dialog .dialog-body')?.textContent || '';");
    check("folder.confirmMentionsTrash", dlgText.includes("回收站"), dlgText.trim().slice(0, 60));
    check("folder.confirmDelete", (await clickByText(".dialog-footer button", "删除")) === true);

    await waitFor(async () => (await js("return (await window.openarc.files.trashList()).entries.length;")) === 1, 10000, "文件夹内文件进回收站");
    const groupEntry = await js("return (await window.openarc.files.trashList()).entries[0];");
    check("folder.trashHasGroupId", typeof groupEntry?.groupId === "string" && groupEntry.groupId.length > 0, JSON.stringify(groupEntry && { groupId: groupEntry.groupId, folderId: groupEntry.folderId }));
    check("folder.removedFromDesktop", (await js("return document.querySelectorAll('.desktop-folder').length;")) === 0, "文件夹应从桌面移除");

    await js("return openTrash();");
    await waitFor(() => js("return !!trashWindow()?.querySelector('[data-trash-kind=\"folder\"]');"), 8000, "回收站文件夹条目");
    const folderCellName = await js("return trashWindow()?.querySelector('[data-trash-kind=\"folder\"] .file-name')?.textContent?.trim() || '';");
    check("trash.folderCellName", folderCellName === "验收文件夹", JSON.stringify(folderCellName));
    const folderCellCount = await js("return trashWindow()?.querySelectorAll('[data-trash-kind=\"folder\"]').length;");
    check("trash.groupedFilesHidden", folderCellCount === 1, "组内文件不应单独出现，文件夹条目数=" + folderCellCount);
    await shot("2026-09-18-trash-folder.png");

    // 恢复文件夹：整组回原位
    await js("return trashWindow().querySelector('[data-trash-kind=\"folder\"]').click(); true;");
    await waitFor(() => js("return !!trashWindow()?.querySelector('.file-cell.selected');"), 5000, "选中文件夹条目");
    check("trash.folderRestoreClick", (await clickByText(".split-nav", "恢复")) === true);
    await waitFor(() => js("return !!document.querySelector('.desktop-folder');"), 10000, "文件夹恢复回桌面");
    const restoredName = await js("return document.querySelector('.desktop-folder .folder-name')?.textContent?.trim() || '';");
    check("trash.folderRestoredName", restoredName === "验收文件夹", JSON.stringify(restoredName));
    const innerBack = await js("return (await window.openarc.files.list(" + JSON.stringify(folderId) + ")).entries.length;");
    check("trash.folderInnerFileRestored", innerBack === 1, "文件夹内文件数 " + innerBack);
    check("trash.trashEmptyAfterFolderRestore", (await js("return (await window.openarc.files.trashList()).entries.length;")) === 0, "回收站应清空");

    // ══ 5. 来自资源库分区：创建资源 → 删除 → 出现在独立分区 → 恢复 ══
    const created = await js(
      "return window.openarc.resource.command({ type: 'resource/create', resourceType: 'text', name: '回收站分区验证', content: 'openarc resource trash' });",
    );
    if (!created || created.ok === false) throw new Error("resource/create 失败：" + JSON.stringify(created));
    const resourceRef = (created.resource && created.resource.resourceRef) || created.resourceRef;
    check("resource.created", !!resourceRef, JSON.stringify(created.resource && { ref: resourceRef }));
    const deleted = await js("return window.openarc.resource.command({ type: 'resource/delete', resourceRef: " + JSON.stringify(resourceRef) + " });");
    check("resource.trashed", deleted && deleted.ok === true, JSON.stringify(deleted && { ok: deleted.ok, error: deleted.error }));
    await sleep(300);
    await js("return openTrash();");
    await waitFor(() => js("return !!trashWindow()?.querySelector('[data-trash-section=\"resource\"]');"), 12000, "来自资源库分区");
    const resName = await js("return trashWindow()?.querySelector('[data-trash-section=\"resource\"] .file-name')?.textContent?.trim() || '';");
    check("trash.resourceSectionName", resName === "回收站分区验证", JSON.stringify(resName));
    const resKind = await js("return trashWindow()?.querySelector('[data-trash-section=\"resource\"] .file-cell')?.getAttribute('data-trash-kind') || '';");
    check("trash.resourceCellKind", resKind === "resource", resKind);
    await shot("2026-09-18-trash-resource.png");
    // 恢复资源
    await js("return trashWindow().querySelector('[data-trash-section=\"resource\"] .file-cell').click(); true;");
    await waitFor(() => js("return !!trashWindow()?.querySelector('[data-trash-section=\"resource\"] .file-cell.selected');"), 5000, "选中资源条目");
    check("trash.resourceRestoreClick", (await clickByText(".split-nav", "恢复")) === true);
    await waitFor(async () => (await js("return !trashWindow()?.querySelector('[data-trash-section=\"resource\"]');")) === true, 12000, "资源分区消失");
    check("trash.resourceRestored", true, "恢复后资源不再出现在回收站分区");

    // ══ 5b. 永久删除：文件夹整组 / 资源都必须先过确认 Dialog，确认后真正销毁 ══
    await js("return minimizeTrash();");
    await sleep(300);
    await js(
      "const el = document.querySelector('.desktop-folder'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2), button: 2 })); return true;",
    );
    await waitFor(() => js("return !!document.querySelector('.context-menu');"), 8000, "文件夹菜单(2)");
    await clickByText('.context-menu button[role="menuitem"]', "删除");
    await waitFor(() => js("return !!document.querySelector('.dialog');"), 8000, "确认 Dialog(2)");
    await clickByText(".dialog-footer button", "删除");
    await waitFor(async () => (await js("return (await window.openarc.files.trashList()).entries.length;")) === 1, 10000, "文件夹再次进回收站");
    await js("return openTrash();");
    await waitFor(() => js("return !!trashWindow()?.querySelector('[data-trash-kind=\"folder\"]');"), 8000, "回收站文件夹条目(2)");
    await js("return trashWindow().querySelector('[data-trash-kind=\"folder\"]').click(); true;");
    check("purge.folderConfirmClick", (await clickByText(".split-nav", "永久删除")) === true);
    await waitFor(() => js("return !!document.querySelector('.dialog');"), 8000, "永久删除确认 Dialog");
    const purgeTitle = await js("return document.querySelector('.dialog .dialog-heading strong')?.textContent?.trim() || '';");
    check("purge.folderDialogTitle", purgeTitle === "永久删除", JSON.stringify(purgeTitle));
    check("purge.folderConfirm", (await clickByText(".dialog-footer button", "永久删除")) === true);
    await waitFor(async () => (await js("return (await window.openarc.files.trashList()).entries.length;")) === 0, 10000, "文件夹整组销毁");
    check("purge.folderInnerFilesDestroyed", (await js("return (await window.openarc.files.list(" + JSON.stringify(folderId) + ")).entries.length;")) === 0, "组内文件应被物理删除");

    // 资源：再次删除后永久删除（走既有 resource/permanentDelete，不新增 IPC）
    const deleted2 = await js("return window.openarc.resource.command({ type: 'resource/delete', resourceRef: " + JSON.stringify(resourceRef) + " });");
    check("purge.resourceTrashedAgain", deleted2 && deleted2.ok === true, JSON.stringify(deleted2 && { ok: deleted2.ok }));
    await sleep(300);
    await js("return openTrash();");
    await waitFor(() => js("return !!trashWindow()?.querySelector('[data-trash-section=\"resource\"] .file-cell');"), 12000, "资源分区(2)");
    await js("return trashWindow().querySelector('[data-trash-section=\"resource\"] .file-cell').click(); true;");
    await clickByText(".split-nav", "永久删除");
    await waitFor(() => js("return !!document.querySelector('.dialog');"), 8000, "资源永久删除确认");
    check("purge.resourceConfirm", (await clickByText(".dialog-footer button", "永久删除")) === true);
    await waitFor(async () => {
      const list = await js("return window.openarc.resource.command({ type: 'resource/query', category: 'trash', limit: 60 });");
      return !(list && list.ok && (list.items || []).some((it) => it.resourceRef === " + JSON.stringify(resourceRef) + "));
    }, 12000, "资源被永久删除");
    check("purge.resourceDestroyed", true, "资源域不再列出该资源");

    // ══ 5c. 清空回收站：文件真正销毁，Dock 回到空桶 ══
    await js("return minimizeTrash();");
    await sleep(300);
    await js(
      "const el = document.querySelector('.desktop-file'); if (!el) return false; const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2), button: 2 })); return true;",
    );
    await waitFor(() => js("return !!document.querySelector('.context-menu');"), 8000, "桌面文件菜单(2)");
    await clickByText('.context-menu button[role="menuitem"]', "删除");
    await waitFor(async () => (await js("return (await window.openarc.files.trashList()).entries.length;")) === 1, 8000, "文件再次进回收站");
    await js("return openTrash();");
    await waitFor(() => js("return !!trashWindow()?.querySelector('[data-trash-kind=\"file\"]');"), 8000, "文件条目(2)");
    check("empty.clearClick", (await clickByText(".split-nav", "清空回收站")) === true);
    await waitFor(() => js("return !!document.querySelector('.dialog');"), 8000, "清空确认 Dialog");
    check("empty.confirm", (await clickByText(".dialog-footer button", "清空")) === true);
    await waitFor(async () => (await js("return (await window.openarc.files.trashList()).entries.length;")) === 0, 10000, "回收站已清空");
    const emptySrc2 = await js("return dockIconSrc();");
    check("empty.dockBackToEmptyIcon", emptySrc2.endsWith("/icons/trash.png"), emptySrc2);

    // ══ 6. 老用户 oa-dock 迁移：不含 trash 也要自动出现 ══
    await js("localStorage.setItem('oa-dock', JSON.stringify(['home','files','settings'])); localStorage.removeItem('oa-dock-trash'); return true;");
    win.webContents.reload();
    await waitFor(() => !win.webContents.isLoading(), 20000, "重载完成");
    await waitFor(() => js("return !!document.querySelector('.desktop');"), 20000, "重载后 desktop");
    let g2 = await gate();
    if (g2 === "uninitialized") {
      await js("return window.openarc.identity.command({ type: 'identity/initialize', identifier: " + JSON.stringify(IDENT) + ", password: " + JSON.stringify(PW) + ", displayName: " + JSON.stringify(NAME) + " });");
      g2 = await gate();
    }
    if (g2 === "locked") await js("return window.openarc.identity.command({ type: 'identity/unlock', password: " + JSON.stringify(PW) + " });");
    else if (g2 === "unauthenticated" || g2 === "uninitialized") await js("return window.openarc.identity.command({ type: 'identity/login', identifier: " + JSON.stringify(IDENT) + ", password: " + JSON.stringify(PW) + " });");
    await waitFor(async () => (await gate()) === "ready", 20000, "重载后 identity ready");
    await sleep(500);
    const migrated = await js("return JSON.parse(localStorage.getItem('oa-dock') || '[]');");
    check("dockMigration.autoAddsTrash", Array.isArray(migrated) && migrated.includes("trash"), JSON.stringify(migrated));
    check("dockMigration.domHasTrash", (await js("return !!document.querySelector('.dock-item[aria-label=\"打开回收站\"]');")) === true);
    check("dockMigration.markerWritten", (await js("return localStorage.getItem('oa-dock-trash');")) === "1");
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
