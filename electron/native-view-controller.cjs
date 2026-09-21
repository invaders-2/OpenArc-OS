/**
 * D2-02 / D5-01 · Native View Controller。
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
 * D5-01 增量（真实桌面浏览器）：
 *   · **一个标签一个原生视图**（`viewId = windowId#tabId`）。只有活动标签参与遮挡结算，
 *     非活动标签 `setVisible(false)` 但**保持存活** —— 切回不重新加载，页面状态不丢。
 *   · 会话分区按 **App + 用户** 绑定（A04）：切账号拿到的是另一个分区，
 *     Cookie / localStorage / 下载记录不跨用户复用。
 *   · 下载真实落盘并留可投影记录；权限申请显式拒绝并回报；
 *     弹窗 / 外部协议不静默放行，交给 UI 让用户明确选择。
 *
 * 本文件把 Gate 七组探针踩出来的六条硬事实落成实现，每条都有对应断言：
 *
 *   1. `capturePage()` **不包含子视图** → 快照天然就是"网页自己的画面"（00-instrument）
 *   2. `setVisible(false)` 只让焦点落空、**不交还外壳** → 隐藏后必须显式 focus 外壳
 *   3. `setVisible(true)` **不抢焦** → 恢复可见是安全的，不会打断用户当前的输入目标
 *   4. DOM 的 border-radius **不裁**原生视图，但 `View.setBorderRadius` 可以
 *   5. `setBorderRadius` 切掉的区域**仍然接收点击** → 被切区域的点击由 DOM 覆盖块拦
 *   6. 会话按 **App** 绑定分区，不是按 Window（ADR §16；D5-01 再叠加用户维度）
 */
"use strict";

const { WebContentsView, session } = require("electron");
const occlusion = require("./occlusion.cjs");
const { BrowserDownloads } = require("./browser-downloads.cjs");

/** 原生视图圆角 = 窗口外壳圆角（--radius-window: 16px）。 */
const VIEW_RADIUS = 16;

/** 仅允许 http/https —— 与 electron/policy.cjs 的口径一致，不在这里放宽。 */
const safeURL = require("./policy.cjs").safeURL;

/** 快照的字节上限：超过就放弃补齐（宁可整块隐藏，也不把内存吃穿）。 */
const SNAPSHOT_MAX_BYTES = 6 * 1024 * 1024;

/** capturePage 的有界重试（几何刚变过时 UnknownVizError 是瞬时的）。 */
const CAPTURE_RETRIES = 3;
const CAPTURE_RETRY_MS = 40;

/** 视图 id：windowId 自身不含 "#"，因此这个拼接是可逆、无歧义的。 */
const viewIdOf = (windowId, tabId) => String(windowId) + "#" + String(tabId);
/** 派发账本上限（内存，只服务 verify / recovery 的归因，绝不持久化）。 */
const DISPATCH_LEDGER_MAX = 64;

/** 只保留 origin：权限提示要给用户看"哪个站"，但不要把完整 URL（可能带查询串）落进事件。 */
function originOf(url) {
  try {
    return new URL(String(url || "")).origin;
  } catch {
    return "";
  }
}

class NativeViewController {
  /**
   * @param opts.parent    宿主 BrowserWindow 的 contentView
   * @param opts.onFocusShell 需要把键盘交还外壳时调用（由 main 注入 win.webContents.focus）
   * @param opts.onEvent   原生事件回调（导航/加载/标题/下载/权限/弹窗/外部协议）
   * @param opts.downloadsDir 下载根目录（每个用户一个子目录）；缺省时下载不落盘（测试装配用）
   * @param opts.log       日志（可选）
   */
  constructor({ parent, onFocusShell, onEvent, log, downloadsDir = null } = {}) {
    this.parent = parent;
    this.onFocusShell = onFocusShell || (() => {});
    this.onEvent = onEvent || (() => {});
    this.log = log || (() => {});
    /** viewId → { view, windowId, tabId, url, key, snapshots, lastMode } */
    this.entries = new Map();
    /** windowId → 活动 viewId（切标签时由 sync 更新） */
    this.windowActive = new Map();
    /** 已装过分区级策略的 partition（权限 / 下载只装一次） */
    this.partitions = new Set();
    this.destroyed = false;
    /** 派发账本：key = viewId#seq（内存、有界、**活**记录 —— 迟到完成会更新它，冷启动即消失）。 */
    this.dispatches = new Map();
    this.downloads = new BrowserDownloads({ dir: downloadsDir, onEvent: (e) => this.onEvent(e), log: this.log });
  }

  // -------------------------------------------------------------------------
  // 会话分区与策略
  // -------------------------------------------------------------------------

  /**
   * 会话分区（ADR §16 + D5-01 A04）。
   *
   *   · 同一个 App 共享 session（Chrome 同一 profile 的语义，用户预期）；
   *   · **不同用户之间绝不共享**：分区名带用户键，切账号后拿到的是另一个分区，
   *     因此 Cookie / localStorage / IndexedDB / 缓存 / 下载目录都不存在复用。
   *   · 不传 sessionKey 时保持 D2-02 的旧名字（既有探针与契约测试逐字不变）。
   */
  static partitionFor(appId, sessionKey = null) {
    const base = "openarc-app-" + String(appId).replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!sessionKey) return base;
    const user = String(sessionKey).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "anon";
    return base + "-u-" + user;
  }

  /** 分区级策略：权限一律拒绝并回报；下载接住并真实落盘。只装一次。 */
  #installSessionPolicy(sess, { partition, appId, sessionKey }) {
    if (this.partitions.has(partition)) return;
    this.partitions.add(partition);
    const reportedPermissions = new Set();
    sess.setPermissionRequestHandler((wc, permission, callback, details) => {
      // 显式处理而不是静默：先拒绝，再把"哪个站申请了什么"回报给 UI。
      callback(false);
      const origin = originOf(details?.requestingUrl || (wc && wc.getURL && wc.getURL()) || "");
      const key = String(permission) + "|" + String(origin || "");
      if (reportedPermissions.has(key)) return;
      reportedPermissions.add(key);
      const owner = this.#ownerOf(wc);
      this.onEvent({
        type: "permission-denied",
        appId,
        windowId: owner ? owner.windowId : null,
        tabId: owner ? owner.tabId : null,
        permission: String(permission),
        origin,
      });
    });
    // geolocation 一类的同步检查走的是 check handler（request handler 可能根本不被调用），
    // 因此两条路径都要回报，否则"权限被拒"在 UI 上不可见。
    const reported = new Set();
    const reportDenied = (wc, permission, origin) => {
      const key = String(permission) + "|" + String(origin || "");
      if (reported.has(key)) return;
      reported.add(key);
      const owner = this.#ownerOf(wc);
      this.onEvent({
        type: "permission-denied",
        appId,
        windowId: owner ? owner.windowId : null,
        tabId: owner ? owner.tabId : null,
        permission: String(permission),
        origin: originOf(origin),
      });
    };
    sess.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
      reportDenied(wc, permission, requestingOrigin);
      return false;
    });
    if (typeof sess.setDevicePermissionHandler === "function") sess.setDevicePermissionHandler(() => false);
    if (typeof sess.setDisplayMediaRequestHandler === "function")
      sess.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    sess.on("will-download", (_event, item) => {
      this.downloads.attach(item, { sessionKey, appId });
    });
    // 证书错误：**会话级**校验（比 app 级更贴近这条浏览器链），显式拒绝并上报。
    // 没有"继续访问"旁路 —— 一个"信任一次"按钮就是 MITM 的入口。
    if (typeof sess.setCertificateVerifyProc === "function") {
      sess.setCertificateVerifyProc((request, callback) => {
        this.onEvent({
          type: "certificate-error",
          appId,
          url: String(request?.hostname || ""),
          error: String(request?.verificationResult || "CERT_VERIFY_FAILED"),
        });
        callback(-2); // -2 = 拒绝（fail closed）
      });
    }
  }

  // -------------------------------------------------------------------------
  // 原生资源管理
  // -------------------------------------------------------------------------

  #create(intent, viewIntent, sessionKey) {
    const partition = NativeViewController.partitionFor(intent.appId, sessionKey);
    const sess = session.fromPartition(partition);
    this.#installSessionPolicy(sess, { partition, appId: intent.appId, sessionKey });

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
    if (typeof view.setBackgroundColor === "function")
      try {
        view.setBackgroundColor("#00000000");
      } catch {
        /* 透明背景不是硬需求 */
      }

    const entry = {
      viewId: viewIntent.viewId,
      windowId: intent.windowId,
      tabId: viewIntent.tabId,
      appId: intent.appId,
      view,
      url: "",
      title: "",
      /** 会话键（= userId）：受控浏览器能力用它校验"这个标签是否属于当前账号"。 */
      sessionKey: sessionKey ? String(sessionKey) : null,
      key: "",
      snapshots: {},
      lastMode: "",
      /** 当前生效的加载失败（null = 正常）。**只有主进程能正确维护它**：
       *  失败后 Chromium 会加载一个 chrome-error 错误页，该错误页同样会触发
       *  did-finish-load —— 渲染层按事件名判断会把错误横幅错误地清掉（实测抓到过）。 */
      loadError: null,
    };

    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      // 弹窗永不自动开新原生窗口：交给 UI 让用户明确选择（在当前窗口新标签打开 / 用系统浏览器打开）。
      this.onEvent({ type: "popup-blocked", windowId: entry.windowId, tabId: entry.tabId, url: String(url || "") });
      return { action: "deny" };
    });
    for (const name of ["will-navigate", "will-redirect"]) {
      wc.on(name, (e, url) => {
        if (safeURL(url)) return;
        e.preventDefault();
        // 外部协议（mailto: / tel: / 自定义 scheme）不是"被拒绝的网页"，而是需要用户明确确认的动作。
        this.onEvent({
          type: /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(String(url || "")) ? "external-protocol" : "navigate-blocked",
          windowId: entry.windowId,
          tabId: entry.tabId,
          url: String(url || ""),
          scheme: String(url || "").split(":")[0],
        });
      });
    }
    wc.on("will-attach-webview", (e) => e.preventDefault());
    for (const name of [
      "did-navigate",
      "did-navigate-in-page",
      "did-start-loading",
      "did-stop-loading",
      "page-title-updated",
      "did-finish-load",
    ])
      // 注意：**不在这里按事件名清错误**。失败后 Chromium 会自己加载一个错误页，
      // 该错误页同样触发 did-finish-load —— 按事件清会把错误横幅清掉（实测抓到过）。
      // 错误只在"用户显式发起的导航"（navigate / 重试）开始时清除。
      wc.on(name, () => this.#emitState(entry, name));
    wc.on("did-fail-load", (_e, code, description, url, main) => {
      // -3 = ABORTED（用户主动停止/被新导航取代），不是错误状态。
      if (!main || code === -3) return;
      entry.loadError = { code: Number(code), message: String(description || "网页加载失败"), url: String(url || "") };
      this.onEvent({ type: "load-failed", windowId: entry.windowId, tabId: entry.tabId, ...entry.loadError });
      this.#emitState(entry, "did-fail-load");
    });
    wc.on("render-process-gone", (_e, details) => {
      this.onEvent({ type: "render-gone", windowId: entry.windowId, tabId: entry.tabId, reason: String(details?.reason || "") });
    });

    // **必须显式挂到宿主 contentView 上**：WebContentsView 不会自己出现，
    // 缺这一行时 webContents 照常加载（CDP/eval/下载都正常），但屏幕上永远看不到网页 ——
    // 是"状态说 shown、画面里没有"的典型静默失效（本轮由屏幕取证抓到）。
    try {
      this.parent.addChildView(view);
    } catch (e) {
      this.log(`native-view: 挂载失败 ${entry.viewId} ${String((e && e.message) || e)}`);
    }
    this.entries.set(entry.viewId, entry);
    this.log(`native-view: 创建 ${entry.viewId}（分区 ${partition}）`);
    return entry;
  }

  /**
   * 视图是否真的挂在宿主 contentView 上。
   *
   * 缺 addChildView 时 webContents 照常加载（CDP/eval/下载/截图全都正常），
   * 但屏幕上永远没有网页 —— 只靠"加载成功"判断会得到假通过，因此把它作为事实回报出去。
   */
  #isAttached(entry) {
    try {
      return !!this.parent && Array.isArray(this.parent.children) && this.parent.children.includes(entry.view);
    } catch {
      return false;
    }
  }

  /** webContents → 它所属的视图（权限事件是会话级的，需要反查归属）。 */
  #ownerOf(wc) {
    if (!wc || wc.isDestroyed()) return null;
    for (const e of this.entries.values()) if (e.view.webContents === wc) return { windowId: e.windowId, tabId: e.tabId };
    return null;
  }

  #emitState(entry, event = "") {
    const wc = entry.view.webContents;
    if (!wc || wc.isDestroyed()) return;
    const history = wc.navigationHistory;
    this.onEvent({
      type: "native-state",
      windowId: entry.windowId,
      tabId: entry.tabId,
      event,
      url: wc.getURL(),
      loading: wc.isLoading(),
      // entry.title 是受控浏览器能力读取页面信息的来源（与事件同源，避免两处口径）。
      title: (entry.title = wc.getTitle()),
      /** 加载失败由主进程持有（见 entry.loadError 的说明），渲染层只镜像它。 */
      loadError: entry.loadError,
      /** 视图是否真的挂在宿主上（见 #isAttached 的说明）。 */
      attached: this.#isAttached(entry),
      // 前进/后退可用性只有主进程知道（渲染层没有 webContents）。
      canGoBack: typeof history?.canGoBack === "function" ? history.canGoBack() : false,
      canGoForward: typeof history?.canGoForward === "function" ? history.canGoForward() : false,
    });
  }

  /**
   * 关闭并**真正释放**原生资源（§11 第 11 项：关闭后必须真释放，不能留空壳）。
   *
   * 参数既接受 **viewId**（`windowId#tabId`，释放单个标签），
   * 也接受 **windowId**（释放该窗口的全部标签视图）—— D2-02 的探针与契约测试
   * 一直以 windowId 调用它，这条兼容路径是刻意保留的，不是巧合。
   */
  destroy(viewIdOrWindowId) {
    const key = String(viewIdOrWindowId);
    if (!this.entries.has(key) && [...this.entries.values()].some((e) => e.windowId === key)) {
      return this.destroyWindow(key) > 0;
    }
    const e = this.entries.get(key);
    if (!e) return false;
    const viewId = key;
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
    this.entries.delete(viewId);
    if (this.windowActive.get(e.windowId) === viewId) this.windowActive.delete(e.windowId);
    this.log(`native-view: 释放 ${viewId}`);
    return true;
  }

  /** 释放某个窗口的全部标签视图（窗口关闭）。 */
  destroyWindow(windowId) {
    let removed = 0;
    for (const [viewId, e] of [...this.entries]) if (e.windowId === windowId) removed += this.destroy(viewId) ? 1 : 0;
    this.windowActive.delete(String(windowId));
    return removed;
  }

  /**
   * 释放全部视图但**保持控制器可用**。
   *
   * 用在"会话变化"上：上一个用户的网页视图必须立即消失（A04），
   * 但桌面还活着、下一个用户还要继续开新视图 —— 所以不能走 destroyAll()。
   */
  releaseAll() {
    for (const viewId of [...this.entries.keys()]) this.destroy(viewId);
    this.windowActive.clear();
    return true;
  }

  destroyAll() {
    this.releaseAll();
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
    return { entries: this.entries.size, aliveWebContents: alive, windows: this.windowActive.size };
  }

  getIds() {
    return [...this.entries.keys()];
  }

  /** 当前存活视图的安全投影（探测用：验证每标签一个视图、非活动标签保持存活）。 */
  inventory() {
    return [...this.entries.values()].map((e) => ({
      viewId: e.viewId,
      windowId: e.windowId,
      tabId: e.tabId,
      url: e.url,
      title: e.title || "",
      sessionKey: e.sessionKey || null,
      mode: e.lastMode,
      alive: !!(e.view.webContents && !e.view.webContents.isDestroyed()),
    }));
  }

  /** 单个视图的归属投影（受控浏览器能力用它做目标校验）。 */
  ownerOfView(viewId) {
    const e = this.entries.get(String(viewId));
    if (!e) return null;
    const wc = e.view.webContents;
    return {
      viewId: e.viewId,
      windowId: e.windowId,
      tabId: e.tabId,
      sessionKey: e.sessionKey || null,
      url: e.url,
      title: e.title || "",
      alive: !!(wc && !wc.isDestroyed()),
    };
  }

  /**
   * 视图**当前真实文档地址**（不是"意图地址"）。
   *
   * entry.url 在导航请求发出的那一刻就被乐观写成目标值，所以导航前快照与导航后核验
   * 一律只认 webContents.getURL()。视图不存在/已释放返回 null。
   */
  liveUrl(viewId) {
    const e = this.entries.get(String(viewId));
    const wc = e && e.view.webContents;
    return wc && !wc.isDestroyed() ? String(wc.getURL() || "") : null;
  }

  /**
   * 等待真实文档地址落地（受控导航的 READ_AFTER_WRITE 依据）。
   *
   * 落地判据：真实地址既不是导航前地址、又已停止加载；同址导航（地址本来就是要去的地址）
   * 归为 noop —— 它是真实发生的导航请求，但**没有产生地址变化**，如实标记而不是冒充写入。
   * 等不到就返回 unconfirmed：调用方必须按"结果不可知"处理，绝不猜成功。
   */
  /**
   * **派发追踪**（D5-01 Closure-3）。
   *
   * 为什么必须有：只比较"当前 URL == 目标 URL"无法区分
   *   ① 这次受控导航真的落地、② 服务器 302 跳到别处、③ **用户自己**导航到了同一个地址、
   *   ④ 这次导航被别的导航顶掉之后地址恰好等于目标。
   * 因此每次受控导航都记一条 dispatch，其中 **loadURL() 自身 promise 的结果**是关键因果证据
   * （"由这次调用引发的加载完成/被中止"）；did-start-navigation / did-navigate 只作旁证。
   * 这些都只是**内存事实**，不写任何持久化权威，进程重启即消失（那时只能判"不可知"）。
   */
  #trackDispatch(entry, requested) {
    const wc = entry.view.webContents;
    const prior = entry.dispatch;
    // 同标签上的新派发会顶掉旧派发：旧的从此**不许**再声称成功（superseded）。
    if (prior && !prior.settled) prior.superseded = true;
    this.dispatchSeq = (this.dispatchSeq || 0) + 1;
    const dispatch = {
      seq: this.dispatchSeq, viewId: String(entry.viewId), requested: String(requested), from: String((wc && !wc.isDestroyed() && wc.getURL()) || ""),
      at: Date.now(), started: null, commitments: [], loaded: null, loadError: null, superseded: false, settled: false,
    };
    const onStart = (details) => {
      const d = details || {};
      if (d.isMainFrame === false || d.isSameDocument === true) return;
      if (dispatch.started == null) dispatch.started = { url: String(d.url || ""), at: Date.now() };
    };
    const onNavigate = (_ev, navUrl) => {
      const url = String(navUrl || "");
      // 只有导航到**本次请求的地址**才算我们的提交；别人的导航只留旁证（foreignCommit）。
      if (url !== dispatch.requested) { dispatch.foreignCommit = { url, at: Date.now() }; return; }
      dispatch.commitments.push({ url, at: Date.now() });
    };
    dispatch.detach = () => {
      try { wc.removeListener("did-start-navigation", onStart); } catch { /* 视图可能已销毁 */ }
      try { wc.removeListener("did-navigate", onNavigate); } catch { /* 同上 */ }
    };
    try { wc.on("did-start-navigation", onStart); wc.on("did-navigate", onNavigate); } catch { /* 视图已销毁：只剩 loadURL promise 一条证据 */ }
    entry.dispatch = dispatch;
    this.dispatches.set(dispatch.viewId + "#" + dispatch.seq, dispatch);
    while (this.dispatches.size > DISPATCH_LEDGER_MAX) this.dispatches.delete(this.dispatches.keys().next().value);
    return dispatch;
  }

  /** 把 loadURL() 自身 promise 的结果落进 dispatch（成功=这次加载完成；失败=这次加载被中止/失败）。 */
  #settleDispatch(dispatch, promise, wc) {
    Promise.resolve(promise).then(
      // 落地地址在 promise resolve 的**那一刻**取，之后用户再导航也不会改写这条记录。
      () => { const live = wc && !wc.isDestroyed() ? String(wc.getURL() || "") : null; dispatch.loaded = { at: Date.now(), url: live }; dispatch.settled = true; },
      (e) => { dispatch.loadError = String((e && e.code) || (e && e.message) || "LOAD_FAILED"); dispatch.settled = true; },
    ).catch(() => {});
  }

  /**
   * 等**这次派发**的真实结果 —— 三态，绝不猜：
   *   APPLIED       ：这次调用引发的加载真的完成（loadURL promise resolve）；url 与是否重定向如实回报。
   *   NOT_APPLIED   ：能证明没发生（这次加载被中止/失败，且当前真实地址不是目标地址）。
   *   INDETERMINATE ：其它一切（超时、视图消失、被别的导航顶掉后地址恰好等于目标……）。
   * 注意：**地址相等不作为 APPLIED 的依据**。
   */
  async waitForDispatch(viewId, { timeoutMs = 5000 } = {}) {
    const e = this.entries.get(String(viewId));
    if (!e || !e.dispatch) return { verdict: "INDETERMINATE", reason: this.entries.has(String(viewId)) ? "NO_DISPATCH" : "TARGET_GONE" };
    const d = e.dispatch;
    const wc = e.view.webContents;
    const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 5000);
    const live = () => (wc && !wc.isDestroyed() ? String(wc.getURL() || "") : null);
    for (;;) {
      if (d.loaded) {
        const url = live();
        d.detach();
        // loadURL resolve 时文档已可读；万一此刻视图已被销毁，仍以"这次加载完成"为准并如实标注。
        const finalUrl = url == null ? d.requested : url;
        return { verdict: "APPLIED", seq: d.seq, url: finalUrl, requested: d.requested, from: d.from, redirected: finalUrl !== d.requested, noop: finalUrl === d.from };
      }
      if (d.loadError) {
        const url = live();
        d.detach();
        // 能证明"没生效"的必要条件：这次加载被中止**且从未提交过我们的地址**，并且当前地址也不是目标。
        // 三者缺一 → 不可知（绝不猜成功、也不猜没发生）。
        const neverCommitted = d.commitments.length === 0;
        if (neverCommitted && url != null && url !== d.requested) return { verdict: "NOT_APPLIED", seq: d.seq, reason: d.loadError, url, requested: d.requested, foreignCommit: d.foreignCommit || null };
        // 地址恰好等于目标、或我们确实提交过 → 无法归因（可能是用户自己导航过去的），只能判不可知。
        return { verdict: "INDETERMINATE", seq: d.seq, reason: "ABORTED:" + d.loadError, url, requested: d.requested, foreignCommit: d.foreignCommit || null };
      }
      if (!wc || wc.isDestroyed() || this.destroyed) { try { d.detach(); } catch { /* ignore */ } return { verdict: "INDETERMINATE", seq: d.seq, reason: "TARGET_GONE_AFTER_DISPATCH", requested: d.requested }; }
      if (Date.now() >= deadline) return { verdict: "INDETERMINATE", seq: d.seq, reason: "DISPATCH_UNCONFIRMED", url: live(), requested: d.requested, started: d.started };
      await new Promise((r) => setTimeout(r, 50));
    }
  }

/**
   * dispatch 的安全投影（受控导航的 verify / recovery 只读证据）。
   *
   * `seq` 给定时按**这次派发**精确取（即便之后用户又导航过，旧记录仍在）；
   * 不给时取该标签最近一次派发。取不到返回 null —— 调用方必须按"不可知"处理。
   * 返回的是**此刻**的副本：派发之后的迟到完成会体现在下一次调用里。
   */
  dispatchEvidence(viewId, seq = null) {
    const d = seq == null
      ? (this.entries.get(String(viewId)) || {}).dispatch
      : this.dispatches.get(String(viewId) + "#" + String(seq));
    if (!d) return null;
    return { seq: d.seq, viewId: d.viewId, requested: d.requested, from: d.from, at: d.at, started: d.started ? { ...d.started } : null, commitments: d.commitments.slice(-4), foreignCommit: d.foreignCommit ? { ...d.foreignCommit } : null, loaded: d.loaded ? { ...d.loaded } : null, loadError: d.loadError, superseded: !!d.superseded, settled: !!d.settled };
  }

  /**
   * 读取视图正文（受控浏览器能力的**唯一**读取实现）。
   *
   * 只读 `document.body.innerText`：不碰 cookie / localStorage / 凭据，
   * 不在主进程日志里落正文；调用方负责再截断与信任分层。
   */
  async readText(viewId, maxChars = 8000) {
    const e = this.entries.get(String(viewId));
    if (!e) return "";
    const wc = e.view.webContents;
    if (!wc || wc.isDestroyed()) return "";
    const raw = await wc.executeJavaScript("document.body ? String(document.body.innerText || '') : ''", true);
    return String(raw == null ? "" : raw).slice(0, Math.max(0, Number(maxChars) || 0));
  }

  // -------------------------------------------------------------------------
  // 唯一的外部入口
  // -------------------------------------------------------------------------

  async sync(intents, opts = {}) {
    if (this.destroyed) return [];
    const sessionKey = opts.sessionKey || null;

    // 1) 收集本次意图想要的视图集合（D5-01：每个标签一个视图）。
    const wanted = new Map();
    for (const intent of intents) {
      const views =
        Array.isArray(intent.views) && intent.views.length
          ? intent.views
          : [{ viewId: viewIdOf(intent.windowId, "t1"), tabId: "t1", url: intent.url, active: true }];
      let activeViewId = null;
      let firstViewId = null;
      for (const v of views) {
        const viewId = String(v.viewId || viewIdOf(intent.windowId, v.tabId));
        if (!firstViewId) firstViewId = viewId;
        if (v.active) activeViewId = viewId;
        wanted.set(viewId, { intent, viewIntent: { ...v, viewId } });
      }
      this.windowActive.set(intent.windowId, activeViewId || firstViewId);
    }

    // 2) 意图里不再出现的视图 = 窗口/标签已关闭 → 真正释放。
    for (const viewId of this.getIds()) if (!wanted.has(viewId)) this.destroy(viewId);
    // 已关闭的窗口不再保留 active 记录
    for (const windowId of [...this.windowActive.keys()]) if (!intents.some((i) => i.windowId === windowId)) this.windowActive.delete(windowId);

    // 3) 逐窗口结算：活动视图走遮挡四态，非活动视图只加载并隐藏。
    const results = [];
    for (const intent of intents) {
      const activeViewId = this.windowActive.get(intent.windowId);
      let activeResult = null;
      for (const { viewIntent } of [...wanted.values()].filter((x) => x.intent.windowId === intent.windowId)) {
        const entry = this.entries.get(viewIntent.viewId) || this.#create(intent, viewIntent, sessionKey);
        if (viewIntent.viewId === activeViewId) activeResult = await this.#apply(entry, intent, viewIntent, opts);
        else await this.#applyInactive(entry, viewIntent);
      }
      results.push(
        activeResult || { windowId: intent.windowId, mode: "hidden", bounds: null, snapshotRects: [], snapshots: [] },
      );
    }
    return results;
  }

  /** 后台标签：保持存活、加载 URL，但绝不参与遮挡结算与快照。 */
  async #applyInactive(entry, viewIntent) {
    const wc = entry.view.webContents;
    if (!wc || wc.isDestroyed()) return;
    await this.#maybeLoad(entry, viewIntent.url);
    if (entry.lastMode !== "inactive") {
      entry.view.setVisible(false);
      entry.lastMode = "inactive";
    }
  }

  /**
   * 导航：**意图里的 url 是"想要的地址"**，只有它确实不等于当前页面时才加载。
   *
   * 为什么必须有 `wc.getURL() === url` 这道判断：原生回报的 url 会写回 domain，
   * 而 domain 的 url 又会作为意图下传。如果只比较 `entry.url`，一次**失败的导航**
   * （domain 记的是失败地址、页面实际停在上一个地址）就会让两边互相触发，
   * 形成 5391↔5392 的来回加载循环（实测抓到过）。
   */
  async #maybeLoad(entry, url) {
    if (!url || !safeURL(url)) return;
    const wc = entry.view.webContents;
    const live = wc && !wc.isDestroyed() ? wc.getURL() : "";
    if (live === url) {
      // 页面已经在目标地址上：这只是原生回报回灌，不是用户意图 → 不重新加载。
      entry.url = url;
      return;
    }
    if (url === entry.url) return;
    entry.url = url;
    try {
      await entry.view.webContents.loadURL(url);
    } catch (e) {
      // 失败细节由 did-fail-load 统一回报（这里不重复发事件，避免两条口径打架）。
      this.log(`native-view: 加载失败 ${entry.viewId} ${String((e && e.message) || e)}`);
    }
  }

  async #apply(entry, intent, viewIntent, opts) {
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

    await this.#maybeLoad(entry, viewIntent.url);

    const wasVisible = !!entry.lastMode && entry.lastMode !== "hidden" && entry.lastMode !== "inactive";

    /**
     * 收起原生视图并把键盘交还外壳。
     * 事实 2：隐藏只让焦点落空，不交还外壳 —— 必须显式移交。
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
      // **必须先铺满完整视口再取图**（capturePage 的 rect 是页面坐标，页面随视图尺寸重排）。
      view.setBounds(viewport);
      view.setVisible(true);
    }

    if (plan.mode === "snapshot") {
      const snaps = await this.#snapshots(entry, intent, snapshotRects, viewport);
      hide("snapshot");
      return { windowId: intent.windowId, mode: "snapshot", bounds: null, snapshotRects, snapshots: snaps, plan };
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
   * 按快照失效键取图（视口 + 遮挡 + URL 三者都不变就复用）。
   * @param rects  视口坐标下的待补齐矩形（plan.snapshotRects）
   * @param origin 视口原点（capturePage 吃页面坐标，两者相差一个 origin）
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
        const img = await this.#capture(entry, {
          x: Math.round(rect.x - origin.x),
          y: Math.round(rect.y - origin.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
        const png = img.toPNG();
        if (png.length <= SNAPSHOT_MAX_BYTES) dataUrl = "data:image/png;base64," + png.toString("base64");
        else this.log(`native-view: 快照超过上限，放弃补齐 ${entry.viewId}（${png.length} bytes）`);
      } catch (e) {
        // 快照失败不是致命错误：这块退回"看不见网页"。但**必须留下痕迹**。
        this.log(`native-view: 快照失败 ${entry.viewId} ${this.#rectId(rect)}: ${String((e && e.message) || e)}`);
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

  /** 取一张快照，带**有界**重试（UnknownVizError 是瞬时的，但次数必须封顶）。 */
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

  // -------------------------------------------------------------------------
  // 视图动作（属于**标签内部**能力，不是窗口命令）
  // -------------------------------------------------------------------------

  #entryOf(windowId, tabId = null) {
    const viewId = tabId ? viewIdOf(windowId, tabId) : this.windowActive.get(String(windowId));
    return (viewId && this.entries.get(viewId)) || null;
  }

  /** 后退 / 前进 / 刷新（重试）/ 停止。tabId 缺省 = 该窗口的活动标签。 */
  act(windowId, action, tabId = null) {
    const e = this.#entryOf(windowId, tabId);
    if (!e) return { error: "窗口不存在" };
    const wc = e.view.webContents;
    if (!wc || wc.isDestroyed()) return { error: "原生视图已释放" };
    const h = wc.navigationHistory;
    if (action === "back" && h.canGoBack()) h.goBack();
    else if (action === "forward" && h.canGoForward()) h.goForward();
    else if (action === "reload") {
      // "重试"必须重试**失败的地址**：一次 navigation 失败后页面仍停在旧 URL，
      // 裸 wc.reload() 只会把旧页面再加载一遍，用户点了重试却看不到任何变化。
      e.loadError = null;
      this.#emitState(e, "retry");
      const live = wc.getURL();
      if (e.url && e.url !== live) wc.loadURL(e.url).catch(() => {});
      else wc.reload();
    } else if (action === "stop") wc.stop();
    return { ok: true };
  }

  /** 真实网址导航。tabId 缺省 = 该窗口的活动标签。 */
  navigate(windowId, url, tabId = null) {
    const e = this.#entryOf(windowId, tabId);
    if (!e) return { error: "窗口不存在" };
    if (!safeURL(url)) return { error: "请输入完整 HTTP / HTTPS 地址，不支持其他协议或含凭据的网址。" };
    e.loadError = null; // 显式导航：清除上一次的失败状态（重试/换地址都走这里）
    this.#emitState(e, "navigate");
    e.url = url;
    // 派发追踪：loadURL() 自己的 promise 是"这次调用引发的加载"的因果证据，绝不静默吞掉。
    const dispatch = this.#trackDispatch(e, url);
    this.#settleDispatch(dispatch, e.view.webContents.loadURL(String(url)), e.view.webContents);
    return { ok: true, seq: dispatch.seq };
  }

  /** 用系统默认应用打开外部协议 / 系统浏览器（**必须由 UI 在用户确认后调用**）。 */
  openExternal(url) {
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(String(url || ""))) return { error: "不支持的地址" };
    require("electron").shell.openExternal(String(url)).catch(() => {});
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // 下载（按会话键隔离，见 browser-downloads.cjs）
  // -------------------------------------------------------------------------

  listDownloads(sessionKey) {
    return this.downloads.list(sessionKey);
  }

  downloadAction(action, downloadId, sessionKey) {
    return this.downloads.act(action, downloadId, sessionKey);
  }

  clearDownloads(sessionKey) {
    return this.downloads.clear(sessionKey);
  }
}

module.exports = { NativeViewController, VIEW_RADIUS, SNAPSHOT_MAX_BYTES, viewIdOf };
