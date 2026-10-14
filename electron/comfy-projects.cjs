/**
 * B7e2 · ComfyUI 项目 / 工作流绑定（逐函数移植 server/comfyProjects.ts:1-161）。
 *
 * 逐函数对应（源文件:行号）：
 *   comfyProjects.ts:8-10    STORE_PATH / STORE_BACKUP_PATH / COVER_DIR（dataPath → 本移植的注入 dataDir）
 *   comfyProjects.ts:12-25   ComfyProject 结构
 *   comfyProjects.ts:27-35   readStore
 *   comfyProjects.ts:37-47   writeStore（先备份 .bak，临时文件 + rename）
 *   comfyProjects.ts:49-54   isRunningHubUrl
 *   comfyProjects.ts:56-63   normalizeWorkflow（nodes 校验、20MB 上限）
 *   comfyProjects.ts:65-74   coverName / removeCover
 *   comfyProjects.ts:76-86   list / get
 *   comfyProjects.ts:88-124  save
 *   comfyProjects.ts:126-142 saveCover
 *   comfyProjects.ts:144-152 getCover
 *   comfyProjects.ts:154-161 delete
 *
 * 与源文件的差异（任务书硬要求，不是行为漂移）：
 *   · 数据目录由装配注入（<userData>/dxos），不写死 dataPath；与 B5 画布 / 素材库各自独立，互不覆盖；
 *   · loadComfyConfig 可注入（默认读 <dataDir>/comfyui.json）；sharp 仅惰性 require，缺失即结构化不可用，不写入 package.json；
 *   · 对外 API 统一为 { ok:true, value } / { ok:false, error, detail }，不向 IPC 出口 throw。
 *
 * OUT（不引入）：api.dx-os.com、云发布 / 更新、云端实时房间。
 */

"use strict";

const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const path = require("node:path");

const { INTEGRATION_ERR_UNAVAILABLE, INTEGRATION_ERR_INVALID_INPUT, INTEGRATION_ERR_NOT_FOUND } = require("./plugin-registry.cjs");

const STORE_FILE_NAME = "comfy-projects.json";
const COVER_DIR_NAME = "comfy-project-covers";
const WORKFLOW_MAX_BYTES = 20 * 1024 * 1024;
const COVER_MAX_BYTES = 10 * 1024 * 1024;

const COVER_NAME_RE = /^[a-f0-9-]+\.webp$/i;
const COVER_URL_RE = /^\/api\/comfyui\/project-covers\/([a-f0-9-]+\.webp)$/i;

/** comfyProjects.ts:49-54 逐字移植。 */
function isRunningHubUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:" && /(^|\.)runninghub\.(?:ai|cn)$/i.test(parsed.hostname);
  } catch { return false; }
}

function comfyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** comfyProjects.ts:56-63 逐字移植。 */
function normalizeWorkflow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw comfyError(INTEGRATION_ERR_INVALID_INPUT, "工作流必须是 JSON 对象");
  const workflow = structuredClone(value);
  if (!Array.isArray(workflow.nodes)) throw comfyError(INTEGRATION_ERR_INVALID_INPUT, "请选择 ComfyUI 保存的普通工作流 JSON（文件中应包含 nodes）");
  if (!workflow.nodes.length) throw comfyError(INTEGRATION_ERR_INVALID_INPUT, "工作流中没有节点");
  if (JSON.stringify(workflow).length > WORKFLOW_MAX_BYTES) throw comfyError(INTEGRATION_ERR_INVALID_INPUT, "工作流文件不能超过 20MB");
  return workflow;
}

/** comfyProjects.ts:65-67 逐字移植。 */
function coverName(url) {
  return String(url || "").match(COVER_URL_RE)?.[1] || "";
}

function createComfyProjects(options = {}) {
  const dataDir = options.dataDir ? String(options.dataDir) : null;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const logger = typeof options.logger === "function" ? options.logger : null;
  const sharpLoader = typeof options.sharpLoader === "function" ? options.sharpLoader : null;
  const loadComfyConfig = typeof options.loadComfyConfig === "function"
    ? options.loadComfyConfig
    : () => {
      // 默认：读 <dataDir>/comfyui.json 的只读投影；缺失 / 坏文件按空实例处理（不落盘、不改写配置）。
      if (!dataDir) return { instances: [] };
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, "comfyui.json"), "utf8"));
        return { instances: Array.isArray(parsed && parsed.instances) ? parsed.instances : [] };
      } catch { return { instances: [] }; }
    };

  const storePath = dataDir ? path.join(dataDir, STORE_FILE_NAME) : null;
  const storeBackupPath = storePath ? storePath + ".bak" : null;
  const coverDir = dataDir ? path.join(dataDir, COVER_DIR_NAME) : null;
  let sharpCache;

  function requireSharp() {
    if (sharpCache) return sharpCache;
    try { sharpCache = sharpLoader ? sharpLoader() : require("sharp"); } catch { sharpCache = null; }
    return sharpCache;
  }

  /** comfyProjects.ts:27-35 逐字移植。 */
  function readStore() {
    if (!storePath || !fs.existsSync(storePath)) return [];
    try {
      const value = JSON.parse(fs.readFileSync(storePath, "utf8"));
      return Array.isArray(value) ? value : [];
    } catch { return []; }
  }

  /** comfyProjects.ts:37-47 逐字移植（先备份 .bak）。 */
  function writeStore(items) {
    if (!storePath) throw comfyError(INTEGRATION_ERR_UNAVAILABLE, "未配置 ComfyUI 项目数据目录");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const tempPath = storePath + "." + process.pid + "." + randomUUID() + ".tmp";
    try {
      if (fs.existsSync(storePath)) fs.copyFileSync(storePath, storeBackupPath);
      fs.writeFileSync(tempPath, JSON.stringify(items, null, 2), "utf8");
      fs.renameSync(tempPath, storePath);
    } finally {
      try { fs.rmSync(tempPath, { force: true }); } catch { /* 忽略 */ }
    }
  }

  /** comfyProjects.ts:69-74 逐字移植。 */
  function removeCover(url) {
    const filename = coverName(url);
    if (!filename || !coverDir) return;
    const target = path.join(coverDir, filename);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }

  /** comfyProjects.ts:76-79 逐字移植（ownerId 源即忽略，项目为共享视图）。 */
  function list() {
    return readStore().map(({ workflow, ...item }) => item);
  }

  /** comfyProjects.ts:81-86 逐字移植。 */
  function get(id) {
    const item = readStore().find((project) => project.id === id);
    if (!item) throw comfyError(INTEGRATION_ERR_NOT_FOUND, "ComfyUI 项目不存在");
    return item;
  }

  /** comfyProjects.ts:88-124 逐字移植。 */
  function save(input) {
    const patch = input && typeof input === "object" ? input : {};
    const items = readStore();
    const existing = patch.id ? items.find((item) => item.id === patch.id) : undefined;
    const instanceId = String(patch.instanceId || (existing && existing.instanceId) || "auto");
    const config = loadComfyConfig() || { instances: [] };
    const instance = instanceId === "auto" ? undefined : (config.instances || []).find((item) => item.id === instanceId);
    const kind = patch.kind === "runninghub" || (existing && existing.kind === "runninghub") || (instance && instance.mode === "runninghub") ? "runninghub" : "comfyui";
    // RunningHub 卡片只依赖目标网页链接。共享给其他账号后，创建者的实例 ID
    // 可能不存在于接收者配置中，不能因此阻止保存或编辑。
    if (kind !== "runninghub" && instanceId !== "auto" && !instance) throw comfyError(INTEGRATION_ERR_INVALID_INPUT, "所选实例不存在");
    const workflow = kind === "comfyui" ? normalizeWorkflow(patch.workflow != null ? patch.workflow : existing && existing.workflow) : undefined;
    let targetUrl = "";
    if (kind === "runninghub") {
      const rawTargetUrl = String(patch.targetUrl != null ? patch.targetUrl : (existing && existing.targetUrl) || "");
      if (!isRunningHubUrl(rawTargetUrl)) throw comfyError(INTEGRATION_ERR_INVALID_INPUT, "请填写有效的 RunningHub 项目页地址（支持 runninghub.ai 和 runninghub.cn）");
      targetUrl = new URL(rawTargetUrl).toString();
    }
    const now = clock();
    const project = {
      id: (existing && existing.id) || randomUUID(),
      ownerId: (existing && existing.ownerId) || "shared",
      name: String(patch.name || (existing && existing.name) || "未命名项目").trim() || "未命名项目",
      description: String(patch.description != null ? patch.description : (existing && existing.description) || "").trim(),
      coverUrl: String(patch.coverUrl != null ? patch.coverUrl : (existing && existing.coverUrl) || ""),
      instanceId,
      workflowName: String(patch.workflowName || (existing && existing.workflowName) || "workflow.json").trim() || "workflow.json",
      ...(workflow ? { workflow } : {}),
      kind,
      ...(targetUrl ? { targetUrl } : {}),
      createdAt: (existing && existing.createdAt) || now,
      updatedAt: now,
    };
    if (project.coverUrl && !coverName(project.coverUrl)) throw comfyError(INTEGRATION_ERR_INVALID_INPUT, "封面地址无效");
    if (existing) items.splice(items.indexOf(existing), 1, project);
    else items.push(project);
    writeStore(items);
    return project;
  }

  /** comfyProjects.ts:126-142 逐字移植（sharp 改为惰性 require）。 */
  async function saveCover(id, file) {
    const mime = String((file && file.mime) || "");
    const buffer = file && file.buffer;
    if (!mime.startsWith("image/")) throw comfyError(INTEGRATION_ERR_INVALID_INPUT, "封面必须是图片文件");
    if (!buffer || !buffer.length || buffer.length > COVER_MAX_BYTES) throw comfyError(INTEGRATION_ERR_INVALID_INPUT, "封面图片不能超过 10MB");
    const items = readStore();
    const project = items.find((item) => item.id === id);
    if (!project) throw comfyError(INTEGRATION_ERR_NOT_FOUND, "ComfyUI 项目不存在");
    const sharp = requireSharp();
    if (!sharp) throw comfyError(INTEGRATION_ERR_UNAVAILABLE, "sharp 未安装（惰性 require(\"sharp\") 失败），ComfyUI 项目封面无法处理；按批次约束未加入 package.json");
    if (!coverDir) throw comfyError(INTEGRATION_ERR_UNAVAILABLE, "未配置 ComfyUI 项目数据目录");
    fs.mkdirSync(coverDir, { recursive: true });
    const filename = randomUUID() + ".webp";
    await sharp(buffer).rotate().resize(1200, 675, { fit: "cover", withoutEnlargement: true }).webp({ quality: 84 }).toFile(path.join(coverDir, filename));
    const previous = project.coverUrl;
    project.coverUrl = "/api/comfyui/project-covers/" + filename;
    project.updatedAt = clock();
    writeStore(items);
    removeCover(previous);
    return project;
  }

  /** comfyProjects.ts:144-152 逐字移植。 */
  function getCover(filename) {
    if (!COVER_NAME_RE.test(String(filename || ""))) throw comfyError(INTEGRATION_ERR_NOT_FOUND, "封面不存在");
    const url = "/api/comfyui/project-covers/" + filename;
    if (!readStore().some((item) => item.coverUrl === url)) throw comfyError(INTEGRATION_ERR_NOT_FOUND, "封面不存在");
    const target = coverDir ? path.join(coverDir, filename) : null;
    if (!target || !fs.existsSync(target)) throw comfyError(INTEGRATION_ERR_NOT_FOUND, "封面不存在");
    return target;
  }

  /** comfyProjects.ts:154-161 逐字移植。 */
  function remove(id) {
    const items = readStore();
    const project = items.find((item) => item.id === id);
    if (!project) throw comfyError(INTEGRATION_ERR_NOT_FOUND, "ComfyUI 项目不存在");
    writeStore(items.filter((item) => item !== project));
    removeCover(project.coverUrl);
    return { changed: true };
  }

  /** 统一出口：内部 throw → 结构化 { ok:false, error, detail }。 */
  function wrap(fn) {
    return async (...args) => {
      try {
        const value = await fn(...args);
        return { ok: true, value };
      } catch (error) {
        const code = error && typeof error.code === "string" && error.code.startsWith("INTEGRATION_") ? error.code : INTEGRATION_ERR_INVALID_INPUT;
        if (logger) { try { logger("comfy-project-failed", { code, message: String((error && error.message) || error).slice(0, 200) }); } catch { /* 忽略 */ } }
        return { ok: false, error: code, detail: String((error && error.message) || error).slice(0, 400) };
      }
    };
  }

  const listComfyProjects = wrap(() => ({ items: list() }));
  const getComfyProject = wrap((ownerId, id) => get(id));
  const saveComfyProject = wrap((ownerId, input) => save(input));
  const saveComfyProjectCover = wrap((ownerId, id, file) => saveCover(id, file));
  const getComfyProjectCover = wrap((ownerId, filename) => ({ path: getCover(filename) }));
  const deleteComfyProject = wrap((ownerId, id) => remove(id));

  return {
    storePath,
    storeBackupPath,
    coverDir,
    readStore,
    listComfyProjects,
    getComfyProject,
    saveComfyProject,
    saveComfyProjectCover,
    getComfyProjectCover,
    deleteComfyProject,
  };
}

module.exports = {
  createComfyProjects,
  isRunningHubUrl,
  normalizeWorkflow,
  coverName,
  STORE_FILE_NAME,
  COVER_DIR_NAME,
  WORKFLOW_MAX_BYTES,
  COVER_MAX_BYTES,
};
