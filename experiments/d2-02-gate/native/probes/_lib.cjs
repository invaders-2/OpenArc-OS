/**
 * Gate 原生探针共用工具：pixel grab、坐标换算、图片构造、颜色判定。
 *
 * 坐标约定（踩坑记录）：
 *   `webContents.capturePage(rect)` 的 rect 用 **DIP**（等于 CSS px，等于窗口内容区坐标）。
 *   但返回的 NativeImage 的 `getSize()` 是 **物理像素**：
 *   在 scaleFactor=2 的屏上，请求 1100×760 DIP 会得到 2200×1520 的位图。
 *   若把 DIP 直接当像素下标去采样，会采到左上角 1/4 区域 —— 断言全错却不报错。
 *   因此 scale 必须由 `位图宽 / 请求矩形宽` 反推，并断言其为整数。
 */
const fs = require("node:fs");
const path = require("node:path");

const ART = path.resolve(__dirname, "..", "..", "..", "..", "artifacts", "d2-02");

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * 抓一帧并返回采样器。
 * @param wc      webContents（capturePage）
 * @param dipRect {x,y,width,height} DIP 坐标，缺省取整窗内容区
 */
async function grab(wc, dipRect) {
  const img = await wc.capturePage(dipRect);
  const size = img.getSize();
  const bmp = img.toBitmap();
  const scale = dipRect ? Math.round(size.width / dipRect.width) : 1;
  const origin = dipRect ? { x: dipRect.x, y: dipRect.y } : { x: 0, y: 0 };
  const at = (x, y) => {
    // 入参为 DIP 绝对坐标；换算到本帧位图内的像素下标
    const px = clamp(Math.round((x - origin.x) * scale), 0, size.width - 1);
    const py = clamp(Math.round((y - origin.y) * scale), 0, size.height - 1);
    const off = (py * size.width + px) * 4;
    return {
      b: bmp[off],
      g: bmp[off + 1],
      r: bmp[off + 2],
      a: bmp[off + 3],
      scale,
      px: { x: px, y: py },
      raw: { w: size.width, h: size.height },
    };
  };
  return { img, scale, size, at, bmp };
}

const rgb = (s) => (s ? `rgb(${s.r},${s.g},${s.b})` : "n/a");
/** 近邻颜色判定，容忍软件渲染与抗锯齿噪声。 */
const near = (s, [r, g, b], tol = 26) =>
  !!s && Math.abs(s.r - r) <= tol && Math.abs(s.g - g) <= tol && Math.abs(s.b - b) <= tol;

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const MAGENTA = [255, 0, 255];
const CYAN = [0, 255, 255];
const YELLOW = [255, 255, 0];
const WHITE = [255, 255, 255];

function savePng(img, name) {
  fs.mkdirSync(ART, { recursive: true });
  const f = path.join(ART, name);
  fs.writeFileSync(f, img.toPNG());
  return f;
}

/** 一次抓帧 + 多点采样，返回可直接塞进报告的记录。 */
async function mapRegion(wc, points, dipRect) {
  const g = await grab(wc, dipRect);
  return {
    scale: g.scale,
    raw: { w: g.size.width, h: g.size.height },
    points: Object.fromEntries(
      Object.entries(points).map(([k, p]) => [k, { ...p, color: rgb(g.at(p.x, p.y)) }]),
    ),
  };
}

/**
 * 外壳页：纯色底 + 可定位的 DOM 覆盖层 + 事件计数器。
 * overlay 坐标与 WebContentsView 的 bounds 共用窗口内容区坐标系（DIP）。
 */
function shellHTML({ w, h, bg, overlay, probes }) {
  const layers = (overlay || [])
    .map(
      (o, i) =>
        `<div class="ov" id="${o.id || "ov" + i}" data-role="${o.role || "overlay"}" style="left:${o.x}px;top:${o.y}px;width:${o.width}px;height:${o.height}px;background:${o.color}${o.extra || ""}"></div>`,
    )
    .join("");
  const marks = (probes || [])
    .map(
      (p, i) =>
        `<div class="mk" id="mk${i}" style="left:${p.x}px;top:${p.y}px"></div>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:${w}px;height:${h}px;background:${bg};overflow:hidden}
  .ov{position:fixed;z-index:2147483647}
  .mk{position:fixed;width:4px;height:4px;background:#ffffff;z-index:2147483647}
</style></head><body>${layers}${marks}
  <script>
    window.__hits = [];
    window.__ready = true;
    for (const t of ["pointerdown","mousedown","click","dblclick","contextmenu","keydown","wheel"]) {
      addEventListener(t, (e) => {
        const el = e.target && e.target.id ? e.target.id : (e.target && e.target.tagName) || "?";
        window.__hits.push({ t, x: Math.round(e.clientX||0), y: Math.round(e.clientY||0),
                             key: e.key||"", target: el });
      }, true);
    }
  </script></body></html>`;
}

/** 网页页：纯色底 + 事件计数器 + 载入计数（用于验证 reload 只影响自己）。 */
function pageHTML({ color, tag }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:100%;height:100%;background:${color};overflow:hidden;
            font:700 26px ui-monospace,monospace;color:#fff;display:flex;align-items:center;justify-content:center}
</style></head><body>${tag}
  <script>
    window.__hits = [];
    window.__loads = (window.__loads||0)+1;
    window.__tag = ${JSON.stringify(tag)};
    for (const t of ["pointerdown","mousedown","click","contextmenu","keydown","wheel"]) {
      addEventListener(t, (e) => {
        const el = e.target && e.target.id ? e.target.id : (e.target && e.target.tagName) || "?";
        window.__hits.push({ t, x: Math.round(e.clientX||0), y: Math.round(e.clientY||0),
                             key: e.key||"", target: el });
      }, true);
    }
  </script></body></html>`;
}

const dataURL = (html) => "data:text/html;charset=utf-8," + encodeURIComponent(html);

// ---------------------------------------------------------------------------
// Gate 统一场景（01 / 02 / 05 必须共用同一布局，否则结论不可比）
//
//   · wA / wB  两个普通 DOM 窗口（可运行时移动）
//   · chromeC  浏览器窗口的 DOM 外壳（含圆角与标题栏）
//   · viewport 原生 WebContentsView 的几何锚点，生产代码正是围绕它对齐
//
// 颜色即身份：A 品红 #ff00ff、B 黄 #ffff00、C 外壳灰 #808080、网页蓝 #0000ff、桌面绿 #00ff00。
// ---------------------------------------------------------------------------
const LAYOUT = {
  W: 1100,
  H: 760,
  A: { x: 60, y: 80, width: 420, height: 280 },
  B0: { x: 520, y: 80, width: 500, height: 280 },
  C: { x: 288, y: 340, width: 524, height: 352, titleBar: 28, radius: 20 },
};
LAYOUT.VIEWPORT = {
  x: LAYOUT.C.x,
  y: LAYOUT.C.y + LAYOUT.C.titleBar,
  width: LAYOUT.C.width,
  height: LAYOUT.C.height - LAYOUT.C.titleBar,
};
/** 几何锚点：所有像素断言都引用这里，避免各探针各写一套坐标。 */
function anchorPoints(vp) {
  const v = vp || LAYOUT.VIEWPORT;
  const c = LAYOUT.C;
  return {
    aCenter: { x: LAYOUT.A.x + LAYOUT.A.width / 2, y: LAYOUT.A.y + LAYOUT.A.height / 2 },
    bCenter: { x: LAYOUT.B0.x + LAYOUT.B0.width / 2, y: LAYOUT.B0.y + LAYOUT.B0.height / 2 },
    desktop: { x: 100, y: 420 },
    vCenter: { x: v.x + v.width / 2, y: v.y + v.height / 2 },
    vLeft: { x: v.x + 40, y: v.y + v.height / 2 },
    vRight: { x: v.x + v.width - 40, y: v.y + v.height / 2 },
    vTop: { x: v.x + v.width / 2, y: v.y + 12 },
    vBottom: { x: v.x + v.width / 2, y: v.y + v.height - 12 },
    // 窗口圆角：整窗矩形四角的内侧。若原生视图是方角矩形，这里会露出网页
    winBottomLeft: { x: c.x + 3, y: c.y + c.height - 3 },
    winBottomRight: { x: c.x + c.width - 3, y: c.y + c.height - 3 },
  };
}

/** 建 Gate 场景页。原生视图由探针按 #viewport 的实时矩形对齐。 */
function shellGate() {
  const { W, H, A, B0, C } = LAYOUT;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:${W}px;height:${H}px;background:#00ff00;overflow:hidden;
            font:600 13px ui-monospace,monospace;color:#111}
  .win{position:fixed;box-sizing:border-box}
  /* 窗口层级：chromeC 在最底，普通窗口 A/B 在其上（这是焦点窗口的真实情形）。
     若三者的 z 序相同，DOM 文档顺序会让后面的 chromeC 盖住 wB —— 场景就错了。 */
  #wA{left:${A.x}px;top:${A.y}px;width:${A.width}px;height:${A.height}px;background:#ff00ff;
      border-radius:12px;display:flex;align-items:center;justify-content:center;z-index:2}
  #wB{left:${B0.x}px;top:${B0.y}px;width:${B0.width}px;height:${B0.height}px;background:#ffff00;
      border-radius:12px;display:flex;align-items:center;justify-content:center;z-index:3}
  #chromeC{left:${C.x}px;top:${C.y}px;width:${C.width}px;height:${C.height}px;background:#808080;
      border-radius:${C.radius}px;z-index:1}
  #chromeC .bar{position:absolute;left:0;top:0;right:0;height:${C.titleBar}px;
      border-radius:${C.radius}px ${C.radius}px 0 0;background:#6b6b6b;display:flex;align-items:center;
      padding-left:10px;color:#eee}
  #viewport{position:absolute;left:0;top:${C.titleBar}px;width:${C.width}px;height:${C.height - C.titleBar}px}
  </style></head><body>
  <div class="win" id="wA" data-role="window-a">Window A</div>
  <div class="win" id="wB" data-role="window-b">Window B</div>
  <div class="win" id="chromeC" data-role="window-c"><div class="bar">Browser C</div>
    <div id="viewport" data-role="viewport"></div></div>
  <script>
    window.__hits = []; window.__ready = true;
    window.__set = (id, r) => {
      const el = document.getElementById(id);
      if (r.x !== undefined) el.style.left = r.x + "px";
      if (r.y !== undefined) el.style.top = r.y + "px";
      if (r.width !== undefined) el.style.width = r.width + "px";
      if (r.height !== undefined) el.style.height = r.height + "px";
      if (r.z !== undefined) el.style.zIndex = r.z;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
    };
    window.__vp = () => {
      const el = document.getElementById("viewport");
      el.style.zIndex = "";
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
    };
    window.__chromeCorner = () => {
      const el = document.getElementById("chromeC");
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
    };
    for (const t of ["pointerdown","mousedown","click","dblclick","contextmenu","keydown","wheel"]) {
      addEventListener(t, (e) => {
        const el = e.target && e.target.id ? e.target.id : (e.target && e.target.tagName) || "?";
        window.__hits.push({ t, x: Math.round(e.clientX||0), y: Math.round(e.clientY||0), key: e.key||"", target: el });
      }, true);
    }
  </script></body></html>`;
}

// ---------------------------------------------------------------------------
// 真实合成帧（screencapture）
//
// 为什么必须走系统截图：实测 webContents.capturePage() 只包含渲染进程自己的图层，
// **不包含 WebContentsView 子视图**（视图可见/隐藏返回的画面完全一致）。
// 层级、遮挡、圆角这类问题必须在真实合成帧上判，不能在 capturePage 上判。
//
// screencapture -R 用屏幕点（DIP），输出是 Retina 物理像素。
// 录屏权限：本机 `screencapture -x` 与 `-x -R` 均可用；早期 `-R 0,0,40,40` 曾报
// "could not create image from rect"，属尺寸过小的偶发失败，因此下面检查退出码与文件大小。
// ---------------------------------------------------------------------------
const { spawnSync } = require("node:child_process");
const PIXELS = path.join(__dirname, "_pixels.py");

/**
 * 抓一帧真实合成帧。
 * @param rectDip {x,y,width,height} 屏幕 DIP 坐标（左上角为主屏原点）
 * @param name    产物文件名（写入 artifacts/d2-02/）
 */
function shoot(rectDip, name) {
  fs.mkdirSync(ART, { recursive: true });
  const file = path.join(ART, name);
  const r = spawnSync(
    "/usr/sbin/screencapture",
    ["-x", "-R", `${Math.round(rectDip.x)},${Math.round(rectDip.y)},${Math.round(rectDip.width)},${Math.round(rectDip.height)}`, file],
    { encoding: "utf8" },
  );
  const exists = fs.existsSync(file);
  const size = exists ? fs.statSync(file).size : 0;
  return { file, ok: r.status === 0 && exists && size > 2000, status: r.status, stderr: (r.stderr || "").trim(), size };
}

/** 在一张 screencapture 产物上按 rect 内 DIP 坐标采样。points 支持 {x,y} 或 [x,y]。 */
function readPixels(file, rectWidthDip, points) {
  const norm = Object.fromEntries(
    Object.entries(points).map(([k, p]) => [k, Array.isArray(p) ? p : [p.x, p.y]]),
  );
  const r = spawnSync(
    "/usr/bin/python3",
    [PIXELS, file, JSON.stringify({ rectW: rectWidthDip, points: norm })],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error("像素读取失败：" + (r.stderr || "").slice(0, 400));
  return JSON.parse(r.stdout);
}

/** 把「窗口内容区内的 DIP 坐标」换算成「屏幕 DIP 坐标」。 */
function screenPoint(contentBounds, dipX, dipY) {
  return { x: contentBounds.x + dipX, y: contentBounds.y + dipY };
}

/** 把真实合成帧的采样结果整理成 {name: "rgb(r,g,b)"}。 */
function colors(res) {
  return Object.fromEntries(Object.entries(res.points).map(([k, v]) => [k, `rgb(${v.rgb.join(",")})`]));
}
function colorOf(res, name) {
  const p = res.points[name];
  return p ? { r: p.rgb[0], g: p.rgb[1], b: p.rgb[2] } : null;
}

// ---------------------------------------------------------------------------
// OS 级鼠标输入注入
// 先 `CGWarpMouseCursorPosition`（无需辅助功能授权）把指针精确放好，
// 再用 cliclick 发点击。位置在发送前会复查，被人手挪动则判该次无效并重试。
// ---------------------------------------------------------------------------
function cursorPos() {
  const r = spawnSync(
    "/usr/bin/python3",
    ["-c", "import Quartz,sys;e=Quartz.CGEventCreate(None);p=Quartz.CGEventGetLocation(e);sys.stdout.write('%d,%d'%(round(p.x),round(p.y)))"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return null;
  const [x, y] = String(r.stdout).split(",").map(Number);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}
function warp(x, y) {
  spawnSync("/usr/bin/python3", ["-c", `import Quartz;Quartz.CGWarpMouseCursorPosition((${Math.round(x)},${Math.round(y)}))`]);
}
function cliclick(args) {
  return spawnSync("/opt/homebrew/bin/cliclick", args, { encoding: "utf8" });
}
/** macOS 虚拟键码（与键盘布局无关，取自 Carbon kVK_*）。 */
const KEYS = { a: 0, s: 1, d: 2, f: 3, return: 36, tab: 48, space: 49, escape: 53, left: 123, right: 124 };
/** 注入一次真实键盘按键（含 down/up）。用于验证键盘到底进了哪个 webContents。 */
function keyPress(code) {
  const py = [
    "import Quartz, time",
    `d = Quartz.CGEventCreateKeyboardEvent(None, ${code}, True)`,
    "Quartz.CGEventPost(Quartz.kCGHIDEventTap, d)",
    "time.sleep(0.04)",
    `u = Quartz.CGEventCreateKeyboardEvent(None, ${code}, False)`,
    "Quartz.CGEventPost(Quartz.kCGHIDEventTap, u)",
  ].join("\n");
  return spawnSync("/usr/bin/python3", ["-c", py], { encoding: "utf8" });
}
/** 带修饰键的按键（如 Shift+Tab）。修饰用 CGEventSetFlags 表达，不是伪造修饰键本身的按键。 */
function keyChord(flagMask, code) {
  const py = [
    "import Quartz, time",
    `d = Quartz.CGEventCreateKeyboardEvent(None, ${code}, True)`,
    `Quartz.CGEventSetFlags(d, ${flagMask})`,
    "Quartz.CGEventPost(Quartz.kCGHIDEventTap, d)",
    "time.sleep(0.04)",
    `u = Quartz.CGEventCreateKeyboardEvent(None, ${code}, False)`,
    `Quartz.CGEventSetFlags(u, ${flagMask})`,
    "Quartz.CGEventPost(Quartz.kCGHIDEventTap, u)",
  ].join("\n");
  return spawnSync("/usr/bin/python3", ["-c", py], { encoding: "utf8" });
}
const FLAGS = { shift: 1 << 17, control: 1 << 18, option: 1 << 19, command: 1 << 20 };
/**
 * 列出本进程当前在屏的**真实 OS 窗口**（含 bounds 与 layer）。
 * 用途：证明"原生 child 窗口"是不是一个独立 OS 窗口 —— 这是产品可见后果，
 * 不能只看 BrowserWindow.getAllWindows()。
 */
function osWindows(pid) {
  const py = [
    "import Quartz, json, sys",
    `pid = ${pid}`,
    "wl = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID)",
    "out = []",
    "for w in wl:",
    "    if w.get('kCGWindowOwnerPID') != pid:",
    "        continue",
    "    b = w.get('kCGWindowBounds') or {}",
    "    out.append({'name': w.get('kCGWindowName') or '', 'layer': w.get('kCGWindowLayer'),",
    "                'x': int(b.get('X', 0)), 'y': int(b.get('Y', 0)),",
    "                'w': int(b.get('Width', 0)), 'h': int(b.get('Height', 0))})",
    "sys.stdout.write(json.dumps(out))",
  ].join("\n");
  const r = spawnSync("/usr/bin/python3", ["-c", py], { encoding: "utf8" });
  if (r.status !== 0) return { error: (r.stderr || "").slice(0, 300), windows: [] };
  let windows = [];
  try {
    windows = JSON.parse(r.stdout);
  } catch {
    /* ignore */
  }
  return { count: windows.length, windows };
}

module.exports = {
  ART,
  LAYOUT,
  anchorPoints,
  shellGate,
  grab,
  mapRegion,
  rgb,
  near,
  savePng,
  shellHTML,
  pageHTML,
  dataURL,
  shoot,
  readPixels,
  screenPoint,
  colors,
  colorOf,
  cursorPos,
  warp,
  cliclick,
  KEYS,
  FLAGS,
  keyPress,
  keyChord,
  osWindows,
  RED,
  GREEN,
  BLUE,
  MAGENTA,
  CYAN,
  YELLOW,
  WHITE,
};
