/**
 * OpenArc Design System v1 — 内部验证用 Gallery
 *
 * 这是**设计系统的回归面**，不是产品页面：
 *   - 它渲染的是**真实 primitive 组件**（与产品同一份代码），不是复制的 class；
 *   - 它把主题 / 玻璃档位 / 动效模式从 URL 读出来，让探针可以确定性地
 *     遍历 {light,dark} × {full,reduced,solid} × {normal,reduced}；
 *   - 每个 specimen 都带稳定的 `data-ds-id`，探针用它定位而不是靠文案。
 *
 * 路由：`?view=primitives`（默认） / `?view=desktop`
 * 参数：`theme=light|dark` `glass=full|reduced|solid` `motion=normal|reduced`
 *
 * 为什么放进 dist：探针跑的是**构建产物**（与 D1-04 性能基线同一口径），
 * 打包时排除该入口即可。见 ADR §Tests / §Known Limitations。
 */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "./tokens.css";
import "../styles.css";
import "./primitives.css";
import "./page-states.css";
import "./gallery.css";
import {
  Badge,
  Button,
  IconButton,
  ScrollArea,
  SearchField,
  Surface,
  TextField,
  ToastProvider,
  Tooltip,
  useToast,
  type Status,
  type ToastKind,
} from "./primitives";
import { PageState, PAGE_STATE_SPEC, type PageStateKind } from "./page-states";

const q = new URLSearchParams(location.search);
const THEME = q.get("theme") === "dark" ? "dark" : "light";
const GLASS = (["full", "reduced", "solid"] as const).includes(q.get("glass") as never)
  ? (q.get("glass") as "full" | "reduced" | "solid")
  : "full";
const MOTION = q.get("motion") === "reduced" ? "reduced" : "normal";
const VIEW = q.get("view") === "desktop" ? "desktop" : "primitives";

/** 行为学探针用的点击计数器。挂在 window 上，探针读 window.__clicks 核对。
 *  这不是产品代码，只服务于"禁用是否真的禁用"这一条断言。 */
function bumpClick(key: string) {
  return () => {
    const w = window as unknown as { __clicks?: Record<string, number> };
    w.__clicks = w.__clicks ?? {};
    w.__clicks[key] = (w.__clicks[key] ?? 0) + 1;
  };
}

function Specimen({
  id,
  label,
  children,
  inline,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
  inline?: boolean;
}) {
  return (
    <div className="g-spec" data-ds-id={id}>
      <p className="g-spec__label">{label}</p>
      <div className={inline ? "g-spec__row" : "g-spec__stack"}>{children}</div>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section className="g-section" data-ds-id={id}>
      <h2 className="g-section__title">{title}</h2>
      {children}
    </section>
  );
}

function ToastLab() {
  const { toast } = useToast();
  const kinds: ToastKind[] = ["info", "success", "warning", "error", "progress"];
  return (
    <Specimen id="toast-triggers" label="Toast / Notification（点击触发）" inline>
      {kinds.map((k) => (
        <Button key={k} data-ds-id={`toast-${k}`} onClick={() => toast({ kind: k, title: `${k} 通知`, description: "设计系统层能力演示" })}>
          {k}
        </Button>
      ))}
      <Button data-ds-id="toast-persistent" onClick={() => toast({ kind: "info", title: "常驻通知", duration: null })}>
        persistent
      </Button>
      <Button
        data-ds-id="toast-multi"
        onClick={() => {
          toast({ kind: "info", title: "第一条" });
          toast({ kind: "success", title: "第二条" });
          toast({ kind: "warning", title: "第三条" });
        }}
      >
        multi
      </Button>
    </Specimen>
  );
}

function Primitives() {
  const [search, setSearch] = useState("");
  const [searchFilled, setSearchFilled] = useState("设计 token");
  const [tf, setTF] = useState("");
  const statuses: Status[] = ["idle", "loading", "success", "error"];

  return (
    <>
      <Section id="typography" title="1. Typography">
        <p className="g-display">Display 27</p>
        <p className="g-title">Title 21</p>
        <p className="g-heading">Heading 14 — 强调行</p>
        <p className="g-body">Body 14 — 正文段落。系统 UI 字体栈，字重克制，标题与强调统一 500。</p>
        <p className="g-secondary">Secondary 13 — 按钮与导航</p>
        <p className="g-caption">Caption 12 — 说明文字</p>
        <p className="g-micro">Micro 11 — 元信息与状态</p>
        <p className="g-eyebrow">EYEBROW 10</p>
        <p className="g-mono">Mono — openarc.d1-06 0.1.0</p>
      </Section>

      <Section id="color" title="2. Color / Surface">
        <Specimen id="color-swatches" label="语义色" inline>
          <span className="g-sw g-sw--text">text</span>
          <span className="g-sw g-sw--muted">muted</span>
          <span className="g-sw g-sw--accent">accent</span>
          <span className="g-sw g-sw--failed">failed</span>
          <span className="g-sw g-sw--focus">focus</span>
        </Specimen>
        <Specimen id="surface-tokens" label="表面与材质" inline>
          <Surface material="glass" level={1} radius="md" padded className="g-cell">
            surface / glass
          </Surface>
          <Surface material="solid" level={1} radius="md" padded className="g-cell">
            content / solid
          </Surface>
          <Surface material="none" level={0} radius="md" padded className="g-cell g-cell--sunken">
            sunken
          </Surface>
          {/* 大面积白名单的显式对照：同是玻璃面，只有这一只参与 REDUCED 的减面积。
              探针会比对两者 —— 小面始终有 backdrop-filter，large 面在 REDUCED 下为 none。 */}
          <Surface material="glass" level={1} radius="md" padded large className="g-cell">
            surface / glass · large
          </Surface>
        </Specimen>
      </Section>

      <Section id="button" title="3. Button（default / hover / active / focus-visible / disabled / loading）">
        <Specimen id="button-variants" label="variants × sizes" inline>
          <Button variant="primary" data-ds-id="btn-primary">
            primary
          </Button>
          <Button variant="secondary" data-ds-id="btn-secondary">
            secondary
          </Button>
          <Button variant="ghost" data-ds-id="btn-ghost">
            ghost
          </Button>
          <Button variant="danger" data-ds-id="btn-danger">
            删除
          </Button>
          <Button variant="secondary" size="sm" data-ds-id="btn-sm">
            small
          </Button>
        </Specimen>
        <Specimen id="button-async" label="异步状态" inline>
          {statuses.map((s) => (
            <Button key={s} variant="secondary" status={s} data-ds-id={`btn-status-${s}`}>
              {s}
            </Button>
          ))}
        </Specimen>
        <Specimen id="button-disabled" label="disabled" inline>
          <Button variant="primary" disabled data-ds-id="btn-disabled-primary">
            不可用
          </Button>
          <Button variant="secondary" disabled data-ds-id="btn-disabled-secondary">
            不可用
          </Button>
        </Specimen>
        {/* 行为学用例：视觉禁用不算禁用 —— 探针会强制点击这几个按钮，
            只有 ok 那一个允许真的把计数加上去。 */}
        <Specimen id="button-behavior" label="行为学：loading 抑制点击 / disabled 真的不触发" inline>
          <Button
            variant="primary"
            status="loading"
            data-ds-id="btn-behave-loading"
            onClick={bumpClick("loading")}
          >
            loading
          </Button>
          <Button
            variant="secondary"
            disabled
            data-ds-id="btn-behave-disabled"
            onClick={bumpClick("disabled")}
          >
            disabled
          </Button>
          <Button variant="secondary" data-ds-id="btn-behave-ok" onClick={bumpClick("ok")}>
            ok
          </Button>
        </Specimen>
      </Section>

      <Section id="iconbutton" title="4. IconButton（含 toggle 与 disabled）">
        <Specimen id="iconbutton-states" label="图标按钮" inline>
          <IconButton label="设置" data-ds-id="ib-ghost">
            ⚙
          </IconButton>
          <IconButton label="次要操作" variant="secondary" data-ds-id="ib-secondary">
            ✎
          </IconButton>
          <IconButton label="确认" variant="primary" data-ds-id="ib-primary">
            ✓
          </IconButton>
          <IconButton label="删除" variant="danger" data-ds-id="ib-danger">
            ✕
          </IconButton>
          <IconButton label="固定到 Dock" pressed data-ds-id="ib-pressed">
            ⇧
          </IconButton>
          <IconButton label="不可用" disabled data-ds-id="ib-disabled">
            ⚙
          </IconButton>
          <IconButton label="加载中" status="loading" data-ds-id="ib-loading" />
        </Specimen>
      </Section>

      <Section id="textfield" title="5. TextField（empty / filled / error / readonly / disabled / async）">
        <Specimen id="tf-empty" label="empty">
          <TextField label="API Key" placeholder="粘贴密钥" value={tf} onChange={(e) => setTF(e.target.value)} data-ds-id="tf-empty-input" />
        </Specimen>
        <Specimen id="tf-filled" label="filled + hint">
          <TextField label="工作区路径" defaultValue="/Users/me/OpenArc" hint="相对路径按工作区解析" />
        </Specimen>
        <Specimen id="tf-error" label="error">
          <TextField label="端点" defaultValue="http://" error="必须是 https 且包含主机名" />
        </Specimen>
        <Specimen id="tf-readonly" label="readonly">
          <TextField label="设备指纹" defaultValue="d1-06-gate" readOnly />
        </Specimen>
        <Specimen id="tf-disabled" label="disabled">
          <TextField label="团队密钥" placeholder="由管理员下发" disabled />
        </Specimen>
        <Specimen id="tf-async" label="async" inline>
          <TextField label="loading" defaultValue="sk-…" status="loading" />
          <TextField label="success" defaultValue="已校验" status="success" />
        </Specimen>
      </Section>

      <Section id="searchfield" title="6. SearchField">
        <Specimen id="sf-states" label="empty / filled / kbd" >
          <SearchField value={search} onValueChange={setSearch} kbd="⌘K" />
          <SearchField value={searchFilled} onValueChange={setSearchFilled} />
        </Specimen>
      </Section>

      <Section id="tooltip" title="7. Tooltip（hover **与** keyboard focus 都必须显示）">
        <Specimen id="tooltip-targets" label="悬停 / Tab 聚焦" inline>
          <Tooltip content="顶部提示" placement="top">
            <Button variant="secondary" data-ds-id="tip-top">
              top
            </Button>
          </Tooltip>
          <Tooltip content="底部提示" placement="bottom">
            <Button variant="secondary" data-ds-id="tip-bottom">
              bottom
            </Button>
          </Tooltip>
          <Tooltip content="右侧提示" placement="right">
            <IconButton label="更多" data-ds-id="tip-right">
              ⋯
            </IconButton>
          </Tooltip>
          <Tooltip content="不应出现" disabled>
            <Button variant="secondary" data-ds-id="tip-disabled">
              disabled
            </Button>
          </Tooltip>
        </Specimen>
      </Section>

      <Section id="badge" title="8. Badge">
        <Specimen id="badge-tones" label="tone × size" inline>
          <Badge tone="neutral">neutral</Badge>
          <Badge tone="success">success</Badge>
          <Badge tone="warning">warning</Badge>
          <Badge tone="danger">danger</Badge>
          <Badge tone="neutral" size="sm">
            sm
          </Badge>
        </Specimen>
      </Section>

      <Section id="scrollarea" title="9. ScrollArea（可聚焦，方向键可滚）">
        <Specimen id="scroll-demo" label="滚动区域">
          <ScrollArea maxHeight={120} label="长列表">
            <ul className="g-list">
              {Array.from({ length: 14 }, (_, i) => (
                <li key={i}>列表项 {i + 1}</li>
              ))}
            </ul>
          </ScrollArea>
        </Specimen>
      </Section>

      <Section id="surface" title="10. Surface / Card（material × elevation）">
        <Specimen id="surface-grid" label="material × level" inline>
          {(["glass", "solid"] as const).map((m) =>
            ([1, 2, 3, 4] as const).map((l) => (
              <Surface key={`${m}${l}`} material={m} level={l} radius="lg" padded className="g-cell">
                {m} / elev-{l}
              </Surface>
            )),
          )}
        </Specimen>
      </Section>

      <Section id="pagestate" title="11. Page States（7 种，Unauthorized 只冻结视觉契约）">
        <div className="g-pagestate-grid">
          {(Object.keys(PAGE_STATE_SPEC) as PageStateKind[]).map((k) => (
            <div className="g-pagestate-cell" key={k} data-ds-id={`page-state-${k}`}>
              <PageState
                kind={k}
                title={PAGE_STATE_TITLE[k]}
                description={PAGE_STATE_DESC[k]}
                missing={k === "partial-result" ? ["2 个设备未上报", "1 个应用签名未校验"] : undefined}
                onAction={PAGE_STATE_SPEC[k].action === "none" ? undefined : () => undefined}
              />
            </div>
          ))}
        </div>
        {/* 契约证据：unauthorized **不传 onAction** 时不得画出任何动作。
            真实权限判定要等 D3-02，本轮绝不假装"去登录"已经接线。 */}
        <div className="g-pagestate-cell" data-ds-id="page-state-unauthorized-noaction">
          <PageState
            kind="unauthorized"
            title="无权访问"
            description="仅冻结视觉契约：没有传入 onAction 时不应出现任何动作按钮。"
          />
        </div>
      </Section>

      <Section id="toast" title="12. Toast / Notification">
        <ToastLab />
      </Section>
    </>
  );
}

const PAGE_STATE_TITLE: Record<PageStateKind, string> = {
  empty: "这里还没有内容",
  loading: "正在载入",
  error: "加载失败",
  unauthorized: "没有访问权限",
  offline: "网络不可达",
  unavailable: "当前环境不可用",
  "partial-result": "部分结果",
};
const PAGE_STATE_DESC: Record<PageStateKind, string> = {
  empty: "可以新建一个项目开始。",
  loading: "正在从本机服务读取数据。",
  error: "服务返回了错误，可以重试。",
  unauthorized: "需要相应权限才能查看该对象。（权限判定待 D3-02）",
  offline: "连接恢复后会自动重试。",
  unavailable: "该能力在当前平台尚未就绪。",
  "partial-result": "已显示可用数据，以下项目缺失：",
};

/* ── Desktop contract specimens：用**产品真实 class**渲染，
   验证桌面部件的视觉契约与 token 绑定，不引入新的窗口架构。 ── */
function DesktopSpecimens() {
  return (
    <div className="desktop" data-glass={GLASS}>
      <div className="topbar">
        <div className="traffic traffic-bar">
          <button className="close" aria-label="关闭" />
          <button className="minimize" aria-label="最小化" />
          <button className="maximize" aria-label="最大化" disabled />
        </div>
        <span className="wordmark">OpenArc</span>
        <div className="topbar-right">
          <span className="local-tag">本机</span>
          <IconButton label="搜索" size="sm">
            ⌕
          </IconButton>
          <IconButton label="设置" size="sm">
            ⚙
          </IconButton>
        </div>
      </div>

      <div className="assistant-pill" data-ds-id="spec-pill">
        <span>问问 OpenArc</span>
        <span className="pill-status">就绪</span>
      </div>

      <div className="window active" data-ds-id="spec-window" style={{ left: 120, top: 120, width: 520, height: 340 }}>
        <div className="window-title" data-ds-id="spec-titlebar">
          <div className="traffic">
            <button className="close" aria-label="关闭" />
            <button className="minimize" aria-label="最小化" />
            <button className="maximize" aria-label="最大化" />
          </div>
          <span>设置</span>
          <span className="title-meta">本机</span>
        </div>
        <div className="window-body" data-ds-id="spec-windowbody">
          <div className="settings-content">
            <p className="eyebrow">PREFERENCES</p>
            <h1>外观</h1>
            <p className="subtitle">材质档位与主题由用户手动选择。</p>
            <div className="setting-row">
              <span>材质</span>
              <select className="material-select" defaultValue={GLASS}>
                <option value="full">完整玻璃</option>
                <option value="reduced">选择性玻璃</option>
                <option value="solid">实色</option>
              </select>
            </div>
            <div className="setting-row">
              <span>减少动效</span>
              <input type="checkbox" defaultChecked={MOTION === "reduced"} />
            </div>
            <div className="app-grid">
              {["文件", "画布", "Skill"].map((n) => (
                <div className="app-card" key={n} data-ds-id={`spec-card-${n}`}>
                  <strong>{n}</strong>
                  <small>应用卡片（染色面，三档一致）</small>
                </div>
              ))}
            </div>
            <span className="badge">badge</span>
          </div>
        </div>
        <div className="resize" aria-hidden="true" />
      </div>

      <div className="dock" data-ds-id="spec-dock">
        {["◻", "◧", "◨", "◩"].map((g, i) => (
          <div className="dock-item" key={g} data-ds-id={`spec-dockitem-${i}`}>
            <span className="dock-icon" style={{ display: "grid", placeItems: "center", fontSize: 20 }}>
              {g}
            </span>
            <span className="dock-tooltip" data-ds-id="spec-docktooltip">
              应用 {i + 1}
            </span>
            <span className={i === 0 ? "running-dot running" : "running-dot"} />
          </div>
        ))}
        <div className="dock-divider" />
        <div className="dock-item">
          <span className="dock-icon" style={{ display: "grid", placeItems: "center", fontSize: 20 }}>
            ⌫
          </span>
          <span className="dock-tooltip">废纸篓</span>
          <span className="running-dot" />
        </div>
      </div>

      <div className="context-menu" data-ds-id="spec-menu" style={{ left: 140, top: 480 }}>
        <button>新建文件夹</button>
        <button>整理</button>
        <button className="danger">删除</button>
      </div>

      <div className="search-shade" data-ds-id="spec-search" style={{ position: "absolute" }}>
        <div className="search-panel">
          <div className="search-input">
            <input placeholder="搜索应用与文件" readOnly />
            <button>Esc</button>
          </div>
          <button className="search-result" data-ds-id="spec-search-result">
            <span className="result-icon">◻</span>
            <span>文件</span>
            <span className="muted">应用</span>
          </button>
        </div>
      </div>

      <div className="ai-panel" data-ds-id="spec-ai">
        <div className="panel-heading">
          <strong>OpenArc AI</strong>
          <button aria-label="关闭">✕</button>
        </div>
        <div className="ai-intro">
          <h2>后端助手运行框架</h2>
          <p>内核 AI 指的是后端助手运行框架，不是某个大模型。</p>
        </div>
        <div className="connection-card" data-ds-id="spec-connection">
          <h3>模型</h3>
          <p>尚未配置</p>
        </div>
      </div>
    </div>
  );
}

function Root() {
  return (
    <ToastProvider>
      <div
        className={`g-root ${THEME === "dark" ? "dark" : ""} ${MOTION === "reduced" ? "reduced" : ""}`}
        data-ds-theme={THEME}
        data-ds-glass={GLASS}
        data-ds-motion={MOTION}
        data-ds-view={VIEW}
        /* 玻璃档位是**子树级**属性，挂在根上让整棵子树都拿到；
           产品里它挂在 .desktop 上，两者语义相同（tokens.css 用 [data-glass] 选择）。 */
        data-glass={GLASS}
      >
        {VIEW === "desktop" ? (
          <DesktopSpecimens />
        ) : (
          <main className="g-main">
            <header className="g-header">
              <h1>OpenArc Design System v1</h1>
              <p className="g-meta" data-ds-id="g-meta">
                theme={THEME} · glass={GLASS} · motion={MOTION} · view={VIEW}
              </p>
            </header>
            <Primitives />
          </main>
        )}
      </div>
    </ToastProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Root />);
