/* ══════════════════════════════════════════════════════════════════════════════
   OpenArc 智能画布 · 单一真源 / 未接通如实禁用 / 只读闸（追加在 smart-canvas.js 的 IIFE 末尾）
   ──────────────────────────────────────────────────────────────────────────────
   背景：入口改向之后 smart-canvas.html 是唯一可达的编辑器。上游 22feb298+ 的本地源码已经
   把「视频」从全局 kind 开关改成**按节点类型**（创建菜单 data-create-type="video"），并删除了
   #apiKindToggle / syncApiKindToggleVisibility；旧封堵里对这两个符号的引用会直接抛
   ReferenceError（applyDom 半途中断）。本版按新源码实际符号重写，不照抄旧模板。

   覆盖（可验证）：
   C1 供应商 / 模型清单只来自宿主 /api/config 投影：
      · DEFAULT_VIDEO_MODELS 就地清空；volcengineProvider / volcengineVideoModels /
        modelscopeImageModels 的页面内置兜底全部失效（没有宿主投影就没有模型）；
      · resolveChatModel 不再回落任何页面写死的模型名（新源码本来就没有 gpt-4o-mini）；
      · unifiedPlatformEntries 的「其它引擎」只列宿主 api_providers 里真实存在的 provider；
      · 清掉清单外的历史值：renderModelControl / renderVideoModelControl 不再把
        settings.model / settings.videoModel 里已不在宿主清单中的旧值渲染出来；
      · 锁掉四把页面记忆键（smart_chat_model / smart_chat_provider /
        smart_agent_image_provider / smart_canvas_recent_run_settings_v1）：读恒 null、写丢弃、
        旧值清除 —— 它们是「宿主清单变了而页面没刷新」时唯一的第二来源。
   C2 未接通能力（视频 / ComfyUI / ModelScope）如实禁用 + 标注（复用经典守卫的
      .openarc-guard-note / data-openarc-unavailable 契约，不新造视觉）：
      · 创建菜单的视频节点按钮真实 disable + 标注；createNodeFromMenu('video') 页面侧拒绝；
      · #engineSelect 里未接通的引擎 option disable；历史 settings.engine 指向未接通引擎时
        在 loadConfig / renderDynamicParams 两处回落 'api'；
      · 视频参数 pill、ModelScope 功能/自定义模型、ComfyUI 模式/工作流在不可用时 disable；
      · runGeneration / runApiVideoGeneration / runModelscopeGeneration / runComfyGeneration /
        createSmartComfyTask 在页面侧按能力事实拒绝（不会走到必然 501 的请求）；
      · /api/canvas-video 与 /api/canvas-comfy-tasks 直接给出明确不可用错误；comfyInstanceCount
        在宿主未投影 ComfyUI 时置 0（不再 Math.max(1, …) 造出一个实例）。
   C3 只读画布：每一条编辑路径都被拒：
      · 桥的 openarc-canvas-context 事实落到 window.__openarcCanvasReadOnly（后到的 context 同样生效，
        readOnly / canEdit 两个字段都认；桥默认 readOnly:true 是 fail-closed）；
      · 事件闸（window 捕获阶段）：#world / #composer / #createMenu / 各编辑弹层上的
        mousedown/pointerdown/click/dblclick/contextmenu/dragstart/dragover/drop/paste/cut/
        beforeinput/input/change 一律 preventDefault + stopImmediatePropagation 并记 blocked；
        键盘编辑键（Delete/Backspace/方向键/Cmd+Z、Y、V、A、D、G、X）同样在捕获阶段拦下；
      · 函数闸：会改文档的闭包函数逐个包成"只读即拒"（拖动/缩放/框选/连线/增删/分组/
        表格/内联编辑/参数面板/右键菜单/撤销重做/模板库写/素材库写/Agent ops/生成落图/保存…），
        并把被 window.* 提前导出的那些重新指到包装后的实现；
      · fetch 闸：只读时任何非 GET/HEAD/OPTIONS 的请求都在页面侧被拒并记 blocked。
   C4 证据面：window.__openarcSmartGuard.facts()/providers()/blocked()/snapshot()/wrapped()/
      writeBlocked()/surfaces()/storage()/videoEntry() 供门禁与真机探针读取。

   明确定位不到的（真机用例见 experiments/dxos-canvas-revendor-next/revendor-probe.mjs）：
   · 拖动/缩放**过程中**节点坐标已经在 mousemove 里写入；capture 闸只能拦手势开始，
     运行中切只读的极端时序会留一帧位移（commitPendingUndo 会回滚快照）；
   · 节点内联 contenteditable 直接改 DOM 文本：只读时事件闸挡住输入，但它本身不是函数；
   · 服务端副作用（版本还原/删除、Agent apply、生成）：拦的是页面入口，宿主权限仍是最后一道；
   · 表格/批量节点用外部 shared/table-node.js，模块内部没有可包装的注入点，靠事件闸整体挡在
     交互层之前（与上一版同一结论）。
   ══════════════════════════════════════════════════════════════════════════════ */
(function(){
    "use strict";
    if (window.__openarcSmartGuardInstalled) return;
    window.__openarcSmartGuardInstalled = true;

    /** 未接通能力的唯一文案（与经典守卫 openarc-canvas-guard.js 完全一致）。*/
    var UNAVAILABLE_TEXT = {
        "video-generation": "OpenArc 未接通视频传输（不可用）",
        "comfy": "OpenArc 未接入 ComfyUI（不可用）"
    };
    /** 宿主 /api/config 原始回包（唯一真源）；null = 还没拿到 ⇒ fail-closed 按不可用呈现。*/
    var hosted = null;
    var hostedPromise = null;
    var blockedLog = [];
    var applyTimer = null;
    var lastToastAt = 0;
    var writeBlockedCount = 0;
    var storageLocked = false;

    function unique(list){
        var seen = {}, out = [];
        (Array.isArray(list) ? list : []).forEach(function(v){
            v = String(v == null ? "" : v).trim();
            if (v && !seen[v]) { seen[v] = true; out.push(v); }
        });
        return out;
    }
    function capFacts(cap){
        var c = hosted && hosted.capabilities && hosted.capabilities[cap];
        if (c && typeof c.available === "boolean") {
            return { available: !!c.available, configured: !!c.configured, transport: c.transport || null, reason: c.reason || null };
        }
        return { available: false, configured: false, transport: null, reason: UNAVAILABLE_TEXT[cap] || "OpenArc 未接通该能力（不可用）" };
    }
    function usable(cap){ var f = capFacts(cap); return f.available && f.configured; }
    /* 显式默认的可用性（宿主 /api/config 投影）：
         default_models[cap]     = 显式默认模型的页面标签（宿主按同一份 label 口径算；没配 / 查不到为空）
         capabilities[cap].defaultUsable = false + defaultReason = 显式默认不可用
       没配默认时 defaultUsable 不是布尔 —— 那不是"不可用"，页面按清单第一个只是展示便利，不在这里管。
       返回 null = 没有"显式默认不可用"这件事。*/
    var DEFAULT_REASON_TEXT = {
        CAPABILITY_UNAVAILABLE: "没有这项能力",
        MODEL_DISABLED: "已停用",
        MODEL_NOT_FOUND: "不在 OpenArc 清单里",
        MODEL_UNAUTHORIZED: "没有使用权限"
    };
    function defaultFact(cap){
        var c = hosted && hosted.capabilities && hosted.capabilities[cap];
        if (!c || typeof c.defaultUsable !== "boolean") return null;
        /* 整个能力没有可用模型（未配置 / 撤权）：走既有"未配置"呈现（下拉唯一占位、模型 pill 0 个），
           不在这里另造一个"不可用默认"——那是"有清单、但你的默认不在里面"的场景。*/
        if (!(c.available && c.configured)) return null;
        var label = String((hosted && hosted.default_models && hosted.default_models[cap]) || "");
        return { capability: cap, label: label, usable: c.defaultUsable === true, reason: c.defaultReason || null };
    }
    function defaultBlocked(cap){ var fact = defaultFact(cap); return !!(fact && fact.usable === false); }
    function defaultReasonText(fact){
        var code = String((fact && fact.reason) || "");
        return DEFAULT_REASON_TEXT[code] || "不可用";
    }
    function defaultNoteText(fact){
        var name = fact && fact.label ? ("默认模型 " + fact.label) : "默认模型";
        return name + " " + defaultReasonText(fact) + "（不会自动改用其它模型）";
    }
    /* 用户显式选过替代模型：之后配置刷新不再把选择掰回"不可用的默认"。
       只记页面内的显式点击（记忆键 smart_chat_model 已被本守卫锁死，不是第二真源）。*/
    var explicitImageModel = "";
    var explicitChatModel = "";
    var lastDefaultKey = { chat: null, "image-generation": null };
    /* 管理面把某个能力的显式默认换掉时，页面上的"显式替代"不再代表用户对**新默认**的选择：
       清掉旧标记，让新默认能如实呈现（否则会出现"默认已换、页面还停在旧选择"的第三种骗人状态）。*/
    function syncExplicitWithDefaultChange(){
        ["chat", "image-generation"].forEach(function(cap){
            var fact = defaultFact(cap);
            var key = fact ? (String(fact.label || "") + "|" + String(fact.reason || "")) : "";
            if (lastDefaultKey[cap] !== null && lastDefaultKey[cap] !== key) {
                if (cap === "chat") explicitChatModel = "";
                else explicitImageModel = "";
            }
            lastDefaultKey[cap] = key;
        });
    }
    try {
        document.addEventListener("click", function(event){
            var el = event && event.target;
            var btn = el && el.closest ? el.closest('[data-smart-param="model"]') : null;
            if (btn) explicitImageModel = String(btn.getAttribute("data-smart-value") || "");
        }, true);
    } catch(e) { /* 没有 document（极早期）时忽略；由 renderModelControl 的兜底逻辑处理 */ }
    function realProvider(id){
        var list = (apiProviders || []).filter(function(p){ return p && p.id === id && p.enabled !== false; });
        return list[0] || null;
    }
    function engineAvailable(id){
        if (id === "api") return true;
        if (id === "comfy") return !!realProvider("comfy") && usable("comfy");
        return !!realProvider(id);
    }
    function hostChatModels(){
        var out = [];
        (apiProviders || []).forEach(function(p){
            if (!p || p.enabled === false) return;
            unique(p.chat_models).forEach(function(m){ out.push({ name: m, provider: p.id }); });
        });
        return out;
    }
    function hostImageModels(providerId){
        var out = [];
        (apiProviders || []).forEach(function(p){
            if (!p || p.enabled === false) return;
            if (providerId && p.id !== providerId) return;
            unique(p.image_models).forEach(function(m){ out.push(m); });
        });
        return out;
    }
    function hostVideoModels(providerId){
        var out = [];
        (apiProviders || []).forEach(function(p){
            if (!p || p.enabled === false) return;
            if (providerId && p.id !== providerId) return;
            unique(p.video_models).forEach(function(m){ out.push(m); });
        });
        return out;
    }
    function blocked(reason, capability, text){
        var entry = { at: Date.now(), reason: String(reason || ""), capability: capability || null };
        blockedLog.push(entry);
        if (blockedLog.length > 120) blockedLog.shift();
        try { window.dispatchEvent(new CustomEvent("openarc-canvas-blocked", { detail: entry })); } catch(e) {}
        var now = Date.now();
        if (now - lastToastAt > 600) {
            lastToastAt = now;
            try {
                if (typeof toast === "function") {
                    toast(capability ? (text || capFacts(capability).reason || UNAVAILABLE_TEXT[capability] || "不可用") : "只读画布不可编辑", "!");
                }
            } catch(e) {}
        }
        return null;
    }

    /* ── C1 页面内置兜底清单全部失效：供应商 / 模型只来自宿主投影 ───────────────── */

    try { if (Array.isArray(DEFAULT_VIDEO_MODELS)) DEFAULT_VIDEO_MODELS.length = 0; } catch(e) {}
    volcengineProvider = function(){
        /* 宿主没投影火山引擎 = OpenArc 没接通它；绝不造一个带 DEFAULT_VIDEO_MODELS 的假平台。*/
        return realProvider("volcengine") || { id: "volcengine", name: "火山引擎", image_models: [], video_models: [], enabled: false };
    };
    volcengineVideoModels = function(){
        var p = realProvider("volcengine");
        return p ? unique(p.video_models) : [];
    };
    modelscopeImageModels = function(){
        var p = realProvider("modelscope");
        return p ? unique(p.image_models) : [];
    };
    resolveChatModel = function(model, providerId){
        var models = providerChatModels(resolveChatProviderId(providerId || ""));
        return String(model || "") || models[0] || "";
    };
    unifiedPlatformEntries = function(){
        var isVideo = settings.apiKind === "video" && isApiLikeEngine(settings.engine);
        var apiList = isVideo ? videoApiProviders() : imageProviders();
        var engineName = function(value){
            var opt = engineSelect && engineSelect.querySelector('option[value="' + value + '"]');
            return String((opt && opt.textContent) || value).trim().replace(/\s*生成$/, "");
        };
        var api = apiList.map(function(p){ return { engine: "api", id: p.id, name: p.name || p.id }; });
        /* 「其它引擎」只列宿主 api_providers 里真实存在的 provider：宿主没投影就是没接通。*/
        var candidates = isVideo ? ["volcengine"] : ["volcengine", "modelscope", "comfy", "runninghub"];
        var others = candidates
            .filter(function(id){ return engineAvailable(id); })
            .map(function(value){ return { engine: value, id: "", name: value === "modelscope" ? "ModelScope" : engineName(value) }; });
        return { api: api, others: others, isVideo: isVideo };
    };
    var __origInitChatModel = initChatModel;
    initChatModel = function(){
        var out = __origInitChatModel.apply(this, arguments);
        var def = defaultFact("chat");
        if (!hostChatModels().length) {
            chatModel = "";
            chatProvider = "";
            if (chatModelSelect) {
                chatModelSelect.innerHTML = '<option value="">未配置</option>';
                chatModelSelect.value = "";
                chatModelSelect.removeAttribute("data-openarc-default-unavailable");
                chatModelSelect.removeAttribute("title");
            }
        } else if (def && def.usable === false && def.label && (!explicitChatModel || explicitChatModel === def.label)) {
            /* 显式文本默认不可用：**不静默换模型**。默认模型如实列成 disabled 的不可用项并保持选中；
               清单里其它可用模型仍然列出来，用户点它就是显式选择替代（此时不再被掰回默认）。*/
            var available = [];
            if (chatModelSelect) {
                Array.prototype.forEach.call(chatModelSelect.options, function(o){
                    if (o.value && o.value !== def.label) available.push({ value: o.value, provider: o.getAttribute("data-provider") || "" });
                });
            }
            chatModel = def.label;
            chatProvider = resolveChatProviderId();
            if (chatModelSelect) {
                chatModelSelect.innerHTML = "";
                if (def.label) {
                    var unavailable = document.createElement("option");
                    unavailable.value = def.label;
                    unavailable.textContent = def.label + "（不可用）";
                    unavailable.disabled = true;
                    unavailable.setAttribute("data-openarc-unavailable", "chat");
                    unavailable.setAttribute("data-openarc-default", "chat");
                    unavailable.title = defaultNoteText(def);
                    chatModelSelect.appendChild(unavailable);
                }
                available.forEach(function(item){
                    var opt = document.createElement("option");
                    opt.value = item.value;
                    opt.textContent = item.value;
                    if (item.provider) opt.setAttribute("data-provider", item.provider);
                    chatModelSelect.appendChild(opt);
                });
                if (def.label) chatModelSelect.selectedIndex = 0;
                if (def.label) chatModelSelect.setAttribute("data-openarc-default-unavailable", "chat");
                else chatModelSelect.removeAttribute("data-openarc-default-unavailable");
                chatModelSelect.title = def.label ? defaultNoteText(def) : "默认模型不可用（不会自动改用其它模型）";
            }
        } else if (chatModelSelect) {
            chatModelSelect.removeAttribute("data-openarc-default-unavailable");
        }
        scheduleApply();
        return out;
    };
    currentChatModel = function(){ return chatModel || ""; };
    var __origChangeChatModel = changeChatModel;
    changeChatModel = function(val){
        explicitChatModel = String(val == null ? "" : val);
        return __origChangeChatModel.apply(this, arguments);
    };
    try { window.initChatModel = initChatModel; window.currentChatModel = currentChatModel; window.changeChatModel = changeChatModel; } catch(e) {}

    /* 清单外的历史模型值不再渲染：renderModelControl 会把 settings.model 强行并进列表。*/
    var __origRenderModelControl = renderModelControl;
    renderModelControl = function(models){
        var list = unique(models);
        var def = defaultFact("image-generation");
        var wantsBlockedDefault = !!(def && def.usable === false && def.label
            && (!explicitImageModel || explicitImageModel === def.label)
            && (!settings.model || settings.model === def.label));
        if (wantsBlockedDefault) {
            /* 显式生图默认不可用：保留它（哪怕不在可用清单里），不换成 list[0]。
               真正的"不可用"呈现（note / option disabled）由 applyDom 落地。*/
            settings.model = def.label;
        } else if (settings.model && list.indexOf(settings.model) < 0) {
            settings.model = list[0] || "";
        }
        return __origRenderModelControl.call(this, list);
    };
    var __origRenderVideoModelControl = renderVideoModelControl;
    renderVideoModelControl = function(models){
        var list = unique(models);
        if (settings.videoModel && list.indexOf(settings.videoModel) < 0) settings.videoModel = list[0] || "";
        return __origRenderVideoModelControl.call(this, list);
    };
    /* 「换平台自动校正模型」不能再把不可用的显式默认换掉：这是静默换模型的另一条路径
       （renderApiParams / correctSmartApiModelForProvider 都走这里）。*/
    var __origCorrectedApiModelForProvider = correctedApiModelForProvider;
    correctedApiModelForProvider = function(providerId, currentModel){
        var def = defaultFact("image-generation");
        var current = String(currentModel || "");
        if (def && def.usable === false && def.label && current === def.label
            && (!explicitImageModel || explicitImageModel === def.label)) return current;
        return __origCorrectedApiModelForProvider.apply(this, arguments);
    };
    var __origCorrectedChatModelForProvider = correctedChatModelForProvider;
    correctedChatModelForProvider = function(providerId, currentModel){
        var def = defaultFact("chat");
        var current = String(currentModel || "");
        if (def && def.usable === false && def.label && current === def.label
            && (!explicitChatModel || explicitChatModel === def.label)) return current;
        return __origCorrectedChatModelForProvider.apply(this, arguments);
    };

    /* 四把页面记忆键 = 第二来源：读恒 null、写丢弃、旧值清除。*/
    (function lockSmartStorage(){
        var keys = {
            "smart_chat_model": 1,
            "smart_chat_provider": 1,
            "smart_agent_image_provider": 1,
            "smart_canvas_recent_run_settings_v1": 1
        };
        /* 桥会把 localStorage 包成带前缀的存储对象（方法挂在实例上，不在 Storage.prototype）。
           两层都锁：实例自己的方法优先（页面实际调的就是它），原型再兜一层普通 Storage。*/
        try {
            var lockedAny = false;
            var ls = window.localStorage;
            if (ls && !ls.__openarcSmartStorageLocked) {
                var ownGet = ls.getItem, ownSet = ls.setItem, ownRemove = ls.removeItem;
                ls.getItem = function(key){ return keys[String(key)] ? null : ownGet.call(ls, key); };
                ls.setItem = function(key, value){
                    if (keys[String(key)]) { try { ownRemove.call(ls, key); } catch(e) {} return; }
                    return ownSet.call(ls, key, value);
                };
                ls.removeItem = function(key){ return ownRemove.call(ls, key); };
                ls.__openarcSmartStorageLocked = true;
                lockedAny = true;
            }
            var proto = window.Storage && window.Storage.prototype;
            if (proto && !proto.__openarcSmartStorageLocked) {
                var getItem = proto.getItem, setItem = proto.setItem, removeItem = proto.removeItem;
                proto.getItem = function(key){ return keys[String(key)] ? null : getItem.call(this, key); };
                proto.setItem = function(key, value){
                    if (keys[String(key)]) { try { removeItem.call(this, key); } catch(e) {} return; }
                    return setItem.call(this, key, value);
                };
                proto.removeItem = function(key){ return removeItem.call(this, key); };
                proto.__openarcSmartStorageLocked = true;
                lockedAny = true;
            }
            storageLocked = lockedAny;
        } catch(e) { storageLocked = false; }
        Object.keys(keys).forEach(function(key){ try { localStorage.removeItem(key); } catch(e) {} });
    })();

    /* ── C2 未接通能力：页面侧真实禁用 / 标注 / 拦截 ─────────────────────────── */

    function ensureStyle(){
        if (document.getElementById("openarc-smart-guard-style")) return;
        var style = document.createElement("style");
        style.id = "openarc-smart-guard-style";
        /* 只消费上游已有 token；复用经典守卫的 .openarc-guard-note 契约（12/18、中性灰、无描边）。*/
        style.textContent = [
            ".openarc-guard-note{display:inline-flex;align-items:center;margin-left:8px;font-size:12px;line-height:18px;font-weight:400;color:var(--muted,var(--text-2,#737373));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:min(60vw,420px)}",
            ".menu-btn[disabled],.direct-option[disabled],#engineSelect option[disabled]{opacity:.45;cursor:not-allowed}",
            "html[data-openarc-readonly=\"1\"] #composer,html[data-openarc-readonly=\"1\"] #createMenu,html[data-openarc-readonly=\"1\"] .node,html[data-openarc-readonly=\"1\"] .image-node,html[data-openarc-readonly=\"1\"] .smart-node-toolbar,html[data-openarc-readonly=\"1\"] .canvas-zoombar,html[data-openarc-readonly=\"1\"] #smartEmptyGuide,html[data-openarc-readonly=\"1\"] #smartTitle,html[data-openarc-readonly=\"1\"] #smartRunSelectedBtn,html[data-openarc-readonly=\"1\"] #smartArrangeBtn,html[data-openarc-readonly=\"1\"] #smartConcatVideosBtn,html[data-openarc-readonly=\"1\"] #smartPickSelectedBtn{pointer-events:none !important}",
            "html[data-openarc-readonly=\"1\"] #world{cursor:not-allowed}",
            "html[data-openarc-readonly=\"1\"] #world .image-node,html[data-openarc-readonly=\"1\"] #world .image-node *{cursor:not-allowed !important}"
        ].join("\n");
        (document.head || document.documentElement).appendChild(style);
    }
    function setNote(anchor, cap, show, text, hostOverride){
        var host = hostOverride || (anchor && anchor.parentElement);
        if (!host) return;
        var note = host.querySelector('[data-openarc-guard-note="' + cap + '"]');
        if (!show) { if (note && note.parentNode) note.parentNode.removeChild(note); return; }
        if (!note) {
            note = document.createElement("span");
            note.className = "openarc-guard-note";
            note.setAttribute("data-openarc-guard-note", cap);
            var span = document.createElement("span");
            span.className = "openarc-guard-note-text";
            note.appendChild(span);
            host.appendChild(note);
        }
        var textEl = note.querySelector(".openarc-guard-note-text");
        if (textEl && textEl.textContent !== text) textEl.textContent = text;
        note.setAttribute("title", text);
    }
    function markUnavailable(el, cap, reason, noteText){
        if (!el) return;
        el.disabled = true;
        el.setAttribute("aria-disabled", "true");
        el.setAttribute("data-openarc-unavailable", cap);
        el.setAttribute("title", reason || UNAVAILABLE_TEXT[cap] || "不可用");
        if (noteText && el.dataset) el.dataset.openarcNote = noteText;
    }
    function clearUnavailable(el){
        if (!el) return;
        el.disabled = false;
        el.removeAttribute("aria-disabled");
        el.removeAttribute("data-openarc-unavailable");
        el.removeAttribute("title");
        if (el.dataset) delete el.dataset.openarcNote;
    }
    function comfyFact(){
        var p = realProvider("comfy");
        var count = hosted && Array.isArray(hosted.comfy_instances) ? hosted.comfy_instances.filter(Boolean).length : 0;
        var ok = !!p && count > 0 && usable("comfy");
        return { ok: ok, count: ok ? Math.max(1, count) : 0 };
    }

    function applyDom(){
        if (!document.body) return;
        ensureStyle();
        var video = capFacts("video-generation");
        var videoDown = !usable("video-generation");
        var videoBtn = document.querySelector('#createMenu [data-create-type="video"]');
        if (videoBtn) {
            if (videoDown) markUnavailable(videoBtn, "video-generation", video.reason || UNAVAILABLE_TEXT["video-generation"], video.reason);
            else clearUnavailable(videoBtn);
        }
        setNote(engineSelect, "video-generation", videoDown, video.reason || UNAVAILABLE_TEXT["video-generation"]);

        var comfy = comfyFact();
        try { comfyInstanceCount = comfy.count; } catch(e) {}

        /* #engineSelect 里未接通 / 未投影的引擎：option 真实 disable（可见 pill 由 C1 的
           unifiedPlatformEntries 过滤，这里是键盘/程序化选择那一层的兜底）。*/
        ["volcengine", "modelscope", "comfy", "runninghub"].forEach(function(id){
            var opt = engineSelect && engineSelect.querySelector('option[value="' + id + '"]');
            if (!opt) return;
            var real = engineAvailable(id);
            opt.disabled = !real;
            if (real) opt.removeAttribute("data-openarc-unavailable");
            else opt.setAttribute("data-openarc-unavailable", id === "comfy" ? "comfy" : (id === "volcengine" ? "video-generation" : id));
            opt.title = real ? "" : (id === "comfy" ? UNAVAILABLE_TEXT.comfy : (id === "volcengine" ? UNAVAILABLE_TEXT["video-generation"] : "OpenArc 未接通 " + id + "（不可用）"));
        });

        var msDown = !realProvider("modelscope");
        document.querySelectorAll('[data-smart-param="msgenModel"],[data-smart-param="msCustomModel"]').forEach(function(el){
            if (msDown) markUnavailable(el, "modelscope", "OpenArc 未接通 ModelScope（不可用）"); else clearUnavailable(el);
        });
        document.querySelectorAll('[data-smart-param="comfyMode"],[data-smart-param="comfyWorkflow"]').forEach(function(el){
            if (!comfy.ok) markUnavailable(el, "comfy", UNAVAILABLE_TEXT.comfy); else clearUnavailable(el);
        });
        document.querySelectorAll('[data-smart-param="videoProvider"],[data-smart-param="videoModel"]').forEach(function(el){
            if (videoDown) markUnavailable(el, "video-generation", video.reason || UNAVAILABLE_TEXT["video-generation"]); else clearUnavailable(el);
        });
        setNote(engineSelect, "comfy", settings.engine === "comfy" && !comfy.ok, UNAVAILABLE_TEXT.comfy);

        var chat = capFacts("chat");
        if (chatModelSelect) {
            var chatDown = !usable("chat");
            chatModelSelect.disabled = chatDown;
            if (chatDown) chatModelSelect.setAttribute("aria-disabled", "true");
            else chatModelSelect.removeAttribute("aria-disabled");
        }
        var ag = agentImageProviderSelect;
        if (ag) {
            var imgDown = !usable("image-generation");
            ag.disabled = imgDown;
            if (imgDown) ag.setAttribute("aria-disabled", "true");
            else ag.removeAttribute("aria-disabled");
        }
        /* 显式默认不可用：如实呈现（既有 .openarc-guard-note + 当前项 disabled），**不静默换模型**。
           替代模型仍可被用户显式选择（点了就记 explicitImageModel / explicitChatModel）。*/
        var imageDef = defaultFact("image-generation");
        var imageDefShown = !!(imageDef && imageDef.usable === false && imageDef.label
            && String(settings.model || "") === imageDef.label);
        var imageDefMissing = !!(imageDef && imageDef.usable === false && !imageDef.label);
        var imagePill = null, imagePopover = null;
        try {
            Array.prototype.forEach.call(document.querySelectorAll("#dynamicParams .model-control"), function(control){
                if (imagePill) return;
                if (!control.querySelector('[data-smart-param="model"]')) return;
                imagePill = control.querySelector(".smart-pill");
                imagePopover = control.querySelector(".smart-popover");
            });
        } catch(e) {}
        if (imagePill) {
            if (imageDefShown || imageDefMissing) {
                imagePill.setAttribute("data-openarc-unavailable", "image-generation");
                imagePill.setAttribute("data-openarc-default-unavailable", "image-generation");
                imagePill.title = defaultNoteText(imageDef);
            } else {
                imagePill.removeAttribute("data-openarc-unavailable");
                imagePill.removeAttribute("data-openarc-default-unavailable");
                imagePill.removeAttribute("title");
            }
            setNote(imagePill, "default-image-model", imageDefShown || imageDefMissing, defaultNoteText(imageDef));
        }
        if (imageDefShown && imagePopover) {
            Array.prototype.forEach.call(imagePopover.querySelectorAll('[data-smart-param="model"]'), function(btn){
                if (btn.getAttribute("data-smart-value") !== imageDef.label) return;
                btn.disabled = true;
                btn.setAttribute("aria-disabled", "true");
                btn.setAttribute("data-openarc-unavailable", "image-generation");
                btn.title = defaultNoteText(imageDef);
            });
        }
        var chatDef = defaultFact("chat");
        var chatDefShown = !!(chatDef && chatDef.usable === false && chatDef.label && String(chatModel || "") === chatDef.label);
        /* 默认模型已从清单里彻底消失（连标签都查不到）：仍然要说清楚，不能装没事。*/
        var chatDefMissing = !!(chatDef && chatDef.usable === false && !chatDef.label);
        if (chatModelSelect) {
            if (chatDefShown) {
                chatModelSelect.setAttribute("data-openarc-default-unavailable", "chat");
                chatModelSelect.title = defaultNoteText(chatDef);
            } else {
                chatModelSelect.removeAttribute("data-openarc-default-unavailable");
            }
            var chatNoteHost = document.getElementById("chatComposerBox");
            if (chatNoteHost) {
                setNote(chatModelSelect, "default-chat-model", chatDefShown || chatDefMissing, defaultNoteText(chatDef), chatNoteHost);
                var chatNote = chatNoteHost.querySelector('[data-openarc-guard-note="default-chat-model"]');
                if (chatNote) { chatNote.style.marginLeft = "0"; chatNote.style.marginTop = "4px"; chatNote.style.maxWidth = "100%"; }
            }
        }
        try {
            var blockedCaps = [];
            if (imageDefShown || imageDefMissing) blockedCaps.push("image-generation");
            if (chatDefShown) blockedCaps.push("chat");
            if (chatDefMissing) blockedCaps.push("chat");
            if (blockedCaps.length) document.documentElement.setAttribute("data-openarc-default-unavailable", blockedCaps.join(" "));
            else document.documentElement.removeAttribute("data-openarc-default-unavailable");
        } catch(e) {}
        applyReadOnlyUi();
    }
    function scheduleApply(){
        if (applyTimer) return;
        applyTimer = window.setTimeout(function(){ applyTimer = null; try { applyDom(); } catch(e) {} }, 120);
    }

    /* 历史 settings.engine 指向未接通引擎：在渲染前回落 api，避免进入没有能力的面板。*/
    var __origRenderDynamicParams = renderDynamicParams;
    renderDynamicParams = function(){
        try {
            if (settings && !engineAvailable(settings.engine)) settings.engine = "api";
        } catch(e) {}
        var out = __origRenderDynamicParams.apply(this, arguments);
        scheduleApply();
        return out;
    };
    var __origLoadConfig = loadConfig;
    loadConfig = async function(){
        var out = await __origLoadConfig.apply(this, arguments);
        try {
            if (hostedPromise) await hostedPromise;
            [settings, canvasDefaultSmartSettings, initialSmartSettings].forEach(function(obj){
                if (obj && !engineAvailable(obj.engine)) obj.engine = "api";
            });
            comfyInstanceCount = comfyFact().count;
            sanitizeSmartApiSelection(settings);
            syncExplicitWithDefaultChange();
            /* 显式生图默认不可用：在渲染参数面板**之前**落成"就是它"，否则 renderApiParams 的
               「没有 model 就取清单第一个」会先静默换成另一个可用模型。*/
            var imgDef = defaultFact("image-generation");
            if (imgDef && imgDef.usable === false && imgDef.label
                && (!explicitImageModel || explicitImageModel === imgDef.label)) {
                settings.model = imgDef.label;
                if (canvasDefaultSmartSettings) canvasDefaultSmartSettings.model = imgDef.label;
            }
        } catch(e) {}
        try { refreshChatModels(); } catch(e) {}
        try { renderDynamicParams(); } catch(e) {}
        scheduleApply();
        return out;
    };

    /* ── C3 只读闸：桥的 context 事实 → 每一条编辑路径被拒 ─────────────────────── */

    function ro(){ return !!window.__openarcCanvasReadOnly; }

    var lastReadOnlyUi = null;
    function applyReadOnlyUi(){
        var r = ro();
        try { document.documentElement.setAttribute("data-openarc-readonly", r ? "1" : "0"); } catch(e) {}
        try {
            [runBtn, cascadeRunBtn].forEach(function(btn){
                if (!btn) return;
                if (r) { btn.disabled = true; btn.setAttribute("aria-disabled", "true"); btn.setAttribute("data-openarc-readonly", "1"); }
                else { btn.removeAttribute("data-openarc-readonly"); btn.removeAttribute("aria-disabled"); }
            });
        } catch(e) {}
        ["smartRunSelectedBtn", "smartArrangeBtn", "smartConcatVideosBtn", "smartPickSelectedBtn"].forEach(function(id){
            var el = document.getElementById(id);
            if (!el) return;
            el.disabled = r;
            if (r) el.setAttribute("aria-disabled", "true"); else el.removeAttribute("aria-disabled");
        });
        if (lastReadOnlyUi === r) return;
        lastReadOnlyUi = r;
        if (!r) { try { __origSyncRunButtonState(); } catch(e) {} }
    }

    function syncReadOnly(forceValue, ctx){
        var value;
        if (typeof forceValue === "boolean") value = forceValue;
        else {
            var b = window.__openarcBridge;
            if (ctx && typeof ctx.readOnly === "boolean") value = !!ctx.readOnly;
            else if (ctx && typeof ctx.canEdit === "boolean") value = !ctx.canEdit;
            else if (b && typeof b.isReadOnly === "function") value = !!b.isReadOnly();
            else value = false;
        }
        window.__openarcCanvasReadOnly = value;
        applyReadOnlyUi();
        scheduleApply();
        return value;
    }
    window.addEventListener("openarc-canvas-context", function(event){
        var d = event && event.detail;
        if (d && typeof d.readOnly === "boolean") syncReadOnly(!!d.readOnly, d);
        else if (d && typeof d.canEdit === "boolean") syncReadOnly(!d.canEdit, d);
        else syncReadOnly(undefined, d);
    });

    /* 事件闸：窗口捕获阶段。只读时，编辑面（画布 / 编辑栏 / 创建菜单 / 各编辑弹层）上的
       指针、拖放、剪贴板、输入事件一律拦下 —— 这是页面侧第一道防线。*/
    var EDIT_SURFACE = [
        "#world", "#composer", "#createMenu", "#canvasZoomBar", "#smartTitle", "#smartEmptyGuide",
        "#promptTemplatePanel", "#promptPresetPanel", "#imageEditModal", "#smartTextModal",
        "#smartLabelPanel", "#smartWorkflowTransferModal", "#assetPanel", "#assetDialogBackdrop",
        "#smartRunSelectedBtn", "#smartArrangeBtn", "#smartConcatVideosBtn", "#smartPickSelectedBtn",
        "#versionPanel", "#chatModal", "#chatComposerBox", "#smartLogModal", "#smartShortcutModal",
        ".smart-node-floating-menu", ".smart-tool-panel", ".smart-node-overlay", ".smart-node-menu",
        ".agent-plan-card", ".chat-modal", ".smart-pick-viewer", ".slash-menu", ".slash-sub",
        ".mention-picker", ".size-custom-submenu", ".smart-control", ".nie-outpaint-panel"
    ].join(",");
    function inEditSurface(el){
        if (!el) return false;
        try { return !!(el.closest && el.closest(EDIT_SURFACE)); } catch(e) { return false; }
    }
    var GATE_TYPES = ["mousedown", "pointerdown", "click", "dblclick", "contextmenu", "dragstart",
        "dragover", "drop", "paste", "cut", "beforeinput", "input", "change"];
    GATE_TYPES.forEach(function(type){
        window.addEventListener(type, function(event){
            if (!ro()) return;
            if (!inEditSurface(event.target)) return;
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
            blocked("READ_ONLY");
        }, true);
    });
    var READONLY_SHORTCUT_KEYS = ["z", "y", "v", "a", "d", "g", "x"];
    window.addEventListener("keydown", function(event){
        if (!ro()) return;
        var key = String(event.key || "");
        var lower = key.toLowerCase();
        var mod = event.metaKey || event.ctrlKey;
        var editKey = (key === "Delete" || key === "Backspace")
            || (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].indexOf(key) >= 0 && !mod)
            || (mod && READONLY_SHORTCUT_KEYS.indexOf(lower) >= 0);
        if (!editKey) return;
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
        blocked("READ_ONLY");
    }, true);

    /* 函数闸：所有会改文档的闭包函数。只读即拒，返回调用方需要的"没发生"值。*/
    var WRAPPED = [];
    var MISSING = [];
    function guardFn(label, orig, ret){
        if (typeof orig !== "function") { MISSING.push(label); return orig; }
        var wrapped = function(){
            if (ro()) { blocked("READ_ONLY"); return (typeof ret === "function") ? ret() : ret; }
            return orig.apply(this, arguments);
        };
        wrapped.__openarcGuardOf = label;
        WRAPPED.push({ name: label, orig: orig, wrapped: wrapped });
        return wrapped;
    }

    pushUndo = guardFn("pushUndo", pushUndo, undefined);
    capturePendingUndo = guardFn("capturePendingUndo", capturePendingUndo, undefined);
    commitPendingUndo = guardFn("commitPendingUndo", commitPendingUndo, undefined);
    discardPendingUndo = guardFn("discardPendingUndo", discardPendingUndo, undefined);
    performUndo = guardFn("performUndo", performUndo, undefined);
    performRedo = guardFn("performRedo", performRedo, undefined);
    restoreUndoSnapshot = guardFn("restoreUndoSnapshot", restoreUndoSnapshot, undefined);

    createNode = guardFn("createNode", createNode, null);
    createImageNodeAt = guardFn("createImageNodeAt", createImageNodeAt, null);
    createPromptNode = guardFn("createPromptNode", createPromptNode, null);
    createSmartGroupNode = guardFn("createSmartGroupNode", createSmartGroupNode, null);
    createNodeFromMenu = guardFn("createNodeFromMenu", createNodeFromMenu, null);
    createSmartBatchNode = guardFn("createSmartBatchNode", createSmartBatchNode, null);
    createSmartTextNode = guardFn("createSmartTextNode", createSmartTextNode, null);
    createSmartLabelNode = guardFn("createSmartLabelNode", createSmartLabelNode, null);
    createSmartTableNode = guardFn("createSmartTableNode", createSmartTableNode, null);
    deleteNode = guardFn("deleteNode", deleteNode, undefined);
    deleteNodeFromButton = guardFn("deleteNodeFromButton", deleteNodeFromButton, undefined);
    clearNodeMediaBeforeDelete = guardFn("clearNodeMediaBeforeDelete", clearNodeMediaBeforeDelete, false);
    deleteImage = guardFn("deleteImage", deleteImage, undefined);
    duplicateSelectedSmartNodes = guardFn("duplicateSelectedSmartNodes", duplicateSelectedSmartNodes, undefined);
    pasteNodes = guardFn("pasteNodes", pasteNodes, undefined);
    duplicateForAltDrag = guardFn("duplicateForAltDrag", duplicateForAltDrag, null);
    nudgeSelectedSmartNodes = guardFn("nudgeSelectedSmartNodes", nudgeSelectedSmartNodes, false);
    alignSelectedSmartNodes = guardFn("alignSelectedSmartNodes", alignSelectedSmartNodes, undefined);
    arrangeSelectedSmartNodes = guardFn("arrangeSelectedSmartNodes", arrangeSelectedSmartNodes, undefined);
    agentArrangeCanvas = guardFn("agentArrangeCanvas", agentArrangeCanvas, undefined);
    renameSmartNodeImage = guardFn("renameSmartNodeImage", renameSmartNodeImage, undefined);
    replaceSmartNodeMedia = guardFn("replaceSmartNodeMedia", replaceSmartNodeMedia, null);
    replaceEditedImage = guardFn("replaceEditedImage", replaceEditedImage, undefined);
    appendImagesToSmartNode = guardFn("appendImagesToSmartNode", appendImagesToSmartNode, undefined);
    handleFiles = guardFn("handleFiles", handleFiles, undefined);
    handleSmartImageDropPayload = guardFn("handleSmartImageDropPayload", handleSmartImageDropPayload, undefined);
    uploadFiles = guardFn("uploadFiles", uploadFiles, undefined);
    relayoutMediaNodeAfterRemoval = guardFn("relayoutMediaNodeAfterRemoval", relayoutMediaNodeAfterRemoval, undefined);
    dropRejectedPicks = guardFn("dropRejectedPicks", dropRejectedPicks, undefined);
    splitStarredPicks = guardFn("splitStarredPicks", splitStarredPicks, undefined);
    concatSelectedVideos = guardFn("concatSelectedVideos", concatSelectedVideos, undefined);
    rerunSmartNode = guardFn("rerunSmartNode", rerunSmartNode, undefined);
    materializeLlmTableNode = guardFn("materializeLlmTableNode", materializeLlmTableNode, null);
    applySegmentStoryboardChannels = guardFn("applySegmentStoryboardChannels", applySegmentStoryboardChannels, undefined);
    applySmartMediaTypeForKind = guardFn("applySmartMediaTypeForKind", applySmartMediaTypeForKind, null);

    addConnection = guardFn("addConnection", addConnection, undefined);
    connectInputNode = guardFn("connectInputNode", connectInputNode, false);
    disconnectConnection = guardFn("disconnectConnection", disconnectConnection, undefined);
    disconnectConnections = guardFn("disconnectConnections", disconnectConnections, undefined);
    insertLoopNodeIntoConnection = guardFn("insertLoopNodeIntoConnection", insertLoopNodeIntoConnection, false);

    groupSelectedNodes = guardFn("groupSelectedNodes", groupSelectedNodes, undefined);
    ungroupNode = guardFn("ungroupNode", ungroupNode, false);
    mergeImageNodesIntoGroup = guardFn("mergeImageNodesIntoGroup", mergeImageNodesIntoGroup, false);
    addNodeToSmartGroup = guardFn("addNodeToSmartGroup", addNodeToSmartGroup, false);
    addDraggedNodeToSmartGroup = guardFn("addDraggedNodeToSmartGroup", addDraggedNodeToSmartGroup, false);
    addDraggedNodesToSmartGroup = guardFn("addDraggedNodesToSmartGroup", addDraggedNodesToSmartGroup, false);
    absorbImageNodeIntoSmartGroup = guardFn("absorbImageNodeIntoSmartGroup", absorbImageNodeIntoSmartGroup, false);
    arrangeSmartGroupMembers = guardFn("arrangeSmartGroupMembers", arrangeSmartGroupMembers, false);
    arrangeSmartGroupMembersInFrame = guardFn("arrangeSmartGroupMembersInFrame", arrangeSmartGroupMembersInFrame, false);
    snapSmartGroupDragBatch = guardFn("snapSmartGroupDragBatch", snapSmartGroupDragBatch, undefined);
    pruneSmartGroupMembershipsForNode = guardFn("pruneSmartGroupMembershipsForNode", pruneSmartGroupMembershipsForNode, false);

    applyImageEdit = guardFn("applyImageEdit", applyImageEdit, undefined);
    applyImageCrop = guardFn("applyImageCrop", applyImageCrop, undefined);
    applyImageOutpaint = guardFn("applyImageOutpaint", applyImageOutpaint, undefined);
    applyImageMask = guardFn("applyImageMask", applyImageMask, undefined);
    applyImageBrush = guardFn("applyImageBrush", applyImageBrush, undefined);
    applyImageGridSplit = guardFn("applyImageGridSplit", applyImageGridSplit, undefined);
    applyImageGridJoin = guardFn("applyImageGridJoin", applyImageGridJoin, undefined);
    applyImageResize = guardFn("applyImageResize", applyImageResize, undefined);
    transformSmartNodeImage = guardFn("transformSmartNodeImage", transformSmartNodeImage, undefined);
    splitSmartNodeImageGrid = guardFn("splitSmartNodeImageGrid", splitSmartNodeImageGrid, undefined);
    layerSplitSmartNodeImage = guardFn("layerSplitSmartNodeImage", layerSplitSmartNodeImage, undefined);
    applyOutpaintSizeToSmartParams = guardFn("applyOutpaintSizeToSmartParams", applyOutpaintSizeToSmartParams, undefined);
    setSmartImageMode = guardFn("setSmartImageMode", setSmartImageMode, undefined);
    blurFacesForSmartNode = guardFn("blurFacesForSmartNode", blurFacesForSmartNode, undefined);
    mattingForSmartNode = guardFn("mattingForSmartNode", mattingForSmartNode, undefined);
    hqMattingForSmartNode = guardFn("hqMattingForSmartNode", hqMattingForSmartNode, undefined);
    runLocalMatting = guardFn("runLocalMatting", runLocalMatting, undefined);
    hdUpscaleForSmartNode = guardFn("hdUpscaleForSmartNode", hdUpscaleForSmartNode, undefined);
    runHdUpscale = guardFn("runHdUpscale", runHdUpscale, undefined);

    updateSmartLabelNode = guardFn("updateSmartLabelNode", updateSmartLabelNode, undefined);
    beginSmartLabelEdit = guardFn("beginSmartLabelEdit", beginSmartLabelEdit, false);
    syncSmartTextEditorNode = guardFn("syncSmartTextEditorNode", syncSmartTextEditorNode, null);
    closeSmartTextEditor = guardFn("closeSmartTextEditor", closeSmartTextEditor, false);
    setSmartLoopPromptFieldValues = guardFn("setSmartLoopPromptFieldValues", setSmartLoopPromptFieldValues, undefined);
    toggleInputRefBlocked = guardFn("toggleInputRefBlocked", toggleInputRefBlocked, false);
    addManualReferenceToSelectedNode = guardFn("addManualReferenceToSelectedNode", addManualReferenceToSelectedNode, undefined);
    removeManualReferenceFromSelectedNode = guardFn("removeManualReferenceFromSelectedNode", removeManualReferenceFromSelectedNode, undefined);
    saveSmartPromptTextFromComposer = guardFn("saveSmartPromptTextFromComposer", saveSmartPromptTextFromComposer, undefined);
    savePromptDraftForCurrent = guardFn("savePromptDraftForCurrent", savePromptDraftForCurrent, undefined);
    setPromptDraftForNode = guardFn("setPromptDraftForNode", setPromptDraftForNode, undefined);
    setDynamicSetting = guardFn("setDynamicSetting", setDynamicSetting, undefined);
    applyUnifiedPlatform = guardFn("applyUnifiedPlatform", applyUnifiedPlatform, undefined);
    changeChatModel = guardFn("changeChatModel", changeChatModel, undefined);
    changeAgentImageProvider = guardFn("changeAgentImageProvider", changeAgentImageProvider, undefined);
    toggleAgentPlanConfirm = guardFn("toggleAgentPlanConfirm", toggleAgentPlanConfirm, undefined);
    toggleAgentReview = guardFn("toggleAgentReview", toggleAgentReview, undefined);
    persistActiveSmartSettings = guardFn("persistActiveSmartSettings", persistActiveSmartSettings, undefined);
    rememberRecentSmartSettings = guardFn("rememberRecentSmartSettings", rememberRecentSmartSettings, undefined);
    savePromptPresets = guardFn("savePromptPresets", savePromptPresets, undefined);
    savePromptTemplateGroups = guardFn("savePromptTemplateGroups", savePromptTemplateGroups, undefined);
    savePromptTemplateOverrides = guardFn("savePromptTemplateOverrides", savePromptTemplateOverrides, undefined);
    createPromptTemplateGroup = guardFn("createPromptTemplateGroup", createPromptTemplateGroup, undefined);
    renamePromptTemplateGroup = guardFn("renamePromptTemplateGroup", renamePromptTemplateGroup, undefined);
    deletePromptTemplateGroup = guardFn("deletePromptTemplateGroup", deletePromptTemplateGroup, undefined);
    createBlankPromptTemplate = guardFn("createBlankPromptTemplate", createBlankPromptTemplate, undefined);
    savePromptTemplateEdit = guardFn("savePromptTemplateEdit", savePromptTemplateEdit, undefined);
    deletePromptTemplate = guardFn("deletePromptTemplate", deletePromptTemplate, undefined);
    saveCurrentPromptAsTemplate = guardFn("saveCurrentPromptAsTemplate", saveCurrentPromptAsTemplate, undefined);
    applyPromptTemplateToNode = guardFn("applyPromptTemplateToNode", applyPromptTemplateToNode, undefined);
    createPromptPresetFromNode = guardFn("createPromptPresetFromNode", createPromptPresetFromNode, undefined);
    createPromptPresetFromComposer = guardFn("createPromptPresetFromComposer", createPromptPresetFromComposer, undefined);
    savePromptNodeAsPreset = guardFn("savePromptNodeAsPreset", savePromptNodeAsPreset, undefined);
    editPromptPresetForNode = guardFn("editPromptPresetForNode", editPromptPresetForNode, undefined);
    insertSmartWorkflowIntoCanvas = guardFn("insertSmartWorkflowIntoCanvas", insertSmartWorkflowIntoCanvas, null);
    importSmartWorkflowFile = guardFn("importSmartWorkflowFile", importSmartWorkflowFile, undefined);
    applyHomeCanvasSeed = guardFn("applyHomeCanvasSeed", applyHomeCanvasSeed, undefined);

    addUrlToAssetLibrary = guardFn("addUrlToAssetLibrary", addUrlToAssetLibrary, undefined);
    addFilesToLocalAssetLibrary = guardFn("addFilesToLocalAssetLibrary", addFilesToLocalAssetLibrary, undefined);
    addLocalPathsToLocalAssetLibrary = guardFn("addLocalPathsToLocalAssetLibrary", addLocalPathsToLocalAssetLibrary, undefined);
    addUrlItemsToLocalAssetLibrary = guardFn("addUrlItemsToLocalAssetLibrary", addUrlItemsToLocalAssetLibrary, undefined);
    addUrlToLocalAssetLibrary = guardFn("addUrlToLocalAssetLibrary", addUrlToLocalAssetLibrary, undefined);
    deleteLocalAssetFromPanel = guardFn("deleteLocalAssetFromPanel", deleteLocalAssetFromPanel, undefined);
    beginAssetInlineRename = guardFn("beginAssetInlineRename", beginAssetInlineRename, undefined);

    applyAgentCanvasOps = guardFn("applyAgentCanvasOps", applyAgentCanvasOps, 0);
    agentRunClientActions = guardFn("agentRunClientActions", agentRunClientActions, undefined);
    agentUndoRun = guardFn("agentUndoRun", agentUndoRun, undefined);
    agentConfirmResolve = guardFn("agentConfirmResolve", agentConfirmResolve, undefined);
    agentConfirmCardAdd = guardFn("agentConfirmCardAdd", agentConfirmCardAdd, undefined);
    sendChatMessage = guardFn("sendChatMessage", sendChatMessage, undefined);
    runAgentStream = guardFn("runAgentStream", runAgentStream, undefined);
    requestAgentPlan = guardFn("requestAgentPlan", requestAgentPlan, undefined);
    agentReviewRun = guardFn("agentReviewRun", agentReviewRun, undefined);
    agentReviewRequest = guardFn("agentReviewRequest", agentReviewRequest, undefined);
    executeChatActions = guardFn("executeChatActions", executeChatActions, undefined);
    writeAssistantTextNode = guardFn("writeAssistantTextNode", writeAssistantTextNode, undefined);
    agentRetryGenerate = guardFn("agentRetryGenerate", agentRetryGenerate, undefined);
    agentPollGenerateTask = guardFn("agentPollGenerateTask", agentPollGenerateTask, undefined);
    chatUploadSelected = guardFn("chatUploadSelected", chatUploadSelected, undefined);
    uploadFilesFromDataTransfer = guardFn("uploadFilesFromDataTransfer", uploadFilesFromDataTransfer, undefined);

    runGeneration = guardFn("runGeneration", runGeneration, undefined);
    runPromptLLMNode = guardFn("runPromptLLMNode", runPromptLLMNode, undefined);
    runSmartPromptChat = guardFn("runSmartPromptChat", runSmartPromptChat, undefined);
    runApiGeneration = guardFn("runApiGeneration", runApiGeneration, undefined);
    runRunningHubGeneration = guardFn("runRunningHubGeneration", runRunningHubGeneration, undefined);
    runApiVideoGeneration = guardFn("runApiVideoGeneration", runApiVideoGeneration, undefined);
    runModelscopeGeneration = guardFn("runModelscopeGeneration", runModelscopeGeneration, undefined);
    runComfyGeneration = guardFn("runComfyGeneration", runComfyGeneration, undefined);
    runCascadeTargetList = guardFn("runCascadeTargetList", runCascadeTargetList, undefined);
    runSelectedNodesCascade = guardFn("runSelectedNodesCascade", runSelectedNodesCascade, undefined);
    runSmartCascade = guardFn("runSmartCascade", runSmartCascade, undefined);
    runSmartCascadeFromLoop = guardFn("runSmartCascadeFromLoop", runSmartCascadeFromLoop, undefined);
    runSmartGroupToolbarAction = guardFn("runSmartGroupToolbarAction", runSmartGroupToolbarAction, undefined);
    runSmartNodeToolbarAction = guardFn("runSmartNodeToolbarAction", runSmartNodeToolbarAction, undefined);
    runSmartToolbarGeneration = guardFn("runSmartToolbarGeneration", runSmartToolbarGeneration, undefined);
    runSmartToolbarMaskGeneration = guardFn("runSmartToolbarMaskGeneration", runSmartToolbarMaskGeneration, undefined);
    tableRunGenerator = guardFn("tableRunGenerator", tableRunGenerator, undefined);
    tableRunVideo = guardFn("tableRunVideo", tableRunVideo, undefined);
    retrySmartLogEntry = guardFn("retrySmartLogEntry", retrySmartLogEntry, undefined);
    runQueuedSmartComfyGenerate = guardFn("runQueuedSmartComfyGenerate", runQueuedSmartComfyGenerate, undefined);
    createSmartComfyTask = guardFn("createSmartComfyTask", createSmartComfyTask, null);
    createPendingOutputFromSource = guardFn("createPendingOutputFromSource", createPendingOutputFromSource, null);
    finalizePendingNode = guardFn("finalizePendingNode", finalizePendingNode, null);
    autoPlaceGeneratedNode = guardFn("autoPlaceGeneratedNode", autoPlaceGeneratedNode, null);
    completeSmartNodeWithImages = guardFn("completeSmartNodeWithImages", completeSmartNodeWithImages, undefined);

    openCreateMenu = guardFn("openCreateMenu", openCreateMenu, undefined);
    openSmartNodeMenu = guardFn("openSmartNodeMenu", openSmartNodeMenu, undefined);
    openSmartToolPanel = guardFn("openSmartToolPanel", openSmartToolPanel, undefined);
    applySmartToolbarPick = guardFn("applySmartToolbarPick", applySmartToolbarPick, undefined);
    applySmartToolbarTemplate = guardFn("applySmartToolbarTemplate", applySmartToolbarTemplate, undefined);
    duplicateSmartNodeMediaToCanvas = guardFn("duplicateSmartNodeMediaToCanvas", duplicateSmartNodeMediaToCanvas, null);
    openSmartNodeOverlay = guardFn("openSmartNodeOverlay", openSmartNodeOverlay, undefined);
    openImageEditor = guardFn("openImageEditor", openImageEditor, false);

    restoreCanvasVersion = guardFn("restoreCanvasVersion", restoreCanvasVersion, undefined);
    deleteCanvasVersion = guardFn("deleteCanvasVersion", deleteCanvasVersion, undefined);

    saveCanvas = guardFn("saveCanvas", saveCanvas, undefined);
    scheduleSave = guardFn("scheduleSave", scheduleSave, undefined);

    /* 被页面提前 window.* 导出的那批：把 window 上的引用重新指到包装后的实现。*/
    WRAPPED.forEach(function(entry){
        try { if (window[entry.name] === entry.orig) window[entry.name] = entry.wrapped; } catch(e) {}
    });

    var __origSyncRunButtonState = syncRunButtonState;
    syncRunButtonState = function(node){
        var out = __origSyncRunButtonState.apply(this, arguments);
        try {
            var cap = capabilityForRun(node || selectedNode());
            if (ro()) {
                if (runBtn) runBtn.disabled = true;
            } else if (cap && !usableCapability(cap)) {
                if (runBtn) { runBtn.disabled = true; runBtn.setAttribute("data-openarc-blocked", cap); }
            } else if (runBlockedDefault(node || selectedNode())) {
                var hit = runBlockedDefault(node || selectedNode());
                if (runBtn) {
                    runBtn.disabled = true;
                    runBtn.setAttribute("data-openarc-blocked", "MODEL_UNAVAILABLE");
                    runBtn.setAttribute("data-openarc-default-unavailable", hit.capability);
                    runBtn.title = defaultNoteText(hit.fact);
                }
            } else if (runBtn) {
                runBtn.removeAttribute("data-openarc-blocked");
                runBtn.removeAttribute("data-openarc-default-unavailable");
            }
        } catch(e) {}
        return out;
    };

    /* ── 运行入口：能力不可用就在页面侧拒绝，不发必失败的请求 ────────────────── */

    function capabilityForRun(node){
        if (!node) return null;
        if (isSmartPromptNode(node)) return "chat";
        var eff = settings;
        try { eff = smartSettingsForNode(node) || settings; } catch(e) { eff = settings; }
        if (eff && eff.engine === "comfy") return "comfy";
        if (eff && eff.engine === "modelscope") return "modelscope";
        if (eff && eff.engine === "volcengine") return realProvider("volcengine") ? null : "video-generation";
        if (eff && isApiLikeEngine(eff.engine || "api") && eff.apiKind === "video") return "video-generation";
        return "image-generation";
    }
    function usableCapability(cap){
        if (cap === "modelscope") return !!realProvider("modelscope");
        return usable(cap);
    }
    /** 这次运行会不会真的用上那个"显式默认不可用"的模型：是 → 页面侧就不发这条必失败的请求。
     *  host 的拒绝语义不变（D2/F1 仍成立），这里只是把"已知必失败"提前如实拦住。*/
    function runBlockedDefault(nodeOrId){
        var node = nodeOrId;
        if (typeof nodeOrId === "string") node = (nodes || []).find(function(n){ return n && n.id === nodeOrId; }) || null;
        var cap = capabilityForRun(node);
        var def = defaultFact(cap);
        if (!def || def.usable !== false || !def.label) return null;
        var model = "";
        if (cap === "chat") model = String(currentChatModel() || (node && node.llmModel) || "");
        else {
            try { model = String((smartSettingsForNode(node) || settings).model || ""); } catch(e) { model = ""; }
            if (!model) model = String((settings && settings.model) || "");
        }
        return model === def.label ? { capability: cap, fact: def } : null;
    }
    function withCapability(fn, capOf){
        return function(){
            var cap = typeof capOf === "function" ? capOf.apply(this, arguments) : capOf;
            if (cap && !usableCapability(cap)) return blocked("CAPABILITY_UNAVAILABLE", cap);
            return fn.apply(this, arguments);
        };
    }
    var __origRunGeneration = runGeneration;
    runGeneration = withCapability(__origRunGeneration, function(){ return capabilityForRun(selectedNode()); });
    runApiVideoGeneration = withCapability(runApiVideoGeneration, "video-generation");
    runModelscopeGeneration = withCapability(runModelscopeGeneration, "modelscope");
    runComfyGeneration = withCapability(runComfyGeneration, "comfy");
    runPromptLLMNode = withCapability(runPromptLLMNode, "chat");
    createSmartComfyTask = withCapability(createSmartComfyTask, "comfy");
    var __origRunPromptLLMNode = runPromptLLMNode;
    runPromptLLMNode = function(nodeOrId){
        var hit = runBlockedDefault(nodeOrId);
        if (hit) return blocked("MODEL_UNAVAILABLE", hit.capability, defaultNoteText(hit.fact));
        return __origRunPromptLLMNode.apply(this, arguments);
    };
    var __origRunGenerationGuarded = runGeneration;
    runGeneration = function(){
        var hit = runBlockedDefault(selectedNode());
        if (hit) return blocked("MODEL_UNAVAILABLE", hit.capability, defaultNoteText(hit.fact));
        return __origRunGenerationGuarded.apply(this, arguments);
    };
    var __origCreateNodeFromMenu = createNodeFromMenu;
    createNodeFromMenu = function(type){
        if (String(type) === "video" && !usable("video-generation")) return blocked("CAPABILITY_UNAVAILABLE", "video-generation");
        return __origCreateNodeFromMenu.apply(this, arguments);
    };

    /* ── 真源读取 + 未接通端点页面侧明确失败 + 只读写请求页面侧拒绝 ───────────── */

    var __origFetch = window.fetch;
    if (typeof __origFetch === "function") {
        window.fetch = function(input, init){
            var url = typeof input === "string" ? input : (input && input.url) || "";
            var path = "";
            try { path = new URL(url, window.location.href).pathname; } catch(e) { path = String(url); }
            if (path === "/api/config") {
                return __origFetch.apply(this, arguments).then(function(res){
                    try {
                        hostedPromise = res.clone().json().then(function(cfg){
                            hosted = cfg || null;
                            return hosted;
                        }).catch(function(){ return null; });
                    } catch(e) { /* ignore */ }
                    return res;
                });
            }
            if (path === "/api/canvas-video" || path.indexOf("/api/canvas-comfy-tasks") === 0) {
                var cap = path.indexOf("/api/canvas-comfy-tasks") === 0 ? "comfy" : "video-generation";
                if (!usable(cap)) {
                    var f = capFacts(cap);
                    blocked("CAPABILITY_UNAVAILABLE", cap);
                    return Promise.resolve(new Response(JSON.stringify({
                        error: "CAPABILITY_UNAVAILABLE", detail: f.reason, capability: cap,
                        message: f.reason, available: false, transport: null
                    }), { status: 501, headers: { "content-type": "application/json" } }));
                }
            }
            if (ro()) {
                var method = "GET";
                try {
                    if (init && init.method) method = String(init.method);
                    else if (input && typeof input === "object" && input.method) method = String(input.method);
                } catch(e) {}
                method = method.toUpperCase();
                if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
                    writeBlockedCount += 1;
                    blocked("READ_ONLY_WRITE");
                    return Promise.resolve(new Response(JSON.stringify({
                        error: "READ_ONLY", message: "只读画布不可写入", readOnly: true
                    }), { status: 403, headers: { "content-type": "application/json" } }));
                }
            }
            return __origFetch.apply(this, arguments);
        };
    }

    /* ── 重渲染后重新落事实（平台 pill / 创建菜单都会被上游重建）────────────── */

    var __origRenderUnified = renderUnifiedPlatformControl;
    renderUnifiedPlatformControl = function(){
        var out = __origRenderUnified.apply(this, arguments);
        scheduleApply();
        return out;
    };
    if (typeof MutationObserver === "function" && composer) {
        try {
            new MutationObserver(scheduleApply).observe(composer, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
        } catch(e) { /* ignore */ }
    }

    /* ── C4 证据面（门禁 / 真机探针只读）─────────────────────────────────────── */

    function guardSnapshot(){
        var payload = {};
        try { payload.title = canvas ? canvas.title : ""; } catch(e) {}
        try { payload.icon = canvas ? canvas.icon : ""; } catch(e) {}
        try { payload.nodes = nodes; } catch(e) {}
        try { payload.connections = canvas ? canvas.connections : []; } catch(e) {}
        try { payload.logs = canvas ? canvas.logs : []; } catch(e) {}
        try { payload.settings = settings; } catch(e) {}
        try { payload.updated_at = canvas ? canvas.updated_at : 0; } catch(e) {}
        try { return JSON.stringify(payload); } catch(e) { return "ERR:" + String(e && e.message || e); }
    }

    window.__openarcSmartGuard = {
        version: 4,
        facts: function(){
            return {
                hosted: !!hosted,
                readOnly: ro(),
                chat: capFacts("chat"),
                image: capFacts("image-generation"),
                video: capFacts("video-generation"),
                comfy: capFacts("comfy"),
                providers: (apiProviders || []).map(function(p){ return p.id; }),
                engines: ["api", "volcengine", "modelscope", "comfy", "runninghub"].filter(engineAvailable),
                defaults: {
                    chat: defaultFact("chat"),
                    image: defaultFact("image-generation"),
                    blocked: ["chat", "image-generation"].filter(defaultBlocked),
                    explicit: { chat: explicitChatModel, image: explicitImageModel }
                }
            };
        },
        providers: function(){
            return (apiProviders || []).map(function(p){
                return { id: p.id, chat: unique(p.chat_models), image: unique(p.image_models), video: unique(p.video_models) };
            });
        },
        hostChatModels: hostChatModels,
        hostImageModels: hostImageModels,
        hostVideoModels: hostVideoModels,
        blocked: function(){ return blockedLog.slice(); },
        snapshot: guardSnapshot,
        writeBlocked: function(){ return writeBlockedCount; },
        surfaces: function(){ return EDIT_SURFACE; },
        storage: function(){
            return { locked: storageLocked, keys: ["smart_chat_model", "smart_chat_provider", "smart_agent_image_provider", "smart_canvas_recent_run_settings_v1"] };
        },
        videoEntry: function(){
            var el = document.querySelector('#createMenu [data-create-type="video"]');
            return el ? { disabled: !!el.disabled, mark: el.getAttribute("data-openarc-unavailable"), title: el.getAttribute("title") } : null;
        },
        wrapped: function(){
            return { count: WRAPPED.length, names: WRAPPED.map(function(e){ return e.name; }), missing: MISSING.slice() };
        }
    };

    syncReadOnly();
    scheduleApply();
    window.setTimeout(function(){ try { syncReadOnly(); applyDom(); } catch(e) {} }, 1500);
})();
