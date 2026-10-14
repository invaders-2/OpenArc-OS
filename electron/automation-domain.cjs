"use strict";
/**
 * B6a · 自动化域纯逻辑（无 I/O）：命令白名单 + 风险/凭据属性 + 定义规约 + 调度解析 + 结果脱敏。
 *
 * 为什么单独一层：automation:command 是本轮新增的顶层 IPC 通道，"哪些命令可被渲染层调用、
 * 每条命令的风险等级、是否触碰凭据、失败时回什么码"必须先在一处冻结，再交给
 * electron/automation-service.cjs 分发、electron/automation-bootstrap.cjs 注册。
 * 命令表本身即白名单：未登记的命令一律 AUTOMATION_COMMAND_NOT_ALLOWED，不做动态 dispatch。
 *
 * ## 来源（只读参照 DX OS 0.5.1 app.asar.unpacked/server）
 *   · automations.ts:5-8       AutomationSchedule（daily / weekly / once）
 *   · automations.ts:10-22     AutomationAction 动作集合与 SERVER_ACTIONS / ALL_ACTIONS 判定
 *   · automations.ts:75-100    时区换算（partsAt / timezoneOffset / zonedTimestamp / plusLocalDays）
 *   · automations.ts:102-116   nextRunAt（daily/weekly/once）
 *   · automations.ts:118-146   执行时间/动作参数校验（validClock / normalizeAppActionArgs）
 *   · automations.ts:148-190   normalizeDefinition（标题 / 时间 / 动作 / 参数夹取）
 *   · automations.ts:192-248   parseAutomationFallback（中文自然语言 → 计划定义，纯规则）
 *
 * ## 与源不同的点（有意为之）
 *   · 【B6a 扩展】schedule 增加 cron（5 段标准 crontab）与 interval（固定间隔）两种语义。
 *     源只有 daily/weekly/once（automations.ts:5-8）；本域保留源三种语义**逐字不变**，
 *     另加两种是因为任务 B6a 明确要求"支持 cron/间隔语义"。扩展只在 schedule 对象内表达，
 *     不新增数据库列（automations.schedule_json 原样承载）。
 *   · 【B6a 扩展】定义可带 retry:{ maxAttempts, delayMs }（源没有重试）。它随 action_json 落库，
 *     同样不新增列；服务层在一次运行内按该策略重试，运行记录只落一行（见 automation-service.cjs）。
 *   · 【B7 依赖】app_action 的参数规约（源 automations.ts:122-146 依赖 listDeveloperApps）
 *     改为注入的 appActions 适配器；未注入即结构化 AGENT_DEPENDENCY_UNAVAILABLE，绝不假装成功。
 *
 * 脱敏/错误规约复用 electron/dxos-foundation-errors.cjs 的既有实现（redactText / redactValue /
 * normalizeError 同源），保证自动化域的失败形状与 agent / skill / media / model / task 各域一致。
 *
 * 参照：electron/skill-domain.cjs:1-175、electron/media-domain.cjs:1-160（同形实现）。
 */

const foundationErrors = require("./dxos-foundation-errors.cjs");

/** 下行事件通道：与 preload 的 automation.onEvent / main.cjs 的 send 同名。 */
const AUTOMATION_EVENT_CHANNEL = "automation:event";
const AUTOMATION_EVENT_DOMAIN = "automation";

/** 自动化域自有错误码。与 DXOS_* / AGENT_* / SKILL_* / MEDIA_* 并列，不合并。 */
const AUTOMATION_ERR_COMMAND_NOT_ALLOWED = "AUTOMATION_COMMAND_NOT_ALLOWED";
const AUTOMATION_ERR_INVALID_INPUT = "AUTOMATION_INVALID_INPUT";
const AUTOMATION_ERR_UNAUTHENTICATED = "AUTOMATION_UNAUTHENTICATED";
const AUTOMATION_ERR_FORBIDDEN = "AUTOMATION_FORBIDDEN";
const AUTOMATION_ERR_NOT_FOUND = "AUTOMATION_NOT_FOUND";
const AUTOMATION_ERR_CONFLICT = "AUTOMATION_CONFLICT";
/**
 * 依赖缺失码刻意沿用 B3/B4 的 AGENT_DEPENDENCY_UNAVAILABLE 约定（任务 B6a §3 明确要求
 * "未注入返回结构化 AGENT_DEPENDENCY_UNAVAILABLE"），而不是像 skill/media 那样自造域码。
 * 域内其它错误仍走 AUTOMATION_*，保证渲染层能稳定区分"依赖没装"与"参数/状态错"。
 */
const AUTOMATION_ERR_DEPENDENCY_UNAVAILABLE = "AGENT_DEPENDENCY_UNAVAILABLE";
const AUTOMATION_ERR_UNAVAILABLE = "AUTOMATION_UNAVAILABLE";
const AUTOMATION_ERR_CANCELLED = "AUTOMATION_CANCELLED";
const AUTOMATION_ERR_INTERNAL = "AUTOMATION_INTERNAL";

const AUTOMATION_ERROR_CODES = Object.freeze([
  AUTOMATION_ERR_COMMAND_NOT_ALLOWED,
  AUTOMATION_ERR_INVALID_INPUT,
  AUTOMATION_ERR_UNAUTHENTICATED,
  AUTOMATION_ERR_FORBIDDEN,
  AUTOMATION_ERR_NOT_FOUND,
  AUTOMATION_ERR_CONFLICT,
  AUTOMATION_ERR_DEPENDENCY_UNAVAILABLE,
  AUTOMATION_ERR_UNAVAILABLE,
  AUTOMATION_ERR_CANCELLED,
  AUTOMATION_ERR_INTERNAL,
]);

/** 源 automations.ts:16-18 的动作集合。workflow_sequence 是唯一的组合动作。 */
const SERVER_ACTIONS = Object.freeze(["ziniao_download", "lingxing_cache_sync", "ziniao_data_sync", "dingtalk_group_notify", "dingtalk_person_notify", "workflow_sequence", "app_action"]);
const SERVER_ATOMIC_ACTIONS = Object.freeze(["ziniao_download", "lingxing_cache_sync", "ziniao_data_sync", "dingtalk_group_notify", "dingtalk_person_notify", "app_action"]);
const ALL_ACTIONS = Object.freeze(["music_play", "music_control", "open_app", "agent_instruction", ...SERVER_ACTIONS]);

const ALL_ACTION_SET = new Set(ALL_ACTIONS);
const SERVER_ACTION_SET = new Set(SERVER_ACTIONS);
const SERVER_ATOMIC_ACTION_SET = new Set(SERVER_ATOMIC_ACTIONS);

function isAutomationAction(action) {
  return !!action && typeof action === "object" && typeof action.type === "string" && ALL_ACTION_SET.has(action.type);
}

/** 源 automations.ts:20-22：哪些动作在源里由服务端执行（本移植统一在主进程内执行）。 */
function isServerAutomationAction(action) {
  return !!action && SERVER_ACTION_SET.has(action.type);
}

/**
 * automation:command 白名单。
 *   risk       read | use | manage | destructive（与 skill-domain.cjs:77 同级定义）
 *   credential 该命令是否会把真实凭据带进执行路径（外部站点 / 第三方插件由注入适配器负责）
 *   summary    中文一句话，供 UI（自动化中心）与审计展示
 * 覆盖任务书要求的 command 族：定义 CRUD / 启停 / 立即运行 / 取消 / 运行记录 / 能力目录 / 解析 / 健康。
 */
const AUTOMATION_COMMANDS = Object.freeze({
  // ---- 定义 CRUD（automation-store.cjs） ----
  "automation/list": { risk: "read", credential: false, summary: "列出当前用户的全部自动化定义与最近运行记录" },
  "automation/get": { risk: "read", credential: false, summary: "读取单个自动化定义及其最近运行记录" },
  "automation/create": { risk: "manage", credential: false, summary: "新建一个自动化定义（校验时间与动作参数）" },
  "automation/update": { risk: "manage", credential: false, summary: "更新自动化定义（标题 / 指令 / 时间 / 动作 / 重试策略）" },
  "automation/delete": { risk: "destructive", credential: false, summary: "删除一个自动化定义并级联删除其运行记录" },
  "automation/enable": { risk: "manage", credential: false, summary: "启用自动化并重新计算下一次执行时间" },
  "automation/disable": { risk: "manage", credential: false, summary: "停用自动化（保留定义与历史记录）" },

  // ---- 运行（automation-service.cjs） ----
  "automation/runNow": { risk: "use", credential: true, summary: "立即执行一次自动化（真实动作，需权限）" },
  // B7j：取消的实参语义是运行记录 id（runId）—— 自然字段主用，automationId 仅作解析别名。
  "automation/cancel": { risk: "manage", credential: false, summary: "取消一次运行中的执行记录（runId 必填；automationId 仅作为可解析到运行记录的兼容别名）" },
  "automation/runs": { risk: "read", credential: false, summary: "列出某个自动化或全部最近的运行记录" },

  // ---- 目录 / 解析 / 健康 ----
  "automation/catalog": { risk: "read", credential: false, summary: "列出已安装开发者 App 提供的自动化能力（B7 未装配时结构化不可用）" },
  "automation/parse": { risk: "read", credential: false, summary: "用本地规则把中文指令解析成自动化定义（离线，不调用模型）" },
  "automation/health": { risk: "read", credential: false, summary: "自动化域依赖装配健康检查（调度器 / 数据库 / 各适配器）" },
});

/** 风险等级序（数值越大越危险）；UI 排序 / 审批阈值使用。 */
const RISK_LEVELS = Object.freeze({ read: 0, use: 1, manage: 2, destructive: 3 });

function isAutomationCommand(command) {
  return typeof command === "string" && Object.prototype.hasOwnProperty.call(AUTOMATION_COMMANDS, command);
}

function automationCommandEntry(command) {
  return isAutomationCommand(command) ? AUTOMATION_COMMANDS[command] : null;
}

/** 未知命令返回 null（调用方据此判 AUTOMATION_COMMAND_NOT_ALLOWED，不猜风险）。 */
function automationCommandRisk(command) {
  const entry = automationCommandEntry(command);
  return entry ? entry.risk : null;
}

function automationCommandRequiresCredential(command) {
  const entry = automationCommandEntry(command);
  return !!(entry && entry.credential);
}

/**
 * 稳定顺序的命令清单（对象字面量声明顺序），供 UI 与测试消费。
 * 注意：IPC 投影把 credential 改名为 needsCredential —— dxos-foundation-errors.redactValue
 * 会把任何含 "credential" 的键当密钥字段掩码（dxos-foundation-mask.cjs:12），
 * 直接回 credential 布尔值会变成 "****alse" 这种掩码串。内部表仍叫 credential。
 */
function listAutomationCommands() {
  return Object.keys(AUTOMATION_COMMANDS).map((command) => ({
    command,
    risk: AUTOMATION_COMMANDS[command].risk,
    needsCredential: AUTOMATION_COMMANDS[command].credential,
    summary: AUTOMATION_COMMANDS[command].summary,
  }));
}

/** 构造带稳定 code 的自动化域错误；message 过 foundation 的 redactText。 */
function createAutomationError(code, message, detail) {
  const err = new Error(foundationErrors.redactText(message == null ? code : message));
  err.name = "AutomationError";
  err.code = AUTOMATION_ERROR_CODES.includes(code) ? code : AUTOMATION_ERR_INTERNAL;
  err.detail = detail === undefined ? undefined : foundationErrors.redactValue(detail);
  return err;
}

function isAutomationError(err) {
  return !!err && typeof err === "object" && typeof err.code === "string" && AUTOMATION_ERROR_CODES.includes(err.code);
}

/** 任意值与返回值脱敏：直接复用 foundation 的深度封顶 + 密钥字段掩码 + 绝对路径替换。 */
function redactAutomationValue(value) {
  return foundationErrors.redactValue(value);
}

/**
 * 自动化域错误 → 渲染层安全结果。
 *   · 命中 AUTOMATION_* 码：保留码与（脱敏后的）消息；
 *   · 底层 AGENT_DEPENDENCY_UNAVAILABLE（B4/B7 适配器约定的依赖缺失码）：归一到本域依赖缺失码，
 *     保留原始 dependency（自动化域因此不必直接依赖 B4 的常量）；
 *   · 其余交给 foundation.normalizeError（未知异常折叠成 DXOS_ERR_INTERNAL）。
 */
function normalizeAutomationError(err) {
  if (isAutomationError(err)) {
    const out = { ok: false, error: err.code, message: foundationErrors.redactText(err.message || err.code) || err.code };
    if (err.detail !== undefined) out.detail = foundationErrors.redactValue(err.detail);
    else if (err.code === AUTOMATION_ERR_DEPENDENCY_UNAVAILABLE && err.dependency) out.detail = { dependency: foundationErrors.redactValue(err.dependency) };
    return out;
  }
  if (err && err.code === "AGENT_DEPENDENCY_UNAVAILABLE") {
    return {
      ok: false,
      error: AUTOMATION_ERR_DEPENDENCY_UNAVAILABLE,
      message: foundationErrors.redactText((err && err.message) || "自动化依赖不可用"),
      detail: foundationErrors.redactValue({ dependency: err.dependency || null, causeCode: err.code }),
    };
  }
  return foundationErrors.normalizeError(err, { fallbackCode: foundationErrors.DXOS_ERR_INTERNAL });
}

function automationCommandNotAllowed(command) {
  return createAutomationError(AUTOMATION_ERR_COMMAND_NOT_ALLOWED, "未知或未授权的 automation 命令：" + String(command == null ? "" : command), { command: command == null ? null : String(command) });
}

/** 渲染层出口：成功 { ok:true, value }；失败 normalizeAutomationError（与 foundation.toIpcResult 同形）。 */
async function toAutomationIpcResult(action) {
  try {
    const value = typeof action === "function" ? await action() : await action;
    return { ok: true, value: redactAutomationValue(value) };
  } catch (err) {
    return normalizeAutomationError(err);
  }
}

// ---------------------------------------------------------------------------
// 时区换算（源 automations.ts:75-100 逐字移植）
// ---------------------------------------------------------------------------

const DEFAULT_TIMEZONE = "Asia/Shanghai";

/** 源 automations.ts:75-83 */
function partsAt(timestamp, timezone) {
  const values = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const get = (type) => Number(values.find((item) => item.type === type)?.value || 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** 源 automations.ts:85-88 */
function timezoneOffset(timestamp, timezone) {
  const p = partsAt(timestamp, timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - timestamp;
}

/** 源 automations.ts:90-95 */
function zonedTimestamp(year, month, day, hour, minute, timezone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  let result = guess - timezoneOffset(guess, timezone);
  result = guess - timezoneOffset(result, timezone);
  return result;
}

/** 源 automations.ts:97-100 */
function plusLocalDays(input, days) {
  const date = new Date(Date.UTC(input.year, input.month - 1, input.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** 时区是否可被 Intl 接受（源没校验；定义时显式拒绝无效时区，避免运行时静默回退）。 */
function isValidTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: String(timezone) }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// cron / interval（B6a 扩展；源 automations.ts:5-8 没有这两种）
// ---------------------------------------------------------------------------

/** 5 段标准 crontab：分 时 日 月 周；周 0/7 = 周日。 */
function parseCronField(raw, min, max) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) throw createAutomationError(AUTOMATION_ERR_INVALID_INPUT, "cron 字段不能为空");
  const values = new Set();
  for (const token of text.split(",")) {
    const match = token.match(/^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/);
    if (!match) throw createAutomationError(AUTOMATION_ERR_INVALID_INPUT, "无法识别的 cron 字段：" + token);
    const step = match[2] == null ? 1 : Number(match[2]);
    if (!Number.isInteger(step) || step <= 0) throw createAutomationError(AUTOMATION_ERR_INVALID_INPUT, "cron 步长必须是正整数：" + token);
    let low;
    let high;
    if (match[1] === "*") {
      low = min;
      high = max;
    } else if (match[1].includes("-")) {
      const pieces = match[1].split("-").map(Number);
      low = pieces[0];
      high = pieces[1];
    } else {
      low = Number(match[1]);
      high = match[2] == null ? low : max;
    }
    if (!Number.isInteger(low) || !Number.isInteger(high) || low < min || high > max || low > high) {
      throw createAutomationError(AUTOMATION_ERR_INVALID_INPUT, "cron 字段超出范围 [" + min + "," + max + "]：" + token);
    }
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return values;
}

/**
 * 解析 5 段 cron 表达式。返回：
 *   { minute:Set, hour:Set, dom:Set, month:Set, dow:Set, domRestricted:boolean, dowRestricted:boolean }
 * domRestricted / dowRestricted 决定"日与周同时受限时取或"的标准语义。
 */
function parseCronExpression(expression) {
  const text = String(expression == null ? "" : expression).trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) throw createAutomationError(AUTOMATION_ERR_INVALID_INPUT, "cron 表达式必须是 5 段（分 时 日 月 周）：" + text);
  const minute = parseCronField(parts[0], 0, 59);
  const hour = parseCronField(parts[1], 0, 23);
  const dom = parseCronField(parts[2], 1, 31);
  const month = parseCronField(parts[3], 1, 12);
  const rawDow = parseCronField(parts[4], 0, 7);
  const dow = new Set([...rawDow].map((value) => (value === 7 ? 0 : value)));
  return { minute, hour, dom, month, dow, domRestricted: parts[2].trim() !== "*", dowRestricted: parts[4].trim() !== "*" };
}

function cronDayMatches(cron, day, weekday) {
  const domOk = cron.dom.has(day);
  const dowOk = cron.dow.has(weekday);
  if (!cron.domRestricted && !cron.dowRestricted) return true;
  if (!cron.domRestricted) return dowOk;
  if (!cron.dowRestricted) return domOk;
  return domOk || dowOk;
}

/** cron 的下一次触发：按本地日期逐日推进，命中当日内取第一个晚于 after 的时刻。 */
function nextCronRunAt(cron, after, timezone) {
  const tz = timezone || DEFAULT_TIMEZONE;
  const hours = [...cron.hour].sort((a, b) => a - b);
  const minutes = [...cron.minute].sort((a, b) => a - b);
  const start = partsAt(after, tz);
  // 上界覆盖 2 月 29 日这类稀疏表达式；命中即返回，只有"完全不匹配"的表达式才会走满。
  const MAX_DAYS = 366 * 5;
  for (let offset = 0; offset <= MAX_DAYS; offset += 1) {
    const date = plusLocalDays(start, offset);
    if (!cron.month.has(date.month)) continue;
    const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
    if (!cronDayMatches(cron, date.day, weekday)) continue;
    for (const hour of hours) {
      for (const minute of minutes) {
        const candidate = zonedTimestamp(date.year, date.month, date.day, hour, minute, tz);
        if (candidate > after) return candidate;
      }
    }
  }
  return null;
}

/**
 * 源 automations.ts:102-116 的 nextRunAt，扩展 cron / interval 两分支。
 *   · once     —— after 之前的单次时间返回 null（源 :103）；
 *   · daily/weekly —— 逐日找下一个命中星期与时钟点的本地时刻（源 :104-115）；
 *   · cron     —— 5 段 crontab（B6a 扩展）；
 *   · interval —— 固定间隔；带 anchor 时按锚点对齐（不随每次领取漂移），否则 after + everyMs。
 */
function nextRunAt(schedule, after) {
  const t = Number.isFinite(after) ? after : Date.now();
  if (!schedule || typeof schedule !== "object") return null;
  if (schedule.type === "once") return schedule.at > t ? schedule.at : null;
  if (schedule.type === "cron") return nextCronRunAt(parseCronExpression(schedule.expression), t, schedule.timezone || DEFAULT_TIMEZONE);
  if (schedule.type === "interval") {
    const everyMs = Math.max(1, Math.floor(Number(schedule.everyMs) || 0));
    const anchor = Number.isFinite(schedule.anchor) ? schedule.anchor : null;
    // anchor 是"起算时刻"而不是"执行时刻"：首次执行 = anchor + everyMs，之后按锚点对齐，不随领取时间漂移。
    if (anchor == null) return t + everyMs;
    if (t < anchor) return anchor + everyMs;
    return anchor + (Math.floor((t - anchor) / everyMs) + 1) * everyMs;
  }
  const timezone = schedule.timezone || DEFAULT_TIMEZONE;
  const local = partsAt(t, timezone);
  for (let offset = 0; offset < 8; offset += 1) {
    const date = plusLocalDays(local, offset);
    if (schedule.type === "weekly") {
      const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
      if (!schedule.weekdays.includes(weekday)) continue;
    }
    const candidate = zonedTimestamp(date.year, date.month, date.day, schedule.hour, schedule.minute, timezone);
    if (candidate > t) return candidate;
  }
  return null;
}

/** 源 automations.ts:118-120 */
function validClock(value, max) {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= max;
}

/** 源 automations.ts:152-167 的时间规约 + B6a 的 cron / interval 两分支。 */
function normalizeSchedule(input, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const raw = input && typeof input === "object" ? input : null;
  if (!raw || !["daily", "weekly", "once", "cron", "interval"].includes(raw.type)) {
    throw createAutomationError(AUTOMATION_ERR_INVALID_INPUT, "没有识别到有效的执行时间");
  }
  const timezone = raw.timezone ? String(raw.timezone) : DEFAULT_TIMEZONE;
  if (!isValidTimezone(timezone)) throw createAutomationError(AUTOMATION_ERR_INVALID_INPUT, "无效的时区：" + timezone);
  if (raw.type === "once") {
    const at = Number(raw.at);
    if (!Number.isFinite(at) || at <= now) throw createAutomationError(AUTOMATION_ERR_INVALID_INPUT, "单次任务的执行时间必须晚于现在");
    return { type: "once", at, timezone };
  }
  if (raw.type === "cron") {
    const expression = String(raw.expression == null ? "" : raw.expression).trim();
    parseCronExpression(expression);
    return { type: "cron", expression, timezone };
  }
  if (raw.type === "interval") {
    const rawEvery = Number(raw.everyMs != null ? raw.everyMs : Number(raw.everyMinutes) * 60000);
    if (!Number.isFinite(rawEvery) || rawEvery < 1) throw createAutomationError(AUTOMATION_ERR_INVALID_INPUT, "间隔任务的 everyMs 必须是正毫秒数");
    const everyMs = Math.min(366 * 24 * 60 * 60 * 1000, Math.floor(rawEvery));
    const anchor = Number.isFinite(raw.anchor) ? raw.anchor : now;
    return { type: "interval", everyMs, anchor, timezone };
  }
  if (!validClock(raw.hour, 23) || !validClock(raw.minute, 59)) throw createAutomationError(AUTOMATION_ERR_INVALID_INPUT, "执行时间无效");
  if (raw.type === "weekly") {
    const weekdays = [...new Set((raw.weekdays || []).map(Number))].filter((day) => day >= 0 && day <= 6);
    if (!weekdays.length) throw createAutomationError(AUTOMATION_ERR_INVALID_INPUT, "每周任务需要指定星期");
    return { type: "weekly", weekdays, hour: raw.hour, minute: raw.minute, timezone };
  }
  return { type: "daily", hour: raw.hour, minute: raw.minute, timezone };
}

/** 重试策略（B6a 扩展；源没有）。默认不重试（maxAttempts=1）。 */
function normalizeRetry(input) {
  if (input == null) return null;
  const raw = input && typeof input === "object" ? input : {};
  const maxAttempts = Math.min(5, Math.max(1, Math.floor(Number(raw.maxAttempts) || 1)));
  const delayMs = Math.min(600000, Math.max(0, Math.floor(Number(raw.delayMs) || 0)));
  return { maxAttempts, delayMs };
}

// ---------------------------------------------------------------------------
// 动作参数规约（源 automations.ts:122-190）
// ---------------------------------------------------------------------------

/**
 * 源 automations.ts:122-146 的 normalizeAppActionArgs。差异：开发者 App 目录改由 appActions
 * 适配器提供（B7）；未注入即结构化依赖缺失 —— 不能在"无法校验动作声明"的情况下放行。
 */
function normalizeAppActionArgs(args, appActions) {
  if (!appActions || typeof appActions.normalize !== "function") {
    throw createAutomationError(AUTOMATION_ERR_DEPENDENCY_UNAVAILABLE, "开发者 App 能力未装配（B7），无法定义 app_action", { dependency: "developerApps" });
  }
  return appActions.normalize(args);
}

/**
 * 源 automations.ts:148-190 的 normalizeDefinition。
 * options.appActions 只在 action.type === "app_action" 时使用；options.now 供 once / interval 判时。
 * 返回定义上的 retry 是 B6a 扩展，随 action_json 落库（源没有）。
 */
function normalizeDefinition(input, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const source = input && typeof input === "object" ? input : {};
  const instruction = String(source.instruction || "").trim();
  const title = String(source.title || instruction.slice(0, 30) || "自动化任务").trim();
  const schedule = normalizeSchedule(source.schedule, { now });
  const rawAction = source.action;
  if (!isAutomationAction(rawAction)) {
    throw createAutomationError(AUTOMATION_ERR_INVALID_INPUT, "没有识别到可执行的动作" + (rawAction && rawAction.type ? "：" + rawAction.type : ""));
  }
  const args = { ...(rawAction.args || {}) };
  if (rawAction.type === "app_action") Object.assign(args, normalizeAppActionArgs(args, options.appActions));
  if (rawAction.type === "lingxing_cache_sync") args.days = Math.min(180, Math.max(1, Math.floor(Number(args.days) || 7)));
  if (rawAction.type === "ziniao_download") args.days = Math.min(90, Math.max(1, Math.floor(Number(args.days) || 1)));
  if (rawAction.type === "ziniao_data_sync") args.days = Math.min(365, Math.max(1, Math.floor(Number(args.days) || 30)));
  if (rawAction.type === "dingtalk_group_notify" || rawAction.type === "dingtalk_person_notify") {
    args.content = String(args.content || "").trim().slice(0, 4000);
    args.includeResult = args.includeResult !== false && args.includeResult !== "false";
  }
  if (rawAction.type === "workflow_sequence") {
    const actions = Array.isArray(args.actions) ? args.actions : [];
    if (!actions.length) throw createAutomationError(AUTOMATION_ERR_INVALID_INPUT, "联动流程至少需要一个执行动作");
    if (actions.length > 20) throw createAutomationError(AUTOMATION_ERR_INVALID_INPUT, "联动流程最多支持 20 个动作");
    args.actions = actions.map((item, index) => {
      if (!item || !SERVER_ATOMIC_ACTION_SET.has(item.type)) throw createAutomationError(AUTOMATION_ERR_INVALID_INPUT, "第 " + (index + 1) + " 个动作暂不支持后台联动");
      // 源 automations.ts:186 递归规约；刻意不把 retry 传进子动作（重试属于整条自动化运行）。
      return normalizeDefinition({ title, instruction, schedule, action: item }, { now, appActions: options.appActions }).action;
    });
  }
  const retry = normalizeRetry(source.retry != null ? source.retry : rawAction.retry);
  const action = { type: rawAction.type, args };
  if (retry) action.retry = retry;
  return { title, instruction, schedule, action };
}

// ---------------------------------------------------------------------------
// 中文自然语言 → 计划定义（源 automations.ts:192-248，纯规则、离线）
// ---------------------------------------------------------------------------

const chineseWeekday = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

/** 源 automations.ts:194-203 */
function clockFromText(text) {
  const match = text.match(/(凌晨|早上|上午|中午|下午|晚上)?\s*(\d{1,2})(?:\s*[:：点时]\s*(\d{1,2})?|\s*点半)/);
  if (!match) return null;
  let hour = Number(match[2]);
  const minute = text.slice(match.index, (match.index || 0) + match[0].length).includes("半") ? 30 : Number(match[3] || 0);
  if (["下午", "晚上"].includes(match[1]) && hour < 12) hour += 12;
  if (match[1] === "中午" && hour < 11) hour += 12;
  if (match[1] === "凌晨" && hour === 12) hour = 0;
  return validClock(hour, 23) && validClock(minute, 59) ? { hour, minute } : null;
}

/** 间隔语义的自然语言（B6a 扩展）：每 N 分钟 / 每小时。 */
function intervalFromText(text, now) {
  const minutes = text.match(/每\s*(\d{1,4})\s*分钟/);
  if (minutes) return { type: "interval", everyMs: Math.max(1, Number(minutes[1])) * 60000, anchor: now, timezone: DEFAULT_TIMEZONE };
  if (/每\s*(?:个)?小时/.test(text)) return { type: "interval", everyMs: 3600000, anchor: now, timezone: DEFAULT_TIMEZONE };
  return null;
}

/** 源 automations.ts:205-248 的 parseAutomationFallback + 间隔语义扩展。 */
function parseAutomationFallback(instruction, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const text = String(instruction == null ? "" : instruction).trim();
  const interval = intervalFromText(text, now);
  let schedule;
  if (interval) {
    schedule = interval;
  } else {
    const clock = clockFromText(text);
    if (!clock) throw createAutomationError(AUTOMATION_ERR_INVALID_INPUT, "请在指令中写明执行时间，例如“每天早上 9 点”");
    const week = text.match(/每(?:周|星期)([一二三四五六日天](?:[、,，和及][一二三四五六日天])*)/);
    if (week) {
      const weekdays = [...week[1]].filter((char) => chineseWeekday[char] !== undefined).map((char) => chineseWeekday[char]);
      schedule = { type: "weekly", weekdays: [...new Set(weekdays)], ...clock, timezone: DEFAULT_TIMEZONE };
    } else if (/每天|每日/.test(text)) {
      schedule = { type: "daily", ...clock, timezone: DEFAULT_TIMEZONE };
    } else {
      const local = partsAt(now, DEFAULT_TIMEZONE);
      const target = plusLocalDays(local, /明天/.test(text) ? 1 : 0);
      let at = zonedTimestamp(target.year, target.month, target.day, clock.hour, clock.minute, DEFAULT_TIMEZONE);
      if (at <= now && !/今天/.test(text)) {
        const tomorrow = plusLocalDays(target, 1);
        at = zonedTimestamp(tomorrow.year, tomorrow.month, tomorrow.day, clock.hour, clock.minute, DEFAULT_TIMEZONE);
      }
      schedule = { type: "once", at, timezone: DEFAULT_TIMEZONE };
    }
  }

  let action;
  const parsedDays = Number(text.match(/(?:近|最近|过去)\s*(\d+)\s*天/)?.[1] || text.match(/(\d+)\s*天(?:的)?数据/)?.[1] || 0);
  if (/紫鸟/.test(text) && /(?:同步|导入)/.test(text) && !/(?:下载|导出)/.test(text)) {
    action = { type: "ziniao_data_sync", args: { days: parsedDays || 30 } };
  } else if (/紫鸟/.test(text) && /(?:下载|导出)/.test(text)) {
    action = { type: "ziniao_download", args: { days: parsedDays || 1, store: "all" } };
  } else if (/领星/.test(text) && /(?:下载|同步|缓存|更新)/.test(text)) {
    action = { type: "lingxing_cache_sync", args: { days: parsedDays || 7 } };
  } else if (/播放|放歌|音乐/.test(text)) {
    const query = text
      .replace(/^.*?(?:自动)?(?:播放|放)(?:一下)?/, "")
      .replace(/(?:的)?(?:歌曲|歌|音乐).*$/, "")
      .trim();
    action = { type: "music_play", args: { query, shuffle: true } };
  } else if (/打开|启动/.test(text)) {
    const app = text.replace(/^.*?(?:打开|启动)/, "").replace(/(?:应用|APP).*$/i, "").trim();
    action = { type: "open_app", args: { app } };
  } else {
    action = { type: "agent_instruction", args: { instruction: text.replace(/^.*?(?:点|时)(?:半|\d{1,2}分?)?\s*/, "") || text } };
  }
  return normalizeDefinition({ title: text.slice(0, 30), instruction: text, schedule, action }, { now, appActions: options.appActions });
}

module.exports = {
  AUTOMATION_EVENT_CHANNEL,
  AUTOMATION_EVENT_DOMAIN,
  AUTOMATION_COMMANDS,
  AUTOMATION_ERROR_CODES,
  AUTOMATION_ERR_COMMAND_NOT_ALLOWED,
  AUTOMATION_ERR_INVALID_INPUT,
  AUTOMATION_ERR_UNAUTHENTICATED,
  AUTOMATION_ERR_FORBIDDEN,
  AUTOMATION_ERR_NOT_FOUND,
  AUTOMATION_ERR_CONFLICT,
  AUTOMATION_ERR_DEPENDENCY_UNAVAILABLE,
  AUTOMATION_ERR_UNAVAILABLE,
  AUTOMATION_ERR_CANCELLED,
  AUTOMATION_ERR_INTERNAL,
  RISK_LEVELS,
  DEFAULT_TIMEZONE,
  ALL_ACTIONS,
  SERVER_ACTIONS,
  SERVER_ATOMIC_ACTIONS,
  isAutomationAction,
  isServerAutomationAction,
  isAutomationCommand,
  automationCommandEntry,
  automationCommandRisk,
  automationCommandRequiresCredential,
  listAutomationCommands,
  createAutomationError,
  isAutomationError,
  redactAutomationValue,
  normalizeAutomationError,
  automationCommandNotAllowed,
  toAutomationIpcResult,
  partsAt,
  timezoneOffset,
  zonedTimestamp,
  plusLocalDays,
  isValidTimezone,
  validClock,
  parseCronExpression,
  parseCronField,
  cronDayMatches,
  nextRunAt,
  normalizeSchedule,
  normalizeRetry,
  normalizeDefinition,
  clockFromText,
  parseAutomationFallback,
};
