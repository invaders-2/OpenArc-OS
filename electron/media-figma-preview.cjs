/**
 * B5e · Figma 预览（逐函数移植自只读源 server/figmaPreview.ts:1-43）。
 *
 * 源行号：
 *   · :10     FIGMA_PREVIEW_DIR（dataPath('figma-previews')）
 *   · :12-16  safeProjectId
 *   · :18-43  buildFigmaPreview：按白名单落 source/，交给注入的 viteBuild 打包到 dist/
 *
 * 与源的差异 / 补充（任务要求"网络经注入 fetch，未注入不可用"）：
 *   · 源 :5-6 直接 import vue() 与 vite 的 build —— 重依赖，本仓改为注入 viteBuild / vuePlugin；
 *     未注入即结构化 MEDIA_DEPENDENCY_UNAVAILABLE，绝不假构建、不返回不存在的 dist。
 *   · 源没有 fetch 入口。这里补充 fetchFigmaPreviewFiles(sourceUrl)：经注入 fetchImpl 拉取
 *     { files:[{path,content}] } 清单并用同一白名单过滤；未注入 fetchImpl 即结构化不可用。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createMediaError, MEDIA_ERR_INVALID_INPUT, MEDIA_ERR_DEPENDENCY_UNAVAILABLE } = require("./media-domain.cjs");

/** 源 :28 允许落盘的文件白名单。 */
const PREVIEW_FILE_RE = /^(?:src\/[a-zA-Z0-9._-]+|index\.html|package\.json|tsconfig\.json|vite\.config\.ts)$/;

let extensions = Object.freeze({});

/** 依赖注入：{ dataDir, fetchImpl, viteBuild, vuePlugin }。 */
function configureFigmaPreview(options) {
  if (options && typeof options === "object") extensions = Object.freeze(Object.assign({}, extensions, options));
  return Object.assign({}, extensions);
}

function effective(options) { return Object.assign({}, extensions, options || {}); }

/** 源 :10 FIGMA_PREVIEW_DIR。 */
function figmaPreviewDir(options) {
  const opts = effective(options);
  if (!opts.dataDir) throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "Figma 预览目录未装配（缺少 dataDir）", "缺少 dataDir：注入后重试。");
  return path.join(opts.dataDir, "figma-previews");
}

/** 源 :12-16 safeProjectId。 */
function safeProjectId(value) {
  const id = String(value || "").trim();
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "预览项目 ID 无效");
  return id;
}

/** 源 :26-32 的落盘白名单投影（纯函数，便于离线断言）。 */
function selectPreviewFiles(files) {
  const list = Array.isArray(files) ? files : [];
  return list.flatMap((file) => {
    const normalized = String(file && file.path || "").replace(/\\/g, "/");
    if (!PREVIEW_FILE_RE.test(normalized)) return [];
    return [{ path: normalized, content: String(file && file.content || "") }];
  });
}

/** 源 :18-43 buildFigmaPreview。viteBuild/vuePlugin 未注入即结构化不可用。 */
async function buildFigmaPreview(projectId, files, options) {
  const opts = effective(options);
  const id = safeProjectId(projectId);
  if (typeof opts.viteBuild !== "function") {
    throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "Figma 预览构建器未装配（缺少 viteBuild）", "缺少 viteBuild / vuePlugin：注入 Vite 构建函数后重试。");
  }
  const projectDir = path.join(figmaPreviewDir(opts), id);
  const sourceDir = path.join(projectDir, "source");
  const distDir = path.join(projectDir, "dist");
  if (fs.existsSync(projectDir)) fs.rmSync(projectDir, { recursive: true, force: true });
  fs.mkdirSync(sourceDir, { recursive: true });

  for (const file of selectPreviewFiles(files)) {
    const target = path.join(sourceDir, ...file.path.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, "utf8");
  }

  await opts.viteBuild({
    root: sourceDir,
    base: "/api/figma/preview/" + id + "/dist/",
    configFile: false,
    plugins: typeof opts.vuePlugin === "function" ? [opts.vuePlugin()] : [],
    logLevel: "silent",
    build: { outDir: distDir, emptyOutDir: true, sourcemap: false },
  });
  return { url: "/api/figma/preview/" + id + "/dist/index.html", projectId: id };
}

/**
 * 补充入口：经注入 fetchImpl 拉取预览文件清单并解析。
 * 期望载荷 { files: [{ path, content }] }；未注入 fetchImpl / 载荷非法一律结构化失败。
 */
async function fetchFigmaPreviewFiles(sourceUrl, options) {
  const opts = effective(options);
  if (typeof opts.fetchImpl !== "function") {
    throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "拉取 Figma 预览文件需要注入 fetchImpl", "缺少 fetchImpl：注入后重试。");
  }
  const url = String(sourceUrl || "").trim();
  if (!/^https:\/\//i.test(url)) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "Figma 预览源必须是 HTTPS 地址");
  const response = await opts.fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!response || !response.ok) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "Figma 预览源请求失败：HTTP " + (response && response.status));
  let body;
  try { body = JSON.parse(await response.text()); } catch { throw createMediaError(MEDIA_ERR_INVALID_INPUT, "Figma 预览源不是合法 JSON"); }
  const files = selectPreviewFiles(body && body.files);
  if (!files.length) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "Figma 预览源没有任何可用的白名单文件");
  return { projectId: body && body.projectId ? safeProjectId(body.projectId) : null, files };
}

module.exports = {
  PREVIEW_FILE_RE,
  configureFigmaPreview,
  figmaPreviewDir,
  safeProjectId,
  selectPreviewFiles,
  buildFigmaPreview,
  fetchFigmaPreviewFiles,
};
