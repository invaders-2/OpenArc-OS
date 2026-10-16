"use strict";
/**
 * B4a1 · 技能目录与存储（CJS 移植）。
 *
 * 来源：server/skills.ts:1-703（技能目录 / skills.json 持久化 / Agent 工具聚合 / provider 选型）。
 * 执行器部分（saveImagesToFs / runSkill / runProcedureSkill 等，skills.ts:870 之后）已由 B4a2 electron/skill-runner.cjs 落地；本文件不含执行器，只含目录 / 存储 / 选型。
 *
 * 逐字对应：
 *   · SkillDef                skills.ts:53-75
 *   · SkillSourceSnapshot     skills.ts:77-83
 *   · mergeSkillSourceForUpdate skills.ts:90-98
 *   · SkillV2Meta             skills.ts:100-121
 *   · IMAGE_SIZES / VIDEO_ASPECTS / VIDEO_RESOLUTIONS / INSTRUCTION_SCHEMA  skills.ts:124-132
 *   · SKILLS 内置目录（15 条） skills.ts:135-438
 *   · SkillStore / loadStore / persistStore  skills.ts:442-464
 *   · OFFICIAL_PRESET_IDS     skills.ts:466
 *   · SYSTEM_CAPABILITY_SKILL_MAP / SYSTEM_CAPABILITY_SKILL_IDS  skills.ts:473-487
 *   · classifySkill / allDefs  skills.ts:489-514
 *   · listSkills / listFunctionalSkills / listSystemCapabilities  skills.ts:516-532
 *   · setSkillEnabled / saveCustomSkill / updateCustomSkillDisplay / deleteCustomSkill /
 *     deleteCustomSkillsForPack / agentSkillTools  skills.ts:534-637
 *   · resolveChatTarget / resolveVisionTarget / resolveVisionTargets  skills.ts:640-703
 *   · PROCEDURE_BASE_SKILL_IDS  skills.ts:2140
 *
 * 【云与商业化删除记录】按 B4 架构决策，以下源依赖逐条移除并注明原因：
 *   · skills.ts:42  import { downloadDxosAiOutput, DXOS_AI_PROVIDER_ID, getDxosAiJob, submitDxosAiJob } from './dxosProtocol.ts'
 *       —— dxosProtocol 是云端 AI 任务（DX Credits）；本文件不含任何执行器，整条 import 删除。
 *   · skills.ts:44  import { assertMeteredApiQuotaEntry, isApiModelAllowed, withApiQuotaOwner } from './apiQuota.ts'
 *       —— apiQuota 是计费/配额门禁，属 OUT。本文件只保留其过滤发生点：resolveChatTarget:649 的
 *          provider.models.filter((model) => isApiModelAllowed(...))。因 apiQuota 不存在，改为不过滤
 *          （等价于全部允许），已在对应行标注。
 *   · cloudEntitlement（权益 / 会员门禁）在 skills.ts 中未被本区间引用，本文件同样不引入。
 *   · 其余 dxosProtocol 调用集中在执行器段（submitDxosAiJob 等，skills.ts:1401 起）：执行器已在 B4a2
 *     electron/skill-runner.cjs；该云端段按 OUT 整体删除（见 skill-runner.cjs 头部记录），本文件不含。
 *
 * 【依赖注入】按 B4 架构决策，后续批次能力一律通过注入适配器接入，未注入返回结构化错误：
 *   · fs.ts 虚拟文件树属 B6、library 属 B5、开发者 App 属 B7 —— 本文件不 import 也不使用；
 *     B4a1 所需的全部文件读写都走 fsImpl（默认 node:fs，可注入子集覆盖）。
 *   · provider/store 依赖通过 providerAdapter 注入，形状：
 *       { firstUsable(kind), all(), autoFallback(), revealProvider(id) }
 *     未注入时 resolveChatTarget / resolveVisionTarget / resolveVisionTargets 抛 AGENT_DEPENDENCY_UNAVAILABLE。
 *   · modelResolver / modelDescriptor（源 resolveVisionTargets:685-698 用到）不在 B4 范围内，且上述
 *     adapter 形状未暴露。本文件改为按 model.caps 直接判定 'llm.chat.vision'，图像张数上限优先走可选的
 *     adapter.imageLimit(provider, model)，否则读 model.inputs.images.max / model.metadata.inputs.images.max，
 *     再否则视为无限制（与源 descriptor.maximum == null 同义）。
 *
 * 对外契约（后续波次按此对接）：
 *   configureSkillStore({ dataDir, bundledDir, fsImpl, providerAdapter, clock })
 *   resetSkillStoreForTests()
 *   mergeSkillSourceForUpdate / listSkills / listFunctionalSkills / listSystemCapabilities /
 *   setSkillEnabled / saveCustomSkill / updateCustomSkillDisplay / deleteCustomSkill /
 *   deleteCustomSkillsForPack / agentSkillTools / resolveChatTarget / resolveVisionTarget / resolveVisionTargets
 *   常量：SKILLS / SYSTEM_CAPABILITY_SKILL_MAP / PROCEDURE_BASE_SKILL_IDS / OFFICIAL_PRESET_IDS /
 *         IMAGE_SIZES / VIDEO_ASPECTS / VIDEO_RESOLUTIONS / AGENT_DEPENDENCY_UNAVAILABLE
 *
 * 路径：源 constants 为 DATA_ROOT（dataPath）与 dataPath('skills.json')（skills.ts:50-51）、
 * dataPath('skill-packs')（skillPacks.ts:16）、dataPath('bundled-skill-packs.json')（skillPacks.ts:18）。
 * 本文件保留同名文件/目录名，dataDir 由调用方注入为 userData/dxos。
 */

const nodeFs = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");

/** 依赖后续批次 / 未注入适配器时的结构化错误码（与 agent-task-store.cjs 一致）。 */
const AGENT_DEPENDENCY_UNAVAILABLE = "AGENT_DEPENDENCY_UNAVAILABLE";

/** skills.ts:50-51 —— DATA_DIR = DATA_ROOT；FILE = dataPath('skills.json')。缺省落点由调用方覆盖。 */
const DEFAULT_SKILL_DATA_DIR = process.env.DXOS_SKILL_DATA_DIR || join(homedir(), ".openarc-os", "dxos");
/** skillPacks.ts:19-21 —— 内置技能包目录（DX_BUNDLED_SKILL_PACKAGES_DIR / DX_BUNDLED_SKILL_PACKS_DIR）。 */
const DEFAULT_BUNDLED_SKILL_DIR = process.env.DX_BUNDLED_SKILL_PACKAGES_DIR
  || process.env.DX_BUNDLED_SKILL_PACKS_DIR
  || join(__dirname, "bundled-skill-packages");

const SKILLS_FILE_NAME = "skills.json";
/** skillPacks.ts:16-18 —— dataPath('skill-packs') 与 dataPath('bundled-skill-packs.json')。 */
const SKILL_PACKS_DIR_NAME = "skill-packs";
const BUNDLED_SKILL_PACKS_STATE_FILE = "bundled-skill-packs.json";

// ---------------------------------------------------------------------------
// 模块级注入（源 skills.ts 用模块级常量 DATA_DIR / FILE + store.ts 模块级函数）
// ---------------------------------------------------------------------------

let skillDataDir = DEFAULT_SKILL_DATA_DIR;
let skillBundledDir = DEFAULT_BUNDLED_SKILL_DIR;
let skillFsImpl = nodeFs;
let skillProviderAdapter = null;
let skillClock = () => Date.now();

/**
 * 注入存储目录 / 内置包目录 / 文件系统 / provider 适配器 / 时钟。
 * providerAdapter 形状见文件头；clock 预留给后续 skillPacks 导入时间戳（B4a2）。
 */
function configureSkillStore(options) {
  const opts = options || {};
  if (typeof opts.dataDir === "string" && opts.dataDir) skillDataDir = opts.dataDir;
  if (typeof opts.bundledDir === "string" && opts.bundledDir) skillBundledDir = opts.bundledDir;
  if (opts.fsImpl && typeof opts.fsImpl === "object") skillFsImpl = Object.assign({}, nodeFs, opts.fsImpl);
  if (Object.prototype.hasOwnProperty.call(opts, "providerAdapter")) skillProviderAdapter = opts.providerAdapter || null;
  if (typeof opts.clock === "function") skillClock = opts.clock;
  return { dataDir: skillDataDir, bundledDir: skillBundledDir };
}

/** 测试隔离：清空全部注入并恢复缺省。 */
function resetSkillStoreForTests() {
  skillDataDir = DEFAULT_SKILL_DATA_DIR;
  skillBundledDir = DEFAULT_BUNDLED_SKILL_DIR;
  skillFsImpl = nodeFs;
  skillProviderAdapter = null;
  skillClock = () => Date.now();
}

/** 当前落点（供 main.cjs / B4a2 复用同一份路径）。 */
function skillStorePaths() {
  return {
    dataDir: skillDataDir,
    bundledDir: skillBundledDir,
    skillsFile: join(skillDataDir, SKILLS_FILE_NAME),
    skillPacksDir: join(skillDataDir, SKILL_PACKS_DIR_NAME),
    bundledStateFile: join(skillDataDir, BUNDLED_SKILL_PACKS_STATE_FILE),
  };
}

function getSkillFs() {
  return skillFsImpl;
}

function now() {
  return skillClock();
}

function getProviderAdapter() {
  if (!skillProviderAdapter) {
    const error = new Error("skill-store 未注入 provider adapter（configureSkillStore({ providerAdapter })）");
    error.code = AGENT_DEPENDENCY_UNAVAILABLE;
    error.dependency = "providerAdapter";
    throw error;
  }
  return skillProviderAdapter;
}

// ---------------------------------------------------------------------------
// 技能目录（skills.ts:53-438）
// ---------------------------------------------------------------------------

// SkillDef（skills.ts:53-75，TS interface）：
// { id, name, description, kind, systemPrompt?, inputSchema, builtin?, layer?, origin?, exposure?,
//   visibleInApp?, source?, allowImplicitInvocation?, v2? }
// SkillSourceSnapshot（skills.ts:77-83，TS interface）：
// { format: 'agentskills/v1', sourcePath, instructions, files: [{path,content}],
//   metadata: { name?, description?, displayName?, packId?, packName?, displayOverride? } }
// SkillV2Meta（skills.ts:100-121，TS interface）：
// { triggers, inputs, steps: [{title,detail,uses?}], allowedTools, permissions:
//   {readsFiles,writesFiles,network,sensitive}, output, checks, resources?, sourceName?, analyzedAt?, version }

/**
 * skills.ts:90-98 逐字：
 * 重新导入 Skill 包会刷新可执行 source 快照；翻译/改名后的显示是用户资产，
 * 因此把 displayOverride 标记带到新快照上，而不是在路由注册时丢弃。
 */
function mergeSkillSourceForUpdate(existing, incoming, preserveDisplay) {
  const source = incoming || existing;
  if (!source || !preserveDisplay) return source;
  return Object.assign({}, source, { metadata: Object.assign({}, source.metadata, { displayOverride: true }) });
}

/** skills.ts:124-126 */
const IMAGE_SIZES = ["1024x1024", "1792x1024", "1024x1792", "1536x1024", "1024x1536", "1280x720", "720x1280"];
const VIDEO_ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
const VIDEO_RESOLUTIONS = ["480p", "720p", "1080p", "4k"];

/** skills.ts:128-132 */
const INSTRUCTION_SCHEMA = (desc) => ({
  type: "object",
  properties: { instruction: { type: "string", description: desc } },
  required: ["instruction"],
});

/** skills.ts:134-438 逐字移植：内置技能目录，共 15 条。 */
const SKILLS = [
  {
    id: "chat",
    name: "对话回复",
    description: "普通对话、问答、解释概念；不适合长文写作（用 writing）和代码（用 code）。",
    kind: "text",
    systemPrompt: "你是一个直接、自然、可靠的中文对话助手。回答用户问题；不需要生成图片；不输出无关解释。",
    inputSchema: INSTRUCTION_SCHEMA("用户的问题或对话内容"),
  },
  {
    id: "writing",
    name: "写作生成",
    description: "生成诗歌、文案、故事、脚本、邮件、标题等原创文本，输出可直接交付的成品。",
    kind: "text",
    systemPrompt: "你是中文写作助手。按用户要求创作可直接交付的文本，如诗歌、文案、故事、标题、邮件。只输出成品，除非用户要求解释。",
    inputSchema: INSTRUCTION_SCHEMA("写作要求，包含体裁、主题、长度、语气等"),
  },
  {
    id: "rewrite",
    name: "文本改写",
    description: "润色、改写、扩写、缩写、翻译或调整语气，保持原意。",
    kind: "text",
    systemPrompt: "你是文本改写助手。根据用户要求润色、改写、扩写、缩写、翻译或调整语气。尽量保留原意，只输出改写结果。",
    inputSchema: INSTRUCTION_SCHEMA("改写要求 + 原文"),
  },
  {
    id: "code",
    name: "代码助手",
    description: "写代码、解释代码、分析报错、给出技术修复方案。",
    kind: "text",
    systemPrompt: "你是代码与技术助手。可以写代码、解释代码、分析报错、给出修复方案。需要代码时使用清晰代码块。",
    inputSchema: INSTRUCTION_SCHEMA("编程需求、代码片段或报错信息"),
  },
  {
    id: "analysis",
    name: "文本分析",
    description: "总结、归纳、对比、提取要点、诊断问题，输出结构化结论。",
    kind: "text",
    systemPrompt: "你是分析总结助手。擅长总结、归纳、对比、提取要点、诊断问题。输出结构清晰，优先给结论。",
    inputSchema: INSTRUCTION_SCHEMA("分析要求 + 待分析的文本材料"),
  },
  {
    id: "generate_image",
    name: "生成图片",
    description: "从文本提示词生成图片（OpenAI 兼容图像 API）；生成结果会保存到「生成图片」文件夹。",
    kind: "image",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "文生图提示词，越具体越好（画面主体、风格、构图、光线、色调等）" },
        path: {
          type: "string",
          description:
            "【推荐】保存路径，相对当前项目根，可含子文件夹并指定文件名，如「角色/苏离.png」。给出后图片直接存到该位置并用该文件名（无需再另建索引文件）。留空则存到「生成图片」文件夹并自动命名。",
        },
        size: { type: "string", enum: IMAGE_SIZES, description: "像素尺寸，默认 1024x1024（16:9=1792x1024，9:16=1024x1792）" },
        n: { type: "number", description: "生成数量 1-4，默认 1" },
      },
      required: ["prompt"],
    },
  },
  {
    id: "midjourney",
    name: "Midjourney 创作",
    description: "仅在用户明确指定 Midjourney，或要求 Blend、U/V、重抽、扩图、平移、局部重绘等 Midjourney 专属操作时使用；普通生图继续使用 generate_image。",
    kind: "midjourney",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["imagine", "blend", "edit", "upscale", "variation", "low_variation", "high_variation", "reroll", "zoom", "pan", "inpaint", "remix_subtle", "remix_strong", "status"],
          description: "操作类型。首次创作使用 imagine；多图融合用 blend；基于参考图创作用 edit；对已有任务继续操作时使用其余类型。",
        },
        prompt: { type: "string", description: "Imagine/Edit/Inpaint/Remix 的提示词；Blend、任务查询和多数后续操作可留空。" },
        image: {
          type: "array",
          items: { type: "string" },
          description: "参考图片路径、FS 节点 id、/api/fs/raw/<id> 或 http(s) 地址。Blend 必须 2-4 张；Edit 至少 1 张。",
        },
        mask_image: { type: "string", description: "Inpaint 局部重绘使用的遮罩图片引用。" },
        task_id: { type: "string", description: "已有 Midjourney 任务 ID；后续操作和 status 必填。" },
        index: { type: "number", description: "图片序号 1-4；Upscale、Variation、Remix 等操作使用。" },
        custom_id: { type: "string", description: "接口返回的按钮 custom_id；有值时优先于 index/direction。" },
        size: { type: "string", enum: ["1:1", "4:3", "3:4", "16:9", "9:16"], description: "画面比例，默认 1:1。" },
        version: { type: "string", description: "Midjourney 版本，默认根据所选模型推断，如 6.1 或 niji。" },
        speed: { type: "string", enum: ["relax", "fast", "turbo"], description: "生成速度，默认 relax。" },
        direction: { type: "string", enum: ["left", "right", "up", "down"], description: "Pan 平移方向。" },
        zoom_ratio: { type: "number", description: "Zoom 缩放比例，大于 1 且不超过 4。" },
        wait: { type: "boolean", description: "是否等待任务完成并保存图片，默认 true；false 时只提交并返回 task_id。" },
        path: { type: "string", description: "完成后图片的保存路径；留空保存到「生成图片」文件夹。" },
      },
      required: ["operation"],
    },
  },
  {
    id: "upscale_image",
    name: "放大图片",
    description: "使用支持 image.upscale 的模型放大已有图片；当前支持即梦 CLI 的 2K、4K、8K 图片放大。不要用生成图片或 Midjourney U 操作替代普通图片超分。",
    kind: "image_upscale",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["upscale", "status"], description: "默认 upscale；即梦任务排队后用 status 和 submit_id 续查。" },
        image: { type: "string", description: "要放大的图片路径、FS 节点 id、/api/fs/raw/<id> 或 http(s) 地址。" },
        resolution: { type: "string", enum: ["2k", "4k", "8k"], description: "目标分辨率，默认 2k。" },
        submit_id: { type: "string", description: "status 查询所需的即梦任务 ID。" },
        path: { type: "string", description: "保存路径；留空保存到「生成图片」文件夹。" },
      },
    },
  },
  {
    id: "generate_video",
    name: "生成视频",
    description:
      "统一的视频生成能力：文生视频、图生视频、首尾帧、参考视频、参考音频。Agent 根据提供的素材和角色选择合适的调用方式，结果保存到「生成视频」文件夹。",
    kind: "video",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["generate", "status"], description: "默认 generate；即梦任务排队后用 status 和 submit_id 续查。" },
        submit_id: { type: "string", description: "status 查询所需的即梦任务 ID。" },
        prompt: { type: "string", description: "视频提示词：主体动作、镜头运动、场景、风格、节奏和声音要求" },
        mode: {
          type: "string",
          enum: ["auto", "text_to_video", "image_to_video", "first_last_frame", "multi_reference", "video_to_video", "audio_reference", "multimodal"],
          description: "生成方式，默认 auto 根据素材自动判断；只有需要强制指定时才填写",
        },
        image: {
          type: "string",
          description: "单张图片参考的路径、FS 节点 id、/api/fs/raw/<id> 或 http(s) 地址，适合图生视频",
        },
        images: {
          type: "array",
          items: { type: "object", properties: { ref: { type: "string" }, role: { type: "string", enum: ["first_frame", "last_frame", "reference_image"] } }, required: ["ref"] },
          description: "多张图片参考；元素可写成 {ref, role}，role 支持 first_frame、last_frame、reference_image",
        },
        first_frame: { type: "string", description: "首帧图片引用；等价于 images 中 role=first_frame" },
        last_frame: { type: "string", description: "尾帧图片引用；等价于 images 中 role=last_frame" },
        video: {
          type: "string",
          description: "参考视频的路径、FS 节点 id、/api/fs/raw/<id> 或 http(s) 地址",
        },
        videos: {
          type: "array",
          items: { type: "object", properties: { ref: { type: "string" }, role: { type: "string", enum: ["reference_video"] } }, required: ["ref"] },
          description: "参考视频列表；元素可写成 {ref, role}",
        },
        audio: {
          type: "string",
          description: "参考音频的路径、FS 节点 id、/api/fs/raw/<id> 或 http(s) 地址",
        },
        audios: {
          type: "array",
          items: { type: "object", properties: { ref: { type: "string" }, role: { type: "string", enum: ["reference_audio"] } }, required: ["ref"] },
          description: "参考音频列表；元素可写成 {ref, role}",
        },
        duration: { type: "number", description: "视频时长（秒），默认 5；不同模型会自动适配支持的范围" },
        aspect_ratio: { type: "string", enum: VIDEO_ASPECTS, description: "画面比例，默认 16:9" },
        resolution: { type: "string", enum: VIDEO_RESOLUTIONS, description: "分辨率档位，默认由站点决定" },
        generate_audio: { type: "boolean", description: "是否让视频模型同时生成声音" },
        enhance_prompt: { type: "boolean", description: "是否让站点增强提示词" },
        enable_upsample: { type: "boolean", description: "是否启用视频超分（模型支持时生效）" },
        watermark: { type: "boolean", description: "是否添加平台水印" },
        camera_fixed: { type: "boolean", description: "是否固定镜头、减少镜头位移" },
        multimodal: { type: "boolean", description: "多模态参考模式；用于同时理解多张图或视频" },
        return_last_frame: { type: "boolean", description: "是否要求返回最后一帧（站点支持时生效）" },
        seed: { type: "number", description: "随机种子（站点支持时生效）" },
        path: { type: "string", description: "保存路径，相对当前项目根，可含子文件夹和文件名；留空保存到「生成视频」" },
      },
    },
  },
  {
    id: "edit_image",
    name: "编辑图片",
    description:
      "按指令编辑/修改已有图片（图生图，需站点支持图像编辑）：换背景、改文案、调风格、局部替换、多图合成等。结果保存到「生成图片」文件夹。",
    kind: "image_edit",
    inputSchema: {
      type: "object",
      properties: {
        image: {
          type: "array",
          items: { type: "string" },
          description: "待编辑/参考图，支持相对项目根的路径（如「角色/苏离.png」）、文件系统节点 id、/api/fs/raw/<id> 链接或 http(s) 图片地址；可传多张一起参考",
        },
        prompt: { type: "string", description: "编辑指令：明确要改什么、保持什么" },
        path: {
          type: "string",
          description: "保存路径，相对当前项目根，可含子文件夹并指定文件名，如「角色/苏离_改.png」。留空则存到「生成图片」文件夹并自动命名。",
        },
        size: { type: "string", enum: IMAGE_SIZES, description: "输出像素尺寸，默认 1024x1024" },
        n: { type: "number", description: "生成数量 1-4，默认 1" },
      },
      required: ["image", "prompt"],
    },
  },
  {
    id: "text_to_speech",
    name: "文字转语音",
    description: "把文本合成为语音并保存到「生成音频」；适用于旁白、配音和语音播报，不用于生成歌曲。",
    kind: "audio_tts",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要朗读的文字。" },
        voice: { type: "string", description: "声音名称，默认 alloy；具体声音由模型支持范围决定。" },
        speed: { type: "number", description: "语速，默认 1，通常支持 0.25-4。" },
        format: { type: "string", enum: ["mp3", "wav", "opus", "aac", "flac"], description: "输出格式，默认 mp3。" },
        path: { type: "string", description: "保存路径；留空保存到「生成音频」。" },
      },
      required: ["text"],
    },
  },
  {
    id: "transcribe_audio",
    name: "音频转文字",
    description: "转写语音、会议或采访录音，也可以把语音翻译成英文文本；需要提供已有音频文件。",
    kind: "audio_transcribe",
    inputSchema: {
      type: "object",
      properties: {
        audio: { type: "string", description: "音频路径、FS 节点 id、/api/fs/raw/<id> 或 http(s) 地址。" },
        operation: { type: "string", enum: ["transcribe", "translate"], description: "transcribe 原语言转写；translate 翻译成英文。" },
        language: { type: "string", description: "输入语言代码，如 zh、en；自动识别时留空。" },
        prompt: { type: "string", description: "可选上下文、专有名词或转写提示。" },
      },
      required: ["audio"],
    },
  },
  {
    id: "generate_music",
    name: "生成音乐",
    description: "使用音乐模型生成歌曲、配乐或纯音乐并保存到「生成音频」；普通语音旁白请使用 text_to_speech。",
    kind: "audio_music",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "音乐主题、情绪、编曲、速度和声音要求。" },
        title: { type: "string", description: "可选歌曲标题。" },
        lyrics: { type: "string", description: "可选歌词。" },
        style: { type: "string", description: "可选曲风，如 cinematic、pop、lofi。" },
        instrumental: { type: "boolean", description: "是否生成纯音乐。" },
        path: { type: "string", description: "保存路径；留空保存到「生成音频」。" },
      },
      required: ["prompt"],
    },
  },
  {
    id: "batch_image_group_process",
    name: "批量图片分组处理",
    description:
      "把多张图片按数量或组合规则分组，对每组统一执行图片编辑：批量精修、逐张换文案/翻译、每 N 张合成场景图、两两组合出图等。结果保存到「生成图片」文件夹。",
    kind: "image_batch",
    inputSchema: {
      type: "object",
      properties: {
        image: {
          type: "array",
          items: { type: "string" },
          description: "待处理的多张图片，支持 FS 节点 id、/api/fs/raw/<id> 链接或 http(s) 地址",
        },
        prompt: { type: "string", description: "对每一组图片统一执行的编辑提示词" },
        groupMode: {
          type: "string",
          enum: ["sequential", "all_each", "all_in_one", "combinations"],
          description: "分组方式：sequential 顺序按 groupSize 分组、all_each 每张单跑、all_in_one 全部一组、combinations 按组合生成",
        },
        groupSize: { type: "number", description: "每组图片数量（sequential/combinations 用），默认 1" },
        remainderPolicy: {
          type: "string",
          enum: ["run", "skip", "error"],
          description: "sequential 最后不足一组的剩余图片如何处理：run 照跑、skip 跳过、error 报错，默认 run",
        },
        concurrency: { type: "number", description: "并发执行组数，建议 1-4，默认 2" },
        retryCount: { type: "number", description: "单组失败自动重试次数，默认 1" },
        maxGroups: { type: "number", description: "最多执行多少组；combinations 默认保护为 200 组" },
        maxReferenceImages: { type: "number", description: "单组最多传给编辑模型的参考图数量，默认 4" },
        failurePolicy: {
          type: "string",
          enum: ["continue", "stop"],
          description: "单组失败后 continue 继续 / stop 停止后续组，默认 continue",
        },
        size: { type: "string", enum: IMAGE_SIZES, description: "输出像素尺寸，默认 1024x1024" },
        n: { type: "number", description: "每组生成数量 1-4，默认 1" },
      },
      required: ["image", "prompt"],
    },
  },
  {
    id: "describe_image",
    name: "识别图片",
    description: "看图并用文字描述/反推：读一张图片，回答它画了什么、反推提示词、校验是否符合要求（需站点有视觉模型）。",
    kind: "image_describe",
    inputSchema: {
      type: "object",
      properties: {
        image: { type: "string", description: "要识别的图片：相对项目根的路径（如「角色/苏离.png」）、FS 节点 id、/api/fs/raw 链接或 http(s) 地址" },
        prompt: { type: "string", description: "想问什么，如「描述画面内容」「反推英文提示词」「是否是银发少女」，留空则默认描述画面" },
      },
      required: ["image"],
    },
  },
];
// ── 持久化：data/skills.json = { enabled: 覆盖项, custom: 自定义技能 } ───
// （兼容旧格式：纯 Record<string, boolean> 视为 enabled 覆盖）
// skills.ts:442-464

function loadStore() {
  const fs = getSkillFs();
  const file = skillStorePaths().skillsFile;
  try {
    if (!fs.existsSync(file)) return { enabled: {}, custom: [] };
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (raw && (raw.enabled || raw.custom)) {
      return {
        enabled: raw.enabled || {},
        custom: Array.isArray(raw.custom) ? raw.custom : [],
      };
    }
    return { enabled: raw || {}, custom: [] };
  } catch {
    return { enabled: {}, custom: [] };
  }
}

function persistStore(store) {
  const fs = getSkillFs();
  const paths = skillStorePaths();
  if (!fs.existsSync(paths.dataDir)) fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.writeFileSync(paths.skillsFile, JSON.stringify(store, null, 2), "utf-8");
}

/** skills.ts:466 */
const OFFICIAL_PRESET_IDS = new Set(["writing", "rewrite", "code", "analysis"]);

/**
 * skills.ts:468-484 逐字：兼容旧内置媒体 Skill 迁到系统 Capability Registry 之前的 Agent 工具名。
 * key 是稳定 Agent 工具名，value 是旧执行器 id，不得当作可安装的用户 Skill。
 */
const SYSTEM_CAPABILITY_SKILL_MAP = Object.freeze({
  media_generate_image: "generate_image",
  media_midjourney: "midjourney",
  media_upscale_image: "upscale_image",
  media_generate_video: "generate_video",
  media_edit_image: "edit_image",
  media_batch_image: "batch_image_group_process",
  media_describe_image: "describe_image",
  media_text_to_speech: "text_to_speech",
  media_transcribe_audio: "transcribe_audio",
  media_generate_music: "generate_music",
});

/** skills.ts:487 */
const SYSTEM_CAPABILITY_SKILL_IDS = new Set(Object.values(SYSTEM_CAPABILITY_SKILL_MAP));

/** skills.ts:489-510 逐字。 */
function classifySkill(skill, builtin) {
  if (skill.id === "chat") {
    return Object.assign({}, skill, { builtin: builtin, layer: "preset", origin: "official", exposure: "internal", visibleInApp: true });
  }
  if (builtin && OFFICIAL_PRESET_IDS.has(skill.id)) {
    return Object.assign({}, skill, { builtin: builtin, layer: "preset", origin: "official", exposure: "slash", allowImplicitInvocation: false, visibleInApp: true });
  }
  if (builtin) {
    return Object.assign({}, skill, { builtin: builtin, layer: "capability", origin: "system", exposure: "internal", allowImplicitInvocation: false, visibleInApp: false });
  }
  const imported = !!(skill.source && skill.source.metadata && skill.source.metadata.packId) || !!skill.source;
  return Object.assign({}, skill, {
    builtin: builtin,
    layer: skill.layer || (skill.kind === "procedure" || imported ? "workflow" : "preset"),
    origin: skill.origin || (imported ? "imported" : "user"),
    // 功能 Skill 不进入 Agent 自动工具集，只允许用户通过 /技能ID 显式调用。
    exposure: "slash",
    allowImplicitInvocation: false,
    visibleInApp: skill.visibleInApp !== false,
  });
}

/** skills.ts:512-514 */
function allDefs(store) {
  return [
    ...SKILLS.map((s) => classifySkill(s, true)),
    ...store.custom.map((s) => classifySkill(s, false)),
  ];
}

/** skills.ts:516-519 */
function listSkills() {
  const store = loadStore();
  return allDefs(store).map((s) => Object.assign({}, s, { enabled: store.enabled[s.id] !== false }));
}

/** skills.ts:521-524 —— 面向产品的 Skill 目录：只含提示词/工作流 Skill，绝不含系统能力。 */
function listFunctionalSkills() {
  return listSkills().filter((skill) => skill.layer !== "capability" && skill.id !== "chat");
}

/** skills.ts:526-532 */
function listSystemCapabilities() {
  const byId = new Map(
    listSkills()
      .filter((skill) => SYSTEM_CAPABILITY_SKILL_IDS.has(skill.id))
      .map((skill) => [skill.id, skill]),
  );
  return Object.entries(SYSTEM_CAPABILITY_SKILL_MAP).flatMap(([toolName, skillId]) => {
    const definition = byId.get(skillId);
    return definition ? [{ toolName: toolName, skillId: skillId, definition: definition }] : [];
  });
}
/** skills.ts:534-541 */
function setSkillEnabled(id, enabled) {
  const store = loadStore();
  const def = allDefs(store).find((s) => s.id === id);
  if (!def) return null;
  store.enabled[id] = enabled;
  persistStore(store);
  return Object.assign({}, def, { enabled: enabled });
}

/** skills.ts:543-586 新建/更新自定义技能（文字类；内置技能不可覆盖）。 */
function saveCustomSkill(obj) {
  const input = obj || {};
  const id = String(input.id || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]*$/.test(id)) throw new Error("id 必须以小写字母开头，只能含小写字母、数字、下划线");
  if (SKILLS.some((s) => s.id === id)) throw new Error("「" + id + "」是内置技能，不能覆盖");
  const requestedName = String(input.name || "").trim();
  if (!requestedName) throw new Error("缺少名称");
  const systemPrompt = String(input.systemPrompt || "").trim();
  if (!systemPrompt) throw new Error("缺少 system prompt（技能的角色设定与规则）");
  const store = loadStore();
  const existing = store.custom.find((s) => s.id === id);
  const existingPackId = existing && existing.source && existing.source.metadata ? existing.source.metadata.packId : undefined;
  const inputPackId = input.source && input.source.metadata ? input.source.metadata.packId : undefined;
  const inputDisplayOverride = !!(input.source && input.source.metadata && input.source.metadata.displayOverride === true);
  const preserveDisplay = !!(existing && existing.source && existing.source.metadata && existing.source.metadata.displayOverride === true)
    && existingPackId === inputPackId
    && !inputDisplayOverride;
  const name = preserveDisplay ? existing.name : requestedName;
  const description = preserveDisplay
    ? existing.description
    : String(input.description || "").trim() || name;
  const v2 = input.v2 || (existing && existing.v2);
  const source = mergeSkillSourceForUpdate(existing && existing.source, input.source, preserveDisplay);
  const allowImplicitInvocation = input.allowImplicitInvocation !== undefined
    ? input.allowImplicitInvocation
    : (existing && existing.allowImplicitInvocation);
  // 带结构化工作流的第三方 Skill 存为 procedure：运行时由 Agent 小循环驱动基础 skill
  const kind = input.kind === "procedure" || (v2 && v2.steps && v2.steps.length) ? "procedure" : "text";
  const def = Object.assign(
    {
      id: id,
      name: name,
      description: description,
      kind: kind,
      layer: input.layer || (existing && existing.layer) || (kind === "procedure" || !!source ? "workflow" : "preset"),
      origin: input.origin || (existing && existing.origin) || (source ? "imported" : "user"),
      exposure: "slash",
      visibleInApp: input.visibleInApp !== undefined ? input.visibleInApp : (existing ? existing.visibleInApp : true),
      systemPrompt: systemPrompt,
      inputSchema: INSTRUCTION_SCHEMA(String(input.description || name)),
      allowImplicitInvocation: false,
    },
    source ? { source: source } : {},
    v2 ? { v2: v2 } : {},
  );
  // 源 skills.ts:563 计算了 allowImplicitInvocation 但在 578 被硬编码 false 覆盖；此处保留同名局部变量以逐字对应。
  void allowImplicitInvocation;
  const idx = store.custom.findIndex((s) => s.id === id);
  if (idx >= 0) store.custom[idx] = def;
  else store.custom.push(def);
  persistStore(store);
  return Object.assign({}, def, { builtin: false, enabled: store.enabled[id] !== false });
}

/** skills.ts:588-600 修改 Skill 的显示名称/简介，不改变 ID、执行说明或工具调用名。 */
function updateCustomSkillDisplay(id, name, description) {
  const store = loadStore();
  const skill = store.custom.find((item) => item.id === id);
  if (!skill) throw new Error("功能 Skill 不存在");
  const nextName = String(name || "").trim();
  if (!nextName) throw new Error("名称不能为空");
  skill.name = nextName.slice(0, 80);
  if (typeof description === "string" && description.trim()) skill.description = description.trim().slice(0, 500);
  if (skill.source) skill.source.metadata = Object.assign({}, skill.source.metadata, { displayOverride: true });
  persistStore(store);
  return Object.assign({}, skill, { builtin: false, enabled: store.enabled[id] !== false });
}

/** skills.ts:602-611 删除自定义技能（内置技能只能停用，不能删除）。 */
function deleteCustomSkill(id) {
  if (SKILLS.some((s) => s.id === id)) throw new Error("内置技能不能删除，只能停用");
  const store = loadStore();
  const before = store.custom.length;
  store.custom = store.custom.filter((s) => s.id !== id);
  delete store.enabled[id];
  persistStore(store);
  return store.custom.length < before;
}

/** skills.ts:613-623 移除某个完整 Skill 包自动注册的路由 Skill。 */
function deleteCustomSkillsForPack(packId) {
  const store = loadStore();
  const removed = store.custom.filter((skill) => skill.source && skill.source.metadata && skill.source.metadata.packId === packId);
  if (!removed.length) return 0;
  const removedIds = new Set(removed.map((skill) => skill.id));
  store.custom = store.custom.filter((skill) => !removedIds.has(skill.id));
  for (const id of removedIds) delete store.enabled[id];
  persistStore(store);
  return removed.length;
}

/** skills.ts:625-637 聚合启用的技能，转成 agent 可用的 function 定义（name = skill__<id>）。 */
function agentSkillTools() {
  return listSkills()
    .filter((s) => s.enabled && s.exposure === "agent" && s.allowImplicitInvocation !== false)
    .map((s) => ({
      type: "function",
      function: {
        name: "skill__" + s.id,
        description: "[技能:" + s.name + "] " + s.description,
        parameters: s.inputSchema,
      },
    }));
}
// ── provider / 模型选型（与 /api/chat 相同规则，skills.ts:639-703）──────────

/** skills.ts:640-661 */
function resolveChatTarget(opts) {
  const options = opts || {};
  const adapter = getProviderAdapter();
  const preferred = options.providerId ? adapter.revealProvider(String(options.providerId)) : adapter.firstUsable("llm");
  const candidates = [preferred, ...(adapter.all() || []).filter((provider) => !preferred || provider.id !== preferred.id)];
  const hit = candidates.flatMap((provider) => {
    // provider-adapter-bridge.cjs 的只读投影用 has_key 取代 api_key（真值密钥不跨出适配器）。
    if (!provider || !provider.enabled || (!provider.api_key && !provider.has_key && provider.source !== "cli")) return [];
    // skills.ts:649 源为 provider.models.filter((model) => isApiModelAllowed(provider.id, model.model))
    // B4: apiQuota OUT（计费/配额门禁已移除），因此这里不再过滤，等价于全部模型允许。
    const models = provider.models || [];
    const entry = (options.model && models.find((model) => model.model === options.model && (model.caps || []).includes("llm")))
      || models.find((model) => (model.caps || []).includes("llm"));
    return entry ? [{ provider: provider, entry: entry }] : [];
  })[0];
  if (!hit) {
    throw new Error("还没有可用的模型站点。请先在「系统设置 › 模型与服务商」里添加并启用一个站点，填好 Base URL、Key 和至少一个模型。");
  }
  return {
    provider: { id: hit.provider.id, base_url: hit.provider.base_url, api_key: hit.provider.api_key, protocol: hit.entry.protocol || hit.provider.protocol },
    model: hit.entry.model,
    providerName: hit.provider.name,
  };
}

/**
 * 视觉模型的图像张数上限。源 skills.ts:696 走
 * resolveModelDescriptor({ provider, model, intent: 'llm.chat.vision' }).inputs.images.max；
 * 该模块不在 B4 范围，因此按文件头约定：可选 adapter.imageLimit 优先，其次 model.inputs.images.max，
 * 再次 model.metadata.inputs.images.max，都没有则 null（与源 maximum == null 同义：无限制）。
 */
function resolveVisionImageLimit(provider, model) {
  if (skillProviderAdapter && typeof skillProviderAdapter.imageLimit === "function") {
    const value = skillProviderAdapter.imageLimit(provider, model);
    if (value !== undefined && value !== null) {
      const injected = Number(value);
      if (Number.isFinite(injected)) return injected;
    }
  }
  const direct = model && model.inputs && model.inputs.images ? model.inputs.images.max : null;
  const metadata = model && model.metadata && model.metadata.inputs && model.metadata.inputs.images
    ? model.metadata.inputs.images.max
    : null;
  const raw = direct !== null && direct !== undefined ? direct : metadata;
  if (raw === null || raw === undefined) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

/** skills.ts:663-670 识图必须选择真正声明 llm.chat.vision 的模型，不能沿用普通聊天首选项。 */
function resolveVisionTarget(opts) {
  return resolveVisionTargets(opts, 1)[0];
}

/** skills.ts:672-703 */
function resolveVisionTargets(opts, imageCount) {
  const options = opts || {};
  const count = Number.isFinite(imageCount) ? Math.max(1, Math.floor(imageCount)) : 1;
  const adapter = getProviderAdapter();
  const providers = adapter.all() || [];
  const preferredProvider = options.providerId
    ? providers.find((provider) => provider.id === options.providerId) || null
    : null;
  // skills.ts:678-684
  const preferredModels = options.providerId
    ? ((preferredProvider && preferredProvider.models) || []).map((entry) => ({
        providerId: options.providerId,
        model: entry.model,
        weight: entry.model === options.model ? 2000 : 500,
      }))
    : options.model ? [{ model: options.model, weight: 2000 }] : [];
  // skills.ts:685-690 源用 resolveModelRoutesFromProviders({ requiresAll: ['llm.chat.vision'],
  // fallbackPolicy: 'best_available', preferredModels })。这里按 caps 直接筛选并做同等权重排序。
  const candidates = [];
  for (const provider of providers) {
    for (const model of provider.models || []) {
      if (!(model.caps || []).includes("llm.chat.vision")) continue;
      const preferred = preferredModels.find((item) => (item.providerId === undefined || item.providerId === provider.id) && item.model === model.model);
      candidates.push({ provider: provider, model: model, weight: preferred ? preferred.weight : 0 });
    }
  }
  candidates.sort((a, b) => b.weight - a.weight
    || Number(a.provider.sort || 0) - Number(b.provider.sort || 0)
    || Number(a.provider.created_ts || 0) - Number(b.provider.created_ts || 0));
  // adapter.autoFallback()：源固定 best_available；这里在显式指定 provider/model 且关闭自动回退时
  // 收窄为指定候选，未指定时保持全量（与源语义一致）。
  let ordered = candidates;
  const autoFallback = typeof adapter.autoFallback === "function" ? adapter.autoFallback() !== false : true;
  if (!autoFallback && (options.providerId || options.model)) {
    const preferredOnly = ordered.filter((candidate) => candidate.weight > 0);
    if (preferredOnly.length) ordered = preferredOnly;
  }
  // skills.ts:691-698
  const compatible = ordered.filter((candidate) => {
    const maximum = resolveVisionImageLimit(candidate.provider, candidate.model);
    return maximum === null || maximum >= count;
  });
  if (!compatible.length) {
    throw new Error("没有可用的视觉模型。请在「系统设置 › 模型与服务商」中启用支持看图的模型。");
  }
  return compatible.map((candidate) => ({
    provider: {
      id: candidate.provider.id,
      base_url: candidate.provider.base_url,
      api_key: candidate.provider.api_key,
      protocol: candidate.model.protocol || candidate.provider.protocol,
    },
    model: candidate.model.model,
    providerName: candidate.provider.name,
  }));
}

/** skills.ts:2140 PROCEDURE_BASE_SKILL_IDS（源为 as const，这里冻结为数组）。 */
const PROCEDURE_BASE_SKILL_IDS = Object.freeze([
  "writing",
  "rewrite",
  "analysis",
  "code",
  "chat",
  "generate_image",
  "upscale_image",
  "midjourney",
  "generate_video",
  "text_to_speech",
  "transcribe_audio",
  "generate_music",
  "edit_image",
  "describe_image",
]);

module.exports = {
  AGENT_DEPENDENCY_UNAVAILABLE,
  SKILLS,
  IMAGE_SIZES,
  VIDEO_ASPECTS,
  VIDEO_RESOLUTIONS,
  INSTRUCTION_SCHEMA,
  SYSTEM_CAPABILITY_SKILL_MAP,
  OFFICIAL_PRESET_IDS,
  PROCEDURE_BASE_SKILL_IDS,
  configureSkillStore,
  resetSkillStoreForTests,
  skillStorePaths,
  mergeSkillSourceForUpdate,
  listSkills,
  listFunctionalSkills,
  listSystemCapabilities,
  setSkillEnabled,
  saveCustomSkill,
  updateCustomSkillDisplay,
  deleteCustomSkill,
  deleteCustomSkillsForPack,
  agentSkillTools,
  resolveChatTarget,
  resolveVisionTarget,
  resolveVisionTargets,
};
