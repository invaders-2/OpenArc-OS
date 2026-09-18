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
import { ArrowLeft, ArrowRight, Maximize2, Minus, Monitor, RotateCw, X } from "lucide-react";
import domain from "../../electron/window-domain.cjs";
import type { Window as WinDomain, WindowCommand } from "../../electron/window-domain.cjs";
import { LATE_NOTICE } from "../approval/ApprovalPrompt";

const icon = (name: string) => "./icons/" + name + ".png";

// ===========================================================================
// 1-2. TopBar / TrafficBar
// ===========================================================================

type TrafficBarProps = {
  /** 可操作目标；null 表示无聚焦窗口 → 三个按钮全部禁用（§33）。 */
  target: string | null;
  /** 目标窗口是否已最大化。这是**域的投影**，不是第二份状态（§33）。 */
  maximized: boolean;
  onCommand: (c: WindowCommand) => void;
};

/**
 * 顶栏红绿灯。**只操作 focusedWindowId，不维护第二份 active state** ——
 * "谁被聚焦"这个问题只问 Window Manager 一次。
 *
 * 最大化是**切换**而不是单向：只看 `maximized` 这个投影决定派发哪条命令。
 * 否则 `window/unmaximize` 这条冻结命令在 UI 上不可达，
 * 用户一旦双击放大就再也回不到原尺寸（D2-02B 审出的真实缺陷）。
 */
export function TrafficBar({ target, maximized, onCommand }: TrafficBarProps) {
  // 还原不需要 host：restore 快照在最大化时就已按当时的工作区收拢过，
  // 之后宿主尺寸变化由 system/reflow 继续维护它（§24 同一条 clamp 路径）。
  const toggleMax = (id: string) =>
    onCommand(maximized ? { type: "window/unmaximize", id } : { type: "window/maximize", id, host: host() });
  return (
    <div className="traffic traffic-bar" aria-label="当前窗口控制">
      <button
        className="close"
        aria-label="关闭当前窗口"
        disabled={!target}
        onClick={() => target && onCommand({ type: "window/close", id: target })}
      >
        <X size={8} />
      </button>
      <button
        className="minimize"
        aria-label="最小化当前窗口"
        disabled={!target}
        onClick={() => target && onCommand({ type: "window/minimize", id: target })}
      >
        <Minus size={8} />
      </button>
      <button
        className="maximize"
        aria-label={maximized ? "还原当前窗口" : "最大化当前窗口"}
        disabled={!target}
        onClick={() => target && toggleMax(target)}
      >
        <Maximize2 size={7} />
      </button>
    </div>
  );
}

const host = () => ({ width: innerWidth, height: innerHeight });

type TopBarProps = {
  activeTitle: string;
  focusedId: string | null;
  /** focusedId 对应窗口是否已最大化。同样是域的投影，不是第二份状态。 */
  focusedMaximized: boolean;
  /** 搜索是否打开。只用来表达 aria-expanded，因此是 boolean 而不是查询串 ——
      需要查询串的地方是搜索面板，不是顶栏。 */
  searchOpen: boolean;
  onCommand: (c: WindowCommand) => void;
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
  activeTitle,
  focusedId,
  focusedMaximized,
  searchOpen,
  onCommand,
  onToggleSearch,
  onToggleAI,
  identity,
}: TopBarProps) {
  return (
    <header className="topbar">
      <TrafficBar target={focusedId} maximized={focusedMaximized} onCommand={onCommand} />
      <strong className="wordmark">◈ OpenArc</strong>
      <span>{activeTitle}</span>
      <div className="topbar-right">
        <span className="local-tag">
          <Monitor size={13} /> 本机 · D1
        </span>
        <button onClick={onToggleSearch} aria-label="全局搜索" aria-expanded={searchOpen}>
          <img className="bar-icon" src={icon("spotlight")} alt="" />
        </button>
        <button onClick={onToggleAI} aria-label="全局 AI">
          <img className="bar-icon" src={icon("siri")} alt="" />
        </button>
        {identity ? (
          <>
            <button
              onClick={identity.onLock}
              disabled={identity.locked}
              aria-label="锁定屏幕"
              data-d3-id="topbar-lock"
            >
              锁定
            </button>
            <button onClick={identity.onLogout} aria-label="退出登录" data-d3-id="topbar-logout">
              {identity.displayName || "退出"}
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
  title: string;
  /** 是否已最大化 —— 决定"最大化"按钮与双击是放大还是还原。 */
  maximized: boolean;
  onCommand: (c: WindowCommand) => void;
  onDragStart: (e: React.PointerEvent) => void;
};

export function TitleBar({ id, title, maximized, onCommand, onDragStart }: TitleBarProps) {
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
          <Maximize2 size={9} />
        </button>
      </div>
      <strong>{title}</strong>
      <span className="title-meta">OpenArc</span>
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
        title={w.meta.title}
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

/** backend authoritative terminal 状态：到达其中一个就必须复位 UI busy 合同。 */
const TASK_TERMINAL = ["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"];

/** D4 收口：失败 Verification 证据的可读投影（只展示 safe 字段）。 */
function formatVerificationEvidence(v: any): string {
  const fmt = (x: unknown) => (x == null ? "—" : typeof x === "string" ? x : JSON.stringify(x));
  const body = "检查方法：" + String(v.method || v.type || "UNKNOWN") + " · 预期：" + fmt(v.expected) + " · 实际：" + fmt(v.actual);
  return body.length > 400 ? body.slice(0, 400) + "…" : body;
}

/** D4 收口：被拒 WRITE 操作的目标可读投影（只展示后端 safe arguments）。 */
function formatDeniedTarget(args: any): string {
  if (!args || typeof args !== "object") return "—";
  const ref = args.resourceRef || (Array.isArray(args.resourceRefs) ? args.resourceRefs[0] : null);
  if (ref) return String(ref);
  try { const body = JSON.stringify(args); return body.length > 200 ? body.slice(0, 200) + "…" : body; } catch { return "—"; }
}

/** D4 Main-Entry Closure-6：appendReason 是后端机器码，只能做可读投影；原始码绝不进可见文本（gate 会把它当成"页面显示了成功"）。 */
const APPEND_REASON_TEXT: Record<string, string> = {
  APPEND_NOT_SUCCEEDED: "当前任务状态不支持追加步骤",
  APPEND_NO_ARTIFACT: "任务还没有可用产物，暂不能追加步骤",
  APPEND_IN_FLIGHT: "任务仍在运行中，暂不能追加步骤",
  APPEND_SIDE_EFFECT_PENDING: "存在待处理的副作用，暂不能追加步骤",
  APPEND_UNKNOWN_EFFECT: "存在结果未知的副作用，暂不能追加步骤",
  APPEND_ACTIVE_LEASE: "存在未释放的执行租约，暂不能追加步骤",
  APPEND_EFFECT_STATE_UNAVAILABLE: "副作用状态不可用，暂不能追加步骤",
};

function formatAppendReason(reason: string | null): string {
  if (!reason) return "当前任务暂不支持追加步骤";
  return APPEND_REASON_TEXT[reason] || "当前任务暂不支持追加步骤";
}

/** D4 Main-Entry Closure-6：step 目标的可读投影。被追加 step 的真实输入在 input.goal；初始 step 没有 input。 */
function formatStepGoal(step: any): string {
  const input = step ? step.input : null;
  if (input == null) return "初始步骤";
  const goal = typeof input.goal === "string" ? input.goal : "";
  return goal || "—";
}

/** 后端 listPending.revocable 的安全投影：已批准、尚未开始执行的 call。 */
type RevocableSideEffect = {
  approvalRequestId: string;
  status?: string;
  toolId?: string;
  toolDisplayName?: string;
  targetDisplayName?: string | null;
  resourceRef?: string | null;
};

type SideEffectBridge = {
  command: (command: Record<string, unknown>) => Promise<Record<string, unknown>>;
  revokeApproval?: (input: { approvalRequestId: string }) => Promise<Record<string, unknown>>;
};

const sideEffectBridge = (): SideEffectBridge | null => {
  const w = window as unknown as { openarc?: { sideEffect?: SideEffectBridge } };
  return (w.openarc && w.openarc.sideEffect) || null;
};

/** 撤销失败一律给人话；机器码只进 data 属性，绝不显示给用户。 */
const REVOKE_ERROR_TEXT: Record<string, string> = {
  SIDE_EFFECT_APPROVAL_TOO_LATE: LATE_NOTICE,
  SIDE_EFFECT_APPROVAL_FORBIDDEN: "你没有撤销该操作的权限。",
  SIDE_EFFECT_APPROVAL_REQUIRED: "该操作已不在可撤销状态。",
  SIDE_EFFECT_CALL_NOT_FOUND: "该操作已不在可撤销状态。",
  SIDE_EFFECT_TASK_NOT_FOUND: "该操作所属的任务已不存在。",
};
const REVOKE_FALLBACK_TEXT = "撤销未生效，请稍后重试。";

type AIPanelProps = { onClose: () => void; onOpenSettings: () => void };
/**
 * D4-04：全局 AI 助手 = 真实 Task Runtime 入口。
 *
 * 它只经窄桥 window.openarc.task.command 发起任务；Renderer 不能指定 userId / role /
 * appId / sessionRef / modelConfig / verification —— 那些由主进程从 authenticated session
 * 与真实 Task Runtime 推导。工具调用仍由受控 Tool Proxy 执行。
 */
export function AIPanel({ onClose, onOpenSettings }: AIPanelProps) {
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
  // D4 收口：被后端拒绝且尚未完成的明确 WRITE 操作（来源 task/get，renderer 不自报）。
  const [deniedOperations, setDeniedOperations] = useState<any[]>([]);
  // D4 Main-Entry Closure-6：对同一个已成功任务追加下一步目标。appendable / appendReason / steps 一律以后端 task/get 为准。
  const [appendGoal, setAppendGoal] = useState("");
  const [appendable, setAppendable] = useState(false);
  const [appendReason, setAppendReason] = useState<string | null>(null);
  const [steps, setSteps] = useState<any[]>([]);
  // D4-03 Closure：已批准、尚未执行的操作（撤销入口）。可见性只能来自后端 listPending.revocable。
  const [revocable, setRevocable] = useState<RevocableSideEffect[]>([]);
  const [revokeResult, setRevokeResult] = useState<{ approvalRequestId: string; text: string; code: string } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

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
    setDeniedOperations(Array.isArray(got.deniedOperations) ? got.deniedOperations : []);
    if (Array.isArray(got.steps)) setSteps(got.steps);
    setAppendable(got.appendable === true);
    setAppendReason(got.appendReason || null);
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

  /** 撤销块不缓存任何判断：每次（含页面刷新后）都从后端权威状态重建。 */
  const refreshRevocable = useCallback(async () => {
    const b = sideEffectBridge();
    if (!b || typeof b.command !== "function") return;
    try {
      const res = await b.command({ type: "sideEffect/listPending" });
      if (res && res.ok === true) setRevocable(Array.isArray(res.revocable) ? (res.revocable as RevocableSideEffect[]) : []);
    } catch { /* 下一轮再试 */ }
  }, []);

  useEffect(() => {
    void refreshRevocable();
    const timer = window.setInterval(() => { void refreshRevocable(); }, 2000);
    return () => window.clearInterval(timer);
  }, [refreshRevocable]);

  /** 撤销成功与否都以刷新后的后端状态为准；失败原因只用人话，机器码只进属性。 */
  const revokeSideEffect = async (approvalRequestId: string) => {
    if (!approvalRequestId || revoking) return;
    const b = sideEffectBridge();
    if (!b || typeof b.command !== "function") return;
    setRevoking(approvalRequestId);
    setRevokeResult(null);
    try {
      const res = typeof b.revokeApproval === "function"
        ? await b.revokeApproval({ approvalRequestId })
        : await b.command({ type: "sideEffect/revokeApproval", approvalRequestId });
      const code = res && typeof res.error === "string" ? res.error : "";
      if (!res || res.ok !== true) setRevokeResult({ approvalRequestId, code, text: REVOKE_ERROR_TEXT[code] || REVOKE_FALLBACK_TEXT });
    } catch {
      setRevokeResult({ approvalRequestId, code: "", text: REVOKE_FALLBACK_TEXT });
    } finally {
      setRevoking(null);
      await refreshRevocable();
      const tb = (window as unknown as { openarc?: { task?: { command?: (c: unknown) => Promise<any> } } }).openarc?.task;
      if (taskId && tb && typeof tb.command === "function") {
        try { const got = await tb.command({ type: "task/get", taskId }); if (got && got.ok) applyTaskState(got); } catch { /* 下一轮轮询再收敛 */ }
      }
    }
  };

  const run = async () => {
    const bridge = (window as unknown as { openarc?: { task?: { command?: (c: unknown) => Promise<{ ok?: boolean; taskId?: string; error?: string }> } } }).openarc?.task;
    if (!bridge || typeof bridge.command !== "function" || busy || !goal.trim()) return;
    setBusy(true); setStatus("running"); setResult(""); setError("");
    const res = await bridge.command({ type: "task/run", goal });
    if (res && res.ok) {
      setTaskId(res.taskId || null); setStatus("running");
      // 新任务的 revision / 追加资格只能由随后的 task/get 给出，避免拿旧值去 appendStep。
      setRevision(null); setAppendable(false); setAppendReason(null); setSteps([]); setAppendGoal("");
    }
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
  // D4 Main-Entry Closure-6：追加下一步目标。进度与终态仍由 task/result 推送，与 run/resume 同一收敛方式。
  const appendStep = async () => {
    const bridge = (window as unknown as { openarc?: { task?: { command?: (c: unknown) => Promise<{ ok?: boolean; error?: string }> } } }).openarc?.task;
    if (!bridge || typeof bridge.command !== "function" || !taskId || busy || !appendGoal.trim()) return;
    setBusy(true); setError("");
    const res = await bridge.command({ type: "task/appendStep", taskId, goal: appendGoal, expectedRevision: revision });
    if (!res || !res.ok) { setBusy(false); setError((res && res.error) || "APPEND_REJECTED"); return; }
    setAppendGoal("");
    // 立即刷新一次，让新 step 出现在历史里；busy 保持到该 step 的 task/result 到达。
    try {
      const got = await bridge.command({ type: "task/get", taskId });
      if (got && got.ok) applyTaskState(got);
    } catch { /* task/result 到达时仍会收敛 */ }
    // 刷新可能读到追加前的旧终态而提前复位 busy；本轮只能由 task/result 收敛
    //（若后端确实已终态，下一次 task/get 轮询会在 1s 内复位）。
    setBusy(true);
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
  const orderedSteps = useMemo(
    () => [...steps].sort((a: any, b: any) => (Number(a && a.sequence) || 0) - (Number(b && b.sequence) || 0)),
    [steps],
  );

  return (
    <aside className="ai-panel" aria-label="AI 助手" data-ai-status={status} data-ai-task-id={taskId || ""}>
      <div className="panel-heading">
        <img className="heading-icon" src={icon("siri")} alt="" />
        <strong>全局 AI 助手</strong>
        <button aria-label="关闭AI面板" onClick={onClose}>
          <X size={19} />
        </button>
      </div>
      <div className="ai-intro">
        <img className="ai-orb" src={icon("siri")} alt="" draggable={false} />
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
        <span data-ai-status-text>{status === "BLOCKED" ? (resumable ? "BLOCKED · Budget Exhausted" : deniedOperations.length ? "BLOCKED · Operation Denied" : "BLOCKED · Recovery Required") : status}</span>
        {error ? <span data-ai-error> · {error}</span> : null}
      </div>
      {taskId && appendable ? (
        <div className="ai-append" data-ai-append-block>
          <textarea
            data-ai-append-goal
            aria-label="下一步目标"
            placeholder="下一步目标…"
            value={appendGoal}
            onChange={(e) => setAppendGoal(e.target.value)}
          />
          <button data-ai-append onClick={appendStep} disabled={busy || !appendGoal.trim()}>
            追加步骤
          </button>
        </div>
      ) : null}
      {taskId && !appendable && !busy && TASK_TERMINAL.includes(status) ? (
        <div className="ai-append ai-append-blocked" data-ai-append-blocked>
          {/* 可见文本一律人话；机器码只进属性，后端 task/get.appendReason 仍是权威 */}
          <p data-ai-append-reason data-ai-append-reason-code={appendReason || ""}>
            {formatAppendReason(appendReason)}
          </p>
        </div>
      ) : null}
      {taskId && orderedSteps.length ? (
        <div className="ai-steps" data-ai-steps>
          {orderedSteps.map((step: any) => {
            const sequence = step && step.sequence != null ? String(step.sequence) : "";
            const appended = !!(step && step.input && step.input.appended === true);
            return (
              <div
                className="ai-step"
                key={(step && step.stepId) || sequence}
                data-ai-step={sequence}
                data-ai-step-status={(step && step.status) || "UNKNOWN"}
                data-ai-step-appended={appended ? "true" : undefined}
              >
                <p>
                  #{sequence} · {step && step.kind ? step.kind : "STEP"} · {step && step.status ? step.status : "UNKNOWN"}
                </p>
                <p>{formatStepGoal(step)}</p>
              </div>
            );
          })}
        </div>
      ) : null}
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
      {status === "BLOCKED" && deniedOperations.length ? (
        <div className="ai-denied" data-ai-denied>
          <p data-ai-denied-title>尚未完成的操作（后端已拒绝）</p>
          {deniedOperations.map((op: any) => (
            <div key={op.proposalId} data-ai-denied-item={op.proposalId}>
              <p data-ai-denied-tool>工具：{op.toolId}</p>
              <p data-ai-denied-target>目标：{formatDeniedTarget(op.arguments)}</p>
              <p data-ai-denied-reason>拒绝原因：{op.reasonCode || "DENIED"}</p>
            </div>
          ))}
          <p data-ai-denied-note>该操作未执行，不会自动重试。</p>
        </div>
      ) : null}
      {/* D4-03 Closure：已批准、尚未执行 —— 只在后端 revocable 里存在时渲染；撤销能力由后端判定。 */}
      {revocable.length ? (
        <div className="ai-revoke" data-ai-revoke-block>
          {revocable.map((r) => (
            <div className="ai-revoke-item" key={r.approvalRequestId} data-ai-revoke-request={r.approvalRequestId}>
              <p data-ai-revoke-tool>工具：{r.toolDisplayName || r.toolId || "受控工具"}</p>
              <p data-ai-revoke-target>目标：{r.targetDisplayName || r.resourceRef || "未命名资源"}</p>
              <p data-ai-revoke-meaning>该操作已批准但还没开始执行；撤销后本次不会执行，旧批准作废。</p>
              <button data-ai-revoke onClick={() => void revokeSideEffect(r.approvalRequestId)} disabled={revoking === r.approvalRequestId}>
                撤销这次操作
              </button>
              {revokeResult && revokeResult.approvalRequestId === r.approvalRequestId ? (
                <p data-ai-revoke-reason data-ai-revoke-reason-code={revokeResult.code}>{revokeResult.text}</p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {/* 迟到提示必须活过撤销块的消失：放在块外的提示区。 */}
      {revokeResult && revokeResult.code === "SIDE_EFFECT_APPROVAL_TOO_LATE" ? (
        <p className="ai-notice" role="status" data-ai-notice data-ai-notice-code={revokeResult.code}>{revokeResult.text}</p>
      ) : null}
      <div className="ai-result" data-ai-result>
        {result}
      </div>
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
