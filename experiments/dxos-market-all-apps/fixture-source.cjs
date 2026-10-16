/**
 * 应用商店升级 · 离线 fixture 更新源（主进程侧）。
 *
 * 与 experiments/dxos-canvas-update-ui/fixture-source.cjs 同一手法：renderer 的 window.openarc
 * 由 contextBridge 暴露且不可写，所以不 stub 桥；改用 NODE_OPTIONS=--require <shim> 预加载本模块，
 * 顶替 globalThis.fetch（main.cjs 用 fetchImpl: fetch 取到的就是这个），只拦 modelscope.cn /
 * api.github.com，其余原样透传（探针断言 passthrough = 0）。
 *
 * 泛化点：文件清单里同时给多个应用出 updates/<appId>/latest.json 与 <appId>-<version>.zip，
 * 更新服务按 appId 各取各的。场景来自 OA_ALL_APPS_FIXTURE_STATE 指向的 JSON：
 *   { canvas: { version, zip, notesUrl, publishedAt, noRelease, delayZipMs },
 *     notes:  { version, zip, ... } }
 * 每次请求重读，探针可在运行中切换。
 */
"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");

const realFetch = globalThis.fetch;
const STATE_FILE = process.env.OA_ALL_APPS_FIXTURE_STATE || "";
const LOG_FILE = process.env.OA_ALL_APPS_FIXTURE_LOG || "";
const APPS = ["canvas", "notes"];

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
function manifestFor(appId, state, zipBytes) {
  return {
    version: state.version,
    build: 1,
    asset: "updates/" + appId + "/" + appId + "-" + state.version + ".zip",
    sha256: sha256(zipBytes),
    notes: state.notesUrl || null,
    publishedAt: Number(state.publishedAt) || 0,
  };
}

globalThis.fetch = async function openArcAllAppsFixtureFetch(url, init) {
  const target = String(url);
  let parsed;
  try { parsed = new URL(target); } catch { return realFetch(url, init); }

  if (parsed.hostname === "modelscope.cn") {
    const state = readState();
    logLine("modelscope " + parsed.pathname + "?" + parsed.search);
    if (parsed.pathname.endsWith("/revisions")) {
      return jsonResponse({ Data: { RevisionMap: { Branches: [{ Name: "master", Revision: "master" }], Tags: [] } } });
    }
    const entries = [];
    const manifests = {};
    for (const appId of APPS) {
      const appState = state[appId];
      if (!appState || appState.noRelease === true || !appState.zip || !appState.version) continue;
      let zipBytes;
      try { zipBytes = fs.readFileSync(String(appState.zip)); } catch { continue; }
      const manifest = manifestFor(appId, appState, zipBytes);
      const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
      manifests[appId] = { manifest, manifestBytes, zipBytes, appState };
      entries.push({ Path: "updates/" + appId + "/latest.json", Size: manifestBytes.length, Sha256: sha256(manifestBytes), Revision: "master", Type: "blob" });
      entries.push({ Path: manifest.asset, Size: zipBytes.length, Sha256: sha256(zipBytes), Revision: "master", Type: "blob" });
    }
    if (parsed.pathname.endsWith("/repo/files")) return jsonResponse({ Data: { Files: entries } });
    if (parsed.pathname.endsWith("/repo")) {
      const filePath = parsed.searchParams.get("FilePath");
      for (const appId of APPS) {
        const item = manifests[appId];
        if (!item) continue;
        if (filePath === "updates/" + appId + "/latest.json") return jsonResponse(item.manifest);
        if (filePath === item.manifest.asset) {
          const delay = Number(item.appState.delayZipMs) || 0;
          if (delay > 0) await new Promise(function (resolve) { setTimeout(resolve, delay); });
          return new Response(item.zipBytes, { status: 200, headers: { "content-type": "application/octet-stream" } });
        }
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
