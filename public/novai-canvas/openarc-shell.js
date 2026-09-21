/**
 * OpenArc · NOVAI 完整应用外壳中继（**只注入入口 index.html**，紧跟 openarc-bridge.js 之后）。
 *
 * 为什么需要中继：外壳页自己跑在 OpenArc 宿主的 sandbox iframe 里，产品子页又是外壳页里的 iframe：
 *   子页(canvas.html/home.html/…) → 外壳(index.html) → OpenArc 宿主，宿主回包按来源路由回去。
 *
 * 中继协议（**逐项限定，不做通用转发**）：
 *   · 子页 → 外壳（dir: canvas->host）
 *       hello-request                                  → 回 hello（token 恒为 null，子页拿不到宿主 token）
 *       call{id:number, method, params}                → 重写为 id:"f<帧号>:<原 id>" 后转发给宿主，并记路由
 *       adapter-ready / adapter-timeout / state / command-result / blocked / abort / notice
 *                                                      → 原样转发（附 frame:"f<帧号>"），宿主据此绑定/呈现
 *     其他 kind / 其他窗口（非本页 iframe）的消息一律忽略。
 *   · 宿主 → 外壳（dir: host->canvas）
 *       hello / context                                → 存 token 与只读上下文，并广播给全部子页
 *       result{id:"f<帧号>:<原 id>"}                    → 只回给发起那次调用的那一帧
 *       command / undo / redo / state-request / 文档刷新 → 只发给**当前画布帧**（没有就明确回错）
 *   · token 只由外壳持有并在转发时附加；宿主仍只接受 event.source === 外壳帧 且 token 匹配的消息。
 */
(function () {
  "use strict";
  var CH = "openarc.canvas";
  var atTop = false;
  try { atTop = window.top === window.self; } catch (e) { atTop = true; }
  if (atTop) return; // 只有被宿主直接加载的外壳帧才当中继

  var accountKey = (function () {
    try { var m = /(?:^|[#&])oa=([A-Za-z0-9_-]{4,64})/.exec(String(window.location.hash || "")); return m ? m[1] : "anon"; } catch (e) { return "anon"; }
  })();
  var hostFrame = null;
  try { hostFrame = window.parent; } catch (e) { hostFrame = null; }

  var token = null;
  var context = { readOnly: true, canEdit: false, canvasId: null, models: null };
  var fidOf = new WeakMap();
  var byFid = {};
  var nextFid = 0;
  var relayPending = new Map(); // relayId -> { fid, id }
  var canvasFid = null;
  /** 宿主握手还没完成时，子页的调用先排队（有上限），拿到 token 后按顺序补发，绝不静默当成成功。*/
  var queued = [];

  function flushQueued() {
    while (queued.length) {
      var item = queued.shift();
      if (Date.now() - item.at > 10000) { childPost(item.fid, { kind: "result", id: item.id, ok: false, error: { error: "CANVAS_HOST_NOT_READY", message: "OpenArc 宿主尚未就绪" } }); continue; }
      forwardCall(item.fid, item.id, item.d);
    }
  }
  function forwardCall(fid, childId, d) {
    var relayId = "f" + fid + ":" + childId;
    relayPending.set(relayId, { fid: fid, id: childId });
    hostPost({ kind: "call", id: relayId, method: d.method, params: d.params || {}, token: token, frame: "f" + fid });
  }

  function hostPost(msg) {
    if (!hostFrame) return;
    try { hostFrame.postMessage(Object.assign({ ch: CH, dir: "canvas->host", top: false }, msg), "*"); } catch (e) { /* 宿主不在 */ }
  }
  function childPost(fid, msg) {
    var w = byFid[fid];
    if (!w) return;
    try { w.postMessage(Object.assign({ ch: CH, dir: "host->canvas" }, msg), "*"); } catch (e) { /* 帧已销毁 */ }
  }
  function frames() { return document.querySelectorAll("iframe"); }
  function idFor(src) {
    if (!src) return 0;
    var list = frames();
    for (var i = 0; i < list.length; i++) {
      var w = null;
      try { w = list[i].contentWindow; } catch (e) { continue; }
      if (w && w === src) {
        if (!fidOf.has(w)) { nextFid += 1; fidOf.set(w, nextFid); byFid[nextFid] = w; }
        return fidOf.get(w);
      }
    }
    return 0;
  }
  function urlOf(fid) { try { return String(byFid[fid].location.href || ""); } catch (e) { return ""; } }
  function urlOfEl(el) { try { return String((el && el.contentWindow && el.contentWindow.location.href) || ""); } catch (e) { return ""; } }

  // 上游首页→"打开某个项目"的链路有个已知缺口：外壳只在 switchUI 之后 300ms 用
  // postMessage({type:'open-canvas'}) 通知画布列表页，而**列表页只在本地有待导入图片时才理它**
  // （canvas-list.html 的 open-canvas 监听只服务 hp_pending_import）。
  // 也就是说上游本身"点最近项目 = 只打开画布管理器，不会打开那一本"。
  // 这里在集成层补齐：拿到 canvasId 后直接驱动 frame-canvas 打开**那一本**画布编辑器。
  var pendingOpen = null;
  var pendingOpenAt = 0;
  function armPendingOpen(canvasId) { pendingOpen = String(canvasId || "") || null; pendingOpenAt = Date.now(); applyPendingOpen(); }
  function canvasUrl(canvasId) {
    return "/static/canvas.html?id=" + encodeURIComponent(String(canvasId)) + "&project=default&t=" + Date.now() + "#oa=" + accountKey;
  }
  function applyPendingOpen() {
    if (!pendingOpen) return;
    var waited = Date.now() - pendingOpenAt;
    if (waited > 20000) { pendingOpen = null; return; }
    var frame = document.getElementById("frame-canvas");
    if (!frame) return;
    var id = pendingOpen;
    var url = urlOfEl(frame);
    if (isCanvasUrl(url)) {
      pendingOpen = null;
      // 已经是那一本就不动；是别的画布则换成目标那一本（上游只会打开"上一次"的那一本）。
      if (url.indexOf(encodeURIComponent(id)) < 0) frame.src = canvasUrl(id);
      return;
    }
    // 画布列表页/空白页：外壳自己的 switchUI 会先把列表页装进来，这里等它一步，
    // 然后**直接驱动 frame-canvas 打开目标画布**（上游的 open-canvas 消息只服务"首页待导入图片"，不认 canvasId）。
    if (/canvas-list\.html/.test(url) || waited > 1500) {
      pendingOpen = null;
      frame.src = canvasUrl(id);
    }
  }
  function isCanvasUrl(u) { return /\/canvas\.html(\?|#|$)/.test(u); }
  function currentCanvasFid() {
    for (var k in byFid) { if (isCanvasUrl(urlOf(Number(k)))) return Number(k); }
    return null;
  }

  // ── 宿主 → 外壳 ─────────────────────────────────────────────────────────────
  function handleHost(d) {
    if (d.kind === "hello") {
      token = d.token || null;
      context = { readOnly: !!d.readOnly, canEdit: !!d.canEdit, canvasId: d.canvasId || null, models: d.models || null };
      broadcast({ kind: "hello", token: null, readOnly: context.readOnly, canEdit: context.canEdit, canvasId: context.canvasId, models: context.models, account: d.account || null, accountKey: d.accountKey || accountKey, via: "relay" });
      flushQueued();
      return;
    }
    if (d.kind === "context") {
      context.readOnly = !!d.readOnly;
      context.canEdit = !!d.canEdit;
      if (d.canvasId) context.canvasId = d.canvasId;
      broadcast({ kind: "context", readOnly: context.readOnly, canEdit: context.canEdit, canvasId: context.canvasId, accountKey: d.accountKey || accountKey });
      return;
    }
    if (d.kind === "result" && typeof d.id === "string") {
      var m = /^f(\d+):(\d+)$/.exec(d.id);
      if (!m) return;
      var entry = relayPending.get(d.id);
      if (entry) relayPending.delete(d.id);
      var fid = entry ? entry.fid : Number(m[1]);
      var childId = entry ? entry.id : Number(m[2]);
      childPost(fid, { kind: "result", id: childId, ok: d.ok, value: d.value, error: d.error });
      return;
    }
    if (d.kind === "command" || d.kind === "undo" || d.kind === "redo" || d.kind === "state-request" || d.kind === "reload-doc") {
      var target = canvasFid || currentCanvasFid();
      if (!target) {
        hostPost({ kind: "command-result", id: d.id, frame: null, ok: false, error: { error: "CANVAS_NOT_OPEN", message: "当前没有打开的画布页" } });
        return;
      }
      childPost(target, d);
      return;
    }
    if (d.kind === "open-canvas") {
      var cid = String(d.canvasId || "");
      if (cid) { pendingOpen = null; openCanvas(cid); }
      return;
    }
  }

  function broadcast(msg) { for (var k in byFid) childPost(Number(k), msg); }

  /** 宿主工具条"打开某一本画布"：驱动外壳自己的导航（画布列表 iframe 换成编辑器）。*/
  function openCanvas(canvasId) {
    var frame = document.getElementById("frame-canvas");
    if (!frame) return false;
    var url = canvasUrl(canvasId);
    try {
      var trigger = document.querySelector("[onclick*=\"'canvas'\"],[onclick*='\"canvas\"']");
      if (typeof window.switchUI === "function") window.switchUI(trigger, "canvas", { skipRemember: false });
      frame.src = url;
    } catch (e) {
      try { frame.src = url; } catch (e2) { return false; }
    }
    return true;
  }

  // ── 子页 → 外壳 ─────────────────────────────────────────────────────────────
  function handleChild(fid, d) {
    if (d.kind === "hello-request") {
      if (isCanvasUrl(urlOf(fid))) canvasFid = fid;
      childPost(fid, { kind: "hello", token: null, readOnly: context.readOnly, canEdit: context.canEdit, canvasId: context.canvasId, models: context.models, accountKey: accountKey, via: "relay" });
      return;
    }
    if (d.kind === "call" && typeof d.id === "number" && d.method) {
      if (!token) { queued.push({ fid: fid, id: d.id, d: d, at: Date.now() }); if (queued.length > 60) queued.shift(); return; }
      forwardCall(fid, d.id, d);
      return;
    }
    if (d.kind === "adapter-ready" || d.kind === "adapter-timeout") {
      if (d.kind === "adapter-ready" && isCanvasUrl(urlOf(fid))) canvasFid = fid;
      hostPost({ kind: d.kind, id: d.id, state: d.state || null, frame: "f" + fid, url: urlOf(fid) });
      return;
    }
    if (d.kind === "command-result" || d.kind === "state" || d.kind === "blocked" || d.kind === "abort" || d.kind === "notice") {
      hostPost({ kind: d.kind, id: d.id, ok: d.ok, value: d.value, error: d.error, reason: d.reason, message: d.message, state: d.state, method: d.method, frame: "f" + fid });
      return;
    }
    // 其余一律丢弃（不做通用转发）
  }

  window.addEventListener("message", function (event) {
    var d = event.data;
    if (!d || d.ch !== CH) return;
    if (hostFrame && event.source === hostFrame) { if (d.dir === "host->canvas") handleHost(d); return; }
    if (d.dir === "canvas->host") {
      var fid = idFor(event.source);
      if (!fid) return; // 不是本页的 iframe（其他窗口/其他来源）一律忽略
      handleChild(fid, d);
    }
  });

  // ── 画布帧生命周期 + 账号钥匙传播（fragment 不参与加载，只给子页读账号作用域）──
  function stamp(node) {
    if (!node || node.tagName !== "IFRAME") return;
    ["data-src", "src"].forEach(function (attr) {
      var v = node.getAttribute(attr);
      if (!v || v.indexOf("#oa=") >= 0) return;
      if (/^https?:/i.test(v)) return;
      try { node.setAttribute(attr, v + "#oa=" + accountKey); } catch (e) { /* ignore */ }
    });
  }
  function stampAll() { var list = frames(); for (var i = 0; i < list.length; i++) stamp(list[i]); }
  try {
    var mo = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        if (m.type === "attributes") stamp(m.target);
        else Array.prototype.forEach.call(m.addedNodes || [], function (n) {
          if (n && n.tagName === "IFRAME") stamp(n);
          else if (n && n.querySelectorAll) Array.prototype.forEach.call(n.querySelectorAll("iframe"), stamp);
        });
      });
    });
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "data-src"] });
  } catch (e) { /* ignore */ }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", stampAll, { once: true });
  else stampAll();

  (function helloLoop(tries) {
    if (token || tries > 30) return;
    hostPost({ kind: "hello-request" });
    setTimeout(function () { helloLoop(tries + 1); }, 500);
  })(0);

  /** 每个 iframe 最后一次**可读且在 bundle 内**的 URL：帧被外部导航打断后用它复位。*/
  var lastGoodUrl = {};
  function rememberGoodUrls() {
    var list = frames();
    for (var i = 0; i < list.length; i += 1) {
      var el = list[i];
      var u = urlOfEl(el);
      var key = el.id || ("f" + i);
      if (u && u.indexOf("openarc-canvas://bundle/") === 0) lastGoodUrl[key] = u;
      else if (!u && lastGoodUrl[key]) {
        // 读不到 URL = 不在我们的 origin 上（被导航到错误页/外部站点）：把这一帧拉回 bundle。
        try { el.src = lastGoodUrl[key]; } catch (e) { /* ignore */ }
        hostPost({ kind: "notice", message: "应用内某个子页面被非预期导航中断，已自动复位" });
      }
    }
  }

  setInterval(function () {
    stampAll();
    rememberGoodUrls();
    applyPendingOpen();
    hostPost({ kind: "alive", token: token });
    var now = currentCanvasFid();
    if (now !== canvasFid) {
      canvasFid = now;
      hostPost({ kind: "frame", event: now ? "canvas-open" : "canvas-closed", frame: now ? "f" + now : null, url: now ? urlOf(now) : "" });
    }
  }, 800);

  // 首启落点：上游 DEFAULT_PAGE_ID='zimage'（3901）与预载 active 的 frame-home（3279）不一致，
  // 首启会停在"在线生图"而不是首页。这里在集成层纠正：**只有用户从未选过页面时**才回到首页，
  // 一旦用户自己选过（studio_active_page 有值）就完全按上游记忆还原。不改上游任何文件。
  try {
    // 桥已经先跑过：这里的 localStorage 是**账号作用域的内存实现**，写入不落盘、不跨账号。
    if (!window.localStorage.getItem("studio_active_page")) window.localStorage.setItem("studio_active_page", "home");
  } catch (e) { /* ignore */ }

  // 上游首页发的导航意图（含要打开哪一本画布）：外壳自己那份监听只切 UI，
  // 这里补上"真的打开那一本"。
  window.addEventListener("message", function (event) {
    var d = event.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "navigate" && d.route === "canvas" && d.canvasId) armPendingOpen(d.canvasId);
  });

  // 子页/外壳自己的 notice 也上报宿主（界面明确说明用）
  window.addEventListener("openarc-canvas-notice", function (e) {
    var msg = e && e.detail && e.detail.message;
    if (msg) hostPost({ kind: "notice", message: String(msg).slice(0, 300) });
  });

  window.__openarcShell = { openCanvas: openCanvas, state: function () { return { canvasFid: canvasFid, ready: !!token }; } };
})();
