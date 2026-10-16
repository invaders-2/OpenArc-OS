/* ══════════════════════════════════════════════════════════════════════════
   OpenArc OS · Windows 标题栏候选方案 —— 示意图 DOM 构造
   纯静态 mock：不导入产品代码、不发请求、不执行产品逻辑。
   用法：index.html?option=A|B|C|D&theme=light|dark[&mode=window|states]
   ══════════════════════════════════════════════════════════════════════════ */

const P = new URLSearchParams(location.search);
const OPTION = (P.get("option") || "B").toUpperCase();
const THEME = P.get("theme") === "dark" ? "dark" : "light";
const MODE = P.get("mode") || "window";
const IS_DARK = THEME === "dark";
const DARK_CLASS = IS_DARK ? "dark" : "";
/* 方案 A 的系统标题栏/菜单栏在网页内容之外，主题类必须挂到根上才能吃到 --sysbar-* 暗色档 */
document.documentElement.classList.toggle("dark", IS_DARK);

/* ── lucide 图标（路径取自 node_modules/lucide-vue-next，与 TopBar.vue 同款）── */
const ICONS = {
  sparkles:
    '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
  monitor:
    '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  sliders:
    '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
};
const icon = (name, size) =>
  '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + "</svg>";

/* ── Windows caption 字形（Segoe Fluent Icons 近似：10px 线宽 1px）────── */
const CAP = {
  min: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10" stroke="currentColor" stroke-width="1" fill="none"/></svg>',
  max: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
  restore:
    '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5v-2h7v7h-2" fill="none" stroke="currentColor" stroke-width="1"/><rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
  close: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" stroke-width="1" fill="none"/></svg>',
};

/* ── 复用的窗口控制组 ─────────────────────────────────────────────────── */
const captions = (maxGlyph = "max") =>
  '<div class="caption-group" role="group" aria-label="窗口控制">' +
  '<button class="caption-btn" aria-label="最小化" title="最小化">' + CAP.min + "</button>" +
  '<button class="caption-btn" aria-label="最大化或还原" title="最大化">' + CAP[maxGlyph] + "</button>" +
  '<button class="caption-btn caption-btn--close" aria-label="关闭" title="关闭">' + CAP.close + "</button>" +
  "</div>";

const MENUS = ["文件", "编辑", "显示", "窗口", "帮助"];
const menus = () =>
  '<nav class="topbar-menus" aria-label="应用菜单">' +
  '<button class="bar-menu bar-logo">' + icon("sparkles", 13) + "<span>OpenArc</span></button>" +
  '<button class="bar-menu bar-appname">访达</button>' +
  MENUS.map((m) => '<button class="bar-menu">' + m + "</button>").join("") +
  "</nav>";

const right = () =>
  '<div class="topbar-right">' +
  '<span class="local-tag">' + icon("monitor", 13) + "<span>本机 · D1</span></span>" +
  '<button aria-label="全局搜索">' + icon("search", 15) + "</button>" +
  '<button aria-label="控制中心">' + icon("sliders", 15) + "</button>" +
  '<button aria-label="全局 AI"><img class="orb" src="./siri.png" alt="" /></button>' +
  '<button class="bar-user">' + icon("user", 14) + "<span>本机用户</span></button>" +
  '<button class="bar-clock">10月17日 周五&nbsp;&nbsp;04:55</button>' +
  "</div>";

const desktop = (inner) =>
  '<div class="desktop ' + DARK_CLASS + '" data-wallpaper="theme-' + THEME + '">' + inner + "</div>";

const anno = (text, { flag = false, right = false, top = 46 } = {}) =>
  '<div class="anno' + (flag ? " anno--flag" : "") + (right ? " anno--right" : "") +
  '" style="top:' + top + 'px"><span class="anno__dot' + (flag ? " anno__dot--warn" : "") + '"></span>' +
  "<span>" + text + "</span></div>";

/* ══ 方案 A · 原生标题栏 ══════════════════════════════════════════════════ */
function optionA() {
  const native =
    '<div class="sys-titlebar"><img class="sys-titlebar__icon" src="./app-icon.png" alt="" />' +
    '<span class="sys-titlebar__title">OpenArc OS</span>' + captions() + "</div>" +
    '<div class="sys-menubar">' +
    ["文件", "编辑", "窗口", "Developer"].map((m) => "<span>" + m + "</span>").join("") +
    "</div>";
  const app =
    '<header class="topbar is-secondary">' +
    '<span class="secondary-app">' + icon("monitor", 13) + "<span>访达</span></span>" +
    right() +
    "</header>" +
    anno("方案 A · frame:true：系统标题栏 32px + 系统菜单栏 22px（菜单来自 installApplicationMenu：文件 / 编辑 / 窗口）", {
      top: 56,
    }) +
    anno("应用顶栏降级为次级工具条：自带的 文件/编辑/显示/窗口/帮助 与系统菜单重复，必须二选一", { top: 82 });
  return native + desktop(app);
}

/* ══ 方案 B · 自绘 Windows 风 caption ═══════════════════════════════════ */
function optionB() {
  const app =
    '<header class="topbar is-win-caption">' + menus() + right() + captions() + "</header>" +
    anno("方案 B · frame:false：左侧不变（去掉 92px 红绿灯预留 → 16px），右侧 3 枚自绘 caption 46×32，close hover #c42b1c", {
      top: 46,
    });
  return desktop(app);
}

/* ══ 方案 C · titleBarOverlay（系统绘制窗口按钮）════════════════════════ */
function optionC() {
  const app =
    '<header class="topbar is-overlay">' + menus() + right() + "</header>" +
    '<div class="overlay-sim" aria-hidden="true">' + captions() + "</div>" +
    anno("方案 C · titleBarOverlay：右上 138px 由系统绘制（单一实色，压在半透明顶栏上会露出一块实色）", {
      top: 46,
    }) +
    anno("DOM 顶栏右侧必须留出 env(titlebar-area-width)", { right: true, top: 72 });
  return desktop(app);
}

/* ══ 方案 D · 保持现状（无窗口按钮）═════════════════════════════════════ */
function optionD() {
  const app =
    '<header class="topbar">' + menus() + right() + "</header>" +
    '<div class="zone zone--reserved"></div>' +
    '<div class="zone zone--missing"></div>' +
    anno("方案 D（现状）· 无最小化 / 最大化 / 关闭：整个窗口只能靠系统任务栏与快捷键收场", {
      flag: true,
      top: 46,
    }) +
    anno("左侧 92px 是给 macOS 红绿灯留的，Windows 上白留", { flag: true, top: 72 }) +
    anno("这里应该有窗口按钮（红框压在时钟上：右侧已排满，加按钮必须先腾地方）", { right: true, flag: true, top: 46 });
  return desktop(app);
}

/* ══ caption 状态细节图（额外）══════════════════════════════════════════ */
function states() {
  const cell = (label, glyph, extraClass, close) => {
    const cls =
      "caption-btn" + (close ? " caption-btn--close" : "") + (extraClass ? " " + extraClass : "");
    return (
      '<div class="states__cell"><div class="states__frame">' +
      '<button class="' + cls + '" tabindex="-1">' + CAP[glyph] + "</button>" +
      '</div><span class="states__label">' + label + "</span></div>"
    );
  };
  const row1 =
    '<div class="states__row">' +
    cell("最小化 · 默认", "min") +
    cell("最大化 · 默认", "max") +
    cell("还原 · 默认", "restore") +
    cell("关闭 · 默认", "close", "", true) +
    "</div>";
  const row2 =
    '<div class="states__row">' +
    cell("最小化 · 悬停", "min", "is-hover") +
    cell("最大化 · 悬停", "max", "is-hover") +
    cell("关闭 · 悬停", "close", "is-hover", true) +
    cell("关闭 · 按下", "close", "is-press", true) +
    "</div>";
  return (
    '<div class="states ' + DARK_CLASS + '">' +
    '<div class="states__title">Windows caption 按钮状态（4× 放大 · ' +
    (IS_DARK ? "深色" : "浅色") + "）</div>" +
    '<div class="states__pane states__row">' + row1 + "</div>" +
    '<div class="states__pane states__row">' + row2 + "</div>" +
    "</div>"
  );
}

/* ── 装配 ─────────────────────────────────────────────────────────────── */
const BUILDERS = { A: optionA, B: optionB, C: optionC, D: optionD };
const stage = document.getElementById("stage");
if (MODE === "states") {
  document.body.classList.add("mode-states");
  stage.outerHTML = states();
} else {
  const build = BUILDERS[OPTION] || optionB;
  stage.innerHTML = build();
}
window.__MOCK_READY__ = true;
document.documentElement.dataset.mockReady = "1";
