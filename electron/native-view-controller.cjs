/**
 * D2-02 · Native View Controller。
 *
 * **职责边界（ADR §35）：它只管原生资源，不拥有任何 Window domain 业务规则。**
 * 它不知道"窗口该不该存在""谁该被聚焦""z-order 是什么" ——
 * 那些由 Window Manager 决定，通过 `sync(intents)` 传进来。
 * 它只回答一个问题：**"拿到这些意图之后，原生对象该以什么形态存在"**。
 *
 * 形态由 electron/occlusion.cjs 的 plan() 结算，四态：
 *   live          视口整块实时
 *   clip+snapshot 收缩到最大空闲矩形，其余区域由快照补齐
 *   snapshot      整块改用快照
 *   hidden        整块隐藏（最小化 / 系统级覆盖层打开）
 *
 * 本文件把 Gate 七组探针踩出来的六条硬事实落成实现，每条都有对应断言：
 *
 *   1. `capturePage()` **不包含子视图** → 快照天然就是"网页自己的画面"，
 *      正好是我们要贴回 DOM 的东西（见 00-instrument）
 *   2. `setVisible(false)` 只让焦点落空、**不交还外壳** → 隐藏后必须显式 focus 外壳
 *      （见 inst.hideDoesNotTransferFocus / input.dialog.hideAndRefocusRestoresKeyboardToDom）
 *   3. `setVisible(true)` **不抢焦** → 恢复可见是安全的，不会打断用户当前的输入目标
 *      （见 inst.reshowDoesNotStealFocus）
 *   4. DOM 的 border-radius **不裁**原生视图，但 `View.setBorderRadius` 可以 →
 *      圆角必须由原生侧修（见 occl.corner.*）
 *   5. `setBorderRadius` 切掉的区域**仍然接收点击** → 视觉修好不等于交互修好，
 *      被切区域的点击由 DOM 覆盖块拦（ADR §13）
 *   6. 会话按 **App** 绑定分区，不是按 Window（ADR §16）
 */
"use strict";

const { WebContentsView, session } = require("electron");
const occlusion = require("./occlusion.cjs");

/** 原生视图圆角 = 窗口外壳圆角（--radius-window: 16px）。 */
const VIEW_RADIUS = 16;

/** 仅允许 http/https —— 与 electron/policy.cjs 的口径一致，不在这里放宽。 */
const safeURL = require("./policy.cjs").safeURL;

/** 快照的字节上限：超过就放弃补齐（宁可整块隐藏，也不把内存吃穿）。 */
const SNAPSHOT_MAX_BYTES = 6 * 1024 * 1024;

class NativeViewController {
  /**
   * @param opts.parent    宿主 BrowserWindow 的 contentView
   * @param opts.onFocusShell 需要把键盘交还外壳时调用（由 main 注入 win.webContents.focus）
   * @param opts.onEvent   原生事件回调（导航/加载/标题），由 main 转发给渲染进程
   * @param opts.log       日志（可选）
   */
  constructor({ parent, onFocusShell, onEvent, log } = {}) {
    this.parent = parent;
    this.onFocusShell = onFocusShell || (() => {});
    this.onEvent = onEvent || (() => {});
    this.log = log || (() => {});
    /** windowId → { view, url, key, snapshots: {rectKey: dataUrl} } */
    this.entries = new Map();
    this.destroyed = false;
  }

  // -------------------------------------------------------------------------
  // 原生资源管理
  // -------------------------------------------------------------------------

  static partitionFor(appId) {
    // §16 冻结：同一个 OpenArc App 默认共享其 session。
    return "openarc-app-" + String(appId).replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  #create(intent) {
    const partition = NativeViewController.partitionFor(intent.appId);
    const sess = session.fromPartition(partition);
    // 分区级策略跟着分区走，不依赖调用顺序：新建分区时立刻装上。
    sess.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    sess.setPermissionCheckHandler(() => false);

    const view = new WebContentsView({
      webPreferences: {
        session: sess,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    view.setBorderRadius(VIEW_RADIUS);
    view.setVisible(false);
    // setBackgroundColor 是 View 的较新 API：存在才调用，避免旧版本直接抛异常。
    if (typeof view.setBackgroundColor === "function")
      try {
        view.setBackgroundColor("#00000000");
      } catch {
        /* 透明背景不是硬需求 */
      }

    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      this.onEvent({ type: "popup-blocked", windowId: intent.windowId, url });
      return { action: "deny" };
    });
    for (const name of ["will-navigate", "will-redirect"])
      wc.on(name, (e, url) => {
        if (!safeURL(url)) {
          e.preventDefault();
          this.onEvent({ type: "navigate-blocked", windowId: intent.windowId, url });
        }
      });
    wc.on("will-attach-webview", (e) => e.preventDefault());
    for (const name of [
      "did-navigate",
      "did-navigate-in-page",
      "did-start-loading",
      "did-stop-loading",
      "page-title-updated",
      "did-finish-load",
    ])
      wc.on(name, () => this.#emitState(intent.windowId));
    wc.on("did-fail-load", (_e, code, description, _url, main) => {
      if (main && code !== -3)
        this.onEvent({ type: "load-failed", windowId: intent.windowId, message: description });
    });

    // 父窗口关闭时由 destroyAll() 统一释放，这里不重复挂。
    this.entries.set(intent.windowId, { view, url: "", key: "", snapshots: {} });
    this.log(`native-view: 创建 ${intent.windowId}（分区 ${partition}）`);
    return this.entries.get(intent.windowId);
  }

  #emitState(windowId) {
    const e = this.entries.get(windowId);
    if (!e) return;
    const wc = e.view.webContents;
    if (!wc || wc.isDestroyed()) return;
    this.onEvent({
      type: "native-state",
      windowId,
      url: wc.getURL(),
      loading: wc.isLoading(),
      title: wc.getTitle(),
    });
  }

  /** 关闭并**真正释放**原生资源（§11 第 11 项：关闭后必须真释放，不能留空壳）。 */
  destroy(windowId) {
    const e = this.entries.get(windowId);
    if (!e) return false;
    const wc = e.view.webContents;
    try {
      if (this.parent && e.view) this.parent.removeChildView(e.view);
    } catch {
      /* 视图可能已随父窗口一起销毁 */
    }
    try {
      if (wc && !wc.isDestroyed()) wc.close();
    } catch {
      /* close 期间的竞态忽略 */
    }
    this.entries.delete(windowId);
    this.log(`native-view: 释放 ${windowId}`);
    return true;
  }

  destroyAll() {
    for (const id of [...this.entries.keys()]) this.destroy(id);
  }

  /** 资源现状（供探针断言"DOM 关了但 WebContentsView 还活着"不存在）。 */
  stats() {
    let alive = 0;
    for (const e of this.entries.values()) {
      const wc = e.view.webContents;
      if (wc && !wc.isDestroyed()) alive += 1;
    }
    return { entries: this.entries.size, aliveWebContents: alive };
  }

  getIds() {
    return [...this.entries.keys()];
  }

  // -------------------------------------------------------------------------
  // 唯一的外部入口
  // -------------------------------------------------------------------------

  /**
   * 按意图结算原生形态。
   *
   * @param intents 由 manager.nativeIntents(state, host) 产出
   * @param opts.overlayOpen 系统级覆盖层（Dialog / Search / AI 面板）是否打开
   * @param opts.interactive 允许"收缩 + 快照"（拖动中允许，按键输入中不允许）
   * @returns 每个窗口的结算结果，渲染进程照此贴快照
   */
  async sync(intents, opts = {}) {
    if (this.destroyed) return [];
    const wanted = new Set(intents.map((i) => i.windowId));
    // 意图里不再出现的窗口 = 已关闭 → 真正释放
    for (const id of this.getIds()) if (!wanted.has(id)) this.destroy(id);

    const results = [];
    for (const intent of intents) {
      const e = this.entries.get(intent.windowId) || this.#create(intent);
      results.push(await this.#apply(e, intent, opts));
    }
    return results;
  }

  async #apply(entry, intent, opts) {
    const { view } = entry;
    const wc = view.webContents;
    if (!wc || wc.isDestroyed()) {
      return { windowId: intent.windowId, strategy: "closed", snapshotRects: [] };
    }

    const viewport = intent.viewport;
    const plan = occlusion.plan({
      viewport,
      occluders: intent.occluders,
      minimized: !intent.present,
      overlayOpen: !!opts.overlayOpen,
      interactive: opts.interactive !== false,
    });

    // 导航：意图里的 url 变了就加载（只有明确的 http/https 才放行）
    if (intent.url && intent.url !== entry.url && safeURL(intent.url)) {
      entry.url = intent.url;
      try {
        await wc.loadURL(intent.url);
      } catch {
        this.onEvent({ type: "load-failed", windowId: intent.windowId, message: "网页加载失败" });
      }
    }

    const wasVisible = entry.lastStrategy && entry.lastStrategy !== "hidden";

    if (plan.strategy === "hidden") {
      if (wasVisible) {
        // 事实 2：隐藏只让焦点落空，不交还外壳 —— 必须显式移交，
        // 否则后果不是"焦点留在网页"，而是"键盘没有人收到"。
        const hadFocus = wc.isFocused();
        view.setVisible(false);
        entry.lastStrategy = "hidden";
        if (hadFocus) this.onFocusShell();
      } else {
        view.setVisible(false);
        entry.lastStrategy = "hidden";
      }
      return { windowId: intent.windowId, strategy: "hidden", bounds: viewport, snapshotRects: [], plan };
    }

    view.setBounds(plan.bounds);
    view.setVisible(true);
    entry.lastStrategy = plan.strategy;

    // 需要补齐的区域 → 取快照（capturePage 不含子视图，所以拿到的正是"网页自己的画面"）
    const snapshotRects = plan.snapshotRects || [];
    const snaps = await this.#snapshots(entry, intent, snapshotRects);
    return {
      windowId: intent.windowId,
      strategy: plan.strategy,
      bounds: plan.bounds,
      snapshotRects,
      snapshots: snaps,
      plan,
    };
  }

  /**
   * 按快照失效键取图。
   *
   * `snapshotKey` 是"视口 + 遮挡 + URL"，三者都不变就复用上一张 ——
   * 否则拖动窗口时每一帧都要重拍一次，成本会失控（05-snapshot 的
   * snap.staleSnapshotDetectable 证明不重取会留旧画面，但重取必须有闸门）。
   */
  async #snapshots(entry, intent, rects) {
    if (!rects.length) {
      entry.key = "";
      entry.snapshots = {};
      return [];
    }
    const key = occlusion.snapshotKey({
      viewport: intent.viewport,
      occluders: intent.occluders,
      url: entry.url || intent.url || "",
    });
    const cacheKey = `${key}|${rects.map((r) => `${r.x},${r.y},${r.width},${r.height}`).join(";")}`;
    if (entry.key === cacheKey && Object.keys(entry.snapshots).length) {
      return rects.map((r) => ({ rect: r, dataUrl: entry.snapshots[this.#rectId(r)], cached: true }));
    }

    const out = [];
    const next = {};
    for (const rect of rects) {
      let dataUrl = null;
      try {
        // capturePage 的 rect 用 DIP；返回的 NativeImage 是物理像素，
        // 但这里只把它编码成 PNG 交给 DOM 拉伸，因此不需要 scale 换算。
        const img = await entry.view.webContents.capturePage(rect);
        const png = img.toPNG();
        if (png.length <= SNAPSHOT_MAX_BYTES) dataUrl = "data:image/png;base64," + png.toString("base64");
      } catch {
        /* 快照失败不是致命错误：这一块退回"看不见网页"，由渲染层决定是否整块隐藏 */
      }
      out.push({ rect, dataUrl, cached: false });
      next[this.#rectId(rect)] = dataUrl;
    }
    entry.key = cacheKey;
    entry.snapshots = next;
    return out;
  }

  #rectId(r) {
    return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
  }

  /** 主动作：后退 / 前进 / 刷新。属于**视图内部**能力，不是窗口命令。 */
  act(windowId, action) {
    const e = this.entries.get(windowId);
    if (!e) return { error: "窗口不存在" };
    const wc = e.view.webContents;
    if (!wc || wc.isDestroyed()) return { error: "原生视图已释放" };
    const h = wc.navigationHistory;
    if (action === "back" && h.canGoBack()) h.goBack();
    else if (action === "forward" && h.canGoForward()) h.goForward();
    else if (action === "reload") wc.reload();
    return { ok: true };
  }

  navigate(windowId, url) {
    const e = this.entries.get(windowId);
    if (!e) return { error: "窗口不存在" };
    if (!safeURL(url)) return { error: "请输入完整 HTTP / HTTPS 地址，不支持其他协议或含凭据的网址。" };
    e.url = url;
    entryLoad(e, url);
    return { ok: true };
  }
}

function entryLoad(entry, url) {
  const wc = entry.view.webContents;
  if (!wc || wc.isDestroyed()) return;
  wc.loadURL(url).catch(() => {});
}

module.exports = { NativeViewController, VIEW_RADIUS, SNAPSHOT_MAX_BYTES };
