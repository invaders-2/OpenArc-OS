/* ══════════════════════════════════════════════════════════════════════════════
   OpenArc 智能画布 · 最小封堵（不移植经典守卫；追加在 smart-canvas.js 的 IIFE 末尾）
   ──────────────────────────────────────────────────────────────────────────────
   背景：入口改向之后 smart-canvas.html 成为唯一可达的编辑器，但它当前只注入了
   openarc-bridge.js —— 页面侧自带一堆"自己造事实"的兜底（DEFAULT_VIDEO_MODELS /
   modelscopeImageModels 默认值 / resolveChatModel 的 gpt-4o-mini / initChatModel 的
   gpt-4o-mini / unifiedPlatformEntries 恒列 volcengine+modelscope+comfy+runninghub），
   会出现"看着能选视频、实际 501"的**假可用**。本文件只做四件能证明"不假可用"的小事，
   经典守卫的其余语义（清单外旧值清理、模型来源键锁定、节点级运行标记、状态位、
   409 合并 / AI 来源标记等）一律**不搬**。

   覆盖（可验证）：
   C1 供应商 / 模型清单只来自宿主 /api/config 投影：
      · volcengineProvider / volcengineVideoModels / modelscopeImageModels 的页面内置兜底全部失效；
      · resolveChatModel 不再回落 gpt-4o-mini；
      · initChatModel 在宿主没有任何对话模型时清掉 gpt-4o-mini 兜底（下拉置为"未配置"并 disable）；
      · unifiedPlatformEntries 的「其它引擎」只列宿主 api_providers 里真实存在的 provider。
   C2 未接通能力（视频 / ComfyUI）如实禁用 + 标注（复用经典守卫的 openarc-guard-note /
      data-openarc-unavailable 契约，不新造视觉）：视频 kind 按钮真实 disable，
      #engineSelect 里未接通的引擎 option disable，能力不可用时运行入口在页面侧就被拒
      （不会走到 501），/api/canvas-video 与 /api/canvas-comfy-tasks 直接给出明确不可用错误。
   C3 只读画布：**每一条编辑路径都被拒**（本包把最小封堵补到"逐条"）：
      · 桥的 openarc-canvas-context 事实落到 window.__openarcCanvasReadOnly（后到的 context 同样生效，
        readOnly / canEdit 两个字段都认；桥默认 readOnly:true 是 fail-closed）；
      · 编辑面 pointer-events 关闭 + 光标 not-allowed，与闸一致；
      · 事件闸（window 捕获阶段）：#world / #composer / #createMenu / 各编辑弹层上的
        mousedown/pointerdown/click/dblclick/contextmenu/dragstart/dragover/drop/paste/cut/
        beforeinput/input/change 一律 preventDefault + stopImmediatePropagation 并记 blocked；
        键盘编辑键（Delete/Backspace/方向键/Cmd+Z、Y、V、A、D、G、X）同样在捕获阶段拦下；
      · 函数闸：把 ~170 个会改文档的闭包函数逐个包成"只读即拒"（拖动/缩放/框选/连线/增删/分组/
        表格/内联编辑/参数面板/右键菜单/撤销重做/模板库写/素材库写/Agent ops/生成落图/保存…），
        并把其中被 window.* 提前导出的那些重新指到包装后的实现（HTML onclick 走的是 window）；
      · fetch 闸：只读时任何非 GET/HEAD/OPTIONS 的请求都在页面侧被拒并记 blocked（后端收不到写请求）。
   C4 证据面：window.__openarcSmartGuard.facts()/providers()/blocked()/snapshot()/wrapped()/
      writeBlocked()/surfaces() 供门禁与真机探针读取。

   未覆盖（待重新 vendor 时按最终源码补齐，清单见 SOURCE.md / PRUNE.md 与
   experiments/dxos-canvas-scope/README.md）：
   · 模型清单外的历史旧值没有逐条从画布文档里清理（只做了默认值不回落）；
   · 节点级可用性徽标 / 状态位 / "打开 OpenArc 总 API 设置"引导没有做；
   · 供应商 baseUrl/凭据等本来就拿不到，未做额外锁定；
   · 三把经典 localStorage 模型来源键智能画布不读，未做锁定；
   · 表格/批量节点用外部 shared/table-node.js 模块，内部模型改动由事件闸整体挡在交互层之前
     （模块自身没有可包装的注入点，见 experiments/dxos-canvas-scope/README.md 第 11 节）。
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
    var blockedLog = [];
    var applyTimer = null;
    var lastToastAt = 0;
    var writeBlockedCount = 0;

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
    function realProvider(id){
        var list = (apiProviders || []).filter(function(p){ return p && p.id === id && p.enabled !== false; });
        return list[0] || null;
    }
    function hostChatModels(){
        var out = [];
        (apiProviders || []).forEach(function(p){
            if (!p || p.enabled === false) return;
            unique(p.chat_models).forEach(function(m){ out.push({ name: m, provider: p.id }); });
        });
        return out;
    }
    function blocked(reason, capability){
        var entry = { at: Date.now(), reason: String(reason || ""), capability: capability || null };
        blockedLog.push(entry);
        if (blockedLog.length > 120) blockedLog.shift();
        try { window.dispatchEvent(new CustomEvent("openarc-canvas-blocked", { detail: entry })); } catch(e) {}
        var now = Date.now();
        if (now - lastToastAt > 600) {
            lastToastAt = now;
            try {
                if (typeof toast === "function") {
                    toast(capability ? (capFacts(capability).reason || UNAVAILABLE_TEXT[capability] || "不可用") : "只读画布不可编辑", "!");
                }
            } catch(e) {}
        }
        return null;
    }

    /* ── C1 页面内置兜底清单全部失效：供应商 / 模型只来自宿主投影 ───────────────── */

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
        var others = ["volcengine", "modelscope", "comfy", "runninghub"]
            .filter(function(id){ return !!realProvider(id); })
            .map(function(value){ return { engine: value, id: "", name: value === "modelscope" ? "ModelScope" : engineName(value) }; });
        return { api: api, others: others, isVideo: isVideo };
    };
    /* 助手的两处 gpt-4o-mini 兜底：宿主没有任何对话模型时清零并如实标注。*/
    var __origInitChatModel = initChatModel;
    initChatModel = function(){
        var out = __origInitChatModel.apply(this, arguments);
        if (!hostChatModels().length) {
            chatModel = "";
            chatProvider = "";
            if (chatModelSelect) {
                chatModelSelect.innerHTML = '<option value="">未配置</option>';
                chatModelSelect.value = "";
            }
        }
        applyDom();
        return out;
    };
    currentChatModel = function(){ return chatModel || ""; };
    /* 页面在 IIFE 中段就把这两个函数挂到了 window：重新指向被本封堵改写后的实现。*/
    try { window.initChatModel = initChatModel; window.currentChatModel = currentChatModel; } catch(e) {}

    /* ── C2 未接通能力：页面侧真实禁用 / 标注 / 拦截 ─────────────────────────── */

    function ensureStyle(){
        if (document.getElementById("openarc-smart-guard-style")) return;
        var style = document.createElement("style");
        style.id = "openarc-smart-guard-style";
        /* 只消费上游已有 token；复用经典守卫的 .openarc-guard-note 契约（12/18、中性灰、无描边）。*/
        style.textContent = [
            ".openarc-guard-note{display:inline-flex;align-items:center;margin-left:8px;font-size:12px;line-height:18px;font-weight:400;color:var(--muted,var(--text-2,#737373));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:min(60vw,420px)}",
            ".kind-toggle button[disabled],#engineSelect option[disabled]{opacity:.45;cursor:not-allowed}",
            "html[data-openarc-readonly=\"1\"] #composer,html[data-openarc-readonly=\"1\"] #createMenu,html[data-openarc-readonly=\"1\"] .node,html[data-openarc-readonly=\"1\"] .smart-node-toolbar,html[data-openarc-readonly=\"1\"] .canvas-zoombar,html[data-openarc-readonly=\"1\"] #smartEmptyGuide,html[data-openarc-readonly=\"1\"] #smartTitle,html[data-openarc-readonly=\"1\"] #smartRunSelectedBtn,html[data-openarc-readonly=\"1\"] #smartArrangeBtn,html[data-openarc-readonly=\"1\"] #smartConcatVideosBtn,html[data-openarc-readonly=\"1\"] #smartPickSelectedBtn{pointer-events:none !important}",
            "html[data-openarc-readonly=\"1\"] #world{cursor:not-allowed}",
            "html[data-openarc-readonly=\"1\"] #world .image-node,html[data-openarc-readonly=\"1\"] #world .image-node *{cursor:not-allowed !important}"
        ].join("\n");
        (document.head || document.documentElement).appendChild(style);
    }
    function setNote(anchor, cap, show, text){
        var host = anchor && anchor.parentElement;
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

    function applyDom(){
        if (!document.body) return;
        ensureStyle();
        var video = capFacts("video-generation");
        var videoDown = !usable("video-generation");
        var videoBtn = apiKindToggle && apiKindToggle.querySelector('[data-kind="video"]');
        if (videoBtn) {
            if (videoDown) {
                if (!videoBtn.disabled) videoBtn.disabled = true;
                videoBtn.setAttribute("aria-disabled", "true");
                videoBtn.setAttribute("data-openarc-unavailable", "video-generation");
                videoBtn.setAttribute("title", video.reason || UNAVAILABLE_TEXT["video-generation"]);
                if (settings.apiKind === "video") {
                    settings.apiKind = "image";
                    try { renderDynamicParams(); } catch(e) {}
                }
            } else {
                videoBtn.disabled = false;
                videoBtn.removeAttribute("aria-disabled");
                videoBtn.removeAttribute("data-openarc-unavailable");
                videoBtn.removeAttribute("title");
            }
        }
        setNote(apiKindToggle, "video-generation", videoDown, video.reason || UNAVAILABLE_TEXT["video-generation"]);

        /* #engineSelect 里未接通 / 未投影的引擎：option 真实 disable（可见 pill 由 C1 的
           unifiedPlatformEntries 过滤，这里是键盘/程序化选择那一层的兜底）。*/
        ["volcengine", "modelscope", "comfy", "runninghub"].forEach(function(id){
            var opt = engineSelect && engineSelect.querySelector('option[value="' + id + '"]');
            if (!opt) return;
            var real = !!realProvider(id);
            opt.disabled = !real;
            if (real) opt.removeAttribute("data-openarc-unavailable");
            else opt.setAttribute("data-openarc-unavailable", id === "comfy" ? "comfy" : (id === "volcengine" ? "video-generation" : id));
        });

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
        applyReadOnlyUi();
    }
    function scheduleApply(){
        if (applyTimer) return;
        applyTimer = window.setTimeout(function(){ applyTimer = null; try { applyDom(); } catch(e) {} }, 120);
    }

    /* ── C3 只读闸：桥的 context 事实 → 每一条编辑路径被拒 ─────────────────────── */

    function ro(){ return !!window.__openarcCanvasReadOnly; }

    /* 只读时与闸一致的 UI：属性、光标、禁用态、pointer-events（CSS）。*/
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
        /* 回到可编辑：把运行按钮的交由页面原生状态机重算（只读时我把它恒 disable 过）。*/
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
        ".smart-node-floating-menu", ".smart-tool-panel", ".smart-node-overlay", ".smart-node-menu",
        ".agent-plan-card", ".chat-modal", ".smart-pick-viewer", ".slash-menu", ".slash-sub",
        ".mention-picker", ".size-custom-submenu", ".smart-control"
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

    /* 函数闸：所有会改文档的闭包函数。只读即拒，返回调用方需要的"没发生"值。
       包装只影响只读态；可编辑态原样透传（ret === undefined 也原样透传）。*/
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
    createLoopNode = guardFn("createLoopNode", createLoopNode, null);
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

    /* 被页面提前 window.* 导出的那批：把 window 上的引用重新指到包装后的实现。
       （HTML 里的 onclick="applyImageEdit()" 走的是 window，不重指就绕过了闸。）*/
    WRAPPED.forEach(function(entry){
        try { if (window[entry.name] === entry.orig) window[entry.name] = entry.wrapped; } catch(e) {}
    });

    var __origSyncRunButtonState = syncRunButtonState;
    syncRunButtonState = function(){
        var out = __origSyncRunButtonState.apply(this, arguments);
        if (ro() && runBtn) runBtn.disabled = true;
        return out;
    };

    /* ── 运行入口：能力不可用就在页面侧拒绝，不发必失败的请求 ────────────────── */

    function capabilityForRun(node){
        if (!node) return null;
        if (isSmartPromptNode(node)) return "chat";
        var eff = settings;
        try { eff = smartSettingsForNode(node) || settings; } catch(e) { eff = settings; }
        if (eff && eff.engine === "comfy") return "comfy";
        if (eff && isApiLikeEngine(eff.engine || "api") && eff.apiKind === "video") return "video-generation";
        return "image-generation";
    }
    var __origRunGeneration = runGeneration;
    runGeneration = async function(){
        var cap = capabilityForRun(selectedNode());
        if (cap && !usable(cap)) return blocked("CAPABILITY_UNAVAILABLE", cap);
        return __origRunGeneration.apply(this, arguments);
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
                        res.clone().json().then(function(cfg){
                            hosted = cfg || null;
                            try { refreshChatModels(); } catch(e) {}
                            scheduleApply();
                        }).catch(function(){ /* 非 JSON：保持 fail-closed */ });
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

    /* ── 重渲染后重新落事实（平台 pill / 视频 kind 都会被上游重建）────────────── */

    var __origRenderUnified = renderUnifiedPlatformControl;
    renderUnifiedPlatformControl = function(){
        var out = __origRenderUnified.apply(this, arguments);
        scheduleApply();
        return out;
    };
    var __origSyncKind = syncApiKindToggleVisibility;
    syncApiKindToggleVisibility = function(){
        var out = __origSyncKind.apply(this, arguments);
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
        /* 服务端 revision：只读期间必须逐字节不变（任何写请求都会被 fetch 闸在页面侧拒掉）。*/
        try { payload.updated_at = canvas ? canvas.updated_at : 0; } catch(e) {}
        try { return JSON.stringify(payload); } catch(e) { return "ERR:" + String(e && e.message || e); }
    }

    window.__openarcSmartGuard = {
        version: 2,
        facts: function(){
            return {
                hosted: !!hosted,
                readOnly: ro(),
                chat: capFacts("chat"),
                image: capFacts("image-generation"),
                video: capFacts("video-generation"),
                comfy: capFacts("comfy"),
                providers: (apiProviders || []).map(function(p){ return p.id; })
            };
        },
        providers: function(){
            return (apiProviders || []).map(function(p){
                return { id: p.id, chat: unique(p.chat_models), image: unique(p.image_models), video: unique(p.video_models) };
            });
        },
        hostChatModels: hostChatModels,
        blocked: function(){ return blockedLog.slice(); },
        snapshot: guardSnapshot,
        writeBlocked: function(){ return writeBlockedCount; },
        surfaces: function(){ return EDIT_SURFACE; },
        wrapped: function(){
            return { count: WRAPPED.length, names: WRAPPED.map(function(e){ return e.name; }), missing: MISSING.slice() };
        }
    };

    /* 初始一次 + 等 onload 把整个页面渲染完再落一次事实。*/
    syncReadOnly();
    scheduleApply();
    window.setTimeout(function(){ try { syncReadOnly(); applyDom(); } catch(e) {} }, 1500);
})();
