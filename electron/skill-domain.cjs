"use strict";
/**
 * B4 · 技能域纯逻辑（无 I/O）：命令白名单 + 风险/凭据属性 + 结果脱敏与错误规约。
 *
 * 为什么单独一层：skill:command 是本轮新增的顶层 IPC 通道，"哪些命令可被渲染层调用、
 * 每条命令的风险等级、是否触碰凭据、失败时回什么码"必须先在一处冻结，再交给
 * electron/skill-service.cjs 分发、electron/skill-bootstrap.cjs 注册。命令表本身即白名单：
 * 未登记的命令一律 SKILL_COMMAND_NOT_ALLOWED，不做动态 dispatch。
 *
 * 脱敏/错误规约复用 electron/dxos-foundation-errors.cjs 的既有实现
 * （redactText / redactValue / normalizeError 同源），保证 skill 域的失败形状与
 * agent / model / task / provider-protocol 各域一致，不产生第二套错误协议。
 *
 * 参照：electron/agent-domain.cjs:1-196（同形实现）、
 *       electron/provider-protocol-domain.cjs:34-71（PROTOCOL_COMMANDS / RISK_LEVELS）。
 */
const foundationErrors = require("./dxos-foundation-errors.cjs");

/** 下行事件通道：与 preload 的 skill.onEvent / main.cjs 的 send 同名。 */
const SKILL_EVENT_CHANNEL = "skill:event";
const SKILL_EVENT_DOMAIN = "skill";

/** 技能域自有错误码。与 DXOS_* / AGENT_* 并列，不合并（域边界清晰，便于渲染层稳定判别）。 */
const SKILL_ERR_COMMAND_NOT_ALLOWED = "SKILL_COMMAND_NOT_ALLOWED";
const SKILL_ERR_INVALID_INPUT = "SKILL_INVALID_INPUT";
const SKILL_ERR_UNAUTHENTICATED = "SKILL_UNAUTHENTICATED";
const SKILL_ERR_FORBIDDEN = "SKILL_FORBIDDEN";
const SKILL_ERR_NOT_FOUND = "SKILL_NOT_FOUND";
const SKILL_ERR_CONFLICT = "SKILL_CONFLICT";
const SKILL_ERR_DEPENDENCY_UNAVAILABLE = "SKILL_DEPENDENCY_UNAVAILABLE";
const SKILL_ERR_INTERNAL = "SKILL_INTERNAL";

const SKILL_ERROR_CODES = Object.freeze([
  SKILL_ERR_COMMAND_NOT_ALLOWED,
  SKILL_ERR_INVALID_INPUT,
  SKILL_ERR_UNAUTHENTICATED,
  SKILL_ERR_FORBIDDEN,
  SKILL_ERR_NOT_FOUND,
  SKILL_ERR_CONFLICT,
  SKILL_ERR_DEPENDENCY_UNAVAILABLE,
  SKILL_ERR_INTERNAL,
]);

/**
 * skill:command 白名单。
 *   risk       read | use | manage | destructive（与 agent-domain.cjs:97 同级定义）
 *   credential 该命令是否会把真实凭据（模型 Key / 外部站点）带进执行路径
 *   summary    中文一句话，供 UI（技能中心 / 工具面板）与审计展示
 * 覆盖任务书要求的 command 族：技能目录 / 执行 / 分析 / 技能包 / 工作区 / 健康检查。
 */
const SKILL_COMMANDS = Object.freeze({
  // ---- 技能目录（skill-store.cjs） ----
  "skill/list": { risk: "read", credential: false, summary: "列出全部技能（内置 + 自定义）与启用状态" },
  "skill/get": { risk: "read", credential: false, summary: "读取单个技能的详情与来源快照" },
  "skill/enable": { risk: "manage", credential: false, summary: "启用一个技能（写入 skills.json）" },
  "skill/disable": { risk: "manage", credential: false, summary: "停用一个技能（保留定义，可再次启用）" },
  "skill/save": { risk: "manage", credential: false, summary: "新建或更新一个文本型/工作流技能" },
  "skill/delete": { risk: "destructive", credential: false, summary: "删除一个自定义技能（内置技能只能停用）" },

  // ---- 执行 / 分析（skill-runner.cjs / skill-analyzer.cjs，触碰模型站点凭据） ----
  "skill/run": { risk: "use", credential: true, summary: "执行一个技能（真实模型调用，需权限）" },
  "skill/analyze": { risk: "use", credential: true, summary: "用模型解析技能文档并生成 v2 工作流定义" },

  // ---- 技能包（skill-pack.cjs / skill-import.cjs） ----
  "skill/pack/list": { risk: "read", credential: false, summary: "列出已安装的技能包与包内文档" },
  "skill/pack/install": { risk: "manage", credential: false, summary: "安装一个完整技能包并注册包内路由技能" },
  "skill/pack/import": { risk: "manage", credential: false, summary: "从 ZIP 导入单个/多个功能技能到技能目录" },
  "skill/pack/export": { risk: "read", credential: false, summary: "把技能或技能包导出为可再次导入的 ZIP" },
  "skill/pack/uninstall": { risk: "destructive", credential: false, summary: "卸载技能包并清理其注册的技能" },

  // ---- 工作区 / 健康 ----
  "skill/workspace/list": { risk: "read", credential: false, summary: "列出技能关联的 Agent 工作区资料" },
  "skill/health": { risk: "read", credential: false, summary: "技能域依赖装配健康检查" },
});

/** 风险等级序（数值越大越危险）；UI 排序 / 审批阈值使用。 */
const RISK_LEVELS = Object.freeze({ read: 0, use: 1, manage: 2, destructive: 3 });

function isSkillCommand(command) {
  return typeof command === "string" && Object.prototype.hasOwnProperty.call(SKILL_COMMANDS, command);
}

function skillCommandEntry(command) {
  return isSkillCommand(command) ? SKILL_COMMANDS[command] : null;
}

/** 未知命令返回 null（调用方据此判 SKILL_COMMAND_NOT_ALLOWED，不猜风险）。 */
function skillCommandRisk(command) {
  const entry = skillCommandEntry(command);
  return entry ? entry.risk : null;
}

function skillCommandRequiresCredential(command) {
  const entry = skillCommandEntry(command);
  return !!(entry && entry.credential);
}

/** 稳定顺序的命令清单（对象字面量声明顺序），供 UI 与测试消费。 */
function listSkillCommands() {
  return Object.keys(SKILL_COMMANDS).map((command) => ({ command, risk: SKILL_COMMANDS[command].risk, credential: SKILL_COMMANDS[command].credential, summary: SKILL_COMMANDS[command].summary }));
}

/** 构造带稳定 code 的技能域错误；message 过 foundation 的 redactText。 */
function createSkillError(code, message, detail) {
  const err = new Error(foundationErrors.redactText(message == null ? code : message));
  err.name = "SkillError";
  err.code = SKILL_ERROR_CODES.includes(code) ? code : SKILL_ERR_INTERNAL;
  err.detail = detail === undefined ? undefined : foundationErrors.redactValue(detail);
  return err;
}

function isSkillError(err) {
  return !!err && typeof err === "object" && typeof err.code === "string" && SKILL_ERROR_CODES.includes(err.code);
}

/** 任意值与返回值脱敏：直接复用 foundation 的深度封顶 + 密钥字段掩码 + 绝对路径替换。 */
function redactSkillValue(value) {
  return foundationErrors.redactValue(value);
}

/**
 * 技能域错误 → 渲染层安全结果。
 *   · 命中 SKILL_* 码：保留码与（脱敏后的）消息；
 *   · 其余交给 foundation.normalizeError（未知异常折叠成 DXOS_ERR_INTERNAL，原始 err.code 进 detail.causeCode）。
 * 形状与 foundation 一致：{ ok:false, error, message, detail? }。
 */
function normalizeSkillError(err) {
  if (isSkillError(err)) {
    const out = { ok: false, error: err.code, message: foundationErrors.redactText(err.message || err.code) || err.code };
    if (err.detail !== undefined) out.detail = foundationErrors.redactValue(err.detail);
    return out;
  }
  return foundationErrors.normalizeError(err, { fallbackCode: foundationErrors.DXOS_ERR_INTERNAL });
}

function skillCommandNotAllowed(command) {
  return createSkillError(SKILL_ERR_COMMAND_NOT_ALLOWED, "未知或未授权的 skill 命令：" + String(command == null ? "" : command), { command: command == null ? null : String(command) });
}

/** 渲染层出口：成功 { ok:true, value }；失败 normalizeSkillError（与 foundation.toIpcResult 同形）。 */
async function toSkillIpcResult(action) {
  try {
    const value = typeof action === "function" ? await action() : await action;
    return { ok: true, value: redactSkillValue(value) };
  } catch (err) {
    return normalizeSkillError(err);
  }
}

module.exports = {
  SKILL_EVENT_CHANNEL,
  SKILL_EVENT_DOMAIN,
  SKILL_COMMANDS,
  SKILL_ERROR_CODES,
  SKILL_ERR_COMMAND_NOT_ALLOWED,
  SKILL_ERR_INVALID_INPUT,
  SKILL_ERR_UNAUTHENTICATED,
  SKILL_ERR_FORBIDDEN,
  SKILL_ERR_NOT_FOUND,
  SKILL_ERR_CONFLICT,
  SKILL_ERR_DEPENDENCY_UNAVAILABLE,
  SKILL_ERR_INTERNAL,
  RISK_LEVELS,
  isSkillCommand,
  skillCommandEntry,
  skillCommandRisk,
  skillCommandRequiresCredential,
  listSkillCommands,
  createSkillError,
  isSkillError,
  redactSkillValue,
  normalizeSkillError,
  skillCommandNotAllowed,
  toSkillIpcResult,
};
