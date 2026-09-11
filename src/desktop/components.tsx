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
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Sparkles,
  X,
} from "lucide-react";
import domain from "../../electron/window-domain.cjs";
import type { Window as WinDomain, WindowCommand } from "../../electron/window-domain.cjs";

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
  identity,
}: TopBarProps) {
  return (
    <header className="topbar">
      <strong className="wordmark">◈ OpenArc</strong>
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
          <Sparkles size={15} />
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
  label: string;
  iconName: string;
  /** 该 App 是否有存活窗口（§32：按 appId 查询，而不是按 windowId）。 */
  running: boolean;
  bouncing: boolean;
  onActivate: () => void;
};

export function DockItem({ label, iconName, running, bouncing, onActivate }: DockItemProps) {
  return (
    <button
      className={`dock-item ${bouncing ? "bouncing" : ""}`}
      aria-label={`打开${label}`}
      onClick={onActivate}
    >
      <img className="dock-icon" src={icon(iconName)} alt="" draggable={false} />
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
  dockRef: React.RefObject<HTMLElement | null>;
  /**
   * 激活一个 App。**Dock 不自己决定要派发哪条窗口命令** ——
   * "聚焦已有窗口 / 恢复最小化的窗口 / 新建"这个判断需要看 `appId → windowIds[]`，
   * 属于窗口状态，只有持有 Window Manager 的那一层才做得对（§32 / §33）。
   */
  onActivate: (appId: string) => void;
  onToggleAI: () => void;
};

export function Dock({ apps, runningApps, bouncing, dockRef, onActivate, onToggleAI }: DockProps) {
  return (
    <nav className="dock" aria-label="应用栏" ref={dockRef}>
      {apps.map((a) => (
        <DockItem
          key={a.id}
          label={a.name}
          iconName={a.icon}
          running={runningApps.has(a.id)}
          bouncing={bouncing === a.id}
          onActivate={() => onActivate(a.id)}
        />
      ))}
      <div className="dock-divider" />
      <DockItem label="全局 AI" iconName="siri" running={false} bouncing={bouncing === "__ai"} onActivate={onToggleAI} />
    </nav>
  );
}

// ===========================================================================
// 6-7. Window / TitleBar
// ===========================================================================

type TitleBarProps = {
  id: string;
  /** 是否已最大化 —— 决定"最大化"按钮与双击是放大还是还原。 */
  maximized: boolean;
  onCommand: (c: WindowCommand) => void;
  onDragStart: (e: React.PointerEvent) => void;
};

export function TitleBar({ id, maximized, onCommand, onDragStart }: TitleBarProps) {
  // 双向切换：双击/按钮在"放大"与"还原"之间切。只发 maximize 会让
  // window/unmaximize 成为不可达命令，用户放大后无法恢复（D2-02B 审出的缺陷）。
  const toggleMax = () =>
    onCommand(maximized ? { type: "window/unmaximize", id } : { type: "window/maximize", id, host: host() });
  return (
    <div className="window-title" onPointerDown={onDragStart} onDoubleClick={toggleMax}>
      <div className="traffic">
        <button className="close" aria-label={`关闭${id}`} onClick={() => onCommand({ type: "window/close", id })}>
          <X size={10} />
        </button>
        <button className="minimize" aria-label={`最小化${id}`} onClick={() => onCommand({ type: "window/minimize", id })}>
          <Minus size={10} />
        </button>
        <button className="maximize" aria-label={`${maximized ? "还原" : "最大化"}${id}`} onClick={toggleMax}>
          {/* macOS 原生绿色按钮的"双三角"缩放符号，而不是对角箭头 */}
          <svg width="7" height="7" viewBox="0 0 10 10" aria-hidden="true">
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
  return (
    <section
      aria-label={`${w.meta.title}窗口`}
      className={`window ${focused ? "active" : ""} ${w.visible ? "" : "minimized"}`}
      style={{ left: w.bounds.x, top: w.bounds.y, width: w.bounds.w, height: w.bounds.h, zIndex: 10 + w.z }}
      onPointerDown={() => !focused && onCommand({ type: "window/focus", id: w.id })}
    >
      <TitleBar
        id={w.id}
        maximized={w.state === domain.WSTATE.MAXIMIZED}
        onCommand={onCommand}
        onDragStart={(e) => startDrag(e, w, onCommand)}
      />
      <div className="window-body">{children}</div>
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
function startDrag(e: React.PointerEvent, w: WinDomain, onCommand: (c: WindowCommand) => void) {
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
  error?: string;
  children?: React.ReactNode;
};

/**
 * **不接受任何 Electron 对象。** 它不知道 WebContentsView 的存在，
 * 只知道"这块区域有没有被原生内容填上"，用来决定占位文案。
 * 几何锚点也不是它自己量的 —— 视口矩形由 domain 的 bounds 推出。
 */
export function WebViewport({ nativeVisible, error, children }: WebViewportProps) {
  return (
    <div className="web-viewport">
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

type AssistantPillProps = { onActivate: () => void };
export function AssistantPill({ onActivate }: AssistantPillProps) {
  return (
    <button className="assistant-pill" onClick={onActivate}>
      <img className="pill-icon" src={icon("siri")} alt="" />
      <span>全局 AI</span>
      <span className="pill-status">未连接</span>
    </button>
  );
}

type AIPanelProps = { onClose: () => void; onOpenSettings: () => void };
export function AIPanel({ onClose, onOpenSettings }: AIPanelProps) {
  const [note, setNote] = useState("");
  return (
    <aside className="ai-panel" aria-label="AI 助手">
      <div className="panel-heading">
        <img className="heading-icon" src={icon("siri")} alt="" />
        <strong>全局 AI 助手</strong>
        <button aria-label="关闭AI面板" onClick={onClose}>
          <X size={19} />
        </button>
      </div>
      <div className="ai-intro">
        <img className="ai-orb" src={icon("siri")} alt="" draggable={false} />
        <h2>从一个想法开始</h2>
        <p>连接模型与工具后，AI 将在授权范围内协调你的应用。</p>
      </div>
      <div className="connection-card">
        <span className="badge">后端未接入</span>
        <h3>准备你的全局助手</h3>
        <p>DeepSeek Harness 正在验证。当前不会发送消息或执行任务。</p>
        <button onClick={onOpenSettings}>
          查看统一设置 <ArrowRight size={15} />
        </button>
      </div>
      <div className="composer">
        <textarea aria-label="任务草稿" placeholder="先记下你想完成的工作…" value={note} onChange={(e) => setNote(e.target.value)} />
        <span>仅本次会话草稿 · 未发送</span>
      </div>
    </aside>
  );
}

// ===========================================================================
// 10. ContextMenu（§31）
// ===========================================================================

export type MenuItem =
  | { id: string; label: string; danger?: boolean; disabled?: boolean; onSelect: () => void }
  | { separator: true };

type ContextMenuProps = {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  label?: string;
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
export function ContextMenu({ x, y, items, onClose, label = "桌面菜单" }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  const selectable = useMemo(
    () => items.map((it, i) => ({ it, i })).filter(({ it }) => !("separator" in it) && !it.disabled).map(({ i }) => i),
    [items],
  );

  useEffect(() => {
    returnTo.current = document.activeElement as HTMLElement;
    const first = selectable[0];
    if (first !== undefined) ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]")[0]?.focus();
    return () => returnTo.current?.focus?.();
  }, [selectable]);

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
        className="context-menu"
        role="menu"
        aria-label={label}
        ref={ref}
        style={{ left: Math.min(x, innerWidth - 190), top: Math.min(y, innerHeight - 150) }}
      >
        {items.map((it, i) =>
          "separator" in it ? (
            <div className="menu-separator" role="separator" key={`sep-${i}`} />
          ) : (
            <button
              key={it.id}
              role="menuitem"
              className={it.danger ? "danger" : undefined}
              disabled={it.disabled}
              onClick={() => {
                it.onSelect();
                onClose();
              }}
            >
              {it.label}
            </button>
          ),
        )}
      </div>
    </>
  );
}
