import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpDown,
  Bot,
  Clock,
  Folder,
  LayoutGrid,
  List,
  Lock,
  LogOut,
  Monitor,
  Package,
  Search,
  Share,
  Sliders,
  Store,
  Tag,
  User,
  Wand2,
} from "lucide-react";
// Token 层必须先于组件层导入：tokens.css 只声明自定义属性与 base reset，
// styles.css 全部是消费方。顺序颠倒会让组件拿到未定义的 var()。
import "./design-system/tokens.css";
import "./styles.css";
import domain from "../electron/window-domain.cjs";
import type { WindowCommand } from "../electron/window-domain.cjs";
import { useDesktop } from "./desktop/useDesktop";
// 别名导入：本模块里有 `declare global { interface Window }`，
// 直接叫 Window 会在类型位置与全局 Window 撞名。
import {
  AIPanel,
  AddressBar,
  AssistantPill,
  ContextMenu,
  Dock,
  TopBar,
  WebViewport,
  Window as DesktopWindow,
  startResize,
} from "./desktop/components";
import type { MenuItem } from "./desktop/components";
import { Dialog } from "./desktop/Dialog";
import { useIdentity } from "./identity/useIdentity";
import { BootSurface, LockScreen, LoginScreen, SetupScreen } from "./identity/AuthScreens";

type DisplayInfo = {
  id: number;
  scaleFactor: number;
  workArea: { x: number; y: number; width: number; height: number };
  internal: boolean;
  primary: boolean;
};
declare global {
  interface Window {
    openarc?: {
      sync: (p: unknown) => Promise<{ ok?: boolean; error?: string; results?: unknown[] }>;
      navigate: (windowId: string, url: string) => Promise<{ error?: string; ok?: boolean }>;
      action: (windowId: string, action: string) => Promise<{ error?: string; ok?: boolean }>;
      onNativeState: (cb: (e: Record<string, string>) => void) => () => void;
      onDisplay: (cb: (d: DisplayInfo[]) => void) => () => void;
      identity?: {
        command: (cmd: Record<string, unknown>) => Promise<Record<string, unknown>>;
        onEvent: (cb: (e: { event: string; snapshot?: unknown }) => void) => () => void;
      };
    };
  }
}

// D1-04B 玻璃材质档位：单值三态。full = 完整玻璃，reduced = 降合成成本，
// solid = 关闭 backdrop-filter 走实色（原"减少透明度"）。
// 与 reduce motion 完全解耦：减少动效不改变材质，降低材质不关动画。
type GlassMode = "full" | "reduced" | "solid";
type Folder = { id: string; name: string; x: number; y: number };

const FOLDER_PREFIX = domain.FOLDER_PREFIX;
const icon = (name: string) => "./icons/" + name + ".png";
const apps = [
  { id: "home", name: "应用中心", icon: "apps" },
  { id: "browser", name: "浏览器", icon: "safari" },
  { id: "files", name: "文件", icon: "finder" },
  { id: "canvas", name: "无限画布", icon: "freeform" },
  { id: "skills", name: "Skill 中心", icon: "shortcuts" },
  { id: "settings", name: "系统设置", icon: "settings" },
] as const;

/** 胶囊开关（role=switch）：设置页与控制中心共用，受控、无内部状态。 */
function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="setting-row">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className="switch"
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

/** 文件夹窗口的浏览状态（按 windowId 存）：当前文件夹 / 查看方式 / 搜索 / 排序 / 前进后退历史。
 *  这些是**窗口内的浏览状态**，不进窗口域 —— 窗口域只管窗口本身。 */
type FolderUI = {
  folderId: string;
  view: "grid" | "list";
  query: string;
  sort: "name" | "date" | "size";
  group: boolean;
  history: string[];
  at: number;
};

function App() {
  const identity = useIdentity();
  /**
   * 锁定时整块原生视图必须让位（§15 / §40）—— 这是唯一能盖住 WebContentsView 的机制，
   * DOM z-index 对它无效，因此 lock 必须一路传到主进程的 overlayOpen。
   */
  const locked = identity.phase === "locked";
  const { state, dispatch, overlays, setOverlays, snapshotLayers, nativeVisibleOf, browserEvents, clearBrowserEvent } =
    useDesktop({ locked });

  // ---------------------------------------------------------------------------
  // 桌面对象（文件夹）仍是独立的一类状态：它们不是窗口，不进 Window Manager。
  // ---------------------------------------------------------------------------
  const [folders, setFolders] = useState<Folder[]>(() => {
    try {
      const raw = localStorage.getItem("oa-folders");
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [bouncing, setBouncing] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; folder?: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const dockRef = useRef<HTMLElement>(null);
  const searchPanel = useRef<HTMLDivElement>(null);
  const searchTrigger = useRef<HTMLElement | null>(null);
  /** 右键菜单的来源元素。对话框关闭后焦点要回到它 —— 菜单本身届时已卸载。 */
  const menuTrigger = useRef<HTMLElement | null>(null);

  const [reduced, setReduced] = useState(() => localStorage.getItem("oa-motion") === "true");
  const [glass, setGlass] = useState<GlassMode>(() => {
    const v = localStorage.getItem("oa-glass");
    if (v === "full" || v === "reduced" || v === "solid") return v;
    return localStorage.getItem("oa-opaque") === "true" ? "solid" : "full";
  });
  const [dark, setDark] = useState(() => localStorage.getItem("oa-dark") === "true");
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  /** 左右分栏的当前页（设置 / 应用中心 / Skill 中心各一份，互不影响）。 */
  const [settingsTab, setSettingsTab] = useState<"appearance" | "model">("appearance");
  const [appTab, setAppTab] = useState<"all" | "pro" | "recent">("all");
  const [skillTab, setSkillTab] = useState<"market" | "mine" | "installed">("market");
  const [folderUI, setFolderUI] = useState<Record<string, FolderUI>>({});
  const [paneMenu, setPaneMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  /**
   * 唯一的命令入口。**组件与未来的 AI 都只能经由它改窗口状态**（§20 / §21）。
   * 这里只是一层 dispatch 转发，没有任何"顺手也改一下"的旁路。
   */
  const onCommand = (c: WindowCommand) => dispatch(c);

  const folderOf = (id: string) =>
    id.startsWith(FOLDER_PREFIX) ? folders.find((f) => f.id === id.slice(FOLDER_PREFIX.length)) : undefined;
  const titleOf = (id: string) => domain.byId(state, id)?.meta.title || folderOf(id)?.name || id;
  const iconOf = (id: string) => domain.byId(state, id)?.meta.icon || (folderOf(id) ? "folder" : "apps");

  const bounce = (id: string) => {
    if (reduced) return;
    setBouncing(id);
    window.setTimeout(() => setBouncing((cur) => (cur === id ? null : cur)), 760);
  };

  /**
   * 启动 / 唤起到前台一个 App。
   *
   * macOS 习惯：**点 Dock 图标 = 聚焦该 App 最近的窗口**，全部最小化时先恢复它，
   * 只有该 App 一个窗口都没有时才新建。这不是额外功能，而是 §32 的直接后果 ——
   * Dock 消费的是 `appId → windowIds[]`，不是"一个 App 一个窗口"。
   *
   * 早先的实现只派发 `window/open`（按 id 幂等）：当窗口 id ≠ appId 时
   * （例如两个浏览器窗口 browser-a / browser-b），点 Dock 既恢复不了最小化的窗口，
   * 还会因为 id 对不上而多开一个 —— 双浏览器探针抓到的真实缺陷。
   */
  const activateApp = (appId: string) => {
    setOverlays((o) => ({ ...o, search: false }));
    bounce(appId);
    const mine = domain.windowsOfApp(state, appId);
    // order 是自底向上的唯一真值，因此"最近的窗口"就是末尾那个
    const visibleId = [...mine].reverse().find((id) => domain.byId(state, id)?.state !== domain.WSTATE.MINIMIZED);
    const topId = mine[mine.length - 1];
    if (visibleId) {
      onCommand({ type: "window/focus", id: visibleId });
      return;
    }
    if (topId) {
      onCommand({ type: "window/restore", id: topId });
      return;
    }
    const app = apps.find((a) => a.id === appId);
    onCommand({ type: "window/open", appId, meta: { title: app?.name || appId, icon: app?.icon || "apps" } });
  };

  const openFolder = (f: Folder) => {
    setMenu(null);
    const id = FOLDER_PREFIX + f.id;
    onCommand({ type: "window/open", appId: id, meta: { title: f.name, icon: "folder" } });
  };

  // ---------------------------------------------------------------------------
  // 副作用：主题 / 桌面对象持久化
  // ---------------------------------------------------------------------------
  useEffect(() => {
    for (const [k, v] of [
      ["motion", reduced],
      ["glass", glass],
      ["dark", dark],
    ])
      localStorage.setItem("oa-" + k, String(v));
  }, [reduced, glass, dark]);
  useEffect(() => {
    localStorage.setItem("oa-folders", JSON.stringify(folders));
  }, [folders]);

  // Dock 波浪放大（纯视觉，与窗口状态无关）
  useEffect(() => {
    const dock = dockRef.current;
    if (!dock) return;
    const items = Array.from(dock.querySelectorAll<HTMLElement>(".dock-item"));
    const RANGE = 135;
    const reset = () => items.forEach((el) => el.style.setProperty("--s", "1"));
    if (reduced) {
      reset();
      return;
    }
    const apply = (x: number) =>
      items.forEach((el) => {
        const r = el.getBoundingClientRect();
        const distance = Math.abs(r.left + r.width / 2 - x);
        const t = Math.max(0, 1 - distance / RANGE);
        el.style.setProperty("--s", (1 + 0.62 * t * t * (3 - 2 * t)).toFixed(3));
      });
    const move = (e: PointerEvent) => apply(e.clientX);
    dock.addEventListener("pointermove", move);
    dock.addEventListener("pointerleave", reset);
    return () => {
      dock.removeEventListener("pointermove", move);
      dock.removeEventListener("pointerleave", reset);
      reset();
    };
  }, [reduced]);

  // 搜索面板的焦点进出（焦点陷阱由 Dialog 原语承担；这里是搜索自己的开关语义）
  useEffect(() => {
    if (overlays.search) {
      searchTrigger.current = document.activeElement as HTMLElement;
      searchPanel.current?.querySelector("input")?.focus();
    } else {
      searchTrigger.current?.focus?.();
    }
  }, [overlays.search]);

  // 全局快捷键。Esc 只关闭**覆盖层**，不碰窗口 —— 窗口关闭是显式命令。
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOverlays((o) => ({ ...o, search: !o.search }));
      }
      if (e.key === "Escape") {
        setOverlays((o) => ({ ...o, search: false, ai: false, control: false }));
        setMenu(null);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [setOverlays]);

  const runningApps = useMemo(() => new Set(state.windows.map((w) => w.appId)), [state.windows]);

  /**
   * 浏览器原生视图此刻是否真的可见 —— 文案与占位必须与它一致，否则界面在撒谎。
   * 必须按 **windowId** 查（不是写死 "browser"）：同一 App 可以开多个窗口（§12），
   * 写死的话第二个浏览器窗口会显示第一个的可见性。
   */
  const browserVisibleOf = (id: string) => nativeVisibleOf(id);

  // ---------------------------------------------------------------------------
  // 各 App 的内容。浏览器窗口通过 AddressBar / WebViewport 消费原生视图状态。
  // ---------------------------------------------------------------------------
  const content = (id: string) => {
    const w = domain.byId(state, id);
    const folder = folderOf(id);
    if (folder) {
      const ui: FolderUI =
        folderUI[id] ?? {
          folderId: folder.id,
          view: "grid",
          query: "",
          sort: "name",
          group: true,
          history: [folder.id],
          at: 0,
        };
      const patch = (p: Partial<FolderUI>) => setFolderUI((m) => ({ ...m, [id]: { ...ui, ...p } }));
      /** 同一窗口内切换文件夹（不新建窗口）：历史栈支持前进/后退。 */
      const go = (fid: string) => {
        if (fid === ui.folderId) return;
        const history = [...ui.history.slice(0, ui.at + 1), fid];
        patch({ folderId: fid, history, at: history.length - 1, query: "" });
      };
      const shown = folders.find((f) => f.id === ui.folderId) ?? folder;
      /**
       * 文件服务（D3-04）接入前文件夹里没有真实条目，因此条目集恒为空。
       * 搜索 / 排序的**代码路径是真实的**，只是当前没有数据可筛 —— 不放假文件。
       */
      const q = ui.query.trim().toLowerCase();
      const openPaneMenu = (x: number, y: number, which: "sort" | "content") => {
        const sortItems: MenuItem[] = [
          { id: "s-name", label: "名称", onSelect: () => patch({ sort: "name" }) },
          { id: "s-date", label: "日期", onSelect: () => patch({ sort: "date" }) },
          { id: "s-size", label: "大小", onSelect: () => patch({ sort: "size" }) },
        ];
        const contentItems: MenuItem[] = [
          { id: "nf", label: "新建文件夹", disabled: true, onSelect: () => {} },
          { id: "info", label: "显示简介", disabled: true, onSelect: () => {} },
          { separator: true },
          { id: "group", label: ui.group ? "关闭群组" : "使用群组", onSelect: () => patch({ group: !ui.group }) },
          { id: "s-name", label: "排序方式：名称", onSelect: () => patch({ sort: "name" }) },
          { id: "s-date", label: "排序方式：日期", onSelect: () => patch({ sort: "date" }) },
          { id: "s-size", label: "排序方式：大小", onSelect: () => patch({ sort: "size" }) },
          { separator: true },
          { id: "vo", label: "查看显示选项", disabled: true, onSelect: () => {} },
        ];
        setPaneMenu({ x, y, items: which === "sort" ? sortItems : contentItems });
      };
      return (
        <div className="split">
          <nav className="split-side" aria-label="桌面文件夹">
            <div className="split-section">桌面</div>
            {folders.map((f) => (
              <button key={f.id} className="split-nav" aria-current={f.id === shown.id} onClick={() => go(f.id)}>
                <Folder size={16} /> {f.name}
              </button>
            ))}
          </nav>
          <div className="split-main">
            <div className="pane-toolbar">
              <button
                className="icon-button"
                aria-label="后退"
                disabled={ui.at <= 0}
                onClick={() => patch({ folderId: ui.history[ui.at - 1], at: ui.at - 1, query: "" })}
              >
                <ArrowLeft size={15} />
              </button>
              <button
                className="icon-button"
                aria-label="前进"
                disabled={ui.at >= ui.history.length - 1}
                onClick={() => patch({ folderId: ui.history[ui.at + 1], at: ui.at + 1, query: "" })}
              >
                <ArrowRight size={15} />
              </button>
              <strong className="pane-title">{shown.name}</strong>
              <div className="toolbar-spacer" />
              <label className="search-field">
                <Search size={13} />
                <input
                  aria-label="搜索此文件夹"
                  placeholder="搜索"
                  value={ui.query}
                  onChange={(e) => patch({ query: e.target.value })}
                />
              </label>
              <div className="segmented" role="group" aria-label="查看方式">
                <button aria-pressed={ui.view === "grid"} aria-label="图标" onClick={() => patch({ view: "grid" })}>
                  <LayoutGrid size={15} />
                </button>
                <button aria-pressed={ui.view === "list"} aria-label="列表" onClick={() => patch({ view: "list" })}>
                  <List size={15} />
                </button>
              </div>
              <button
                className="icon-button"
                aria-label="排序方式"
                aria-haspopup="menu"
                onClick={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  openPaneMenu(r.left, r.bottom + 4, "sort");
                }}
              >
                <ArrowUpDown size={15} />
              </button>
              <button className="icon-button" aria-label="共享" disabled title="文件服务接入后可用">
                <Share size={15} />
              </button>
              <button className="icon-button" aria-label="标签" disabled title="文件服务接入后可用">
                <Tag size={15} />
              </button>
            </div>
            <div
              className="folder-body"
              onContextMenu={(e) => {
                e.preventDefault();
                openPaneMenu(e.clientX, e.clientY, "content");
              }}
            >
              <div className="empty-content">
                <img className="large-icon" src={icon("folder")} alt="" draggable={false} />
                <span className="badge">{q ? "无匹配项" : "暂无内容"}</span>
                {q ? (
                  <p>没有匹配「{ui.query}」的项目。</p>
                ) : (
                  <p>
                    文件夹已创建，可重命名、移动和删除。文件本体与跨设备存储属于 D3
                    文件服务范围，本版不显示模拟文件。
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      );
    }
    if (w?.appId === "home")
      return (
        <div className="split">
          <nav className="split-side" aria-label="应用分类">
            <div className="split-section">应用</div>
            <button className="split-nav" aria-current={appTab === "all"} onClick={() => setAppTab("all")}>
              <LayoutGrid size={16} /> 全部应用
            </button>
            <button className="split-nav" aria-current={appTab === "recent"} onClick={() => setAppTab("recent")}>
              <Clock size={16} /> 最近使用
            </button>
            <div className="split-section">专业</div>
            <button className="split-nav" aria-current={appTab === "pro"} onClick={() => setAppTab("pro")}>
              <Wand2 size={16} /> 专业应用
            </button>
          </nav>
          <div className="split-main">
            {appTab === "all" ? (
              <>
                <h1>应用中心</h1>
                <p className="subtitle">一个桌面，连接你的应用、创意与 AI。</p>
                <div className="app-grid">
                  {apps
                    .filter((a) => a.id !== "home")
                    .map((a) => (
                      <button className="app-card" key={a.id} onClick={() => activateApp(a.id)}>
                        <img className="app-icon" src={icon(a.icon)} alt="" draggable={false} />
                        <strong>{a.name}</strong>
                        <small>
                          {a.id === "browser"
                            ? "真实网页 · 隔离运行"
                            : a.id === "settings"
                              ? "外观与全局模型"
                              : "规划中 · 查看说明"}
                        </small>
                      </button>
                    ))}
                </div>
              </>
            ) : appTab === "pro" ? (
              <>
                <h1>专业应用</h1>
                <p className="subtitle">本机已安装的 Adobe 应用；启动与操控尚未接入。</p>
                <div className="adobe-row">
                  <div className="adobe ps">Ps</div>
                  <div>
                    <strong>Adobe Photoshop</strong>
                    <small>已安装 27.1.0 · MCP 未连接</small>
                  </div>
                  <div className="adobe illustrator">Ai</div>
                  <div>
                    <strong>Adobe Illustrator</strong>
                    <small>已安装 30.0.0 · MCP 未连接</small>
                  </div>
                </div>
                <p className="footnote">Adobe 安装状态来自本次设备检查，尚未提供启动与操控。</p>
              </>
            ) : (
              <>
                <h1>最近使用</h1>
                <p className="subtitle">当前打开的窗口。</p>
                {state.windows.length === 0 ? (
                  <p className="muted">还没有打开任何应用窗口。</p>
                ) : (
                  <div className="list">
                    {state.windows.map((win) => (
                      <button
                        className="list-row"
                        key={win.id}
                        onClick={() => onCommand({ type: "window/focus", id: win.id })}
                      >
                        <img className="list-icon" src={icon(win.meta.icon)} alt="" draggable={false} />
                        <span>{win.meta.title}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      );
    if (w?.appId === "browser" || w?.kind === "browser") {
      const url = w.meta.url || "https://example.com";
      const visible = browserVisibleOf(id);
      return (
        <div className="browser-shell">
          <AddressBar
            url={url}
            onUrlChange={(v) => onCommand({ type: "system/native-state", windowId: id, url: v })}
            onNavigate={() => {
              if (!window.openarc) {
                clearBrowserEvent();
                return;
              }
              void window.openarc.navigate(id, url);
            }}
            onAction={(a) => void window.openarc?.action(id, a)}
          />
          <div className="browser-status" role="status">
            {browserEvents?.windowId === id
              ? browserEvents.message
              : visible
                ? "正在显示网页。桌面窗口可遮挡它，遮挡时由快照补齐。"
                : w.meta.url || "输入地址开始浏览。外部页面与桌面权限隔离。"}
          </div>
          <WebViewport nativeVisible={visible} error={undefined} />
        </div>
      );
    }
    if (w?.appId === "settings")
      return (
        <div className="split">
          <nav className="split-side" aria-label="设置分类">
            <div className="split-section">系统</div>
            <button
              className="split-nav"
              aria-current={settingsTab === "appearance"}
              onClick={() => setSettingsTab("appearance")}
            >
              <Sliders size={16} /> 外观与交互
            </button>
            <button className="split-nav" aria-current={settingsTab === "model"} onClick={() => setSettingsTab("model")}>
              <Bot size={16} /> 全局模型服务
            </button>
          </nav>
          <div className="split-main">
            {settingsTab === "appearance" ? (
              <>
                <h1>外观与交互</h1>
                <p className="subtitle">整个工作空间，遵循你的习惯。</p>
                <Switch label="深色外观" checked={dark} onChange={setDark} />
                <Switch label="减少动态效果" checked={reduced} onChange={setReduced} />
                <div className="setting-row">
                  <span>
                    材质
                    <span className="footnote"> 玻璃合成成本，与动效互不影响</span>
                  </span>
                  <select
                    className="material-select"
                    value={glass}
                    onChange={(e) => setGlass(e.target.value as GlassMode)}
                  >
                    <option value="full">完整玻璃</option>
                    <option value="reduced">降低材质</option>
                    <option value="solid">实色</option>
                  </select>
                </div>
              </>
            ) : (
              <>
                <h1>
                  全局模型服务 <span className="badge">尚未连接</span>
                </h1>
                <p className="subtitle">统一配置所有应用使用的模型；当前字段仅保留在内存，不保存、不发送。</p>
                <label className="field">
                  API 地址
                  <input
                    placeholder="https://api.example.com/v1"
                    value={endpoint}
                    onChange={(e) => setEndpoint(e.target.value)}
                  />
                </label>
                <label className="field">
                  模型名称
                  <input placeholder="填写自定义模型名" value={model} onChange={(e) => setModel(e.target.value)} />
                </label>
                <p className="footnote">密钥保管后端尚未接入，本版不收集 API 密钥。</p>
              </>
            )}
          </div>
        </div>
      );
    if (w?.appId === "skills")
      return (
        <div className="split">
          <nav className="split-side" aria-label="Skill 分类">
            <div className="split-section">Skill</div>
            <button className="split-nav" aria-current={skillTab === "market"} onClick={() => setSkillTab("market")}>
              <Store size={16} /> 市场
            </button>
            <button className="split-nav" aria-current={skillTab === "mine"} onClick={() => setSkillTab("mine")}>
              <User size={16} /> 我的技能
            </button>
            <div className="split-section">本机</div>
            <button
              className="split-nav"
              aria-current={skillTab === "installed"}
              onClick={() => setSkillTab("installed")}
            >
              <Package size={16} /> 已安装
            </button>
          </nav>
          <div className="split-main">
            <div className="empty-content">
              <img className="large-icon" src={icon("shortcuts")} alt="" draggable={false} />
              <h1>Skill 中心</h1>
              <span className="badge">尚未实现</span>
              <p>市场、自定义技能、版本与团队分享将在后续阶段接入。</p>
              <p className="muted">当前仅验证桌面窗口生命周期，不显示模拟业务数据。</p>
            </div>
          </div>
        </div>
      );
    return (
      <div className="empty-content">
        <img className="large-icon" src={icon(iconOf(id))} alt="" draggable={false} />
        <h1>{apps.find((a) => a.id === w?.appId)?.name}</h1>
        <span className="badge">尚未实现</span>
        <p>
          {w?.appId === "skills"
            ? "市场、自定义技能、版本与团队分享将在后续阶段接入。"
            : w?.appId === "canvas"
              ? "内容块、连线和项目保存将在后续阶段接入。"
              : "个人文件、团队项目和设备文件将在后续阶段接入。"}
        </p>
        <p className="muted">当前仅验证桌面窗口生命周期，不显示模拟业务数据。</p>
      </div>
    );
  };

  const menuItems: MenuItem[] = menu
    ? menu.folder
      ? [
          {
            id: "open",
            label: "打开",
            onSelect: () => {
              const f = folders.find((v) => v.id === menu.folder);
              if (f) openFolder(f);
            },
          },
          { id: "rename", label: "重命名", onSelect: () => setRenaming(menu.folder!) },
          { separator: true },
          {
            id: "delete",
            label: "删除",
            danger: true,
            onSelect: () => {
              setPendingDelete(menu.folder!);
              // 必须同时置 overlays.dialog：原生视图让位（§17）与背景 inert（§16）
              // 都吃这一个开关。少了这一步，"对话框打开时网页仍在吃键盘"会静默复现。
              setOverlays((o) => ({ ...o, dialog: true }));
            },
          },
        ]
      : [{ id: "new-folder", label: "新建文件夹", onSelect: () => createFolder(menu.x, menu.y) }]
    : [];

  function createFolder(x: number, y: number) {
    const used = new Set(folders.map((f) => f.name));
    let name = "新建文件夹";
    for (let i = 2; used.has(name); i += 1) name = `新建文件夹 ${i}`;
    const folder: Folder = { id: "f" + Date.now().toString(36), name, x: Math.max(0, Math.round(x)), y: Math.max(52, Math.round(y)) };
    setFolders((fs) => [...fs, folder]);
    setMenu(null);
    setRenaming(folder.id);
  }
  function removeFolder(id: string) {
    setFolders((fs) => fs.filter((f) => f.id !== id));
    onCommand({ type: "window/close", id: FOLDER_PREFIX + id });
    setMenu(null);
    closeDialog();
  }
  function closeDialog() {
    setPendingDelete(null);
    setOverlays((o) => ({ ...o, dialog: false }));
  }
  function renameFolder(id: string, name: string) {
    const next = name.trim();
    setFolders((fs) => fs.map((f) => (f.id === id ? { ...f, name: next || f.name } : f)));
    setRenaming(null);
  }

  const dragFolder = (e: React.PointerEvent, f: Folder) => {
    if (renaming === f.id) return;
    const x = e.clientX;
    const y = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
    const el = e.currentTarget as HTMLElement;
    const move = (ev: Event) => {
      const p = ev as PointerEvent;
      setFolders((fs) =>
        fs.map((v) =>
          v.id === f.id
            ? {
                ...v,
                x: Math.max(0, Math.min(innerWidth - 88, f.x + p.clientX - x)),
                y: Math.max(52, Math.min(innerHeight - 160, f.y + p.clientY - y)),
              }
            : v,
        ),
      );
    };
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  };

  const deleteTarget = pendingDelete ? folders.find((f) => f.id === pendingDelete) : null;

  /**
   * 身份门禁（§38 / §39）。
   *
   *   checking        → 只画启动态。**绝不先画桌面再闪回登录**——
   *                     恢复结果出来之前桌面内容根本不存在
   *   uninitialized   → 只能进初始化；刷新/回退也回不到可提交的空表单之外
   *   unauthenticated → 登录
   *   locked          → 桌面 DOM 保留（窗口状态不丢，§40），整块 inert + 锁屏覆盖
   *   ready / unavailable → 桌面
   *
   * `unavailable` = 没有主进程（浏览器 / 视觉回归环境）。
   * 真实产品里 preload 恒在，因此它不是可绕过的后门。
   */
  const gate = identity.phase;
  const showDesktop = gate === "unavailable" || gate === "ready" || gate === "locked";

  return (
    <div
      className={`desktop ${dark ? "dark" : ""} ${reduced ? "reduced" : ""}`}
      data-glass={glass}
      data-identity-gate={gate}
      onContextMenu={(e) => {
        if (!showDesktop) return;
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {gate === "checking" ? <BootSurface /> : null}

      {gate === "uninitialized" ? (
        <SetupScreen
          busy={identity.busy}
          error={identity.error}
          onSubmit={async (input) => {
            const res = await identity.initialize(input);
            // 初始化成功后不自动登录：交给登录页，让"初始口令是否可用"被真实验证一次
            if (res && res.ok) return res;
            return res;
          }}
        />
      ) : null}

      {gate === "unauthenticated" ? (
        <LoginScreen
          busy={identity.busy}
          error={identity.error}
          defaultIdentifier={identity.snapshot.identifier || ""}
          onSubmit={(input) => identity.login(input)}
        />
      ) : null}

      {/* Dialog 打开时背景必须 inert：语义层就挡住，而不是只靠 Tab 循环这一层技巧。
          display:contents 让这个包装盒不参与布局，因此不改变任何既有版式。 */}
      {showDesktop ? (
        <>
          <div className="desktop-surface" inert={overlays.dialog || locked || undefined}>
        <TopBar
          searchOpen={overlays.search}
          controlOpen={overlays.control}
          onToggleControl={() => setOverlays((o) => ({ ...o, control: !o.control }))}
          recent={[...state.windows].reverse().map((w) => ({ id: w.id, title: w.meta.title, appId: w.appId }))}
          onFocusWindow={(id) => onCommand({ type: "window/focus", id })}
          onCommand={onCommand}
          onToggleSearch={() => setOverlays((o) => ({ ...o, search: !o.search }))}
          onToggleAI={() => {
            setOverlays((o) => ({ ...o, ai: !o.ai }));
            bounce("__ai");
          }}
          identity={
            gate === "unavailable"
              ? null
              : {
                  displayName: identity.snapshot.displayName,
                  locked,
                  onLock: () => void identity.lock(),
                  onLogout: () => void identity.logout(),
                }
          }
        />
        <div className="desktop-brand">
          <div>OpenArc</div>
          <p>A space for everything you create.</p>
        </div>
        {folders.map((f) => (
          <div
            key={f.id}
            className="desktop-folder"
            style={{ left: f.x, top: f.y }}
            tabIndex={0}
            onPointerDown={(e) => dragFolder(e, f)}
            onDoubleClick={() => openFolder(f)}
            onKeyDown={(e) => {
              // 事件必须来自磁贴自身：重命名输入框里的 Enter 会冒泡上来，
              // 若不拦就会"提交重命名的同时把文件夹窗口也打开"（探针抓到的真实缺陷）。
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter") openFolder(f);
              if (e.key === "F2") setRenaming(f.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              menuTrigger.current = e.currentTarget as HTMLElement;
              setMenu({ x: e.clientX, y: e.clientY, folder: f.id });
            }}
          >
            <img className="desktop-folder-icon" src={icon("folder")} alt="" draggable={false} />
            {renaming === f.id ? (
              <input
                className="folder-rename"
                autoFocus
                aria-label="文件夹名称"
                defaultValue={f.name}
                onPointerDown={(e) => e.stopPropagation()}
                onBlur={(e) => renameFolder(f.id, e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") renameFolder(f.id, e.currentTarget.value);
                  if (e.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <span className="folder-name">{f.name}</span>
            )}
          </div>
        ))}
        <AssistantPill
          onActivate={() => {
            setOverlays((o) => ({ ...o, ai: !o.ai }));
            bounce("__ai");
          }}
        />
        {state.windows.map((w) => (
          <DesktopWindow
            key={w.id}
            window={w}
            focused={state.focused === w.id}
            onCommand={onCommand}
            onResizeStart={(e) => startResize(e, w, onCommand)}
            snapshots={snapshotLayers.filter((s) => s.windowId === w.id)}
          >
            {content(w.id)}
          </DesktopWindow>
        ))}
        <Dock
          apps={apps}
          runningApps={runningApps}
          bouncing={bouncing}
          dockRef={dockRef}
          onActivate={activateApp}
          onToggleAI={() => {
            setOverlays((o) => ({ ...o, ai: !o.ai }));
            bounce("__ai");
          }}
        />
      </div>

      {overlays.ai ? (
        <AIPanel
          onClose={() => setOverlays((o) => ({ ...o, ai: false }))}
          onOpenSettings={() => {
            setOverlays((o) => ({ ...o, ai: false }));
            activateApp("settings");
          }}
        />
      ) : null}

      {overlays.control ? (
        <>
          {/* 不压暗桌面（不同于搜索），只做点击外部关闭 */}
          <div className="cc-shade" onClick={() => setOverlays((o) => ({ ...o, control: false }))} />
          <div className="control-center" role="dialog" aria-modal="true" aria-label="控制中心">
            <Switch label="深色外观" checked={dark} onChange={setDark} />
            <Switch label="减少动态效果" checked={reduced} onChange={setReduced} />
            <div className="setting-row">
              <span>材质</span>
              <select
                className="material-select"
                aria-label="材质"
                value={glass}
                onChange={(e) => setGlass(e.target.value as GlassMode)}
              >
                <option value="full">完整玻璃</option>
                <option value="reduced">降低材质</option>
                <option value="solid">实色</option>
              </select>
            </div>
            <div className="cc-status">
              <Monitor size={13} /> 本机 · D1
            </div>
            {gate === "unavailable" ? null : (
              <div className="cc-actions">
                <button onClick={() => void identity.lock()} disabled={locked}>
                  <Lock size={13} /> 锁定
                </button>
                <button onClick={() => void identity.logout()}>
                  <LogOut size={13} /> {identity.snapshot.displayName || "退出"}
                </button>
              </div>
            )}
          </div>
        </>
      ) : null}

      {overlays.search ? (
        <div className="search-shade" onClick={() => setOverlays((o) => ({ ...o, search: false }))}>
          <div className="search-panel" ref={searchPanel} role="dialog" aria-modal="true" aria-label="搜索应用" onClick={(e) => e.stopPropagation()}>
            <div className="search-input">
              <img className="search-icon" src={icon("spotlight")} alt="" />
              <input
                aria-label="搜索应用名称"
                placeholder="搜索应用…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Tab") return;
                  const items = Array.from(
                    searchPanel.current?.querySelectorAll<HTMLElement>("button,input") || [],
                  );
                  if (!items.length) return;
                  const first = items[0];
                  const last = items[items.length - 1];
                  if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault();
                    last.focus();
                  } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                  }
                }}
              />
              <button onClick={() => setOverlays((o) => ({ ...o, search: false }))}>Esc</button>
            </div>
            {apps
              .filter((a) => a.name.toLowerCase().includes(query.toLowerCase()))
              .map((a) => (
                <button className="search-result" key={a.id} onClick={() => activateApp(a.id)}>
                  <img className="result-icon" src={icon(a.icon)} alt="" />
                  {a.name}
                  <ArrowRight size={16} />
                </button>
              ))}
          </div>
        </div>
      ) : null}

      {paneMenu ? (
        <ContextMenu
          x={paneMenu.x}
          y={paneMenu.y}
          items={paneMenu.items}
          onClose={() => setPaneMenu(null)}
          label="文件夹菜单"
        />
      ) : null}
      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} label="桌面菜单" />
      ) : null}

      {/* 真实产品消费：删除文件夹前的确认。Dialog 由产品自身使用，
          而不是只在 gallery 里存在 —— 这是 §41 能标 CLOSED BY D2-02 的前提。 */}
      <Dialog
        open={overlays.dialog}
        title="删除文件夹"
        returnFocusTo={menuTrigger.current}
        onClose={closeDialog}
        footer={
          <>
            <button className="ghost" onClick={closeDialog}>
              取消
            </button>
            <button className="primary danger" onClick={() => deleteTarget && removeFolder(deleteTarget.id)}>
              删除
            </button>
          </>
        }
      >
        <p>
          确定删除「{deleteTarget?.name}」吗？该文件夹内的内容不会随之删除。
        </p>
        <p className="muted">此操作不可撤销。</p>
        </Dialog>
        </>
      ) : null}

      {/*
        锁屏是**覆盖层**而不是页面：桌面 DOM 与窗口状态都还在（§40），
        只是整块 inert + 原生视图已隐藏。因此解锁后窗口原样回来，
        不存在"锁定把浏览器会话销毁"这种副作用。
      */}
      {gate === "locked" ? (
        <LockScreen
          snapshot={identity.snapshot}
          busy={identity.busy}
          error={identity.error}
          onUnlock={(password) => identity.unlock(password)}
          onLogout={() => identity.logout()}
        />
      ) : null}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
