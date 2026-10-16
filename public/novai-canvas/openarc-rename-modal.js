/**
 * OpenArc 无限画布 · 应用内模态输入（prompt() 的替代品）。
 *
 * 为什么需要它：Electron 的 Chromium **不支持 window.prompt**（调用即被忽略 / 抛
 * "prompt() is not supported"），上游在画布列表页与智能画布里的"重命名"因此变成死路。
 * 这里用画布页自己的既有样式（.purge-confirm-* / .asset-dialog 同一套 token：
 * --panel / --shadow / --radius-* / --v4-* / --danger-text）做一个**应用内**输入模态，
 * 不引入任何新框架、不建新窗口。
 *
 * 契约（门禁/探针可观察）：
 *   window.__openarcPrompt(opts) -> Promise<string|null>
 *     · 确认且通过校验 -> resolve(去空格后的值)
 *     · 取消 / Esc / 点遮罩 -> resolve(null)
 *     · 空值不提交：内联错误提示，模态保持打开
 *     · opts.onSubmit(name) 返回 Promise 时由模态负责提交：
 *       resolve -> 关闭并 resolve(name)；reject -> 结构化错误留在模态内（不静默、不关窗）
 *   DOM：.openarc-prompt-overlay / .openarc-prompt-panel / [data-openarc-prompt-error]
 *   状态：document.documentElement[data-openarc-prompt-open="1"]（打开时）
 *
 * 可及性：role=dialog + aria-modal，Esc 取消，焦点进入输入框并全选，Tab 困在面板内，
 * 关闭后焦点回原位；减少动态效果（宿主 data-openarc-reduced-motion / 系统偏好）下不做动效。
 */
(function () {
  "use strict";
  if (window.__openarcPrompt) return;

  var STYLE_ID = "openarc-prompt-style";
  var active = null;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      ".openarc-prompt-overlay{position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;",
      "background:rgba(0,0,0,.2);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);",
      "opacity:0;pointer-events:none;transition:opacity .25s cubic-bezier(.22,.61,.36,1)}",
      ".openarc-prompt-overlay.active{opacity:1;pointer-events:auto}",
      ".openarc-prompt-panel{width:340px;max-width:calc(100vw - 48px);padding:20px;border:0;border-radius:20px;",
      "background:color-mix(in srgb, var(--panel, #ffffff) 78%, transparent);",
      "backdrop-filter:blur(44px) saturate(190%);-webkit-backdrop-filter:blur(44px) saturate(190%);",
      "box-shadow:0 24px 56px var(--shadow, rgba(0,0,0,.18)), 0 8px 24px color-mix(in srgb, var(--shadow, rgba(0,0,0,.18)) 60%, transparent);",
      "transform:translateY(8px) scale(.97);transition:transform .3s cubic-bezier(.22,.61,.36,1)}",
      ".openarc-prompt-overlay.active .openarc-prompt-panel{transform:translateY(0) scale(1)}",
      ".theme-dark .openarc-prompt-panel,html.studio-theme-dark .openarc-prompt-panel{background:color-mix(in srgb, var(--panel, #1e1e1e) 70%, transparent)}",
      ".openarc-prompt-title{font-size:15px;font-weight:600;line-height:1.4;color:var(--text, var(--v4-text, inherit))}",
      ".openarc-prompt-input{display:block;width:100%;margin-top:12px;padding:8px 10px;border-radius:8px;",
      "border:1px solid var(--border, rgba(0,0,0,.12));background:var(--bg, var(--v4-bg, #f5f5f7));",
      "color:var(--text, var(--v4-text, inherit));font-size:13px;font-family:var(--font-sans, inherit);outline:none}",
      ".openarc-prompt-input:focus-visible{outline:2px solid var(--v4-focus-ring, var(--text, #1d1d1f));outline-offset:1px}",
      ".openarc-prompt-error{margin-top:6px;font-size:12px;line-height:1.5;color:var(--danger-text, #d70015);word-break:break-all}",
      ".openarc-prompt-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}",
      ".openarc-prompt-btn{padding:6px 14px;border-radius:8px;border:none;font-size:13px;font-weight:500;cursor:pointer;",
      "font-family:var(--font-sans, inherit);transition:opacity .2s cubic-bezier(.4,0,.2,1)}",
      ".openarc-prompt-btn.secondary{background:var(--bg, var(--v4-bg, #f5f5f7));color:var(--text, var(--v4-text, inherit))}",
      ".openarc-prompt-btn.primary{background:var(--v4-btn-bg, var(--text, #1d1d1f));color:var(--v4-btn-text, var(--bg, #ffffff))}",
      ".openarc-prompt-btn:hover{opacity:.85}",
      ".openarc-prompt-btn[disabled]{opacity:.45;cursor:default}",
      "html[data-openarc-reduced-motion='1'] .openarc-prompt-overlay,",
      "html[data-openarc-reduced-motion='1'] .openarc-prompt-panel{transition:none}",
      "@media (prefers-reduced-motion: reduce){.openarc-prompt-overlay,.openarc-prompt-panel{transition:none !important}}",
    ].join("");
    (document.head || document.documentElement).appendChild(style);
  }

  function focusables(panel) {
    return Array.prototype.slice.call(panel.querySelectorAll("button, input, textarea, [tabindex]:not([tabindex='-1'])"));
  }

  function close(instance, value) {
    if (!instance || instance.closed) return;
    instance.closed = true;
    if (active === instance) active = null;
    document.removeEventListener("keydown", instance.onKey, true);
    instance.overlay.classList.remove("active");
    document.documentElement.removeAttribute("data-openarc-prompt-open");
    var done = function () {
      if (instance.overlay.parentNode) instance.overlay.parentNode.removeChild(instance.overlay);
      try { if (instance.returnFocus && instance.returnFocus.focus) instance.returnFocus.focus(); } catch (e) { /* ignore */ }
      instance.resolve(value);
    };
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) done();
    else window.setTimeout(done, 220);
  }

  function showError(instance, message) {
    instance.error.textContent = message ? String(message) : "";
    instance.error.hidden = !message;
    if (message) {
      instance.panel.setAttribute("data-openarc-prompt-error", String(message).slice(0, 200));
    } else {
      instance.panel.removeAttribute("data-openarc-prompt-error");
    }
  }

  function submit(instance) {
    if (instance.busy) return;
    var raw = String(instance.input.value == null ? "" : instance.input.value);
    var name = raw.replace(/\s+$/, "").replace(/^\s+/, "");
    if (!name) { showError(instance, instance.opts.emptyText || "名称不能为空"); return; }
    if (instance.opts.maxLength && name.length > instance.opts.maxLength) {
      showError(instance, "最多 " + instance.opts.maxLength + " 个字"); return;
    }
    if (typeof instance.opts.validate === "function") {
      var problem = instance.opts.validate(name);
      if (problem) { showError(instance, problem); return; }
    }
    showError(instance, "");
    if (typeof instance.opts.onSubmit !== "function") { close(instance, name); return; }
    instance.busy = true;
    instance.okBtn.disabled = true;
    instance.cancelBtn.disabled = true;
    Promise.resolve()
      .then(function () { return instance.opts.onSubmit(name); })
      .then(function () { instance.busy = false; close(instance, name); })
      .catch(function (err) {
        instance.busy = false;
        instance.okBtn.disabled = false;
        instance.cancelBtn.disabled = false;
        var status = err && err.status ? "（HTTP " + err.status + "）" : "";
        showError(instance, (instance.opts.failedText || "提交失败") + status + "：" + String((err && err.message) || err || "未知错误"));
        try { instance.input.focus(); instance.input.select(); } catch (e) { /* ignore */ }
      });
  }

  /**
   * opts: { title, value, placeholder, maxLength, confirmText, cancelText,
   *         emptyText, failedText, onSubmit(name)->Promise, validate(name)->string|null }
   * 返回 Promise<string|null>；同一时刻只保留一个模态（新调用先把上一个按取消关闭）。
   */
  window.__openarcPrompt = function (opts) {
    opts = opts || {};
    if (active) close(active, null);
    injectStyle();
    return new Promise(function (resolve) {
      var overlay = document.createElement("div");
      overlay.className = "openarc-prompt-overlay";
      var panel = document.createElement("div");
      panel.className = "openarc-prompt-panel";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");

      var titleId = "openarc-prompt-title";
      var title = document.createElement("div");
      title.className = "openarc-prompt-title";
      title.id = titleId;
      title.textContent = String(opts.title || "输入");
      panel.setAttribute("aria-labelledby", titleId);

      var input = document.createElement("input");
      input.className = "openarc-prompt-input";
      input.type = "text";
      input.autocomplete = "off";
      input.spellcheck = false;
      if (opts.placeholder) input.placeholder = String(opts.placeholder);
      if (opts.maxLength) input.maxLength = Number(opts.maxLength);
      input.value = opts.value == null ? "" : String(opts.value);
      input.setAttribute("aria-label", String(opts.title || "输入"));

      var error = document.createElement("div");
      error.className = "openarc-prompt-error";
      error.setAttribute("data-openarc-prompt-error", "");
      error.hidden = true;

      var actions = document.createElement("div");
      actions.className = "openarc-prompt-actions";
      var cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "openarc-prompt-btn secondary";
      cancelBtn.textContent = String(opts.cancelText || "取消");
      var okBtn = document.createElement("button");
      okBtn.type = "button";
      okBtn.className = "openarc-prompt-btn primary";
      okBtn.setAttribute("data-openarc-prompt-confirm", "1");
      okBtn.textContent = String(opts.confirmText || "确定");
      actions.appendChild(cancelBtn);
      actions.appendChild(okBtn);

      panel.appendChild(title);
      panel.appendChild(input);
      panel.appendChild(error);
      panel.appendChild(actions);
      overlay.appendChild(panel);
      (document.body || document.documentElement).appendChild(overlay);

      var instance = {
        opts: opts, overlay: overlay, panel: panel, input: input, error: error,
        okBtn: okBtn, cancelBtn: cancelBtn, closed: false, busy: false, resolve: resolve,
        returnFocus: document.activeElement,
      };
      active = instance;
      document.documentElement.setAttribute("data-openarc-prompt-open", "1");

      instance.onKey = function (event) {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(instance, null); return; }
        if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); submit(instance); return; }
        if (event.key === "Tab") {
          var list = focusables(panel);
          if (!list.length) return;
          var first = list[0], last = list[list.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      };
      document.addEventListener("keydown", instance.onKey, true);
      overlay.addEventListener("click", function (event) { if (event.target === overlay) close(instance, null); });
      cancelBtn.addEventListener("click", function (event) { event.preventDefault(); close(instance, null); });
      okBtn.addEventListener("click", function (event) { event.preventDefault(); submit(instance); });
      input.addEventListener("input", function () { showError(instance, ""); });

      window.requestAnimationFrame(function () {
        overlay.classList.add("active");
        try { input.focus(); input.select(); } catch (e) { /* ignore */ }
      });
    });
  };
})();
