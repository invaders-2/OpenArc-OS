/* ══════════════════════════════════════════════════════════════════════════════
   OpenArc：画布「AI 新增」来源标记与入场动画的**纯函数**（不碰 DOM、不读画布闭包、不读全局）
   ──────────────────────────────────────────────────────────────────────────────
   真源只有一个：画布自己的**命令账本**（宿主 canvas/log：actorKind=AGENT、outcome=APPLIED、
   command.node.id）。「这次改动是远端同步来的」**不**等于「这是 AI 干的」—— 别的窗口的用户操作、
   页面自己的手工编辑都会走同一条远端同步路径，按同步来源猜会把它们全打成 AI（MOTION_SYSTEM §6）。

   这里只做两件纯数据的事：
     sanitize(hostPayload) → 把宿主回包归一成 [{ nodeIds, edgeIds, commandType, resultRevision, at }]；
     plan(hostPayload, seen) → marked（该带来源标记的 id）+ enter（**本次才该播入场动画**的 id）。
   seen = 已经播过入场动画的 id（调用方持有并原样存回）。render() 每次整层重建节点元素，只有靠这份
   集合去重，同一节点才不会每来一次远端同步就重播一遍淡入 —— 第八批在注入说明行上观察到的正是这个问题。

   纯数据 ⇒ Node 侧（tests/d5-02-canvas-ai-marks.test.mjs）require 的是**同一份文本**。
   ══════════════════════════════════════════════════════════════════════════════ */
var __openarcCanvasAiMarks = (function () {
    "use strict";
    var MAX_IDS = 200;      /* 单条命令涉及的 id 上限（与 canvas-domain 的 ids() 同量级）*/
    var MAX_MARKS = 200;    /* 账本条目上限（宿主 canvas/log 的 limit 同量级）*/

    function idKey(id) {
        if (typeof id === "string") return id;
        if (typeof id === "number" && isFinite(id)) return String(id);
        return "";
    }

    /** 数组 / Set / 普通对象（键即 id）→ 去重索引。*/
    function indexOfIds(value) {
        var out = {};
        if (Array.isArray(value)) { value.forEach(function (id) { var k = idKey(id); if (k) out[k] = true; }); return out; }
        if (value && typeof value.forEach === "function") { value.forEach(function (id) { var k = idKey(id); if (k) out[k] = true; }); return out; }
        if (value && typeof value === "object") { Object.keys(value).forEach(function (k) { if (k) out[k] = true; }); return out; }
        return out;
    }

    function idList(value, cap) {
        var out = [], seen = {};
        (Array.isArray(value) ? value : []).forEach(function (id) {
            var k = idKey(id);
            if (!k || seen[k] || out.length >= cap) return;
            seen[k] = true; out.push(k);
        });
        return out;
    }

    /** 宿主回包的防御性归一：形状不对的条目不猜、不抛；id 去重且限长。*/
    function sanitize(payload) {
        var rows = payload && Array.isArray(payload.marks) ? payload.marks : [];
        var out = [];
        rows.forEach(function (row) {
            if (!row || typeof row !== "object" || out.length >= MAX_MARKS) return;
            var nodeIds = idList(row.nodeIds, MAX_IDS);
            var edgeIds = idList(row.edgeIds, MAX_IDS);
            if (!nodeIds.length && !edgeIds.length) return;
            var revision = Number(row.resultRevision);
            var at = Number(row.at);
            out.push({
                nodeIds: nodeIds, edgeIds: edgeIds,
                commandType: typeof row.commandType === "string" ? row.commandType.slice(0, 40) : "",
                resultRevision: isFinite(revision) ? revision : null,
                at: isFinite(at) ? at : null,
            });
        });
        return out;
    }

    /**
     * 标记 + 入场动画计划。**不按当前文档过滤 id**：宿主回包已经只含当前文档里仍存在的 id，
     * 而页面侧是**按元素**加标记的（元素不存在 = 什么都不发生），多出来的 id 不会产生任何效果。
     * @returns {{marks: Array, marked: {nodeIds: string[], edgeIds: string[]},
     *            enter: {nodeIds: string[], edgeIds: string[]},
     *            seen: {nodeIds: string[], edgeIds: string[]}}}
     */
    function plan(payload, seen) {
        var marks = sanitize(payload);
        var played = {
            nodeIds: indexOfIds(seen && seen.nodeIds),
            edgeIds: indexOfIds(seen && seen.edgeIds),
        };
        var marked = { nodeIds: [], edgeIds: [] };
        var enter = { nodeIds: [], edgeIds: [] };
        function collect(ids, kind) {
            ids.forEach(function (id) {
                if (marked[kind].indexOf(id) >= 0) return;
                marked[kind].push(id);
                if (played[kind][id]) return;
                played[kind][id] = true;
                enter[kind].push(id);
            });
        }
        marks.forEach(function (row) {
            collect(row.nodeIds, "nodeIds");
            collect(row.edgeIds, "edgeIds");
        });
        return {
            marks: marks,
            marked: marked,
            enter: enter,
            seen: { nodeIds: Object.keys(played.nodeIds), edgeIds: Object.keys(played.edgeIds) },
        };
    }

    return { sanitize: sanitize, plan: plan, idList: idList, MAX_IDS: MAX_IDS, MAX_MARKS: MAX_MARKS };
})();

/* 页面里（本文件被 vendor 脚本内联进 canvas.js 的同一个 IIFE）与 Node 单测里共用同一份实现。*/
if (typeof module === "object" && module && module.exports) module.exports = __openarcCanvasAiMarks;
if (typeof window !== "undefined") window.__openarcCanvasAiMarks = __openarcCanvasAiMarks;
