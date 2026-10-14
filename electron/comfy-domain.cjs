"use strict";
/**
 * B7e1 · ComfyUI 域纯逻辑（无 I/O）：错误规约 + 命令白名单 + 风险/凭据属性 + 结果脱敏。
 *
 * 为什么单独一层：comfy:command 是本轮新增的顶层 IPC 通道，"哪些命令可被渲染层调用、
 * 每条命令的风险等级、是否触碰凭据、失败时回什么码"必须先在一处冻结，再交给
 * electron/comfy-service.cjs 分发、electron/comfy-bootstrap.cjs 注册。
 * 命令表本身即白名单：未登记的命令一律 COMFY_COMMAND_NOT_ALLOWED，不做动态 dispatch。
 *
 * ## 来源（只读参照 DX OS 0.5.1 app.asar.unpacked/server）
 *   · comfyui.ts:42-46           默认安装根（COMFYUI_ROOT 覆盖 → 便携目录探测）
 *   · comfyui.ts:48-72           实例/配置形状（mode / gpu / port / baseUrl / lanHost / ssh*）
 *   · comfyui.ts:106-136         参数解析与实例归一化
 *   · comfyWorkflows.ts:17-25    字段 / 输出 / 能力 / 角色类型集合
 *   · comfyWorkflows.ts:173-209  运行记录与活动工作流快照形状
 *   · comfyBridge.ts:5-18        桥接扩展（__init__.py + web/dx-os-bridge.js + 安装说明）
 *
 * ## 与源不同的点（有意为之，硬约束驱动）
 *   · 源是 Windows 便携包（E:\\ComfyUI_windows_portable）且会 spawn python 常驻进程；
 *     本移植把"可选插件、默认关闭"放在最前面：未启用 / 本机缺 Python 或 ComfyUI 安装路径时，
 *     执行类命令一律结构化 COMFY_DEPENDENCY_UNAVAILABLE / INTEGRATION_UNAVAILABLE，并给出
 *     "缺什么 / 怎么装"，绝不假运行（源没有这个闸门，因为它默认假定本机已装好）。
 *   · 云发布 / 云更新 / api.dx-os.com / 云端实时房间一律 OUT（任务书硬约束）。源里的
 *     runninghub / tunnel / SSH 自动修复路径不移植；实例模式只保留 local / lan / remote。
 *
 * 脱敏/错误规约复用 electron/dxos-foundation-errors.cjs 的既有实现，保证 comfy 域的失败形状与
 * automation / platform / plugin / media 各域一致。
 *
 * 参照：electron/automation-domain.cjs:1-209、electron/media-domain.cjs（同形实现）。
 */

const foundationErrors = require("./dxos-foundation-errors.cjs");

/** 下行事件通道：与 preload 的 comfy.onEvent / main.cjs 的 send 同名。 */
const COMFY_EVENT_CHANNEL = "comfy:event";
const COMFY_EVENT_DOMAIN = "comfy";

/** comfy 域自有错误码。与 AUTOMATION_* / MEDIA_* / INTEGRATION_* 并列，不合并。 */
const COMFY_ERR_COMMAND_NOT_ALLOWED = "COMFY_COMMAND_NOT_ALLOWED";
const COMFY_ERR_INVALID_INPUT = "COMFY_INVALID_INPUT";
const COMFY_ERR_UNAUTHENTICATED = "COMFY_UNAUTHENTICATED";
const COMFY_ERR_FORBIDDEN = "COMFY_FORBIDDEN";
const COMFY_ERR_NOT_FOUND = "COMFY_NOT_FOUND";
const COMFY_ERR_CONFLICT = "COMFY_CONFLICT";
/**
 * 依赖缺失码：任务书要求"本机缺 Python / ComfyUI 安装路径"必须结构化，
 * 这里用本域码 COMFY_DEPENDENCY_UNAVAILABLE 承载（detail 里给出 missing + install）。
 * 同时登记 INTEGRATION_UNAVAILABLE：插件"默认关闭"这一闸门沿用它（与 B7c 插件域同码），
 * 渲染层因此能稳定区分"没启用"与"装了但依赖缺失"。
 */
const COMFY_ERR_DEPENDENCY_UNAVAILABLE = "COMFY_DEPENDENCY_UNAVAILABLE";
const COMFY_ERR_INTEGRATION_UNAVAILABLE = "INTEGRATION_UNAVAILABLE";
const COMFY_ERR_UNAVAILABLE = "COMFY_UNAVAILABLE";
const COMFY_ERR_TIMEOUT = "COMFY_TIMEOUT";
const COMFY_ERR_CANCELLED = "COMFY_CANCELLED";
const COMFY_ERR_CHILD_FAILED = "COMFY_CHILD_FAILED";
const COMFY_ERR_WORKFLOW_INVALID = "COMFY_WORKFLOW_INVALID";
const COMFY_ERR_INTERNAL = "COMFY_INTERNAL";

const COMFY_ERROR_CODES = Object.freeze([
  COMFY_ERR_COMMAND_NOT_ALLOWED,
  COMFY_ERR_INVALID_INPUT,
  COMFY_ERR_UNAUTHENTICATED,
  COMFY_ERR_FORBIDDEN,
  COMFY_ERR_NOT_FOUND,
  COMFY_ERR_CONFLICT,
  COMFY_ERR_DEPENDENCY_UNAVAILABLE,
  COMFY_ERR_INTEGRATION_UNAVAILABLE,
  COMFY_ERR_UNAVAILABLE,
  COMFY_ERR_TIMEOUT,
  COMFY_ERR_CANCELLED,
  COMFY_ERR_CHILD_FAILED,
  COMFY_ERR_WORKFLOW_INVALID,
  COMFY_ERR_INTERNAL,
]);

/**
 * comfy:command 白名单。
 *   risk       read | use | manage | destructive（与 automation-domain.cjs:118 同级定义）
 *   credential 该命令是否会把真实凭据带进执行路径（运行 / 启停远端实例会读站点地址与 SSH 凭据）
 *   summary    中文一句话，供 UI（ComfyUI 中心）与审计展示
 * 覆盖任务书要求的命令族：插件开关 / 依赖探测 / 实例监督 / 工作流解析导入 / 运行提交与取消。
 */
const COMFY_COMMANDS = Object.freeze({
  // ---- 插件开关 / 依赖探测（comfy-service.cjs） ----
  "comfy/health": { risk: "read", credential: false, summary: "ComfyUI 域健康：插件开关 / 依赖 / 工作流数 / 运行数 / 受监督 worker 装配" },
  "comfy/plugin/get": { risk: "read", credential: false, summary: "读取 ComfyUI 可选插件状态（默认关闭）" },
  "comfy/plugin/enable": { risk: "manage", credential: false, summary: "启用 ComfyUI 插件（启用后仍会单独校验本机依赖）" },
  "comfy/plugin/disable": { risk: "manage", credential: false, summary: "关闭 ComfyUI 插件（保留工作流与运行记录）" },
  "comfy/dependencies/probe": { risk: "read", credential: false, summary: "探测本机依赖：ComfyUI Python 运行时与安装路径（缺失时给出安装指引，不联网）" },
  "comfy/bridge/install": { risk: "manage", credential: false, summary: "把桥接扩展写到本机 ComfyUI/custom_nodes/dx_os_bridge（局域网 / 云端请用 archive 手动上传）" },
  "comfy/bridge/archive": { risk: "read", credential: false, summary: "打包桥接扩展 ZIP（base64），供局域网 / 云端手动上传" },

  // ---- 实例监督（本机 / 局域网 / 远端地址登记） ----
  "comfy/instances/list": { risk: "read", credential: false, summary: "列出已登记的 ComfyUI 实例（端口 / 模式 / 启用状态）" },
  "comfy/instances/save": { risk: "manage", credential: false, summary: "新增或更新一个 ComfyUI 实例（校验端口 / 地址 / 局域网主机名）" },
  "comfy/instances/delete": { risk: "destructive", credential: false, summary: "删除一个 ComfyUI 实例（不影响其它实例）" },
  "comfy/instances/start": { risk: "use", credential: false, summary: "受监督子进程启动本机 ComfyUI 实例（缺依赖时结构化拒绝）" },
  "comfy/instances/stop": { risk: "manage", credential: false, summary: "停止本机 ComfyUI 实例（按启动时记录的 pid，绝不误杀端口占用者）" },

  // ---- 工作流（随包目录 + 本地 JSON 导入 / 解析 / 参数映射） ----
  "comfy/workflows/list": { risk: "read", credential: false, summary: "列出全部 API 工作流（内置随包 + 本地导入）与 Agent 清单摘要" },
  "comfy/workflows/get": { risk: "read", credential: false, summary: "读取单个 API 工作流（含字段映射 / 输出 / 能力）" },
  "comfy/workflows/parse": { risk: "read", credential: false, summary: "解析并校验一段 ComfyUI API 工作流 JSON（节点 / 连接，纯离线）" },
  "comfy/workflows/import": { risk: "manage", credential: false, summary: "从本地 JSON 导入一个 API 工作流并校验字段 / 输出映射" },
  "comfy/workflows/save": { risk: "manage", credential: false, summary: "新建或更新工作流定义（名称 / 字段 / 输出 / 能力）" },
  "comfy/workflows/delete": { risk: "destructive", credential: false, summary: "删除一个本地导入的工作流（内置随包工作流不能删除）" },
  "comfy/workflows/agent-manifests": { risk: "read", credential: false, summary: "只读投影全部工作流的 Agent 能力清单（供工具目录消费）" },

  // ---- 运行（受监督子进程提交 ComfyUI 任务并回推进度） ----
  "comfy/run/start": { risk: "use", credential: true, summary: "提交一次工作流运行（真实调用 ComfyUI 实例，需权限；重活走受监督子进程）" },
  "comfy/run/get": { risk: "read", credential: false, summary: "读取单次运行记录（状态 / 进度 / 结果文件索引）" },
  "comfy/run/list": { risk: "read", credential: false, summary: "列出当前用户的运行记录（按更新时间倒序）" },
  "comfy/run/results": { risk: "read", credential: false, summary: "读取单次运行的结果索引（只回相对文件名与节点，不含绝对路径）" },
  "comfy/run/cancel": { risk: "manage", credential: false, summary: "取消一次运行中的 ComfyUI 任务（取消受监督子进程，绝不伪造完成）" },
});

/** 风险等级序（数值越大越危险）；UI 排序 / 审批阈值使用。 */
const RISK_LEVELS = Object.freeze({ read: 0, use: 1, manage: 2, destructive: 3 });

function isComfyCommand(command) {
  return typeof command === "string" && Object.prototype.hasOwnProperty.call(COMFY_COMMANDS, command);
}

function comfyCommandEntry(command) {
  return isComfyCommand(command) ? COMFY_COMMANDS[command] : null;
}

/** 未知命令返回 null（调用方据此判 COMFY_COMMAND_NOT_ALLOWED，不猜风险）。 */
function comfyCommandRisk(command) {
  const entry = comfyCommandEntry(command);
  return entry ? entry.risk : null;
}

function comfyCommandRequiresCredential(command) {
  const entry = comfyCommandEntry(command);
  return !!(entry && entry.credential);
}

/**
 * 稳定顺序的命令清单（对象字面量声明顺序），供 UI 与测试消费。
 * 注意：IPC 投影把 credential 改名为 needsCredential —— dxos-foundation-errors.redactValue
 * 会把任何含 "credential" 的键当密钥字段掩码（dxos-foundation-mask.cjs:12），
 * 直接回 credential 布尔值会变成 "****alse" 这种掩码串。内部表仍叫 credential。
 */
function listComfyCommands() {
  return Object.keys(COMFY_COMMANDS).map((command) => ({
    command,
    risk: COMFY_COMMANDS[command].risk,
    needsCredential: COMFY_COMMANDS[command].credential,
    summary: COMFY_COMMANDS[command].summary,
  }));
}

/** 构造带稳定 code 的 comfy 域错误；message 过 foundation 的 redactText。 */
function createComfyError(code, message, detail) {
  const err = new Error(foundationErrors.redactText(message == null ? code : message));
  err.name = "ComfyError";
  err.code = COMFY_ERROR_CODES.includes(code) ? code : COMFY_ERR_INTERNAL;
  err.detail = detail === undefined ? undefined : foundationErrors.redactValue(detail);
  return err;
}

function isComfyError(err) {
  return !!err && typeof err === "object" && typeof err.code === "string" && COMFY_ERROR_CODES.includes(err.code);
}

/** 任意值与返回值脱敏：直接复用 foundation 的深度封顶 + 密钥字段掩码 + 绝对路径替换。 */
function redactComfyValue(value) {
  return foundationErrors.redactValue(value);
}

/**
 * comfy 域错误 → 渲染层安全结果。
 *   · 命中 COMFY_* / INTEGRATION_UNAVAILABLE：保留码与（脱敏后的）消息；
 *   · 其余交给 foundation.normalizeError（未知异常折叠成 DXOS_ERR_INTERNAL）。
 */
function normalizeComfyError(err) {
  if (isComfyError(err)) {
    const out = { ok: false, error: err.code, message: foundationErrors.redactText(err.message || err.code) || err.code };
    if (err.detail !== undefined) out.detail = foundationErrors.redactValue(err.detail);
    return out;
  }
  return foundationErrors.normalizeError(err, { fallbackCode: foundationErrors.DXOS_ERR_INTERNAL });
}

function comfyCommandNotAllowed(command) {
  return createComfyError(COMFY_ERR_COMMAND_NOT_ALLOWED, "未知或未授权的 comfy 命令：" + String(command == null ? "" : command), { command: command == null ? null : String(command) });
}

/** 渲染层出口：成功 { ok:true, value }；失败 normalizeComfyError（与 foundation.toIpcResult 同形）。 */
async function toComfyIpcResult(action) {
  try {
    const value = typeof action === "function" ? await action() : await action;
    return { ok: true, value: redactComfyValue(value) };
  } catch (err) {
    return normalizeComfyError(err);
  }
}

/**
 * 依赖缺失的标准失败体（任务书 item 1："缺什么 / 怎么装"，绝不假运行）。
 * 返回普通对象而不是 Error —— 它常被当作命令的最终返回值直接透出。
 */
function comfyDependencyUnavailable(dependency, message, options = {}) {
  const missing = Array.isArray(options.missing) ? options.missing.slice(0, 20).map((item) => String(item).slice(0, 120)) : [];
  return {
    ok: false,
    error: COMFY_ERR_DEPENDENCY_UNAVAILABLE,
    message: foundationErrors.redactText(message || ("ComfyUI 依赖不可用：" + String(dependency || "unknown"))).slice(0, 400),
    detail: {
      dependency: String(dependency || "comfy").slice(0, 80),
      missing: missing,
      install: String(options.install || "安装 Python 3.10+ 与 ComfyUI，然后在 comfy/instances/save 填写 rootDir / pythonPath / mainPath").slice(0, 800),
    },
  };
}

/** 插件"默认关闭"的标准失败体（与 B7c INTEGRATION_UNAVAILABLE 同码同形）。 */
function comfyDisabled(message) {
  return {
    ok: false,
    error: COMFY_ERR_INTEGRATION_UNAVAILABLE,
    message: foundationErrors.redactText(message || "ComfyUI 为可选插件，默认关闭；请先 comfy/plugin/enable").slice(0, 400),
    detail: "ComfyUI 为可选插件，默认关闭。先在「ComfyUI · 插件」里启用（comfy/plugin/enable），再登记本机安装路径与实例。",
  };
}

/** 结构化工作流非法错误（解析 / 字段映射 / 输出映射失败统一走它）。 */
function comfyWorkflowInvalid(message, detail) {
  return createComfyError(COMFY_ERR_WORKFLOW_INVALID, message || "工作流格式无效", detail);
}

module.exports = {
  COMFY_EVENT_CHANNEL,
  COMFY_EVENT_DOMAIN,
  COMFY_COMMANDS,
  COMFY_ERROR_CODES,
  COMFY_ERR_COMMAND_NOT_ALLOWED,
  COMFY_ERR_INVALID_INPUT,
  COMFY_ERR_UNAUTHENTICATED,
  COMFY_ERR_FORBIDDEN,
  COMFY_ERR_NOT_FOUND,
  COMFY_ERR_CONFLICT,
  COMFY_ERR_DEPENDENCY_UNAVAILABLE,
  COMFY_ERR_INTEGRATION_UNAVAILABLE,
  COMFY_ERR_UNAVAILABLE,
  COMFY_ERR_TIMEOUT,
  COMFY_ERR_CANCELLED,
  COMFY_ERR_CHILD_FAILED,
  COMFY_ERR_WORKFLOW_INVALID,
  COMFY_ERR_INTERNAL,
  RISK_LEVELS,
  isComfyCommand,
  comfyCommandEntry,
  comfyCommandRisk,
  comfyCommandRequiresCredential,
  listComfyCommands,
  createComfyError,
  isComfyError,
  redactComfyValue,
  normalizeComfyError,
  comfyCommandNotAllowed,
  toComfyIpcResult,
  comfyDependencyUnavailable,
  comfyDisabled,
  comfyWorkflowInvalid,
};
