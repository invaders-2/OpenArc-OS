/* ══════════════════════════════════════════════════════════════════════════════
   OpenArc 适配层（对上游画布代码的**唯一**改动，追加在 IIFE 末尾）
   ──────────────────────────────────────────────────────────────────────────────
   1) 把画布自己的原语暴露给受控适配器（openarc-adapter.js）——不复制、不重建节点系统；
   2) 只读闸（A28）：只读成员的手工编辑在这里被拒（AI 编辑在主进程被同一权限规则拒）；
   3) 重做：上游只有撤销栈；这里补一条与撤销配对的 redo 栈（清空时机与新编辑一致）。
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
})();
