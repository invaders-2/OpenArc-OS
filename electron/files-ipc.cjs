const { app, BrowserWindow, ipcMain, nativeImage, protocol, net, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { Readable } = require("node:stream");
const { pathToFileURL } = require("node:url");
const { createFileService } = require("./file-service.cjs");
const { createWeatherService } = require("./weather-service.cjs");
const { createVideoService } = require("./video-service.cjs");
const { declareImage } = require("./xmp-service.cjs");

const NATIVE_RESOURCES = {
  "siri-blob": "/System/Library/PrivateFrameworks/SiriUI.framework/Versions/A/Resources/Siri Blob.mov",
};
const NATIVE_TYPES = { ".mov": "video/quicktime", ".mp4": "video/mp4", ".m4v": "video/x-m4v" };
const MEDIA_TYPES = { ...NATIVE_TYPES, ".webm": "video/webm", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".aac": "audio/aac", ".ogg": "audio/ogg", ".flac": "audio/flac" };

let files;
let win;

function registerFilesIpc(context) {
  const { trusted, uiPlatform } = context;
  win = context.win;
  files = createFileService({ userDataDir: app.getPath("userData") });
  context.files = files;

  // 路径只在主进程解析；native 与媒体分支显式支持 Range，保证视频可 seek 且不暴露任意路径。
  protocol.handle("openarc-file", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname === "native") {
        const abs = NATIVE_RESOURCES[url.pathname.replace(/^\/+/, "")];
        if (!abs || !fs.existsSync(abs)) return new Response("Not Found", { status: 404 });
        const size = fs.statSync(abs).size;
        const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") || "");
        const start = range?.[1] ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start > end) return new Response("Range Not Satisfiable", { status: 416 });
        const headers = {
          "Content-Type": NATIVE_TYPES[path.extname(abs).toLowerCase()] || "application/octet-stream",
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
          "Access-Control-Allow-Origin": "*",
        };
        if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
        const body = Readable.toWeb(fs.createReadStream(abs, { start, end }));
        return new Response(body, { status: range ? 206 : 200, headers });
      }
      const parts = url.pathname.split("/").filter(Boolean);
      const hit = files.resolve(decodeURIComponent(parts[0] || ""), decodeURIComponent(parts[1] || ""));
      if (!hit) return new Response("Not Found", { status: 404 });
      const mediaType = MEDIA_TYPES[path.extname(hit.path).toLowerCase()];
      if (mediaType) {
        const size = fs.statSync(hit.path).size;
        const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") || "");
        const start = range?.[1] ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start > end) return new Response("Range Not Satisfiable", { status: 416 });
        const headers = { "Content-Type": mediaType, "Accept-Ranges": "bytes", "Content-Length": String(end - start + 1) };
        if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
        return new Response(Readable.toWeb(fs.createReadStream(hit.path, { start, end })), { status: range ? 206 : 200, headers });
      }
      return await net.fetch(pathToFileURL(hit.path).toString());
    } catch {
      return new Response("Error", { status: 500 });
    }
  });

  ipcMain.handle("files:info", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    const hit = files.resolve(String(payload?.folderId ?? ""), String(payload?.id ?? ""));
    if (!hit) return { ok: false, error: "NOT_FOUND" };
    try {
      const img = nativeImage.createFromPath(hit.path);
      if (!img || img.isEmpty()) return { ok: false, error: "NO_INFO" };
      const size = img.getSize();
      return { ok: true, width: size.width, height: size.height };
    } catch {
      return { ok: false, error: "NO_INFO" };
    }
  });
  ipcMain.on("files:startDrag", async (e, payload) => {
    if (!trusted(e)) return;
    const hit = files.resolve(String(payload?.folderId ?? ""), String(payload?.id ?? ""));
    if (!hit) return;
    try {
      const thumb = await nativeImage.createThumbnailFromPath(hit.path, { width: 64, height: 64 });
      e.sender.startDrag({ file: hit.path, icon: thumb && !thumb.isEmpty() ? thumb : nativeImage.createEmpty() });
    } catch { /* 拖拽启动失败就当作没有发生 */ }
  });
  ipcMain.handle("files:copy", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    return files.copy(String(payload?.folderId ?? ""), payload?.ids, String(payload?.toFolderId ?? ""));
  });
  ipcMain.handle("files:move", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    return files.move(String(payload?.folderId ?? ""), payload?.ids, String(payload?.toFolderId ?? ""));
  });
  ipcMain.handle("files:export", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    const folderId = String(payload?.folderId ?? "");
    const ids = Array.isArray(payload?.ids) ? payload.ids.map(String) : [];
    const picks = ids.map((id) => files.resolve(folderId, id)).filter(Boolean);
    if (!picks.length) return { ok: false, error: "NOT_FOUND" };
    const host = BrowserWindow.fromWebContents(e.sender);
    const res = await dialog.showOpenDialog(host, {
      title: "导出到电脑",
      buttonLabel: "导出到此处",
      properties: ["openDirectory", "createDirectory"],
    });
    if (res.canceled || !res.filePaths?.[0]) return { ok: false, error: "CANCELED" };
    const dest = res.filePaths[0];
    const used = new Set();
    let count = 0;
    for (const hit of picks) {
      try {
        const base = path.basename(hit.path);
        const dot = base.lastIndexOf(".");
        const stem = dot > 0 ? base.slice(0, dot) : base;
        const ext = dot > 0 ? base.slice(dot) : "";
        let name = base;
        for (let index = 2; used.has(name) || fs.existsSync(path.join(dest, name)); index += 1) name = stem + " " + index + ext;
        used.add(name);
        fs.copyFileSync(hit.path, path.join(dest, name));
        count += 1;
      } catch { /* 单个失败不影响整批 */ }
    }
    return { ok: true, count, dest };
  });
  ipcMain.handle("files:import", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    const folderId = String(payload && payload.folderId ? payload.folderId : "");
    const paths = Array.isArray(payload && payload.paths) ? payload.paths.slice(0, 200) : [];
    return files.importPaths(folderId, paths);
  });
  ipcMain.handle("files:list", async (e, folderId) => {
    if (!trusted(e)) throw Error("Forbidden");
    return files.list(String(folderId ?? ""));
  });
  ipcMain.handle("files:rename", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    return files.rename(String(payload?.folderId ?? ""), String(payload?.id ?? ""), String(payload?.name ?? ""));
  });
  ipcMain.handle("files:remove", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    return files.remove(String(payload?.folderId ?? ""), String(payload?.id ?? ""));
  });
  ipcMain.handle("files:trash", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    return files.trash(String(payload?.folderId ?? ""), String(payload?.id ?? ""), payload?.groupId);
  });
  ipcMain.handle("files:trashList", async (event) => {
    if (!trusted(e)) throw Error("Forbidden");
    return files.listTrash();
  });
  ipcMain.handle("files:trashRestore", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    return files.restore(String(payload?.id ?? ""));
  });
  ipcMain.handle("files:trashPurge", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    return files.purge(String(payload?.id ?? ""));
  });
  ipcMain.handle("files:trashEmpty", async (event) => {
    if (!trusted(e)) throw Error("Forbidden");
    return files.empty();
  });

  const video = createVideoService();
  ipcMain.handle("video:status", async (event) => {
    if (!trusted(e)) throw Error("Forbidden");
    return video.status();
  });
  ipcMain.handle("video:probe", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    const hit = files.resolve(String(payload?.folderId ?? ""), String(payload?.id ?? ""));
    if (!hit) return { ok: false, error: "NOT_FOUND" };
    return video.probePath(hit.path);
  });
  ipcMain.handle("video:export", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    const outFolder = String(payload?.folderId ?? "");
    const refs = [];
    for (const clip of Array.isArray(payload?.clips) ? payload.clips.slice(0, 51) : []) {
      const hit = files.resolve(String(clip?.folderId ?? ""), String(clip?.id ?? ""));
      if (!hit) return { ok: false, error: "NOT_FOUND" };
      refs.push({ path: hit.path, start: Number(clip?.start), end: Number(clip?.end) });
    }
    const send = (progress) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("video:progress", progress); };
    const result = await video.exportClips(refs, {
      resolution: String(payload?.resolution ?? "source"),
      name: String(payload?.name ?? ""),
      onProgress: (ratio) => send({ ratio }),
    });
    if (!result.ok) return result;
    try {
      const imported = files.importPaths(outFolder, [result.outPath]);
      const entry = imported.ok && imported.added && imported.added[0];
      return entry ? { ok: true, entry, duration: result.duration } : { ok: false, error: "IMPORT_FAILED" };
    } finally {
      try { fs.rmSync(result.dir, { recursive: true, force: true }); } catch { /* 临时目录清理失败无所谓 */ }
    }
  });
  ipcMain.handle("video:cancel", async (event) => {
    if (!trusted(e)) throw Error("Forbidden");
    return video.cancel();
  });

  ipcMain.handle("image:declare", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    const kind = payload?.kind === "mix" ? "mix" : payload?.kind === "ai" ? "ai" : null;
    if (!kind) return { ok: false, error: "INVALID_INPUT" };
    const items = Array.isArray(payload?.items) ? payload.items.slice(0, 100) : [];
    const results = [];
    for (const item of items) {
      const folderId = String(item?.folderId ?? "");
      const hit = files.resolve(folderId, String(item?.id ?? ""));
      if (!hit) {
        results.push({ id: item?.id, ok: false, error: "NOT_FOUND" });
        continue;
      }
      let dir = null;
      try {
        const ext = path.extname(hit.path).slice(1).toLowerCase();
        const result = declareImage(fs.readFileSync(hit.path), ext, kind);
        if (!result.ok) {
          results.push({ id: item.id, ok: false, error: result.error });
          continue;
        }
        const base = String(hit.entry.name || "图片").replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "").slice(0, 80) || "图片";
        dir = fs.mkdtempSync(path.join(app.getPath("temp"), "openarc-declare-"));
        const out = path.join(dir, base + "（来源声明）." + ext);
        fs.writeFileSync(out, result.buffer);
        const imported = files.importPaths(folderId, [out]);
        const entry = imported.ok && imported.added && imported.added[0];
        results.push(entry ? { id: item.id, ok: true, entry, replaced: !!result.replaced } : { id: item.id, ok: false, error: "IMPORT_FAILED" });
      } catch {
        results.push({ id: item.id, ok: false, error: "INTERNAL_ERROR" });
      } finally {
        if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
    return { ok: true, results };
  });

  ipcMain.handle("system:info", async (event) => {
    if (!trusted(e)) throw Error("Forbidden");
    const os = require("node:os");
    const dataDir = app.getPath("userData");
    let disk = null;
    try {
      const stat = await fs.promises.statfs(dataDir);
      disk = { total: stat.blocks * stat.bsize, free: stat.bavail * stat.bsize };
    } catch {
      disk = null;
    }
    let used = 0;
    let count = 0;
    let truncated = false;
    const walk = async (dir) => {
      let list = [];
      try { list = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of list) {
        if (count >= 20000) { truncated = true; return; }
        count += 1;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) { try { used += (await fs.promises.stat(full)).size; } catch { /* ignore */ } }
      }
    };
    await walk(dataDir);
    return {
      ok: true,
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: uiPlatform,
      arch: process.arch,
      osRelease: os.release(),
      cpus: os.cpus().length,
      memory: os.totalmem(),
      disk,
      data: { used, truncated },
    };
  });

  const weather = createWeatherService({ fetchImpl: (url, options) => net.fetch(url, options) });
  ipcMain.handle("weather:geocode", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    return weather.geocode(String(payload?.name ?? ""));
  });
  ipcMain.handle("weather:forecast", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    return weather.forecast(payload?.lat, payload?.lon);
  });
  ipcMain.handle("files:writeText", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    return files.writeText(
      String(payload?.folderId ?? ""),
      payload?.id ? String(payload.id) : "",
      String(payload?.name ?? ""),
      typeof payload?.text === "string" ? payload.text : "",
    );
  });
  ipcMain.handle("files:read", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    return files.read(String(payload?.folderId ?? ""), String(payload?.id ?? ""));
  });

  let genericIconPng = null;
  async function genericIcon() {
    if (genericIconPng) return genericIconPng;
    try {
      const probe = path.join(app.getPath("temp"), "openarc-generic-probe.zzz");
      fs.writeFileSync(probe, "x");
      const img = await nativeImage.createThumbnailFromPath(probe, { width: 160, height: 160 });
      genericIconPng = img.toPNG();
      try { fs.unlinkSync(probe); } catch { /* 清理失败无所谓 */ }
    } catch {
      genericIconPng = Buffer.alloc(0);
    }
    return genericIconPng;
  }

  ipcMain.handle("files:thumb", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    const hit = files.resolve(String(payload?.folderId ?? ""), String(payload?.id ?? ""));
    if (!hit) return { ok: false, error: "NOT_FOUND" };
    const size = Math.min(1024, Math.max(32, Number(payload?.size) || 160));
    try {
      const img = await nativeImage.createThumbnailFromPath(hit.path, { width: size, height: size });
      if (!img || img.isEmpty()) return { ok: false, error: "NO_THUMBNAIL" };
      const png = img.toPNG();
      const generic = await genericIcon();
      if (generic.length && png.equals(generic)) return { ok: false, error: "GENERIC_ICON" };
      return { ok: true, dataUrl: "data:image/png;base64," + png.toString("base64") };
    } catch {
      return { ok: false, error: "NO_THUMBNAIL" };
    }
  });
}

module.exports = { registerFilesIpc };
