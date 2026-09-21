/**
 * OpenArc · NOVAI 完整应用宿主桥（**每个页面最先执行的脚本**：外壳 index.html 与 14 个子页都注入）。
 *
 * 边界（PLAN §24 + D5-02 §三 / §6.1）：
 *   1. 应用页面跑在 sandbox iframe 里：**没有** window.openarc / require / IPC / fs / 凭据；
 *   2. 页面**没有**自己的密钥、服务地址或隐藏默认供应商 —— 所有模型调用一律经
 *      window.__openarcBridge.call('model.*') 转给 OpenArc 宿主，再由 OpenArc 模型服务执行；
 *   3. 只放行产品真正需要的端点；其余一律返回明确的"不支持"错误，
 *      **绝不静默改用别的服务**、也绝不直接出网（CSP connect-src 'none' 是最后的硬边界）；
 *   4. 账号边界：localStorage/sessionStorage/BroadcastChannel 一律按 **OpenArc 账号** 作用域，
 *      内存实现、不落盘、不跨账号；启动时清掉同源残留（同一个 bundle origin ≠ 不同账号已隔离）。
 *   5. pywebview 桌面壳的 11 个方法在 OpenArc 里**明确不可用**（不假装、不提供通用宿主能力）。
 */
(function () {
  "use strict";
  var CH = "openarc.canvas";
  var seq = 0;
  var pending = new Map();
  var ctx = { ready: false, readOnly: true, canEdit: false, canvasId: null, models: null, account: null, top: false };
  /** 宿主在 hello 里发来的**本次实例 token**：每条调用都必须带回，否则宿主忽略。*/
  var token = null;
  /** 外壳页（被宿主直接加载的那一帧）自己持有 token；子页的 token 恒为 null，由外壳转发时附加。*/
  var IS_TOP = false;
  try { IS_TOP = window.top === window.self; } catch (e) { IS_TOP = false; }
  ctx.top = IS_TOP;

  /** 账号作用域钥匙：宿主在入口 URL 的 fragment 里给出（不透明、不含凭据），外壳再传给子页。*/
  function readAccountKey() {
    try {
      var m = /(?:^|[#&])oa=([A-Za-z0-9_-]{4,64})/.exec(String(window.location.hash || ""));
      return m ? m[1] : "anon";
    } catch (e) { return "anon"; }
  }
  var accountKey = readAccountKey();

  function post(msg) {
    try { window.parent.postMessage(Object.assign({ ch: CH, dir: "canvas->host", top: IS_TOP }, msg), "*"); } catch (e) { /* host 不在 */ }
  }
  function errText(code, message) { return { error: code, message: message || code }; }
  function notice(message) {
    try { window.dispatchEvent(new CustomEvent("openarc-canvas-notice", { detail: { message: String(message) } })); } catch (e) { /* ignore */ }
    post({ kind: "notice", message: String(message).slice(0, 300), token: token });
  }

  /** 宿主握手是异步的：页面脚本可能在 hello 到达之前就发请求，这里排队等待（有上限，绝不静默变成功）。*/
  var readyWaiters = [];
  function whenReady() {
    if (ctx.ready) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var entry = { resolve: resolve, reject: reject };
      readyWaiters.push(entry);
      setTimeout(function () {
        var i = readyWaiters.indexOf(entry);
        if (i < 0) return;
        readyWaiters.splice(i, 1);
        reject(errText("CANVAS_HOST_NOT_READY", "OpenArc 应用宿主尚未就绪"));
      }, 8000);
    });
  }
  function flushReady() { while (readyWaiters.length) { try { readyWaiters.shift().resolve(); } catch (e) { /* ignore */ } } }

  function call(method, params, signal) {
    return whenReady().then(function () { return new Promise(function (resolve, reject) {
      seq += 1;
      var id = seq;
      var onAbort = function () {
        if (!pending.has(id)) return;
        pending.delete(id);
        post({ kind: "abort", id: id, method: method });
        reject(errText("CANVAS_ABORTED", "已停止"));
      };
      pending.set(id, { resolve: resolve, reject: reject });
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      post({ kind: "call", id: id, method: method, params: params || {}, token: token });
      setTimeout(function () {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(errText("CANVAS_HOST_TIMEOUT", method + " 超时"));
      }, 120000);
    }); });
  }

  function applyAccount(next) {
    var key = next ? String(next) : null;
    if (!key || key === accountKey) return;
    accountKey = key;
    purgeOtherAccountResidue();
    clearOwnStores();
  }

  window.addEventListener("message", function (event) {
    var d = event.data;
    if (!d || d.ch !== CH || d.dir !== "host->canvas") return;
    if (d.kind === "hello") {
      token = d.token || null;
      ctx.ready = true;
      ctx.readOnly = !!d.readOnly;
      ctx.canEdit = !!d.canEdit;
      ctx.canvasId = d.canvasId || null;
      ctx.models = d.models || null;
      ctx.account = d.account || null;
      applyAccount(d.accountKey);
      flushReady();
      window.dispatchEvent(new CustomEvent("openarc-canvas-context", { detail: { readOnly: ctx.readOnly, canEdit: ctx.canEdit, canvasId: ctx.canvasId, models: ctx.models, top: IS_TOP } }));
      return;
    }
    if (d.kind === "context") {
      ctx.readOnly = !!d.readOnly;
      ctx.canEdit = !!d.canEdit;
      if (d.canvasId) ctx.canvasId = d.canvasId;
      applyAccount(d.accountKey);
      window.dispatchEvent(new CustomEvent("openarc-canvas-context", { detail: { readOnly: ctx.readOnly, canEdit: ctx.canEdit, canvasId: ctx.canvasId, models: ctx.models, top: IS_TOP } }));
      return;
    }
    if (d.kind === "result") {
      var p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      if (d.ok) p.resolve(d.value); else p.reject(errText((d.error && d.error.error) || "CANVAS_HOST_ERROR", d.error && (d.error.message || d.error.detail) || ""));
    }
  });

  window.__openarcBridge = {
    call: call,
    context: ctx,
    accountKey: function () { return accountKey; },
    /** 账号边界自证：真实同源存储里属于本次挂载的键 / 不属于的键（只回计数，不回键名）。*/
    storageIsolation: function () {
      var out = { own: 0, foreign: 0, mount: false };
      try {
        var p = prefixOf();
        var s = realLocal;
        if (s) {
          for (var i = 0; i < s.length; i += 1) {
            var k = s.key(i);
            if (!k) continue;
            if (k === "oa:mount") continue;
            if (k.indexOf(p) === 0) out.own += 1; else out.foreign += 1;
          }
          out.mount = s.getItem("oa:mount") === accountKey;
        }
      } catch (e) { out.error = "unavailable"; }
      return out;
    },
    /** 页面里唯一的"是否只读"事实来源（A28：只读成员两条路径都被拒）。*/
    isReadOnly: function () { return !!ctx.readOnly; },
    requestContext: function () { post({ kind: "context-request" }); },
  };

  // ──────────────────────────────────────────────────────────────── 账号作用域存储
  // 同一个 bundle origin 上的真实 localStorage 会跨账号残留：一律换成**按账号分桶的内存实现**，
  // 并在启动时清掉同源残留，保证"切账号后旧页面读不到新账号的数据"。
  // 三种要求同时成立：① 页面之间**能共享**（上游靠 localStorage 传 hp_pending_import / 主题 / 语言）；
  // ② 不同账号之间**不共享**；③ 磁盘上不残留上一个账号的数据。
  // 做法：所有键加 "oa:<本次挂载的账号钥匙>:" 前缀；钥匙变了（换账号/窗口重挂载）就整片清掉再接管。
  var realLocal = null, realSession = null;
  try { realLocal = window.localStorage; } catch (e) { realLocal = null; }
  try { realSession = window.sessionStorage; } catch (e) { realSession = null; }
  var memoryFallback = { local: new Map(), session: new Map() };
  function prefixOf() { return "oa:" + accountKey + ":"; }
  function storageOf(bucket) { return bucket === "local" ? realLocal : realSession; }

  function purgeOtherAccountResidue() {
    try {
      var store = realLocal;
      if (!store) return;
      if (store.getItem("oa:mount") === accountKey) return;      // 本次挂载已经接管过：保留，避免把同账号其它页面刚写的数据清掉
      store.clear();
      try { if (realSession) realSession.clear(); } catch (e) { /* ignore */ }
      try { if (window.indexedDB && indexedDB.databases) indexedDB.databases().then(function (dbs) { (dbs || []).forEach(function (d) { try { indexedDB.deleteDatabase(d.name); } catch (e) { /* ignore */ } }); }); } catch (e) { /* ignore */ }
      try { if (window.caches && caches.keys) caches.keys().then(function (ks) { (ks || []).forEach(function (k) { try { caches.delete(k); } catch (e) { /* ignore */ } }); }); } catch (e) { /* ignore */ }
      store.setItem("oa:mount", accountKey);
    } catch (e) { /* ignore */ }
  }
  function clearOwnStores() {
    Object.keys(memoryFallback).forEach(function (k) { memoryFallback[k].clear(); });
    var p = prefixOf();
    try {
      var store = realLocal;
      if (store) {
        var keys = [];
        for (var i = 0; i < store.length; i += 1) { var k = store.key(i); if (k && k.indexOf(p) === 0) keys.push(k); }
        keys.forEach(function (k) { store.removeItem(k); });
      }
    } catch (e) { /* ignore */ }
  }
  function scopedStorage(bucket) {
    var fallback = memoryFallback[bucket];
    function keys() {
      var p = prefixOf(), out = [];
      var store = storageOf(bucket);
      if (store) { try { for (var i = 0; i < store.length; i += 1) { var k = store.key(i); if (k && k.indexOf(p) === 0) out.push(k.slice(p.length)); } } catch (e) { out = []; } }
      else { Array.from(fallback.keys()).forEach(function (k) { if (k.indexOf(p) === 0) out.push(k.slice(p.length)); }); }
      return out;
    }
    return {
      getItem: function (k) {
        var key = prefixOf() + String(k);
        var store = storageOf(bucket);
        if (store) { try { return store.getItem(key); } catch (e) { /* 落到内存兜底 */ } }
        var v = fallback.get(key);
        return v == null ? null : v;
      },
      setItem: function (k, v) {
        var key = prefixOf() + String(k);
        var store = storageOf(bucket);
        if (store) { try { store.setItem(key, String(v)); return; } catch (e) { /* 落到内存兜底 */ } }
        fallback.set(key, String(v));
      },
      removeItem: function (k) {
        var key = prefixOf() + String(k);
        var store = storageOf(bucket);
        if (store) { try { store.removeItem(key); } catch (e) { /* ignore */ } }
        fallback.delete(key);
      },
      clear: function () { var self = this; keys().forEach(function (k) { self.removeItem(k); }); },
      key: function (i) { var list = keys(); return list[i] == null ? null : list[i]; },
      get length() { return keys().length; },
    };
  }
  purgeOtherAccountResidue();
  Object.defineProperty(window, "localStorage", { value: scopedStorage("local"), configurable: true });
  Object.defineProperty(window, "sessionStorage", { value: scopedStorage("session"), configurable: true });

  // BroadcastChannel：按账号改频道名（旧账号的页面/旧通道收不到新账号的消息）。
  try {
    var RealBroadcastChannel = window.BroadcastChannel;
    if (RealBroadcastChannel) {
      window.BroadcastChannel = function (name) { return new RealBroadcastChannel("oa:" + accountKey + ":" + String(name)); };
    }
  } catch (e) { /* ignore */ }

  // ──────────────────────────────────────────────────────────────── pywebview 桌面壳
  // 上游用 window.pywebview 的存在与否区分"桌面版/网页版"。OpenArc 不是 pywebview：
  // 这里返回 undefined（页面自动走网页版分支），但**任何一次读取都会留下明确记录**，
  // 不提供退出 OpenArc / 任意文件路径 / 任意宿主方法转发。
  try {
    Object.defineProperty(window, "pywebview", {
      configurable: true,
      get: function () {
        window.__openarcUnsupportedHostCalls = (window.__openarcUnsupportedHostCalls || 0) + 1;
        try { console.warn("[openarc] pywebview 宿主方法在 OpenArc 中不可用（save_file/select_directory/quit_app/minimize/maximize/close/get_data_dir/open_data_dir/set_auto_start/set_titlebar_theme）"); } catch (e) { /* ignore */ }
        // 不往宿主提示条刷屏：上游每页启动都会读一次这个对象（判断是否桌面版）。
        return undefined;
      },
    });
  } catch (e) { /* ignore */ }

  // window.open / 弹窗一律拒绝（不产生新窗口、不产生出网导航）。
  try {
    window.open = function () {
      notice("OpenArc 不允许页面打开新窗口");
      return null;
    };
  } catch (e) { /* ignore */ }

  // ──────────────────────────────────────────────────────────────── fetch / XHR
  function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), { status: status, headers: { "content-type": "application/json" } });
  }
  /** 同一个端点只提示一次：未接通模块（素材库/提示词库/ComfyUI/第三方供应商…）在 OpenArc 里必须**界面明确说明**，但不刷屏。*/
  var noticedPaths = {};
  function unsupported(url, extra) {
    var path = String(url).slice(0, 120);
    if (!noticedPaths[path]) {
      noticedPaths[path] = true;
      notice("该功能未接入 OpenArc（保留入口）：" + path);
    }
    return jsonResponse(501, Object.assign({ error: "OPENARC_UNSUPPORTED", message: "该功能不在 OpenArc 集成范围内：" + path }, extra || {}));
  }
  /** 更新/下载上游程序：**保持禁用**，界面明确说明（绝不静默联网、绝不直连 GitHub/Gitee/ModelScope）。*/
  var UPDATE_PATHS = [/^\/api\/check-update$/, /^\/api\/update-/, /^\/api\/update-backups$/, /^\/api\/update-rollback$/, /^\/api\/update-progress$/, /^\/api\/update-from-github$/, /^\/api\/update-connectivity/];
  function isUpdatePath(pathname) { return UPDATE_PATHS.some(function (re) { return re.test(pathname); }); }

  /** 端点白名单：只放行产品真正需要的；每个都对应宿主的一条受控命令。*/
  function route(method, pathname, search, body) {
    var m = String(method || "GET").toUpperCase();
    if (isUpdatePath(pathname)) return { blocked: "UPDATE_DISABLED" };
    // —— 外壳（index.html）——
    if (m === "GET" && pathname === "/api/app-info") return { method: "app.info" };
    if (m === "GET" && pathname === "/api/changelog") return { method: "app.changelog" };
    if (m === "GET" && pathname === "/api/queue_status") return { method: "app.queue" };
    // —— 首页（home.html）——
    if (m === "GET" && pathname === "/api/recent-canvases") return { method: "canvas.recent" };
    // —— 画布列表（canvas-list.html）——
    if (m === "GET" && pathname === "/api/projects") return { method: "project.list" };
    // —— 画布编辑器 / 列表共用 ——
    if (m === "GET" && pathname === "/api/config") return { method: "model.config" };
    if (m === "GET" && pathname === "/api/workflows") return { method: "canvas.workflows" };
    if (m === "GET" && pathname === "/api/canvases") return { method: "canvas.list" };
    if (m === "POST" && pathname === "/api/canvases") return { method: "canvas.create", params: { title: body && body.title, icon: body && body.icon, kind: body && body.kind, project: body && body.project, boardX: body && body.board_x, boardY: body && body.board_y } };
    if (m === "GET" && pathname === "/api/canvases/trash") return { method: "canvas.trashList" };
    var cv = pathname.match(/^\/api\/canvases\/([^/]+)$/);
    if (cv) {
      var id = decodeURIComponent(cv[1]);
      if (m === "GET") return { method: "canvas.get", params: { canvasId: id } };
      if (m === "PUT") return { method: "canvas.save", params: { canvasId: id, body: body } };
      if (m === "DELETE") return { method: "canvas.trash", params: { canvasId: id } };
    }
    var meta = pathname.match(/^\/api\/canvases\/([^/]+)\/meta$/);
    if (meta) return { method: "canvas.meta", params: { canvasId: decodeURIComponent(meta[1]), body: body, httpMethod: m } };
    var touch = pathname.match(/^\/api\/canvases\/([^/]+)\/(touch|restore)$/);
    if (touch) return { method: "canvas." + touch[2], params: { canvasId: decodeURIComponent(touch[1]) } };
    var purge = pathname.match(/^\/api\/canvases\/([^/]+)\/purge$/);
    if (purge && m === "DELETE") return { method: "canvas.purge", params: { canvasId: decodeURIComponent(purge[1]) } };
    // —— 模型（唯一来源：OpenArc 模型服务）——
    if (m === "POST" && pathname === "/api/canvas-llm") return { method: "model.chat", params: { body: body } };
    if (m === "POST" && pathname === "/api/canvas-image-tasks") return { method: "model.imageTask", params: { body: body } };
    var task = pathname.match(/^\/api\/canvas-image-tasks\/([^/]+)$/);
    if (task && m === "GET") return { method: "model.imageTaskResult", params: { taskId: decodeURIComponent(task[1]) } };
    if (m === "POST" && pathname === "/api/image-task-query") return { method: "model.queryTask", params: { body: body } };
    // —— 资源（统一走 OpenArc 资源库）——
    if (m === "POST" && pathname === "/api/canvas-assets/check") return { method: "canvas.assetStates", params: { body: body } };
    if (m === "POST" && pathname === "/api/ai/upload") return { method: "canvas.upload", params: { form: body } };
    if (m === "POST" && pathname === "/api/upload") return { method: "canvas.upload", params: { form: body } };
    return null;
  }

  var realFetch = window.fetch.bind(window);
  /** 把 FormData 里的文件读成 data URL（有界：最多 8 个 / 每个 ≤ 8MB）；不把 File 对象丢过 postMessage。*/
  function readUploadFiles(form) {
    try {
      if (!form || typeof form.getAll !== "function") return Promise.resolve([]);
      var files = form.getAll("files").concat(form.getAll("file")).filter(function (f) { return f && typeof f.size === "number"; }).slice(0, 8);
      return Promise.all(files.map(function (f) {
        if (Number(f.size) > 8 * 1024 * 1024) return Promise.resolve(null);
        return new Promise(function (resolve) {
          var r = new FileReader();
          r.onload = function () { resolve({ name: String(f.name || "upload"), type: String(f.type || ""), dataUrl: String(r.result || "") }); };
          r.onerror = function () { resolve(null); };
          r.readAsDataURL(f);
        });
      })).then(function (list) { return list.filter(Boolean); });
    } catch (e) { return Promise.resolve([]); }
  }

  window.fetch = function (input, init) {
    init = init || {};
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var method = (init.method || (input && input.method) || "GET").toUpperCase();
    var parsed;
    try { parsed = new URL(url, window.location.href); } catch (e) { return Promise.resolve(unsupported(url)); }
    // ② 本 bundle 自己的静态资源（非 /api/）：走真实 fetch，由 openarc-canvas:// 只读白名单把关。
    if (parsed.origin === window.location.origin && parsed.pathname.indexOf("/api/") !== 0) return realFetch(input, init);
    // 出网请求（http/https/ws）一律不发出：CSP 之外的第二道明确拒绝。
    if (parsed.protocol !== "openarc-canvas:" && parsed.protocol !== "file:" && parsed.protocol !== "data:" && parsed.protocol !== "blob:") {
      notice("OpenArc 不允许页面直接访问外部网络：" + parsed.origin);
      return Promise.resolve(unsupported(parsed.href, { error: "OPENARC_EGRESS_BLOCKED", message: "页面不能直接出网（更新/第三方直连已禁用）：" + parsed.origin }));
    }
    var body = null;
    if (init.body != null && typeof init.body === "string") { try { body = JSON.parse(init.body); } catch (e) { body = null; } }
    var isForm = typeof FormData !== "undefined" && init.body instanceof FormData;
    var mapped = route(method, parsed.pathname, parsed.search, isForm ? init.body : body);
    if (mapped && mapped.blocked === "UPDATE_DISABLED") {
      notice("更新与下载已禁用：OpenArc 不检查、不下载、不安装上游程序");
      return Promise.resolve(jsonResponse(501, { error: "OPENARC_UPDATE_DISABLED", message: "更新/下载上游程序在 OpenArc 中已禁用（不发生任何联网）", reachable: false }));
    }
    if (!mapped) return Promise.resolve(unsupported(parsed.pathname));
    if (parsed.pathname === "/api/ai/upload" || parsed.pathname === "/api/upload") {
      return readUploadFiles(init.body).then(function (files) {
        if (!files.length) return jsonResponse(501, { error: "OPENARC_UNSUPPORTED", message: "上传里没有可导入的文件" });
        return call(mapped.method, { files: files });
      }).then(function (res) { return jsonResponse(200, res); }).catch(function (err) { return jsonResponse(502, { error: err.error, message: err.message }); });
    }
    return call(mapped.method, mapped.params || {}, init.signal || null).then(function (res) {
      if (res && res.__conflict) return jsonResponse(409, { detail: res.detail || null, error: "REVISION_CONFLICT" });
      if (res && res.__status) return jsonResponse(res.__status, res.body || {});
      return jsonResponse(200, res);
    }).catch(function (err) { return jsonResponse(502, { error: err.error, message: err.message }); });
  };

  // XHR：少数路径用 XHR；统一转成 fetch 语义即可，不额外放开任何端点。
  var OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    var xhr = new OrigXHR();
    var self = this;
    this.upload = xhr.upload; this.readyState = 0; this.status = 0; this.responseText = ""; this.response = "";
    this.open = function (method, url) { self._m = method; self._u = url; return self; };
    this.setRequestHeader = function () { return self; };
    this.getAllResponseHeaders = function () { return ""; };
    this.getResponseHeader = function () { return null; };
    this.abort = function () {};
    this.addEventListener = function () {};
    this.removeEventListener = function () {};
    this.send = function (data) {
      var init = { method: self._m || "GET" };
      if (typeof data === "string") init.body = data;
      window.fetch(self._u, init).then(function (res) {
        self.status = res.status;
        res.text().then(function (txt) {
          self.responseText = txt; self.response = txt; self.readyState = 4;
          if (typeof self.onload === "function") self.onload();
          if (typeof self.onreadystatechange === "function") self.onreadystatechange();
        });
      });
    };
    return this;
  };

  // WebSocket：上游只用来订阅 /ws/stats（实时在线数/队列推送）。OpenArc 不提供该实时通道，
  // 这里给出**明确失败**的替身（触发 onerror/onclose），页面走自己的轮询分支，不静默假装已连接。
  try {
    var RealWebSocket = window.WebSocket;
    function UnavailableSocket(url) {
      this.url = String(url);
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
      var self = this;
      setTimeout(function () {
        self.readyState = 3;
        notice("实时状态通道 /ws/stats 在 OpenArc 中不可用（状态栏改用宿主队列计数）");
        try { if (typeof self.onerror === "function") self.onerror({ type: "error" }); } catch (e) { /* ignore */ }
        try { if (typeof self.onclose === "function") self.onclose({ type: "close", code: 1006, reason: "OPENARC_UNSUPPORTED", wasClean: false }); } catch (e) { /* ignore */ }
      }, 300);
    }
    UnavailableSocket.CONNECTING = 0; UnavailableSocket.OPEN = 1; UnavailableSocket.CLOSING = 2; UnavailableSocket.CLOSED = 3;
    UnavailableSocket.prototype.send = function () {};
    UnavailableSocket.prototype.close = function () { this.readyState = 3; };
    UnavailableSocket.prototype.addEventListener = function () {};
    UnavailableSocket.prototype.removeEventListener = function () {};
    window.WebSocket = function (url) {
      var lower = String(url).toLowerCase();
      if (lower.indexOf("openarc-canvas:") === 0 || lower.indexOf("ws://openarc-canvas") === 0 || lower.indexOf("wss://openarc-canvas") === 0) return new RealWebSocket(url);
      return new UnavailableSocket(url);
    };
    window.WebSocket.prototype = UnavailableSocket.prototype;
  } catch (e) { /* ignore */ }

  // ──────────────────────────────────────────────────────────────── 导航
  // 站内（bundle 内）跳转必须放行（首页 → 画布列表 → 编辑器是产品主流程）；
  // 离开 bundle 的跳转一律拦下并明确提示 —— 宿主侧还有 will-frame-navigate 兜底。
  document.addEventListener("click", function (event) {
    var a = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (!href || href.charAt(0) === "#") return;
    if (/^(https?:)?\/\//i.test(href)) {
      event.preventDefault();
      event.stopPropagation();
      notice("OpenArc 不允许从应用内跳转到外部站点：" + href);
    }
  }, true);

  (function helloLoop(tries) {
    if (ctx.ready || tries > 30) return;
    post({ kind: "hello-request" });
    setTimeout(function () { helloLoop(tries + 1); }, 500);
  })(0);
})();
