/**
 * D2-02 · Dialog 无障碍 + ContextMenu 键盘操作探针（§16 / §17 / §31 / §40 / §41）。
 *
 * 这组断言直接对应 D2-01 登记的缺口：
 *   「对话框焦点陷阱 + 焦点返回 NOT VERIFIED —— 本轮无 Dialog 组件，拒绝临时造一个充数」
 *
 * 现在有真 Dialog 了，但"有组件"不等于"能验收"（§41）。因此本探针：
 *   · 打开的是**真实产品页**（dist/index.html），走的是产品自己的删除文件夹确认流程
 *   · 只断言**行为**：焦点在哪、Tab 能不能逃、Esc 能不能关、焦点回不回到原处
 *   · 每条断言都有对应的反证或对照，避免"恒真断言"
 *
 * 范围声明（必须写清）：
 *   · 本探针跑在 Playwright 的 Chromium 里，**不是 Electron**。
 *     因此它证明的是"DOM 侧的对话框语义正确"，
 *     而"对话框必须挡住 WebContentsView 的鼠标与键盘"由 Electron 侧的
 *     experiments/d2-02-gate 02-input 探针证明（§17 的两半，各自有各自的证据）。
 *   · 没有断言"焦点陷阱在 IME / 屏幕阅读器下也正确"——这类需要人工与会话式验证。
 */
import { Probe, VERDICT, appUrl, serveDist, launch, sleep } from "./lib/app.mjs";

const p = new Probe("dialog-a11y", "Dialog 无障碍 + ContextMenu 键盘操作");
const server = await serveDist();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errs.push(m.text());
});

/** 每次从干净状态开始：桌面只留默认窗口，不残留上次的文件夹。 */
await page.addInitScript(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});
await page.goto(appUrl());
await page.waitForSelector(".desktop", { timeout: 15000 });
await sleep(400);

const active = () =>
  page.evaluate(() => {
    const a = document.activeElement;
    return a
      ? {
          tag: a.tagName,
          role: a.getAttribute("role"),
          cls: typeof a.className === "string" ? a.className : "",
          text: (a.textContent || "").trim().slice(0, 24),
          inMenu: !!a.closest('[role="menu"]'),
          inDialog: !!a.closest('[role="dialog"]'),
        }
      : null;
  });

const menuState = () =>
  page.evaluate(() => {
    const m = document.querySelector('[role="menu"]');
    if (!m) return null;
    const items = [...m.querySelectorAll('[role="menuitem"]')];
    const seps = [...m.querySelectorAll('[role="separator"]')];
    return {
      items: items.map((b) => ({ label: b.textContent.trim(), disabled: b.hasAttribute("disabled") })),
      separators: seps.length,
      focusIndex: items.indexOf(document.activeElement),
      separatorFocused: seps.includes(document.activeElement),
    };
  });

const dialogState = () =>
  page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return { present: false };
    const f = d.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])');
    const surface = document.querySelector(".desktop-surface");
    return {
      present: true,
      modal: d.getAttribute("aria-modal"),
      name: d.getAttribute("aria-label"),
      focusables: f.length,
      focusInside: !!d.contains(document.activeElement),
      backgroundInert: !!surface && surface.hasAttribute("inert"),
      closeLabel: d.querySelector(".dialog-heading button")?.getAttribute("aria-label") ?? null,
    };
  });

/* ══════════════════════════════════════════════════════════════════════════
   A. 建一个文件夹（真实产品流程：桌面右键 → 菜单 → 新建文件夹）
   ══════════════════════════════════════════════════════════════════════════ */
// 空白桌面区域（默认 home 窗口占 x90..920，这里避开它 ——
// 否则右键会被窗口截住，"桌面右键"这条路径就没被测到）
await page.mouse.click(1180, 470, { button: "right" });
await sleep(250);
const menuOpen = await menuState();
p.assert("menu.opensOnContextMenu", !!menuOpen, `右键后未出现 role=menu：${JSON.stringify(menuOpen)}`);
p.assert(
  "menu.firstItemFocused",
  menuOpen?.focusIndex === 0,
  `焦点应落在第 1 个菜单项，实测 focusIndex=${menuOpen?.focusIndex}`,
);
p.assert(
  "menu.arrowDownMovesFocus",
  await (async () => {
    // 产品菜单只有一个"新建文件夹"项，先看 ArrowDown 在单项菜单上不越界
    await page.keyboard.press("ArrowDown");
    await sleep(120);
    const s = await menuState();
    return s?.focusIndex === 0 && !s?.separatorFocused;
  })(),
  "ArrowDown 在单项菜单上越界或离开了菜单项",
);

// Enter 触发"新建文件夹" → 进入重命名态
await page.keyboard.press("Enter");
await sleep(350);
const renameInput = await page.$(".folder-rename");
p.assert("menu.enterActivatesItem", !!renameInput, "Enter 未触发菜单项（新建文件夹没有进入重命名态）");
if (renameInput) {
  await renameInput.fill("验收文件夹");
  await page.keyboard.press("Enter");
}
await sleep(300);
const folderTile = page.locator(".desktop-folder").first();
p.assert("product.createdFolder", (await page.locator(".desktop-folder").count()) === 1, "文件夹未创建");
p.assert(
  "menu.triggerIsFocusable",
  await page.evaluate(() => {
    const el = document.querySelector(".desktop-folder");
    el.focus();
    return el === document.activeElement;
  }),
  "文件夹磁贴无法通过 script 聚焦（tabindex 缺失）",
);

/* ══════════════════════════════════════════════════════════════════════════
   B. ContextMenu 的完整键盘操作（§31）
   ══════════════════════════════════════════════════════════════════════════ */
await folderTile.click({ button: "right" });
await sleep(300);
const folderMenu = await menuState();
p.assert(
  "menu.folderMenuHasSeparatorAndThreeItems",
  folderMenu?.items.length === 3 && folderMenu?.separators === 1,
  `实测 items=${JSON.stringify(folderMenu?.items)} separators=${folderMenu?.separators}`,
);
p.assert("menu.focusOnFirstItem", folderMenu?.focusIndex === 0, `focusIndex=${folderMenu?.focusIndex}`);

await page.keyboard.press("ArrowDown");
await sleep(120);
const afterDown = await menuState();
p.assert("menu.arrowDownMovesAcrossItems", afterDown?.focusIndex === 1, `focusIndex=${afterDown?.focusIndex}`);

await page.keyboard.press("ArrowUp");
await sleep(120);
const afterUp = await menuState();
p.assert("menu.arrowUpMovesBack", afterUp?.focusIndex === 0, `focusIndex=${afterUp?.focusIndex}`);

await page.keyboard.press("ArrowUp");
await sleep(120);
const wrapped = await menuState();
p.assert(
  "menu.arrowUpWrapsToLast",
  wrapped?.focusIndex === 2 && !wrapped?.separatorFocused,
  `从首项 ArrowUp 应循环到末项且跳过分隔线，实测 focusIndex=${wrapped?.focusIndex} separatorFocused=${wrapped?.separatorFocused}`,
);

await page.keyboard.press("End");
await sleep(120);
p.assert("menu.endJumpsToLast", (await menuState())?.focusIndex === 2, "End 未跳到末项");
await page.keyboard.press("Home");
await sleep(120);
p.assert("menu.homeJumpsToFirst", (await menuState())?.focusIndex === 0, "Home 未跳到首项");

// Esc 关闭菜单并把焦点还给触发它的元素（文件夹磁贴）。
// 这里**不能"再右键一次"**：当前菜单还开着，.menu-shade 会拦住所有指针事件，
// Playwright 会一直重试到超时 —— 这不是产品问题，是探针顺序写错了。
await page.keyboard.press("Escape");
await sleep(250);
p.assert("menu.escapeCloses", (await menuState()) === null, "Esc 未关闭菜单");
p.assert(
  "menu.focusReturnsToTrigger",
  (await active())?.cls.includes("desktop-folder"),
  `Esc 后焦点应回到文件夹磁贴，实测 ${JSON.stringify(await active())}`,
);

/* ══════════════════════════════════════════════════════════════════════════
   C. Dialog（§16）—— 由产品自身的"删除文件夹"确认流程触发（§41）
   ══════════════════════════════════════════════════════════════════════════ */
await folderTile.click({ button: "right" });
await sleep(250);
await page.keyboard.press("End"); // 末项 = 删除
await sleep(120);
await page.keyboard.press("Enter");
await sleep(400);

const d0 = await dialogState();
p.assert("dialog.opensFromProductFlow", d0.present === true, "删除确认对话框未打开");
p.assert("dialog.roleAndModal", d0.modal === "true", `aria-modal=${d0.modal}`);
p.assert("dialog.hasAccessibleName", !!d0.name, `aria-label=${d0.name}`);
p.assert("dialog.hasCloseButtonWithLabel", !!d0.closeLabel, `关闭按钮 aria-label=${d0.closeLabel}`);
p.assert("dialog.hasFocusableContent", d0.focusables >= 2, `可聚焦元素数=${d0.focusables}`);
p.assert("dialog.focusMovesInsideOnOpen", d0.focusInside === true, `焦点未进入对话框：${JSON.stringify(await active())}`);
p.assert(
  "dialog.backgroundIsInert",
  d0.backgroundInert === true,
  "背景没有 inert —— 只靠 Tab 循环一层技巧承担无障碍是不可靠的",
);
p.note(`对话框内可聚焦元素 ${d0.focusables} 个；背景 inert=${d0.backgroundInert}`);

// 焦点陷阱：连按 Tab 20 次，任何一次都不允许跑到对话框外。
// 同时把每一步落在哪个元素记下来 —— 这是"陷阱真的在循环"的唯一可信证据：
// 如果 20 次 Tab 之后焦点始终没动，"没逃出"就只是恒真断言，不能算验收。
const forwardVisits = [];
let escapedForward = null;
for (let i = 0; i < 20; i += 1) {
  await page.keyboard.press("Tab");
  await sleep(45);
  const a = await active();
  forwardVisits.push(`${a?.tag}#${a?.cls || ""}:${a?.text || ""}`);
  if (!a?.inDialog) {
    escapedForward = { step: i + 1, where: a };
    break;
  }
}
p.assert(
  "dialog.trapForward",
  escapedForward === null,
  `Tab 第 ${escapedForward?.step} 次逃出对话框：${JSON.stringify(escapedForward?.where)}`,
);

let escapedBackward = null;
for (let i = 0; i < 20; i += 1) {
  await page.keyboard.press("Shift+Tab");
  await sleep(45);
  const a = await active();
  if (!a?.inDialog) {
    escapedBackward = { step: i + 1, where: a };
    break;
  }
}
p.assert(
  "dialog.trapBackward",
  escapedBackward === null,
  `Shift+Tab 第 ${escapedBackward?.step} 次逃出对话框：${JSON.stringify(escapedBackward?.where)}`,
);

const distinctForward = [...new Set(forwardVisits)];
p.assert(
  "dialog.trapActuallyCycles",
  distinctForward.length >= 2,
  `陷阱内至少应经过 2 个不同元素，实测轨迹=${JSON.stringify(forwardVisits)}`,
);
p.note(`向前 Tab 的焦点轨迹：${forwardVisits.join(" → ")}`);

/* ══════════════════════════════════════════════════════════════════════════
   D. Esc 关闭 + 焦点返回（D2-01 登记缺口的另一半）
   ══════════════════════════════════════════════════════════════════════════ */
await page.keyboard.press("Escape");
await sleep(400);
p.assert("dialog.escapeCloses", (await dialogState()).present === false, "Esc 未关闭对话框");
p.assert(
  "dialog.inertRemovedAfterClose",
  await page.evaluate(() => !document.querySelector(".desktop-surface")?.hasAttribute("inert")),
  "关闭后背景仍处于 inert，桌面会永久不可用",
);
const afterClose = await active();
p.assert(
  "dialog.focusReturnsToTrigger",
  !!afterClose && afterClose.cls.includes("desktop-folder"),
  `关闭后焦点应回到右键触发的文件夹磁贴，实测 ${JSON.stringify(afterClose)}`,
);

/* ══════════════════════════════════════════════════════════════════════════
   E. 关闭按钮路径（不能只测 Esc 这一条）
   ══════════════════════════════════════════════════════════════════════════ */
await folderTile.click({ button: "right" });
await sleep(250);
await page.keyboard.press("End");
await sleep(120);
await page.keyboard.press("Enter");
await sleep(400);
const d1 = await dialogState();
await page.locator('[role="dialog"] .dialog-heading button').click();
await sleep(350);
p.assert(
  "dialog.closeButtonCloses",
  d1.present === true && (await dialogState()).present === false,
  "关闭按钮没有关闭对话框",
);
p.assert(
  "dialog.focusReturnsViaCloseButton",
  (await active())?.cls.includes("desktop-folder"),
  `关闭按钮路径下焦点未回到触发元素：${JSON.stringify(await active())}`,
);

/* ══════════════════════════════════════════════════════════════════════════
   F. 反向断言：确认上面的"通过"不是因为测错了地方
   ══════════════════════════════════════════════════════════════════════════ */
// 关闭状态下不存在 role=dialog —— 否则 C 段的 present 断言就是恒真
p.assert("dialog.absentWhenClosed", (await dialogState()).present === false, "关闭态仍存在 role=dialog");
// 背景没有 inert 时，Tab 能到桌面元素 —— 证明 inert 是**有效**的而不是装饰
await page.evaluate(() => document.querySelector(".dock button")?.focus());
const dockFocusable = await page.evaluate(() => !!document.activeElement?.closest(".dock"));
p.assert(
  "dialog.backgroundIsReachableOnlyWithoutInert",
  dockFocusable === true,
  "关闭状态下 Dock 应可聚焦 —— 否则 inert 断言无法证明它起了作用",
);

p.assert("noPageErrors", errs.length === 0, `页面报错：${errs.slice(0, 3).join(" | ")}`);

await browser.close();
server.close();
const res = p.write();
console.log(`\n== ${p.id} 结论：${res.verdict} — ${JSON.stringify(res.counts)}`);
console.log(`   产物：${res.file}`);
process.exit(res.verdict === VERDICT.FAIL ? 1 : 0);
