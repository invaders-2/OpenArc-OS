/**
 * D2-02 · 桌面组件（§18 / §19）。
 *
 * 组件化的判据不是"拆得多"，而是**契约窄**：
 *   · 每个组件只接受它真正需要的东西，不做"万能 props 包"
 *   · 窗口状态一律从 `window` 领域对象读，组件不持有窗口业务状态（§19）
 *   · 所有会改状态的动作只走 `onCommand(WindowCommand)`（§20）
 *
 * 视觉完全沿用既有 styles.css 类名 —— 组件化的目的是**换掉状态所有权**，
 * 不是换外观。所以这里没有一处新增的视觉样式。
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Orb } from "orb-ui";
import type { OrbAdapter } from "orb-ui";
import { useMicSignal } from "./useMicLevel";
import { SiriBlob } from "./SiriBlob";
import { SiriOrbProcedural, type SiriOrbHandle } from "./SiriOrbProcedural";
import {
  ArrowLeft,
  ArrowRight,
  Compass,
  Folder,
  LayoutGrid,
  Lock,
  LogOut,
  Minus,
  Monitor,
  PenTool,
  Puzzle,
  RotateCw,
  Search,
  Settings,
  SlidersHorizontal,
  X,
} from "lucide-react";
import domain from "../../electron/window-domain.cjs";
import type { Window as WinDomain, WindowCommand } from "../../electron/window-domain.cjs";
import { useDockArrange } from "./useDockArrange";
import { useDockMagnify } from "./useDockMagnify";

const icon = (name: string) => "./icons/" + name + ".png";

// ===========================================================================
// 1. TopBar
//
// 顶栏左侧**不再自绘红绿灯**：改用系统原生红绿灯（main.cjs: titleBarStyle:"hidden"
// + trafficLightPosition）。原生三灯操作的是 OpenArc 窗口本身，可用且符合 macOS 预期；
// 之前那套 DOM 红绿灯只能操作"当前聚焦的内部窗口"，没有聚焦窗口时三灯全灰，等于不可用。
// 每个内部窗口标题栏内仍保留自己的红绿灯（TitleBar）。
// ===========================================================================

const host = () => ({ width: innerWidth, height: innerHeight });

/** 顶栏"最近应用"的线性图标。与应用身份图标（Dock 里那套彩色 PNG）不是一层：
 *  顶栏统一线性，应用身份保持彩色（DESIGN_SYSTEM 的"平台约定例外"）。 */
const appLineIcon: Record<string, React.ComponentType<{ size?: number }>> = {
  home: LayoutGrid,
  browser: Compass,
  files: Folder,
  canvas: PenTool,
  skills: Puzzle,
  settings: Settings,
};

type TopBarProps = {
  /** 搜索是否打开。只用来表达 aria-expanded，因此是 boolean 而不是查询串 ——
      需要查询串的地方是搜索面板，不是顶栏。 */
  searchOpen: boolean;
  onCommand: (c: WindowCommand) => void;
  /** 控制中心是否打开。只用于 aria-expanded。 */
  controlOpen: boolean;
  onToggleControl: () => void;
  /** 最近打开的窗口（域的投影，不是第二份状态）。点击聚焦。 */
  recent: { id: string; title: string; appId: string }[];
  onFocusWindow: (id: string) => void;
  onToggleSearch: () => void;
  onToggleAI: () => void;
  /** 顶栏那颗球动不动：跟 Dock / 胶囊共用同一条"减少动态效果"开关，不新引状态。 */
  animated?: boolean;
  /**
   * 身份投影（D3-01）。**可选**：没有主进程时门禁不参与，顶栏保持原样。
   * 顶栏不持有任何身份状态，只显示快照并回调命令 —— 与 §25 的单一权威一致。
   */
  identity?: {
    displayName: string | null;
    locked: boolean;
    onLock: () => void;
    onLogout: () => void;
  } | null;
};

export function TopBar({
  searchOpen,
  onCommand,
  controlOpen,
  onToggleControl,
  recent,
  onFocusWindow,
  onToggleSearch,
  onToggleAI,
  animated = true,
  identity,
}: TopBarProps) {
  return (
    <header className="topbar">
      {/* 用户口径：**顶栏不要品牌字标**（logo 与 "OpenArc" 都不要），只留红绿灯与最近窗口。 */}
      <div className="topbar-recent" aria-label="最近打开的窗口">
        {recent.map((w) => {
          const AppIcon = appLineIcon[w.appId] || LayoutGrid;
          return (
            <button key={w.id} className="bar-app" aria-label={`切换到${w.title}`} onClick={() => onFocusWindow(w.id)}>
              <AppIcon size={15} />
            </button>
          );
        })}
      </div>
      <div className="topbar-right">
        <span className="local-tag">
          <Monitor size={13} /> 本机 · D1
        </span>
        <button onClick={onToggleControl} aria-label="控制中心" aria-expanded={controlOpen}>
          <SlidersHorizontal size={15} />
        </button>
        <button onClick={onToggleSearch} aria-label="全局搜索" aria-expanded={searchOpen}>
          <Search size={15} />
        </button>
        <button onClick={onToggleAI} aria-label="全局 AI">
          <OrbIcon size={18} className="topbar-orb" animated={animated} />
        </button>
        {identity ? (
          <>
            <button
              onClick={identity.onLock}
              disabled={identity.locked}
              aria-label="锁定屏幕"
              data-d3-id="topbar-lock"
            >
              <Lock size={13} /> 锁定
            </button>
            <button onClick={identity.onLogout} aria-label="退出登录" data-d3-id="topbar-logout">
              <LogOut size={13} /> {identity.displayName || "退出"}
            </button>
          </>
        ) : null}
        <span>
          {new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric" })}
        </span>
      </div>
    </header>
  );
}

// ===========================================================================
// 3-5. Dock / DockItem / DockTooltip
// ===========================================================================

type DockTooltipProps = { label: string };
export function DockTooltip({ label }: DockTooltipProps) {
  return (
    <span className="dock-tooltip" aria-hidden="true">
      {label}
    </span>
  );
}

type DockItemProps = {
  /** 程序坞上的 app id。分隔线之后那个固定的"全局 AI"没有 id，也不参与排序。 */
  id?: string;
  label: string;
  iconName: string;
  /** 该 App 是否有存活窗口（§32：按 appId 查询，而不是按 windowId）。 */
  running: boolean;
  bouncing: boolean;
  /** 正被长按拖动 —— 用来抬层级、关掉提示、盖住兄弟项的抖动。 */
  dragging?: boolean;
  /** 程序坞图标尺寸（px）与动效开关：AI 球按它画画布，减少动态效果时换成静态帧。 */
  iconSize?: number;
  orbAnimated?: boolean;
  onActivate: () => void;
  onPointerDown?: (e: React.PointerEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
};

/**
 * AI 球的观感参数：orb-ui 的 cloud 主题 + 我们自己的一版调色 / 几何。
 *
 * 调色就是 orb-ui cloud 的默认那套蓝紫：用户口径「颜色我想要这样的」，给的是那颗柔和的蓝紫云球图；之前的青/品红是我自己配的，已撤掉。
 *
 * `state="thinking"` 只取它的**动效**：orb-ui 的 idle 是静止的（实测两帧像素完全一样），
 * 而用户口径要的就是"动态的"。等真接上后端，这里换成真实状态即可。
 */
const ORB_THEME = {
  name: "cloud" as const,
  appearance: {
    deepColor: "#5c63fb",
    upperColor: "#7a8ffb",
    lowerColor: "#b8c7f9",
    highlightColor: "#e3eafa",
  },
  geometry: { diameterRatio: 0.92 },
};

/**
 * 兜底球：现有 orb-ui 的 WebGL 球（减少动态效果时退回同一张静态帧 siri.png）。
 * 球本身来自 **orb-ui**（MIT，© Alexander Chen，https://orb-ui.com）。
 *
 * 它只被 OrbIcon 里那**一个**开关选中 —— 以后要换兜底观感，改这个组件（或换掉它）即可，
 * 调用方（DockItem / AssistantPill / AIPanel）一行都不用动。
 */
function OrbUiFallback({
  size,
  boost,
  animated,
  adapter,
}: {
  size: number;
  boost: number;
  animated: boolean;
  adapter?: OrbAdapter;
}) {
  const render = Math.max(8, Math.round(size * boost));
  // orb-ui 的球只画到 size 的 ~69%（实测：47px 槽位里球 32.4px）。
  // 这里不再把球顶满槽位，而是留一圈给光晕（用户口径：「跟他一样，加一个光晕」）：
  // 球占槽位 ~78%，外面一圈 .orb::after 的柔和光晕正好盖住球那条硬边（锯齿）。
  const fill = 1.3;
  return (
    <span
      className="orb-scale"
      style={{ width: render, height: render, transform: `translate(-50%, -50%) scale(${(size * fill) / render})` }}
    >
      {animated ? (
        adapter ? (
          <Orb size={render} theme={ORB_THEME} adapter={adapter} interactive={false} className="orb-canvas" />
        ) : (
          <Orb size={render} theme={ORB_THEME} state="thinking" interactive={false} className="orb-canvas" />
        )
      ) : (
        <img className="orb-static" src={"./icons/siri.png"} alt="" width={render} height={render} draggable={false} />
      )}
    </span>
  );
}

/** AI 球的三个来源：native = 系统原生素材；procedural = 程序化近似；orb-ui = 最后兜底。 */
type OrbSource = "native" | "procedural" | "orb-ui";

/**
 * AI 球。这里是**唯一的切换点**，三级：
 *
 *     native(SiriBlob) --素材/解码出问题--> procedural(SiriOrbProcedural) --WebGL 起不来--> orb-ui
 *
 * 为什么要三级：主路径是系统里那颗 Apple 原生 Siri Blob（见 SiriBlob.tsx），但它**只在部分
 * macOS 版本里有**；老系统上协议直接 404，那些机器就得靠程序化球 —— 而不是用户说「不好看」的
 * orb-ui 那颗。orb-ui 退到最后一级只负责「球绝不能空白」。
 * 调用方（DockItem / AssistantPill / AIPanel）一行都不用动。
 *
 * 为什么减少动态效果要在这里判：orb-ui 只认系统级 `prefers-reduced-motion`，认不到产品内的开关；
 * 所以产品开关打开时**干脆不挂 WebGL**（原生那条暂停视频 seek 到静态帧，程序化那条只画一帧），
 * 既省 GPU，也不会留空壳。
 */
export function OrbIcon({
  size = 47,
  className = "",
  animated = true,
  adapter,
  boost = 2,
}: {
  size?: number;
  className?: string;
  animated?: boolean;
  /** 有真实信号源（例如麦克风）就用它驱动；没有就退回装饰性的 thinking 动效。 */
  adapter?: OrbAdapter;
  /**
   * 超采样倍数：球按 size×boost 画、再用 CSS 缩回去。
   * 为什么要这样（用户口径：图标有锯齿）：orb-ui 的圆是**片元里直接切**出来的硬边，
   * 即使画布按 devicePixelRatio（它内部 min(dpr,2)）放大，边缘仍然是台阶；
   * 画大一号再缩回等于做了一次超采样，台阶被平均掉（实测 1.5 倍超采样）。
   */
  boost?: number;
}) {
  const [source, setSource] = useState<OrbSource>("native");
  const proceduralRef = useRef<SiriOrbHandle>(null);
  /**
   * 语音联动：上游给的是 orb-ui 的 adapter（回调里是 signal.inputVolume）。这里**命令式**推给
   * 程序化球的 setLevel —— 逐帧 setState 会让 AI 面板整块玻璃每帧重渲染（真机上会闪）。
   * 原生那条由 SiriBlob 自己订阅，走的是同一份 adapter。
   */
  useEffect(() => {
    if (source !== "procedural" || !adapter) return undefined;
    return adapter.subscribe((signal) => {
      proceduralRef.current?.setLevel(signal.inputVolume ?? 0);
    });
  }, [source, adapter]);
  const sourceClass = source === "native" ? " orb-native" : source === "procedural" ? " orb-procedural" : "";
  return (
    <span
      className={`orb${sourceClass}${className ? " " + className : ""}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
      draggable={false}
    >
      {source === "native" ? (
        <SiriBlob size={size} animated={animated} adapter={adapter} onError={() => setSource("procedural")} />
      ) : source === "procedural" ? (
        <SiriOrbProcedural
          ref={proceduralRef}
          size={size}
          animated={animated}
          onError={() => setSource("orb-ui")}
        />
      ) : (
        <OrbUiFallback size={size} boost={boost} animated={animated} adapter={adapter} />
      )}
    </span>
  );
}
export function DockItem({
  id,
  label,
  iconName,
  running,
  bouncing,
  dragging,
  iconSize = 47,
  orbAnimated = true,
  onActivate,
  onPointerDown,
  onContextMenu,
}: DockItemProps) {
  return (
    <button
      className={`dock-item ${bouncing ? "bouncing" : ""}`}
      aria-label={`打开${label}`}
      data-dock-id={id}
      data-dragging={dragging ? "true" : undefined}
      onClick={onActivate}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
    >
      {iconName === "siri" ? (
        <OrbIcon className="dock-icon" size={iconSize} animated={orbAnimated} />
      ) : (
        <img className="dock-icon" src={icon(iconName)} alt="" draggable={false} />
      )}
      <DockTooltip label={label} />
      <span className={`running-dot ${running ? "running" : ""}`} />
    </button>
  );
}

type DockProps = {
  apps: readonly { id: string; name: string; icon: string }[];
  /** `appId → windowIds[]`。Dock 消费 Window Manager，不自己数窗口。 */
  runningApps: ReadonlySet<string>;
  bouncing: string | null;
  /** 减少动效：关闭波浪放大（与材质档位解耦）。 */
  reduced: boolean;
  /** 程序坞图标尺寸（px，来自设置里的滑块）：AI 球要按它画画布。 */
  iconSize?: number;
  /**
   * 激活一个 App。**Dock 不自己决定要派发哪条窗口命令** ——
   * "聚焦已有窗口 / 恢复最小化的窗口 / 新建"这个判断需要看 `appId → windowIds[]`，
   * 属于窗口状态，只有持有 Window Manager 的那一层才做得对（§32 / §33）。
   */
  onActivate: (appId: string) => void;
  onToggleAI: () => void;
  /** 全屏时自动隐藏（底部留一条 hover 带把它唤回来）。 */
  hidden?: boolean;
  onPointerLeave?: () => void;
  /** 长按拖动排序的结果。顺序的真值在 App（它负责持久化），Dock 只上报。 */
  onReorder: (next: string[]) => void;
  /** 右键某个图标 / 右键程序坞空白。菜单由 App 渲染（只有它拿得到 App 清单）。 */
  onItemMenu: (appId: string, e: React.MouseEvent) => void;
  onSurfaceMenu: (e: React.MouseEvent) => void;
  /** 回收站是否有内容：macOS 行为 —— 空桶 trash.png / 满桶 trash-full.png。 */
  trashFull?: boolean;
};

export function Dock({
  apps,
  runningApps,
  bouncing,
  reduced,
  iconSize = 47,
  onActivate,
  onToggleAI,
  hidden,
  onPointerLeave,
  onReorder,
  onItemMenu,
  onSurfaceMenu,
  trashFull = false,
}: DockProps) {
  // 放大与整理都由 Dock 自己持有：它只在身份门通过后挂载，父层的 useEffect
  // 拿不到这一刻（详见 useDockMagnify 顶部注释）。两个 hook 共用同一个 ref ——
  // 整理期间放大必须让位（槽位由拖动手势接管）。
  const dockRef = useRef<HTMLElement>(null);
  // 回收站是系统级固定槽位（macOS 惯例在分隔线右侧、最右端）：不参与长按排序，
  // 因此它从排序的 ids 里排除，只作为一个固定 DockItem 画出来。
  const mainApps = apps.filter((a) => a.id !== "trash");
  const trashApp = apps.find((a) => a.id === "trash");
  const order = mainApps.map((a) => a.id);
  const arrange = useDockArrange(dockRef, { ids: order, onReorder, onActivate });
  useDockMagnify(dockRef, reduced || arrange.arranging, order.join(","));
  return (
    <nav
      className={`dock ${hidden ? "hidden" : ""} ${arrange.arranging ? "arranging" : ""}`}
      aria-label="应用栏"
      ref={dockRef}
      onPointerLeave={onPointerLeave}
      onContextMenu={onSurfaceMenu}
    >
      {/* 底板两层：阴影在下、静止玻璃在上（为什么这么拆见 styles.css 里的说明） */}
      <span className="dock-shadow" aria-hidden="true" />
      <span className="dock-glass" aria-hidden="true" />
      {mainApps.map((a) => (
        <DockItem
          key={a.id}
          id={a.id}
          label={a.name}
          iconName={a.icon}
          running={runningApps.has(a.id)}
          bouncing={bouncing === a.id}
          dragging={arrange.dragId === a.id}
          onActivate={() => arrange.activate(a.id)}
          onPointerDown={(e) => arrange.press(a.id, e)}
          onContextMenu={(e) => onItemMenu(a.id, e)}
        />
      ))}
      <div className="dock-divider" />
      <DockItem
        label="全局 AI"
        iconName="siri"
        running={false}
        bouncing={bouncing === "__ai"}
        iconSize={iconSize}
        orbAnimated={!reduced}
        onActivate={onToggleAI}
      />
      {/* 回收站是系统级固定槽位（macOS 惯例：分隔线右侧、最右端），按内容切换空桶/满桶。
          原生素材来源：/System/Library/CoreServices/Dock.app/Contents/Resources/
          trashempty@2x.png（空桶）与 trashfull@2x.png（满桶），拷贝到 public/icons/ 供本机原型使用。 */}
      {trashApp ? (
        <DockItem
          label="回收站"
          iconName={trashFull ? "trash-full" : "trash"}
          running={runningApps.has("trash")}
          bouncing={bouncing === "trash"}
          onActivate={() => onActivate("trash")}
          onContextMenu={(e) => onItemMenu("trash", e)}
        />
      ) : null}
    </nav>
  );
}

// ===========================================================================
// 5b. FolderIcon（桌面与访达共用的文件夹图标）
// ===========================================================================

/**
 * 文件夹图标。移植 React Bits 的 Folder（reactbits.dev/components/folder）的**合上态**：
 * 悬停时整体上浮、两片前板向外 skew 张开，里面的纸张探出一点 —— 像文件夹被轻轻掀开。
 *
 * 用户口径：**不播展开动画**（双击仍然直接打开文件夹窗口），因此这里没有 open 状态、
 * 没有纸张飞出、也没有纸张跟鼠标的视差。几何照抄原组件（100×80 底板 + 三张纸 + 两片前板），
 * 用 --folder-w 整体缩放，内部一律用 em（1em = 文件夹宽度），尺寸由调用点传进来。
 */
export function FolderIcon({ size = 58, className }: { size?: number; className?: string }) {
  return (
    <span
      className={"rb-folder" + (className ? " " + className : "")}
      style={{ "--folder-w": size + "px" } as React.CSSProperties}
      aria-hidden="true"
    >
      <span className="rb-folder-inner">
        <span className="rb-folder-tab" />
        <span className="rb-folder-paper rb-paper-1" />
        <span className="rb-folder-paper rb-paper-2" />
        <span className="rb-folder-paper rb-paper-3" />
        <span className="rb-folder-front rb-front-a" />
        <span className="rb-folder-front rb-front-b" />
      </span>
    </span>
  );
}

// ===========================================================================
// 6-7. Window / TitleBar
// ===========================================================================

type TitleBarProps = {
  id: string;
  /** 是否已最大化 —— 决定"最大化"按钮与双击是放大还是还原。 */
  maximized: boolean;
  /**
   * 红灯的语义。用户口径：**App 窗口不真的关闭，一律最小化**（收进 Dock），
   * 只有系统设置例外（它没有常驻意义，关掉才是用户预期）。
   */
  closeAction: "close" | "minimize";
  onCommand: (c: WindowCommand) => void;
  onDragStart: (e: React.PointerEvent) => void;
};

export function TitleBar({ id, maximized, closeAction, onCommand, onDragStart }: TitleBarProps) {
  // 双向切换：双击/按钮在"放大"与"还原"之间切。只发 maximize 会让
  // window/unmaximize 成为不可达命令，用户放大后无法恢复（D2-02B 审出的缺陷）。
  const toggleMax = () =>
    onCommand(maximized ? { type: "window/unmaximize", id } : { type: "window/maximize", id, host: host() });
  return (
    <div className="window-title" onPointerDown={onDragStart} onDoubleClick={toggleMax}>
      <div className="traffic">
        <button
          className="close"
          aria-label={`${closeAction === "close" ? "关闭" : "最小化"}${id}`}
          onClick={() =>
            onCommand(closeAction === "close" ? { type: "window/close", id } : { type: "window/minimize", id })
          }
        >
          <X size={8} strokeWidth={3} />
        </button>
        <button className="minimize" aria-label={`最小化${id}`} onClick={() => onCommand({ type: "window/minimize", id })}>
          <Minus size={8} strokeWidth={3} />
        </button>
        <button className="maximize" aria-label={`${maximized ? "还原" : "最大化"}${id}`} onClick={toggleMax}>
          {/* macOS 原生绿色按钮的"双三角"缩放符号，而不是对角箭头 */}
          <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1 4.6 L4.6 4.6 L4.6 1 Z" fill="currentColor" />
            <path d="M9 5.4 L5.4 5.4 L5.4 9 Z" fill="currentColor" />
          </svg>
        </button>
      </div>
    </div>
  );
}

type WindowProps = {
  window: WinDomain;
  focused: boolean;
  onCommand: (c: WindowCommand) => void;
  /** 快照层：原生视图被收缩/隐藏后把网页画面补回 DOM（ADR §12）。 */
  snapshots?: { rect: { x: number; y: number; width: number; height: number }; dataUrl: string }[];
  onResizeStart: (e: React.PointerEvent) => void;
  children: React.ReactNode;
};

/**
 * 窗口容器。**不拥有任何业务状态** ——
 * 位置尺寸来自 `window.bounds`，层级来自 `window.z`，聚焦来自 `focused`，
 * 它自己只有"拖拽中"这一个纯交互状态，且不回写域（域在 pointermove 里更新）。
 */
export function Window({ window: w, focused, onCommand, snapshots, onResizeStart, children }: WindowProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const wasVisible = useRef(w.visible);

  /**
   * 最小化 / 恢复的动效几何。
   *
   * 目标点就是该 App 在 Dock 上的图标中心 —— **在状态翻转的那一帧量一次**，
   * 之后整个动画期间 Dock 自己怎么放大都不影响（动画吃的是写死的 --min-tx/--min-ty）。
   * 量不到图标（文件夹窗口之类）时退化成"向下收走"。
   */
  useLayoutEffect(() => {
    if (wasVisible.current === w.visible) return;
    wasVisible.current = w.visible;
    const el = rootRef.current;
    if (!el) return;
    const icon = document.querySelector<HTMLElement>(`.dock-item[data-dock-id="${w.appId}"]`);
    const target = icon?.getBoundingClientRect();
    // 用 bounds 算中心而不是 getBoundingClientRect()：最小化态带着 min-out 的缩放，
    // 量出来的是那个缩到 0.05 的小方块，恢复时会从错的地方展开。
    const centerX = w.bounds.x + w.bounds.w / 2;
    const centerY = w.bounds.y + w.bounds.h / 2;
    const tx = target ? target.left + target.width / 2 - centerX : 0;
    const ty = target ? target.top + target.height / 2 - centerY : w.bounds.h / 2 + 60;
    el.style.setProperty("--min-tx", `${Math.round(tx)}px`);
    el.style.setProperty("--min-ty", `${Math.round(ty)}px`);
    // 动画类一旦加上就留着：换回另一个即可重放。若在这里移除，.window 的
    // appear 动画会立刻被重新触发（恢复时闪一下）。
    el.classList.toggle("min-out", !w.visible);
    el.classList.toggle("min-in", w.visible);
  }, [w.visible, w.appId]);

  return (
    <section
      ref={rootRef}
      data-window-id={w.id}
      aria-label={`${w.meta.title}窗口`}
      className={`window ${focused ? "active" : ""} ${w.visible ? "" : "minimized"}`}
      style={{ left: w.bounds.x, top: w.bounds.y, width: w.bounds.w, height: w.bounds.h, zIndex: 10 + w.z }}
      onPointerDown={() => !focused && onCommand({ type: "window/focus", id: w.id })}
    >
      <TitleBar
        id={w.id}
        maximized={w.state === domain.WSTATE.MAXIMIZED}
        closeAction={w.appId === "settings" ? "close" : "minimize"}
        onCommand={onCommand}
        onDragStart={(e) => startDrag(e, w, onCommand)}
      />
      <div className="window-body" ref={bodyRef}>
        {children}
      </div>
      {/* 磨砂条由桌面层按窗口位置绘制（见 onScrolledChange）——不能画在窗口内部，原因见 props 注释 */}

      {snapshots?.length ? (
        <div className="window-snapshot-layer" aria-hidden="true" data-window={w.id}>
          {snapshots.map((s) => (
            <img
              key={`${s.rect.x},${s.rect.y},${s.rect.width},${s.rect.height}`}
              src={s.dataUrl}
              alt=""
              draggable={false}
              style={{
                position: "absolute",
                left: s.rect.x - w.bounds.x,
                top: s.rect.y - w.bounds.y,
                width: s.rect.width,
                height: s.rect.height,
                // 快照是静态图：必须让点击穿透，否则被补丁覆盖的区域会变成交互黑洞
                pointerEvents: "none",
              }}
            />
          ))}
        </div>
      ) : null}
      {w.state !== domain.WSTATE.MAXIMIZED ? (
        <button
          className="resize"
          aria-label={`调整${w.id}大小`}
          onPointerDown={onResizeStart}
          onKeyDown={(e) => {
            if (!e.key.startsWith("Arrow")) return;
            e.preventDefault();
            const dx = e.key === "ArrowRight" ? 20 : e.key === "ArrowLeft" ? -20 : 0;
            const dy = e.key === "ArrowDown" ? 20 : e.key === "ArrowUp" ? -20 : 0;
            onCommand({ type: "window/resize", id: w.id, w: w.bounds.w + dx, h: w.bounds.h + dy, host: host() });
          }}
        >
          ⌟
        </button>
      ) : null}
      <div ref={viewportRef} hidden aria-hidden="true" />
    </section>
  );
}

/**
 * 追踪一次指针手势（拖动 / 缩放共用）。
 *
 * **监听器挂在 window 上，而不是在元素上依赖 `setPointerCapture`。**
 *
 * 原因（experiments/d2-02/window-stress 实测）：捕获并不总会真正生效 ——
 * 探针里能看到 `setPointerCapture` 调用成功、`hasPointerCapture()` 当场返回 true，
 * 但**从没有触发过 `gotpointercapture`**，随后 `pointermove` 被投给了指针下方的
 * 别的元素。后果是：拖着拖着指针一离开元素（标题栏 44px、缩放手柄只有 22px），
 * 窗口就不跟手了；缩放更是只要移动超过手柄大小就断。
 *
 * 这种问题在肉眼上表现为"卡顿"，很难归因，而挂到 window 上就不存在这个前提：
 * 指针跑到哪里都还在同一个手势里。
 *
 * 捕获仍然尝试建立（减少重定向抖动），但**正确性不依赖它**。
 */
function trackPointer(
  e: React.PointerEvent,
  onMove: (p: PointerEvent) => void,
  onEnd: () => void,
) {
  const id = e.pointerId;
  const move = (ev: PointerEvent) => {
    if (ev.pointerId === id) onMove(ev);
  };
  const stop = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    cleanup();
    onEnd();
  };
  const cleanup = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
  try {
    (e.currentTarget as HTMLElement).setPointerCapture?.(id);
  } catch {
    /* 捕获失败不影响手势本身 */
  }
}

/** 拖拽：位移量在组件里算，**clamp 在域里做**（electron/window-manager.cjs）。 */
export function startDrag(e: React.PointerEvent, w: WinDomain, onCommand: (c: WindowCommand) => void) {
  if ((e.target as HTMLElement).closest("button,input")) return;
  if (w.state === domain.WSTATE.MAXIMIZED) return;
  const startX = e.clientX;
  const startY = e.clientY;
  const x0 = w.bounds.x;
  const y0 = w.bounds.y;
  trackPointer(
    e,
    (p) => onCommand({ type: "window/move", id: w.id, x: x0 + p.clientX - startX, y: y0 + p.clientY - startY, host: host() }),
    () => {},
  );
}

export function startResize(e: React.PointerEvent, w: WinDomain, onCommand: (c: WindowCommand) => void) {
  if (w.state === domain.WSTATE.MAXIMIZED) return;
  const startX = e.clientX;
  const startY = e.clientY;
  const w0 = w.bounds.w;
  const h0 = w.bounds.h;
  trackPointer(
    e,
    (p) => onCommand({ type: "window/resize", id: w.id, w: w0 + p.clientX - startX, h: h0 + p.clientY - startY, host: host() }),
    () => {},
  );
}

// ===========================================================================
// 8. WebViewport —— 只是 DOM 占位与几何锚点（§34）
// ===========================================================================

type WebViewportProps = {
  /** 原生视图此刻是否真的可见 —— 文案必须与它一致，否则界面在撒谎。 */
  nativeVisible: boolean;
  /** 原生视图是否真的挂在宿主上。缺挂载时"加载成功"依旧成立，但屏幕上没有页面。 */
  attached?: boolean;
  error?: string;
  children?: React.ReactNode;
};

/**
 * **不接受任何 Electron 对象。** 它不知道 WebContentsView 的存在，
 * 只知道"这块区域有没有被原生内容填上"，用来决定占位文案。
 * 几何锚点也不是它自己量的 —— 视口矩形由 domain 的 bounds 推出。
 */
export function WebViewport({ nativeVisible, attached, error, children }: WebViewportProps) {
  return (
    <div className="web-viewport" data-attached={attached === false ? "0" : "1"}>
      {children}
      <img className="viewport-icon" src={icon("safari")} alt="" draggable={false} />
      <p data-view={nativeVisible ? "shown" : "hidden"}>
        {error || (nativeVisible ? "网页内容将在此处显示" : "网页已暂时隐藏，避免遮挡系统窗口")}
      </p>
    </div>
  );
}

// ===========================================================================
// 9. AddressBar
// ===========================================================================

type AddressBarProps = {
  url: string;
  onUrlChange: (v: string) => void;
  onNavigate: () => void;
  onAction: (action: "back" | "forward" | "reload") => void;
};

export function AddressBar({ url, onUrlChange, onNavigate, onAction }: AddressBarProps) {
  return (
    <form
      className="addressbar"
      onSubmit={(e) => {
        e.preventDefault();
        onNavigate();
      }}
    >
      <button type="button" aria-label="后退" onClick={() => onAction("back")}>
        <ArrowLeft size={17} />
      </button>
      <button type="button" aria-label="前进" onClick={() => onAction("forward")}>
        <ArrowRight size={17} />
      </button>
      <button type="button" aria-label="刷新" onClick={() => onAction("reload")}>
        <RotateCw size={16} />
      </button>
      <input aria-label="网页地址" value={url} onChange={(e) => onUrlChange(e.target.value)} />
      <button className="primary">打开</button>
    </form>
  );
}

// ===========================================================================
// 11-12. AssistantPill / AIPanel
// ===========================================================================

type AssistantPillProps = { onActivate: () => void; animated?: boolean };
export function AssistantPill({ onActivate, animated = true }: AssistantPillProps) {
  return (
    <button className="assistant-pill" onClick={onActivate}>
      <OrbIcon size={19} className="pill-icon" animated={animated} />
      <span>全局 AI</span>
      <span className="pill-status">未连接</span>
    </button>
  );
}

/** backend authoritative terminal 状态：到达其中一个就必须复位 UI busy 合同。 */
const TASK_TERMINAL = ["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"];

/** D4 收口：失败 Verification 证据的可读投影（只展示 safe 字段）。 */
function formatVerificationEvidence(v: any): string {
  const fmt = (x: unknown) => (x == null ? "—" : typeof x === "string" ? x : JSON.stringify(x));
  const body = "检查方法：" + String(v.method || v.type || "UNKNOWN") + " · 预期：" + fmt(v.expected) + " · 实际：" + fmt(v.actual);
  return body.length > 400 ? body.slice(0, 400) + "…" : body;
}

type AIPanelProps = { onClose: () => void; onOpenSettings: () => void; animated?: boolean };
/**
 * D4-04：全局 AI 助手 = 真实 Task Runtime 入口。
 *
 * 它只经窄桥 window.openarc.task.command 发起任务；Renderer 不能指定 userId / role /
 * appId / sessionRef / modelConfig / verification —— 那些由主进程从 authenticated session
 * 与真实 Task Runtime 推导。工具调用仍由受控 Tool Proxy 执行。
 */
export function AIPanel({ onClose, onOpenSettings, animated = true }: AIPanelProps) {
  const [goal, setGoal] = useState("");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [status, setStatus] = useState("idle");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // D4-06 Closure：预算停止后的显式续接；resumable / 账本一律来自后端 task/get。
  const [revision, setRevision] = useState<number | null>(null);
  const [stopReason, setStopReason] = useState<string | null>(null);
  const [resumeLedger, setResumeLedger] = useState<{ resumeCount?: number; maxResumes?: number; remainingResumes?: number; kinds?: Record<string, { authorized?: number; consumed?: number; remaining?: number }>; remaining?: Record<string, number>; nextGrant?: { kind?: string; amount?: number } | null } | null>(null);
  const [resumable, setResumable] = useState(false);
  // D4-05 S2：结果未知的只读恢复投影（仅后端判定；renderer 不自报）。
  const [recovery, setRecovery] = useState<any>(null);
  // D4 收口：失败 Verification 证据（safe；只如实展示，绝不据此显示成功）。
  const [verifications, setVerifications] = useState<any[]>([]);

  // UI 线：语音 Orb / 麦克风电平（命令式推送，不进 React 每帧渲染）。
  /** 只在面板开着时听：关掉面板 = 组件卸载 = 钩子清理 = 麦克风 track 停掉（灯灭）。 */
  const [micOn, setMicOn] = useState(false);
  const mic = useMicSignal(micOn);
  const subscribeMic = mic.subscribe;
  // 开不起来（没权限/没设备）就把开关弹回去，并把原因写在下面那行小字里
  useEffect(() => {
    if (mic.error) setMicOn(false);
  }, [mic.error]);
  /**
   * 电平条走**命令式**：每帧直接改 transform，不经过 React ——
   * 30fps 的 setState 会让这块玻璃面板每帧重渲染（真机上会闪），纯属白烧。
   */
  const meterRef = useRef<HTMLSpanElement>(null);
  useEffect(
    () =>
      subscribeMic((v) => {
        if (meterRef.current) meterRef.current.style.transform = `scaleX(${v.level})`;
      }),
    [subscribeMic],
  );
  /**
   * 球也一样：用 orb-ui 的 adapter 把电平**推**进去，而不是每帧换一个 signal 对象。
   * 传 undefined（减少动态效果）时 OrbIcon 会走静态帧。
   */
  const orbAdapter = useMemo<OrbAdapter>(
    () => ({
      subscribe: (listener) => subscribeMic((v) => listener({ state: v.state, inputVolume: v.level })),
      start: async () => {},
      stop: async () => {},
    }),
    [subscribeMic],
  );

  const applyTaskState = (got: any) => {
    if (!got || !got.ok || !got.task) return;
    const next = String(got.task.status || "");
    setRevision(typeof got.task.revision === "number" ? got.task.revision : null);
    setStatus(next);
    if (TASK_TERMINAL.includes(next)) setBusy(false);
    const artifacts = Array.isArray(got.artifacts) ? got.artifacts : [];
    const artifact = artifacts.length ? artifacts[artifacts.length - 1] : null;
    if (artifact && typeof artifact.content === "string") setResult(artifact.content);
    setResumable(got.resumable === true);
    setStopReason(got.stopReason || null);
    setResumeLedger(got.budgetLedger || null);
    setRecovery(got.recovery || null);
    setVerifications(Array.isArray(got.verifications) ? got.verifications : []);
  };

  useEffect(() => {
    // §41：Reload 后必须从 backend state 恢复最新 Task 的权威结果，而不是依赖 Renderer memory。
    const bridge = (window as unknown as { openarc?: { task?: { command?: (c: unknown) => Promise<any> } } }).openarc?.task;
    if (!bridge || typeof bridge.command !== "function") return;
    const command = bridge.command;
    void (async () => {
      const list = await command({ type: "task/list" });
      const latest = list && list.ok && Array.isArray(list.items) && list.items.length ? list.items[list.items.length - 1] : null;
      if (!latest) return;
      setTaskId(latest.taskId);
      const got = await command({ type: "task/get", taskId: latest.taskId });
      if (!got || !got.ok) return;
      const restored = (got.task && got.task.status) || latest.status || "idle";
      // §24：恢复时 backend 仍在 RUNNING 说明任务未收敛，Cancel 必须可用、Run 必须保持禁用。
      setBusy(!TASK_TERMINAL.includes(restored));
      applyTaskState(got);
    })();
  }, []);

  // §24：busy 不能只依赖 happy-path task/result。以 backend authoritative task/get 为准，
  // 任何 terminal 状态都复位 Run / Cancel，并同步最终状态与 artifact。
  useEffect(() => {
    if (!busy || !taskId) return;
    const bridge = (window as unknown as { openarc?: { task?: { command?: (c: unknown) => Promise<any> } } }).openarc?.task;
    if (!bridge || typeof bridge.command !== "function") return;
    const command = bridge.command;
    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const got = await command({ type: "task/get", taskId });
          if (cancelled || !got || !got.ok || !got.task) return;
          const next = String(got.task.status || "");
          if (!TASK_TERMINAL.includes(next)) return;
          applyTaskState(got);
        } catch { /* 下一轮再试 */ }
      })();
    }, 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [busy, taskId]);

  useEffect(() => {
    const bridge = (window as unknown as { openarc?: { task?: { command?: (c: unknown) => Promise<any>; onEvent?: (cb: (e: unknown) => void) => () => void } } }).openarc?.task;
    if (!bridge || typeof bridge.onEvent !== "function") return;
    const command = bridge.command;
    const off = bridge.onEvent((event) => {
      const ev = event as { type?: string; taskId?: string; status?: string; ok?: boolean; artifact?: { content?: string }; error?: string } | null;
      if (!ev || ev.type !== "task/result") return;
      setBusy(false);
      if (ev.taskId !== taskId) return; // 非当前任务的 result 只用于解除 busy，不覆盖当前显示
      setStatus(ev.status || (ev.ok ? "SUCCEEDED" : "FAILED"));
      setResult((ev.artifact && ev.artifact.content) || "");
      setError(ev.error || "");
      // D4-06：terminal result 后从 backend 刷新 stopReason / resumable / budgetLedger。
      void (async () => { try { if (typeof command === "function") applyTaskState(await command({ type: "task/get", taskId })); } catch { /* ignore */ } })();
    });
    return () => { try { off(); } catch { /* ignore */ } };
  }, [taskId]);

  const run = async () => {
    const bridge = (window as unknown as { openarc?: { task?: { command?: (c: unknown) => Promise<{ ok?: boolean; taskId?: string; error?: string }> } } }).openarc?.task;
    if (!bridge || typeof bridge.command !== "function" || busy || !goal.trim()) return;
    setBusy(true); setStatus("running"); setResult(""); setError("");
    const res = await bridge.command({ type: "task/run", goal });
    if (res && res.ok) { setTaskId(res.taskId || null); setStatus("running"); }
    else { setBusy(false); setStatus("error"); setError((res && res.error) || "TASK_FAILED"); }
  };
  const cancel = async () => {
    const bridge = (window as unknown as { openarc?: { task?: { command?: (c: unknown) => Promise<unknown> } } }).openarc?.task;
    if (!bridge || typeof bridge.command !== "function" || !taskId) return;
    await bridge.command({ type: "task/cancel", taskId });
    setStatus("cancelling");
  };
  const resume = async () => {
    const bridge = (window as unknown as { openarc?: { task?: { command?: (c: unknown) => Promise<{ ok?: boolean; error?: string }> } } }).openarc?.task;
    if (!bridge || typeof bridge.command !== "function" || !taskId || busy || !resumable) return;
    setBusy(true); setStatus("running"); setError("");
    const res = await bridge.command({ type: "task/resume", taskId, expectedRevision: revision });
    if (!res || !res.ok) { setBusy(false); setError((res && res.error) || "RESUME_REJECTED"); }
  };
  // D4-05 S2：只追加“已人工核查”事件；绝不改 call/step/task 状态，绝不授权 resume/retry。
  const acknowledge = async (callId: string) => {
    const bridge = (window as unknown as { openarc?: { task?: { command?: (c: unknown) => Promise<{ ok?: boolean; error?: string }> } } }).openarc?.task;
    if (!bridge || typeof bridge.command !== "function" || !taskId || !callId) return;
    const res = await bridge.command({ type: "task/acknowledgeUnknownEffect", taskId, callId });
    if (!res || !res.ok) { setError((res && res.error) || "ACKNOWLEDGE_FAILED"); return; }
    const gotBridge = (window as unknown as { openarc?: { task?: { command?: (c: unknown) => Promise<any> } } }).openarc?.task;
    if (gotBridge && typeof gotBridge.command === "function") {
      const got = await gotBridge.command({ type: "task/get", taskId });
      if (got && got.ok) applyTaskState(got);
    }
  };

  const failVerifications = (verifications || []).filter((v: any) => v && v.status === "FAIL");

  return (
    <aside className="ai-panel" aria-label="AI 助手" data-ai-status={status} data-ai-task-id={taskId || ""}>
      <div className="panel-heading">
        <OrbIcon size={24} className="heading-icon" animated={animated} adapter={orbAdapter} />
        <strong>全局 AI 助手</strong>
        <button aria-label="关闭AI面板" onClick={onClose}>
          <X size={19} />
        </button>
      </div>
      <div className="ai-intro">
        <OrbIcon size={82} className="ai-orb" animated={animated} adapter={orbAdapter} />
        <h2>让 AI 在授权范围内执行任务</h2>
        <p>OpenArc 决定、执行并验证；工具调用只在受控 Tool Proxy 内发生。</p>
      </div>
      <div className="composer">
        <textarea data-ai-goal aria-label="任务目标" placeholder="描述你想完成的工作…" value={goal} onChange={(e) => setGoal(e.target.value)} />
        <div className="ai-actions">
          <button data-ai-run onClick={run} disabled={busy || !goal.trim()}>
            运行任务
          </button>
          <button data-ai-cancel onClick={cancel} disabled={!taskId || !busy}>
            取消
          </button>
        </div>
      </div>
      <div className="ai-state" data-ai-state>
        <strong>状态：</strong>
        <span data-ai-status-text>{status === "BLOCKED" ? (resumable ? "BLOCKED · Budget Exhausted" : "BLOCKED · Recovery Required") : status}</span>
        {error ? <span data-ai-error> · {error}</span> : null}
      </div>
      {resumable ? (
        <div className="ai-resume" data-ai-resume-block>
          <p data-ai-stop-reason>停止原因：{stopReason || "BUDGET_EXHAUSTED"}</p>
          <p data-ai-resume-budget>
            本次追加预算：{resumeLedger && resumeLedger.nextGrant ? resumeLedger.nextGrant.kind + " +" + resumeLedger.nextGrant.amount : "bounded step"}
            {resumeLedger && resumeLedger.nextGrant && resumeLedger.nextGrant.kind ? "（该 kind 任务剩余 " + ((resumeLedger.remaining && resumeLedger.remaining[resumeLedger.nextGrant.kind]) ?? 0) + "）" : ""}
            {resumeLedger ? "（第 " + ((resumeLedger.resumeCount || 0) + 1) + "/" + (resumeLedger.maxResumes || 3) + " 次续接）" : ""}
          </p>
          <p data-ai-resume-remaining>
            三类剩余：MODEL_CALLS {resumeLedger && resumeLedger.remaining ? (resumeLedger.remaining.MODEL_CALLS ?? 0) : "—"} / TOOL_CALLS {resumeLedger && resumeLedger.remaining ? (resumeLedger.remaining.TOOL_CALLS ?? 0) : "—"} / TOOL_ROUNDS {resumeLedger && resumeLedger.remaining ? (resumeLedger.remaining.TOOL_ROUNDS ?? 0) : "—"}
          </p>
          <button data-ai-resume onClick={resume} disabled={busy}>续接任务</button>
        </div>
      ) : null}
      {status === "BLOCKED" && recovery && recovery.applicable ? (
        <div className="ai-recovery" data-ai-recovery>
          <p data-ai-recovery-reason>结果未知 · 停止原因：{recovery.stopReason || "UNKNOWN_EFFECT"}</p>
          {(recovery.calls || []).map((c: any) => (
            <div key={c.callId} data-ai-recovery-call={c.callId}>
              <p data-ai-recovery-state>实际状态：{c.status} · 核查结论：{c.recoveryResult === "NO_CONCLUSION" ? "尚无结论" : c.recoveryResult}</p>
              <p data-ai-recovery-tool>工具：{c.toolId}{c.resourceRef ? " · 目标：" + c.resourceRef : ""}</p>
              <p data-ai-recovery-artifacts>关联产物：{(c.associatedArtifacts || []).length ? c.associatedArtifacts.map((a: any) => a.artifactId + "（" + a.type + "）").join("、") : "无"}</p>
              {c.acknowledged ? <p data-ai-acknowledged>已人工确认</p> : <button data-ai-acknowledge onClick={() => acknowledge(c.callId)} disabled={busy}>我已人工核查</button>}
            </div>
          ))}
          <p data-ai-recovery-note>该结果未知：不会自动重试，也不会自动续接；请核对实际应用与关联产物后人工确认。</p>
        </div>
      ) : null}
      {status === "BLOCKED" && failVerifications.length ? (
        <div className="ai-verification" data-ai-verification>
          <p data-ai-verification-fail>验证失败</p>
          {failVerifications.map((v: any) => (
            <div key={v.verificationId} data-ai-verification-item={v.verificationId}>
              <p data-ai-verification-detail>{formatVerificationEvidence(v)}</p>
              {v.executionId ? <p data-ai-verification-evidence>证据引用：{v.executionId}</p> : null}
            </div>
          ))}
        </div>
      ) : null}
      <div className="ai-result" data-ai-result>
        {result}
      </div>
      <div className="mic-row">
        <button className="control-button" aria-pressed={micOn} onClick={() => setMicOn((v) => !v)}>
          {micOn ? "停止聆听" : "开始聆听"}
        </button>
        <span className="mic-meter" aria-hidden="true">
          <span className="mic-meter-fill" ref={meterRef} />
        </span>
      </div>
      <p className="muted mic-note">
        {mic.error
          ? mic.error
          : micOn
            ? "球正跟着你的声音动；音频只在本机算一个音量值，不录音、不上传。识别与回答要等模型服务接入。"
            : "开启后球会跟着你的声音变化（只在本机算音量，不外发）。"}
      </p>
      <div className="connection-card">
        <p>受控工具：resource.search / resource.read.metadata / resource.trash。</p>
        <button onClick={onOpenSettings}>
          查看统一设置 <ArrowRight size={15} />
        </button>
      </div>
    </aside>
  );
}

// ===========================================================================
// 10. ContextMenu（§31）
// ===========================================================================

export type MenuItem =
  | {
      id: string;
      label: string;
      danger?: boolean;
      disabled?: boolean;
      checked?: boolean;
      /** 禁用原因 / 补充说明（DESIGN_SYSTEM §8：禁用控件不隐藏原因）。 */
      title?: string;
      /** 悬停展开的子菜单（例如"壁纸"）。 */
      submenu?: MenuItem[];
      onSelect: () => void;
    }
  | { separator: true };

type ContextMenuProps = {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  label?: string;
  /**
   * 把菜单**底边**贴在 (x, y) 上方、并水平居中于 x —— 程序坞右键用它，
   * 菜单要浮在 Dock 上方（macOS 的位置），而不是从光标往下展开（会掉出屏幕）。
   */
  anchorAbove?: boolean;
  className?: string;
};

/**
 * 真实菜单：键盘可完整操作。
 *
 *   ArrowDown / ArrowUp  在可选项之间移动（跳过 disabled 与分隔线，且**循环**）
 *   Home / End           首 / 末项
 *   Enter / Space        触发
 *   Escape               关闭并把焦点还给触发者
 *
 * 关闭时把焦点还回去是硬要求：否则用户按 Esc 之后焦点会掉到 body，
 * 键盘用户等于"迷失位置"（这条在 D2-01 登记为 NOT VERIFIED，本轮补上）。
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
  label = "桌面菜单",
  anchorAbove = false,
  className,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  /** 当前展开的子菜单（悬停或键盘触发）。 */
  const [openSub, setOpenSub] = useState<{ id: string; top: number; items: MenuItem[] } | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  /**
   * 用**真实高度**决定位置，再夹进视口。
   *
   * 旧的写法只按 `innerHeight - 150` 估算，菜单比 150px 高时就伸到屏幕外面去了；
   * 更糟的是当时还会 focus 面板本身 —— 焦点移动会把最近的滚动容器滚过去，
   * 而 `.desktop` 是 `overflow: hidden`（仍然允许程序化滚动），
   * 于是整个桌面（含 Dock）被顶上去。这里在 paint 之前一次性算好，不产生第二帧跳动。
   */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    const wantLeft = anchorAbove ? x - r.width / 2 : x;
    const wantTop = anchorAbove ? y - r.height - 12 : y;
    const left = Math.max(pad, Math.min(wantLeft, innerWidth - r.width - pad));
    const top = Math.max(pad, Math.min(wantTop, innerHeight - r.height - pad));
    el.style.left = Math.round(left) + "px";
    el.style.top = Math.round(top) + "px";
  }, [anchorAbove, x, y, items]);

  const selectable = useMemo(
    () => items.map((it, i) => ({ it, i })).filter(({ it }) => !("separator" in it) && !it.disabled).map(({ i }) => i),
    [items],
  );

  useEffect(() => {
    returnTo.current = document.activeElement as HTMLElement;
    // 打开时**不高亮第一项**（macOS 菜单只有悬停/键盘导航时才高亮）。
    // 焦点给面板本身，方向键仍然能从第一项开始走。
    // preventScroll 是硬要求：没有它，贴边打开的菜单会把桌面滚走，Dock 跟着被顶上去。
    ref.current?.focus({ preventScroll: true });
    return () => returnTo.current?.focus?.({ preventScroll: true });
  }, []);

  const move = useCallback(
    (dir: 1 | -1) => {
      const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])") || []);
      if (!nodes.length) return;
      const at = nodes.indexOf(document.activeElement as HTMLElement);
      const next = at < 0 ? (dir > 0 ? 0 : nodes.length - 1) : (at + dir + nodes.length) % nodes.length;
      nodes[next].focus();
    },
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        move(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        move(-1);
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])") || []);
        nodes[e.key === "Home" ? 0 : nodes.length - 1]?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [move, onClose]);

  return (
    <>
      <div className="menu-shade" onPointerDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        className={"context-menu" + (className ? " " + className : "")}
        role="menu"
        tabIndex={-1}
        aria-label={label}
        ref={ref}
        style={{ left: x, top: y }}
      >
        {items.map((it, i) =>
          "separator" in it ? (
            <div className="menu-separator" role="separator" key={`sep-${i}`} />
          ) : (
            <button
              key={it.id}
              role="menuitem"
              data-menu-id={it.id}
              className={it.danger ? "danger" : undefined}
              disabled={it.disabled}
              title={it.title}
              aria-haspopup={it.submenu ? "menu" : undefined}
              onPointerEnter={(e) => {
                if (it.submenu) {
                  setOpenSub({ id: it.id, top: (e.currentTarget as HTMLElement).offsetTop, items: it.submenu });
                } else {
                  setOpenSub(null);
                }
              }}
              onFocus={(e) => {
                if (it.submenu) setOpenSub({ id: it.id, top: (e.currentTarget as HTMLElement).offsetTop, items: it.submenu });
              }}
              onClick={(e) => {
                // 带子菜单的父项：点一下只展开，不关菜单、也不触发动作
                if (it.submenu) {
                  setOpenSub({ id: it.id, top: (e.currentTarget as HTMLElement).offsetTop, items: it.submenu });
                  return;
                }
                it.onSelect();
                onClose();
              }}
            >
              {"checked" in it ? (
                <span className="menu-check" aria-hidden="true">
                  {it.checked ? "✓" : ""}
                </span>
              ) : null}
              {it.label}
              {it.submenu ? (
                <span className="menu-chevron" aria-hidden="true">
                  ›
                </span>
              ) : null}
            </button>
          ),
        )}
        {openSub ? (
          <div className="context-menu context-submenu" role="menu" style={{ top: openSub.top }}>
            {openSub.items.map((it, i) =>
              "separator" in it ? (
                <div className="menu-separator" role="separator" key={`sub-sep-${i}`} />
              ) : (
                <button
                  key={it.id}
                  role="menuitem"
                  data-menu-id={it.id}
                  className={it.danger ? "danger" : undefined}
                  disabled={it.disabled}
                  title={it.title}
                  onClick={() => {
                    it.onSelect();
                    onClose();
                  }}
                >
                  {"checked" in it ? (
                    <span className="menu-check" aria-hidden="true">
                      {it.checked ? "✓" : ""}
                    </span>
                  ) : null}
                  {it.label}
                </button>
              ),
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}
