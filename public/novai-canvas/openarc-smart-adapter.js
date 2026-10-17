/**
 * OpenArc 智能画布 · 命令适配器（在 smart-canvas.js 之后加载）。
 *
 * 与经典画布的 openarc-adapter.js 同一套宿主协议（PLAN §24），但命令映射按智能画布
 * 的真实数据模型重写：节点是 smart-* 类型 + images 数组，连线在 canvas.connections。
 * 不复制画布状态、不重建节点系统：所有变更都发生在页面自己的 nodes / canvas.connections 上，
 * 走页面自己的 render / scheduleSave / 撤销栈。
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
  function readOnly() {
    var b = bridge();
    if (b && typeof b.isReadOnly === "function") return !!b.isReadOnly();
    var it = internals();
    return !!(it && it.isReadOnly && it.isReadOnly());
  }

  var COMMAND_TYPES = ["node.add", "node.edit", "node.move", "node.copy", "node.delete", "node.group", "edge.connect", "edge.disconnect"];
  var TYPE_MAP = {
    image: "smart-image", generator: "smart-image", output: "smart-image",
    llm: "smart-prompt", prompt: "smart-prompt",
    video: "smart-video",
    group: "smart-group", promptGroup: "smart-group",
    text: "smart-text", label: "smart-label",
    table: "table", comfy: "smart-image",
  };

  function state() {
    var it = internals();
    if (!it) return null;
    var s = it.getState();
    return { canvasId: s.canvas ? s.canvas.id : null, revision: s.canvas ? s.canvas.revision : 0, nodeCount: s.nodes.length, edgeCount: s.connections.length };
  }
  function fail(error, detail) { return { ok: false, error: error, detail: detail || null }; }

  function assetUrlOf(node) {
    if (node && node.url) return String(node.url);
    if (node && Array.isArray(node.refs) && node.refs[0]) return String(node.refs[0]);
    return "";
  }
  function resolveAssetUrl(raw) {
    var url = String(raw || "");
    if (url.indexOf("openarc-asset:") !== 0) return Promise.resolve(url);
    var b = bridge();
    if (!b || typeof b.call !== "function") return Promise.resolve(url);
    return b.call("library.resolve", { url: url }).then(function (res) {
      return (res && res.dataUrl) || url;
    }).catch(function () { return url; });
  }
  function toSmartNode(input) {
    var copy = JSON.parse(JSON.stringify(input || {}));
    var rawType = String(copy.type || "image");
    if (rawType.indexOf("smart-") !== 0 && rawType !== "table") copy.type = TYPE_MAP[rawType] || "smart-image";
    if (copy.type === "smart-prompt") {
      if (copy.text && !copy.prompt) copy.prompt = copy.text;
    } else if (copy.type === "smart-text") {
      if (copy.prompt && !copy.text) copy.text = copy.prompt;
    } else if (copy.type === "smart-image" || copy.type === "smart-video") {
      if (!Array.isArray(copy.images)) copy.images = [];
      if (!copy.images.length) {
        var url = assetUrlOf(copy);
        if (url) copy.images.push({ url: url, name: copy.name || "image", kind: copy.type === "smart-video" ? "video" : "image" });
      }
      if (!copy.title) copy.title = copy.name || "";
    } else if (copy.type === "smart-group") {
      if (!Array.isArray(copy.items)) copy.items = [];
    }
    return copy;
  }

  /** 与主进程 canvas-domain 同一套语义的命令执行（唯一入口）。*/
  async function applyCommand(command, baseRevision) {
    var it = internals();
    if (!it) return fail("CANVAS_NOT_READY");
    if (readOnly()) return fail("READ_ONLY");
    var st = it.getState();
    if (st.canvas && baseRevision != null && Number(baseRevision) !== Number(st.canvas.revision)) {
      return { ok: false, error: "REVISION_CONFLICT", detail: { currentRevision: Number(st.canvas.revision), baseRevision: Number(baseRevision) } };
    }
    if (!command || typeof command !== "object" || COMMAND_TYPES.indexOf(String(command.type)) < 0) return fail("UNSUPPORTED_COMMAND", command && command.type);
    var p = it.primitives;
    p.pushUndo();               // 与手工操作同一条撤销记录
    var result = null;
    try {
      if (command.type === "node.add") {
        if (!command.node || typeof command.node !== "object") throw new Error("INVALID_INPUT");
        var node = toSmartNode(command.node);
        if (!node.id) node.id = p.uid(String(node.type || "n"));
        node.x = Number(node.x) || 0; node.y = Number(node.y) || 0;
        if (node.type === "smart-image" && Array.isArray(node.images) && node.images[0]) {
          node.images[0].url = await resolveAssetUrl(node.images[0].url);
        } else if (node.type === "smart-video" && Array.isArray(node.images) && node.images[0]) {
          node.images[0].url = await resolveAssetUrl(node.images[0].url);
        }
        result = { node: p.addNode(node) };
        if (!result.node) throw new Error("INVALID_INPUT");
      } else if (command.type === "node.edit") {
        var target = p.findNode(String(command.id || command.nodeId || ""));
        if (!target) throw new Error("NOT_FOUND");
        var patch = Object.assign({}, command.patch || {});
        if (patch.type) delete patch.type;
        if (patch.url && (target.type === "smart-image" || target.type === "smart-video")) {
          patch.images = Array.isArray(target.images) ? target.images.slice() : [];
          if (!patch.images.length) patch.images.push({ url: patch.url, name: patch.name || "image", kind: target.type === "smart-video" ? "video" : "image" });
          else patch.images[0] = Object.assign({}, patch.images[0], { url: patch.url });
          delete patch.url;
        }
        Object.assign(target, patch);
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
        delIds.forEach(function (id) { if (!p.findNode(String(id))) throw new Error("NOT_FOUND"); });
        p.deleteNodes(delIds);
        result = { ids: delIds };
      } else if (command.type === "node.group") {
        var gIds = command.ids || [];
        if (gIds.length < 2) throw new Error("INVALID_INPUT");
        var members = gIds.map(function (id) { var n = p.findNode(String(id)); if (!n) throw new Error("NOT_FOUND"); return n; });
        var gid = command.groupId || p.uid("grp");
        p.addNode({
          id: gid, type: "smart-group", title: command.title || "工作流群组",
          x: Math.min.apply(null, members.map(function (n) { return Number(n.x) || 0; })) - 24,
          y: Math.min.apply(null, members.map(function (n) { return Number(n.y) || 0; })) - 64,
          w: 420, h: 280, items: gIds.slice(),
        });
        result = { group: { id: gid } };
      } else if (command.type === "edge.connect") {
        var from = String(command.from || command.fromId || "");
        var to = String(command.to || command.toId || "");
        if (!p.findNode(from) || !p.findNode(to)) throw new Error("NOT_FOUND");
        if (from === to) throw new Error("INVALID_INPUT");
        var list = it.getState().connections;
        var dup = list.some(function (c) { return c.from === from && c.to === to; });
        if (dup) throw new Error("INVALID_INPUT");
        var edge = { from: from, to: to, kind: "flow" };
        if (command.id) edge.id = String(command.id);
        list.push(edge);
        result = { edge: edge };
      } else if (command.type === "edge.disconnect") {
        var conns2 = it.getState().connections;
        var hit = command.id ? conns2.filter(function (c) { return c.id === command.id || String(c.from) + "->" + String(c.to) === String(command.id); })
          : conns2.filter(function (c) { return c.from === command.from && c.to === command.to; });
        if (!hit.length) throw new Error("NOT_FOUND");
        var drop = hit.map(function (c) { return c.from + "->" + c.to; });
        var keep = conns2.filter(function (c) { return drop.indexOf(c.from + "->" + c.to) < 0; });
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
      void applyCommand(d.command, d.baseRevision).then(function (res) {
        post({ kind: "command-result", id: d.id, ok: res.ok, value: res.ok ? res : null, error: res.ok ? null : { error: res.error, message: res.detail ? JSON.stringify(res.detail) : "" } });
      });
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

  window.__openarcCanvas = {
    state: state,
    applyCommand: applyCommand,
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
      try { internals().setReadOnly(readOnly()); } catch (e) { /* ignore */ }
      post({ kind: "adapter-ready", state: state() });
      return;
    }
    if (Date.now() - startedAt > MAX_WAIT) { post({ kind: "adapter-timeout" }); return; }
    setTimeout(wait, 50);
  })();
})();
