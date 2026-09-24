/**
 * OpenArc · 画布页真源守卫（只注入 canvas.html，在 canvas.js 之后加载）。
 *
 * 上游 canvas.js 里有三处"自己造事实"的行为，OpenArc 不能沿用：
 *   1) api_providers 为空时凭空造一个 comfly 供应商（:697-699、:1705、:1721）；
 *   2) video_models 为空时填 25 个写死的视频模型（:1702、:586-606），视频节点默认写死 veo3-fast（:8240/:10484）；
 *   3) ComfyUI 实例数 Math.max(1, …)（:1704），以及把清单外的模型名（写死默认值、localStorage 里的旧清单）塞回下拉。
 *
 * 本脚本**不改上游**，只在上游之后修正它看到/显示的东西：
 *   · 包装 window.fetch：读 /api/config 的真源事实（供应商、各能力模型清单、capabilities.available/transport/reason），
 *     并让"OpenArc 没有传输"的端点返回明确的不可用错误（不是 501 惊吓）；
 *   · 用 MutationObserver 对**每次重渲染后的 DOM**做判定：能力未接通的 provider/model 下拉真实 disable 并写中性灰说明，
 *     清掉清单外的旧选中值，同时在未配置处给出真实可点的"打开 OpenArc 总 API 设置"引导；
 *   · localStorage 的三把"模型来源"键（canvas_custom_image_models / canvas_image_models_ordered /
 *     canvas_chat_models_ordered）一律读不到也写不进 —— 模型清单只有 OpenArc 一个真源。
 *
 * DOM 契约（给门禁断言用，全部 DOM 可观察）：
 *   window.__openarcCanvasGuard.facts                    真源事实快照
 *   select[data-openarc-unavailable="<cap>"]            该下拉因能力未接通被禁用（disabled + aria-disabled）
 *   select[data-openarc-unconfigured="<cap>"]           该下拉因清单为空被禁用（disabled + aria-disabled）
 *   [data-openarc-guard-note="<cap>"]                   说明文字（视频/ComfyUI 为"未接通"，其余为"未配置"）
 *   .node[data-openarc-capability][data-openarc-available="false"]   节点级可用性事实
 *   button[data-openarc-blocked="<cap>"]                该运行按钮被守卫禁用（disabled + aria-disabled）
 *   button[data-openarc-open-model-settings]            "打开 OpenArc 总 API 设置"（真实可点，走桥的登记动作）
 *   [data-openarc-model-status="ok|unconfigured|loading"] 页头模型状态位
 *   html[data-openarc-reduced-motion="0|1"]             宿主传来的"减少动态效果"事实
 */
(function () {
  "use strict";
  if (window.__openarcCanvasGuard) return;

  var GUIDE_TEXT = "打开 OpenArc 总 API 设置";
  var STATUS_LOADING = "模型：读取中…";
  /** 未配置时给用户看的说明（中性灰，不含彩色语义）。*/
  var UNCONFIGURED_TEXT = {
    "chat": "未配置（OpenArc 总 API 设置里没有可用的文本模型）",
    "image-generation": "未配置（OpenArc 总 API 设置里没有可用的生图模型）",
  };
  /** 未接通能力的**唯一**文案：页面任何位置都不允许出现"看着已连接"的说法。*/
  var UNAVAILABLE_TEXT = {
    "video-generation": "OpenArc 未接通视频传输（不可用）",
    "comfy": "OpenArc 未接入 ComfyUI（不可用）",
  };
  var MODEL_SOURCE_KEYS = ["canvas_custom_image_models", "canvas_image_models_ordered", "canvas_chat_models_ordered"];
  var RUN_SELECTORS = {
    "video-generation": [".gen-btn", ".table-batch-run-btn", ".gen-cascade-btn"],
    "image-generation": [".gen-btn", ".table-batch-run-btn", ".gen-cascade-btn"],
    "chat": [".llm-run", ".gen-cascade-btn"],
    "comfy": [".comfy-run", ".gen-cascade-btn", ".mode-tabs button"],
  };
  var facts = {
    loaded: false, providers: [], providerIds: [], chat: [], image: [], video: [], capabilities: {},
  };
  var scanTimer = null;
  /** 被守卫接管 innerHTML 时暂存的选中值：**只存 JS 侧**，绝不写进 DOM ——
   *  上游的兜底值里可能有伪造供应商 id（comfly），写进属性就等于把伪造名字留在页面上。*/
  var keepValue = new WeakMap();

  function unique(list) {
    var seen = {};
    return (Array.isArray(list) ? list : []).map(function (v) { return String(v == null ? "" : v).trim(); }).filter(function (v) {
      if (!v || seen[v]) return false;
      seen[v] = true;
      return true;
    });
  }
  function textOf(el) { return String((el && el.textContent) || "").trim(); }

  // ─────────────────────────────────────────────────────────── 1. 模型来源：只有 OpenArc
  /** 三把"页面自带模型清单"的键一律读不到、写不进（旧数据也当场删掉）。*/
  function lockModelSourceKeys() {
    var real = window.localStorage;
    if (!real) return;
    MODEL_SOURCE_KEYS.forEach(function (k) { try { real.removeItem(k); } catch (e) { /* ignore */ } });
    var wrapper = {
      getItem: function (k) { return MODEL_SOURCE_KEYS.indexOf(String(k)) >= 0 ? null : real.getItem(k); },
      setItem: function (k, v) { if (MODEL_SOURCE_KEYS.indexOf(String(k)) >= 0) return; real.setItem(k, v); },
      removeItem: function (k) { real.removeItem(k); },
      clear: function () { real.clear(); },
      key: function (i) { return real.key(i); },
    };
    Object.defineProperty(wrapper, "length", { get: function () { return real.length; } });
    try { Object.defineProperty(window, "localStorage", { value: wrapper, configurable: true }); } catch (e) { /* ignore */ }
  }

  // ─────────────────────────────────────────────────────────── 2. fetch：读真源 + 明确不可用
  function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), { status: status, headers: { "content-type": "application/json" } });
  }
  /** 能力事实：transport=有没有传输；available=能力在不在；configured=有没有可用模型。三件事分开，不靠文案猜。*/
  function capabilityOf(cap) {
    var c = facts.capabilities && facts.capabilities[cap];
    if (c && typeof c.available === "boolean") {
      return { available: !!c.available, configured: !!c.configured, transport: c.transport || null, reason: c.reason || null };
    }
    // 真源没给事实 = 不可用（fail-closed）：绝不让界面"猜"成可用。
    return { available: false, configured: false, transport: null, reason: UNAVAILABLE_TEXT[cap] || "OpenArc 未接通该能力（不可用）" };
  }
  /** 界面口径的"能用"= 有传输 且 有模型。*/
  function usable(cap) { var c = capabilityOf(cap); return c.available && c.configured; }
  function applyFacts(cfg) {
    cfg = cfg || {};
    facts.providers = (Array.isArray(cfg.api_providers) ? cfg.api_providers : []).map(function (p) {
      return {
        id: String(p.id || ""), name: String(p.name || p.id || ""),
        chat_models: unique(p.chat_models), image_models: unique(p.image_models), video_models: unique(p.video_models),
      };
    }).filter(function (p) { return !!p.id; });
    facts.providerIds = facts.providers.map(function (p) { return p.id; });
    facts.chat = unique(cfg.chat_models);
    facts.image = unique(cfg.image_models);
    facts.video = unique(cfg.video_models);
    facts.capabilities = cfg.capabilities || {};
    var signature = JSON.stringify(cfg);
    var changed = facts.loaded && signature !== facts.signature;
    facts.signature = signature;
    facts.loaded = true;
    if (changed) refreshUpstreamNodes();
    scheduleScan();
  }

  /** 配置真的变了：走**上游自己的**刷新入口（canvas.js 的 window message 分支：
   *  loadConfig → sanitize*NodeProviderModel → render），否则下拉里永远不会出现新模型。
   *  只发同源消息、只在内容变化时发一次，避免自激循环。*/
  function refreshUpstreamNodes() {
    try { window.postMessage({ type: "providers-changed" }, window.location.origin); } catch (e) { /* ignore */ }
  }
  function modelsFor(cap) {
    if (cap === "chat") return facts.chat;
    if (cap === "image-generation") return facts.image;
    if (cap === "video-generation") return facts.video;
    return [];
  }
  function patchFetch() {
    var realFetch = window.fetch;
    if (typeof realFetch !== "function") return;
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var path = "";
      try { path = new URL(url, window.location.href).pathname; } catch (e) { path = String(url); }
      if (path === "/api/config") {
        return realFetch.apply(this, arguments).then(function (res) {
          try {
            res.clone().json().then(applyFacts).catch(function () { /* 非 JSON：保持原样 */ });
          } catch (e) { /* ignore */ }
          return res;
        });
      }
      // 未接通的能力：在**页面侧**就给出明确错误（不发任何请求），而不是让它撞上 501。
      if (path === "/api/canvas-video" || path === "/api/canvas-comfy-tasks" || path.indexOf("/api/canvas-comfy-tasks/") === 0) {
        var cap = path === "/api/canvas-video" ? "video-generation" : "comfy";
        var reason = (capabilityOf(cap).reason) || UNAVAILABLE_TEXT[cap];
        flashNotes(cap);
        return Promise.resolve(jsonResponse(501, { error: "CAPABILITY_UNAVAILABLE", detail: reason, capability: cap, message: reason, available: false, transport: null }));
      }
      return realFetch.apply(this, arguments);
    };
  }

  // ─────────────────────────────────────────────────────────── 3. DOM：真实 disable + 说明 + 引导
  function injectStyle() {
    if (document.getElementById("openarc-guard-style")) return;
    var style = document.createElement("style");
    style.id = "openarc-guard-style";
    // 只消费上游已有变量；中性灰、无描边分层、字重 ≤500、4px 间距体系。
    style.textContent = [
      ".openarc-model-status{display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin:4px 0 0;font-size:11px;line-height:16px;font-weight:400;color:var(--text-2,#737373)}",
      ".openarc-model-status-text{font-weight:400}",
      ".openarc-guide-btn{height:24px;padding:0 8px;border-radius:8px;background:var(--nav-hover-bg,rgba(0,0,0,.05));color:var(--text,#0a0a0a);font-size:11px;font-weight:500;cursor:pointer;transition:background 100ms cubic-bezier(.2,0,0,1)}",
      ".openarc-guide-btn:hover{background:var(--border-2,rgba(0,0,0,.12))}",
      // 键盘焦点环：显式中性高对比 2px + 2px 间隔（浏览器默认的 auto 环是彩色系统色，设计系统禁用）
      ".openarc-guide-btn:focus-visible{outline:2px solid var(--text,#0a0a0a);outline-offset:2px}",
      ".openarc-guard-note{margin:4px 0 0;font-size:11px;line-height:16px;font-weight:400;color:var(--text-2,#737373);animation:openarc-note-in 160ms cubic-bezier(.2,0,0,1)}",
      ".openarc-guard-note[data-openarc-guard-flash='1']{color:var(--text,#0a0a0a)}",
      ".openarc-guard-note .openarc-guide-btn{margin-left:4px}",
      ".openarc-guard-note[data-openarc-guard-error='1']{color:var(--danger-text,#d70015)}",
      "@keyframes openarc-note-in{from{opacity:0}to{opacity:1}}",
      "html[data-openarc-reduced-motion='1'] .openarc-guard-note,html[data-openarc-reduced-motion='1'] .openarc-model-status,html[data-openarc-reduced-motion='1'] .openarc-guide-btn{animation:none;transition:none}",
      "@media (prefers-reduced-motion: reduce){.openarc-guard-note,.openarc-model-status,.openarc-guide-btn{animation:none !important;transition:none !important}}",
    ].join("\n");
    (document.head || document.documentElement).appendChild(style);
  }

  function makeGuideButton() {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "openarc-guide-btn";
    btn.setAttribute("data-openarc-open-model-settings", "1");
    btn.textContent = GUIDE_TEXT;
    // 键盘可达 + 焦点可见（沿用全局 focus 环），点击走桥的登记动作（无参数）。
    btn.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      var b = window.__openarcBridge;
      if (!b || typeof b.openModelSettings !== "function") {
        markGuideError(btn, "OpenArc 宿主未就绪，无法打开设置");
        return;
      }
      try {
        Promise.resolve(b.openModelSettings()).then(function () { btn.setAttribute("data-openarc-guide-state", "opened"); })
          .catch(function (err) { markGuideError(btn, String((err && err.message) || "打开设置失败")); });
      } catch (err) { markGuideError(btn, String((err && err.message) || "打开设置失败")); }
    });
    return btn;
  }
  function markGuideError(btn, message) {
    var note = btn.closest ? btn.closest(".openarc-guard-note") : null;
    if (!note) return;
    note.setAttribute("data-openarc-guard-error", "1");
    note.setAttribute("data-openarc-guard-flash", "1");
    var text = note.querySelector(".openarc-guard-note-text");
    // 失败红必须"标记 + 文字"成对出现（设计系统 §3.1）：前面加一个中性感叹标记。
    if (text) text.textContent = "！" + message;
  }

  /** 节点里的说明行：文字 + （未配置时）真实可点的引导。能力未接通只给事实文案，不给误导性的"去设置里开"。*/
  function setNodeNote(nodeEl, cap, text, withGuide) {
    var note = nodeEl.querySelector('[data-openarc-guard-note="' + cap + '"]');
    if (!note) {
      note = document.createElement("p");
      note.className = "openarc-guard-note";
      note.setAttribute("data-openarc-guard-note", cap);
      var span = document.createElement("span");
      span.className = "openarc-guard-note-text";
      note.appendChild(span);
      if (withGuide) note.appendChild(makeGuideButton());
      var anchor = nodeEl.querySelector(".gen-run-row") || nodeEl.querySelector(".comfy-controls") || nodeEl.querySelector(".llm-run-row") || nodeEl.querySelector(".node-body") || nodeEl;
      anchor.parentNode.insertBefore(note, anchor);
    }
    var spanEl = note.querySelector(".openarc-guard-note-text");
    if (spanEl && textOf(spanEl) !== text) spanEl.textContent = text;
    var guide = note.querySelector("[data-openarc-open-model-settings]");
    if (!withGuide && guide && guide.parentNode) guide.parentNode.removeChild(guide);
    if (withGuide && !guide) note.appendChild(makeGuideButton());
    return note;
  }
  function removeNodeNote(nodeEl, cap) {
    var note = nodeEl.querySelector('[data-openarc-guard-note="' + cap + '"]');
    if (note && note.parentNode) note.parentNode.removeChild(note);
  }
  function flashNotes(cap) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-openarc-guard-note="' + cap + '"]'), function (note) {
      note.setAttribute("data-openarc-guard-flash", "1");
      window.setTimeout(function () { note.setAttribute("data-openarc-guard-flash", "0"); }, 1200);
    });
  }

  function selectRole(sel) {
    if (sel.classList.contains("video-provider")) return { cap: "video-generation", kind: "provider" };
    if (sel.classList.contains("video-model")) return { cap: "video-generation", kind: "model" };
    if (sel.classList.contains("llm-provider-select")) return { cap: "chat", kind: "provider" };
    if (sel.classList.contains("llm-model")) return { cap: "chat", kind: "model" };
    if (sel.classList.contains("provider-select") && sel.closest(".generator-body")) return { cap: "image-generation", kind: "provider" };
    if (sel.classList.contains("model-select") && sel.closest(".generator-body")) return { cap: "image-generation", kind: "model" };
    if (sel.closest(".comfy-body")) return { cap: "comfy", kind: "model" };
    return null;
  }
  function clearSelect(sel) { while (sel.firstChild) sel.removeChild(sel.firstChild); }
  function placeholderOption(text) {
    var opt = document.createElement("option");
    opt.value = "";
    opt.disabled = true;
    opt.selected = true;
    opt.textContent = text;
    return opt;
  }
  function markUnavailable(sel, cap, text) {
    if (sel.value) keepValue.set(sel, sel.value);
    if (sel.getAttribute("data-openarc-state") !== "unavailable:" + text) {
      clearSelect(sel);
      sel.appendChild(placeholderOption(text));
      sel.setAttribute("data-openarc-state", "unavailable:" + text);
    }
    sel.disabled = true;
    sel.setAttribute("aria-disabled", "true");
    sel.setAttribute("data-openarc-unavailable", cap);
    sel.removeAttribute("data-openarc-unconfigured");
  }
  function markUnconfigured(sel, cap, text) {
    if (sel.value) keepValue.set(sel, sel.value);
    if (sel.getAttribute("data-openarc-state") !== "unconfigured:" + text) {
      clearSelect(sel);
      sel.appendChild(placeholderOption(text));
      sel.setAttribute("data-openarc-state", "unconfigured:" + text);
    }
    sel.disabled = true;
    sel.setAttribute("aria-disabled", "true");
    sel.setAttribute("data-openarc-unconfigured", cap);
    sel.removeAttribute("data-openarc-unavailable");
  }
  /** 清单外的选项（写死默认值、localStorage 旧清单、伪造供应商）直接删掉；空则回落到"未配置"。*/
  function pruneOptions(sel, allowed) {
    Array.prototype.slice.call(sel.options).forEach(function (opt) {
      if (opt.value === "") return;
      if (allowed.indexOf(opt.value) < 0) opt.parentNode.removeChild(opt);
    });
  }
  /** 该能力在某个 provider 下的模型清单（画布自己的 provider → 模型 分组口径）。*/
  function providerModels(provider, cap) {
    if (!provider) return [];
    if (cap === "chat") return provider.chat_models || [];
    if (cap === "image-generation") return provider.image_models || [];
    if (cap === "video-generation") return provider.video_models || [];
    return [];
  }
  /** 同节点的 provider 下拉（模型下拉要按它的当前值取该 provider 的模型，避免串台）。*/
  function providerSelectOf(sel, cap) {
    var nodeEl = sel.closest ? sel.closest(".node") : null;
    if (!nodeEl) return null;
    if (cap === "chat") return nodeEl.querySelector(".llm-provider-select");
    if (cap === "video-generation") return nodeEl.querySelector(".video-provider");
    return nodeEl.querySelector(".generator-body .provider-select");
  }
  /** 用真源重建选项（守卫在"未配置→已配置"过渡时接管过 innerHTML，必须自己补回来）。*/
  function rebuildOptions(sel, role) {
    var items = [];
    if (role.kind === "provider") {
      items = facts.providers.map(function (p) { return { value: p.id, label: p.name }; });
    } else {
      var ps = providerSelectOf(sel, role.cap);
      var pid = ps && !ps.disabled ? ps.value : "";
      var provider = facts.providers.filter(function (p) { return p.id === pid; })[0];
      var list = providerModels(provider, role.cap);
      if (!list.length) list = modelsFor(role.cap);
      items = list.map(function (v) { return { value: v, label: v }; });
    }
    if (!items.length) return false;
    clearSelect(sel);
    items.forEach(function (it) {
      var opt = document.createElement("option");
      opt.value = it.value;
      opt.textContent = it.label;
      sel.appendChild(opt);
    });
    var keep = keepValue.get(sel);
    sel.value = (keep && items.some(function (it) { return it.value === keep; })) ? keep : items[0].value;
    return true;
  }

  function syncNodeField(sel, role) {
    var nodeEl = sel.closest ? sel.closest(".node") : null;
    var internals = window.__openarcCanvasInternals;
    if (!nodeEl || !internals) return;
    var id = nodeEl.getAttribute("data-id");
    var st = internals.getState ? internals.getState() : null;
    var node = st && st.nodes ? st.nodes.filter(function (n) { return n.id === id; })[0] : null;
    if (!node) return;
    var value = sel.disabled ? "" : sel.value;
    if (role.kind === "model" && node.model !== value) node.model = value;
    if (role.kind === "provider") {
      if (role.cap === "chat" && node.llmProvider !== value) node.llmProvider = value;
      if (role.cap !== "chat" && node.apiProvider !== value) node.apiProvider = value;
    }
  }
  function applySelect(sel) {
    var role = selectRole(sel);
    if (!role) return;
    var cap = role.cap;
    var availability = capabilityOf(cap);
    if (!availability.available) {
      markUnavailable(sel, cap, availability.reason || UNAVAILABLE_TEXT[cap] || "OpenArc 未接通该能力（不可用）");
      syncNodeField(sel, role);
      return;
    }
    if (!availability.configured) {
      markUnconfigured(sel, cap, UNCONFIGURED_TEXT[cap] || "未配置（OpenArc 总 API 设置里没有可用模型）");
      syncNodeField(sel, role);
      return;
    }
    var allowed = role.kind === "provider" ? facts.providerIds : modelsFor(cap);
    if (!allowed.length) { markUnconfigured(sel, cap, UNCONFIGURED_TEXT[cap] || "未配置（OpenArc 总 API 设置里没有可用模型）"); syncNodeField(sel, role); return; }
    pruneOptions(sel, allowed);
    if (sel.getAttribute("data-openarc-state")) { rebuildOptions(sel, role); sel.removeAttribute("data-openarc-state"); }
    sel.disabled = false;
    sel.removeAttribute("aria-disabled");
    sel.removeAttribute("data-openarc-unavailable");
    sel.removeAttribute("data-openarc-unconfigured");
    if (allowed.indexOf(sel.value) < 0) sel.value = allowed[0];
    if (role.kind === "provider" && !sel.value) sel.value = allowed[0];
    keepValue.delete(sel);
    syncNodeField(sel, role);
  }

  /** 节点 → 能力：**按节点自己的控件判定，不按容器类名**（视频/Midjourney 节点也用 .generator-body）。
   *  一个节点只认一个能力；Midjourney/RunningHub 等不在本轮范围，返回 null 不做任何标记。*/
  function nodeCapability(nodeEl) {
    if (nodeEl.querySelector(".video-provider, .video-model")) return "video-generation";
    if (nodeEl.querySelector(".comfy-body")) return "comfy";
    if (nodeEl.querySelector(".llm-body")) return "chat";
    if (nodeEl.querySelector(".generator-body .provider-select, .generator-body .model-select")) return "image-generation";
    return null;
  }

  /** 节点级事实 + 运行入口：能力不可用就**真实禁用**，并在提交位置留下说明。*/
  function markNode(nodeEl) {
    var cap = nodeCapability(nodeEl);
    var caps = cap ? [cap] : [];
    caps.forEach(function (cap) {
      var availability = capabilityOf(cap);
      var ok = usable(cap);
      nodeEl.setAttribute("data-openarc-capability", cap);
      nodeEl.setAttribute("data-openarc-available", ok ? "true" : "false");
      var unconfigured = availability.available && !availability.configured;
      var text = ok ? "" : (unconfigured ? (UNCONFIGURED_TEXT[cap] || "未配置") : (availability.reason || UNAVAILABLE_TEXT[cap] || "不可用"));
      if (text) setNodeNote(nodeEl, cap, text, unconfigured); else removeNodeNote(nodeEl, cap);
      (RUN_SELECTORS[cap] || []).forEach(function (selector) {
        Array.prototype.forEach.call(nodeEl.querySelectorAll(selector), function (btn) {
          if (ok) {
            if (btn.getAttribute("data-openarc-blocked") === cap) {
              btn.removeAttribute("data-openarc-blocked");
              btn.removeAttribute("aria-disabled");
              btn.disabled = false;
            }
            return;
          }
          btn.setAttribute("data-openarc-blocked", cap);
          btn.setAttribute("aria-disabled", "true");
          btn.disabled = true;
          btn.title = text;
        });
      });
    });
  }

  /** 上游指向已死设置页的文案（"请到 API 设置添加"）：改指 OpenArc 总 API 设置。只动 <option> 文本，不碰正文。*/
  function rewriteDeadCopy() {
    Array.prototype.forEach.call(document.querySelectorAll("option"), function (opt) {
      var t = String(opt.textContent || "");
      if (/OpenArc/.test(t)) return;
      if (!/API\s*设置|API\s*Settings/.test(t)) return;
      var next = t.replace(/API\s*设置/g, "OpenArc 总 API 设置").replace(/API\s*Settings/g, "OpenArc total API settings");
      if (next !== t) opt.textContent = next;
    });
  }

  function statusChip() {
    var meta = document.querySelector(".canvas-nav-meta");
    if (!meta) return null;
    var chip = meta.querySelector("[data-openarc-model-status]");
    if (!chip) {
      chip = document.createElement("div");
      chip.className = "openarc-model-status";
      chip.setAttribute("data-openarc-model-status", "loading");
      var span = document.createElement("span");
      span.className = "openarc-model-status-text";
      chip.appendChild(span);
      meta.appendChild(chip);
    }
    return chip;
  }
  function updateStatusChip() {
    var chip = statusChip();
    if (!chip) return;
    var span = chip.querySelector(".openarc-model-status-text");
    if (!facts.loaded) {
      chip.setAttribute("data-openarc-model-status", "loading");
      if (span) span.textContent = STATUS_LOADING;
      return;
    }
    var chatOk = usable("chat");
    var imageOk = usable("image-generation");
    var missing = [];
    if (!chatOk) missing.push("文本" + (capabilityOf("chat").configured ? "不可用" : "未配置"));
    if (!imageOk) missing.push("生图" + (capabilityOf("image-generation").configured ? "不可用" : "未配置"));
    var parts = [];
    if (chatOk) parts.push("文本 " + facts.chat.length);
    if (imageOk) parts.push("生图 " + facts.image.length);
    var text = parts.join(" · ");
    if (missing.length) text = (text ? text + " · " : "") + missing.join(" · ");
    if (!usable("video-generation")) text = (text ? text + " · " : "") + "视频未接通";
    var unconfigured = missing.length > 0;
    chip.setAttribute("data-openarc-model-status", unconfigured ? "unconfigured" : "ok");
    if (span) span.textContent = "模型：" + text;
    var btn = chip.querySelector("[data-openarc-open-model-settings]");
    if (unconfigured && !btn) chip.appendChild(makeGuideButton());
    if (!unconfigured && btn && btn.parentNode) btn.parentNode.removeChild(btn);
  }

  function scan() {
    scanTimer = null;
    if (!facts.loaded) return;
    Array.prototype.forEach.call(document.querySelectorAll("select"), applySelect);
    Array.prototype.forEach.call(document.querySelectorAll(".node"), markNode);
    rewriteDeadCopy();
    updateStatusChip();
  }
  function scheduleScan() {
    if (scanTimer != null) return;
    scanTimer = window.setTimeout(function () { try { scan(); } catch (e) { scanTimer = null; } }, 40);
  }

  /** 被禁用的运行按钮点不动（disabled 按钮不派发 click），所以整行也拦一层：点它就说明原因。*/
  function bindClickGuard() {
    document.addEventListener("click", function (ev) {
      var target = ev.target;
      if (!target || !target.closest) return;
      var row = target.closest(".gen-run-row, .comfy-controls, .llm-run-row, .node");
      if (!row) return;
      var nodeEl = row.classList.contains("node") ? row : row.closest(".node");
      if (!nodeEl) return;
      var cap = nodeEl.getAttribute("data-openarc-capability");
      if (!cap || nodeEl.getAttribute("data-openarc-available") !== "false") return;
      if (!target.closest(".gen-run-row, .comfy-controls, .llm-run-row")) return;
      if (target.closest("[data-openarc-open-model-settings]")) return;
      ev.preventDefault();
      ev.stopPropagation();
      flashNotes(cap);
    }, true);
  }

  function start() {
    injectStyle();
    lockModelSourceKeys();
    patchFetch();
    bindClickGuard();
    var observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i += 1) {
        if (records[i].addedNodes && records[i].addedNodes.length) { scheduleScan(); return; }
      }
    });
    try { observer.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) { /* ignore */ }
    window.addEventListener("openarc-canvas-context", scheduleScan);
    window.addEventListener("load", scheduleScan);
    scheduleScan();
  }

  window.__openarcCanvasGuard = {
    version: 1,
    facts: facts,
    scan: scheduleScan,
    guideText: GUIDE_TEXT,
    unavailableText: UNAVAILABLE_TEXT,
    modelSourceKeys: MODEL_SOURCE_KEYS.slice(),
  };
  start();
})();
