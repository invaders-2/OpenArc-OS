"use strict";
/**
 * B4 · 技能域装配 + skill:command 分发（唯一执行入口）。
 *
 * 装配真实模块（不 mock、不新增依赖）：
 *   · skill-store.cjs     技能目录 / 启停 / 自定义技能（configureSkillStore）
 *   · skill-import.cjs    单技能 ZIP 导入（configureSkillImport）
 *   · skill-pack.cjs      技能包安装/导出/卸载（configureSkillPack）
 *   · skill-runner.cjs    技能执行器 runSkill（configureSkillRunner）
 *   · skill-analyzer.cjs  技能文档分析 analyzeSkillDocument（configureSkillAnalyzer）
 *   · skill-workspace.cjs 多 Agent 工作空间资料（configureSkillWorkspace）
 *
 * 边界：
 *   · 渲染层自报的 userId / role / appId / sessionRef 一律忽略；actor 由 authorization.resolveActor
 *     从可信 sessionRef 推导（与 agent-service.cjs:255-264 / model-service.cjs:17 同一条边界）。
 *   · <userData>/dxos 由 dxos-foundation-paths.cjs:29-37 解析；本文件不拼第二套路径。
 *   · 返回值统一过 skill-domain.cjs 的 redactSkillValue —— 不含 api_key / credentialRef / 绝对路径。
 *   · 未注入的适配器（modelAdapter / cliRuntime / mediaAdapter / fsAdapter / providerAdapter / db）
 *     保持结构化 AGENT_DEPENDENCY_UNAVAILABLE，绝不伪造成功。
 */
const { resolveDxosPaths, ensureDxosLayout } = require("./dxos-foundation-paths.cjs");

const skillDomain = require("./skill-domain.cjs");
const skillStore = require("./skill-store.cjs");
const skillImport = require("./skill-import.cjs");
const skillPack = require("./skill-pack.cjs");
const skillRunner = require("./skill-runner.cjs");
const skillAnalyzer = require("./skill-analyzer.cjs");
const skillWorkspace = require("./skill-workspace.cjs");

const { createSkillError, normalizeSkillError, redactSkillValue, isSkillCommand, skillCommandNotAllowed, SKILL_ERR_INVALID_INPUT, SKILL_ERR_UNAUTHENTICATED, SKILL_ERR_NOT_FOUND, SKILL_ERR_DEPENDENCY_UNAVAILABLE, SKILL_EVENT_CHANNEL } = skillDomain;

/** 技能能力承载的 App Principal：与 agent-service.cjs:48 / task-bootstrap.cjs:108 同一约定。 */
const HOST_APP_ID = "ai";
/** 技能包 ZIP 上限：与 skill-import.cjs:34 MAX_PACKAGE_BYTES 对齐，避免把超大载荷搬过 IPC。 */
const MAX_ARCHIVE_BYTES = skillImport.MAX_PACKAGE_BYTES;
/** 导出返回 base64 的上限：超过即结构化拒绝，不返回半截内容。 */
const MAX_EXPORT_BYTES = 8 * 1024 * 1024;

const asStr = (value, max = 512) => (typeof value === "string" ? value.slice(0, max) : value == null ? undefined : String(value).slice(0, max));
const requireStr = (value, max = 512) => { const text = asStr(value, max); return text && text.length ? text : null; };

/**
 * B7j：把"依赖 / 前置缺失"归一到技能域依赖缺失码 SKILL_DEPENDENCY_UNAVAILABLE。
 *   · 底层 AGENT_DEPENDENCY_UNAVAILABLE（modelAdapter / providerAdapter / modelSite / cliRuntime...）；
 *   · 已经是 SKILL_* 的结构化错误原样保留（normalizeSkillError 会照码返回）。
 * detail 里保留 dependency 与可读 reason —— 绝不把依赖缺失伪装成 DXOS_ERR_INTERNAL。
 */
function toSkillError(error) {
  if (!error || typeof error !== "object") return error;
  if (error.code === "AGENT_DEPENDENCY_UNAVAILABLE") {
    const reason = typeof error.detail === "string" && error.detail ? error.detail : String(error.message || "") || null;
    return createSkillError(SKILL_ERR_DEPENDENCY_UNAVAILABLE, (error && error.message) || "技能依赖不可用", { dependency: error.dependency || null, causeCode: error.code, reason });
  }
  return error;
}

/** 载荷 → ZIP Buffer；只认显式字段，不猜路径。 */
function archiveBuffer(payload, field) {
  const raw = payload[field] !== undefined ? payload[field] : payload.archiveBase64 !== undefined ? payload.archiveBase64 : payload.archive;
  let buffer;
  if (Buffer.isBuffer(raw)) buffer = raw;
  else if (raw instanceof Uint8Array) buffer = Buffer.from(raw);
  else if (Array.isArray(raw) && raw.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) buffer = Buffer.from(raw);
  else if (typeof raw === "string" && raw.length) {
    const base64 = raw.startsWith("data:") && raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
    buffer = Buffer.from(base64, "base64");
  } else {
    throw createSkillError(SKILL_ERR_INVALID_INPUT, "需要技能包 ZIP 的 base64 或字节数组载荷（字段：archiveBase64 / data）");
  }
  if (!buffer.length) throw createSkillError(SKILL_ERR_INVALID_INPUT, "技能包 ZIP 为空");
  if (buffer.length > MAX_ARCHIVE_BYTES) throw createSkillError(SKILL_ERR_INVALID_INPUT, "技能包超过 " + MAX_ARCHIVE_BYTES + " 字节上限");
  return buffer;
}

/** 技能来源文本：优先显式 markdown，其次技能自身的 source.instructions。 */
function skillSourceText(payload) {
  const explicit = requireStr(payload.markdown, 64000);
  if (explicit) return explicit;
  const skillId = requireStr(payload.skillId, 160);
  if (!skillId) throw createSkillError(SKILL_ERR_INVALID_INPUT, "skill/analyze 需要 markdown 或 skillId");
  const skill = skillStore.listSkills().find((item) => item.id === skillId);
  if (!skill) throw createSkillError(SKILL_ERR_NOT_FOUND, "技能不存在：" + skillId);
  const instructions = skill.source && skill.source.instructions ? skill.source.instructions : skill.systemPrompt;
  if (!instructions) throw createSkillError(SKILL_ERR_INVALID_INPUT, "技能没有可分析的源文档：" + skillId);
  return String(instructions).slice(0, 64000);
}

/** 从已注册技能 / 技能包重建可再次导入的 ZIP（只用内存快照，不遍历任意磁盘路径）。 */
function exportArchive(payload) {
  const skillId = requireStr(payload.skillId, 160);
  const packId = requireStr(payload.packId, 160);
  if (!skillId && !packId) throw createSkillError(SKILL_ERR_INVALID_INPUT, "skill/pack/export 需要 skillId 或 packId");
  const all = skillStore.listSkills();
  let chosen;
  if (skillId) {
    const one = all.find((item) => item.id === skillId);
    if (!one) throw createSkillError(SKILL_ERR_NOT_FOUND, "技能不存在：" + skillId);
    chosen = [one];
  } else {
    chosen = all.filter((item) => item.source && item.source.metadata && item.source.metadata.packId === packId);
    if (!chosen.length) throw createSkillError(SKILL_ERR_NOT_FOUND, "技能包内没有已注册技能：" + packId);
  }
  const entries = [];
  for (const skill of chosen) {
    const prefix = chosen.length > 1 ? skill.id + "/" : "";
    const source = skill.source || {};
    const instructions = source.instructions || skill.systemPrompt || "";
    entries.push({ name: prefix + "SKILL.md", data: Buffer.from(String(instructions), "utf8") });
    for (const file of Array.isArray(source.files) ? source.files : []) {
      const rel = String(file && file.path ? file.path : "").replace(/\\/g, "/").replace(/^\/+/, "");
      if (!rel || rel.includes("..") || rel.startsWith("/")) continue;
      entries.push({ name: prefix + rel, data: Buffer.from(String((file && file.content) || ""), "utf8") });
    }
  }
  const buffer = skillImport.buildZip(entries);
  if (buffer.length > MAX_EXPORT_BYTES) throw createSkillError(SKILL_ERR_INVALID_INPUT, "导出内容超过 " + MAX_EXPORT_BYTES + " 字节上限");
  return {
    fileName: (packId ? "skill-pack-" + packId : "skill-" + skillId) + ".zip",
    base64: buffer.toString("base64"),
    bytes: buffer.length,
    skillCount: chosen.length,
    entries: entries.length,
  };
}

/**
 * 工具目录 skill 来源（agent-tool-catalog.cjs:134-138 / :360-387 的契约：{ list(), call() }）。
 * list() 必须是同步的（catalog 的 sourceList 不 await），所以只能给内存快照：
 *   · 首选 skill-store.listSkills()（目录需要 id/enabled/exposure/v2 才能补 installedSkillStatus）；
 *   · agentSkillTools() 的 OpenAI 函数定义无法满足该目录契约，仅作为没有 listSkills 时的兜底。
 * call() 转交 skill-runner.runSkill(id, args, opts)。
 */
function createSkillCatalogSource() {
  return {
    list: () => (typeof skillStore.listSkills === "function" ? skillStore.listSkills() : (typeof skillStore.agentSkillTools === "function" ? skillStore.agentSkillTools() : [])),
    call: (skillId, args, ctx) => skillRunner.runSkill(String(skillId), args, ctx && typeof ctx === "object" ? ctx : {}),
  };
}

/**
 * 装配技能域 bundle。
 * 额外注入 providerAdapter / modelAdapter / cliRuntime / mediaAdapter / fsAdapter 供执行器使用；
 * 未注入即保持结构化依赖缺失（见 skill-runner.cjs:176-206）。
 * B6d：fsAdapter 只喂 skillRunner（产物落盘 saveImagesToFs / saveAudiosToFs / saveVideosToFs）；
 * 技能目录 / 技能包 / 工作空间的 fsImpl 仍是 node:fs（见下方第 1 节的注）。
 */
function createSkillBundle({ userDataDir, identityStore = null, authorization = null, providerAdapter = null, modelAdapter = null, cliRuntime = null, mediaAdapter = null, fsAdapter = null, onlineInstaller = null, logger = null, clock = null } = {}) {
  const now = typeof clock === "function" ? clock : () => Date.now();
  const paths = userDataDir ? resolveDxosPaths(userDataDir) : null;
  const dataDir = paths ? paths.root : null;
  const db = (identityStore && (identityStore.connection || identityStore.db)) || null;
  // 目录只创建、不写文件；失败不阻断装配（各域落盘时再抛结构化错误）。
  if (userDataDir) { try { ensureDxosLayout(userDataDir); } catch { /* 保留真实落盘错误给具体命令 */ } }

  // ---- 1) 技能目录：显式 dataDir（<userData>/dxos）+ 注入 providerAdapter ----
  //      skill-store.cjs:93-101 configureSkillStore 只认这些键；providerAdapter 必须显式传 null 以清空。
  //      B6d 注：fsAdapter 是 DX 虚拟文件树，不是 node:fs 替身 —— skill-store /
  //      skillWorkspace / skillPack 的 fsImpl 只接受 node:fs 形状（readFileSync / mkdirSync 等），
  //      混用只会把 DX 适配器的键并进 nodeFs 对象（静默无效）。所以 fsAdapter 只喂 skillRunner，
  //      这三处继续用默认 node:fs（技能目录 / 包 / 工作空间落在 <userData>/dxos 真实文件里，语义不变）。
  if (dataDir) {
    skillStore.configureSkillStore({ dataDir: dataDir, providerAdapter: providerAdapter || null, clock: now });
  } else {
    skillStore.configureSkillStore({ providerAdapter: providerAdapter || null, clock: now });
  }

  // ---- 2) 单技能导入：把同一个技能存储注入 skill-import.cjs:65-71 ----
  skillImport.configureSkillImport({ skillStore: skillStore });

  // ---- 3) 工作空间：先装配，再作为 skill-pack 的 agentWorkspace 端口注入 ----
  skillWorkspace.configureSkillWorkspace({ db: db, skillStore: skillStore, clock: now, logger: logger });
  const agentWorkspaceAdapter = {
    registerAgentWorkspace: (pack, root) => skillWorkspace.registerAgentWorkspace(pack, root),
    deleteAgentWorkspaceProfiles: (ids) => skillWorkspace.deleteAgentWorkspaceProfiles(ids),
    deleteAgentWorkspaceProfilesForPack: (packId) => skillWorkspace.deleteAgentWorkspaceProfilesForPack(packId),
  };

  // ---- 4) 技能包：<userData> + <userData>/dxos + 同一份技能存储 / 工作空间 ----
  //      skill-pack.cjs:121-128 configureSkillPack 白名单键；skillStore 会同步下发给 skill-import。
  skillPack.configureSkillPack({
    userDataDir: userDataDir || undefined,
    dataDir: dataDir || undefined,
    skillStore: skillStore,
    providerAdapter: providerAdapter || null,
    // 始终注入：没有多 Agent 工作空间时 registerAgentWorkspace 返回 null（skill-workspace.cjs:254-256），
    // 不依赖 db；真正检测到工作空间而 db 缺失时才由 skill-workspace.cjs:91-94 抛结构化依赖错误。
    agentWorkspace: agentWorkspaceAdapter,
    clock: now,
    logger: logger,
    // task-25 D09：ModelScope 在线安装器只接受显式注入；未注入时 importOnlineSkillPack 结构化依赖缺失。
    runner: onlineInstaller || null,
  });

  // ---- 5) 执行器 / 分析器：模型出口、CLI、媒体、虚拟文件树 ----
  skillRunner.configureSkillRunner({ skillStore: skillStore, providerAdapter: providerAdapter || null, modelAdapter: modelAdapter || null, cliRuntime: cliRuntime || null, mediaAdapter: mediaAdapter || null, fsAdapter: fsAdapter || null, clock: now, logger: logger });
  skillAnalyzer.configureSkillAnalyzer({ modelAdapter: modelAdapter || null, skillStore: skillStore, providerAdapter: providerAdapter || null, clock: now, logger: logger });

  // ---- 6) 下行事件（P1 信封；bootstrap 的 send 经 setEventSink 注入） ----
  const { createEventChannel } = require("./dxos-foundation-events.cjs");
  const channel = createEventChannel({ domain: skillDomain.SKILL_EVENT_DOMAIN, clock: now });
  let eventSink = null;
  function setEventSink(fn) { eventSink = typeof fn === "function" ? fn : null; return true; }
  function emit(kind, payload) {
    const event = channel.emit(kind, payload);
    if (eventSink) { try { eventSink(event); } catch { /* 事件推送失败不改变业务结果 */ } }
    return event;
  }

  const dependencies = Object.freeze({
    userDataDir: !!userDataDir,
    dataDir: !!dataDir,
    skillStore: true,
    skillImport: true,
    skillPack: true,
    onlineInstaller: !!onlineInstaller,
    skillRunner: true,
    skillAnalyzer: true,
    skillWorkspace: !!db,
    // 键名避开 isSecretKey 的 provider/credential 子串（dxos-foundation-mask.cjs:12）。
    chatTarget: !!providerAdapter,
    // B4 接线：显式反映 provider-adapter-bridge.cjs 只读桥是否装配（布尔，不含任何密钥值）。
    providerAdapter: !!providerAdapter,
    modelCall: !!modelAdapter,
    cliRuntime: !!cliRuntime,
    mediaAdapter: !!mediaAdapter,
    fsAdapter: !!fsAdapter,
  });

  /** sessionRef → actor；不可解析时返回 { ok:false }，绝不伪造身份。 */
  function resolveActor(context) {
    if (!authorization || typeof authorization.resolveActor !== "function") return { ok: false, message: "授权服务未装配" };
    try {
      const result = authorization.resolveActor({ context });
      if (!result || result.ok !== true || !result.user || result.user.id == null) return { ok: false, message: (result && (result.error || result.reason)) || "会话无效" };
      return result;
    } catch (error) {
      return { ok: false, message: String((error && error.message) || error) };
    }
  }

  /** 命令分发。失败一律 throw（由 execute 统一规约），成功返回原始值（由 execute 统一脱敏）。 */
  async function dispatch(command, payload, context) {
    const userId = context.userId;
    switch (command) {
      // ---------------- 技能目录 ----------------
      case "skill/list": {
        return { items: skillStore.listSkills() };
      }
      case "skill/get": {
        const id = requireStr(payload.skillId, 160) || requireStr(payload.id, 160);
        if (!id) throw createSkillError(SKILL_ERR_INVALID_INPUT, "skillId 必填");
        const skill = skillStore.listSkills().find((item) => item.id === id);
        if (!skill) throw createSkillError(SKILL_ERR_NOT_FOUND, "技能不存在：" + id);
        return { skill };
      }
      case "skill/enable":
      case "skill/disable": {
        const id = requireStr(payload.skillId, 160) || requireStr(payload.id, 160);
        if (!id) throw createSkillError(SKILL_ERR_INVALID_INPUT, "skillId 必填");
        const updated = skillStore.setSkillEnabled(id, command === "skill/enable");
        if (!updated) throw createSkillError(SKILL_ERR_NOT_FOUND, "技能不存在：" + id);
        return { skill: updated };
      }
      case "skill/save": {
        const input = payload.skill && typeof payload.skill === "object" ? payload.skill : payload;
        return { skill: skillStore.saveCustomSkill(input) };
      }
      case "skill/delete": {
        const id = requireStr(payload.skillId, 160) || requireStr(payload.id, 160);
        if (!id) throw createSkillError(SKILL_ERR_INVALID_INPUT, "skillId 必填");
        return { skillId: id, deleted: skillStore.deleteCustomSkill(id) };
      }

      // ---------------- 执行 / 分析 ----------------
      case "skill/run": {
        const id = requireStr(payload.skillId, 160) || requireStr(payload.id, 160);
        if (!id) throw createSkillError(SKILL_ERR_INVALID_INPUT, "skillId 必填");
        const args = payload.arguments && typeof payload.arguments === "object" ? payload.arguments : payload.args && typeof payload.args === "object" ? payload.args : {};
        const options = payload.options && typeof payload.options === "object" ? payload.options : {};
        return await skillRunner.runSkill(id, args, Object.assign({ userId: userId, rootId: requireStr(payload.rootId, 160) || undefined, providerId: requireStr(payload.providerId, 120) || undefined, model: requireStr(payload.model, 200) || undefined }, options));
      }
      case "skill/analyze": {
        const result = await skillAnalyzer.analyzeSkillDocument(skillSourceText(payload), requireStr(payload.sourceName, 200) || undefined);
        return result;
      }

      // ---------------- 技能包 ----------------
      case "skill/pack/list": {
        return { items: skillPack.listSkillPacks() };
      }
      case "skill/pack/install": {
        // task-25 D09：在线安装复用 install 命令（不扩前端冻结白名单）；缺安装器即结构化缺失。
        if (payload.onlineSource != null) return skillPack.importOnlineSkillPack(requireStr(payload.onlineSource, 12000));
        return skillPack.importRegisteredSkillPack(archiveBuffer(payload, "archiveBase64"), requireStr(payload.sourceName, 200) || "skill-pack.zip");
      }
      case "skill/pack/import": {
        const options = {
          packId: requireStr(payload.packId, 160) || undefined,
          packName: requireStr(payload.packName, 200) || undefined,
          idPrefix: requireStr(payload.idPrefix, 40) || undefined,
        };
        return skillImport.importSkillPackage(archiveBuffer(payload, "archiveBase64"), options);
      }
      case "skill/pack/export": {
        return exportArchive(payload);
      }
      case "skill/pack/uninstall": {
        const id = requireStr(payload.packId, 160) || requireStr(payload.id, 160);
        if (!id) throw createSkillError(SKILL_ERR_INVALID_INPUT, "packId 必填");
        if (!skillPack.deleteSkillPack(id)) throw createSkillError(SKILL_ERR_NOT_FOUND, "技能包不存在：" + id);
        return { packId: id, deleted: true };
      }

      // ---------------- 工作区 / 健康 ----------------
      case "skill/workspace/list": {
        const packId = requireStr(payload.packId, 160);
        if (packId) return { packId: packId, items: skillWorkspace.listAgentWorkspaceProfiles(packId) };
        const packs = skillPack.listSkillPacks();
        const items = [];
        for (const pack of packs) {
          for (const profile of skillWorkspace.listAgentWorkspaceProfiles(pack.id)) items.push(Object.assign({ packId: pack.id }, profile));
        }
        return { items: items };
      }
      case "skill/health": {
        return { status: dependencies.skillWorkspace ? "ok" : "degraded", dependencies: dependencies, commands: skillDomain.listSkillCommands().length, eventChannel: SKILL_EVENT_CHANNEL };
      }

      default: throw skillCommandNotAllowed(command);
    }
  }

  /**
   * 唯一分发入口：白名单 → actor 解析 → dispatch → 脱敏；失败统一 normalizeSkillError。
   * 每次执行前后各发一条 progress 事件（P1 信封），供渲染层显示与丢帧判定。
   */
  async function execute(command, payload, ctx = {}) {
    if (!isSkillCommand(command)) return normalizeSkillError(skillCommandNotAllowed(command));
    const context = {
      sessionRef: requireStr(ctx && ctx.sessionRef, 160) || null,
      appId: requireStr(ctx && ctx.appId, 60) || HOST_APP_ID,
      source: "skill",
      requestId: requireStr(ctx && ctx.requestId, 100) || null,
    };
    emit("progress", { command: command, phase: "begin", requestId: context.requestId });
    const actorResult = resolveActor(context);
    if (!actorResult.ok) {
      emit("progress", { command: command, phase: "rejected", reason: "unauthenticated", requestId: context.requestId });
      return normalizeSkillError(createSkillError(SKILL_ERR_UNAUTHENTICATED, actorResult.message || "当前会话未认证，skill 命令被拒绝"));
    }
    context.userId = String(actorResult.user.id);
    context.actor = actorResult.user;
    const body = payload && typeof payload === "object" ? payload : {};
    try {
      const value = await dispatch(command, body, context);
      emit("progress", { command: command, phase: "completed", requestId: context.requestId });
      return { ok: true, value: redactSkillValue(value) };
    } catch (error) {
      emit("progress", { command: command, phase: "failed", requestId: context.requestId });
      return normalizeSkillError(toSkillError(error));
    }
  }

  const skillSource = Object.freeze(createSkillCatalogSource());

  return {
    execute,
    setEventSink,
    emitEvent: emit,
    /** 工具目录 skill 来源（agent-service.cjs 接线用；同步 list + runSkill 调用）。 */
    skillSource,
    /** 供 agent 运行时的函数定义投影（skill-store.cjs:692-703）。 */
    agentSkillTools: () => skillStore.agentSkillTools(),
    /** 只读依赖清单（供 health 与测试；不含任何路径 / 凭据值）。 */
    dependencies,
    paths: dataDir ? { root: dataDir } : null,
  };
}

module.exports = { createSkillBundle, HOST_APP_ID, MAX_ARCHIVE_BYTES, MAX_EXPORT_BYTES };
