/**
 * D2-02 · Native View Controller。
 *
 * **职责边界（ADR §35）：它只管原生资源，不拥有任何 Window domain 业务规则。**
 * 它不知道"窗口该不该存在""谁该被聚焦""z-order 是什么" ——
 * 那些由 Window Manager 决定，通过 `sync(intents)` 传进来。
 * 它只回答一个问题：**"拿到这些意图之后，原生对象该以什么形态存在"**。
 *
 * 形态由 electron/occlusion.cjs 的 plan() 结算，四态：
 *   live          视口整块实时（原生像素）
 *   clip+snapshot 收缩到最大空闲矩形做实况，其余区域由快照补齐
 *   snapshot      原生视图收起，整块由快照占位（空闲区域太小或当前不可交互）
 *   hidden        整块隐藏且不出快照（最小化 / 系统级覆盖层打开）
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

/**
 * capturePage 的重试上限与间隔。
 *
 * 实测（experiments/d2-02/native-view-controller 探针）：视图几何刚变过时立刻取图，
 * Chromium 会抛 `UnknownVizError` —— 合成器还没为新区域产出帧。
 * 一次失败就把 dataUrl 留成 null 的后果是"这块区域永远补不上图"，
 * 而失败本身是瞬时的。因此这里做**有界**重试（总开销 ≤ 约 80ms，不会拖住 sync）。
 */
const CAPTURE_RETRIES = 3;
const CAPTURE_RETRY_MS = 40;

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
    // 修复（showcase 像素级截图抓出）：视图必须挂进窗口树。
    // 没有 addChildView 时它是一个"孤儿视图"——url/title/bounds/visible 全部正常，
    // 但永不显示（D1-01/D2-02 的验收只断言了 API 状态，未断言像素，因此未暴露）。
    if (this.parent && !this.destroyed) this.parent.addChildView(view);
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
    this.entries.set(intent.windowId, { view, url: "", key: "", snapshots: {}, lastMode: "" });
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
    // 父窗口已关，控制器不再可用。不置位的话后续 sync 会在已销毁的宿主上重建视图。
    this.destroyed = true;
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
      return { windowId: intent.windowId, mode: "closed", snapshotRects: [] };
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

    const wasVisible = entry.lastMode && entry.lastMode !== "hidden";

    /**
     * 收起原生视图并把键盘交还外壳。
     *
     * 事实 2：隐藏只让焦点落空，不交还外壳 —— 必须显式移交，
     * 否则后果不是"焦点留在网页"，而是"键盘没有人收到"。
     * 事实 3：恢复可见不抢焦，因此这条移交只发生在真正收起的时候。
     */
    const hide = (mode) => {
      const hadFocus = wasVisible && wc.isFocused();
      view.setVisible(false);
      entry.lastMode = mode;
      if (hadFocus) this.onFocusShell();
    };

    if (plan.mode === "hidden") {
      hide("hidden");
      return { windowId: intent.windowId, mode: "hidden", bounds: viewport, snapshotRects: [], plan };
    }

    const snapshotRects = plan.snapshotRects || [];

    if (snapshotRects.length) {
      // **必须先铺满完整视口再取图。**
      // capturePage 的 rect 是页面坐标，而 WebContentsView 里的页面会随视图尺寸重排：
      // 先收缩到 plan.bounds 再取补丁，补丁那块区域在页面里已经不存在了，
      // 取到的只能是一张空图（探针抓到的第二个快照缺陷）。
      view.setBounds(viewport);
      view.setVisible(true);
    }

    if (plan.mode === "snapshot") {
      // 「整块改用快照」= 这块区域没有任何活动像素。
      // 另外 plan.bounds 在这个分支里是 null，直接 setBounds(null) 会抛
      // "conversion failure from null" 并把整次 sync 打断。
      const snaps = await this.#snapshots(entry, intent, snapshotRects, viewport);
      hide("snapshot");
      return {
        windowId: intent.windowId,
        mode: "snapshot",
        bounds: null,
        snapshotRects,
        snapshots: snaps,
        plan,
      };
    }

    // clip+snapshot：先取补丁，再收缩到最大空闲矩形
    const snaps = await this.#snapshots(entry, intent, snapshotRects, viewport);
    view.setBounds(plan.bounds);
    view.setVisible(true);
    entry.lastMode = plan.mode;
    return {
      windowId: intent.windowId,
      mode: plan.mode,
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
   *
   * @param rects  **视口坐标**下的待补齐矩形（plan.snapshotRects）
   * @param origin 视口原点。capturePage 吃的是页面坐标，两者相差一个 origin ——
   *               视图正好铺在视口上，因此页面坐标 = 视口坐标 - 原点。
   *               返回给渲染层的 rect 仍然是视口坐标（DOM 侧按窗口 bounds 取偏移）。
   */
  async #snapshots(entry, intent, rects, origin) {
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
        // capturePage 的 rect 是**页面坐标**，返回的 NativeImage 是物理像素，
        // 但这里只把它编码成 PNG 交给 DOM 拉伸，因此不需要 scale 换算。
        const img = await this.#capture(entry, {
          x: Math.round(rect.x - origin.x),
          y: Math.round(rect.y - origin.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
        const png = img.toPNG();
        if (png.length <= SNAPSHOT_MAX_BYTES) dataUrl = "data:image/png;base64," + png.toString("base64");
        else this.log(`native-view: 快照超过上限，放弃补齐 ${intent.windowId}（${png.length} bytes）`);
      } catch (e) {
        // 快照失败不是致命错误：这一块退回"看不见网页"，由渲染层决定是否整块隐藏。
        // 但**必须留下痕迹** —— 静默吞掉会让"DOM 侧永远补不上图"变成无从排查的现象。
        this.log(`native-view: 快照失败 ${intent.windowId} ${this.#rectId(rect)}: ${String((e && e.message) || e)}`);
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

  /**
   * 取一张快照，带**有界**重试。
   *
   * `UnknownVizError` 在视图几何刚变过时是瞬时的（合成器还没为新区域产出帧），
   * 因此重试有效；但它也可能是确定性的（区域真的不可合成），
   * 所以次数必须封顶，不能无限等。
   */
  async #capture(entry, rect) {
    let last = null;
    for (let attempt = 1; attempt <= CAPTURE_RETRIES; attempt += 1) {
      try {
        return await entry.view.webContents.capturePage(rect);
      } catch (e) {
        last = e;
        if (attempt < CAPTURE_RETRIES) await new Promise((r) => setTimeout(r, CAPTURE_RETRY_MS));
      }
    }
    throw last;
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
