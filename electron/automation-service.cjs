"use strict";
/**
 * B6a · 自动化域装配 + automation:command 分发 + 主进程内调度器（唯一执行入口）。
 *
 * ## 来源
 *   · automations.ts:250-392                 定义 CRUD / 领取 / 完成（已移植到 automation-store.cjs）
 *   · automationBusinessActions.ts:63-67     通知文案（{{上一步结果}} / {{完成状态}} 替换）
 *   · automationBusinessActions.ts:69-108    workflow_sequence / app_action 分派
 *   · automationBusinessActions.ts:109-147   领星 / 紫鸟 / 钉钉五个服务端动作
 *   · automationCatalog.ts:17-37             自动化能力目录（已安装开发者 App 的动作清单）
 *   · index.ts:10258-10289                   调度循环（claim → runServerAutomation → complete）
 *
 * ## 调度器在主进程内（无云依赖）
 *   · 源把调度放在 DX OS 的 HTTP 服务进程里（index.ts:10310-10311 的 6s 首次 + 15s 轮询）；
 *     本移植把它搬进 Electron 主进程：startScheduler() 用 setInterval 定时 tick()，
 *     tick() 领取一个到点定义并在**异步**路径里执行 —— Node 单线程事件循环不会被长动作阻塞；
 *     真正"重"的工作（外部站点下载 / 模型调用 / 子进程）全部由注入适配器负责，
 *     生产装配里它们要么走受监督子进程，要么直接调用既有工具目录（app_action 的 toolName 分支）。
 *   · 领取是全局的（automation-store.claimDueAutomation 不带用户过滤），与源
 *     claimDueServerAutomation（automations.ts:349-364）同语义；执行前从运行记录取 created_by。
 *
 * ## 业务动作的对外依赖一律走注入适配器（未注入 = 结构化 AGENT_DEPENDENCY_UNAVAILABLE，绝不假执行）
 *   · developerApps（B7：开发者 App 清单 / 已安装判定 / 参数规约 / 工具执行 / 能力目录）
 *   · integrations （钉钉 / 领星 / 紫鸟：第三方集成插件，默认关闭）
 *   · desktop      （music_play / music_control / open_app 的桌面执行端）
 *   · agent        （agent_instruction 的 Agent 执行端，B3）
 *   · localAccounts（B4：自动化所属账户解析；生产由 identity.localAccountService 注入）
 *   · toolCatalog  （既有工具目录；developerApps 未提供 runTool 时的兜底执行出口）
 *   本文件在任何分支都不会"因为没有依赖就返回成功"：缺依赖一律 throw，由 execute 统一规约。
 *
 * ## 取消与重试（任务 B6a 要求；源都没有）
 *   · 取消：activeRuns 里记录运行中标志，cancelRun 置位；执行器在每次尝试前后检查，
 *     已领取但未开始的运行直接置 cancelled。取消只写状态 cancelled，绝不写 success。
 *   · 重试：action.retry = { maxAttempts(1..5), delayMs(0..600000) }，在**一次运行内**重试，
 *     运行记录仍只落一行（result 里写真实 attempts），与"每次重试一条记录"相比不会污染历史。
 *
 * 边界：渲染层自报的 userId / role / appId / sessionRef 一律忽略；actor 由 authorization.resolveActor
 * 从可信 sessionRef 推导（与 skill-service.cjs:216-225 / media-service.cjs 同一条边界）。
 * 返回值统一过 automation-domain.cjs 的 redactAutomationValue（绝对路径 / 密钥字段不过桥）。
 *
 * 参照：electron/skill-service.cjs:1-364、electron/media-service.cjs:1-180。
 */

const store = require("./automation-store.cjs");
const domain = require("./automation-domain.cjs");
const { createEventChannel } = require("./dxos-foundation-events.cjs");

/** 自动化能力承载的 App Principal：与 skill-service.cjs:34 / media-service.cjs:62 同一约定。 */
const HOST_APP_ID = "ai";
/** 主进程调度轮询周期（源 index.ts:10311 是 15s）。 */
const DEFAULT_TICK_MS = 15000;
/** app_action 的 serverAction 白名单（源 automationBusinessActions.ts:95-99 逐字）。 */
const TRUSTED_SERVER_ACTIONS = Object.freeze({
  ziniao: ["ziniao_download"],
  lingxing: ["lingxing_cache_sync", "ziniao_data_sync"],
  dingtalk: ["dingtalk_group_notify", "dingtalk_person_notify"],
});

const asStr = (value, max = 512) => (typeof value === "string" ? value.slice(0, max) : value == null ? undefined : String(value).slice(0, max));
const requireStr = (value, max = 512) => { const text = asStr(value, max); return text && text.length ? text : null; };
const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/** 源 automationBusinessActions.ts:63-67 */
function notificationContent(args, previousResult) {
  const base = String(args.content || "自动化任务已完成").trim();
  const replaced = base.replaceAll("{{上一步结果}}", previousResult || "").replaceAll("{{完成状态}}", "执行成功");
  return args.includeResult !== false && previousResult && !base.includes("{{上一步结果}}") ? replaced + "\n\n" + previousResult : replaced;
}

function createAutomationBundle(options = {}) {
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const logger = typeof options.logger === "function" ? options.logger : null;
  const sleeper = typeof options.sleeper === "function" ? options.sleeper : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const identityStore = options.identityStore || null;
  const authorization = options.authorization || null;
  const db = identityStore ? identityStore.connection || identityStore.db || null : null;
  const tickMs = Number.isFinite(options.tickMs) ? Math.max(250, options.tickMs) : DEFAULT_TICK_MS;

  const adapters = Object.freeze({
    developerApps: options.developerApps || null,
    integrations: options.integrations || null,
    desktop: options.desktop || null,
    agent: options.agent || null,
    localAccounts: options.localAccounts || null,
    toolCatalog: options.toolCatalog || null,
  });

  // app_action 的定义期参数规约只有 B7 适配器能给；未注入则定义 app_action 结构化失败。
  const appActions = adapters.developerApps && typeof adapters.developerApps.normalizeAction === "function"
    ? { normalize: (args) => adapters.developerApps.normalizeAction(args) }
    : null;

  if (db) store.configureAutomationStore({ db, clock, idFactory: options.idFactory, appActions });

  // ---- 事件（P1 信封；bootstrap 的 send 经 setEventSink 注入） ----
  const channel = createEventChannel({ domain: domain.AUTOMATION_EVENT_DOMAIN, clock });
  let eventSink = null;
  function setEventSink(fn) { eventSink = typeof fn === "function" ? fn : null; return true; }
  function emit(kind, payload) {
    const event = channel.emit(kind, payload);
    if (eventSink) { try { eventSink(event); } catch { /* 事件推送失败不改变业务结果 */ } }
    return event;
  }
  function log(message) { if (logger) { try { logger(message); } catch { /* 日志失败不影响业务 */ } } }

  // ---- 启动恢复（源 automations.ts:370-381） ----
  // 主进程是单实例调度器：装配时把上次遗留的 running 运行如实置 failed。
  // 绝不在这里写 success（重启不是成功），也绝不悄悄重跑（业务状态由人确认后 runNow）。
  if (db) {
    try {
      const recovered = store.recoverInterruptedRuns();
      if (recovered) log("[automation] recovered " + recovered + " interrupted runs as failed");
    } catch (error) {
      log("[automation] recover interrupted runs failed: " + String((error && error.message) || error));
    }
  }

  // ---- 运行中登记表（取消语义的载体） ----
  const activeRuns = new Map();

  function dependencyError(dependency, message) {
    return domain.createAutomationError(domain.AUTOMATION_ERR_DEPENDENCY_UNAVAILABLE, message || ("自动化依赖未装配：" + dependency), { dependency });
  }
  function requireAdapter(name) {
    const adapter = adapters[name];
    if (!adapter) throw dependencyError(name, "自动化依赖未装配：" + name + "（" + dependencyLabel(name) + "）");
    return adapter;
  }
  function dependencyLabel(name) {
    return {
      developerApps: "开发者 App，属 B7",
      integrations: "第三方集成插件（默认关闭）",
      desktop: "桌面执行端",
      agent: "Agent 运行时，属 B3",
      localAccounts: "本地账号服务，属 B4",
      toolCatalog: "既有工具目录",
    }[name] || name;
  }
  function requireMethod(name, method) {
    const adapter = requireAdapter(name);
    if (typeof adapter[method] !== "function") throw dependencyError(name + "." + method, "自动化依赖未装配：" + name + "." + method);
    return adapter[method].bind(adapter);
  }

  // -------------------------------------------------------------------------
  // 业务动作执行（源 automationBusinessActions.ts:69-147）
  // -------------------------------------------------------------------------

  /** 源 automationBusinessActions.ts:69-83：联动流程按顺序执行，失败定位到第几步。 */
  async function executeWorkflow(action, context) {
    const actions = Array.isArray(action.args.actions) ? action.args.actions : [];
    if (!actions.length) throw domain.createAutomationError(domain.AUTOMATION_ERR_INVALID_INPUT, "联动流程没有可执行动作");
    const results = [];
    for (let index = 0; index < actions.length; index += 1) {
      try {
        results.push(await executeAction(actions[index], Object.assign({}, context, { previousResult: results.at(-1) || "" })));
      } catch (error) {
        const code = domain.isAutomationError(error) ? error.code : domain.AUTOMATION_ERR_INVALID_INPUT;
        throw domain.createAutomationError(code, "第 " + (index + 1) + " 步执行失败：" + String((error && error.message) || error), domain.isAutomationError(error) ? error.detail : undefined);
      }
    }
    return results.map((result, index) => (index + 1) + ". " + result).join("\n");
  }

  /** 源 automationBusinessActions.ts:84-108：开发者 App 动作（B7 依赖，全部经注入适配器）。 */
  async function executeAppAction(action, context) {
    const adapter = requireAdapter("developerApps");
    const appId = String(action.args.appId || "");
    const actionId = String(action.args.actionId || "");
    const packs = typeof adapter.listPacks === "function" ? adapter.listPacks() : [];
    const pack = packs.find((item) => {
      const manifest = item && item.manifest;
      return item && (item.id === appId || (manifest && manifest.id === appId))
        && manifest && manifest.automation && Array.isArray(manifest.automation.actions)
        && manifest.automation.actions.some((candidate) => candidate.id === actionId);
    });
    if (!pack) throw domain.createAutomationError(domain.AUTOMATION_ERR_NOT_FOUND, "APP 自动化能力不存在：" + appId + "/" + actionId);
    const installed = typeof adapter.installedAppIds === "function" ? adapter.installedAppIds(context.userId) : [];
    if (!installed.includes(pack.id) && !installed.includes(pack.manifest.id)) {
      throw domain.createAutomationError(domain.AUTOMATION_ERR_INVALID_INPUT, "提供该能力的 APP 未安装：" + appId);
    }
    const declaration = pack.manifest.automation.actions.find((candidate) => candidate.id === actionId);
    if (!declaration) throw domain.createAutomationError(domain.AUTOMATION_ERR_NOT_FOUND, "APP 自动化能力不存在：" + appId + "/" + actionId);
    const values = isPlainObject(action.args.values) ? action.args.values : {};
    if (declaration.serverAction) {
      if (!(TRUSTED_SERVER_ACTIONS[appId] || []).includes(declaration.serverAction)) {
        throw domain.createAutomationError(domain.AUTOMATION_ERR_INVALID_INPUT, "第三方 APP 不能调用系统内部自动化动作");
      }
      return executeAction({ type: declaration.serverAction, args: values }, context);
    }
    if (!declaration.toolName) throw domain.createAutomationError(domain.AUTOMATION_ERR_INVALID_INPUT, "自动化动作没有可执行工具：" + appId + "/" + actionId);
    const localAccounts = requireAdapter("localAccounts");
    const actor = typeof localAccounts.findUser === "function" ? localAccounts.findUser(context.userId) : null;
    if (!actor) throw domain.createAutomationError(domain.AUTOMATION_ERR_INVALID_INPUT, "自动化所属账户不存在");
    const runTool = typeof adapter.runTool === "function"
      ? adapter.runTool.bind(adapter)
      : (typeof adapters.toolCatalog === "object" && adapters.toolCatalog && typeof adapters.toolCatalog.runTool === "function" ? adapters.toolCatalog.runTool.bind(adapters.toolCatalog) : null);
    if (!runTool) throw dependencyError("toolCatalog", "自动化依赖未装配：既有工具目录");
    const result = await runTool(declaration.toolName, values, actor, { sourceId: appId });
    return result && typeof result.text === "string" ? result.text : JSON.stringify(result);
  }

  /** 唯一动作分派口。未知动作/缺依赖一律 throw，绝不返回成功的假结果。 */
  async function executeAction(action, context) {
    if (!domain.isAutomationAction(action)) throw domain.createAutomationError(domain.AUTOMATION_ERR_INVALID_INPUT, "不支持的动作类型：" + String(action && action.type));
    if (action.type === "workflow_sequence") return executeWorkflow(action, context);
    if (action.type === "app_action") return executeAppAction(action, context);

    if (action.type === "lingxing_cache_sync") {
      const run = requireMethod("integrations", "lingxingCacheSync");
      return run(action.args);
    }
    if (action.type === "ziniao_download") {
      const run = requireMethod("integrations", "ziniaoDownload");
      return run(action.args);
    }
    if (action.type === "ziniao_data_sync") {
      const run = requireMethod("integrations", "ziniaoDataSync");
      return run(action.args);
    }
    if (action.type === "dingtalk_group_notify") {
      const send = requireMethod("integrations", "dingtalkGroupNotify");
      const sent = await send(String(action.args.channelId || "") || undefined, { text: notificationContent(action.args, context.previousResult) });
      if (!sent || sent.ok !== true) throw domain.createAutomationError(domain.AUTOMATION_ERR_UNAVAILABLE, (sent && sent.error) || "钉钉群机器人发送失败");
      return "钉钉通知已发送到群机器人「" + String(sent.channel || "") + "」";
    }
    if (action.type === "dingtalk_person_notify") {
      const send = requireMethod("integrations", "dingtalkPersonNotify");
      const recipient = String(action.args.recipient || "");
      await send(recipient, notificationContent(action.args, context.previousResult));
      return "钉钉通知已发送给 " + recipient;
    }
    if (action.type === "music_play") {
      const run = requireMethod("desktop", "musicPlay");
      return String(await run(action.args));
    }
    if (action.type === "music_control") {
      const run = requireMethod("desktop", "musicControl");
      return String(await run(action.args));
    }
    if (action.type === "open_app") {
      const run = requireMethod("desktop", "openApp");
      return String(await run(action.args));
    }
    if (action.type === "agent_instruction") {
      const run = requireMethod("agent", "runInstruction");
      const result = await run(String(action.args.instruction || ""), { userId: context.userId });
      return result && typeof result.text === "string" ? result.text : JSON.stringify(result);
    }
    throw domain.createAutomationError(domain.AUTOMATION_ERR_INVALID_INPUT, "不支持的动作类型：" + action.type);
  }

  // -------------------------------------------------------------------------
  // 一次运行的执行（重试 + 取消 + 落库）
  // -------------------------------------------------------------------------

  function retryPolicy(action) {
    const retry = action && isPlainObject(action.retry) ? action.retry : null;
    const maxAttempts = retry ? Math.min(5, Math.max(1, Math.floor(Number(retry.maxAttempts) || 1))) : 1;
    const delayMs = retry ? Math.min(600000, Math.max(0, Math.floor(Number(retry.delayMs) || 0))) : 0;
    return { maxAttempts, delayMs };
  }

  /**
   * 执行一条已领取的运行。返回 { runId, status, attempts, result?, error? }。
   * 无论成功 / 失败 / 取消，都恰好调用一次 completeAutomationRun 落库。
   */
  async function executeRun(claim) {
    const userId = claim.userId;
    const automation = claim.automation;
    const run = claim.run;
    const action = automation.action || {};
    const { maxAttempts, delayMs } = retryPolicy(action);
    const record = activeRuns.get(run.id) || { cancelled: false };
    activeRuns.set(run.id, record);
    let attempts = 0;
    let lastError = null;

    function isCancelled() {
      if (record.cancelled) return true;
      // 领取之后被其它路径直接取消（例如 cancelRun 在未登记时立即落 cancelled）。
      try { return store.getRun(userId, run.id).status !== "running"; } catch { return true; }
    }

    emit("progress", { automationId: automation.id, runId: run.id, phase: "started", maxAttempts });
    try {
      if (isCancelled()) {
        return { runId: run.id, status: "cancelled", attempts: 0, error: "运行已取消" };
      }
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (isCancelled()) break;
        attempts = attempt;
        try {
          const output = await executeAction(action, { userId, previousResult: "" });
          if (isCancelled()) break;
          const resultText = JSON.stringify({ attempts, output });
          store.completeAutomationRun(userId, run.id, { status: "success", result: resultText });
          emit("progress", { automationId: automation.id, runId: run.id, phase: "completed", attempts });
          return { runId: run.id, status: "success", attempts, result: output };
        } catch (error) {
          lastError = error;
          const message = String((error && error.message) || error);
          emit("progress", { automationId: automation.id, runId: run.id, phase: "attempt-failed", attempt, error: message });
          if (attempt < maxAttempts && !record.cancelled && delayMs > 0) await sleeper(delayMs);
        }
      }
      if (isCancelled()) {
        const cancelled = store.completeAutomationRun(userId, run.id, { status: "cancelled", error: "运行已取消" });
        emit("progress", { automationId: automation.id, runId: run.id, phase: "cancelled" });
        return { runId: run.id, status: "cancelled", attempts, error: "运行已取消", errorCode: domain.AUTOMATION_ERR_CANCELLED, run: cancelled };
      }
      const message = String((lastError && lastError.message) || "执行失败");
      // 结构化错误码保留到返回值：runNow(await) 与测试据此稳定判别"依赖缺失/参数错/内部错"。
      const errorCode = domain.isAutomationError(lastError) ? lastError.code : domain.AUTOMATION_ERR_INTERNAL;
      const errorDetail = domain.isAutomationError(lastError) ? lastError.detail : undefined;
      store.completeAutomationRun(userId, run.id, { status: "failed", error: message });
      emit("progress", { automationId: automation.id, runId: run.id, phase: "failed", attempts, error: message, errorCode });
      return { runId: run.id, status: "failed", attempts, error: message, errorCode, errorDetail };
    } finally {
      activeRuns.delete(run.id);
    }
  }

  /** 领取一个到点定义（不改状态之外的东西）；没有可领取的返回 null。 */
  function claimDue() {
    if (!db) throw dependencyError("db", "自动化依赖未装配：数据库");
    return store.claimDueAutomation({ now: clock() });
  }

  /** 调度器一次推进：领取 + 执行。返回执行结果；无可执行返回 null。 */
  async function tick() {
    const claim = claimDue();
    if (!claim) return null;
    return executeRun(claim);
  }

  let schedulerTimer = null;
  function startScheduler() {
    if (schedulerTimer) return false;
    schedulerTimer = setInterval(() => {
      // 调度轮询本身不 await：长动作不能阻塞主进程事件循环，也不能拖住下一轮领取。
      Promise.resolve()
        .then(() => tick())
        .catch((error) => log("[automation] scheduler tick failed: " + String((error && error.message) || error)));
    }, tickMs);
    if (typeof schedulerTimer.unref === "function") schedulerTimer.unref();
    emit("progress", { phase: "scheduler-started", intervalMs: tickMs });
    return true;
  }
  function stopScheduler() {
    if (!schedulerTimer) return false;
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    emit("progress", { phase: "scheduler-stopped" });
    return true;
  }
  /** 应用退出只停调度：绝不写运行状态（复用 app-shutdown.cjs 的"退出不是取消"规则）。 */
  function dispose() { stopScheduler(); return true; }

  /** 取消：运行中置标志（执行器会收敛）；已领取未开始直接落 cancelled。 */
  function cancelRun(userId, runId) {
    const run = store.getRun(userId, runId);
    if (run.status !== "running") throw domain.createAutomationError(domain.AUTOMATION_ERR_CONFLICT, "只有运行中的执行记录可以取消");
    const record = activeRuns.get(runId);
    if (record) {
      record.cancelled = true;
      emit("progress", { automationId: run.automationId, runId: runId, phase: "cancelling" });
      return { runId: runId, status: "cancelling", immediate: false };
    }
    const finished = store.completeAutomationRun(userId, runId, { status: "cancelled", error: "运行已取消" });
    emit("progress", { automationId: run.automationId, runId: runId, phase: "cancelled" });
    return { runId: runId, status: "cancelled", immediate: true, run: finished };
  }

  // -------------------------------------------------------------------------
  // IPC 命令分发
  // -------------------------------------------------------------------------

  function requireAutomationId(payload) {
    const id = requireStr(payload.automationId, 120) || requireStr(payload.id, 120);
    if (!id) throw domain.createAutomationError(domain.AUTOMATION_ERR_INVALID_INPUT, "automationId 必填");
    return id;
  }

  function definitionOf(payload) {
    if (isPlainObject(payload.definition)) return payload.definition;
    if (isPlainObject(payload.patch)) return payload.patch;
    return payload;
  }

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

  async function dispatch(command, payload, context) {
    const userId = context.userId;
    switch (command) {
      case "automation/list":
        return { automations: store.listAutomations(userId) };
      case "automation/get":
        return { automation: store.getAutomation(userId, requireAutomationId(payload)) };
      case "automation/create":
        return { automation: store.createAutomation(userId, definitionOf(payload)) };
      case "automation/update":
        return { automation: store.updateAutomation(userId, requireAutomationId(payload), definitionOf(payload)) };
      case "automation/delete":
        return store.deleteAutomation(userId, requireAutomationId(payload));
      case "automation/enable":
        return { automation: store.updateAutomation(userId, requireAutomationId(payload), { enabled: true }) };
      case "automation/disable":
        return { automation: store.updateAutomation(userId, requireAutomationId(payload), { enabled: false }) };
      case "automation/runNow": {
        const claim = store.runAutomationNow(userId, requireAutomationId(payload), requireStr(payload.clientId, 60) || "manual");
        if (payload.await === true) {
          const result = await executeRun(claim);
          const finished = store.getRun(userId, claim.run.id);
          // 运行记录已经如实落库（failed / cancelled）；等待模式下再把结构化错误抛给调用方，
          // 让 UI 拿到 error code 而不是只有一个字符串。fire-and-forget 模式则只靠 automation:event。
          if (result.status === "failed") throw domain.createAutomationError(result.errorCode || domain.AUTOMATION_ERR_INTERNAL, result.error || "执行失败", result.errorDetail);
          if (result.status === "cancelled") throw domain.createAutomationError(domain.AUTOMATION_ERR_CANCELLED, result.error || "运行已取消");
          return { automation: claim.automation, run: finished, result: result };
        }
        // 默认不等待：立即返回领取到的运行，执行在异步路径继续（事件走 automation:event）。
        void executeRun(claim).catch((error) => log("[automation] run failed: " + String((error && error.message) || error)));
        return { automation: claim.automation, run: claim.run, awaited: false };
      }
      case "automation/cancel":
        return cancelRun(userId, requireAutomationId(payload));
      case "automation/runs":
        return { runs: store.listRuns(userId, payload) };
      case "automation/catalog": {
        const catalog = requireMethod("developerApps", "catalog");
        return { apps: await catalog(userId) };
      }
      case "automation/parse": {
        const instruction = requireStr(payload.instruction, 4000);
        if (!instruction) throw domain.createAutomationError(domain.AUTOMATION_ERR_INVALID_INPUT, "请输入要自动执行的事情");
        return { definition: domain.parseAutomationFallback(instruction, { now: clock() }), parsedBy: "rules" };
      }
      case "automation/health":
        return {
          status: db ? "ok" : "degraded",
          dependencies: dependencies,
          schedulerRunning: schedulerTimer != null,
          tickMs: tickMs,
          commands: domain.listAutomationCommands().length,
          eventChannel: domain.AUTOMATION_EVENT_CHANNEL,
        };
      default:
        throw domain.automationCommandNotAllowed(command);
    }
  }

  const dependencies = Object.freeze({
    db: !!db,
    developerApps: !!adapters.developerApps,
    integrations: !!adapters.integrations,
    desktop: !!adapters.desktop,
    agent: !!adapters.agent,
    localAccounts: !!adapters.localAccounts,
    toolCatalog: !!adapters.toolCatalog,
    scheduler: typeof setInterval === "function",
  });

  /**
   * 唯一分发入口：白名单 → actor 解析 → dispatch → 脱敏；失败统一 normalizeAutomationError。
   * 每次执行前后各发一条 progress 事件（P1 信封），供渲染层显示与丢帧判定。
   */
  async function execute(command, payload, ctx = {}) {
    if (!domain.isAutomationCommand(command)) return domain.normalizeAutomationError(domain.automationCommandNotAllowed(command));
    const context = {
      sessionRef: requireStr(ctx && ctx.sessionRef, 160) || null,
      appId: requireStr(ctx && ctx.appId, 60) || HOST_APP_ID,
      source: "automation",
      requestId: requireStr(ctx && ctx.requestId, 100) || null,
    };
    emit("progress", { command: command, phase: "begin", requestId: context.requestId });
    const actorResult = resolveActor(context);
    if (!actorResult.ok) {
      emit("progress", { command: command, phase: "rejected", reason: "unauthenticated", requestId: context.requestId });
      return domain.normalizeAutomationError(domain.createAutomationError(domain.AUTOMATION_ERR_UNAUTHENTICATED, actorResult.message || "当前会话未认证，automation 命令被拒绝"));
    }
    context.userId = String(actorResult.user.id);
    context.actor = actorResult.user;
    const body = isPlainObject(payload) ? payload : {};
    try {
      const value = await dispatch(command, body, context);
      emit("progress", { command: command, phase: "completed", requestId: context.requestId });
      return { ok: true, value: domain.redactAutomationValue(value) };
    } catch (error) {
      emit("progress", { command: command, phase: "failed", requestId: context.requestId });
      return domain.normalizeAutomationError(error);
    }
  }

  return {
    execute,
    setEventSink,
    emitEvent: emit,
    claimDue,
    runClaimed: executeRun,
    tick,
    startScheduler,
    stopScheduler,
    dispose,
    cancelRun,
    executeAction,
    dependencies,
    /** 只读依赖清单（供 health 与测试；不含任何路径 / 凭据值）。 */
    get schedulerRunning() { return schedulerTimer != null; },
  };
}

module.exports = { createAutomationBundle, HOST_APP_ID, DEFAULT_TICK_MS, TRUSTED_SERVER_ACTIONS, notificationContent };
