/**
 * OpenArc 无限画布 · 宿主桥（**画布页面里最先执行的脚本**）。
 *
 * 边界（PLAN §24 + D5-02 §三）：
 *   1. 画布页面跑在 sandbox iframe 里：**没有** window.openarc / require / IPC / fs / 凭据；
 *   2. 画布**没有**自己的密钥、服务地址或隐藏默认供应商 —— 所有模型调用一律经
 *      window.__openarcBridge.call('model.*') 转给 OpenArc 宿主，再由 OpenArc 模型服务执行；
 *   3. 只放行画布真正需要的端点；其余一律返回明确的"不支持"错误，
 *      **绝不静默改用别的服务**、也绝不直接出网。
 */
(function () {
  "use strict";
  var CH = "openarc.canvas";
  var seq = 0;
  var pending = new Map();
  var ctx = { ready: false, readOnly: true, canEdit: false, canvasId: null, models: null };
  /** 宿主在 hello 里发来的**本次实例 token**：每条调用都必须带回，否则宿主忽略。*/
  var token = null;

  function post(msg) {
    try { window.parent.postMessage(Object.assign({ ch: CH, dir: "canvas->host" }, msg), "*"); } catch (e) { /* host 不在 */ }
  }
  function errText(code, message) { return { error: code, message: message || code }; }

  function call(method, params, signal) {
    return new Promise(function (resolve, reject) {
      if (!ctx.ready) { reject(errText("CANVAS_HOST_NOT_READY", "OpenArc 画布宿主尚未就绪")); return; }
      seq += 1;
      var id = seq;
      var onAbort = function () {
        if (!pending.has(id)) return;
        pending.delete(id);
        // 用户停止（级联停止会 abort 在途请求）：通知宿主终结这次生成运行，之后不再发出后续请求。
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
    });
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
      window.dispatchEvent(new CustomEvent("openarc-canvas-context", { detail: { readOnly: ctx.readOnly, canEdit: ctx.canEdit, canvasId: ctx.canvasId, models: ctx.models } }));
      return;
    }
    if (d.kind === "context") { ctx.readOnly = !!d.readOnly; ctx.canEdit = !!d.canEdit; return; }
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
    /** 画布页面里唯一的"是否只读"事实来源（A28：只读成员两条路径都被拒）。*/
    isReadOnly: function () { return !!ctx.readOnly; },
    requestContext: function () { post({ kind: "context-request" }); },
  };

  // ---------------------------------------------------------------- 存储
  // 沙箱（allow-scripts，无 allow-same-origin）下 localStorage 会抛 SecurityError。
  // 画布只用它存主题/草稿类偏好：给一个**内存实现**，不落盘、不跨账号、不跨窗口。
  function memoryStorage() {
    var map = new Map();
    return {
      getItem: function (k) { return map.has(String(k)) ? map.get(String(k)) : null; },
      setItem: function (k, v) { map.set(String(k), String(v)); },
      removeItem: function (k) { map.delete(String(k)); },
      clear: function () { map.clear(); },
      key: function (i) { return Array.from(map.keys())[i] || null; },
      get length() { return map.size; },
    };
  }
  try { void window.localStorage.getItem("probe"); } catch (e) {
    Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
    Object.defineProperty(window, "sessionStorage", { value: memoryStorage(), configurable: true });
  }

  // ---------------------------------------------------------------- fetch / XHR
  function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), { status: status, headers: { "content-type": "application/json" } });
  }
  function unsupported(url) {
    return jsonResponse(501, { error: "OPENARC_UNSUPPORTED", message: "该功能不属于 OpenArc 无限画布范围：" + String(url).slice(0, 120) });
  }

  /** 端点白名单：只放行画布真正需要的；每个都对应宿主的一条受控命令。 */
  function route(method, pathname, search, body) {
    var m = method.toUpperCase();
    if (m === "GET" && pathname === "/api/config") return { method: "model.config" };
    if (m === "GET" && pathname === "/api/workflows") return { method: "canvas.workflows" };
    if (m === "GET" && pathname === "/api/canvases") return { method: "canvas.list" };
    if (m === "POST" && pathname === "/api/canvases") return { method: "canvas.create", params: { title: body && body.title, icon: body && body.icon, kind: body && body.kind } };
    if (m === "GET" && pathname === "/api/canvases/trash") return { method: "canvas.trashList" };
    var cv = pathname.match(/^\/api\/canvases\/([^/]+)$/);
    if (cv) {
      var id = decodeURIComponent(cv[1]);
      if (m === "GET") return { method: "canvas.get", params: { canvasId: id } };
      if (m === "PUT") return { method: "canvas.save", params: { canvasId: id, body: body } };
      if (m === "DELETE") return { method: "canvas.trash", params: { canvasId: id } };
    }
    var meta = pathname.match(/^\/api\/canvases\/([^/]+)\/meta$/);
    if (meta && m === "PUT") return { method: "canvas.meta", params: { canvasId: decodeURIComponent(meta[1]), body: body } };
    var touch = pathname.match(/^\/api\/canvases\/([^/]+)\/(touch|restore)$/);
    if (touch) return { method: "canvas." + touch[2], params: { canvasId: decodeURIComponent(touch[1]) } };
    var purge = pathname.match(/^\/api\/canvases\/([^/]+)\/purge$/);
    if (purge && m === "DELETE") return { method: "canvas.purge", params: { canvasId: decodeURIComponent(purge[1]) } };
    if (m === "POST" && pathname === "/api/canvas-llm") return { method: "model.chat", params: { body: body } };
    if (m === "POST" && pathname === "/api/canvas-image-tasks") return { method: "model.imageTask", params: { body: body } };
    var task = pathname.match(/^\/api\/canvas-image-tasks\/([^/]+)$/);
    if (task && m === "GET") return { method: "model.imageTaskResult", params: { taskId: decodeURIComponent(task[1]) } };
    if (m === "POST" && pathname === "/api/image-task-query") return { method: "model.queryTask", params: { body: body } };
    if (m === "POST" && pathname === "/api/canvas-assets/check") return { method: "canvas.assetStates", params: { body: body } };
    if (m === "POST" && pathname === "/api/ai/upload") return { method: "canvas.upload", params: { form: body } };
    if (m === "POST" && pathname === "/api/canvas-assets/download") return { method: "canvas.assetDownload", params: { body: body } };
    if (m === "POST" && pathname === "/api/media-preview") return { method: "canvas.mediaPreview", params: { body: body } };
    return null;
  }

  window.fetch = function (input, init) {
    init = init || {};
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var method = (init.method || (input && input.method) || "GET").toUpperCase();
    var parsed;
    try { parsed = new URL(url, window.location.href); } catch (e) { return Promise.resolve(unsupported(url)); }
    var body = null;
    if (init.body != null && typeof init.body === "string") { try { body = JSON.parse(init.body); } catch (e) { body = null; } }
    var isForm = typeof FormData !== "undefined" && init.body instanceof FormData;
    var mapped = route(method, parsed.pathname, parsed.search, isForm ? init.body : body);
    if (!mapped) return Promise.resolve(unsupported(parsed.pathname));
    if (parsed.pathname === "/api/ai/upload") return call(mapped.method, { form: init.body }).then(function (res) { return jsonResponse(200, res); }).catch(function (err) { return jsonResponse(502, { error: err.error, message: err.message }); });
    return call(mapped.method, mapped.params || {}, init.signal || null).then(function (res) {
      if (res && res.__conflict) return jsonResponse(409, { detail: res.detail || null, error: "REVISION_CONFLICT" });
      if (res && res.__status) return jsonResponse(res.__status, res.body || {});
      return jsonResponse(200, res);
    }).catch(function (err) { return jsonResponse(502, { error: err.error, message: err.message }); });
  };

  // XHR：画布少数路径用 XHR（进度/流）；统一转成 fetch 语义即可，不额外放开任何端点。
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

  // ---------------------------------------------------------------- 导航拦截
  // 画布里有指向其它产品页（智能画布 / 画布列表页）的入口：在 OpenArc 里它们不属于本轮范围。
  document.addEventListener("click", function (event) {
    var a = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (!href || href.charAt(0) === "#") return;
    if (/smart-canvas\.html|canvas-list\.html|api-settings\.html|asset-manager\.html|comfyui-settings\.html|online\.html|index\.html/.test(href)) {
      event.preventDefault();
      event.stopPropagation();
      window.dispatchEvent(new CustomEvent("openarc-canvas-notice", { detail: { message: "该功能不在 OpenArc 无限画布范围内：" + href } }));
    }
  }, true);

  post({ kind: "hello-request" });
})();
