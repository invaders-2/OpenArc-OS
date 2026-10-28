"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, desktopCapturer, dialog } = require("electron");

const MEDIA = new Map([[".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".webp", "image/webp"], [".gif", "image/gif"], [".mp4", "video/mp4"], [".mov", "video/quicktime"], [".webm", "video/webm"], [".mp3", "audio/mpeg"], [".wav", "audio/wav"], [".m4a", "audio/mp4"], [".aac", "audio/aac"], [".ogg", "audio/ogg"]]);
const grants = new Map();
const recordSources = new Map();
let loaded = false;

function grantFile() { return path.join(app.getPath("userData"), "canvas-folder-grants.json"); }
function load() { if (loaded) return; loaded = true; try { const rows = JSON.parse(fs.readFileSync(grantFile(), "utf8")); for (const row of rows) if (row && row.id && row.root && row.name) grants.set(row.id, { id: row.id, root: path.resolve(row.root), name: row.name }); } catch {} }
function save() { fs.mkdirSync(path.dirname(grantFile()), { recursive: true }); const tmp = grantFile() + ".tmp"; fs.writeFileSync(tmp, JSON.stringify([...grants.values()], null, 2), { mode: 0o600 }); fs.renameSync(tmp, grantFile()); }
function error(code, detail) { return { ok: false, error: code, ...(detail ? { detail: String(detail).slice(0, 300) } : {}) }; }
function grant(id) { load(); const value = grants.get(String(id || "")); if (!value) throw new Error("FOLDER_GRANT_INVALID"); return value; }
function safeChild(root, relative) { const target = path.resolve(root, relative); if (target !== root && !target.startsWith(root + path.sep)) throw new Error("FOLDER_PATH_NOT_ALLOWED"); return target; }

async function chooseFolder(sender, defaultPath) {
  const owner = BrowserWindow.fromWebContents(sender);
  const result = await dialog.showOpenDialog(owner, { properties: ["openDirectory", "createDirectory"], buttonLabel: "授权此文件夹", ...(defaultPath ? { defaultPath } : {}) });
  if (result.canceled || !result.filePaths[0]) return { ok: false, error: "CANCELLED" };
  const root = path.resolve(result.filePaths[0]); const id = "folder_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), name = path.basename(root);
  load(); grants.set(id, { id, root, name }); save(); return { ok: true, grant: { id, name } };
}
function listGrants() { load(); return { ok: true, grants: [...grants.values()].map(({ id, name }) => ({ id, name })) }; }
function removeGrant(id) { load(); grants.delete(String(id || "")); save(); return { ok: true }; }
function listFiles(id) {
  const selected = grant(id), rows = [];
  function walk(dir, depth) {
    if (depth > 3 || rows.length >= 200) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const absolute = path.join(dir, entry.name), relative = path.relative(selected.root, absolute);
      if (entry.isDirectory()) walk(absolute, depth + 1);
      else if (entry.isFile() && MEDIA.has(path.extname(entry.name).toLowerCase())) rows.push({ id: relative, name: entry.name, relative, mime: MEDIA.get(path.extname(entry.name).toLowerCase()), size: fs.statSync(absolute).size });
      if (rows.length >= 200) break;
    }
  }
  walk(selected.root, 0); return { ok: true, grant: { id: selected.id, name: selected.name }, files: rows };
}
function readFile(id, relative) {
  const selected = grant(id), target = safeChild(selected.root, String(relative || "")), stat = fs.statSync(target);
  if (!stat.isFile() || stat.size > 200 * 1024 * 1024) throw new Error("FOLDER_FILE_TOO_LARGE");
  const mime = MEDIA.get(path.extname(target).toLowerCase()); if (!mime) throw new Error("FOLDER_FILE_TYPE_NOT_ALLOWED");
  return { ok: true, name: path.basename(target), mime, dataUrl: `data:${mime};base64,${fs.readFileSync(target).toString("base64")}` };
}
function withCaptureTimeout(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("CAPTURE_PERMISSION_TIMEOUT")), 10_000); })]).finally(() => clearTimeout(timer));
}
async function captureSources() {
  const rows = await withCaptureTimeout(desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: true }));
  return { ok: true, sources: rows.map((s) => ({ id: s.id, name: s.name, kind: s.id.startsWith("screen:") ? "screen" : "window", thumbnail: s.thumbnail.toDataURL() })) };
}
async function captureScreenshot(id) {
  const rows = await withCaptureTimeout(desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 1920, height: 1080 } }));
  const source = rows.find((s) => s.id === id) || rows.find((s) => s.id.startsWith("screen:"));
  if (!source) return error("CAPTURE_SOURCE_NOT_FOUND");
  const image = source.thumbnail; if (image.isEmpty()) return error("CAPTURE_EMPTY");
  return { ok: true, name: "画布截图-" + new Date().toISOString().replace(/[:.]/g, "-") + ".png", mime: "image/png", dataUrl: image.toDataURL() };
}
function selectRecording(sender, id) {
  recordSources.set(sender.session.id, id);
  sender.session.setDisplayMediaRequestHandler((_request, callback) => {
    const selected = recordSources.get(sender.session.id);
    if (!selected) return callback({});
    desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 200 } }).then((rows) => {
      const source = rows.find((s) => s.id === selected);
      if (source) callback({ video: source, audio: null }); else callback({});
    }).catch(() => callback({}));
  });
  return { ok: true };
}
function stopRecording(sender) { recordSources.delete(sender.session.id); return { ok: true }; }

async function executeCanvasDesktopInput(command, payload, sender) {
  try {
    if (command === "canvas/folder/grants") return listGrants();
    if (command === "canvas/folder/choose") return await chooseFolder(sender, typeof payload.defaultPath === "string" ? payload.defaultPath : undefined);
    if (command === "canvas/folder/remove") return removeGrant(payload.grantId);
    if (command === "canvas/folder/files") return listFiles(payload.grantId);
    if (command === "canvas/folder/read") return readFile(payload.grantId, payload.file);
    if (command === "canvas/capture/sources") return await captureSources();
    if (command === "canvas/capture/screenshot") return await captureScreenshot(payload.sourceId);
    if (command === "canvas/capture/selectRecording") return selectRecording(sender, payload.sourceId);
    if (command === "canvas/capture/stopRecording") return stopRecording(sender);
    return error("CANVAS_COMMAND_NOT_ALLOWED", command);
  } catch (err) { return error(String(err?.message || "DESKTOP_INPUT_FAILED")); }
}

module.exports = { executeCanvasDesktopInput };
