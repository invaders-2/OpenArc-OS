/**
 * D5-01 Closure-4 · **屏幕几何与真实指针的唯一换算**（测试仪器，不进产品）。
 *
 * 为什么单独抽出来：Closure-4 之前，可见性门禁里同时存在两条换算路径 ——
 *   ① 按 domain 意图矩形（窗口 bounds + chrome）换算；
 *   ② 按 DOM 占位符 .web-viewport + 经验标定 dy 换算。
 * 两条路径在有提示条时给出不同结果，导致"仪器自己和自己打架"。现在只有一条：
 * 全部以**实测的原生视图矩形**为原点，并用三条互相独立的通道交叉验证：
 *
 *   ① 像素：screencapture -x -o -l <CGWindowID> 抓本窗口画面 → 行/列扫描出原生视图矩形；
 *   ② 真实指针：cliclick（CGEvent）点一个已知屏幕点 → 网页自己回报 client 坐标 → 反推视图原点；
 *   ③ DOM：窗口内容原点 = window.screenX/screenY + 标题栏高度（outer.oh - inner.oh），
 *      DOM 矩形 → 屏幕矩形；原生视图矩形必须与 .web-viewport 的预留矩形一致。
 *
 * 三者一致才允许用这套换算发真实点击；任何一条不一致就如实报未验证。
 */
import { execFileSync } from "node:child_process";

export const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" });
export const cliclick = (s) => sh("cliclick", [String(s)]).trim();
export const PY = (script, args) => sh("python3", ["-c", script, ...args.map(String)]);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const PAGE_GREEN = [10, 125, 79]; // 站点 /paint 与 /notice-lab 的纯色
export const isPageGreen = (rgb) => { const p = String(rgb).split(",").map(Number); return p.length === 3 && p[1] - p[0] >= 40 && p[1] - p[2] >= 20; };

/** 我们进程的屏幕窗口（**只按 PID 过滤** —— 绝不碰别的实例）。 */
export function ourWindows(pid) {
  const py = [
    "import json,sys",
    "from Quartz import CGWindowListCopyWindowInfo, kCGWindowListOptionOnScreenOnly, kCGNullWindowID",
    "pid=int(sys.argv[1]); out=[]",
    "for w in CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID):",
    "    if w.get('kCGWindowOwnerPID')==pid:",
    "        b=w.get('kCGWindowBounds')",
    "        out.append({'id':int(w.get('kCGWindowNumber')),'x':float(b['X']),'y':float(b['Y']),'w':float(b['Width']),'h':float(b['Height']),'layer':int(w.get('kCGWindowLayer'))})",
    "print(json.dumps(out))",
  ].join("\n");
  return JSON.parse(PY(py, [pid]));
}
/** 全屏 layer-0 窗口顺序（判断"最前面的是不是我们"）。 */
export function frontmostLayer0() {
  const py = [
    "import json,sys",
    "from Quartz import CGWindowListCopyWindowInfo, kCGWindowListOptionOnScreenOnly, kCGNullWindowID",
    "out=[]",
    "for w in CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID):",
    "    if int(w.get('kCGWindowLayer'))==0: out.append({'pid':int(w.get('kCGWindowOwnerPID')),'id':int(w.get('kCGWindowNumber'))})",
    "print(json.dumps(out[:5]))",
  ].join("\n");
  return JSON.parse(PY(py, []));
}
/**
 * 系统**当前活跃 App**（NSWorkspace.frontmostApplication）。
 * 与"最前面的 layer-0 窗口"不是一回事：App 可以是最前窗口而不活跃（未成为 key app），
 * 此时第一下点击只会被系统用来激活它、不会送进内容 —— 真实指针门禁必须先确认它。
 */
export function frontmostAppPid() {
  const py = [
    "import sys",
    "from AppKit import NSWorkspace",
    "app = NSWorkspace.sharedWorkspace().frontmostApplication()",
    "print(int(app.processIdentifier()) if app else -1)",
  ].join("\n");
  try { return Number(PY(py, []).trim()); } catch { return -1; }
}
export function activate(pid) {
  try { sh("osascript", ["-e", "tell application \"System Events\" to set frontmost of (first process whose unix id is " + pid + ") to true"]); } catch { /* ignore */ }
  try { sh("osascript", ["-e", "tell application \"System Events\" to tell (first process whose unix id is " + pid + ") to perform action \"AXRaise\" of window 1"]); } catch { /* ignore */ }
  return true;
}
export async function ensureFrontmost(pid, winId, tries = 6) {
  for (let i = 0; i < tries; i += 1) {
    const f = frontmostLayer0();
    if (f.length && f[0].id === winId) {
      // 已经是最前窗口，但 App 未必活跃：再显式激活一次并等它成为 key app（否则第一下点击会被系统吃掉）。
      if (frontmostAppPid() !== pid) { activate(pid); await sleep(1200); }
      return { ok: true, front: f.slice(0, 3), activePid: frontmostAppPid(), tries: i + 1 };
    }
    activate(pid);
    await sleep(1500);
  }
  return { ok: false, front: frontmostLayer0().slice(0, 3), activePid: frontmostAppPid(), tries };
}
export function captureTo(id, file) { sh("screencapture", ["-x", "-o", "-l", String(id), file]); return file; }
export function imageSize(file) {
  const py = [
    "import sys",
    "from Quartz import CGImageSourceCreateWithURL, CGImageSourceCreateImageAtIndex, CGImageGetWidth, CGImageGetHeight, CFURLCreateWithFileSystemPath, kCFURLPOSIXPathStyle",
    "url=CFURLCreateWithFileSystemPath(None, sys.argv[1], kCFURLPOSIXPathStyle, False)",
    "img=CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithURL(url, None),0,None)",
    "print('%d,%d' % (CGImageGetWidth(img), CGImageGetHeight(img)))",
  ].join("\n");
  return PY(py, [file]).trim().split(",").map(Number);
}
export function pixelAt(file, x, y) {
  const py = [
    "import sys",
    "from Quartz import CGImageSourceCreateWithURL, CGImageSourceCreateImageAtIndex, CGImageGetDataProvider, CGDataProviderCopyData, CGImageGetBytesPerRow, CGImageGetBitsPerPixel, CFURLCreateWithFileSystemPath, kCFURLPOSIXPathStyle",
    "url=CFURLCreateWithFileSystemPath(None, sys.argv[1], kCFURLPOSIXPathStyle, False)",
    "img=CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithURL(url, None),0,None)",
    "bpr=CGImageGetBytesPerRow(img); bpp=CGImageGetBitsPerPixel(img)",
    "buf=bytes(CGDataProviderCopyData(CGImageGetDataProvider(img)))",
    "x=int(sys.argv[2]); y=int(sys.argv[3]); o=y*bpr+x*(bpp//8)",
    "print('%d,%d,%d' % (buf[o], buf[o+1], buf[o+2]))",
  ].join("\n");
  return PY(py, [file, x, y]).trim();
}
/** 一次调用同时扫一列与一行，返回各自的"绿区间"（图像像素坐标）。 */
export function scanGreen(file, col, row) {
  const py = [
    "import sys, json",
    "from Quartz import CGImageSourceCreateWithURL, CGImageSourceCreateImageAtIndex, CGImageGetDataProvider, CGDataProviderCopyData, CGImageGetWidth, CGImageGetHeight, CGImageGetBytesPerRow, CGImageGetBitsPerPixel, CFURLCreateWithFileSystemPath, kCFURLPOSIXPathStyle",
    "url=CFURLCreateWithFileSystemPath(None, sys.argv[1], kCFURLPOSIXPathStyle, False)",
    "img=CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithURL(url, None),0,None)",
    "bpr=CGImageGetBytesPerRow(img); bpp=CGImageGetBitsPerPixel(img); step=bpp//8; w=CGImageGetWidth(img); h=CGImageGetHeight(img)",
    "buf=bytes(CGDataProviderCopyData(CGImageGetDataProvider(img)))",
    "def isg(o):",
    "    r,g,b=buf[o],buf[o+1],buf[o+2]; return g-r>=40 and g-b>=20",
    "x=int(sys.argv[2]); first=None; last=None",
    "for y in range(h):",
    "    o=y*bpr+x*step",
    "    if isg(o):",
    "        if first is None: first=y",
    "        last=y",
    "colout={'first':first,'last':last}",
    "y=int(sys.argv[3]); first=None; last=None",
    "for x in range(w):",
    "    o=y*bpr+x*step",
    "    if isg(o):",
    "        if first is None: first=x",
    "        last=x",
    "rowout={'first':first,'last':last}",
    "print(json.dumps({'col':colout,'row':rowout}))",
  ].join("\n");
  return JSON.parse(PY(py, [file, col, row]));
}

/** 由像素扫描结果得到原生视图的屏幕矩形（pt）。 */
export function viewRectFromPixels(win, scale, scan) {
  if (scan.col.first == null || scan.row.first == null) return null;
  return {
    left: win.x + scan.row.first / scale,
    top: win.y + scan.col.first / scale,
    right: win.x + scan.row.last / scale,
    bottom: win.y + scan.col.last / scale,
    width: (scan.row.last - scan.row.first) / scale,
    height: (scan.col.last - scan.col.first) / scale,
  };
}

/**
 * 唯一换算器。输入全部是**实测值**：
 *   · viewRect 原生视图屏幕矩形（像素扫描得到）—— 网页坐标 → 屏幕点用它；
 *   · origin   DOM (0,0) 的屏幕原点 = 窗口内容原点（win.x, win.y + 标题栏高度）—— 外壳控件用它。
 *
 * **origin 不能由 viewRect 反推**：chrome 之下还可能有 DOM 条带（提示条/错误条）需要网页让位，
 * 那时 viewRect.top − shell.top − chrome ≠ 内容原点。两条几何必须各自独立，再用一致性断言对齐。
 */
export function makeMapper({ win, scale, viewRect, origin }) {
  const content = { x: origin.x, y: origin.y };
  return {
    content,
    /** DOM 点 → 屏幕点（外壳控件用，例如窗口按钮、标签栏、地址栏）。 */
    domToScreen: (p) => ({ x: Math.round(content.x + p.x), y: Math.round(content.y + p.y) }),
    /** 网页坐标（client px）→ 屏幕点（网页交互用）。 */
    pageToScreen: (p) => ({ x: Math.round(viewRect.left + p.x), y: Math.round(viewRect.top + p.y) }),
    /** 屏幕点 → 本窗口截图的图像像素坐标。 */
    screenToImage: (p) => ({ x: Math.round((p.x - win.x) * scale), y: Math.round((p.y - win.y) * scale) }),
    pixelOfScreen: (file, p) => pixelAt(file, Math.round((p.x - win.x) * scale), Math.round((p.y - win.y) * scale)),
  };
}

/**
 * 真实点击的**安全闸**：每次点击前重新确认
 *   ① 本实例窗口还在；② 它此刻是最前面的 layer-0 窗口；③ 落点在本窗口内容区内。
 * 三条任一不满足就**不发点击**（绝不冒险碰到用户正在用的另一个实例）。
 * 焦点可能被系统/别的窗口抢走，因此允许"重新激活后再校验"，最多 3 轮。
 */
export function makeSafeClick({ pid, titlebar = 32, winId = null, tries = 3 }) {
  return async function safeClick(pt, label) {
    const trace = [];
    for (let i = 0; i < tries; i += 1) {
      const w = ourWindows(pid).filter((x) => x.layer === 0 && x.w > 400)[0];
      if (!w) return { ok: false, reason: "window-gone:" + label, trace };
      if (winId && w.id !== winId) return { ok: false, reason: "window-changed:" + label, trace };
      const front = frontmostLayer0();
      const activePid = frontmostAppPid();
      trace.push({ ours: w.id, front, activePid });
      // 判据是"最前面的 layer-0 窗口属于**本进程**、且本进程是**活跃 App**"：别的 App 或另一个
      // OpenArc 实例（不同 PID）一律不点；同一个进程内窗口顺序的抖动不该被误判成"不能点"。
      if (front.length && front[0].pid === pid && activePid === pid) {
        if (pt.x < w.x + 6 || pt.x > w.x + w.w - 6 || pt.y < w.y + titlebar + 4 || pt.y > w.y + w.h - 6)
          return { ok: false, reason: "outside-content:" + label, trace };
        cliclick("m:" + pt.x + "," + pt.y);
        await sleep(150);
        cliclick("c:" + pt.x + "," + pt.y);
        return { ok: true, attempt: i + 1, trace };
      }
      activate(pid);
      await sleep(1400);
    }
    return { ok: false, reason: "not-frontmost:" + label, trace };
  };
}
