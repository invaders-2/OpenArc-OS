/**
 * 无限画布在线更新 · 离线 fixture 更新源（主进程侧）。
 *
 * 为什么在这里：
 *   · renderer 的 window.openarc 由 contextBridge 暴露，属性 **不可写、不可配置**（探针实测，
 *     见 diagnose-bridge.mjs），所以页内 stub 桥做不到；
 *   · 但主进程 electron/main.cjs 在装配更新服务时用 `fetchImpl: fetch`（即 globalThis.fetch），
 *     只要本模块在 main.cjs 之前跑，注入的 fetchImpl 就是它。
 *   因此用 NODE_OPTIONS=--require <无空格临时路径的 shim> 预加载本模块，顶替 globalThis.fetch，
 *   把 https://modelscope.cn 变成内存里的 fixture 更新源。除白名单主机外一律原样透传。
 *
 * 覆盖的 endpoint（与 electron/market-update-sources.cjs 的 ModelScope 适配器一一对应）：
 *   GET /api/v1/models/{owner}/{repo}/revisions
 *   GET /api/v1/models/{owner}/{repo}/repo/files?Revision=&Recursive=true
 *   GET /api/v1/models/{owner}/{repo}/repo?Revision=&FilePath=updates/canvas/latest.json
 *   GET /api/v1/models/{owner}/{repo}/repo?Revision=&FilePath=updates/canvas/canvas-<version>.zip
 * GitHub Releases 源（api.github.com）回空数组 = 无可用版本，同样不联网。
 *
 * 场景来自 OA_UPDATE_FIXTURE_STATE 指向的 JSON（每次请求重读，探针可在运行中切换）：
 *   { zip, version, notesUrl, publishedAt, build, noRelease, delayZipMs }
 * 每次请求写一行到 OA_UPDATE_FIXTURE_LOG，作为「真的走了主进程更新服务」的证据。
 */
"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");

const realFetch = globalThis.fetch;
const STATE_FILE = process.env.OA_UPDATE_FIXTURE_STATE || "";
const LOG_FILE = process.env.OA_UPDATE_FIXTURE_LOG || "";
const MANIFEST_PATH = "updates/canvas/latest.json";

function logLine(line) {
  if (!LOG_FILE) return;
  try { fs.appendFileSync(LOG_FILE, line + String.fromCharCode(10)); } catch { /* 日志失败不影响请求 */ }
}
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}
function jsonResponse(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
function notFound() {
  return new Response("fixture: not found", { status: 404 });
}
function latestManifest(state, zipBytes) {
  return {
    version: state.version,
    build: Number(state.build) > 0 ? Number(state.build) : 1,
    asset: "updates/canvas/canvas-" + state.version + ".zip",
    sha256: sha256(zipBytes),
    notes: state.notesUrl || null,
    publishedAt: Number(state.publishedAt) || 0,
  };
}

globalThis.fetch = async function openArcFixtureFetch(url, init) {
  const target = String(url);
  let parsed;
  try { parsed = new URL(target); } catch { return realFetch(url, init); }

  if (parsed.hostname === "modelscope.cn") {
    const state = readState();
    logLine("modelscope " + parsed.pathname + "?" + parsed.search + " | noRelease=" + (state.noRelease === true) + " version=" + String(state.version) + " delay=" + String(state.delayZipMs || 0) + " zip=" + String(state.zip || ""));
    if (parsed.pathname.endsWith("/revisions")) {
      return jsonResponse({ Data: { RevisionMap: { Branches: [{ Name: "master", Revision: "master" }], Tags: [] } } });
    }
    if (state.noRelease === true) {
      if (parsed.pathname.endsWith("/repo/files")) return jsonResponse({ Data: { Files: [] } });
      return notFound();
    }
    let zipBytes;
    try { zipBytes = fs.readFileSync(String(state.zip)); } catch { return new Response("fixture: zip missing", { status: 500 }); }
    if (parsed.pathname.endsWith("/repo/files")) {
      const manifestBytes = Buffer.from(JSON.stringify(latestManifest(state, zipBytes)), "utf8");
      return jsonResponse({
        Data: {
          Files: [
            { Path: MANIFEST_PATH, Size: manifestBytes.length, Sha256: sha256(manifestBytes), Revision: "master", Type: "blob" },
            { Path: "updates/canvas/canvas-" + state.version + ".zip", Size: zipBytes.length, Sha256: sha256(zipBytes), Revision: "master", Type: "blob" },
          ],
        },
      });
    }
    if (parsed.pathname.endsWith("/repo")) {
      const filePath = parsed.searchParams.get("FilePath");
      if (filePath === MANIFEST_PATH) return jsonResponse(latestManifest(state, zipBytes));
      if (filePath === "updates/canvas/canvas-" + state.version + ".zip") {
        const delay = Number(state.delayZipMs) || 0;
        if (delay > 0) await new Promise(function (resolve) { setTimeout(resolve, delay); });
        return new Response(zipBytes, { status: 200, headers: { "content-type": "application/octet-stream" } });
      }
      return notFound();
    }
    return notFound();
  }

  if (parsed.hostname === "api.github.com") {
    logLine("github " + parsed.pathname + parsed.search + " | fixture: 空 Release 列表");
    return jsonResponse([]);
  }

  logLine("passthrough " + target);
  return realFetch(url, init);
};

module.exports = { fixtureLoaded: true };
