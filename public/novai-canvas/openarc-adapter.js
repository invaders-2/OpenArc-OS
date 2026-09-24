/**
 * OpenArc 无限画布 · 命令适配器（在 canvas.js 之后加载）。
 *
 * 它把画布**自己的**原语包装成 OpenArc 的统一画布命令（PLAN §24），
 * 并且只做三件事：只读闸、基准版本检查、把结果如实回报给宿主。
 * 不复制画布状态、不重建节点系统：所有变更都发生在画布自己的 nodes/connections 上，
 * 走画布自己的 render / scheduleSave / 撤销栈。
 */
(function () {
  "use strict";
  var CH = "openarc.canvas";
  var MAX_WAIT = 15000;
  var startedAt = Date.now();

  function post(msg) {
    try { window.parent.postMessage(Object.assign({ ch: CH, dir: "canvas->host" }, msg), "*"); } catch (e) { /* host 不在 */ }
  }
  function internals() { return window.__openarcCanvasInternals || null; }
  function bridge() { return window.__openarcBridge || null; }
  function readOnly() { return !!(bridge() && bridge().isReadOnly && bridge().isReadOnly()); }

  var COMMAND_TYPES = ["node.add", "node.edit", "node.move", "node.copy", "node.delete", "node.group", "edge.connect", "edge.disconnect"];

  function state() {
    var it = internals();
    if (!it) return null;
    var s = it.getState();
    return { canvasId: s.canvas ? s.canvas.id : null, revision: s.canvas ? s.canvas.revision : 0, nodeCount: s.nodes.length, edgeCount: s.connections.length };
  }

  function fail(error, detail) { return { ok: false, error: error, detail: detail || null }; }

  /** 与主进程 canvas-domain 同一套语义的命令执行（唯一入口）。*/
  function applyCommand(command, baseRevision) {
    var it = internals();
    if (!it) return fail("CANVAS_NOT_READY");
    if (readOnly()) return fail("READ_ONLY");
    var st = it.getState();
    if (st.canvas && baseRevision != null && Number(baseRevision) !== Number(st.canvas.revision)) {
      return { ok: false, error: "REVISION_CONFLICT", detail: { currentRevision: Number(st.canvas.revision), baseRevision: Number(baseRevision) } };
    }
    if (!command || typeof command !== "object" || COMMAND_TYPES.indexOf(String(command.type)) < 0) return fail("UNSUPPORTED_COMMAND", command && command.type);
    var p = it.primitives;
    it.primitives.pushUndo();               // 与手工操作同一条撤销记录
    var result = null;
    try {
      if (command.type === "node.add") {
        if (!command.node || typeof command.node !== "object") throw new Error("INVALID_INPUT");
        var node = Object.assign({}, command.node);
        if (!node.id) node.id = p.uid(String(node.type || "n"));
        node.x = Number(node.x) || 0; node.y = Number(node.y) || 0;
        result = { node: p.addNode(node) };
        if (!result.node) throw new Error("READ_ONLY");
      } else if (command.type === "node.edit") {
        var target = p.findNode(String(command.id || command.nodeId || ""));
        if (!target) throw new Error("NOT_FOUND");
        Object.assign(target, command.patch || {});
        result = { node: target };
      } else if (command.type === "node.move") {
        var ids = command.ids || [command.id || command.nodeId];
        ids.forEach(function (id) {
          var n = p.findNode(String(id));
          if (!n) throw new Error("NOT_FOUND");
          if (Number.isFinite(Number(command.x)) && Number.isFinite(Number(command.y)) && ids.length === 1) { n.x = Number(command.x); n.y = Number(command.y); }
          else { n.x = Number(n.x || 0) + (Number(command.dx) || 0); n.y = Number(n.y || 0) + (Number(command.dy) || 0); }
        });
        result = { ids: ids };
      } else if (command.type === "node.copy") {
        var srcIds = command.ids || [command.id || command.nodeId];
        var created = [];
        srcIds.forEach(function (id) {
          var n = p.findNode(String(id));
          if (!n) throw new Error("NOT_FOUND");
          var copy = JSON.parse(JSON.stringify(n));
          copy.id = command.newId && srcIds.length === 1 ? command.newId : p.uid(String(n.type || "n"));
          copy.x = Number(n.x || 0) + (Number(command.dx) || 40);
          copy.y = Number(n.y || 0) + (Number(command.dy) || 40);
          p.addNode(copy);
          created.push(copy.id);
        });
        result = { ids: created };
      } else if (command.type === "node.delete") {
        var delIds = command.ids || [command.id || command.nodeId];
        var list = it.getState().nodes.filter(function (n) { return delIds.indexOf(n.id) < 0; });
        it.getState().nodes.length = 0;
        list.forEach(function (n) { it.getState().nodes.push(n); });
        var conns = it.getState().connections.filter(function (c) { return delIds.indexOf(c.from) < 0 && delIds.indexOf(c.to) < 0; });
        it.getState().connections.length = 0;
        conns.forEach(function (c) { it.getState().connections.push(c); });
        result = { ids: delIds };
      } else if (command.type === "node.group") {
        var gIds = command.ids || [];
        if (gIds.length < 2) throw new Error("INVALID_INPUT");
        var members = gIds.map(function (id) { var n = p.findNode(String(id)); if (!n) throw new Error("NOT_FOUND"); return n; });
        var gid = command.groupId || p.uid("grp");
        p.addNode({
          id: gid, type: "group", title: command.title || "工作流群组",
          x: Math.min.apply(null, members.map(function (n) { return Number(n.x) || 0; })) - 24,
          y: Math.min.apply(null, members.map(function (n) { return Number(n.y) || 0; })) - 64,
          w: 420, h: 280, items: gIds.slice(), runStatus: "", runError: "",
        });
        result = { group: { id: gid } };
      } else if (command.type === "edge.connect") {
        var from = String(command.from || command.fromId || "");
        var to = String(command.to || command.toId || "");
        if (!p.findNode(from) || !p.findNode(to)) throw new Error("NOT_FOUND");
        if (from === to) throw new Error("INVALID_INPUT");
        var dup = it.getState().connections.some(function (c) { return c.from === from && c.to === to; });
        if (dup) throw new Error("INVALID_INPUT");
        var edge = { id: command.id || p.uid("c"), from: from, to: to };
        it.getState().connections.push(edge);
        result = { edge: edge };
      } else if (command.type === "edge.disconnect") {
        var conns2 = it.getState().connections;
        var hit = command.id ? conns2.filter(function (c) { return c.id === command.id; })
          : conns2.filter(function (c) { return c.from === command.from && c.to === command.to; });
        if (!hit.length) throw new Error("NOT_FOUND");
        var drop = hit.map(function (c) { return c.id; });
        var keep = conns2.filter(function (c) { return drop.indexOf(c.id) < 0; });
        conns2.length = 0; keep.forEach(function (c) { conns2.push(c); });
        result = { ids: drop };
      }
    } catch (err) {
      // 失败不留半套撤销记录：把刚压入的快照弹回（与"这次命令没发生"一致）
      try { p.performUndo(); } catch (e) { /* ignore */ }
      var code = String((err && err.message) || "INVALID_INPUT");
      return fail(["NOT_FOUND", "INVALID_INPUT", "READ_ONLY"].indexOf(code) >= 0 ? code : "INVALID_INPUT", code);
    }
    p.sanitizeConnections();
    p.render();
    p.scheduleSave();
    var now = it.getState();
    return { ok: true, result: result, revision: now.canvas ? Number(now.canvas.revision) : 0, state: { nodeCount: now.nodes.length, edgeCount: now.connections.length } };
  }

  window.addEventListener("message", function (event) {
    var d = event.data;
    if (!d || d.ch !== CH || d.dir !== "host->canvas") return;
    if (d.kind === "command") {
      var res = applyCommand(d.command, d.baseRevision);
      post({ kind: "command-result", id: d.id, ok: res.ok, value: res.ok ? res : null, error: res.ok ? null : { error: res.error, message: res.detail ? JSON.stringify(res.detail) : "" } });
      return;
    }
    if (d.kind === "undo") {
      var it = internals();
      if (!it) { post({ kind: "command-result", id: d.id, ok: false, error: { error: "CANVAS_NOT_READY" } }); return; }
      if (readOnly()) { post({ kind: "command-result", id: d.id, ok: false, error: { error: "READ_ONLY" } }); return; }
      it.primitives.performUndo();
      post({ kind: "command-result", id: d.id, ok: true, value: { undo: true } });
      return;
    }
    if (d.kind === "redo") {
      var it2 = internals();
      if (!it2) { post({ kind: "command-result", id: d.id, ok: false, error: { error: "CANVAS_NOT_READY" } }); return; }
      if (readOnly()) { post({ kind: "command-result", id: d.id, ok: false, error: { error: "READ_ONLY" } }); return; }
      it2.primitives.performRedo();
      post({ kind: "command-result", id: d.id, ok: true, value: { redo: true } });
      return;
    }
    if (d.kind === "state-request") { post({ kind: "state", id: d.id, state: state() }); return; }
    if (d.kind === "reload-doc") {
      // 宿主已经落库（AI 编辑）或发现引用的资源不可用：整篇换成本宿主给的文档，**不回写**。
      var it3 = internals();
      if (!it3) { post({ kind: "command-result", id: d.id, ok: false, error: { error: "CANVAS_NOT_READY" } }); return; }
      try {
        var doc = d.doc || {};
        it3.primitives.setNodes(JSON.parse(JSON.stringify(doc.nodes || [])));
        it3.primitives.setConnections(JSON.parse(JSON.stringify(doc.connections || [])));
        it3.primitives.setCanvasMeta({ updated_at: d.updatedAt, title: d.title });
        it3.primitives.setViewport(doc.viewport);
        it3.primitives.sanitizeConnections();
        it3.primitives.render();
        // 宿主已经落库并整篇推来：这一版就是页面新的共同祖先（保存冲突三方合并的 base）。
        if (it3.primitives.markSynced) it3.primitives.markSynced();
        post({ kind: "command-result", id: d.id, ok: true, value: { reloaded: true, state: state() } });
      } catch (err) {
        post({ kind: "command-result", id: d.id, ok: false, error: { error: "INVALID_INPUT", message: String((err && err.message) || err) } });
      }
      return;
    }
  });

  window.addEventListener("openarc-canvas-context", function (event) {
    var it = internals();
    if (it && event && event.detail) it.setReadOnly(!event.detail.canEdit);
  });
  window.addEventListener("openarc-canvas-blocked", function () {
    post({ kind: "blocked", reason: "READ_ONLY" });
  });

  // 只读时也挡掉键盘/指针层面的编辑入口（保存与命令层之外的最后一道）
  ["keydown", "paste", "drop"].forEach(function (type) {
    window.addEventListener(type, function (event) {
      if (!readOnly()) return;
      var tag = document.activeElement && document.activeElement.tagName;
      if (type === "keydown" && (tag === "INPUT" || tag === "TEXTAREA" || (document.activeElement && document.activeElement.isContentEditable))) return;
      if (type === "keydown" && !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      event.stopPropagation();
      post({ kind: "blocked", reason: "READ_ONLY" });
    }, true);
  });

  // 上游没有重做入口：补一个 Ctrl/Cmd+Shift+Z
  window.addEventListener("keydown", function (event) {
    if (!(event.metaKey || event.ctrlKey) || String(event.key).toLowerCase() !== "z" || !event.shiftKey) return;
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || (document.activeElement && document.activeElement.isContentEditable)) return;
    event.preventDefault();
    var it = internals();
    if (it && !readOnly()) it.primitives.performRedo();
  }, true);

  window.__openarcCanvas = {
    state: state,
    applyCommand: applyCommand,
    /** 运行一个节点（与节点上的 ▶ 按钮同一入口）。模型调用仍然全部经宿主 → OpenArc 模型服务。*/
    runNode: function (nodeId) { var it = internals(); return it ? it.primitives.runNode(nodeId) : null; },
    getNode: function (nodeId) { var it = internals(); return it ? JSON.parse(JSON.stringify(it.primitives.getNode(nodeId) || null)) : null; },
    undo: function () { var it = internals(); if (it && !readOnly()) it.primitives.performUndo(); },
    redo: function () { var it = internals(); if (it && !readOnly()) it.primitives.performRedo(); },
    canUndo: function () { var it = internals(); return !!(it && it.primitives.canUndo()); },
    canRedo: function () { var it = internals(); return !!(it && it.primitives.canRedo()); },
    readOnly: readOnly,
  };

  (function wait() {
    if (internals()) {
      // 桥可能早就收到过 hello（context 事件在适配器注册监听之前就派发过）：
      // 就绪时按**桥里的只读事实**再同步一次，只读成员不会因为时序而漏掉闸门。
      try { internals().setReadOnly(readOnly()); } catch (e) { /* ignore */ }
      post({ kind: "adapter-ready", state: state() });
      return;
    }
    if (Date.now() - startedAt > MAX_WAIT) { post({ kind: "adapter-timeout" }); return; }
    setTimeout(wait, 50);
  })();
})();
