"use strict";
/**
 * B3 · Agent 域纯逻辑（无 I/O）：命令白名单 + 风险/凭据属性 + 结果脱敏与错误规约。
 *
 * 为什么单独一层：agent:command 是本轮唯一新增的顶层 IPC 通道，"哪些命令可被渲染层调用、
 * 每条命令的风险等级、是否触碰凭据、失败时回什么码"必须先在一处冻结，再交给
 * electron/agent-service.cjs 分发、electron/agent-bootstrap.cjs 注册。命令表本身即白名单：
 * 未登记的命令一律 AGENT_COMMAND_NOT_ALLOWED，不做动态 dispatch。
 *
 * 脱敏/错误规约复用 electron/dxos-foundation-errors.cjs 的既有实现
 * （redactText / redactValue / normalizeError 同源），保证 agent 域的失败形状与
 * model / task / provider-protocol 各域一致，不产生第二套错误协议。
 *
 * 参照：electron/provider-protocol-domain.cjs:34-71（PROTOCOL_COMMANDS / RISK_LEVELS）。
 */
const foundationErrors = require("./dxos-foundation-errors.cjs");

/** 下行事件通道：与 preload 的 agent.onEvent / main.cjs 的 send 同名。 */
const AGENT_EVENT_CHANNEL = "agent:event";
const AGENT_EVENT_DOMAIN = "agent";

/** Agent 域自有错误码。与 DXOS_* 并列，不合并（域边界清晰，便于渲染层稳定判别）。 */
const AGENT_ERR_COMMAND_NOT_ALLOWED = "AGENT_COMMAND_NOT_ALLOWED";
const AGENT_ERR_INVALID_INPUT = "AGENT_INVALID_INPUT";
const AGENT_ERR_UNAUTHENTICATED = "AGENT_UNAUTHENTICATED";
const AGENT_ERR_FORBIDDEN = "AGENT_FORBIDDEN";
const AGENT_ERR_NOT_FOUND = "AGENT_NOT_FOUND";
const AGENT_ERR_CONFLICT = "AGENT_CONFLICT";
const AGENT_ERR_DEPENDENCY_UNAVAILABLE = "AGENT_DEPENDENCY_UNAVAILABLE";
const AGENT_ERR_INTERNAL = "AGENT_INTERNAL";
/** 运行期内核依赖缺失时（agent-kernel / agent-runtime-deps）抛出的既有码，这里复用同一字面量。 */
const AGENT_KERNEL_DEPENDENCY_UNAVAILABLE = "AGENT_DEPENDENCY_UNAVAILABLE";

const AGENT_ERROR_CODES = Object.freeze([
  AGENT_ERR_COMMAND_NOT_ALLOWED,
  AGENT_ERR_INVALID_INPUT,
  AGENT_ERR_UNAUTHENTICATED,
  AGENT_ERR_FORBIDDEN,
  AGENT_ERR_NOT_FOUND,
  AGENT_ERR_CONFLICT,
  AGENT_ERR_DEPENDENCY_UNAVAILABLE,
  AGENT_ERR_INTERNAL,
]);

/**
 * agent:command 白名单。
 *   risk       read | use | manage | destructive（与 provider-protocol-domain.cjs:61 同级定义）
 *   credential 该命令是否会把真实凭据带进执行路径（model / 外部工具 / 站点调用）
 *   summary    中文一句话，供 UI（菜单 / 工具面板）与审计展示
 * 覆盖任务书要求的 task / run / tool / capability / project / memory / react / health 八族。
 */
const AGENT_COMMANDS = Object.freeze({
  // ---- task：DX 任务域状态机（agent-task-store.cjs） ----
  "agent/task/create": { risk: "use", credential: false, summary: "在项目内创建一个 Agent 任务并进入队列" },
  "agent/task/list": { risk: "read", credential: false, summary: "列出当前用户可见的项目任务" },
  "agent/task/get": { risk: "read", credential: false, summary: "读取单个任务的安全投影（含步骤/事件/交付物）" },
  "agent/task/events": { risk: "read", credential: false, summary: "按 sequence 增量拉取任务事件" },
  "agent/task/answer": { risk: "use", credential: false, summary: "回答等待中的任务提问并重新入队" },
  "agent/task/continue": { risk: "use", credential: false, summary: "向已停止的 react 任务追加要求" },
  "agent/task/pause": { risk: "manage", credential: false, summary: "暂停任务（保留可续接状态）" },
  "agent/task/cancel": { risk: "destructive", credential: false, summary: "取消任务并终结其运行" },
  "agent/task/resume": { risk: "use", credential: false, summary: "恢复中断/暂停的任务" },
  "agent/task/delete": { risk: "destructive", credential: false, summary: "删除任务记录" },
  "agent/task/trace": { risk: "read", credential: false, summary: "任务执行轨迹（步数/耗时/错误码）" },
  "agent/task/stats": { risk: "read", credential: false, summary: "跨任务聚合统计（状态/模式/用量）" },

  // ---- run：Agent Run 持久化与巡检（agent-kernel-store / agent-kernel-inspection） ----
  "agent/run/get": { risk: "read", credential: false, summary: "读取单个 Agent Run" },
  "agent/run/inspect": { risk: "read", credential: false, summary: "巡检 Agent Run 子树（用量/产物/评审）" },
  "agent/run/list": { risk: "read", credential: false, summary: "列出当前用户的 Agent Run" },

  // ---- tool：工具目录 / 描述 / 调用（agent-tool-catalog / agent-tool-resolver / agent-builtin-tools） ----
  "agent/tool/catalog": { risk: "read", credential: false, summary: "工具目录快照（descriptors/tools/summary）" },
  "agent/tool/describe": { risk: "read", credential: false, summary: "解析单个工具的描述与权限判定" },
  "agent/tool/call": { risk: "use", credential: true, summary: "执行一个已登记工具（真实副作用，需权限）" },

  // ---- capability：路由（capability-router.cjs） ----
  "agent/capability/route": { risk: "read", credential: false, summary: "按指令路由模型与可用能力工具" },

  // ---- project：项目与快照（agent-task-store / agent-project-snapshot） ----
  "agent/project/create": { risk: "manage", credential: false, summary: "创建 DX 项目并绑定根节点" },
  "agent/project/list": { risk: "read", credential: false, summary: "列出当前用户的项目" },
  "agent/project/snapshot": { risk: "manage", credential: false, summary: "把项目快照写入工作区（依赖 B6 虚拟文件树）" },
  // B4 收口：项目级 Agent 模式（project-agent-mode.cjs）的唯一 IPC 入口。
  // 一次运行会经能力发现→工具执行→完成验收调用模型与工具，因此 risk=use、credential=true。
  "agent/project/run": { risk: "use", credential: true, summary: "在项目内运行一轮项目级 Agent（能力发现→工具执行→完成验收）" },

  // ---- memory：项目记忆（agent-task-store） ----
  "agent/memory/list": { risk: "read", credential: false, summary: "列出项目记忆（可选含被取代版本）" },
  "agent/memory/save": { risk: "manage", credential: false, summary: "写入/取代一条项目记忆" },

  // ---- react：React 驱动（agent-react-driver.cjs） ----
  "agent/react/run": { risk: "use", credential: true, summary: "驱动一个 react 任务的执行循环" },

  // ---- health ----
  "agent/health": { risk: "read", credential: false, summary: "Agent 域依赖装配健康检查" },
});

/** 风险等级序（数值越大越危险）；UI 排序 / 审批阈值使用。 */
const RISK_LEVELS = Object.freeze({ read: 0, use: 1, manage: 2, destructive: 3 });

function isAgentCommand(command) {
  return typeof command === "string" && Object.prototype.hasOwnProperty.call(AGENT_COMMANDS, command);
}

function agentCommandEntry(command) {
  return isAgentCommand(command) ? AGENT_COMMANDS[command] : null;
}

/** 未知命令返回 null（调用方据此判 AGENT_COMMAND_NOT_ALLOWED，不猜风险）。 */
function agentCommandRisk(command) {
  const entry = agentCommandEntry(command);
  return entry ? entry.risk : null;
}

function agentCommandRequiresCredential(command) {
  const entry = agentCommandEntry(command);
  return !!(entry && entry.credential);
}

/** 稳定顺序的命令清单（对象字面量声明顺序），供 UI 与测试消费。 */
function listAgentCommands() {
  return Object.keys(AGENT_COMMANDS).map((command) => ({ command, risk: AGENT_COMMANDS[command].risk, credential: AGENT_COMMANDS[command].credential, summary: AGENT_COMMANDS[command].summary }));
}

/** 构造带稳定 code 的 Agent 域错误；message 过 foundation 的 redactText。 */
function createAgentError(code, message, detail) {
  const err = new Error(foundationErrors.redactText(message == null ? code : message));
  err.name = "AgentError";
  err.code = AGENT_ERROR_CODES.includes(code) ? code : AGENT_ERR_INTERNAL;
  err.detail = detail === undefined ? undefined : foundationErrors.redactValue(detail);
  return err;
}

function isAgentError(err) {
  return !!err && typeof err === "object" && typeof err.code === "string" && AGENT_ERROR_CODES.includes(err.code);
}

/** 任意值与返回值脱敏：直接复用 foundation 的深度封顶 + 密钥字段掩码 + 绝对路径替换。 */
function redactAgentValue(value) {
  return foundationErrors.redactValue(value);
}

/**
 * Agent 域错误 → 渲染层安全结果。
 *   · 命中 AGENT_* 码：保留码与（脱敏后的）消息；
 *   · 其余交给 foundation.normalizeError（未知异常折叠成 DXOS_ERR_INTERNAL，原始 err.code 进 detail.causeCode）。
 * 形状与 foundation 一致：{ ok:false, error, message, detail? }。
 */
function normalizeAgentError(err) {
  if (isAgentError(err)) {
    const out = { ok: false, error: err.code, message: foundationErrors.redactText(err.message || err.code) || err.code };
    if (err.detail !== undefined) out.detail = foundationErrors.redactValue(err.detail);
    return out;
  }
  return foundationErrors.normalizeError(err, { fallbackCode: foundationErrors.DXOS_ERR_INTERNAL });
}

function agentCommandNotAllowed(command) {
  return createAgentError(AGENT_ERR_COMMAND_NOT_ALLOWED, "未知或未授权的 agent 命令：" + String(command == null ? "" : command), { command: command == null ? null : String(command) });
}

/** 渲染层出口：成功 { ok:true, value }；失败 normalizeAgentError（与 foundation.toIpcResult 同形）。 */
async function toAgentIpcResult(action) {
  try {
    const value = typeof action === "function" ? await action() : await action;
    return { ok: true, value: redactAgentValue(value) };
  } catch (err) {
    return normalizeAgentError(err);
  }
}

module.exports = {
  AGENT_EVENT_CHANNEL,
  AGENT_EVENT_DOMAIN,
  AGENT_COMMANDS,
  AGENT_ERROR_CODES,
  AGENT_KERNEL_DEPENDENCY_UNAVAILABLE,
  AGENT_ERR_COMMAND_NOT_ALLOWED,
  AGENT_ERR_INVALID_INPUT,
  AGENT_ERR_UNAUTHENTICATED,
  AGENT_ERR_FORBIDDEN,
  AGENT_ERR_NOT_FOUND,
  AGENT_ERR_CONFLICT,
  AGENT_ERR_DEPENDENCY_UNAVAILABLE,
  AGENT_ERR_INTERNAL,
  RISK_LEVELS,
  isAgentCommand,
  agentCommandEntry,
  agentCommandRisk,
  agentCommandRequiresCredential,
  listAgentCommands,
  createAgentError,
  isAgentError,
  redactAgentValue,
  normalizeAgentError,
  agentCommandNotAllowed,
  toAgentIpcResult,
};
