/**
 * B7c · 可选插件注册表（唯一真值：目录 + 依赖探测 + 开关状态 + 健康报告）。
 *
 * 只读源：
 *   · server/dingtalk.ts:36-120        机器人 / 联系人配置的读写与掩码投影（本批不在此文件实现，见 integration-dingtalk.cjs）
 *   · server/weather.ts:44-54          结果缓存与超时口径（本文件只登记"网络依赖"）
 *   · server/calendarAlmanac.ts:46-67  年份缓存文件（同上）
 *   · server/marketplace.ts:116-205    标识符 / 版本 / URL 规范化（见 market-domain.cjs）
 *
 * 机制（任务书要求，逐条对应）：
 *   ① 统一登记每个插件的 id / 名称 / 依赖探测 / 开关状态 / 健康报告；
 *   ② **默认全部关闭** —— 注册表从不自动置 enabled=true，缺省即 false；
 *   ③ "已安装才启用" —— required 依赖探测为 missing 时 enable 直接结构化拒绝（INTEGRATION_UNAVAILABLE）；
 *   ④ "缺依赖显式降级并提示" —— optional 依赖缺失或运行时能力未注入时，健康报告 status=degraded /
 *      unavailable，并给出可执行的安装提示（install 字段），**绝不假实现**；
 *   ⑤ 开关落 <userData>/dxos/integrations.json（纯 JSON，保留未知顶层键与未知插件条目）。
 *
 * 依赖探测三类（任务书）：binary（PATH 二进制）、python（Python 包）、network（网络可达性）。
 * 三类探测全部可注入 —— 测试注入假探测，**离线**跑；生产默认探测不联网、不下载。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveDxosPaths } = require("./dxos-foundation-paths.cjs");

// ── 统一错误码（与 platform-domain.cjs:31-41 的口径一致，不另造一套语义） ──
const INTEGRATION_ERR_UNAVAILABLE = "INTEGRATION_UNAVAILABLE";
const INTEGRATION_ERR_INVALID_INPUT = "INTEGRATION_INVALID_INPUT";
const INTEGRATION_ERR_NOT_FOUND = "INTEGRATION_NOT_FOUND";
const INTEGRATION_ERR_FORBIDDEN = "INTEGRATION_FORBIDDEN";
const INTEGRATION_ERR_INTERNAL = "INTEGRATION_INTERNAL";

const INTEGRATION_ERROR_CODES = Object.freeze([
  INTEGRATION_ERR_UNAVAILABLE,
  INTEGRATION_ERR_INVALID_INPUT,
  INTEGRATION_ERR_NOT_FOUND,
  INTEGRATION_ERR_FORBIDDEN,
  INTEGRATION_ERR_INTERNAL,
]);

/** 状态文件：<userData>/dxos/integrations.json（任务书硬要求，不改名、不迁到 SQLite）。 */
const STATE_FILE_NAME = "integrations.json";
const STATE_VERSION = 1;

/** 运行时能力（不是可安装依赖，而是主进程注入的函数）；未注入即不可用，且理由可读。 */
const CAPABILITY_HINTS = Object.freeze({
  fetch: "未注入 fetch（网络访问在主进程统一开关）；注入 fetch 后重试",
  safeStorage: "safeStorage 不可用，凭据无法加密保存（为不落明文，本功能停用）",
  personalSender: "未注入钉钉个人消息发送器（需 clientId/clientSecret 的 OpenAPI 客户端）",
});

/** 依赖类型 → 默认探测。三类都返回 { ok, status, detail }；ok=null 表示"探测不了"，不是"缺失"。 */
const DEP_KINDS = Object.freeze(["binary", "python", "network", "credential"]);

const BINARY_NAME_RE = /^[A-Za-z0-9._+-]{1,64}$/;
const PYTHON_MODULE_RE = /^[A-Za-z_][A-Za-z0-9_.]{0,127}$/;

const asStr = (value, max = 200) => (typeof value === "string" ? value.slice(0, max) : value == null ? "" : String(value).slice(0, max));

function normalizeProbeResult(value, label) {
  if (value === true) return { ok: true, status: "ok", detail: "" };
  if (value === false) return { ok: false, status: "missing", detail: label + "不可用" };
  if (value == null) return { ok: null, status: "unknown", detail: label + "未探测" };
  if (typeof value === "string") return { ok: false, status: "missing", detail: value.slice(0, 400) };
  if (typeof value === "object") {
    const ok = value.ok === true ? true : value.ok === false ? false : null;
    const status = value.status === "ok" || value.status === "missing" || value.status === "unknown" ? value.status : ok === true ? "ok" : ok === false ? "missing" : "unknown";
    return { ok, status, detail: asStr(value.detail, 400) };
  }
  return { ok: null, status: "unknown", detail: label + "探测结果无法识别" };
}

/** PATH 扫描（不 spawn、不联网）：binary 依赖的默认探测。 */
function resolveBinaryPath(name, pathValue = process.env.PATH || "") {
  if (!BINARY_NAME_RE.test(String(name || ""))) return null;
  const dirs = String(pathValue).split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* 继续 */ }
  }
  return null;
}

/** Python 包默认探测：本机 python3 -c "import <mod>"，3 秒超时；模块名先过白名单杜绝拼接注入。 */
function probePythonPackage(moduleName) {
  if (!PYTHON_MODULE_RE.test(String(moduleName || ""))) return { ok: null, status: "unknown", detail: "Python 包名不合法" };
  try {
    const result = spawnSync("python3", ["-c", "import " + moduleName], { timeout: 3000, stdio: "ignore" });
    if (result.error) return { ok: null, status: "unknown", detail: "找不到 python3：" + asStr(result.error.message, 160) };
    if (result.status === 0) return { ok: true, status: "ok", detail: "" };
    return { ok: false, status: "missing", detail: 'python3 -c "import ' + moduleName + '" 退出码 ' + result.status };
  } catch (error) {
    return { ok: null, status: "unknown", detail: asStr(error && error.message, 160) };
  }
}

/** 出网依赖默认探测：只在显式 probeNetwork 时调用；未注入 fetch 即 unknown（绝不偷偷联网）。 */
async function probeNetworkReachable(url, fetchImpl, timeoutMs = 4000) {
  if (typeof fetchImpl !== "function") return { ok: null, status: "unknown", detail: "未注入 fetch，跳过网络探测" };
  let target;
  try { target = new URL(url); } catch { return { ok: null, status: "unknown", detail: "网络探测地址不合法" }; }
  if (target.protocol !== "https:" && !(target.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(target.hostname))) {
    return { ok: null, status: "unknown", detail: "网络探测只允许 HTTPS（localhost 除外）" };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetchImpl(target.toString(), { method: "HEAD", signal: ctrl.signal, redirect: "manual" });
    return { ok: true, status: "ok", detail: "HTTP " + (response && response.status != null ? response.status : "?") };
  } catch (error) {
    return { ok: false, status: "missing", detail: "网络不可达：" + asStr(error && error.message, 160) };
  } finally { clearTimeout(timer); }
}

/**
 * 内置插件目录。**这里只登记"有什么、要什么、怎么装"**，不实现任何业务动作。
 * dependencies.required=true  → 缺失时禁止启用（已安装才启用）
 * dependencies.required=false → 缺失时降级并提示（能力仍在，只是不可用）
 */
function builtinPlugins() {
  return [
    {
      id: "dingtalk",
      name: "钉钉",
      description: "群机器人（加签 Webhook）消息发送与渠道 / 联系人列举。",
      kind: "integration",
      version: "1.0.0",
      capabilities: ["safeStorage"],
      dependencies: [
        {
          id: "dingtalk.credential",
          kind: "credential",
          label: "钉钉机器人 Webhook / 加签密钥",
          required: false,
          target: "dingtalk",
          install: "在「集成 · 钉钉」里添加群机器人并填写 Webhook 与加签密钥（凭据写入系统安全存储，不落明文）",
        },
        {
          id: "dingtalk.network",
          kind: "network",
          label: "钉钉开放平台可达",
          required: false,
          target: "https://oapi.dingtalk.com",
          install: "检查网络 / 代理；离线时消息发送会返回 INTEGRATION_UNAVAILABLE",
        },
      ],
    },
    {
      id: "weather",
      name: "天气",
      description: "open-meteo 城市天气（当前 + 未来 7 天），结果缓存 15 分钟。",
      kind: "integration",
      version: "1.0.0",
      capabilities: ["fetch"],
      dependencies: [
        {
          id: "weather.network",
          kind: "network",
          label: "open-meteo 可达",
          required: false,
          target: "https://api.open-meteo.com",
          install: "联网后可用；离线或未注入 fetch 时查询返回 INTEGRATION_UNAVAILABLE",
        },
      ],
    },
    {
      id: "almanac",
      name: "黄历",
      description: "在线万年历（节假日 / 节气 / 农历），按年缓存、当日新鲜则复用。",
      kind: "integration",
      version: "1.0.0",
      capabilities: ["fetch"],
      dependencies: [
        {
          id: "almanac.network",
          kind: "network",
          label: "uapis.cn 万年历可达",
          required: false,
          target: "https://uapis.cn",
          install: "联网后可用；离线或未注入 fetch 时查询返回 INTEGRATION_UNAVAILABLE",
        },
      ],
    },
  ];
}

/**
 * B7d · 三个"重集成"插件目录（领星 / 紫鸟 / 夸克网盘）。
 *
 * 为什么单独成函数而不是并进 builtinPlugins()：
 *   dxos-plugin.test.mjs:56-68 精确断言 builtinPlugins() 的 id 集合为 [almanac, dingtalk, weather]；
 *   三个新插件默认全关、依赖探测/能力更重，由 plugin-service.cjs 显式并入 registry，
 *   保持既有目录契约不动（任务书硬约束：不新增依赖、不回归既有测试）。
 *
 * 依赖探测（任务书）：
 *   · binary   —— 紫鸟 python3、夸克官方 CLI（quark-drive.cjs，由 plugin-service 注入探测）；
 *   · python   —— 紫鸟 requirements.txt 三个包（requests / selenium / openpyxl，optional 降级）；
 *   · credential —— 三个插件各自的可选凭据（走 credential-store/safeStorage，只给掩码）；
 *   · network  —— 三个插件各自的云端点，optional 且**默认不联网探测**（只有 probeNetwork 才探）。
 *
 * required=true 的依赖缺失 → enable 直接结构化 INTEGRATION_UNAVAILABLE（已安装才启用）。
 */
function integrationPlugins() {
  return [
    {
      id: "lingxing",
      name: "领星 ERP",
      description: "领星本地数据缓存 / 映射表格 / 销售与广告同步作业（云查询经注入 transport，未注入即不可用）。",
      kind: "integration",
      version: "1.0.0",
      capabilities: [],
      dependencies: [
        {
          id: "lingxing.credential",
          kind: "credential",
          label: "领星 API 凭据",
          required: false,
          target: "lingxing",
          install: "在「集成 · 领星」里填写 API 凭据（凭据写入系统安全存储，不落明文）",
        },
        {
          id: "lingxing.network",
          kind: "network",
          label: "领星云 API 可达",
          required: false,
          target: "https://api.lingxing.com",
          install: "检查网络 / 代理；离线或未注入 transport 时云同步返回 INTEGRATION_UNAVAILABLE",
        },
      ],
    },
    {
      id: "ziniao",
      name: "紫鸟浏览器",
      description: "紫鸟 VC 汇总下载作业（创建 / 查询 / 暂停 / 继续 / 停止 / 删除）与 VC 文件列举。",
      kind: "integration",
      version: "1.0.0",
      capabilities: [],
      dependencies: [
        {
          id: "ziniao.python3",
          kind: "binary",
          label: "python3",
          required: true,
          target: "python3",
          install: "安装 Python 3（紫鸟 MCP server 依赖 python）",
        },
        {
          id: "ziniao.requests",
          kind: "python",
          label: "Python 包 requests",
          required: false,
          target: "requests",
          install: "pip3 install requests",
        },
        {
          id: "ziniao.selenium",
          kind: "python",
          label: "Python 包 selenium",
          required: false,
          target: "selenium",
          install: "pip3 install selenium",
        },
        {
          id: "ziniao.openpyxl",
          kind: "python",
          label: "Python 包 openpyxl",
          required: false,
          target: "openpyxl",
          install: "pip3 install openpyxl",
        },
        {
          id: "ziniao.credential",
          kind: "credential",
          label: "紫鸟账号凭据",
          required: false,
          target: "ziniao",
          install: "在「集成 · 紫鸟」里填写账号凭据（凭据写入系统安全存储，不落明文）",
        },
        {
          id: "ziniao.network",
          kind: "network",
          label: "紫鸟服务可达",
          required: false,
          target: "https://www.ziniao.com",
          install: "检查网络 / 代理；离线或未注入 transport 时下载作业返回 INTEGRATION_UNAVAILABLE",
        },
      ],
    },
    {
      id: "quark",
      name: "夸克网盘",
      description: "夸克网盘官方 CLI（搜索 / 浏览 / 下载 / 上传 / 登录态），未配置 CLI 即结构化不可用。",
      kind: "integration",
      version: "1.0.0",
      capabilities: [],
      dependencies: [
        {
          id: "quark.cli",
          kind: "binary",
          label: "夸克官方 CLI (quark-drive.cjs)",
          required: true,
          target: "quark-drive.cjs",
          install: "把官方 quark-drive.cjs 放到应用 resources 下，或在 createPluginBundle 注入 quarkCliPath",
        },
        {
          id: "quark.network",
          kind: "network",
          label: "夸克开放平台可达",
          required: false,
          target: "https://open-api-drive.quark.cn",
          install: "检查网络 / 代理；离线时操作返回 INTEGRATION_UNAVAILABLE",
        },
        {
          id: "quark.credential",
          kind: "credential",
          label: "夸克登录态",
          required: false,
          target: "quark",
          install: "在「集成 · 夸克」中启动登录并完成扫码；登录态由官方 CLI 自行保存",
        },
      ],
    },
  ];
}

/**
 * B7e2/B7e3 · 网络型可选插件目录（RunningHub / ModelScope / Agnes）。
 *
 * 与 integrationPlugins()（B7d 三个重集成）同为"默认全关、装配时显式并入"的可选集成：
 *   · 不并进 builtinPlugins()，避免改变 tests/dxos-plugin.test.mjs:60 钉住的内置目录契约；
 *   · capabilities=["fetch","safeStorage"] —— 网络与凭据都必须由主进程注入；
 *   · 依赖 required=false：未配置时启用后为 degraded，调用时才返回 INTEGRATION_UNAVAILABLE；
 *   · credential 依赖的探测由 plugin-service 注入（各自回掩码投影 / 存在性）。
 */
function optionalPlugins() {
  return [
    {
      id: "runninghub",
      name: "RunningHub",
      description: "RunningHub 图片 / 视频模型执行与 AI 应用 / 工作流入口（协议 runninghub）。",
      kind: "integration",
      version: "1.0.0",
      capabilities: ["fetch", "safeStorage"],
      dependencies: [
        {
          id: "runninghub.credential",
          kind: "credential",
          label: "RunningHub API Key（RH币 / 账户余额）",
          required: false,
          target: "runninghub",
          install: "在「集成 · RunningHub」填写 API Key（写入系统安全存储，不落明文）",
        },
        {
          id: "runninghub.network",
          kind: "network",
          label: "RunningHub 站点可达",
          required: false,
          target: "https://www.runninghub.ai",
          install: "联网后可用；离线或未注入 fetch 时返回 INTEGRATION_UNAVAILABLE",
        },
      ],
    },
    {
      id: "modelscope",
      name: "ModelScope",
      description: "ModelScope 图像生成 / 图像编辑（协议 modelscope）。",
      kind: "integration",
      version: "1.0.0",
      capabilities: ["fetch", "safeStorage"],
      dependencies: [
        {
          id: "modelscope.credential",
          kind: "credential",
          label: "ModelScope 访问令牌",
          required: false,
          target: "modelscope",
          install: "在「集成 · ModelScope」填写访问令牌（写入系统安全存储，不落明文）",
        },
        {
          id: "modelscope.network",
          kind: "network",
          label: "ModelScope 推理服务可达",
          required: false,
          target: "https://api-inference.modelscope.cn",
          install: "联网后可用；离线或未注入 fetch 时返回 INTEGRATION_UNAVAILABLE",
        },
      ],
    },
    {
      id: "figma",
      name: "Figma",
      description: "Figma 预览 / 设计稿读取；Framelink MCP（figma-developer-mcp）由本机 npx 启动，需 Figma 访问令牌。",
      kind: "integration",
      version: "1.0.0",
      capabilities: ["fetch"],
      mcp: { serverId: "figma", transport: "stdio", command: "npx", args: ["-y", "figma-developer-mcp", "--stdio"], credentialRef: "figma.token", toolPrefix: "figma" },
      dependencies: [
        { id: "figma.mcp", kind: "binary", label: "Framelink MCP（figma-developer-mcp）", required: true, target: "figma-developer-mcp", install: "安装 figma-developer-mcp（npx / npm i -g）后重试" },
        { id: "figma.credential", kind: "credential", label: "Figma 访问令牌", required: true, target: "figma", install: "在「集成 · Figma」填写 Figma API Token（写入系统安全存储）" },
        { id: "figma.network", kind: "network", label: "Figma API 可达", required: false, target: "https://api.figma.com", install: "联网后可用；离线返回 INTEGRATION_UNAVAILABLE" },
      ],
    },
    {
      id: "illustrator",
      name: "Illustrator",
      description: "Illustrator 预览 / 模板 / 临时导出；Adobe Illustrator MCP 与本机 Adobe 为外部依赖。",
      kind: "integration",
      version: "1.0.0",
      capabilities: ["fetch"],
      mcp: { serverId: "illustrator", transport: "stdio", command: "illustrator-mcp", args: [], toolPrefix: "illustrator" },
      dependencies: [
        { id: "illustrator.mcp", kind: "binary", label: "Illustrator MCP", required: true, target: "illustrator-mcp", install: "配置 Illustrator MCP（本机 Adobe + MCP server）后重试" },
        { id: "illustrator.adobe", kind: "binary", label: "Adobe Illustrator", required: true, target: "Adobe Illustrator", install: "安装 Adobe Illustrator；本机无 Adobe 时预览/导出结构化不可用" },
        { id: "illustrator.network", kind: "network", label: "Adobe 服务可达", required: false, target: "https://www.adobe.com", install: "联网后可用；离线返回 INTEGRATION_UNAVAILABLE" },
      ],
    },
    {
      id: "agnes",
      name: "Agnes",
      description: "Agnes 原生图片编辑 / 视频适配（协议 agnes，2.5 / 2.5 Flash / v2.0）。",
      kind: "integration",
      version: "1.0.0",
      capabilities: ["fetch", "safeStorage"],
      dependencies: [
        {
          id: "agnes.credential",
          kind: "credential",
          label: "Agnes API Key",
          required: false,
          target: "agnes",
          install: "在「集成 · Agnes」填写 API Key（写入系统安全存储，不落明文）",
        },
        {
          id: "agnes.network",
          kind: "network",
          label: "Agnes 开放平台可达",
          required: false,
          target: "https://apihub.agnes-ai.com",
          install: "联网后可用；离线或未注入 fetch 时返回 INTEGRATION_UNAVAILABLE",
        },
      ],
    },
  ];
}

function createPluginRegistry(options = {}) {
  const userDataDir = options.userDataDir ? String(options.userDataDir) : null;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const logger = typeof options.logger === "function" ? options.logger : null;
  const fetchImpl = typeof options.fetch === "function" ? options.fetch : null;
  const capabilities = options.capabilities && typeof options.capabilities === "object" ? options.capabilities : {};

  const catalog = new Map();
  const extraPlugins = Array.isArray(options.plugins) ? options.plugins : [];
  for (const plugin of [...builtinPlugins(), ...extraPlugins]) {
    if (!plugin || typeof plugin !== "object") continue;
    const id = asStr(plugin.id, 60);
    if (!id) continue;
    catalog.set(id, {
      id,
      name: asStr(plugin.name, 80) || id,
      description: asStr(plugin.description, 300),
      kind: asStr(plugin.kind, 40) || "integration",
      version: asStr(plugin.version, 40) || "1.0.0",
      capabilities: Array.isArray(plugin.capabilities) ? plugin.capabilities.map((item) => asStr(item, 40)).filter(Boolean) : [],
      dependencies: Array.isArray(plugin.dependencies) ? plugin.dependencies.filter((dep) => dep && DEP_KINDS.includes(dep.kind)).map((dep) => ({
        id: asStr(dep.id, 80) || asStr(dep.kind, 40),
        kind: dep.kind,
        label: asStr(dep.label, 120) || asStr(dep.target, 120) || asStr(dep.kind, 40),
        required: dep.required === true,
        target: asStr(dep.target, 200),
        install: asStr(dep.install, 400),
      })) : [],
      probes: plugin.probes && typeof plugin.probes === "object" ? plugin.probes : {},
      // task-36 B15：把插件声明的 MCP 服务登记为可发现的模板（不自动连接/不执行）。
      mcp: plugin.mcp && typeof plugin.mcp === "object" ? {
        serverId: asStr(plugin.mcp.serverId, 80),
        transport: asStr(plugin.mcp.transport, 20),
        command: asStr(plugin.mcp.command, 200),
        args: Array.isArray(plugin.mcp.args) ? plugin.mcp.args.map((arg) => asStr(arg, 200)).filter(Boolean).slice(0, 32) : [],
        credentialRef: plugin.mcp.credentialRef ? asStr(plugin.mcp.credentialRef, 120) : null,
        toolPrefix: plugin.mcp.toolPrefix ? asStr(plugin.mcp.toolPrefix, 80) : null,
      } : null,
    });
  }

  const statePath = userDataDir ? path.join(resolveDxosPaths(userDataDir).root, STATE_FILE_NAME) : null;

  // ── 状态文件读写：保留未知顶层键与未知插件条目（"JSON 保留原格式"） ──
  let rawState = null;
  function readState() {
    if (rawState) return rawState;
    if (!statePath) { rawState = { version: STATE_VERSION, plugins: {} }; return rawState; }
    try {
      if (!fs.existsSync(statePath)) { rawState = { version: STATE_VERSION, plugins: {} }; return rawState; }
      const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { rawState = { version: STATE_VERSION, plugins: {} }; return rawState; }
      if (!parsed.plugins || typeof parsed.plugins !== "object" || Array.isArray(parsed.plugins)) parsed.plugins = {};
      rawState = parsed;
    } catch (error) {
      // 读坏不静默重置磁盘：内存回退默认（全关），下一次写入才会覆盖；原因打日志。
      if (logger) { try { logger("plugin-state-read-failed", { message: asStr(error && error.message, 200) }); } catch { /* 忽略 */ } }
      rawState = { version: STATE_VERSION, plugins: {} };
    }
    return rawState;
  }

  function entryOf(id) {
    const state = readState();
    const current = state.plugins[id];
    if (current && typeof current === "object" && !Array.isArray(current)) return current;
    const created = {};
    state.plugins[id] = created;
    return created;
  }

  function persistState() {
    const state = readState();
    state.version = STATE_VERSION;
    state.updatedAt = clock();
    if (!statePath) return false;
    const dir = path.dirname(statePath);
    const temp = statePath + "." + process.pid + "." + Date.now() + ".tmp";
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(state, null, 2), "utf8");
      fs.renameSync(temp, statePath);
      return true;
    } catch (error) {
      try { fs.rmSync(temp, { force: true }); } catch { /* 忽略 */ }
      if (logger) { try { logger("plugin-state-write-failed", { message: asStr(error && error.message, 200) }); } catch { /* 忽略 */ } }
      return false;
    } finally {
      try { if (fs.existsSync(temp)) fs.rmSync(temp, { force: true }); } catch { /* 忽略 */ }
    }
  }

  // ── 依赖探测（结果缓存 60 秒；测试可传 probe:true 强制重探） ──
  const probeCache = new Map();
  const PROBE_TTL_MS = 60 * 1000;

  const injectedProbes = options.probes && typeof options.probes === "object" ? options.probes : {};

  async function probeDependency(pluginId, dep, { probeNetwork = false, force = false } = {}) {
    const cacheKey = pluginId + "|" + dep.id;
    const cached = probeCache.get(cacheKey);
    if (!force && cached && clock() - cached.at < PROBE_TTL_MS) return cached.result;
    if (dep.kind === "network" && !probeNetwork) return { ok: null, status: "unknown", detail: "未请求网络探测（离线默认）" };

    let raw;
    try {
      if (dep.kind === "binary") {
        if (typeof injectedProbes.binary === "function") raw = await injectedProbes.binary(dep.target, dep);
        else raw = resolveBinaryPath(dep.target) ? { ok: true, status: "ok", detail: "" } : { ok: false, status: "missing", detail: "PATH 中找不到 " + dep.target };
      } else if (dep.kind === "python") {
        if (typeof injectedProbes.python === "function") raw = await injectedProbes.python(dep.target, dep);
        else raw = probePythonPackage(dep.target);
      } else if (dep.kind === "network") {
        if (typeof injectedProbes.network === "function") raw = await injectedProbes.network(dep.target, dep);
        else raw = await probeNetworkReachable(dep.target, fetchImpl);
      } else if (dep.kind === "credential") {
        if (typeof injectedProbes.credential === "function") raw = await injectedProbes.credential(dep, pluginId);
        else raw = { ok: null, status: "unknown", detail: "凭据由具体集成自行判定" };
      } else {
        raw = { ok: null, status: "unknown", detail: "不支持的依赖类型：" + dep.kind };
      }
    } catch (error) {
      raw = { ok: null, status: "unknown", detail: asStr(error && error.message, 200) };
    }
    const result = normalizeProbeResult(raw, dep.label);
    probeCache.set(cacheKey, { at: clock(), result });
    return result;
  }

  function capabilityMissing(plugin) {
    const missing = [];
    for (const name of plugin.capabilities) {
      const value = capabilities[name];
      if (typeof value === "function") continue;
      if (value === true) continue;
      missing.push(name);
    }
    return missing;
  }

  /** 健康报告：不抛异常，失败也体现在 status / detail 上。 */
  async function health(id, { probeNetwork = false, force = false } = {}) {
    const plugin = catalog.get(asStr(id, 60));
    if (!plugin) return null;
    const entry = entryOf(plugin.id);
    const enabled = entry.enabled === true;
    const dependencies = [];
    const missingRequired = [];
    const missingOptional = [];
    const degradedReasons = [];

    for (const dep of plugin.dependencies) {
      const result = await probeDependency(plugin.id, dep, { probeNetwork, force });
      dependencies.push({ id: dep.id, kind: dep.kind, label: dep.label, required: dep.required, status: result.status, detail: result.detail, install: dep.install });
      if (result.ok === false) {
        if (dep.required) missingRequired.push(dep.id); else missingOptional.push(dep.id);
      } else if (result.ok === null && dep.required) {
        degradedReasons.push(dep.label + " 无法确认（" + (result.detail || "探测不可用") + "）");
      }
    }

    const capabilityMissingList = capabilityMissing(plugin);
    let status;
    if (!enabled) status = "disabled";
    else if (missingRequired.length || capabilityMissingList.length) status = "unavailable";
    else if (missingOptional.length || degradedReasons.length) status = "degraded";
    else status = "healthy";

    const installHints = [];
    for (const dep of plugin.dependencies) {
      if (missingRequired.includes(dep.id) || missingOptional.includes(dep.id)) {
        installHints.push(dep.label + "：" + (dep.install || "请先安装/配置该依赖"));
      }
    }
    for (const name of capabilityMissingList) installHints.push(CAPABILITY_HINTS[name] || ("缺少运行时能力：" + name));
    for (const reason of degradedReasons) installHints.push(reason);

    return {
      id: plugin.id,
      name: plugin.name,
      kind: plugin.kind,
      version: plugin.version,
      description: plugin.description,
      enabled,
      status,
      dependencies,
      capabilities: plugin.capabilities.map((name) => ({ name, available: !capabilityMissingList.includes(name) })),
      missingRequired,
      missingOptional,
      mcp: plugin.mcp,
      detail: installHints.join("；"),
    };
  }

  async function listHealth(options = {}) {
    const items = [];
    for (const id of catalog.keys()) items.push(await health(id, options));
    return items;
  }

  /** 启用：required 依赖缺失时结构化拒绝（已安装才启用）；force 才允许"降级启用"。 */
  async function enable(id, { force = false, probeNetwork = false } = {}) {
    const plugin = catalog.get(asStr(id, 60));
    if (!plugin) return { ok: false, error: INTEGRATION_ERR_NOT_FOUND, detail: "没有登记该插件：" + asStr(id, 60) };
    const report = await health(plugin.id, { probeNetwork, force: true });
    if (report.missingRequired.length && !force) {
      return { ok: false, error: INTEGRATION_ERR_UNAVAILABLE, detail: "缺少必需依赖，无法启用「" + plugin.name + "」：" + report.detail };
    }
    entryOf(plugin.id).enabled = true;
    const persisted = persistState();
    const next = await health(plugin.id, { probeNetwork });
    return { ok: true, value: { id: plugin.id, enabled: true, persisted, status: next.status, detail: next.detail } };
  }

  function disable(id) {
    const plugin = catalog.get(asStr(id, 60));
    if (!plugin) return { ok: false, error: INTEGRATION_ERR_NOT_FOUND, detail: "没有登记该插件：" + asStr(id, 60) };
    entryOf(plugin.id).enabled = false;
    const persisted = persistState();
    return { ok: true, value: { id: plugin.id, enabled: false, persisted, status: "disabled" } };
  }

  function isEnabled(id) { const plugin = catalog.get(asStr(id, 60)); return !!plugin && entryOf(plugin.id).enabled === true; }

  function readPluginConfig(id) {
    const plugin = catalog.get(asStr(id, 60));
    if (!plugin) return null;
    const entry = entryOf(plugin.id);
    return entry.config && typeof entry.config === "object" && !Array.isArray(entry.config) ? Object.assign({}, entry.config) : {};
  }

  function writePluginConfig(id, patch) {
    const plugin = catalog.get(asStr(id, 60));
    if (!plugin) return { ok: false, error: INTEGRATION_ERR_NOT_FOUND, detail: "没有登记该插件：" + asStr(id, 60) };
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { ok: false, error: INTEGRATION_ERR_INVALID_INPUT, detail: "插件配置必须是对象" };
    const entry = entryOf(plugin.id);
    const current = entry.config && typeof entry.config === "object" && !Array.isArray(entry.config) ? entry.config : {};
    entry.config = Object.assign({}, current, patch);
    const persisted = persistState();
    return { ok: true, value: { id: plugin.id, config: Object.assign({}, entry.config), persisted } };
  }

  function list() {
    return [...catalog.values()].map((plugin) => ({
      id: plugin.id, name: plugin.name, description: plugin.description, kind: plugin.kind, version: plugin.version,
      enabled: entryOf(plugin.id).enabled === true,
      requiredDependencies: plugin.dependencies.filter((dep) => dep.required).map((dep) => dep.id),
      optionalDependencies: plugin.dependencies.filter((dep) => !dep.required).map((dep) => dep.id),
      capabilities: plugin.capabilities.slice(),
    }));
  }

  function get(id) {
    const plugin = catalog.get(asStr(id, 60));
    if (!plugin) return null;
    return list().find((item) => item.id === plugin.id) || null;
  }

  return {
    statePath,
    catalog,
    list,
    get,
    isEnabled,
    health,
    listHealth,
    enable,
    disable,
    readPluginConfig,
    writePluginConfig,
    readState,
    // 便于测试与复用
    probeDependency,
    resolveBinaryPath,
    probePythonPackage,
  };
}

module.exports = {
  createPluginRegistry,
  builtinPlugins,
  integrationPlugins,
  optionalPlugins,
  resolveBinaryPath,
  probePythonPackage,
  probeNetworkReachable,
  normalizeProbeResult,
  INTEGRATION_ERR_UNAVAILABLE,
  INTEGRATION_ERR_INVALID_INPUT,
  INTEGRATION_ERR_NOT_FOUND,
  INTEGRATION_ERR_FORBIDDEN,
  INTEGRATION_ERR_INTERNAL,
  INTEGRATION_ERROR_CODES,
  CAPABILITY_HINTS,
  DEP_KINDS,
  STATE_FILE_NAME,
  STATE_VERSION,
};
