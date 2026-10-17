/* ══════════════════════════════════════════════════════════════════════════════
   OpenArc 智能画布 · 受控注入层（追加在 smart-canvas.js 的 IIFE 末尾）
   ──────────────────────────────────────────────────────────────────────────────
   把智能画布**自己的**原语暴露成与经典画布同一形状的 window.__openarcCanvasInternals，
   供 openarc-smart-adapter.js 的命令层使用；不复制、不重建节点系统：所有变更都发生在
   页面自己的 nodes / canvas.connections 上，走页面自己的 render / scheduleSave / 撤销栈。

   与经典 canvas-internals.js 的差异（按新数据模型，不照搬）：
   · 连线在 canvas.connections（经典是独立闭包变量），节点仍是闭包变量 nodes；
   · 撤销/重做用页面**原生** undoStack / redoStack / performUndo / performRedo，
     注入层不再补第二条 redo 栈（页面 pushUndo 已负责清 redo）；
   · 409 合并由页面原生 applyMergedServerCanvas 承担，这里只提供 markSynced（空操作）
     与 reload-doc 的整篇换内容路径；
   · runNode 与节点上的 ▶ 走同一条 runGeneration（先选中，再运行），不另造影子运行路径。
   ══════════════════════════════════════════════════════════════════════════════ */
(function(){
    "use strict";
    if (window.__openarcCanvasInternals) return;

    function makeId(prefix){
        var raw = "";
        try { raw = String(uid()); } catch(e) { raw = "u" + Math.random().toString(36).slice(2, 10); }
        return prefix ? String(prefix) + "_" + raw : raw;
    }
    function findNode(id){ return nodes.find(function(n){ return n && n.id === id; }) || null; }
    function connectionList(){
        if (!canvas) return [];
        if (!Array.isArray(canvas.connections)) canvas.connections = [];
        return canvas.connections;
    }
    function findEdge(id){
        var list = connectionList();
        var key = String(id || "");
        if (!key) return null;
        if (key.indexOf("->") >= 0) {
            var parts = key.split("->");
            return list.find(function(c){ return c && c.from === parts[0] && c.to === parts[1]; }) || null;
        }
        return list.find(function(c){ return c && c.id === key; }) || null;
    }
    function normalizeNode(node){
        if (!node || typeof node !== "object") return node;
        try { return typeof normalizeLegacySmartNode === "function" ? normalizeLegacySmartNode(node) : node; } catch(e) { return node; }
    }
    function sanitizeConnections(){
        if (!canvas) return;
        var ids = new Set(nodes.map(function(n){ return n && n.id; }).filter(Boolean));
        var seen = new Set();
        canvas.connections = connectionList().filter(function(c){
            if (!c || !ids.has(c.from) || !ids.has(c.to) || c.from === c.to) return false;
            var key = c.from + "->" + c.to + "|" + (c.kind || "flow");
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }
    function snapshotDoc(){
        return {
            nodes: JSON.parse(JSON.stringify(nodes || [])),
            connections: JSON.parse(JSON.stringify(connectionList())),
            viewport: Object.assign({}, viewport || {x:0, y:0, scale:1}),
            logs: JSON.parse(JSON.stringify((canvas && canvas.logs) || [])),
            title: canvas ? canvas.title : "",
            icon: canvas ? canvas.icon : "",
            updated_at: canvas ? Number(canvas.updated_at || 0) : 0
        };
    }
    function applyDoc(doc, meta){
        doc = doc || {};
        nodes = (Array.isArray(doc.nodes) ? doc.nodes : []).map(normalizeNode);
        if (canvas) {
            canvas.connections = Array.isArray(doc.connections) ? doc.connections.map(function(c){ return Object.assign({}, c); }) : [];
            if (doc.logs != null) canvas.logs = Array.isArray(doc.logs) ? doc.logs : [];
            if (meta) {
                if (meta.updated_at != null) canvas.updated_at = Number(meta.updated_at) || canvas.updated_at;
                if (typeof meta.title === "string" && meta.title) canvas.title = meta.title;
                if (typeof meta.icon === "string" && meta.icon) canvas.icon = meta.icon;
            }
        }
        if (doc.viewport && Number.isFinite(Number(doc.viewport.scale))) {
            viewport = { x: Number(doc.viewport.x) || 0, y: Number(doc.viewport.y) || 0, scale: Math.max(0.05, Number(doc.viewport.scale) || 1) };
            try { applyViewport(); } catch(e) {}
        }
        selectedId = "";
        selectedIds = [];
        sanitizeConnections();
        render();
    }

    window.__openarcCanvasInternals = {
        getState: function(){
            return {
                canvas: canvas ? { id: canvas.id, title: canvas.title, icon: canvas.icon, updated_at: Number(canvas.updated_at || 0), revision: Number(canvas.updated_at || 0) } : null,
                nodes: nodes,
                connections: connectionList(),
                viewport: viewport,
                settings: settings,
            };
        },
        isReadOnly: function(){ return !!window.__openarcCanvasReadOnly; },
        setReadOnly: function(value){ window.__openarcCanvasReadOnly = !!value; },
        primitives: {
            uid: makeId,
            findNode: findNode,
            findEdge: findEdge,
            addNode: function(node){
                if (!node || !node.id) return null;
                if (findNode(node.id)) return null;
                var normalized = normalizeNode(node);
                nodes.push(normalized);
                return normalized;
            },
            deleteNodes: function(ids){
                var drop = new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean));
                nodes = nodes.filter(function(n){ return !drop.has(n.id); });
                if (canvas) canvas.connections = connectionList().filter(function(c){ return !drop.has(c.from) && !drop.has(c.to); });
                if (drop.has(selectedId)) selectedId = "";
                selectedIds = selectedIds.filter(function(id){ return !drop.has(id); });
            },
            pushUndo: function(){ return pushUndo(); },
            performUndo: function(){ return performUndo(); },
            performRedo: function(){ return performRedo(); },
            canUndo: function(){ return undoStack.length > 0; },
            canRedo: function(){ return redoStack.length > 0; },
            render: function(){ return render(); },
            scheduleSave: function(){ return scheduleSave(); },
            saveNow: function(){ return saveCanvas(); },
            sanitizeConnections: sanitizeConnections,
            setNodes: function(list){ nodes = (Array.isArray(list) ? list : []).map(normalizeNode); },
            setConnections: function(list){
                if (!canvas) return;
                canvas.connections = (Array.isArray(list) ? list : []).map(function(c){ return Object.assign({}, c); });
            },
            setCanvasMeta: function(meta){
                if (!canvas || !meta) return;
                if (meta.updated_at != null) canvas.updated_at = Number(meta.updated_at) || canvas.updated_at;
                if (typeof meta.title === "string" && meta.title) canvas.title = meta.title;
                if (typeof meta.icon === "string" && meta.icon) canvas.icon = meta.icon;
            },
            setViewport: function(v){
                if (!v) return;
                viewport = { x: Number(v.x) || 0, y: Number(v.y) || 0, scale: Math.max(0.05, Number(v.scale) || 1) };
                try { applyViewport(); } catch(e) {}
            },
            getNode: function(id){ return findNode(id); },
            serializableNodes: function(){ try { return canvasForStorage().nodes || []; } catch(e) { return nodes; } },
            /** 保存冲突由页面原生 409 合并承担：这里保留同名原语，不另造第二套 base。*/
            markSynced: function(){ return true; },
            conflictLog: function(){ return null; },
            applyDoc: applyDoc,
            snapshotDoc: snapshotDoc,
            /** 与节点上的 ▶ 同一入口：先选中，再走页面原生 runGeneration。*/
            runNode: function(nodeId){
                var node = findNode(nodeId);
                if (!node) return Promise.resolve(false);
                selectedId = node.id;
                selectedIds = [node.id];
                try { render(); } catch(e) {}
                try { if (typeof syncRunButtonState === "function") syncRunButtonState(); } catch(e) {}
                return Promise.resolve(runGeneration()).then(function(){ return true; });
            },
        },
    };
})();
