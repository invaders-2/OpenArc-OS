/**
 * 探针 02 · 输入路由与对话框阻断（§9 / §17）。
 *
 * D2-02 的硬验收之一：**Browser 在 Dialog 后面时，Dialog 必须
 *   ① 视觉覆盖网页 ② 阻止网页鼠标输入 ③ 阻止网页键盘输入，
 * 关闭 Dialog 后 Browser 才恢复。**
 *
 * 本探针用真实 OS 级鼠标与键盘注入来测，不看代码推断：
 *   · 键盘归属用 win/view 两个 webContents 的 isFocused() 判定
 *   · 键盘到达用注入真实按键后统计两侧 keydown 次数判定
 *   · 鼠标到达用真实点击后统计两侧命中次数判定
 *
 * 同时验证一个前置问题：`setVisible(false)` 之后键盘到底归谁 —— D1-01 只写了"隐藏"，
 * 没写"隐藏之后键盘去哪"。实测已发现隐藏不会自动交还外壳，这里把后果测出来。
 */
const { BrowserWindow, WebContentsView, session, app } = require("electron");
const L = require("./_lib.cjs");

const { W, H } = L.LAYOUT;
const VP = L.LAYOUT.VIEWPORT;
const DIALOG = { x: VP.x + 62, y: VP.y + 62, width: VP.width - 124, height: VP.height - 124 };

exports.run = async function run({ report, sleep, add }) {
  const win = new BrowserWindow({
    width: W,
    height: H,
    x: 40,
    y: 40,
    show: true,
    useContentSize: true,
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  await win.loadURL(L.dataURL(L.shellGate()));
  await win.webContents.executeJavaScript(`
    (() => {
      const d = document.createElement("div");
      d.id = "dialog";
      d.setAttribute("role", "dialog");
      d.style.cssText = "position:fixed;left:${DIALOG.x}px;top:${DIALOG.y}px;width:${DIALOG.width}px;height:${DIALOG.height}px;background:#ff8800;z-index:9999;display:none;" +
        "display:none;align-items:center;justify-content:center";
      d.innerHTML = '<button id="dlgA" style="width:120px;height:44px">A</button><button id="dlgB" style="width:120px;height:44px;margin-left:12px">B</button>';
      document.body.appendChild(d);
      window.__dialog = (open) => {
        d.style.display = open ? "flex" : "none";
        if (open) { const b = document.getElementById("dlgA"); b.focus(); }
        return { display: d.style.display, active: document.activeElement && document.activeElement.id };
      };
      window.__focusId = () => (document.activeElement && document.activeElement.id) || document.activeElement.tagName;
      const out = document.createElement("button");
      out.id = "outsideBtn";
      out.textContent = "OUTSIDE";
      out.style.cssText = "position:fixed;left:80px;top:390px;width:140px;height:44px;z-index:50";
      document.body.appendChild(out);
    })();
  `);
  app.focus({ steal: true });
  win.moveTop();
  win.focus();
  await sleep(800);

  const view = new WebContentsView({
    webPreferences: {
      session: session.fromPartition("openarc-gate-input"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.contentView.addChildView(view);
  await view.webContents.loadURL(L.dataURL(L.pageHTML({ color: "#0000ff", tag: "PAGE" })));
  view.setBounds(VP);
  view.setVisible(true);
  await sleep(700);

  const js = (c) => win.webContents.executeJavaScript(c);
  const pageJs = (c) => view.webContents.executeJavaScript(c);
  const focusState = () => ({ view: view.webContents.isFocused(), shell: win.webContents.isFocused() });
  const clearHits = async () => {
    await js("window.__hits = []");
    await pageJs("window.__hits = []");
  };
  const hits = async () => ({
    dom: await js("window.__hits"),
    page: await pageJs("window.__hits"),
  });
  /**
   * 前置条件：键盘事件只会投递给 key window。
   * 本机可能有外部负载/用户操作抢焦点，未成为 key 时"按键没人收到"是环境现象，
   * 不能当成"键盘进错了对象"的产品结论。
   */
  async function ensureKeyWindow() {
    for (let i = 0; i < 12; i += 1) {
      if (win.isFocused()) return true;
      app.focus({ steal: true });
      win.show();
      win.focus();
      win.moveTop();
      await sleep(300);
    }
    return win.isFocused();
  }
  const keyWindow = await ensureKeyWindow();
  report.keyWindow = keyWindow;
  add(
    "input.preconditionWindowIsKey",
    keyWindow,
    `窗口成为 key window = ${keyWindow}（false 说明本轮键盘证据不可得，属环境干扰）`,
    { keyWindow },
  );

  /** 注入一次真实按键，返回两侧 keydown 命中。 */
  async function pressKey(code, label, flagMask) {
    await clearHits();
    const key = await ensureKeyWindow();
    const send = flagMask ? () => L.keyChord(flagMask, code) : () => L.keyPress(code);
    send();
    await sleep(400);
    const h = await hits();
    return {
      label,
      keyWindow: key,
      focusBefore: focusState(),
      domKeys: h.dom.filter((e) => e.t === "keydown").map((e) => e.key),
      pageKeys: h.page.filter((e) => e.t === "keydown").map((e) => e.key),
      focusAfter: focusState(),
    };
  }
  const keyDesc = (r) => `[${r.label}] DOM 收到 ${r.domKeys.join(",") || "无"} / 网页收到 ${r.pageKeys.join(",") || "无"}`;

  /** 真实点击某点，返回两侧命中。 */
  async function clickAt(dipX, dipY, label) {
    await clearHits();
    const cb = win.getContentBounds();
    const p = L.screenPoint(cb, dipX, dipY);
    L.warp(p.x, p.y);
    await sleep(70);
    const cur = L.cursorPos();
    const drift = cur ? Math.hypot(cur.x - p.x, cur.y - p.y) : null;
    L.cliclick([`c:${p.x},${p.y}`]);
    await sleep(400);
    const h = await hits();
    return {
      label,
      dip: { x: dipX, y: dipY },
      drift,
      valid: drift !== null && drift <= 8,
      domHits: h.dom.length,
      pageHits: h.page.length,
      domTargets: h.dom.map((e) => e.target),
    };
  }
  const clickDesc = (r) => `[${r.label}] DOM ${r.domHits} 次${r.domTargets?.length ? "(" + r.domTargets.join(",") + ")" : ""} / 网页 ${r.pageHits} 次`;

  report.dialogRect = DIALOG;

  // 键盘类断言的统一门控：macOS 只把键盘事件投递给 key window 内部的 focused webContents。
  // 窗口未成为 key 时"按键没人收到"是环境现象，不能当作"键盘进错了对象"的产品结论。
  // 因此每条键盘断言都带 `!keyWindow ||` 前缀，并在消息里标注该轮窗口是否 key。
  const kGate = (cond) => !keyWindow || cond;
  const kNote = keyWindow ? "" : "［窗口非 key，本轮键盘证据 NOT VERIFIED］";

  // ============ A. 基线：无对话框，键盘归属 ============
  view.webContents.focus();
  await sleep(400);
  const pageKeyed = await pressKey(L.KEYS.a, "基线·网页持焦");
  report.keyboard = { baselinePageFocused: pageKeyed };
  add(
    "input.keyboard.baselineKeysGoToPage",
    kGate(pageKeyed.pageKeys.length > 0 && pageKeyed.domKeys.length === 0),
    `${kNote}${keyDesc(pageKeyed)} → 网页持焦时键盘进入网页，注入手段有效`,
    pageKeyed,
  );

  win.webContents.focus();
  await sleep(400);
  const domKeyed = await pressKey(L.KEYS.a, "基线·外壳持焦");
  report.keyboard.baselineShellFocused = domKeyed;
  add(
    "input.keyboard.shellKeysGoToShell",
    kGate(domKeyed.domKeys.length > 0 && domKeyed.pageKeys.length === 0),
    `${kNote}${keyDesc(domKeyed)} → 外壳持焦时键盘进入外壳`,
    domKeyed,
  );

  // ============ B. 打开对话框但视图仍可见（未缓解） ============
  view.webContents.focus();
  await sleep(300);
  const dlgOpen = await js("window.__dialog(true)");
  report.dialogOpenUnmitigated = { openState: dlgOpen, focus: focusState() };
  await sleep(400);
  const focusWhileOpen = focusState();
  const keyedWhileOpen = await pressKey(L.KEYS.escape, "对话框打开·视图仍可见·按 Esc");
  report.dialogOpenUnmitigated.focusWhileOpen = focusWhileOpen;
  report.dialogOpenUnmitigated.escape = keyedWhileOpen;

  add(
    "input.dialog.viewKeepsKeyboardWhenVisible",
    kGate(focusWhileOpen.view === true),
    `${kNote}对话框打开后焦点仍在网页（view.isFocused=${focusWhileOpen.view} / shell=${focusWhileOpen.shell}）→ DOM 拿不到键盘`,
    focusWhileOpen,
  );
  add(
    "input.dialog.escapeReachesPageNotDialog",
    !keyedWhileOpen.keyWindow ||
      (keyedWhileOpen.pageKeys.includes("Escape") && !keyedWhileOpen.domKeys.includes("Escape")),
    `${keyDesc(keyedWhileOpen)} → Esc 被网页吃掉，DOM 对话框收不到关闭键（§17 键盘阻断不成立）`,
    keyedWhileOpen,
  );
  const clickWhileOpen = await clickAt(DIALOG.x + DIALOG.width / 2, DIALOG.y + DIALOG.height / 2, "对话框打开·视图仍可见·点对话框中心");
  report.dialogOpenUnmitigated.click = clickWhileOpen;
  add(
    "input.dialog.clickOnDialogReachesPage",
    clickWhileOpen.valid && clickWhileOpen.pageHits > 0 && clickWhileOpen.domHits === 0,
    `${clickDesc(clickWhileOpen)} → 对话框上的点击进了网页（§17 鼠标阻断不成立）`,
    clickWhileOpen,
  );

  // ============ C. 缓解：隐藏视图 + 显式移交焦点 ============
  view.setVisible(false);
  win.webContents.focus();
  await sleep(500);
  const focusAfterMitigation = focusState();
  const keyedAfterMitigation = await pressKey(L.KEYS.escape, "缓解后·按 Esc");
  const clickedAfterMitigation = await clickAt(DIALOG.x + DIALOG.width / 2, DIALOG.y + DIALOG.height / 2, "缓解后·点对话框中心");
  report.mitigated = { focus: focusAfterMitigation, escape: keyedAfterMitigation, click: clickedAfterMitigation };

  add(
    "input.dialog.hideAndRefocusRestoresKeyboardToDom",
    !keyedAfterMitigation.keyWindow ||
      (focusAfterMitigation.shell === true && focusAfterMitigation.view === false),
    `隐藏视图 + 显式 focus 外壳 → view=${focusAfterMitigation.view}/shell=${focusAfterMitigation.shell}（窗口是否 key=${keyedAfterMitigation.keyWindow}）`,
    focusAfterMitigation,
  );
  add(
    "input.dialog.escapeReachesDialogAfterMitigation",
    !keyedAfterMitigation.keyWindow ||
      (keyedAfterMitigation.domKeys.includes("Escape") && keyedAfterMitigation.pageKeys.length === 0),
    `${keyDesc(keyedAfterMitigation)} → 缓解后 Esc 到达 DOM 对话框（§17 键盘阻断成立）`,
    keyedAfterMitigation,
  );
  add(
    "input.dialog.clickReachesDialogAfterMitigation",
    clickedAfterMitigation.valid && clickedAfterMitigation.domHits > 0 && clickedAfterMitigation.pageHits === 0,
    `${clickDesc(clickedAfterMitigation)} → 缓解后点击到达 DOM 对话框（§17 鼠标阻断成立）`,
    clickedAfterMitigation,
  );

  // ============ D. 关闭对话框后恢复 ============
  const dlgClose = await js("window.__dialog(false)");
  view.setVisible(true);
  await sleep(600);
  const focusAfterClose = focusState();
  // 规格要求"关闭后 Browser 才恢复"：恢复 = 视图重新可见且可再次接收输入
  const clickAfterClose = await clickAt(VP.x + VP.width / 2, VP.y + VP.height / 2, "关闭对话框后·点视口中心");
  report.restored = { closeState: dlgClose, focus: focusAfterClose, click: clickAfterClose };
  add(
    "input.dialog.pageResumesAfterClose",
    clickAfterClose.valid && clickAfterClose.pageHits > 0,
    `${clickDesc(clickAfterClose)} → 关闭对话框并恢复视图后网页重新接收输入`,
    clickAfterClose,
  );

  // ============ E. 焦点陷阱的最小实测（Tab 循环） ============
  // §16 会在 D2-02B 正式建立 Dialog primitive，这里只证明输入手段足以验收它。
  // 口径：D2-02B 的 Dialog 打开时会把原生视图整块让位（正是 C 段验证过的缓解方式），
  // 因此这里也先隐藏视图、把焦点交给外壳，再测 DOM 内部的 Tab 轨迹。
  // 否则 Tab 会进网页（视图仍可见时网页吃键盘），轨迹不变 ——
  // 得到的结论会是"焦点压根没到 DOM"，而不是"焦点陷阱缺失"，两者不能混为一谈。
  await js("window.__dialog(true)");
  view.setVisible(false);
  win.webContents.focus();
  await sleep(500);
  const trailKey = await ensureKeyWindow();
  const trail = [await js("window.__focusId()")];
  for (let i = 0; i < 6; i += 1) {
    await clearHits();
    await ensureKeyWindow();
    win.webContents.focus();
    L.keyPress(L.KEYS.tab);
    await sleep(260);
    trail.push(await js("window.__focusId()"));
  }
  report.focusTrailForward = { keyWindow: trailKey, trail };
  const tNote = trailKey ? "" : "［窗口非 key，本轮轨迹 NOT VERIFIED］";
  add(
    "input.focusTrail.tabIsInjectable",
    !trailKey || (trail.length === 7 && trail.some((t) => t === "dlgB" || t === "dlgA")),
    `${tNote}连续 Tab 后的 activeElement 轨迹 = ${trail.join(" → ")} → 真实 Tab 可注入，足以验收焦点陷阱`,
    report.focusTrailForward,
  );
  const escaped = trail.includes("outsideBtn");
  add(
    "input.focusTrail.escapeDetectable",
    !trailKey || escaped,
    `${tNote}轨迹 ${trail.join(" → ")} ${escaped ? "出现 outsideBtn → 焦点逃出对话框。这是本轮仪器能力的**阳性对照**：证明注入的 Tab 能真实驱动 DOM 焦点，因此 D2-02B 装上焦点陷阱后\"逃不出去\"才是可信结论" : "未逃出"}`,
    { trail, escaped },
  );
  await js("window.__dialog(false)");

  win.destroy();
};
