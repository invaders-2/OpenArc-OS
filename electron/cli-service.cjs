/**
 * DX OS 0.6.1 · CLI 域装配与分发（唯一执行入口；所有子进程调用集中在这一层）。
 *
 * 边界：
 *   · **只转发既有出口**，不重写任何探测 / 执行逻辑：
 *       - codex / gemini → electron/agent-cli-bridge.cjs 的
 *         probeAgentCliDependency / agentCliStatus / agentCliModels /
 *         agentCliLoginStart / agentCliLoginStatus / agentCliLogout；
 *       - jimeng（即梦）→ electron/agent-cli-tools.cjs 的
 *         probeJimengCli / jimengStatus / jimengModels / jimengCredit /
 *         jimengLoginStart / jimengLoginStatus / jimengLogout；
 *       - pippit（小云雀）→ electron/agent-pippit-tools.cjs 的
 *         probePippitCliDependency / pippitStatus / pippitModels / pippitCredit /
 *         pippitLoginStart / pippitLoginStatus / pippitLogout。
 *   · 未安装 → CLI_UNAVAILABLE（detail 逐字保留既有探测说明，含探测过哪些路径）；
 *   · 工具不具备该能力（codex/gemini 没有 credit、gemini 没有 logout）→ CLI_UNSUPPORTED；
 *   · 已确认的执行失败（子进程非零退出 / 登录进程提前结束）→ CLI_FAILED；
 *     真正未预期的异常仍由 domain 折叠为 DXOS_ERR_INTERNAL。
 *   · 不联网抓取任何非官方地址：登录链接 / 设备码只取自既有 CLI 的 stdout/stderr。
 *
 * cli/list 为什么不给 version：四个探测出口都不含版本，取版本必须启动 CLI
 * （即梦 user_credit / 小云雀 status / Codex login status 都可能数秒到十几秒）。
 * 列表只做无子进程的依赖探测，version 恒为 null；真实版本由 cli/status 给出。
 */
"use strict";

const foundationErrors = require("./dxos-foundation-errors.cjs");
const domain = require("./cli-domain.cjs");

function compact(value) {
  const out = {};
  for (const [key, item] of Object.entries(value || {})) if (item !== undefined) out[key] = item;
  return out;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * 装配 CLI 域。options 注入既有出口（测试可整替）；缺省即真实模块。
 * @param {{ bridge?: object, tools?: object, pippit?: object, logger?: Function }} options
 */
function createCliBundle(options = {}) {
  const bridge = options.bridge && typeof options.bridge === "object" ? options.bridge : require("./agent-cli-bridge.cjs");
  const tools = options.tools && typeof options.tools === "object" ? options.tools : require("./agent-cli-tools.cjs");
  const pippit = options.pippit && typeof options.pippit === "object" ? options.pippit : require("./agent-pippit-tools.cjs");
  const logger = typeof options.logger === "function" ? options.logger : null;

  /** 既有出口抛错 → 已知执行失败 CLI_FAILED（未知/域内错误原样上抛，由 domain 折叠）。 */
  async function invoke(label, fn) {
    try {
      return await fn();
    } catch (error) {
      if (domain.isCliError(error) || foundationErrors.isDxosError(error)) throw error;
      throw domain.cliFailed(label + "失败：" + String((error && error.message) || error), { causeCode: error && typeof error.code === "string" ? error.code : undefined });
    }
  }

  /** 逐个工具调用既有探测出口（未安装时 detail 即既有探测说明）。 */
  function probeTool(tool) {
    if (tool === "codex" || tool === "gemini") {
      const probe = bridge.probeAgentCliDependency(tool);
      if (probe && probe.installed === true) {
        return { installed: true, runtime: probe.runtime || null, command: (probe.runtime && probe.runtime.command) || null, detail: (probe.runtime && probe.runtime.detail) || null };
      }
      return { installed: false, runtime: null, command: null, detail: (probe && probe.detail) || "未检测到 CLI（探测出口没有返回 detail）" };
    }
    if (tool === "jimeng") {
      const probe = tools.probeJimengCli(true);
      if (probe && probe.installed === true) {
        return { installed: true, runtime: probe.runtime || null, command: probe.exe || (probe.runtime && probe.runtime.path) || null, detail: (probe.runtime && probe.runtime.detail) || null };
      }
      return { installed: false, runtime: null, command: null, detail: (probe && probe.detail) || "dreamina：未找到可执行文件（探测出口没有返回 detail）" };
    }
    const probe = pippit.probePippitCliDependency();
    if (probe && probe.installed === true) {
      return { installed: true, runtime: probe.runtime || null, command: (probe.runtime && probe.runtime.path) || null, detail: (probe.runtime && probe.runtime.detail) || null };
    }
    return { installed: false, runtime: null, command: null, detail: (probe && probe.detail) || "未检测到小云雀 CLI（探测出口没有返回 detail）" };
  }

  function safeProbe(tool) {
    try {
      return probeTool(tool);
    } catch (error) {
      return { installed: false, runtime: null, command: null, detail: "依赖探测失败：" + String((error && error.message) || error) };
    }
  }

  /** 只保留契约声明的 runtime 五字段；不伪造缺失字段。 */
  function runtimeView(tool, source, command) {
    if (!source || typeof source !== "object") return undefined;
    return compact({
      command: source.command || command || source.path || undefined,
      mode: source.mode === undefined ? undefined : String(source.mode),
      home: source.home === undefined ? undefined : String(source.home),
      label: source.label === undefined ? undefined : String(source.label),
      provider: source.provider === undefined ? tool : String(source.provider),
    });
  }

  function requireTool(payload) {
    const raw = payload && typeof payload === "object" ? payload.tool : undefined;
    const tool = typeof raw === "string" ? raw.trim() : "";
    if (!domain.isCliTool(tool)) {
      throw domain.cliInvalidInput("tool 必须是 " + domain.CLI_TOOL_ORDER.join(" / ") + " 之一", { tool: raw == null ? null : String(raw).slice(0, 60) });
    }
    return tool;
  }

  function assertCapability(tool, capability) {
    const meta = domain.cliToolEntry(tool);
    if (!meta) throw domain.cliInvalidInput("未知工具：" + String(tool));
    if (!meta.capabilities.includes(capability)) throw domain.cliUnsupported(tool, capability);
    return meta;
  }

  function assertInstalled(tool) {
    const probe = probeTool(tool);
    if (!probe.installed) throw domain.cliUnavailable(probe.detail, tool);
    return probe;
  }

  function normalizeModel(item) {
    if (typeof item === "string") return item.trim() ? { id: item, name: item } : null;
    if (!item || typeof item !== "object") return null;
    const id = String(item.model || item.id || "").trim();
    if (!id) return null;
    return { id, name: String(item.name || item.label || id) };
  }

  function modelsOf(catalog) {
    const raw = Array.isArray(catalog && catalog.model_items)
      ? catalog.model_items
      : Array.isArray(catalog && catalog.models)
        ? catalog.models.map((model) => ({ model }))
        : [];
    return raw.map(normalizeModel).filter(Boolean);
  }

  async function listTools() {
    const list = [];
    for (const id of domain.CLI_TOOL_ORDER) {
      const meta = domain.CLI_TOOLS[id];
      const probe = safeProbe(id);
      list.push(compact({
        id,
        name: meta.name,
        installed: probe.installed === true,
        version: null,
        detail: probe.detail || null,
        capabilities: [...meta.capabilities],
        loginRequired: meta.loginRequired,
      }));
    }
    return { tools: list };
  }

  async function statusTool(tool) {
    const probe = probeTool(tool);
    if (!probe.installed) return { tool, installed: false, version: null, loggedIn: null, detail: probe.detail || null };
    let status;
    if (tool === "codex" || tool === "gemini") status = await invoke("查询 " + tool + " 状态", () => bridge.agentCliStatus(tool));
    else if (tool === "jimeng") status = await invoke("查询即梦状态", () => tools.jimengStatus());
    else status = await invoke("查询小云雀状态", () => pippit.pippitStatus());
    const runtime = runtimeView(tool, { ...(probe.runtime || {}), ...(status && status.runtime ? status.runtime : {}) }, probe.command);
    return compact({
      tool,
      installed: !!(status && status.installed === true),
      version: status && status.cli_version != null ? String(status.cli_version) : null,
      loggedIn: status && status.logged_in === true ? true : status && status.logged_in === false ? false : null,
      runtime,
      detail: firstNonEmpty(status && status.message, status && status.error, probe.detail, status && status.runtime && status.runtime.detail, (probe.runtime && probe.runtime.detail) || null),
    });
  }

  async function modelsTool(tool) {
    assertInstalled(tool);
    if (tool === "codex" || tool === "gemini") {
      const catalog = await invoke("查询 " + tool + " 模型", () => bridge.agentCliModels(tool));
      return compact({ tool, models: modelsOf(catalog), cached: catalog && typeof catalog.cached === "boolean" ? catalog.cached : undefined });
    }
    if (tool === "jimeng") {
      const result = await invoke("查询即梦模型", () => tools.jimengModels());
      if (tools.isCliUnavailable(result)) throw domain.cliUnavailable(result.detail, tool);
      const list = Array.isArray(result && result.models) ? result.models : [];
      return compact({ tool, models: list.map((model) => ({ id: String(model), name: String(model) })), cached: result && typeof result.cached === "boolean" ? result.cached : undefined });
    }
    const result = await invoke("查询小云雀模型", () => pippit.pippitModels());
    return compact({ tool, models: modelsOf(result) });
  }

  async function creditTool(tool) {
    assertCapability(tool, "credit");
    assertInstalled(tool);
    if (tool === "jimeng") {
      const result = await invoke("查询即梦积分", () => tools.jimengCredit());
      if (tools.isCliUnavailable(result)) throw domain.cliUnavailable(result.detail, tool);
      return { tool, credit: result };
    }
    const result = await invoke("查询小云雀积分", () => pippit.pippitCredit());
    return { tool, credit: result };
  }

  function browserHint(url, fallback) {
    return firstNonEmpty(fallback, url ? "需要浏览器授权，请在浏览器中打开链接完成登录。" : "已发起登录流程。");
  }

  async function loginStartTool(tool) {
    assertCapability(tool, "login/start");
    assertInstalled(tool);
    if (tool === "codex" || tool === "gemini") {
      const result = await invoke("发起 " + tool + " 登录", () => bridge.agentCliLoginStart(tool));
      const url = firstNonEmpty(result && result.login_url, result && result.verification_uri);
      return compact({
        tool,
        started: true,
        url: url || undefined,
        code: firstNonEmpty(result && result.user_code, result && result.device_code) || undefined,
        detail: browserHint(url, firstNonEmpty(result && result.text, result && result.message)),
      });
    }
    if (tool === "jimeng") {
      const result = await invoke("发起即梦登录", () => tools.jimengLoginStart());
      if (tools.isCliUnavailable(result)) throw domain.cliUnavailable(result.detail, tool);
      const url = firstNonEmpty(result && result.login_url, result && result.qr_url, result && result.verification_uri);
      return compact({
        tool,
        started: true,
        url: url || undefined,
        code: firstNonEmpty(result && result.user_code, result && result.device_code) || undefined,
        detail: browserHint(url, firstNonEmpty(result && result.text, result && result.message)),
      });
    }
    const result = await invoke("发起小云雀登录", () => pippit.pippitLoginStart());
    if (!result || result.started !== true) throw domain.cliFailed("小云雀登录进程没有成功启动", { tool });
    const url = firstNonEmpty(result.login_url);
    return compact({
      tool,
      started: true,
      url: url || undefined,
      code: firstNonEmpty(result.user_code, result.device_code) || undefined,
      detail: browserHint(url, firstNonEmpty(result.text, result.message)),
    });
  }

  function loginStatusOf(result) {
    const loggedIn = !!(result && (result.logged_in === true || result.loggedIn === true));
    const running = !!(result && result.running === true);
    if (loggedIn) return { status: "authorized", detail: firstNonEmpty(result && result.text, result && result.message) || "已登录。" };
    if (running) return { status: "pending", detail: firstNonEmpty(result && result.text, result && result.message) || "正在等待授权…" };
    const failure = firstNonEmpty(result && result.error);
    if (failure || (result && result.failed === true)) return { status: "failed", detail: failure || firstNonEmpty(result && result.text, result && result.message) || "登录流程失败。" };
    return { status: "idle", detail: firstNonEmpty(result && result.text, result && result.message) || "当前不在登录流程中。" };
  }

  async function loginStatusTool(tool) {
    assertCapability(tool, "login/status");
    assertInstalled(tool);
    let result;
    if (tool === "codex" || tool === "gemini") result = await invoke("查询 " + tool + " 登录状态", () => bridge.agentCliLoginStatus(tool));
    else if (tool === "jimeng") result = await invoke("查询即梦登录状态", () => tools.jimengLoginStatus());
    else result = await invoke("查询小云雀登录状态", () => pippit.pippitLoginStatus());
    const view = loginStatusOf(result);
    return { tool, status: view.status, detail: view.detail };
  }

  async function logoutTool(tool) {
    assertCapability(tool, "logout");
    assertInstalled(tool);
    if (tool === "codex") {
      const result = await invoke("退出 Codex 登录", () => bridge.agentCliLogout("codex"));
      if (!result || result.success !== true) throw domain.cliFailed("Codex 退出登录失败", { tool });
      return { tool, loggedOut: true };
    }
    if (tool === "jimeng") {
      const result = await invoke("退出即梦登录", () => tools.jimengLogout());
      if (tools.isCliUnavailable(result)) throw domain.cliUnavailable(result.detail, tool);
      if (!result || result.success !== true) throw domain.cliFailed("即梦退出登录失败", { tool });
      return { tool, loggedOut: true };
    }
    const result = await invoke("退出小云雀登录", () => pippit.pippitLogout());
    if (!result || result.success !== true) throw domain.cliFailed("小云雀退出登录失败", { tool });
    return { tool, loggedOut: true };
  }

  /** 唯一执行入口：白名单 → 入参 → 分发 → 成功 {ok:true,value} / 失败 normalizeCliError。 */
  async function execute(command, payload) {
    try {
      if (!domain.isCliCommand(command)) throw domain.cliCommandNotAllowed(command);
      const body = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
      let value;
      switch (command) {
        case "cli/list": value = await listTools(); break;
        case "cli/status": value = await statusTool(requireTool(body)); break;
        case "cli/models": value = await modelsTool(requireTool(body)); break;
        case "cli/credit": value = await creditTool(requireTool(body)); break;
        case "cli/login/start": value = await loginStartTool(requireTool(body)); break;
        case "cli/login/status": value = await loginStatusTool(requireTool(body)); break;
        case "cli/logout": value = await logoutTool(requireTool(body)); break;
        default: throw domain.cliCommandNotAllowed(command);
      }
      return { ok: true, value: domain.redactCliValue(value) };
    } catch (error) {
      if (logger) { try { logger("[OpenArc cli] " + String((error && error.message) || error)); } catch { /* 日志失败不改变业务结果 */ } }
      return domain.normalizeCliError(error);
    }
  }

  return {
    bridge,
    tools,
    pippit,
    execute,
    listTools,
    statusTool,
    modelsTool,
    creditTool,
    loginStartTool,
    loginStatusTool,
    logoutTool,
    commands: domain.listCliCommands,
    toolsMeta: domain.listCliTools,
  };
}

module.exports = { createCliBundle };
