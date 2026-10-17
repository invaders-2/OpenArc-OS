/**
 * B5e · 短剧工坊（逐函数移植自只读源 server/shortDrama.ts:1-515）。
 *
 * 行号为源文件行号：
 *   · :10-11   数据目录 / 项目 JSON（本仓放注入的 dataDir 下）
 *   · :94-111  load / save（JSON 用 node:fs，与源一致）
 *   · :112-131 find / touch / syncProjectFile（画布文件树走注入 fsAdapter，源用 fs.ts）
 *   · :133-158 jsonFromModel / safeText / resolveModel / resolveImageModel
 *   · :160-170 imagePrompt / :172-195 persistImages
 *   · :197-226 listDramaProjects / createDramaProject
 *   · :228-267 updateDramaProject
 *   · :269-302 generateDramaOutline
 *   · :304-337 generateDramaVisualDesign
 *   · :339-355 visualDesignImagePrompt / :357-374 generateVisualReferenceImage / :376-401 editVisualReferenceImage
 *   · :403-439 generateDramaStoryboards
 *   · :441-453 addDramaShot / :455-472 updateDramaShot
 *   · :474-490 generateDramaShotImage / :492-515 editDramaShotImage
 *
 * 依赖注入：
 *   · dataDir     —— 项目 JSON 落盘目录
 *   · fsAdapter   —— B6 dxos-fs（.store 也接受）；缺 → 结构化 MEDIA_DEPENDENCY_UNAVAILABLE
 *   · fetchImpl   —— 下载模型返回的图片 URL；缺 → 结构化不可用
 *   · providerStore.firstUsableProvider(caps) —— 语言/图像模型提供方
 *   · modelGateway.callChat / generateImages / editImages —— 云模型调用面（调用方注入）
 *   · resourceRegistrar.registerBuffer —— 出图落盘后同时登记进 OpenArc 资源库（调用方注入；
 *     未注入时画面仍落 fs，但资源 ref 如实为 null，绝不假装已登记）
 *   · resourceContext —— 资源登记所需的可信 sessionRef / appId（由 media-service 从 IPC 上下文传入）
 *
 * 与既有 B5a 渲染对接（编排为本仓新增，源没有该函数）：
 *   buildDramaTimeline(project) 把"已就绪分镜图"顺序编排成 media-domain 认可的
 *   Timeline V1；submitDramaRender 经注入 renderSubmit（默认 mediaStore.createVideoRenderJob）
 *   提交，绝不伪造完成。
 *
 * 云与商业化 OUT 逐条注明：
 *   · 源 :7   protocols.ts 的 callChat / generateImages / editImages —— 真实模型云调用，
 *             本仓只保留注入点，未注入即结构化不可用
 *   · 源 :8   store.ts firstUsableProvider —— 同上，注入面
 *   · 源 :182-185 生成图 URL 远程下载 —— 走注入 fetchImpl，未注入不可用
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const mediaDomain = require("./media-domain.cjs");
const { createMediaError, MEDIA_ERR_INVALID_INPUT, MEDIA_ERR_NOT_FOUND, MEDIA_ERR_CONFLICT, MEDIA_ERR_DEPENDENCY_UNAVAILABLE } = mediaDomain;

const DRAMA_STAGES = Object.freeze(["script", "design", "storyboard", "generate", "timeline"]);
const DEFAULT_CANVAS = Object.freeze({ width: 1080, height: 1920, fps: 30 });

let extensions = Object.freeze({});

/** 依赖注入：{ dataDir, fsAdapter, fetchImpl, providerStore, modelGateway, mediaStore, clock, logger }。 */
function configureShortDrama(options) {
  if (options && typeof options === "object") extensions = Object.freeze(Object.assign({}, extensions, options));
  return Object.assign({}, extensions);
}

function effective(options) {
  return Object.assign({}, extensions, options || {});
}

function projectFile(options) {
  const opts = effective(options);
  if (typeof opts.file === "string" && opts.file) return opts.file;
  if (!opts.dataDir) throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "短剧数据目录未装配（缺少 dataDir）", "缺少 dataDir：注入短剧数据目录后重试。");
  return path.join(opts.dataDir, "short-drama-projects.json");
}

/** 源 :6 fs.ts 的注入面；适配器的 .store 也接受。缺任一函数即结构化不可用。 */
function fsPort(options) {
  const opts = effective(options);
  const adapter = opts.fsAdapter;
  if (!adapter || typeof adapter !== "object") {
    throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "短剧画布文件系统未装配（缺少 fsAdapter）", "缺少 fsAdapter：注入 B6 dxos-fs 适配器后重试。");
  }
  const store = adapter.store && typeof adapter.store === "object" ? Object.assign({}, adapter.store, adapter) : adapter;
  const names = ["getNode", "isInTrash", "listChildren", "findByPath", "ensureFolder", "createNode", "setContent", "renameNode", "saveBlob", "readBlob", "ensureCanvasRoot"];
  const port = {};
  const missing = [];
  for (const name of names) {
    if (typeof store[name] === "function") port[name] = store[name].bind(store);
    else missing.push(name);
  }
  if (missing.length) {
    throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "短剧画布文件系统能力缺失：" + missing.join(", "), "缺少 fsAdapter 方法：" + missing.join(", "));
  }
  return port;
}

/** 源 :94-107 load。 */
function load(options) {
  const opts = effective(options);
  try {
    const items = JSON.parse(fs.readFileSync(projectFile(opts), "utf8"));
    return Array.isArray(items) ? items.map((item) => ({
      ...item,
      shots: Array.isArray(item.shots) ? item.shots.map((shot) => ({ ...shot, characterIds: Array.isArray(shot.characterIds) ? shot.characterIds : [], images: Array.isArray(shot.images) ? shot.images : [] })) : [],
      visualDesign: item.visualDesign ? {
        ...item.visualDesign,
        characters: Array.isArray(item.visualDesign.characters) ? item.visualDesign.characters.map((character) => ({ ...character, images: Array.isArray(character.images) ? character.images : [] })) : [],
        locations: Array.isArray(item.visualDesign.locations) ? item.visualDesign.locations.map((location) => ({ ...location, images: Array.isArray(location.images) ? location.images : [] })) : [],
      } : undefined,
    })) : [];
  } catch { return []; }
}

/** 源 :108-111 save。 */
function save(projects, options) {
  const opts = effective(options);
  const file = projectFile(opts);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(projects, null, 2), "utf8");
}

/** 源 :112-118 find。 */
function find(projects, id, options) {
  const project = projects.find((item) => item.id === id);
  if (!project) throw createMediaError(MEDIA_ERR_NOT_FOUND, "项目不存在");
  const port = fsPort(options);
  const folder = port.getNode(project.folderId);
  if (!folder || port.isInTrash(project.folderId)) throw createMediaError(MEDIA_ERR_CONFLICT, "项目文件夹已删除，请先从废纸篓恢复");
  return project;
}

/** 源 :119 touch。 */
function touch(project, options) {
  project.updatedAt = (effective(options).clock || (() => Date.now()))();
}

/** 源 :121-131 syncProjectFile。 */
function syncProjectFile(project, relPath, content, options) {
  const port = fsPort(options);
  const existing = port.findByPath(project.folderId, relPath);
  if (existing) port.setContent(existing.id, content);
  else {
    const parts = relPath.split("/");
    const name = parts.pop() || "untitled.txt";
    let parentId = project.folderId;
    for (const part of parts) parentId = port.ensureFolder(part, parentId);
    port.createNode({ name, type: "file", parentId, content });
  }
}

/** 源 :133-139 jsonFromModel。 */
function jsonFromModel(text) {
  const trimmed = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "模型没有返回可识别的项目数据");
  try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { throw createMediaError(MEDIA_ERR_INVALID_INPUT, "模型返回的项目数据格式不正确，请重试"); }
}

/** 源 :141 safeText。 */
function safeText(value, limit) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit); }

/** 源 :143-158 resolveModel / resolveImageModel；providerStore 未注入即结构化不可用。 */
function resolveByCaps(caps, options) {
  const opts = effective(options);
  const store = opts.providerStore;
  if (!store || typeof store.firstUsableProvider !== "function") {
    throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "模型提供方服务未装配（缺少 providerStore）", "缺少 providerStore.firstUsableProvider：注入后重试。");
  }
  const provider = store.firstUsableProvider(caps);
  if (!provider) throw createMediaError(MEDIA_ERR_INVALID_INPUT, caps === "llm"
    ? "请先在「系统设置 › 模型与服务商」中配置并启用一个语言模型，再使用 AI 生产流程。"
    : "请先在「系统设置 › 模型与服务商」中配置并启用一个图像模型，再生成分镜图。");
  return provider;
}

function resolveModel(options) {
  const provider = resolveByCaps("llm", options);
  const entry = provider.models.find((item) => item.caps.includes("llm"));
  const model = entry && entry.model;
  if (!model) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "当前语言模型站点没有可用模型。");
  return { provider, model, resolved: { id: provider.id, base_url: provider.base_url, api_key: provider.api_key, protocol: provider.protocol } };
}

function resolveImageModel(options) {
  const provider = resolveByCaps("image", options);
  const entry = provider.models.find((item) => item.caps.includes("image"));
  const model = entry && entry.model;
  if (!model) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "当前图像站点没有可用图像模型。");
  return { provider, model, resolved: { id: provider.id, base_url: provider.base_url, api_key: provider.api_key, protocol: entry.protocol || provider.protocol } };
}

/** 源 :7 protocols.ts 的注入面（云调用 OUT，只保留注入点）。 */
function modelGateway(options) {
  const opts = effective(options);
  const gateway = opts.modelGateway;
  if (!gateway || typeof gateway !== "object") {
    throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "模型网关未装配（缺少 modelGateway）", "缺少 modelGateway.callChat / generateImages / editImages：注入后重试。");
  }
  return gateway;
}

/** 源 :160-170 imagePrompt。 */
function imagePrompt(project, shot) {
  const visual = project.visualDesign;
  const characterGuide = visual ? visual.characters.map((item) => item.name + "：" + item.appearance + "；服装：" + item.costume).join("\n") : "";
  return [
    "竖屏短剧高质量分镜关键帧，9:16 画幅，电影感构图，人物与服装在后续镜头中必须保持一致。",
    visual && visual.style ? "总体影像风格：" + visual.style : "",
    characterGuide ? "角色造型参考：\n" + characterGuide : "",
    "镜头名称：" + shot.title, shot.scene ? "场景：" + shot.scene : "", "画面要求：" + shot.prompt,
    "不要添加文字、水印、logo、边框或拼贴画面。",
  ].filter(Boolean).join("\n\n");
}

/**
 * 出图落盘后登记资源库。registrar 未注入 → unavailable（不伪造已登记）；
 * 登记失败 → failed + 错误码，但已落盘的画面保留（不因资源库故障丢素材）。
 */
async function registerImageResource(opts, { buffer, name, mime, prompt }) {
  const registrar = opts.resourceRegistrar;
  if (!registrar || typeof registrar.registerBuffer !== "function") return { status: "unavailable" };
  const generatedModel = typeof opts.generatedModel === "string" ? opts.generatedModel : null;
  let result;
  try {
    result = await registrar.registerBuffer({
      context: opts.resourceContext && typeof opts.resourceContext === "object" ? opts.resourceContext : null,
      buffer,
      name,
      mime,
      description: prompt,
      resourceType: "image",
      generated: generatedModel ? { model: generatedModel } : null,
    });
  } catch (error) {
    return { status: "failed", error: String((error && error.code) || "RESOURCE_REGISTER_FAILED") };
  }
  if (result && result.ok === true) {
    return {
      status: result.dedupe === true ? "deduped" : "registered",
      resourceId: result.resourceId == null ? null : String(result.resourceId),
      resourceRef: result.resourceRef == null ? null : String(result.resourceRef),
    };
  }
  return { status: "failed", error: String((result && result.error) || "RESOURCE_REGISTER_FAILED") };
}

/** 源 :172-195 persistImages。 */
async function persistImages(project, owner, label, images, prompt, kind, folderName, options) {
  const opts = effective(options);
  const port = fsPort(opts);
  const assetsId = project.folders.assets || port.ensureFolder("assets", project.folderId);
  project.folders.assets = assetsId;
  const frameFolder = port.ensureFolder(folderName || "frames", assetsId);
  const saved = [];
  for (const [index, image] of images.entries()) {
    let buf;
    let mime = "image/png";
    if (image.type === "b64") buf = Buffer.from(image.value, "base64");
    else {
      const fetchImpl = opts.fetchImpl;
      if (typeof fetchImpl !== "function") {
        throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "下载生成图片需要注入 fetchImpl", "缺少 fetchImpl：注入后重试。");
      }
      const response = await fetchImpl(image.value);
      if (!response.ok) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "下载生成图片失败：HTTP " + response.status);
      mime = (response.headers.get("content-type") || "").split(";")[0].trim() || mime;
      buf = Buffer.from(await response.arrayBuffer());
    }
    const extension = mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
    const node = port.createNode({ name: (label.replace(/[\\/:*?"<>|]/g, "_").slice(0, 30) || "image") + "-" + Date.now() + "-" + (index + 1) + "." + extension, type: "file", parentId: frameFolder, mime, size: buf.length });
    port.saveBlob(node.id, buf);
    const registration = await registerImageResource(opts, { buffer: buf, name: node.name, mime, prompt });
    saved.push({
      id: randomUUID(), nodeId: node.id, url: "/api/fs/raw/" + node.id, prompt, kind,
      createdAt: (opts.clock || (() => Date.now()))(),
      resourceRef: registration.resourceRef || null,
      resourceId: registration.resourceId || null,
      resourceStatus: registration.status,
      ...(registration.error ? { resourceError: registration.error } : {}),
    });
  }
  owner.images.push(...saved);
  owner.selectedImageId = saved.at(-1) ? saved.at(-1).id : owner.selectedImageId;
  return saved;
}

/** 源 :197-201 listDramaProjects。 */
function listDramaProjects(options) {
  const opts = effective(options);
  const port = fsPort(opts);
  return load(opts)
    .filter((project) => !!port.getNode(project.folderId) && !port.isInTrash(project.folderId))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 10-16 · 读取短剧项目里的一张画面（分镜图 / 角色与场景参考图），给 OpenArc 前端显示用。
 * 只读、有界：nodeId 必须被这个项目的 shots / visualDesign 引用（不开放任意虚拟文件读取），≤ 12 MB。
 */
function readDramaImage(id, nodeId, options) {
  const opts = effective(options);
  const project = find(load(opts), id, opts);
  const wanted = String(nodeId || "");
  const refs = new Set();
  for (const shot of project.shots || []) for (const image of shot.images || []) if (image && image.nodeId) refs.add(String(image.nodeId));
  const design = project.visualDesign || {};
  for (const item of [...(design.characters || []), ...(design.locations || [])]) for (const image of item.images || []) if (image && image.nodeId) refs.add(String(image.nodeId));
  if (!wanted || !refs.has(wanted)) throw createMediaError(MEDIA_ERR_NOT_FOUND, "画面不属于这个项目");
  const port = fsPort(opts);
  const node = port.getNode(wanted);
  if (!node || port.isInTrash(wanted)) throw createMediaError(MEDIA_ERR_NOT_FOUND, "画面已不存在");
  const buf = port.readBlob(wanted);
  if (!buf || !buf.length) throw createMediaError(MEDIA_ERR_NOT_FOUND, "画面内容缺失");
  if (buf.length > 12 * 1024 * 1024) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "画面过大，无法预览");
  const mime = typeof node.mime === "string" && node.mime.startsWith("image/") ? node.mime : "image/png";
  return { nodeId: wanted, mime, bytes: buf.length, dataUrl: "data:" + mime + ";base64," + Buffer.from(buf).toString("base64") };
}

/**
 * 10-16 · 前端视图：单个项目 + 拍平的画面索引。
 * IPC 返回值经 foundation 脱敏，嵌套深度封顶 6（项目 → 镜头 → 画面 → 字段 已超）：
 * 画面一律拍平到 images[]，各处只留 selectedImageId / imageCount，不靠深层嵌套传数据。
 */
function getDramaProjectView(id, options) {
  const opts = effective(options);
  const project = find(load(opts), id, opts);
  const images = [];
  const pushAll = (owner, ownerId, list) => {
    for (const image of list || []) if (image && image.nodeId != null) images.push({
      owner, ownerId, id: image.id, nodeId: String(image.nodeId), kind: image.kind || null, createdAt: image.createdAt || null,
      resourceRef: image.resourceRef || null, resourceId: image.resourceId || null, resourceStatus: image.resourceStatus || "unavailable",
    });
  };
  const shots = (project.shots || []).map((shot) => {
    pushAll("shot", shot.id, shot.images);
    const { images: _drop, ...rest } = shot;
    return { ...rest, characterIds: Array.isArray(shot.characterIds) ? shot.characterIds.join(",") : "", imageCount: (shot.images || []).length };
  });
  const design = project.visualDesign || null;
  const flatItems = (kind, list) => (list || []).map((item) => {
    pushAll(kind, item.id, item.images);
    const { images: _drop, ...rest } = item;
    return { ...rest, imageCount: (item.images || []).length };
  });
  const blueprint = project.blueprint
    ? { ...project.blueprint, episodes: (project.blueprint.episodes || []).map((e) => ({ ...e, characterNames: (e.characterNames || []).join("、"), locationNames: (e.locationNames || []).join("、") })) }
    : null;
  return {
    project: {
      id: project.id, name: project.name, stage: project.stage, sourceText: project.sourceText || "",
      createdAt: project.createdAt, updatedAt: project.updatedAt,
      blueprint,
      visualDesign: design ? { style: design.style || "", provider: design.provider || null, model: design.model || null, characters: flatItems("character", design.characters), locations: flatItems("location", design.locations) } : null,
      shots,
    },
    images,
  };
}

/** 源 :203-226 createDramaProject。 */
function createDramaProject(name, ownerId, options) {
  const opts = effective(options);
  const port = fsPort(opts);
  const title = String(name || "").trim().slice(0, 50);
  if (!title) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "请输入项目名称");
  const appRoot = ownerId ? port.ensureCanvasRoot(ownerId).id : null;
  const appFolders = appRoot ? port.listChildren(appRoot).nodes.filter((node) => node.type === "folder") : [];
  const legacyRoot = appFolders.find((node) => node.name === "短剧项目");
  if (legacyRoot && !appFolders.some((node) => node.name === "短剧工坊")) port.renameNode(legacyRoot.id, "短剧工坊");
  const projectsRoot = port.ensureFolder("短剧工坊", appRoot, ownerId);
  const folderId = port.ensureFolder(title, projectsRoot, ownerId);
  const folders = {
    inputs: port.ensureFolder("inputs", folderId, ownerId),
    scripts: port.ensureFolder("scripts", folderId, ownerId),
    assets: port.ensureFolder("assets", folderId, ownerId),
    episodes: port.ensureFolder("episodes", folderId, ownerId),
    renders: port.ensureFolder("renders", folderId, ownerId),
  };
  const createdAt = (opts.clock || (() => Date.now()))();
  const project = { id: randomUUID(), name: title, folderId, folders, createdAt, updatedAt: createdAt, stage: "script", sourceText: "", shots: [] };
  port.createNode({ name: "project.json", type: "file", parentId: folderId, content: JSON.stringify({ version: 1, projectId: project.id, name: project.name, createdAt }, null, 2) });
  const projects = load(opts);
  projects.push(project);
  save(projects, opts);
  return project;
}

/** 源 :228-267 updateDramaProject。 */
function updateDramaProject(id, patch, options) {
  const opts = effective(options);
  const projects = load(opts);
  const project = find(projects, id, opts);
  if (patch.stage && DRAMA_STAGES.includes(patch.stage)) project.stage = patch.stage;
  if (typeof patch.sourceText === "string") {
    project.sourceText = patch.sourceText.slice(0, 200000);
    syncProjectFile(project, "scripts/source-script.txt", project.sourceText, opts);
  }
  if (patch.blueprint && typeof patch.blueprint === "object") {
    const source = patch.blueprint;
    const episodes = Array.isArray(source.episodes) ? source.episodes.slice(0, 30).map((entry, index) => ({
      id: entry && typeof entry.id === "string" ? entry.id : randomUUID(),
      number: index + 1,
      title: safeText(entry && entry.title, 60) || "第 " + (index + 1) + " 集",
      summary: safeText(entry && entry.summary, 900),
      hook: safeText(entry && entry.hook, 300),
      characterNames: Array.isArray(entry && entry.characterNames) ? entry.characterNames.slice(0, 20).map((n) => safeText(n, 60)).filter(Boolean) : [],
      locationNames: Array.isArray(entry && entry.locationNames) ? entry.locationNames.slice(0, 20).map((n) => safeText(n, 80)).filter(Boolean) : [],
    })) : [];
    project.blueprint = { logline: safeText(source.logline, 500), tone: safeText(source.tone, 300), episodes, generatedAt: (project.blueprint && project.blueprint.generatedAt) || (opts.clock || (() => Date.now()))(), provider: (project.blueprint && project.blueprint.provider) || "手动编辑", model: (project.blueprint && project.blueprint.model) || "手动编辑" };
    syncProjectFile(project, "scripts/story-blueprint.json", JSON.stringify(project.blueprint, null, 2), opts);
  }
  if (patch.visualDesign && typeof patch.visualDesign === "object") {
    const source = patch.visualDesign;
    const existingCharacters = new Map((project.visualDesign && project.visualDesign.characters || []).map((entry) => [entry.id, entry]));
    const existingLocations = new Map((project.visualDesign && project.visualDesign.locations || []).map((entry) => [entry.id, entry]));
    const characters = Array.isArray(source.characters) ? source.characters.slice(0, 20).map((entry) => {
      const charId = entry && typeof entry.id === "string" ? entry.id : randomUUID();
      const previous = existingCharacters.get(charId);
      return { id: charId, name: safeText(entry && entry.name, 60) || "未命名角色", role: safeText(entry && entry.role, 180), appearance: safeText(entry && entry.appearance, 700), costume: safeText(entry && entry.costume, 700), signature: safeText(entry && entry.signature, 300), images: (previous && previous.images) || [], selectedImageId: previous && previous.selectedImageId };
    }) : [];
    const locations = Array.isArray(source.locations) ? source.locations.slice(0, 20).map((entry) => {
      const locId = entry && typeof entry.id === "string" ? entry.id : randomUUID();
      const previous = existingLocations.get(locId);
      return { id: locId, name: safeText(entry && entry.name, 80) || "未命名场景", atmosphere: safeText(entry && entry.atmosphere, 400), visual: safeText(entry && entry.visual, 700), props: safeText(entry && entry.props, 400), images: (previous && previous.images) || [], selectedImageId: previous && previous.selectedImageId };
    }) : [];
    project.visualDesign = { style: safeText(source.style, 700), characters, locations, generatedAt: (project.visualDesign && project.visualDesign.generatedAt) || (opts.clock || (() => Date.now()))(), provider: (project.visualDesign && project.visualDesign.provider) || "手动编辑", model: (project.visualDesign && project.visualDesign.model) || "手动编辑" };
    syncProjectFile(project, "assets/visual-bible.json", JSON.stringify(project.visualDesign, null, 2), opts);
  }
  touch(project, opts);
  save(projects, opts);
  return project;
}

/** 源 :269-302 generateDramaOutline。 */
async function generateDramaOutline(id, episodeCount, options) {
  const opts = effective(options);
  const projects = load(opts);
  const project = find(projects, id, opts);
  const source = project.sourceText.trim();
  if (source.length < 30) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "请先输入至少一段剧情素材，再开始 AI 拆解。");
  const count = Math.max(1, Math.min(30, Number(episodeCount) || 8));
  const { provider, model, resolved } = resolveModel(opts);
  const prompt = [
    "你是一名成熟的竖屏短剧总编剧。根据用户提供的原始素材，设计适合连续生产的短剧蓝图。",
    "规划 " + count + " 集，每集必须有明确的冲突升级和结尾钩子。不要编造用户没有给出的关键人物关系。",
    "只输出 JSON，不要 Markdown。结构必须是：{\"logline\":\"一句话卖点\",\"tone\":\"视觉与叙事基调\",\"episodes\":[{\"number\":1,\"title\":\"集名\",\"summary\":\"本集剧情\",\"hook\":\"结尾钩子\",\"characterNames\":[\"本集出场角色\"],\"locationNames\":[\"本集场景\"]}]}。",
    "原始素材：\n" + source.slice(0, 80000),
  ].join("\n\n");
  const response = await modelGateway(opts).callChat(resolved, model, { prompt }, { temperature: 0.65, max_tokens: 6000 }, 180000);
  const data = jsonFromModel(response.text);
  const rawEpisodes = Array.isArray(data.episodes) ? data.episodes : [];
  if (!rawEpisodes.length) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "模型没有生成分集内容，请重试或补充更具体的素材。");
  const episodes = rawEpisodes.slice(0, count).map((item, index) => {
    const row = item && typeof item === "object" ? item : {};
    return {
      id: randomUUID(), number: index + 1,
      title: safeText(row.title, 60) || "第 " + (index + 1) + " 集",
      summary: safeText(row.summary, 900), hook: safeText(row.hook, 300),
      characterNames: Array.isArray(row.characterNames) ? row.characterNames.slice(0, 20).map((n) => safeText(n, 60)).filter(Boolean) : [],
      locationNames: Array.isArray(row.locationNames) ? row.locationNames.slice(0, 20).map((n) => safeText(n, 80)).filter(Boolean) : [],
    };
  });
  project.blueprint = { logline: safeText(data.logline, 500), tone: safeText(data.tone, 300), episodes, generatedAt: (opts.clock || (() => Date.now()))(), provider: provider.name, model };
  project.stage = "design";
  touch(project, opts);
  syncProjectFile(project, "scripts/story-blueprint.json", JSON.stringify(project.blueprint, null, 2), opts);
  save(projects, opts);
  return project;
}

/** 源 :304-337 generateDramaVisualDesign。 */
async function generateDramaVisualDesign(id, options) {
  const opts = effective(options);
  const projects = load(opts);
  const project = find(projects, id, opts);
  if (!project.blueprint || !project.blueprint.episodes.length) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "请先完成剧本拆解，生成分集集纲。");
  const { provider, model, resolved } = resolveModel(opts);
  const prompt = [
    "你是短剧的美术指导、服装造型师和场景设计师。根据项目蓝图制定一份可直接交给分镜和图像生成的视觉设定。",
    "设计必须保持跨集一致性，服装要能区分人物身份与阵营；场景要注明氛围、空间结构、光线、主色和反复出现的关键道具。",
    "只输出 JSON，不要 Markdown。结构必须为：{\"style\":\"总体影像风格\",\"characters\":[{\"name\":\"人物名\",\"role\":\"身份与戏剧功能\",\"appearance\":\"年龄感、体态、五官、发型等外观\",\"costume\":\"主服装、材质、配色、随剧情变化\",\"signature\":\"辨识道具或动作细节\"}],\"locations\":[{\"name\":\"场景名\",\"atmosphere\":\"氛围、光线、色调\",\"visual\":\"空间、建筑、景别与画面要点\",\"props\":\"关键道具与陈设\"}]}。",
    "故事卖点：" + project.blueprint.logline + "\n叙事基调：" + project.blueprint.tone + "\n集纲：" + JSON.stringify(project.blueprint.episodes.slice(0, 8)),
  ].join("\n\n");
  const response = await modelGateway(opts).callChat(resolved, model, { prompt }, { temperature: 0.65, max_tokens: 7000 }, 180000);
  const data = jsonFromModel(response.text);
  const rawCharacters = Array.isArray(data.characters) ? data.characters : [];
  const rawLocations = Array.isArray(data.locations) ? data.locations : [];
  if (!rawCharacters.length && !rawLocations.length) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "模型没有生成可用的视觉设定，请重试。");
  project.visualDesign = {
    style: safeText(data.style, 700),
    characters: rawCharacters.slice(0, 12).map((item) => {
      const row = item && typeof item === "object" ? item : {};
      return { id: randomUUID(), name: safeText(row.name, 60) || "未命名角色", role: safeText(row.role, 180), appearance: safeText(row.appearance, 700), costume: safeText(row.costume, 700), signature: safeText(row.signature, 300), images: [] };
    }),
    locations: rawLocations.slice(0, 12).map((item) => {
      const row = item && typeof item === "object" ? item : {};
      return { id: randomUUID(), name: safeText(row.name, 80) || "未命名场景", atmosphere: safeText(row.atmosphere, 400), visual: safeText(row.visual, 700), props: safeText(row.props, 400), images: [] };
    }),
    generatedAt: (opts.clock || (() => Date.now()))(), provider: provider.name, model,
  };
  project.stage = "storyboard";
  touch(project, opts);
  syncProjectFile(project, "assets/visual-bible.json", JSON.stringify(project.visualDesign, null, 2), opts);
  save(projects, opts);
  return project;
}

/** 源 :339-355 visualDesignImagePrompt。 */
function visualDesignImagePrompt(project, kind, item) {
  const style = (project.visualDesign && project.visualDesign.style) || "高质量竖屏短剧，电影感写实影像";
  if (kind === "character") {
    return [
      "竖屏短剧角色服化道设定图，单人全身，干净的角色概念展示，写实电影质感，9:16 画幅。",
      "项目视觉风格：" + style, "角色：" + item.name + "，" + item.role, "外观：" + item.appearance, "服装：" + item.costume, "辨识细节：" + item.signature,
      "保持人物形象稳定，不要文字、水印、logo、拼贴或多余人物。",
    ].filter(Boolean).join("\n\n");
  }
  return [
    "竖屏短剧场景概念图，空镜或少量远景人物，电影感写实影像，9:16 画幅。",
    "项目视觉风格：" + style, "场景：" + item.name, "氛围与光线：" + item.atmosphere, "空间与画面：" + item.visual, "关键道具：" + item.props,
    "不要文字、水印、logo、边框或拼贴画面。",
  ].filter(Boolean).join("\n\n");
}

function visualReferenceManifest(design) {
  return JSON.stringify({
    characters: design.characters.map((entry) => ({ id: entry.id, name: entry.name, selectedImageId: entry.selectedImageId, images: entry.images })),
    locations: design.locations.map((entry) => ({ id: entry.id, name: entry.name, selectedImageId: entry.selectedImageId, images: entry.images })),
  }, null, 2);
}

/** 源 :357-374 generateVisualReferenceImage。 */
async function generateVisualReferenceImage(id, kind, itemId, options) {
  const opts = effective(options);
  const projects = load(opts);
  const project = find(projects, id, opts);
  const design = project.visualDesign;
  if (!design) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "请先生成视觉设定。");
  const items = kind === "character" ? design.characters : design.locations;
  const item = items.find((entry) => entry.id === itemId);
  if (!item) throw createMediaError(MEDIA_ERR_NOT_FOUND, kind === "character" ? "角色不存在" : "场景不存在");
  const { provider, model, resolved } = resolveImageModel(opts);
  const prompt = visualDesignImagePrompt(project, kind, item);
  const { images } = await modelGateway(opts).generateImages(resolved, model, { prompt, size: "1024x1536", n: 1 }, 300000);
  if (!images.length) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "图像模型未返回图片。");
  await persistImages(project, item, item.name, images, prompt, "generated", kind === "character" ? "character-designs" : "location-designs", Object.assign({}, opts, { generatedModel: model }));
  touch(project, opts);
  syncProjectFile(project, "assets/visual-reference-manifest.json", visualReferenceManifest(design), opts);
  save(projects, opts);
  return { project, provider: provider.name, model };
}

/** 源 :376-401 editVisualReferenceImage。 */
async function editVisualReferenceImage(id, kind, itemId, imageId, instruction, options) {
  const opts = effective(options);
  const projects = load(opts);
  const project = find(projects, id, opts);
  const design = project.visualDesign;
  if (!design) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "请先生成视觉设定。");
  const items = kind === "character" ? design.characters : design.locations;
  const item = items.find((entry) => entry.id === itemId);
  if (!item) throw createMediaError(MEDIA_ERR_NOT_FOUND, kind === "character" ? "角色不存在" : "场景不存在");
  const source = item.images.find((entry) => entry.id === imageId);
  if (!source) throw createMediaError(MEDIA_ERR_NOT_FOUND, "找不到要修改的图片版本。");
  const note = String(instruction || "").trim().slice(0, 3000);
  if (!note) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "请说明希望怎样修改图片。");
  const port = fsPort(opts);
  const node = port.getNode(source.nodeId);
  const buf = port.readBlob(source.nodeId);
  if (!node || !buf) throw createMediaError(MEDIA_ERR_NOT_FOUND, "原始图片文件不存在，无法修改。");
  const { provider, model, resolved } = resolveImageModel(opts);
  const prompt = visualDesignImagePrompt(project, kind, item) + "\n\n基于参考图修改：" + note + "\n保持未要求变化的角色设定、服装、场景和整体风格一致。";
  const { images } = await modelGateway(opts).editImages(resolved, model, { prompt, size: "1024x1536", n: 1 }, [{ buf, mime: node.mime || "image/png", name: node.name || "reference.png" }], 300000);
  if (!images.length) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "图像模型未返回修改后的图片。");
  await persistImages(project, item, item.name, images, prompt, "edited", kind === "character" ? "character-designs" : "location-designs", Object.assign({}, opts, { generatedModel: model }));
  touch(project, opts);
  syncProjectFile(project, "assets/visual-reference-manifest.json", visualReferenceManifest(design), opts);
  save(projects, opts);
  return { project, provider: provider.name, model };
}

/** 源 :403-439 generateDramaStoryboards。 */
async function generateDramaStoryboards(id, episodeId, options) {
  const opts = effective(options);
  const projects = load(opts);
  const project = find(projects, id, opts);
  if (!project.blueprint || !project.blueprint.episodes.length) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "请先完成剧本拆解，生成分集集纲。");
  if (!project.visualDesign) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "请先完成角色、服化道与场景的视觉设定。");
  const { provider, model, resolved } = resolveModel(opts);
  const targetEpisodes = episodeId ? project.blueprint.episodes.filter((episode) => episode.id === episodeId) : project.blueprint.episodes;
  if (!targetEpisodes.length) throw createMediaError(MEDIA_ERR_NOT_FOUND, "指定分集不存在。");
  const prompt = [
    "你是短剧分镜导演。根据下列项目蓝图，为" + (episodeId ? "指定的单集" : "全部剧集") + "分别设计 4 到 8 个适合生成图像和视频的关键镜头。",
    "每个镜头应独立、画面明确，持续 3 到 10 秒。prompt 必须是中文画面描述，含人物、场景、动作、镜头语言与光线，不要出现品牌或技术说明。",
    "只输出 JSON，不要 Markdown。结构：{\"shots\":[{\"episodeNumber\":1,\"title\":\"镜头名\",\"scene\":\"场景\",\"script\":\"本镜头台词或动作脚本\",\"characterNames\":[\"出场角色\"],\"prompt\":\"画面提示词\",\"duration\":5}]}。",
    "故事卖点：" + project.blueprint.logline + "\n基调：" + project.blueprint.tone + "\n角色与场景视觉设定：" + JSON.stringify(project.visualDesign) + "\n目标集纲：" + JSON.stringify(targetEpisodes),
  ].join("\n\n");
  const response = await modelGateway(opts).callChat(resolved, model, { prompt }, { temperature: 0.7, max_tokens: 7000 }, 180000);
  const data = jsonFromModel(response.text);
  const rawShots = Array.isArray(data.shots) ? data.shots : [];
  if (!rawShots.length) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "模型没有生成可用分镜，请重试。");
  const generatedShots = rawShots.slice(0, episodeId ? 12 : 120).map((item, index) => {
    const row = item && typeof item === "object" ? item : {};
    const episodeNumber = Math.max(1, Number(row.episodeNumber) || targetEpisodes[0].number);
    const episode = targetEpisodes.find((entry) => entry.number === episodeNumber) || targetEpisodes[0];
    const names = Array.isArray(row.characterNames) ? row.characterNames.map((name) => safeText(name, 60)).filter(Boolean) : [];
    const characterIds = (project.visualDesign && project.visualDesign.characters || []).filter((character) => names.includes(character.name)).map((character) => character.id);
    return {
      id: randomUUID(), episodeId: episode.id, title: safeText(row.title, 80) || "镜头 " + (index + 1),
      scene: safeText(row.scene, 120), script: safeText(row.script, 4000), characterIds, prompt: safeText(row.prompt, 10000),
      duration: Math.max(1, Math.min(30, Number(row.duration) || 5)), imageStatus: "idle", videoStatus: "idle", images: [],
    };
  });
  project.shots = episodeId ? [...project.shots.filter((shot) => shot.episodeId !== episodeId), ...generatedShots] : generatedShots;
  project.stage = "storyboard";
  touch(project, opts);
  syncProjectFile(project, "episodes/storyboards.json", JSON.stringify(project.shots, null, 2), opts);
  save(projects, opts);
  return project;
}

/** 源 :441-453 addDramaShot。 */
function addDramaShot(id, input, options) {
  const opts = effective(options);
  const projects = load(opts);
  const project = find(projects, id, opts);
  const shot = {
    id: randomUUID(), episodeId: typeof input.episodeId === "string" ? input.episodeId : undefined,
    title: String(input.title || "镜头 " + (project.shots.length + 1)).trim().slice(0, 80),
    scene: String(input.scene || "").trim().slice(0, 120), script: String(input.script || "").trim().slice(0, 4000),
    characterIds: Array.isArray(input.characterIds) ? input.characterIds.slice(0, 20) : [],
    prompt: String(input.prompt || "").trim().slice(0, 10000),
    duration: Math.max(1, Math.min(30, Number(input.duration) || 5)), imageStatus: "idle", videoStatus: "idle", images: [],
  };
  project.shots.push(shot);
  touch(project, opts);
  save(projects, opts);
  return shot;
}

/** 源 :455-472 updateDramaShot。 */
function updateDramaShot(id, shotId, patch, options) {
  const opts = effective(options);
  const projects = load(opts);
  const project = find(projects, id, opts);
  const shot = project.shots.find((item) => item.id === shotId);
  if (!shot) throw createMediaError(MEDIA_ERR_NOT_FOUND, "分镜不存在");
  if (typeof patch.title === "string") shot.title = patch.title.slice(0, 80);
  if (typeof patch.scene === "string") shot.scene = patch.scene.slice(0, 120);
  if (typeof patch.episodeId === "string") shot.episodeId = patch.episodeId;
  if (typeof patch.script === "string") shot.script = patch.script.slice(0, 4000);
  if (Array.isArray(patch.characterIds)) shot.characterIds = patch.characterIds.slice(0, 20);
  if (typeof patch.prompt === "string") shot.prompt = patch.prompt.slice(0, 10000);
  if (patch.duration !== undefined) shot.duration = Math.max(1, Math.min(30, Number(patch.duration) || 5));
  if (patch.imageStatus === "idle" || patch.imageStatus === "queued" || patch.imageStatus === "ready") shot.imageStatus = patch.imageStatus;
  if (patch.videoStatus === "idle" || patch.videoStatus === "queued" || patch.videoStatus === "ready") shot.videoStatus = patch.videoStatus;
  touch(project, opts);
  save(projects, opts);
  return shot;
}

/** 源 :474-490 generateDramaShotImage。 */
async function generateDramaShotImage(id, shotId, options) {
  const opts = effective(options);
  const projects = load(opts);
  const project = find(projects, id, opts);
  const shot = project.shots.find((item) => item.id === shotId);
  if (!shot) throw createMediaError(MEDIA_ERR_NOT_FOUND, "分镜不存在");
  if (!shot.prompt.trim()) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "请先补充镜头画面描述，再生成图片。");
  const { provider, model, resolved } = resolveImageModel(opts);
  const prompt = imagePrompt(project, shot);
  const { images } = await modelGateway(opts).generateImages(resolved, model, { prompt, size: "1024x1536", n: 1 }, 300000);
  if (!images.length) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "图像模型未返回图片。");
  await persistImages(project, shot, shot.title, images, prompt, "generated", "frames", Object.assign({}, opts, { generatedModel: model }));
  shot.imageStatus = "ready";
  touch(project, opts);
  syncProjectFile(project, "assets/image-manifest.json", JSON.stringify(project.shots.map((item) => ({ shotId: item.id, title: item.title, selectedImageId: item.selectedImageId, images: item.images })), null, 2), opts);
  save(projects, opts);
  return { project, provider: provider.name, model };
}

/** 源 :492-515 editDramaShotImage。 */
async function editDramaShotImage(id, shotId, imageId, instruction, options) {
  const opts = effective(options);
  const projects = load(opts);
  const project = find(projects, id, opts);
  const shot = project.shots.find((item) => item.id === shotId);
  if (!shot) throw createMediaError(MEDIA_ERR_NOT_FOUND, "分镜不存在");
  const source = shot.images.find((item) => item.id === imageId);
  if (!source) throw createMediaError(MEDIA_ERR_NOT_FOUND, "找不到要修改的图片版本。");
  const note = String(instruction || "").trim().slice(0, 3000);
  if (!note) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "请说明希望怎样修改图片。");
  const port = fsPort(opts);
  const node = port.getNode(source.nodeId);
  const buf = port.readBlob(source.nodeId);
  if (!node || !buf) throw createMediaError(MEDIA_ERR_NOT_FOUND, "原始图片文件不存在，无法修改。");
  const { provider, model, resolved } = resolveImageModel(opts);
  const prompt = imagePrompt(project, shot) + "\n\n基于参考图修改：" + note + "\n保持角色身份、服化道和场景连续性，除非修改要求明确改变。";
  const { images } = await modelGateway(opts).editImages(resolved, model, { prompt, size: "1024x1536", n: 1 }, [{ buf, mime: node.mime || "image/png", name: node.name || "reference.png" }], 300000);
  if (!images.length) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "图像模型未返回修改后的图片。");
  await persistImages(project, shot, shot.title, images, prompt, "edited", "frames", Object.assign({}, opts, { generatedModel: model }));
  shot.imageStatus = "ready";
  touch(project, opts);
  syncProjectFile(project, "assets/image-manifest.json", JSON.stringify(project.shots.map((item) => ({ shotId: item.id, title: item.title, selectedImageId: item.selectedImageId, images: item.images })), null, 2), opts);
  save(projects, opts);
  return { project, provider: provider.name, model };
}

// ---------------------------------------------------------------------------
// 渲染编排（本仓新增：源没有这一层；复用 media-domain 的 Timeline V1 校验）
// ---------------------------------------------------------------------------

function selectedShotImage(shot) {
  const images = Array.isArray(shot && shot.images) ? shot.images : [];
  return images.find((image) => image.id === shot.selectedImageId) || images.at(-1) || null;
}

/**
 * 把选中的分镜图登记成 mediaStore 的 video_assets（真实文件写 <userData>/dxos/media/assets）。
 * 为什么需要：createVideoRenderJob 只认 video_assets 的 file_path，DX 虚拟文件树的 nodeId
 * 不在素材表里，不先落成 video_asset 就永远"服务端缺少素材"。
 * 已登记的 image.renderAssetId 直接复用，重复提交渲染不会重复写素材。
 */
function materializeRenderAssets(project, options) {
  const opts = effective(options);
  const store = opts.mediaStore;
  if (!store || typeof store.saveVideoAsset !== "function" || typeof store.getVideoAssetRow !== "function") return null;
  if (!opts.ownerId) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "提交渲染缺少 ownerId");
  const port = fsPort(opts);
  const canvas = Object.assign({}, DEFAULT_CANVAS, opts.canvas || {});
  const byShot = new Map();
  for (const shot of Array.isArray(project.shots) ? project.shots : []) {
    const selected = selectedShotImage(shot);
    if (!selected || !selected.nodeId) continue;
    const existingAssetId = selected.renderAssetId ? String(selected.renderAssetId) : null;
    if (existingAssetId) {
      const existing = store.getVideoAssetRow(existingAssetId, opts.ownerId);
      if (existing) { byShot.set(shot.id, existing.id); continue; }
    }
    const buffer = port.readBlob(selected.nodeId);
    if (!buffer || !buffer.length) throw createMediaError(MEDIA_ERR_NOT_FOUND, "分镜图内容缺失，无法提交渲染：" + (shot.title || shot.id));
    const node = port.getNode(selected.nodeId);
    const mime = node && typeof node.mime === "string" && node.mime.startsWith("image/") ? node.mime : "image/png";
    const extension = mime.includes("jpeg") ? ".jpg" : mime.includes("webp") ? ".webp" : ".png";
    const durationMs = Math.max(1000, Math.min(30000, Math.round((Number(shot.duration) || 5) * 1000)));
    const asset = store.saveVideoAsset({
      projectId: project.id, ownerId: opts.ownerId, projectName: project.name,
      name: (String(shot.title || "分镜").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "分镜") + extension,
      mime, buffer,
      probe: { durationMs, width: canvas.width, height: canvas.height, hasVideo: false, hasAudio: false, formatName: "image" },
    });
    selected.renderAssetId = asset.id;
    byShot.set(shot.id, asset.id);
  }
  return byShot;
}

/**
 * 把"已选图分镜"顺序编排为 Timeline V1 + assets。
 * 每个分镜时长 = shot.duration 秒（1..30s），画面用选中的分镜图。
 * assetIdFor 由 submitDramaRender 注入（video_assets id）；默认测试路径仍用虚拟树 nodeId。
 */
function buildDramaTimeline(project, options) {
  const opts = effective(options);
  const assetIdFor = typeof opts.assetIdFor === "function" ? opts.assetIdFor : null;
  const canvas = Object.assign({}, DEFAULT_CANVAS, opts.canvas || {});
  const assets = [];
  const clips = [];
  let cursor = 0;
  for (const shot of Array.isArray(project.shots) ? project.shots : []) {
    const selected = selectedShotImage(shot);
    if (!selected) continue;
    const assetId = (assetIdFor ? assetIdFor(shot, selected) : null) || selected.assetId || selected.nodeId || selected.id;
    const durationMs = Math.max(1000, Math.min(30000, Math.round((Number(shot.duration) || 5) * 1000)));
    assets.push({ id: assetId, name: shot.title || "分镜", kind: "image", hasAudio: false, durationMs });
    clips.push({ id: shot.id, trackId: "video-1", assetId, name: shot.title || "分镜", timelineStartMs: cursor, durationMs, sourceInMs: 0, sourceOutMs: durationMs, volume: 1 });
    cursor += durationMs;
  }
  const timeline = {
    schemaVersion: "1.0",
    projectId: project.id,
    version: project.updatedAt,
    timebase: 1000,
    canvas,
    durationMs: cursor,
    outputProfileId: opts.outputProfileId || "short-drama",
    tracks: [{ id: "video-1", type: "video", name: "分镜", order: 1, locked: false, muted: false, hidden: false, clips }],
  };
  const issues = mediaDomain.validateTimeline(timeline, assets).filter((issue) => issue.severity === "error");
  if (issues.length) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "短剧分镜无法编排为时间线：" + issues.map((issue) => issue.code).join(", "), { issues: issues.map((issue) => ({ code: issue.code, message: issue.message })) });
  return { timeline, assets, shotCount: clips.length, durationMs: cursor };
}

/**
 * 编排并提交渲染。renderSubmit 优先；否则用注入的 mediaStore.createVideoRenderJob；
 * 都没有即结构化不可用（绝不假执行、绝不伪造完成）。
 */
async function submitDramaRender(projectId, options) {
  const opts = effective(options);
  const projects = load(opts);
  const project = find(projects, projectId, opts);
  let submit = null;
  if (typeof opts.renderSubmit === "function") submit = opts.renderSubmit;
  else if (opts.mediaStore && typeof opts.mediaStore.createVideoRenderJob === "function") submit = (input) => opts.mediaStore.createVideoRenderJob(input);
  if (!submit) {
    throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "渲染提交面未装配（缺少 renderSubmit / mediaStore）", "缺少 renderSubmit 或 mediaStore.createVideoRenderJob：注入后重试。");
  }
  // 只有走真实 mediaStore 时才需要把虚拟树画面落成 video_assets；显式 renderSubmit 的
  // 测试 / 外部执行器自己决定素材形态，保持原样。
  const materialized = typeof opts.renderSubmit === "function" || !opts.ownerId ? null : materializeRenderAssets(project, opts);
  const plan = buildDramaTimeline(project, Object.assign({}, opts, materialized ? { assetIdFor: (shot) => materialized.get(shot.id) || null } : {}));
  if (!plan.shotCount) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "没有已就绪的分镜图，无法提交渲染。");
  if (materialized) {
    // 先记住 renderAssetId，再提交；重复提交渲染不会重复写同一份素材。
    touch(project, opts);
    save(projects, opts);
  }
  const job = await submit({ projectId: project.id, ownerId: opts.ownerId, projectName: project.name, timeline: plan.timeline, assets: plan.assets });
  return { job, plan: { shotCount: plan.shotCount, durationMs: plan.durationMs } };
}

module.exports = {
  DRAMA_STAGES,
  configureShortDrama,
  load,
  save,
  find,
  touch,
  syncProjectFile,
  jsonFromModel,
  safeText,
  resolveModel,
  resolveImageModel,
  imagePrompt,
  persistImages,
  listDramaProjects,
  createDramaProject,
  updateDramaProject,
  generateDramaOutline,
  generateDramaVisualDesign,
  visualDesignImagePrompt,
  generateVisualReferenceImage,
  editVisualReferenceImage,
  generateDramaStoryboards,
  addDramaShot,
  updateDramaShot,
  generateDramaShotImage,
  editDramaShotImage,
  buildDramaTimeline,
  submitDramaRender,
  readDramaImage,
  getDramaProjectView,
};
