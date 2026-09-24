/* ══════════════════════════════════════════════════════════════════════════════
   OpenArc：画布保存冲突的**三方合并**（纯数据函数：不碰 DOM、不碰画布闭包、不读全局）
   ──────────────────────────────────────────────────────────────────────────────
   为什么需要它：页面在 500ms 待保存窗口里做的本地编辑，一旦与宿主 / AI / 其它窗口的改动
   撞上，上游 saveCanvas() 的 409 分支会"把基线换成远端新值 → 立刻重发同一份基于旧 revision 的
   整篇文档"，于是对方那次改动被静默覆盖（第八 / 十 / 十一批真机实测）。

   这里把 409 变成三方合并：base = 页面最后一次成功同步的文档，local = 页面当前文档，
   remote = 冲突回包里那份远端文档。按**节点 id / 连线 id / 日志 id**逐项合并：
     · 只在一侧新增            → 保留；
     · 一侧删除、另一侧未改     → 删除；
     · 两侧都改、字段不重叠     → 各自保留（字段级）；
     · 同一字段两边都改了       → 不猜：本地那一版留在原位，远端那一版另存为**可辨认副本**
                                 （id 后缀 -remote，带 oaConflictCopyOf 标记），并如实报告。
   合并结果 + 冲突清单一起返回；写回页面、提示、重发由 canvas-internals.js 负责。
   纯数据 ⇒ Node 侧（tests/d5-02-canvas-merge.test.mjs）require 本文件即可测**同一份**实现。
   ══════════════════════════════════════════════════════════════════════════════ */
var __openarcCanvasMerge = (function () {
    "use strict";
    var COPY_SUFFIX = "-remote";
    var COPY_MARK = "oaConflictCopyOf";      // 副本标记：值是它复制的那一项的 id
    var copyMeta = {}; copyMeta[COPY_MARK] = true; copyMeta.oaConflictAt = true;

    /** 与键序无关的规范化串：文档来自本地对象或 JSON 往返，键序不保证一致。*/
    function canon(value) {
        if (value === undefined) return "undefined";
        if (value === null || typeof value !== "object") return JSON.stringify(value);
        if (Array.isArray(value)) return "[" + value.map(canon).join(",") + "]";
        var keys = Object.keys(value).sort();
        return "{" + keys.map(function (k) { return JSON.stringify(k) + ":" + canon(value[k]); }).join(",") + "}";
    }
    function equal(a, b) { return canon(a) === canon(b); }
    function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
    function itemKey(item) { return String((item && item.id) || ""); }

    /** 副本的"内容"：去掉 id / 标记 / 位置（位置为了并排可见做了偏移，不是内容）。*/
    function contentOf(item) {
        var copy = clone(item) || {};
        delete copy.id; delete copy.x; delete copy.y;
        Object.keys(copyMeta).forEach(function (k) { delete copy[k]; });
        return copy;
    }

    /** 单个字段的三方取舍：远端没改 → 本地；本地没改 → 远端；两边改成了同一个值 → 任取；否则冲突。*/
    function mergeField(baseValue, localValue, remoteValue) {
        if (equal(remoteValue, baseValue)) return { value: localValue, conflict: false };
        if (equal(localValue, baseValue)) return { value: remoteValue, conflict: false };
        if (equal(localValue, remoteValue)) return { value: localValue, conflict: false };
        return { value: localValue, conflict: true };
    }

    /** 两侧都改了同一项：逐字段合并，冲突字段留在本地值上并记进 fields。*/
    function mergeItem(baseItem, localItem, remoteItem, fields) {
        var merged = clone(localItem) || {};
        Object.keys(remoteItem || {}).forEach(function (field) {
            if (copyMeta[field]) return;
            var pick = mergeField((baseItem || {})[field], localItem[field], remoteItem[field]);
            if (!pick.conflict) {
                if (pick.value === undefined) delete merged[field];
                else merged[field] = clone(pick.value);
                return;
            }
            fields.push(field);
        });
        return merged;
    }

    function uniqueCopyId(id, used) {
        var candidate = id + COPY_SUFFIX, n = 2;
        while (used[candidate]) { candidate = id + COPY_SUFFIX + n; n += 1; }
        return candidate;
    }

    /** 远端那一版的可辨认副本：id 后缀 + 标记 + 并排偏移（组节点再在标题上写一句）。*/
    function remoteCopy(remoteItem, id, kind, localList, produced, used) {
        var body = contentOf(remoteItem);
        var seen = null;
        (localList || []).concat(produced).some(function (item) {
            if (!item || item[COPY_MARK] !== id || !equal(contentOf(item), body)) return false;
            seen = item; return true;
        });
        if (seen) return { id: seen.id, item: null };            // 同一份远端版本已经复制过：幂等复用
        var copyId = uniqueCopyId(id, used);
        used[copyId] = true;
        var copy = clone(remoteItem) || {};
        copy.id = copyId;
        copy[COPY_MARK] = id;
        if (typeof copy.x === "number" && isFinite(copy.x) && typeof copy.y === "number" && isFinite(copy.y)) {
            copy.x += 48; copy.y += 48;
        }
        if (kind === "node" && copy.type === "group" && typeof copy.title === "string") {
            copy.title = copy.title + "（远端副本 · 保存冲突）";
        }
        return { id: copyId, item: copy };
    }

    function indexById(list) {
        var out = {};
        (list || []).forEach(function (item) { var key = itemKey(item); if (key) out[key] = item; });
        return out;
    }

    /**
     * 按 id 的三方合并。返回合并后的列表；冲突、副本、各项增删计数都写进 report。
     * copyOnConflict=false（日志：只追加、不可变）时，同 id 冲突保留本地，不造副本。
     */
    function mergeKeyed(baseList, localList, remoteList, kind, report, copyOnConflict) {
        var base = indexById(baseList), local = indexById(localList), remote = indexById(remoteList);
        var order = [];
        (localList || []).forEach(function (item) { var key = itemKey(item); if (key && order.indexOf(key) < 0) order.push(key); });
        (remoteList || []).forEach(function (item) { var key = itemKey(item); if (key && order.indexOf(key) < 0) order.push(key); });
        // 只存在于 base 的 id（两边都删了）：不进结果，但要如实记一笔，别让"删除"看起来像没发生过。
        (baseList || []).forEach(function (item) { var key = itemKey(item); if (key && order.indexOf(key) < 0) order.push(key); });
        var used = {};
        (baseList || []).concat(localList || [], remoteList || []).forEach(function (item) { var key = itemKey(item); if (key) used[key] = true; });
        var out = [];
        order.forEach(function (id) {
            var b = base[id], l = local[id], r = remote[id];
            var hasBase = b !== undefined, hasLocal = l !== undefined, hasRemote = r !== undefined;
            if (hasLocal && hasRemote) {
                if (equal(l, r)) { out.push(clone(l)); return; }
                if (hasBase && equal(l, b)) { out.push(clone(r)); report.remoteApplied.push(kind + ":" + id); return; }
                if (hasBase && equal(r, b)) { out.push(clone(l)); return; }
                var fields = [];
                var merged = mergeItem(hasBase ? b : {}, l, r, fields);
                out.push(merged);
                if (!fields.length) { report.remoteApplied.push(kind + ":" + id); return; }
                report.conflicts.push({ kind: kind, id: id, reason: hasBase ? "SAME_FIELD" : "BOTH_ADDED", fields: fields });
                if (copyOnConflict) {
                    var copy = remoteCopy(r, id, kind, localList, out, used);
                    report.copies.push(copy.id);
                    if (copy.item) out.push(copy.item);
                }
                return;
            }
            if (hasLocal) {                                                  // 远端没有这一项
                if (!hasBase) { out.push(clone(l)); report.localAdded.push(kind + ":" + id); return; }
                if (equal(l, b)) { report.remoteDeleted.push(kind + ":" + id); return; }   // 远端删、本地没改 → 删
                out.push(clone(l));                                          // 远端删、本地改了 → 删除不带走内容，保留本地
                report.conflicts.push({ kind: kind, id: id, reason: "REMOTE_DELETED", fields: [] });
                return;
            }
            if (hasRemote) {                                                 // 本地没有这一项
                if (!hasBase) { out.push(clone(r)); report.remoteAdded.push(kind + ":" + id); return; }
                if (equal(r, b)) { report.localDeleted.push(kind + ":" + id); return; }    // 本地删、远端没改 → 删
                report.conflicts.push({ kind: kind, id: id, reason: "LOCAL_DELETED_REMOTE_CHANGED", fields: [] });
                if (copyOnConflict) {
                    var kept = remoteCopy(r, id, kind, localList, out, used);
                    report.copies.push(kept.id);
                    if (kept.item) out.push(kept.item);
                }
                return;
            }
            report.bothDeleted.push(kind + ":" + id);                        // 两边都删了
        });
        return out;
    }

    function emptyReport() {
        return {
            conflicts: [], copies: [], remoteAdded: [], remoteDeleted: [], remoteApplied: [],
            localAdded: [], localDeleted: [], bothDeleted: [],
        };
    }

    function mergeDocs(base, local, remote) {
        base = base || {}; local = local || {}; remote = remote || {};
        var report = emptyReport();
        var nodes = mergeKeyed(base.nodes, local.nodes, remote.nodes, "node", report, true);
        var connections = mergeKeyed(base.connections, local.connections, remote.connections, "edge", report, true);
        // 日志是只追加的（新条目插在最前、截断到 500），同 id 冲突保留本地即可，不造副本。
        var logs = mergeKeyed(base.logs, local.logs, remote.logs, "log", report, false);
        var title = mergeField(base.title, local.title, remote.title);
        if (title.conflict) report.conflicts.push({ kind: "canvas", id: "", reason: "SAME_FIELD", fields: ["title"] });
        var icon = mergeField(base.icon, local.icon, remote.icon);
        if (icon.conflict) report.conflicts.push({ kind: "canvas", id: "", reason: "SAME_FIELD", fields: ["icon"] });
        // 标题冲突没有"副本"这种载体：本地标题留在原位，远端标题进提示文案（report.remoteTitle）。
        report.remoteTitle = title.conflict ? remote.title : null;
        return {
            doc: { nodes: nodes, connections: connections, logs: logs, title: title.value, icon: icon.value },
            report: report,
        };
    }

    return { mergeDocs: mergeDocs, canon: canon, equal: equal, COPY_MARK: COPY_MARK, COPY_SUFFIX: COPY_SUFFIX };
})();

/* 页面里（本文件被 vendor 脚本内联进 canvas.js 的同一个 IIFE）与 Node 单测里共用同一份实现。*/
if (typeof module === "object" && module && module.exports) module.exports = __openarcCanvasMerge;
if (typeof window !== "undefined") window.__openarcCanvasMerge = __openarcCanvasMerge;
