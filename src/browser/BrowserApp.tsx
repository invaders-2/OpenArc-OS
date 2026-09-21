/**
 * D5-01 · 浏览器窗口内容（标签栏 / 地址栏 / 状态与提示 / 下载面板 / 原生视口）。
 *
 * 三条边界（与 ADR §21 / §34 一致）：
 *   1. **不拥有标签状态**：标签来自 window.meta（Window domain 的唯一权威），
 *      本组件只渲染它并派发 browser/* 命令。
 *   2. **不拥有原生对象**：视口只是 DOM 占位；原生视图由主进程按 windowId/tabId 管理。
 *   3. 运行期事实（loading / 错误 / 下载 / 提示）来自 props —— 它们不是持久化状态。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Download, RotateCw, X, Plus, ShieldAlert, ExternalLink, Globe, Bot } from "lucide-react";
import domain from "../../electron/window-domain.cjs";
import type { Window as WinDomain, WindowCommand } from "../../electron/window-domain.cjs";
import { WebViewport } from "../desktop/components";
import {
  DOWNLOAD_STATE_TEXT,
  EMPTY_TAB_RUNTIME,
  formatBytes,
  tabKey,
  type BrowserNotice,
  type DownloadRecord,
  type TabRuntimeMap,
} from "./types";

type Props = {
  win: WinDomain;
  runtime: TabRuntimeMap;
  downloads: DownloadRecord[];
  notices: BrowserNotice[];
  /** 该窗口此刻的原生视图是否可见（live / clip+snapshot）。 */
  nativeVisible: boolean;
  onCommand: (c: WindowCommand) => void;
  onNavigate: (tabId: string, url: string) => void;
  onAction: (tabId: string, action: "back" | "forward" | "reload" | "stop") => void;
  onBrowser: (command: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onDismissNotice: (id: string) => void;
  /** 下载面板打开时必须让原生视图让位（否则面板被网页盖住，用户点不到）。 */
  onPanelOpenChange?: (open: boolean) => void;
  /**
   * 上报「chrome 之下、网页之上」的 DOM 条带高度（提示条 / 错误条 / 状态行）。
   * 它是**实测**的：原生视图是窗口之上的子视图，不让位就会把提示条整个盖住。
   */
  onViewportReserve?: (windowId: string, reserve: number) => void;
};

const NOTICE_TITLE: Record<BrowserNotice["kind"], string> = {
  popup: "已阻止弹窗",
  external: "外部协议",
  permission: "网站权限",
  blocked: "已阻止导航",
  certificate: "证书错误",
  gone: "网页进程已退出",
};

export function BrowserApp({ win, runtime, downloads, notices, nativeVisible, onCommand, onNavigate, onAction, onBrowser, onDismissNotice, onPanelOpenChange, onViewportReserve }: Props) {
  const tabs = domain.tabsOf(win);
  const activeTabId = domain.activeTabIdOf(win);
  const activeTab = tabs.find((t) => t.tabId === activeTabId) || tabs[0];
  const activeRuntime = activeTab ? runtime[tabKey(win.id, activeTab.tabId)] || EMPTY_TAB_RUNTIME : EMPTY_TAB_RUNTIME;
  const [draft, setDraft] = useState(activeTab?.url || "");
  const [editing, setEditing] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  // 每次渲染后重算一次「视口顶到外壳顶」的距离：提示条/错误条的高度是 DOM 事实，
  // 只有这里知道；值不变时 useDesktop 不会再渲染（不会形成回路）。
  useLayoutEffect(() => {
    const shell = shellRef.current;
    const vp = shell ? shell.querySelector<HTMLElement>(".web-viewport") : null;
    if (!shell || !vp || !onViewportReserve) return;
    const top = Math.round(vp.getBoundingClientRect().top - shell.getBoundingClientRect().top);
    onViewportReserve(win.id, Math.max(0, top - domain.BROWSER_CHROME_H));
  });
  // ---------------------------------------------------------------- D5-01 Closure-2 · AI 控制授权
  // 目标身份与主进程/工具链**同一口径**（windowId#tabId）；这里只显示"哪个标签被授权了"，
  // 授权本身由用户在按钮上显式点击，主进程再校验账号 / 分区归属 / 存活。
  const [controlTargets, setControlTargets] = useState<string[]>([]);
  // 与主进程/原生视图同口径的稳定标签身份（windowId#tabId），不引入第二套命名。
  const viewIdOf = (tabId: string) => (tabId ? `${win.id}#${tabId}` : "");
  const refreshControl = async () => {
    const res = await onBrowser({ type: "browser/controlList" });
    const list = Array.isArray(res?.targets) ? (res.targets as Array<{ viewId?: unknown }>) : [];
    setControlTargets(list.map((t) => String(t?.viewId || "")).filter(Boolean));
  };
  const toggleControl = async (tabId: string) => {
    const authorized = controlTargets.includes(viewIdOf(tabId));
    await onBrowser({ type: authorized ? "browser/controlRelease" : "browser/controlSelect", windowId: win.id, tabId });
    await refreshControl();
  };

  // 地址栏草稿只在"用户没有在输入"时跟随权威 url，避免打字被原生事件打断。
  useEffect(() => {
    if (!editing) setDraft(activeTab?.url || "");
  }, [activeTab?.url, activeTab?.tabId, editing]);

  // 会话级事件（权限 / 证书）没有具体窗口归属（windowId 为空）→ 在浏览器窗口里都显示，
  // 否则用户永远看不到"权限被拒"这条事实。
  const windowNotices = notices.filter((n) => !n.windowId || n.windowId === win.id);

  // 标签增删后重读权威列表（关标签会让主进程摘掉失效目标，UI 不能停在旧状态）。
  const tabIds = tabs.map((t) => t.tabId).join(",");
  useEffect(() => {
    void refreshControl();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.id, tabIds]);

  /** 新标签 id 必须在渲染层生成（reduce 保持纯函数），但状态权威仍是 domain。 */
  const newTabId = () => {
    const seq = Math.max(Number(win.meta.tabSeq) || 0, tabs.length) + 1;
    return `t${seq}`;
  };
  const openTab = (url = "") => onCommand({ type: "browser/tab-open", id: win.id, tabId: newTabId(), url });
  const closeTab = (tabId: string) => {
    // 浏览器语义：关掉最后一个标签 = 关窗口。
    if (tabs.length <= 1) onCommand({ type: "window/close", id: win.id });
    else onCommand({ type: "browser/tab-close", id: win.id, tabId });
  };

  const submit = () => {
    const value = draft.trim();
    if (!value) return;
    onNavigate(activeTab.tabId, value);
    // 提交后退出编辑态：否则地址栏会一直停在"用户正在输入"，
    // 切标签时不再跟随活动标签的权威 url（这是产品缺陷，不是测试问题）。
    setEditing(false);
    inputRef.current?.blur();
  };

  const downloadsButton = (
    <button
      type="button"
      className="addressbar-downloads"
      aria-label="下载"
      aria-expanded={panelOpen}
      data-downloads-toggle
      onClick={() => {
        setPanelOpen((v) => {
          onPanelOpenChange?.(!v);
          return !v;
        });
        // 打开面板时向主进程要一次**本用户**的完整记录（含落盘路径）。
        void onBrowser({ type: "browser/downloads", action: "list" });
      }}
    >
      <Download size={16} />
      {downloads.length ? <span className="badge-count" data-downloads-count>{downloads.length}</span> : null}
    </button>
  );

  return (
    <div className="browser-shell" data-browser-window={win.id} ref={shellRef}>
      <div className="tabstrip" role="tablist" aria-label="浏览器标签">
        {tabs.map((t) => {
          const active = t.tabId === activeTabId;
          const rt = runtime[tabKey(win.id, t.tabId)] || EMPTY_TAB_RUNTIME;
          return (
            <div
              key={t.tabId}
              className={`tab ${active ? "active" : ""}`}
              data-tab={t.tabId}
              data-tab-active={active ? "1" : "0"}
              data-ai-control-authorized={controlTargets.includes(viewIdOf(t.tabId)) ? "1" : "0"}
            >
              <button
                role="tab"
                aria-selected={active}
                className="tab-main"
                title={t.title || t.url || "新标签页"}
                onClick={() => onCommand({ type: "browser/tab-activate", id: win.id, tabId: t.tabId })}
              >
                {rt.loading ? <span className="tab-spinner" data-tab-loading={t.tabId} /> : <Globe size={12} />}
                <span className="tab-title">{t.title || t.url || "新标签页"}</span>
              </button>
              <button className="tab-close" aria-label={`关闭标签 ${t.title || t.tabId}`} onClick={() => closeTab(t.tabId)}>
                <X size={11} />
              </button>
            </div>
          );
        })}
        <button
          className="tab-new"
          aria-label="新建标签"
          data-tab-new
          disabled={tabs.length >= domain.TAB_LIMIT}
          title={tabs.length >= domain.TAB_LIMIT ? `标签数量上限 ${domain.TAB_LIMIT}` : "新建标签"}
          onClick={() => openTab()}
        >
          <Plus size={14} />
        </button>
        <div className="tabstrip-spacer" />
        {downloadsButton}
        <button
          type="button"
          className="addressbar-downloads"
          aria-label={controlTargets.includes(viewIdOf(activeTab.tabId)) ? "撤销 AI 控制该标签" : "允许 AI 控制该标签"}
          title={
            controlTargets.length
              ? "已授权 AI 控制的标签：" + controlTargets.join("、")
              : "未授权任何标签给 AI 控制"
          }
          data-ai-control-toggle
          data-ai-control-state={controlTargets.includes(viewIdOf(activeTab.tabId)) ? "on" : "off"}
          data-ai-control-count={controlTargets.length}
          data-ai-control-view-id={viewIdOf(activeTab.tabId)}
          onClick={() => void toggleControl(activeTab.tabId)}
        >
          <Bot size={16} />
        </button>
      </div>

      <form
        className="addressbar"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <button type="button" aria-label="后退" disabled={!activeRuntime.canGoBack} onClick={() => onAction(activeTab.tabId, "back")}>
          <ArrowLeft size={17} />
        </button>
        <button type="button" aria-label="前进" disabled={!activeRuntime.canGoForward} onClick={() => onAction(activeTab.tabId, "forward")}>
          <ArrowRight size={17} />
        </button>
        <button
          type="button"
          aria-label={activeRuntime.loading ? "停止" : "刷新"}
          data-addressbar-reload={activeRuntime.loading ? "stop" : "reload"}
          onClick={() => onAction(activeTab.tabId, activeRuntime.loading ? "stop" : "reload")}
        >
          {activeRuntime.loading ? <X size={15} /> : <RotateCw size={16} />}
        </button>
        <input
          ref={inputRef}
          aria-label="网页地址"
          placeholder="输入完整地址，例如 https://example.com"
          value={draft}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          onChange={(e) => {
            setEditing(true);
            setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setDraft(activeTab?.url || "");
              setEditing(false);
              inputRef.current?.blur();
            }
          }}
        />
        <button className="primary">打开</button>
      </form>

      {activeRuntime.error ? (
        <div className="browser-error" role="alert" data-browser-error={activeTab.tabId}>
          <ShieldAlert size={14} />
          <span>
            网页加载失败：{activeRuntime.error.message}
            {activeRuntime.error.url ? `（${activeRuntime.error.url}）` : ""}
          </span>
          <button type="button" data-browser-retry onClick={() => onAction(activeTab.tabId, "reload")}>
            重试
          </button>
        </div>
      ) : null}

      {windowNotices.length ? (
        <div className="browser-notices" aria-label="浏览器提示">
          {windowNotices.map((n) => (
            <div className="browser-notice" key={n.id} data-notice-kind={n.kind}>
              <span className="notice-title">{NOTICE_TITLE[n.kind]}</span>
              <span className="notice-text">{n.message}</span>
              {n.kind === "popup" ? (
                <button type="button" onClick={() => { openTab(n.url); onDismissNotice(n.id); }}>
                  在新标签打开
                </button>
              ) : null}
              {n.kind === "popup" || n.kind === "external" ? (
                <button
                  type="button"
                  data-notice-external
                  onClick={() => {
                    // **用户明确确认之后**才交给系统处理（主进程还有 scheme 白名单）。
                    void onBrowser({ type: "browser/openExternal", url: n.url });
                    onDismissNotice(n.id);
                  }}
                >
                  <ExternalLink size={12} /> 用系统应用打开
                </button>
              ) : null}
              {n.kind === "gone" ? (
                <button type="button" onClick={() => onAction(n.tabId || activeTab.tabId, "reload")}>
                  重新加载
                </button>
              ) : null}
              <button type="button" className="ghost" aria-label="关闭提示" onClick={() => onDismissNotice(n.id)}>
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {panelOpen ? (
        <div className="downloads-panel" role="dialog" aria-label="下载" data-downloads-panel>
          <header>
            <strong>下载</strong>
            <button type="button" className="ghost" data-downloads-clear onClick={() => void onBrowser({ type: "browser/downloads", action: "clear" })}>
              清除已完成
            </button>
            <button type="button" className="ghost" aria-label="关闭下载面板" onClick={() => { setPanelOpen(false); onPanelOpenChange?.(false); }}>
              <X size={12} />
            </button>
          </header>
          {downloads.length === 0 ? (
            <p className="muted" data-downloads-empty>
              暂无下载。网页发起的下载会真实保存到本机下载目录。
            </p>
          ) : (
            downloads.map((d) => (
              <div className="download-row" key={d.downloadId} data-download={d.downloadId} data-download-state={d.state}>
                <div className="download-main">
                  <strong title={d.filename}>{d.filename}</strong>
                  <small>
                    {DOWNLOAD_STATE_TEXT[d.state]} · {formatBytes(d.received)}
                    {d.total ? ` / ${formatBytes(d.total)}` : ""}
                  </small>
                  <progress
                    max={d.total || 100}
                    value={d.state === "completed" ? d.total || 100 : d.received}
                    data-download-progress={d.state}
                  />
                  <small className="download-path" title={d.savePath}>
                    {d.savePath}
                  </small>
                </div>
                <div className="download-actions">
                  {d.state === "progressing" ? (
                    <button type="button" onClick={() => void onBrowser({ type: "browser/downloads", action: "cancel", downloadId: d.downloadId })}>
                      取消
                    </button>
                  ) : null}
                  {d.state === "completed" ? (
                    <>
                      <button type="button" data-download-open onClick={() => void onBrowser({ type: "browser/downloads", action: "open", downloadId: d.downloadId })}>
                        打开
                      </button>
                      <button type="button" onClick={() => void onBrowser({ type: "browser/downloads", action: "reveal", downloadId: d.downloadId })}>
                        显示
                      </button>
                    </>
                  ) : null}
                  {d.state !== "progressing" ? (
                    <button type="button" className="ghost" onClick={() => void onBrowser({ type: "browser/downloads", action: "remove", downloadId: d.downloadId })}>
                      移除
                    </button>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      ) : null}

      {/* 集成线的 WebViewport（HEAD）没有 attached prop：这个组件本轮未接线，保持可编译即可。 */}
      <WebViewport nativeVisible={nativeVisible} error={undefined} />
    </div>
  );
}
