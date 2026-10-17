/* ══════════════════════════════════════════════════════════════════════════════
   OpenArc 智能画布 · 宿主推送同步（追加在 smart-canvas.js 的 IIFE 末尾，第 16 处改动）
   ──────────────────────────────────────────────────────────────────────────────
   问题：宿主 / AI 通过 canvas/command 改动文档后，已打开的智能画布只能等自己的远端合并轮询
   （上游 8s）才看到；经典画布是 2.5s，门禁 F3d 的 ≤5s 预算因此不成立。

   修复分两层（都必须保留）：
     1) **宿主推送（主路径）**：CanvasHost 检测到 canvas revision/updated_at 变化后，向这个 iframe
        发 {ch:"openarc.canvas", dir:"host->canvas", kind:"doc-changed", doc, updatedAt, title}。
        本注入层收到后走页面**自己的** applyMergedServerCanvas（与轮询/409 合并同一份语义），
        不重载 iframe、不整篇替换、不新建第二套文档。
     2) **兜底轮询**：static/js/smart-canvas.js 的区段轮询 8000 → 2500（第 17 处改动，见 vendor 脚本）。
        推送丢失 / 帧还没就绪 / 宿主被关掉时，最多 2.5s 仍会合并。

   安全（"不打断正在编辑的用户、不丢内容"）：
     · 正在输入（焦点在 input/textarea/select/contenteditable）、拖动、框选、保存中、
       本地有未保存改动（内容签名 ≠ 上次成功保存的签名）时，**一律不 apply**；
       推送先记 pending，400ms 后重试，最多 30 次（15s）后交回兜底轮询，绝不抢先打断；
     · mergeReloadCanvasNow（轮询/409 的入口）也走同一个 oaLiveSyncMergeUnsafe()（vendor 补丁），
       所以兜底路径同样不会在输入中途合并；
     · 按 updated_at 幂等：同一改动只合并一次；比页面当前更新的才合并（旧包 / 重发一律跳过）。

   证据面（只读，供门禁与探针）：window.__openarcCanvasLiveSync.stats()
   ══════════════════════════════════════════════════════════════════════════════ */

/* 注意：这里**不能**再包一层 IIFE —— oaLiveSyncMergeUnsafe 必须与 mergeReloadCanvasNow 同在
   smart-canvas.js 的 IIFE 作用域里（函数声明提升），vendor 补丁才能调用它。*/
var OA_LIVE_SYNC_CHANNEL = "openarc.canvas";
var OA_LIVE_SYNC_POLL_MS = 2500;
var oaLiveSyncStats = { pushed: 0, applied: 0, deferred: 0, skipped: 0, failed: 0, lastPushedAt: 0, lastAppliedAt: 0, lastUpdatedAt: 0 };
var oaLiveSyncPending = null;
var oaLiveSyncRetryTimer = null;
var oaLiveSyncRetries = 0;
var oaLiveSyncAppliedUpdatedAt = 0;

function oaLiveSyncUserEditing(){
    try {
        var el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) return false;
        if (el.isContentEditable) return true;
        var tag = String(el.tagName || "").toUpperCase();
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
        if (el.getAttribute && el.getAttribute("contenteditable") === "true") return true;
    } catch(e) {}
    return false;
}
/* 本地有未保存改动：内容签名与"上次成功保存的签名"不一致（视口/选中态不算内容）。*/
function oaLiveSyncDirty(){
    try {
        if (typeof canvasForStorage !== "function" || typeof canvasContentSignature !== "function") return false;
        var sig = canvasContentSignature(canvasForStorage());
        return !!sig && sig !== lastSavedContentSig;
    } catch(e) { return false; }
}
/* 轮询入口（mergeReloadCanvasNow）与推送入口共用这一条安全判定。*/
function oaLiveSyncMergeUnsafe(){
    try { if (canvasSyncInFlight) return true; } catch(e) {}
    try { if (dragState || selectionState) return true; } catch(e) {}
    if (oaLiveSyncUserEditing()) return true;
    if (oaLiveSyncDirty()) return true;
    return false;
}
function oaLiveSyncApply(msg){
    if (!msg || !msg.doc) return false;
    var remoteUpdatedAt = Number(msg.updatedAt || 0);
    var currentUpdatedAt = Number((canvas && canvas.updated_at) || 0);
    if (remoteUpdatedAt && remoteUpdatedAt <= currentUpdatedAt) return false;          // 已经包含这次改动
    if (remoteUpdatedAt && remoteUpdatedAt === oaLiveSyncAppliedUpdatedAt) return false; // 同一条推送重发
    oaLiveSyncAppliedUpdatedAt = remoteUpdatedAt;
    oaLiveSyncStats.lastUpdatedAt = remoteUpdatedAt;
    applyMergedServerCanvas({
        nodes: Array.isArray(msg.doc.nodes) ? msg.doc.nodes : [],
        connections: Array.isArray(msg.doc.connections) ? msg.doc.connections : [],
        title: msg.title || (canvas && canvas.title) || "",
        updated_at: remoteUpdatedAt || Date.now()
    });
    oaLiveSyncStats.applied += 1;
    oaLiveSyncStats.lastAppliedAt = Date.now();
    return true;
}
function oaLiveSyncTryPending(){
    oaLiveSyncRetryTimer = null;
    var msg = oaLiveSyncPending;
    if (!msg) return;
    if (oaLiveSyncMergeUnsafe()) {
        oaLiveSyncRetries += 1;
        /* 用户一直在编辑：到期后不再抢，交回 2.5s 兜底轮询（它走同一条安全判定）。*/
        if (oaLiveSyncRetries > 30) { oaLiveSyncPending = null; oaLiveSyncStats.skipped += 1; return; }
        oaLiveSyncRetryTimer = setTimeout(oaLiveSyncTryPending, 400);
        return;
    }
    oaLiveSyncPending = null;
    oaLiveSyncRetries = 0;
    try { if (!oaLiveSyncApply(msg)) oaLiveSyncStats.skipped += 1; } catch(e) { oaLiveSyncStats.failed += 1; }
}
function oaLiveSyncOnMessage(event){
    var d = event && event.data;
    if (!d || d.ch !== OA_LIVE_SYNC_CHANNEL || d.dir !== "host->canvas") return;
    if (d.kind !== "doc-changed") return;
    if (!canvasId || (d.canvasId && String(d.canvasId) !== String(canvasId))) return;
    oaLiveSyncStats.pushed += 1;
    oaLiveSyncStats.lastPushedAt = Date.now();
    var remoteUpdatedAt = Number(d.updatedAt || 0);
    if (remoteUpdatedAt && remoteUpdatedAt <= Number((canvas && canvas.updated_at) || 0)) { oaLiveSyncStats.skipped += 1; return; }
    if (remoteUpdatedAt && remoteUpdatedAt === oaLiveSyncAppliedUpdatedAt) { oaLiveSyncStats.skipped += 1; return; }
    if (oaLiveSyncMergeUnsafe()) {
        oaLiveSyncStats.deferred += 1;
        oaLiveSyncPending = d;
        oaLiveSyncRetries = 0;
        if (!oaLiveSyncRetryTimer) oaLiveSyncRetryTimer = setTimeout(oaLiveSyncTryPending, 400);
        return;
    }
    try { if (!oaLiveSyncApply(d)) oaLiveSyncStats.skipped += 1; } catch(e) { oaLiveSyncStats.failed += 1; }
}
window.addEventListener("message", oaLiveSyncOnMessage);
window.addEventListener("beforeunload", function(){
    if (oaLiveSyncRetryTimer) { clearTimeout(oaLiveSyncRetryTimer); oaLiveSyncRetryTimer = null; }
    oaLiveSyncPending = null;
});
window.__openarcCanvasLiveSync = {
    version: 1,
    channel: OA_LIVE_SYNC_CHANNEL,
    pollIntervalMs: OA_LIVE_SYNC_POLL_MS,
    mergeUnsafe: function(){ return oaLiveSyncMergeUnsafe(); },
    stats: function(){
        return Object.assign({}, oaLiveSyncStats, {
            pending: !!oaLiveSyncPending,
            retries: oaLiveSyncRetries,
            appliedUpdatedAt: oaLiveSyncAppliedUpdatedAt
        });
    }
};
