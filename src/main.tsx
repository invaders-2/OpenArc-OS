import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Search, ArrowLeft, ArrowRight, RotateCw, X, Minus, Maximize2, Monitor } from "lucide-react";
import "./styles.css";
import geometry from "../electron/geometry.cjs";
type BrowserState = {
  url: string;
  loading: boolean;
  title: string;
  error: string;
};
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
      navigate: (url: string) => Promise<{ error?: string; ok?: boolean }>;
      layout: (p: unknown) => Promise<void>;
      action: (a: string) => Promise<void>;
      onBrowser: (cb: (s: BrowserState) => void) => () => void;
      onDisplay: (cb: (d: DisplayInfo[]) => void) => () => void;
    };
  }
}
type AppId = "home" | "browser" | "files" | "canvas" | "skills" | "settings";
// D1-04B 玻璃材质档位：单值三态。full = 完整玻璃，reduced = 降合成成本，
// solid = 关闭 backdrop-filter 走实色（原"减少透明度"）。
// 与 reduce motion 完全解耦：减少动效不改变材质，降低材质不关动画。
type GlassMode = "full" | "reduced" | "solid";
type Folder = { id: string; name: string; x: number; y: number };
type Win = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  min: boolean;
  max: boolean;
  restore?: number[];
};
const FOLDER_PREFIX = "folder:";
// 桌面工作区：顶栏之下、Dock 之上。所有窗口恢复时的收拢基准。
const AREA_TOP = 44;
const AREA_BOTTOM = 114;
const workArea = () => ({
  x: 0,
  y: AREA_TOP,
  width: innerWidth,
  height: Math.max(geometry.MIN_H, innerHeight - AREA_TOP - AREA_BOTTOM),
});
const isWin = (v: unknown): v is Win => {
  const w = v as Win;
  return (
    !!w &&
    typeof w.id === "string" &&
    ["x", "y", "w", "h"].every((k) => Number.isFinite(w[k as keyof Win] as number))
  );
};
// A05：恢复持久化的窗口几何，并立即收拢到当前可见工作区。
function restoreWins(): Win[] {
  const fallback: Win[] = [
    { id: "home", x: 90, y: 94, w: 830, h: 570, min: false, max: false },
  ];
  try {
    const raw = localStorage.getItem("oa-wins");
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed) || !parsed.length || !parsed.every(isWin))
      return fallback;
    return geometry.clampAll(parsed as Win[], [workArea()]);
  } catch {
    return fallback;
  }
}
const icon = (name: string) => "./icons/" + name + ".png";
const apps = [
  { id: "home", name: "应用中心", icon: "apps" },
  { id: "browser", name: "浏览器", icon: "safari" },
  { id: "files", name: "文件", icon: "finder" },
  { id: "canvas", name: "无限画布", icon: "freeform" },
  { id: "skills", name: "Skill 中心", icon: "shortcuts" },
  { id: "settings", name: "系统设置", icon: "settings" },
] as const;
function App() {
  const [wins, setWins] = useState<Win[]>(restoreWins);
  const [folders, setFolders] = useState<Folder[]>(() => {
    try {
      const raw = localStorage.getItem("oa-folders");
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [menu, setMenu] = useState<{ x: number; y: number; folder?: string } | null>(
    null,
  );
  const [renaming, setRenaming] = useState<string | null>(null);
  const [bouncing, setBouncing] = useState<string | null>(null);
  const dockRef = useRef<HTMLElement>(null);
  const [ai, setAI] = useState(false),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState(false);
  const [reduced, setReduced] = useState(
    () => localStorage.getItem("oa-motion") === "true",
  );
  // D1-04B：材质档位是单值三态，不再用多个独立 boolean 拼状态。
  // 兼容旧键 oa-opaque：true → solid，其余 → full。
  const [glass, setGlass] = useState<GlassMode>(() => {
    const v = localStorage.getItem("oa-glass");
    if (v === "full" || v === "reduced" || v === "solid") return v;
    return localStorage.getItem("oa-opaque") === "true" ? "solid" : "full";
  });
  const [dark, setDark] = useState(
    () => localStorage.getItem("oa-dark") === "true",
  );
  const [url, setURL] = useState("https://example.com"),
    [browser, setBrowser] = useState<BrowserState>({
      url: "",
      loading: false,
      title: "浏览器",
      error: "",
    });
  const [browserHidden, setBrowserHidden] = useState(false);
  const [note, setNote] = useState(""),
    [endpoint, setEndpoint] = useState(""),
    [model, setModel] = useState("");
  const searchTrigger = useRef<HTMLElement | null>(null);
  const searchPanel = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const active = wins.filter((w) => !w.min).at(-1)?.id;
  const folderOf = (id: string) =>
    id.startsWith(FOLDER_PREFIX)
      ? folders.find((f) => f.id === id.slice(FOLDER_PREFIX.length))
      : undefined;
  const titleOf = (id: string) =>
    folderOf(id)?.name ?? apps.find((a) => a.id === id)?.name ?? id;
  const iconOf = (id: string) =>
    folderOf(id) ? "folder" : (apps.find((a) => a.id === id)?.icon ?? "apps");
  const update = (id: string, patch: Partial<Win>) =>
    setWins((ws) => ws.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  const focus = (id: string) =>
    setWins((ws) => {
      const w = ws.find((w) => w.id === id);
      return w ? [...ws.filter((w) => w.id !== id), { ...w, min: false }] : ws;
    });
  const bounce = (id: string) => {
    if (reduced) return;
    setBouncing(id);
    window.setTimeout(
      () => setBouncing((cur) => (cur === id ? null : cur)),
      760,
    );
  };
  const openFolder = (f: Folder) => {
    setMenu(null);
    const id = FOLDER_PREFIX + f.id;
    if (wins.some((w) => w.id === id)) {
      focus(id);
      return;
    }
    setWins((ws) => [
      ...ws,
      {
        id,
        x: 140 + ws.length * 22,
        y: 100 + ws.length * 18,
        w: 620,
        h: 440,
        min: false,
        max: false,
      },
    ]);
  };
  const createFolder = (x: number, y: number) => {
    const used = new Set(folders.map((f) => f.name));
    let name = "新建文件夹";
    for (let i = 2; used.has(name); i += 1) name = `新建文件夹 ${i}`;
    const folder: Folder = {
      id: "f" + Date.now().toString(36),
      name,
      x: Math.max(0, Math.round(x)),
      y: Math.max(52, Math.round(y)),
    };
    setFolders((fs) => [...fs, folder]);
    setMenu(null);
    setRenaming(folder.id);
  };
  const removeFolder = (id: string) => {
    setFolders((fs) => fs.filter((f) => f.id !== id));
    setWins((ws) => ws.filter((w) => w.id !== FOLDER_PREFIX + id));
    setMenu(null);
  };
  const renameFolder = (id: string, name: string) => {
    const next = name.trim();
    setFolders((fs) =>
      fs.map((f) => (f.id === id ? { ...f, name: next || f.name } : f)),
    );
    setRenaming(null);
  };
  const open = (id: AppId) => {
    setSearch(false);
    bounce(id);
    if (wins.some((w) => w.id === id)) {
      focus(id);
      return;
    }
    setWins((ws) => [
      ...ws,
      {
        id,
        x: 120 + ws.length * 22,
        y: 90 + ws.length * 18,
        w: Math.min(840, innerWidth - 180),
        h: Math.min(570, innerHeight - 190),
        min: false,
        max: false,
      },
    ]);
  };
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
  // A05：窗口几何持久化，重启后才有"恢复"这回事
  useEffect(() => {
    localStorage.setItem("oa-wins", JSON.stringify(wins));
  }, [wins]);
  // 显示器增删或分辨率变化后重新收拢所有窗口
  useEffect(
    () =>
      window.openarc?.onDisplay(() =>
        setWins((ws) => geometry.clampAll(ws, [workArea()])),
      ),
    [],
  );
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
        const scale = 1 + 0.62 * t * t * (3 - 2 * t);
        el.style.setProperty("--s", scale.toFixed(3));
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
  useEffect(
    () =>
      window.openarc?.onBrowser((s) => {
        setBrowser(s);
        if (s.url) setURL(s.url);
      }),
    [],
  );
  useEffect(() => {
    if (search) {
      searchTrigger.current = document.activeElement as HTMLElement;
      searchPanel.current?.querySelector("input")?.focus();
    } else {
      searchTrigger.current?.focus();
    }
  }, [search]);
  useEffect(() => {
    const clamp = () =>
      setWins((ws) =>
        geometry.clampAll(
          ws.map((w) =>
            w.max
              ? {
                  ...w,
                  x: 12,
                  y: 52,
                  w: innerWidth - 24,
                  h: Math.max(geometry.MIN_H, innerHeight - 158),
                }
              : w,
          ),
          [workArea()],
        ),
      );
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearch((s) => !s);
      }
      if (e.key === "Escape") {
        setSearch(false);
        setAI(false);
        // MS-A03：桌面右键菜单此前只能靠点击遮罩关闭，Esc 无效会导致
        // .menu-shade 继续拦截所有点击，形成功能性陷阱。菜单必须可键盘关闭。
        setMenu(null);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useLayoutEffect(() => {
    const sync = () => {
      const rect = viewport.current?.getBoundingClientRect();
      const target = rect
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        : null;
      // A12：原生 WebContentsView 永远绘制在 DOM 之上，任何更高层的窗口压到
      // 网页区都必须隐藏视图，否则网页会穿透 OpenArc 的窗口。
      const index = wins.findIndex((w) => w.id === "browser");
      const above =
        index >= 0
          ? wins
              .slice(index + 1)
              .filter((w) => !w.min)
              .map(geometry.rectOf)
          : [];
      const blocked = ai || search || !!menu || geometry.occluded(target, above);
      const shown = active === "browser" && !blocked && !!target;
      setBrowserHidden(!shown);
      void window.openarc?.layout({ visible: shown, bounds: target });
    };
    sync();
    const observer = new ResizeObserver(sync);
    if (viewport.current) observer.observe(viewport.current);
    window.addEventListener("resize", sync);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [wins, active, ai, search, menu]);
  const drag = (e: React.PointerEvent, id: string, resize = false) => {
    if ((e.target as HTMLElement).closest("button,input") && !resize) return;
    const w = wins.find((v) => v.id === id)!;
    if (w.max) return;
    focus(id);
    const x = e.clientX,
      y = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
    const element = e.currentTarget;
    const move = (ev: Event) => {
      const p = ev as PointerEvent;
      update(
        id,
        resize
          ? {
              w: Math.max(560, Math.min(innerWidth - w.x, w.w + p.clientX - x)),
              h: Math.max(
                400,
                Math.min(innerHeight - 100 - w.y, w.h + p.clientY - y),
              ),
            }
          : {
              x: Math.max(0, Math.min(innerWidth - w.w, w.x + p.clientX - x)),
              y: Math.max(44, Math.min(innerHeight - 140, w.y + p.clientY - y)),
            },
      );
    };
    const end = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", end);
      element.removeEventListener("pointercancel", end);
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", end);
    element.addEventListener("pointercancel", end);
  };
  const maximize = (w: Win) =>
    update(
      w.id,
      w.max
        ? {
            max: false,
            x: w.restore![0],
            y: w.restore![1],
            w: w.restore![2],
            h: w.restore![3],
          }
        : {
            max: true,
            restore: [w.x, w.y, w.w, w.h],
            x: 12,
            y: 52,
            w: innerWidth - 24,
            h: innerHeight - 158,
          },
    );
  // 顶栏红绿灯操作当前聚焦且未最小化的窗口；没有可操作目标时置灰
  const activeWin = wins.find((w) => w.id === active && !w.min);
  const dragFolder = (e: React.PointerEvent, f: Folder) => {
    if (renaming === f.id) return;
    const x = e.clientX,
      y = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
    const element = e.currentTarget;
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
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", end);
      element.removeEventListener("pointercancel", end);
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", end);
    element.addEventListener("pointercancel", end);
  };
  const navigate = async () => {
    if (!window.openarc) {
      setBrowser((s) => ({
        ...s,
        error: "请用 npm run desktop 启动真实桌面浏览器。",
      }));
      return;
    }
    const result = await window.openarc.navigate(url);
    if (result.error) setBrowser((s) => ({ ...s, error: result.error! }));
  };
  const content = (id: string) => {
    const folder = folderOf(id);
    if (folder)
      return (
        <div className="empty-content">
          <img
            className="large-icon"
            src={icon("folder")}
            alt=""
            draggable={false}
          />
          <h1>{folder.name}</h1>
          <span className="badge">暂无内容</span>
          <p>
            文件夹已创建，可重命名、移动和删除。文件本体与跨设备存储属于 D3
            文件服务范围，本版不显示模拟文件。
          </p>
        </div>
      );
    if (id === "home")
      return (
        <div className="app-content">
          <div className="eyebrow">YOUR WORKSPACE, CONNECTED</div>
          <h1>把工作，放在一起。</h1>
          <p className="subtitle">一个桌面，连接你的应用、创意与 AI。</p>
          <div className="app-grid">
            {apps
              .filter((a) => a.id !== "home")
              .map((a) => (
                <button
                  className="app-card"
                  key={a.id}
                  onClick={() => open(a.id)}
                >
                  <img
                    className="app-icon"
                    src={icon(a.icon)}
                    alt=""
                    draggable={false}
                  />
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
          <div className="section-title">
            专业应用 <span>本机连接</span>
          </div>
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
          <p className="footnote">
            D1 桌面验证版 · Adobe 安装状态来自本次设备检查，尚未提供启动与操控。
          </p>
        </div>
      );
    if (id === "browser")
      return (
        <div className="browser-shell">
          <form
            className="addressbar"
            onSubmit={(e) => {
              e.preventDefault();
              void navigate();
            }}
          >
            <button
              type="button"
              aria-label="后退"
              onClick={() => void window.openarc?.action("back")}
            >
              <ArrowLeft size={17} />
            </button>
            <button
              type="button"
              aria-label="前进"
              onClick={() => void window.openarc?.action("forward")}
            >
              <ArrowRight size={17} />
            </button>
            <button
              type="button"
              aria-label="刷新"
              onClick={() => void window.openarc?.action("reload")}
            >
              <RotateCw size={16} />
            </button>
            <input
              aria-label="网页地址"
              value={url}
              onChange={(e) => setURL(e.target.value)}
            />
            <button className="primary">打开</button>
          </form>
          <div className="browser-status" role="status">
            {browser.error ||
              (browser.loading
                ? "正在加载网页…"
                : browser.url || "输入地址开始浏览。外部页面与桌面权限隔离。")}
          </div>
          <div className="web-viewport" ref={viewport}>
            <img
              className="viewport-icon"
              src={icon("safari")}
              alt=""
              draggable={false}
            />
            {/* 文案必须与实际是否显示原生视图一致，否则界面会撒谎 */}
            <p data-view={browserHidden ? "hidden" : "shown"}>
              {browserHidden
                ? "网页已暂时隐藏，避免遮挡系统窗口"
                : "网页内容将在此处显示"}
            </p>
          </div>
        </div>
      );
    if (id === "settings")
      return (
        <div className="settings-content">
          <div className="eyebrow">SYSTEM PREFERENCES</div>
          <h1>系统设置</h1>
          <p className="subtitle">整个工作空间，遵循你的习惯。</p>
          <h3>外观与交互</h3>
          {[
            ["深色外观", dark, setDark],
            ["减少动态效果", reduced, setReduced],
          ].map(([label, value, set]) => (
            <label className="setting-row" key={String(label)}>
              <span>{String(label)}</span>
              <input
                type="checkbox"
                checked={Boolean(value)}
                onChange={(e) =>
                  (set as (v: boolean) => void)(e.target.checked)
                }
              />
            </label>
          ))}
          {/* D1-04B：材质档位取代原"减少透明度"勾选框。
              材质与动效是两个独立设置，互不影响。 */}
          <label className="setting-row">
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
          </label>
          <h3>
            全局模型服务 <span className="badge">尚未连接</span>
          </h3>
          <p className="muted">
            这里将统一配置所有应用使用的模型。当前字段仅保留在内存，不保存、不发送。
          </p>
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
            <input
              placeholder="填写自定义模型名"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </label>
          <p className="footnote">
            密钥保管后端尚未接入，本版不收集 API 密钥。
          </p>
        </div>
      );
    return (
      <div className="empty-content">
        <img
          className="large-icon"
          src={icon(iconOf(id))}
          alt=""
          draggable={false}
        />
        <h1>{apps.find((a) => a.id === id)?.name}</h1>
        <span className="badge">尚未实现</span>
        <p>
          {id === "skills"
            ? "市场、自定义技能、版本与团队分享将在后续阶段接入。"
            : id === "canvas"
              ? "内容块、连线和项目保存将在后续阶段接入。"
              : "个人文件、团队项目和设备文件将在后续阶段接入。"}
        </p>
        <p className="muted">
          当前仅验证桌面窗口生命周期，不显示模拟业务数据。
        </p>
      </div>
    );
  };
  return (
    <div
      className={`desktop ${dark ? "dark" : ""} ${reduced ? "reduced" : ""}`}
      data-glass={glass}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <header className="topbar">
        <div className="traffic traffic-bar" aria-label="当前窗口控制">
          <button
            className="close"
            aria-label="关闭当前窗口"
            disabled={!activeWin}
            onClick={() =>
              activeWin && setWins((ws) => ws.filter((v) => v.id !== activeWin.id))
            }
          >
            <X size={8} />
          </button>
          <button
            className="minimize"
            aria-label="最小化当前窗口"
            disabled={!activeWin}
            onClick={() => activeWin && update(activeWin.id, { min: true })}
          >
            <Minus size={8} />
          </button>
          <button
            className="maximize"
            aria-label="最大化当前窗口"
            disabled={!activeWin}
            onClick={() => activeWin && maximize(activeWin)}
          >
            <Maximize2 size={7} />
          </button>
        </div>
        <strong className="wordmark">◈ OpenArc</strong>
        <span>{apps.find((a) => a.id === active)?.name || "桌面"}</span>
        <div className="topbar-right">
          <span className="local-tag">
            <Monitor size={13} /> 本机 · D1
          </span>
          <button onClick={() => setSearch((v) => !v)} aria-label="全局搜索">
            <img className="bar-icon" src={icon("spotlight")} alt="" />
          </button>
          <button
            onClick={() => {
              setAI((v) => !v);
              bounce("__ai");
            }}
            aria-label="全局 AI"
          >
            <img className="bar-icon" src={icon("siri")} alt="" />
          </button>
          <span>
            {new Date().toLocaleDateString("zh-CN", {
              month: "long",
              day: "numeric",
            })}
          </span>
        </div>
      </header>
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
            if (e.key === "Enter") openFolder(f);
            if (e.key === "F2") setRenaming(f.id);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenu({ x: e.clientX, y: e.clientY, folder: f.id });
          }}
        >
          <img
            className="desktop-folder-icon"
            src={icon("folder")}
            alt=""
            draggable={false}
          />
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
      <button
        className="assistant-pill"
        onClick={() => {
          setAI((v) => !v);
          bounce("__ai");
        }}
      >
        <img className="pill-icon" src={icon("siri")} alt="" />
        <span>全局 AI</span>
        <span className="pill-status">未连接</span>
      </button>
      {wins.map((w, i) => (
        <section
          key={w.id}
          aria-label={`${titleOf(w.id)}窗口`}
          className={`window ${active === w.id ? "active" : ""} ${w.min ? "minimized" : ""}`}
          style={{
            left: w.x,
            top: w.y,
            width: w.w,
            height: w.h,
            zIndex: 10 + i,
          }}
          onPointerDown={() => {
            if (active !== w.id) focus(w.id);
          }}
        >
          <div
            className="window-title"
            onPointerDown={(e) => drag(e, w.id)}
            onDoubleClick={() => maximize(w)}
          >
            <div className="traffic">
              <button
                className="close"
                aria-label={`关闭${w.id}`}
                onClick={() => setWins((ws) => ws.filter((v) => v.id !== w.id))}
              >
                <X size={10} />
              </button>
              <button
                className="minimize"
                aria-label={`最小化${w.id}`}
                onClick={() => update(w.id, { min: true })}
              >
                <Minus size={10} />
              </button>
              <button
                className="maximize"
                aria-label={`最大化${w.id}`}
                onClick={() => maximize(w)}
              >
                <Maximize2 size={9} />
              </button>
            </div>
            <strong>{titleOf(w.id)}</strong>
            <span className="title-meta">OpenArc</span>
          </div>
          <div className="window-body">{content(w.id)}</div>
          {!w.max && (
            <button
              className="resize"
              aria-label={`调整${w.id}大小`}
              onPointerDown={(e) => drag(e, w.id, true)}
              onKeyDown={(e) => {
                if (e.key.startsWith("Arrow")) {
                  e.preventDefault();
                  update(w.id, {
                    w: Math.max(
                      560,
                      Math.min(
                        innerWidth - w.x,
                        w.w +
                          (e.key === "ArrowRight"
                            ? 20
                            : e.key === "ArrowLeft"
                              ? -20
                              : 0),
                      ),
                    ),
                    h: Math.max(
                      400,
                      Math.min(
                        innerHeight - 100 - w.y,
                        w.h +
                          (e.key === "ArrowDown"
                            ? 20
                            : e.key === "ArrowUp"
                              ? -20
                              : 0),
                      ),
                    ),
                  });
                }
              }}
            >
              ⌟
            </button>
          )}
        </section>
      ))}
      <nav className="dock" aria-label="应用栏" ref={dockRef}>
        {apps.map((a) => (
          <button
            key={a.id}
            aria-label={`打开${a.name}`}
            onClick={() => open(a.id)}
            className={`dock-item ${bouncing === a.id ? "bouncing" : ""}`}
          >
            <img className="dock-icon" src={icon(a.icon)} alt="" draggable={false} />
            <span className="dock-tooltip" aria-hidden="true">
              {a.name}
            </span>
            <span
              className={`running-dot ${wins.some((w) => w.id === a.id) ? "running" : ""}`}
            />
          </button>
        ))}
        <div className="dock-divider" />
        <button
          className={`dock-item ${bouncing === "__ai" ? "bouncing" : ""}`}
          aria-label="打开全局AI"
          onClick={() => {
            setAI((v) => !v);
            bounce("__ai");
          }}
        >
          <img className="dock-icon" src={icon("siri")} alt="" draggable={false} />
          <span className="dock-tooltip" aria-hidden="true">
            全局 AI
          </span>
          <span className="running-dot" />
        </button>
      </nav>
      {ai && (
        <aside className="ai-panel" aria-label="AI 助手">
          <div className="panel-heading">
            <img className="heading-icon" src={icon("siri")} alt="" />
            <strong>全局 AI 助手</strong>
            <button aria-label="关闭AI面板" onClick={() => setAI(false)}>
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
            <button
              onClick={() => {
                setAI(false);
                open("settings");
              }}
            >
              查看统一设置 <ArrowRight size={15} />
            </button>
          </div>
          <div className="composer">
            <textarea
              aria-label="任务草稿"
              placeholder="先记下你想完成的工作…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <span>仅本次会话草稿 · 未发送</span>
          </div>
        </aside>
      )}
      {search && (
        <div className="search-shade" onClick={() => setSearch(false)}>
          <div
            className="search-panel"
            ref={searchPanel}
            aria-modal="true"
            onKeyDown={(e) => {
              if (e.key === "Tab") {
                const items =
                  searchPanel.current?.querySelectorAll<HTMLElement>(
                    "button,input",
                  );
                if (!items?.length) return;
                const first = items[0],
                  last = items[items.length - 1];
                if (e.shiftKey && document.activeElement === first) {
                  e.preventDefault();
                  last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                  e.preventDefault();
                  first.focus();
                }
              }
            }}
            role="dialog"
            aria-label="搜索应用"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="search-input">
              <img className="search-icon" src={icon("spotlight")} alt="" />
              <input
                aria-label="搜索应用名称"
                placeholder="搜索应用…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button onClick={() => setSearch(false)}>Esc</button>
            </div>
            {apps
              .filter((a) => a.name.toLowerCase().includes(query.toLowerCase()))
              .map((a) => (
                <button
                  className="search-result"
                  key={a.id}
                  onClick={() => open(a.id)}
                >
                  <img className="result-icon" src={icon(a.icon)} alt="" />
                  {a.name}
                  <ArrowRight size={15} />
                </button>
              ))}
          </div>
        </div>
      )}
      {menu && (
        <>
          <div
            className="menu-shade"
            onPointerDown={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div
            className="context-menu"
            role="menu"
            aria-label="桌面菜单"
            style={{
              left: Math.min(menu.x, innerWidth - 190),
              top: Math.min(menu.y, innerHeight - 150),
            }}
          >
            {menu.folder ? (
              <>
                <button
                  role="menuitem"
                  onClick={() => {
                    const f = folders.find((v) => v.id === menu.folder);
                    if (f) openFolder(f);
                  }}
                >
                  打开
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setRenaming(menu.folder!);
                    setMenu(null);
                  }}
                >
                  重命名
                </button>
                <button
                  role="menuitem"
                  className="danger"
                  onClick={() => removeFolder(menu.folder!)}
                >
                  删除
                </button>
              </>
            ) : (
              <button role="menuitem" onClick={() => createFolder(menu.x, menu.y)}>
                新建文件夹
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
