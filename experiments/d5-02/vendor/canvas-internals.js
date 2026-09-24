/* ══════════════════════════════════════════════════════════════════════════════
   OpenArc 适配层（对上游画布代码的**唯一**改动，追加在 IIFE 末尾）
   ──────────────────────────────────────────────────────────────────────────────
   1) 把画布自己的原语暴露给受控适配器（openarc-adapter.js）——不复制、不重建节点系统；
   2) 只读闸（A28）：只读成员的手工编辑在这里被拒（AI 编辑在主进程被同一权限规则拒）；
   3) 重做：上游只有撤销栈；这里补一条与撤销配对的 redo 栈（清空时机与新编辑一致）；
   4) 保存冲突：base/local/remote 三方合并（双方内容都保留），只重发一次合并结果、有界、绝不
      拿新基线盲目重发旧文档（上游那一支的缺陷见 canvas-merge.js 顶部说明）；
   5) AI 新增节点：160ms 淡入 + 来源标记（MOTION_SYSTEM §6）。真源是**命令账本**里的
      actorKind=AGENT 条目（宿主 canvas/log），不是"这次改动是远端同步来的"这种猜测口径；
      判定与去重是纯函数（canvas-ai-marks.js，Node 单测测同一份文本）。
   ══════════════════════════════════════════════════════════════════════════════ */
(function(){
    var __redoStack = [];
    var __origPushUndo = pushUndo;
    var __origPerformUndo = performUndo;
    var __origAddNode = addNode;
    var __origDeleteSelected = deleteSelectedNodes;

    function __readOnly(){ return !!window.__openarcCanvasReadOnly; }
    function __blocked(){
        try { window.dispatchEvent(new CustomEvent('openarc-canvas-blocked', { detail: { reason: 'READ_ONLY' } })); } catch(e) {}
        return null;
    }
    function __snapshot(){
        return { nodes: JSON.parse(JSON.stringify(serializableCanvasNodes())), connections: JSON.parse(JSON.stringify(connections)) };
    }

    pushUndo = function(){
        if (__readOnly()) return __blocked();
        __redoStack.length = 0;          // 新编辑让 redo 失效（与标准历史语义一致）
        return __origPushUndo();
    };
    performUndo = function(){
        if (__readOnly()) return __blocked();
        if (!canvas || !undoStack.length) return;
        __redoStack.push(__snapshot());
        if (__redoStack.length > 200) __redoStack.shift();
        return __origPerformUndo();
    };
    function performRedo(){
        if (__readOnly()) return __blocked();
        if (!canvas || !__redoStack.length) return;
        undoStack.push(__snapshot());
        if (undoStack.length > 200) undoStack.shift();
        var st = __redoStack.pop();
        nodes = st.nodes;
        connections = st.connections;
        selected.clear();
        render();
        scheduleSave();
    }
    addNode = function(node){ if (__readOnly()) return __blocked(); return __origAddNode(node); };
    deleteSelectedNodes = function(){ if (__readOnly()) return __blocked(); return __origDeleteSelected(); };


    /* ── 保存冲突：三方合并（双方内容都保留）──────────────────────────────────────
       vendor 脚本把上游 saveCanvas() 的 409 分支改成调用 window.__openarcCanvasConflict(remote, at)。
       合并本身是纯函数（__openarcCanvasMerge —— 与 tests/d5-02-canvas-merge.test.mjs 测的同一份文本）；
       这里只负责任务型的三件事：维护 base（页面最后一次成功同步的文档）、把合并结果写回页面、
       如实提示。合并是**远端变更**，走与 applyRemoteCanvasData 同一类路径（不压撤销栈、整篇换内容），
       所以撤销/重做语义不受影响；写回后只重发一次合并结果，且重发次数有界。*/
    var __CONFLICT_LIMIT = 2;
    var __mergeState = { canvasId: null, syncedDoc: null, attempts: 0, gaveUpAt: null };

    function __mergeApi(){
        try { if(typeof __openarcCanvasMerge !== 'undefined' && __openarcCanvasMerge) return __openarcCanvasMerge; } catch(e) {}
        return window.__openarcCanvasMerge || null;
    }
    function __clone(value){ return value == null ? value : JSON.parse(JSON.stringify(value)); }

    /** 页面当前文档（与 PUT body 同一序列化口径：去掉运行期临时字段）。*/
    function __pageDoc(){
        return {
            nodes: __clone(serializableCanvasNodes()) || [],
            connections: __clone(connections) || [],
            logs: __clone(canvas && canvas.logs) || [],
            title: canvas ? canvas.title : undefined,
            icon: canvas ? canvas.icon : undefined,
        };
    }
    /** 记下"服务端已经和页面一致"的那一版 = 下一次三方合并的共同祖先；并重新开始计数。*/
    function __markSynced(doc){
        __mergeState.canvasId = canvas ? String(canvas.id) : null;
        __mergeState.syncedDoc = doc ? __clone(doc) : null;
        __mergeState.attempts = 0;
        __mergeState.gaveUpAt = null;
    }

    /** 合并结果写回页面：与 applyRemoteCanvasData 同一类"远端变更"路径（不压撤销栈）。*/
    function __applyMergedDoc(doc){
        applyingRemoteCanvas = true;
        try {
            resetCascadeRuntimeState();
            var localViewport = localViewportForCanvas(canvas.id, viewport || {x:0, y:0, scale:1});
            var localSelectedIds = new Set(selected);
            if(doc.title != null) canvas.title = doc.title;
            if(doc.icon != null) canvas.icon = doc.icon;
            canvas.logs = doc.logs || [];
            nodes = doc.nodes || [];
            connections = doc.connections || [];
            viewport = localViewport;
            canvas.viewport = {...viewport};
            resetTransientRunState(nodes);
            sanitizeConnections();
            pruneMissingComfyWorkflows();
            refreshMissingCanvasAssets().then(function(){ render(); });
            selected = new Set([...localSelectedIds].filter(function(id){ return nodes.some(function(n){ return n.id === id; }); }));
            renderCanvasList();
            render();
            resumeCanvasImageTasks();
            if(currentCanvasTitle) currentCanvasTitle.textContent = canvas.title || tr('canvas.untitled');
            if(currentCanvasTime) currentCanvasTime.textContent = formatCanvasTime(Number(lastCanvasUpdatedAt || 0));
        } finally {
            applyingRemoteCanvas = false;
        }
    }

    /** 冲突提示 + 只读证据（探针/门禁读 window.__openarcCanvasConflicts；页面自己弹原生 toast）。*/
    function __showConflict(msg, entry){
        try { setStatus(msg); } catch(e) {}
        try { if(window.NovaUtils && typeof window.NovaUtils.showToast === 'function') window.NovaUtils.showToast(msg); } catch(e) {}
        try { console.warn('[openarc-canvas] ' + msg); } catch(e) {}
        try {
            var box = window.__openarcCanvasConflicts;
            if(!box){ box = { count: 0, last: null, history: [] }; window.__openarcCanvasConflicts = box; }
            box.count += 1;
            box.last = entry;
            box.history.push(entry);
            if(box.history.length > 20) box.history.splice(0, box.history.length - 20);
        } catch(e) {}
    }

    function __conflictSummary(report){
        var parts = [];
        if(report.copies.length) parts.push('同一处两边各改了一版：你的版本留在原位，对方那一版已作为副本保留（' + report.copies.join('、') + '）');
        var counts = [];
        if(report.remoteAdded.length) counts.push('对方新增 ' + report.remoteAdded.length + ' 项');
        if(report.remoteApplied.length) counts.push('对方改动 ' + report.remoteApplied.length + ' 项');
        if(report.remoteDeleted.length) counts.push('对方删除 ' + report.remoteDeleted.length + ' 项');
        if(report.localDeleted.length) counts.push('你删除的 ' + report.localDeleted.length + ' 项保持删除');
        if(report.conflicts.some(function(c){ return c.reason === 'REMOTE_DELETED'; })) counts.push('对方删除但你改过的项已保留');
        if(report.remoteTitle) counts.push('对方把画布标题改成「' + report.remoteTitle + '」（你的标题保留）');
        if(counts.length) parts.push(counts.join('、'));
        return parts.join('；') || '没有需要合并的改动';
    }

    /**
     * 上游 409 分支的接管点：remote = 冲突回包里的远端文档，remoteUpdatedAt = 那份文档的 updated_at。
     * 返回 'retry'（把合并结果重发一次，由 saveCanvas 的 finally 统一调度）或 'stop'（明确呈现，不再重试）。
     * async 的唯一原因：写回合并结果之前要取一次 AI 新增标记（有界等待）；调用方本来就 await 返回值。
     */
    async function __onCanvasConflict(remote, remoteUpdatedAt){
        var api = __mergeApi();
        if(!api || !canvas || !remote || String(remote.id || '') !== String(canvas.id)){
            var why = !api ? '合并模块未就绪' : (!remote ? '冲突回包里没有远端文档' : '冲突回包不是当前这本画布');
            var msgNone = '保存冲突：无法自动合并（' + why + '）。你在画布上的编辑没有被覆盖（仍未保存），请稍后重试保存。';
            __showConflict(msgNone, { at: Date.now(), canvasId: canvas ? canvas.id : null, outcome: 'UNMERGED', attempt: __mergeState.attempts, reason: why, copies: [], conflicts: [], message: msgNone });
            localCanvasDirty = true;
            return 'stop';
        }
        var local = __pageDoc();
        var fingerprint = api.canon({ nodes: local.nodes, connections: local.connections, title: local.title, icon: local.icon });
        // 上一轮已经放弃过、而这之后页面文档没再变过 → 不自动重试（无界循环的反面）；用户一改就重新开始。
        if(__mergeState.gaveUpAt && __mergeState.gaveUpAt !== fingerprint){
            __mergeState.attempts = 0;
            __mergeState.gaveUpAt = null;
        }
        if(__mergeState.attempts >= __CONFLICT_LIMIT){
            var msgLimit = '保存冲突：无法自动合并（这本画布正在被别处持续修改，自动合并已达上限 ' + __CONFLICT_LIMIT + ' 次），不再自动重试。双方内容都已保留：你在画布上的编辑没有被覆盖（仍未保存），已取到的远端改动也已合入页面。请稍后再改动一下画布以重新尝试保存（保存成功前先别离开编辑器）。';
            __mergeState.gaveUpAt = fingerprint;
            __showConflict(msgLimit, { at: Date.now(), canvasId: canvas.id, outcome: 'UNMERGED', attempt: __mergeState.attempts, reason: 'MERGE_LIMIT', copies: [], conflicts: [], message: msgLimit });
            localCanvasDirty = true;
            return 'stop';
        }
        __mergeState.attempts += 1;
        var remoteDoc = {
            nodes: __clone(remote.nodes) || [],
            connections: __clone(remote.connections) || [],
            logs: __clone(remote.logs) || [],
            title: remote.title,
            icon: remote.icon,
        };
        var merged = api.mergeDocs(__mergeState.syncedDoc || null, local, remoteDoc);
        lastCanvasUpdatedAt = Number(remoteUpdatedAt || remote.updated_at || 0) || lastCanvasUpdatedAt;
        // 合并结果里可能有 AI 新增的节点：写回之前取一次 marks（有界），让新节点第一帧就是 opacity 0。
        await __aiRefresh(String(canvas.id));
        __applyMergedDoc(merged.doc);
        // 再冲突时，共同祖先就是"我刚合并进来的这一版"（服务端此刻就是它）；合并结果本身由成功回包确认。
        __mergeState.syncedDoc = remoteDoc;
        var msg = '保存冲突：已与别处的改动合并。' + __conflictSummary(merged.report) + '。两边内容都保留了，请核对后自行取舍。';
        __showConflict(msg, {
            at: Date.now(), canvasId: canvas.id,
            outcome: merged.report.copies.length ? 'MERGED_WITH_COPIES' : 'MERGED',
            attempt: __mergeState.attempts, remoteUpdatedAt: Number(lastCanvasUpdatedAt || 0),
            copies: merged.report.copies.slice(), conflicts: merged.report.conflicts.slice(),
            added: merged.report.remoteAdded.slice(), applied: merged.report.remoteApplied.slice(), deleted: merged.report.remoteDeleted.slice(),
            message: msg,
        });
        return 'retry';
    }
    window.__openarcCanvasConflict = __onCanvasConflict;
    /** 保存成功回包（vendor 补丁里调用）：这一版就是页面新的共同祖先。*/
    window.__openarcCanvasSynced = function(doc){ __markSynced(doc || __pageDoc()); };

    /* ── AI 新增节点：160ms 淡入 + 来源标记（MOTION_SYSTEM §6）──────────────────────
       真源只有一个：宿主 canvas/log 的**命令账本**（actorKind=AGENT、outcome=APPLIED、
       command.node.id）。**绝不**按"这次改动是远端同步来的"猜 AI —— 别的窗口的用户操作、本页的
       手工编辑走的是同一条远端同步路径，按来源猜会把它们全打成 AI。
       取 marks 的时机有两处：① 远端同步**之前**（新节点必须第一帧就是 opacity 0，否则会先以终态
       出现、再跳回 0 播一遍，变成"闪一下"）；② 编辑器加载完成时（重开仍保留来源标记 —— 那一刻
       节点已经在 DOM 里，只补标记不补动画）。两处都是**有界等待**：拿不到就按"没有标记"继续。*/
    var __AI_FETCH_WAIT = 400;      /* 取 marks 的等待上限（ms）：超时就放弃这一次，不挡远端同步 */
    var __AI_FRESH_MS = 500;        /* 刚取过 marks 就不为同一批改动再取一次 */
    /* 上游 applyRemoteCanvasData() 里同一批远端内容会**连着渲染两次**
       （`refreshMissingCanvasAssets().then(() => render())` + 紧随其后的同步 `render()`，实测相隔几 ms）：
       第二次整层重建会换掉刚挂上入场标记的那个元素。所以入场标记在"首次挂上之后的极短窗口内"
       允许跟着重建再挂一次；超过这个窗口就不再重挂 —— 免得一次普通重渲染把已经淡入完的节点
       又拉回 opacity 0（那才是要避免的"重播"）。*/
    var __AI_ENTER_REARM_MS = 120;
    var __aiState = {
        canvasId: null,
        marked: { nodeIds: {}, edgeIds: {} },
        seen: { nodeIds: {}, edgeIds: {} },     /* 已经播过入场动画的 id：整层重建也不会重播 */
        pending: {},                            /* 还没出现在 DOM 里、下次渲染时才播的 id */
        enterAt: {},                            /* id → 首次挂上入场标记的时刻（重挂窗口用） */
        fetchedAt: 0, lastError: null,
    };

    function __aiApi(){
        try { return window.__openarcCanvasAiMarks || null; } catch(e) { return null; }
    }
    function __aiIndex(list){
        var out = {};
        (list || []).forEach(function(id){ var key = String(id); if(key) out[key] = true; });
        return out;
    }
    var __aiStyled = false;
    function __aiEnsureStyle(){
        if(__aiStyled) return;
        __aiStyled = true;
        if(document.getElementById('openarc-canvas-ai-style')) return;
        var style = document.createElement('style');
        style.id = 'openarc-canvas-ai-style';
        /* 只消费上游已有变量：中性灰、无描边（不用 border 分层）、字重 500、圆角走既有 token。
           12/18 是 DS §5 的最小档；徽标本身 pointer-events:none，绝不吃掉节点按钮的命中。*/
        style.textContent = [
            ".openarc-ai-badge{display:inline-flex;align-items:center;flex:0 0 auto;height:18px;padding:0 6px;border-radius:var(--radius-sm,6px);background:var(--surface-2,rgba(0,0,0,.05));color:var(--text-2,#737373);font-size:12px;line-height:18px;font-weight:500;letter-spacing:0;pointer-events:none;-webkit-user-select:none;user-select:none}",
            "@keyframes openarc-ai-node-in{from{opacity:0}to{opacity:1}}",
            ".node[data-openarc-ai-enter='1']{animation:openarc-ai-node-in 160ms cubic-bezier(.2,0,0,1) both}",
            /* 减少动态效果：即时呈现（0ms、opacity 直接是 1），两个来源都要覆盖 —— 宿主应用内开关
               （html[data-openarc-reduced-motion]）与系统偏好（prefers-reduced-motion）。*/
            "html[data-openarc-reduced-motion='1'] .node[data-openarc-ai-enter='1']{animation:none;opacity:1}",
            "@media (prefers-reduced-motion: reduce){.node[data-openarc-ai-enter='1']{animation:none !important;opacity:1 !important}}",
        ].join("\n");
        (document.head || document.documentElement).appendChild(style);
    }

    function __aiReset(canvasId){
        __aiState.canvasId = canvasId;
        __aiState.marked = { nodeIds: {}, edgeIds: {} };
        __aiState.seen = { nodeIds: {}, edgeIds: {} };
        __aiState.pending = {};
        __aiState.enterAt = {};
        __aiState.fetchedAt = 0;
    }
    function __aiNodeEl(id){
        try { return nodesEl ? nodesEl.querySelector('.node[data-id="' + CSS.escape(String(id)) + '"]') : null; } catch(e) { return null; }
    }
    function __aiEnterDue(key){
        var at = Number(__aiState.enterAt[key] || 0);
        return !!at && (Date.now() - at) <= __AI_ENTER_REARM_MS;
    }
    /** 给一个节点元素补来源标记（每个元素最多一个徽标）；入场动画只给"本次新增且还没画出来"的 id。*/
    function __aiDecorate(el, id){
        if(!el || !id || !__aiState.marked.nodeIds[String(id)]) return;
        __aiEnsureStyle();
        var key = String(id);
        el.setAttribute('data-openarc-ai-source', 'agent');
        var head = el.querySelector('.node-head');
        var slot = head ? head.lastElementChild : null;
        if(slot && slot !== head && !slot.querySelector('.openarc-ai-badge')){
            var badge = document.createElement('span');
            badge.className = 'openarc-ai-badge';
            badge.setAttribute('data-openarc-ai-source', 'agent');
            badge.setAttribute('aria-label', '来自 AI');
            badge.textContent = 'AI';
            slot.insertBefore(badge, slot.firstChild);
        }
        if(__aiState.pending[key]){
            if(!__aiState.enterAt[key]) __aiState.enterAt[key] = Date.now();
            delete __aiState.pending[key];
        }
        if(__aiEnterDue(key)) el.setAttribute('data-openarc-ai-enter', '1');
    }
    function __aiDecorateAll(){
        if(!nodesEl) return;
        var list = nodesEl.querySelectorAll('.node');
        for(var i = 0; i < list.length; i += 1) __aiDecorate(list[i], list[i].dataset ? list[i].dataset.id : null);
    }
    /** 把宿主回的 marks 变成页面状态：标记集合 + 本次该播淡入的 id（已播过的不再播）。*/
    function __aiApply(payload){
        var api = __aiApi();
        if(!api || !payload) return null;
        var result = api.plan(payload, { nodeIds: Object.keys(__aiState.seen.nodeIds), edgeIds: Object.keys(__aiState.seen.edgeIds) });
        __aiState.seen = { nodeIds: __aiIndex(result.seen.nodeIds), edgeIds: __aiIndex(result.seen.edgeIds) };
        __aiState.marked = { nodeIds: __aiIndex(result.marked.nodeIds), edgeIds: __aiIndex(result.marked.edgeIds) };
        /* 只有"还没出现在 DOM 里"的 id 保留入场动画：重开编辑器、或在取到 marks 之前就已经渲染出来的
           节点只补标记 —— 否则它会先以终态出现、再跳回 0 播一遍（那正是要避免的"闪一下"）。*/
        result.enter.nodeIds.forEach(function(id){ if(!__aiNodeEl(id)) __aiState.pending[id] = true; });
        __aiDecorateAll();
        return result;
    }
    function __aiFetch(canvasId){
        var url = '/api/canvases/' + encodeURIComponent(String(canvasId)) + '/agent-marks';
        var late = new Promise(function(resolve){ setTimeout(function(){ resolve(null); }, __AI_FETCH_WAIT); });
        var request;
        try { request = window.fetch(url, { method: 'GET' }).then(function(res){ return res && res.ok ? res.json() : null; }).catch(function(){ return null; }); }
        catch(e) { request = Promise.resolve(null); }
        return Promise.race([request, late]).catch(function(){ return null; });
    }
    /** 取一次 marks 并应用。opts.freshMs：刚取过就跳过（避免同一批改动取两次）。*/
    function __aiRefresh(canvasId, opts){
        var id = String(canvasId || '');
        if(!id) return Promise.resolve(null);
        if(__aiState.canvasId !== id) __aiReset(id);          // 换画布：旧标记与旧去重集合立即失效
        var freshMs = Number(opts && opts.freshMs) || 0;
        if(freshMs && __aiState.fetchedAt && (Date.now() - __aiState.fetchedAt) < freshMs) return Promise.resolve(null);
        return __aiFetch(id).then(function(payload){
            if(!payload || payload.ok === false || String(id) !== String(__aiState.canvasId)) return null;   // 迟到 / 换画布 → 丢弃
            __aiState.fetchedAt = Date.now();
            return __aiApply(payload);
        }).catch(function(err){ __aiState.lastError = String((err && err.message) || err); return null; });
    }

    /* render() 每次整层重建节点元素，所以标记必须挂在**元素生成的那一刻**：包装 renderNode
       （render / refreshNodes 都走它），而不是渲染完再扫一遍 DOM 补。*/
    var __origRenderNode = renderNode;
    renderNode = function(node){
        var el = __origRenderNode(node);
        try { __aiDecorate(el, node ? node.id : null); } catch(e) { /* 标记失败不影响节点渲染 */ }
        return el;
    };

    /* 远端同步（页面自己的 2.5s 版本轮询 / 冲突后的整篇刷新）**之前**先把 marks 取回来：
       新节点必须在第一帧就是 opacity 0。有界等待，拿不到照常同步 —— 只是这一次没有标记/淡入。*/
    var __origSyncRemoteCanvasNow = syncRemoteCanvasNow;
    syncRemoteCanvasNow = async function(){
        if(canvas) await __aiRefresh(String(canvas.id));
        return __origSyncRemoteCanvasNow();
    };

    window.__openarcCanvasInternals = {
        getState: function(){
            return {
                canvas: canvas ? { id: canvas.id, title: canvas.title, updated_at: Number(canvas.updated_at || 0), revision: Number(canvas.updated_at || 0) } : null,
                nodes: nodes, connections: connections, viewport: viewport,
            };
        },
        isReadOnly: __readOnly,
        setReadOnly: function(v){ window.__openarcCanvasReadOnly = !!v; },
        primitives: {
            addNode: function(node){ return addNode(node); },
            pushUndo: function(){ return pushUndo(); },
            performUndo: function(){ return performUndo(); },
            performRedo: function(){ return performRedo(); },
            render: function(){ return render(); },
            setViewport: function(v){ if(v){ viewport = { x: Number(v.x) || 0, y: Number(v.y) || 0, scale: Number(v.scale) || 1 }; } },
            scheduleSave: function(){ return scheduleSave(); },
            saveNow: function(){ return saveCanvas(); },
            /** 宿主整篇推送（openarc-adapter.js 的 reload-doc）之后调用：推来的这一版就是新的共同祖先。*/
            markSynced: function(){ __markSynced(__pageDoc()); },
            /** 保存冲突的只读证据（探针/门禁）：次数 + 最近一次的结果、副本、冲突字段。*/
            conflictLog: function(){ return __clone(window.__openarcCanvasConflicts) || null; },
            /** AI 新增标记 / 入场去重的只读证据（探针与门禁）：本次已标记、已播过动画、等待渲染的 id。*/
            aiMarks: function(){
                return {
                    canvasId: __aiState.canvasId,
                    marked: { nodeIds: Object.keys(__aiState.marked.nodeIds), edgeIds: Object.keys(__aiState.marked.edgeIds) },
                    seen: { nodeIds: Object.keys(__aiState.seen.nodeIds), edgeIds: Object.keys(__aiState.seen.edgeIds) },
                    pending: Object.keys(__aiState.pending),
                    enterAt: Object.keys(__aiState.enterAt).map(function(id){ return { id: id, at: Number(__aiState.enterAt[id]) }; }),
                    fetchedAt: __aiState.fetchedAt, lastError: __aiState.lastError,
                };
            },
            serializableNodes: function(){ return serializableCanvasNodes(); },
            sanitizeConnections: function(){ return sanitizeConnections(); },
            uid: function(prefix){ return uid(prefix); },
            findNode: function(id){ return nodes.find(function(n){ return n.id === id; }) || null; },
            findEdge: function(id){ return connections.find(function(c){ return c.id === id; }) || null; },
            setNodes: function(list){ nodes = list; },
            setConnections: function(list){ connections = list; },
            // 宿主整篇刷新（AI 执行落库后 / 引用的资源被删除或撤权后）：只换内容，版本由宿主给出，不回写库
            setCanvasMeta: function(meta){ if(canvas && meta){ if(meta.updated_at != null) canvas.updated_at = Number(meta.updated_at) || canvas.updated_at; if(typeof meta.title === 'string' && meta.title) canvas.title = meta.title; } },
            canUndo: function(){ return undoStack.length > 0; },
            canRedo: function(){ return __redoStack.length > 0; },
            // 与节点上的 ▶ 按钮**同一个入口**（runNodeCascade）：门禁驱动真实运行路径，不是影子实现。
            runNode: function(nodeId){ return runNodeCascade(nodeId); },
            getNode: function(id){ return nodes.find(function(n){ return n.id === id; }) || null; },
        },
    };

    /* base（页面最后一次成功同步的文档）的四个来源：打开画布 / 整篇远端刷新 / 宿主整篇推送 /
       保存成功。少一个，"共同祖先"就会失真 —— 把已经同步过的改动当成没同步的，凭空造出冲突副本。*/
    var __origOpenCanvas = openCanvas;
    openCanvas = async function(id){
        __mergeState.canvasId = null; __mergeState.syncedDoc = null; __mergeState.attempts = 0; __mergeState.gaveUpAt = null;
        var result = await __origOpenCanvas(id);
        if(canvas && String(canvas.id) === String(id)){
            __markSynced(__pageDoc());
            // 编辑器加载完成：取一次 marks。此刻节点已经在 DOM 里，所以只补来源标记、不补动画 ——
            // 重开画布看到的是"这些节点来自 AI"，而不是整屏重播一次淡入。
            __aiRefresh(String(id));
        }
        return result;
    };
    var __origApplyRemoteCanvasData = applyRemoteCanvasData;
    applyRemoteCanvasData = function(remote){
        // 原函数在"本地有未保存编辑"时只排队、不改状态：那种情况不能把页面文档当成已同步。
        var deferred = !!(localCanvasDirty || saveTimer || savingCanvasNow || saveCanvasAgain);
        var result = __origApplyRemoteCanvasData(remote);
        if(!deferred && remote && canvas && remote.id === canvas.id){
            __markSynced(__pageDoc());
            // 应用远端文档之后就取一次 marks（远端同步那条路径在同步前已经取过，这里跳过一次；
            // 冲突合并那条路径没取过，标记靠这一次补上）。
            __aiRefresh(String(canvas.id), { freshMs: __AI_FRESH_MS });
        }
        return result;
    };
})();
