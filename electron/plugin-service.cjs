/**
 * B7c/B7d · 集成域装配 + integration:command 分发（唯一执行入口）。
 *
 * 机制（任务书 item 1）：
 *   · 统一入口只有 command({ command, payload })；命令白名单在 INTEGRATION_COMMANDS（由
 *     INTEGRATION_COMMAND_META 的键生成，保证"白名单 ↔ 实现 ↔ 元数据"一一对应）；
 *   · 全部可选插件（钉钉 / 天气 / 黄历 / 领星 / 紫鸟 / 夸克 / RunningHub / ModelScope / Agnes）**默认全关**；
 *     未启用、或已启用但依赖缺失 /
 *     运行时能力未注入，一律返回结构化 { ok:false, error:"INTEGRATION_UNAVAILABLE", detail:"<缺什么、怎么装>" }，绝不假实现；
 *   · 开关落 <userData>/dxos/integrations.json（plugin-registry.cjs）；
 *   · 钉钉 / 领星 / 紫鸟凭据走 credential-store 的 safeStorage 后端；投影只给掩码，明文不落盘；
 *   · 绿星 / 紫鸟云 API 一律走**注入的 mcpCallDirect / transportFactory**；夸克走可注入的官方 CLI；
 *     未注入即结构化不可用；
 *   · 本域**没有** api.dx-os.com / 云端实时房间 / 远端更新（OUT，任务书硬约束）。
 *
 * 身份边界与 peers 一致：sessionRef / appId 由主进程注入（bootstrap），payload.userId / role / appId 忽略。
 */
"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");

const {
  createPluginRegistry,
  integrationPlugins,
  optionalPlugins,
  resolveBinaryPath,
  INTEGRATION_ERR_UNAVAILABLE,
  INTEGRATION_ERR_INVALID_INPUT,
  INTEGRATION_ERR_NOT_FOUND,
  INTEGRATION_ERR_INTERNAL,
} = require("./plugin-registry.cjs");
const { createDingtalkIntegration } = require("./integration-dingtalk.cjs");
const { createWeatherIntegration } = require("./integration-weather.cjs");
const { createAlmanacIntegration } = require("./integration-almanac.cjs");
const { createLingxingIntegration } = require("./integration-lingxing.cjs");
const { createZiniaoIntegration, ZINIAO_VENDOR_HINT } = require("./integration-ziniao.cjs");
const { createQuarkIntegration, QUARK_VENDOR_HINT } = require("./integration-quark.cjs");
const { createRunningHubIntegration } = require("./plugin-runninghub.cjs");
const { createModelScopeIntegration } = require("./plugin-modelscope.cjs");
const { createAgnesIntegration } = require("./plugin-agnes.cjs");
const { setLegacyExecutorPorts } = require("./legacy-executor-ports.cjs");
// B7e2 后续：CLI 协议族（即梦 / Codex / Gemini）的 legacy 执行器端口；只在对应 CLI 已安装时注入。
const { installLegacyCliPorts } = require("./legacy-cli-ports.cjs");
const { resolveDxosPaths } = require("./dxos-foundation-paths.cjs");
const { safeStorageCredentialBackend } = require("./credential-store.cjs");

const HOST_APP_ID = "ai";
const ALMANAC_CACHE_DIR_NAME = "calendar-almanac";
const INTEGRATIONS_DIR_NAME = "integrations";

/**
 * 命令元数据（唯一真值）：risk / credential / 中文 summary。
 * 白名单由本表键生成；新增命令必须同时在此登记并在 execute 的 switch 中实现。
 *   risk       read | use | manage | destructive（与 platform-domain.cjs:59-63 同级定义）
 *   credential 该命令是否把真实凭据带进执行路径（IPC 投影里会改名 needsCredential）
 *   summary    中文一句话，供 UI 与审计展示
 */
const INTEGRATION_COMMAND_META = Object.freeze({
  "integration/health": { risk: "read", credential: false, summary: "集成域健康：命令数 / 插件数 / 已启用插件" },
  "integration/commands": { risk: "read", credential: false, summary: "列出 integration 命令目录（risk / credential / 中文摘要）" },
  "integration/plugins/list": { risk: "read", credential: false, summary: "列出全部集成插件与开关状态（默认全关）" },
  "integration/plugins/get": { risk: "read", credential: false, summary: "读取单个集成插件的登记信息" },
  "integration/plugins/enable": { risk: "manage", credential: false, summary: "启用一个插件（必需依赖缺失时结构化拒绝）" },
  "integration/plugins/disable": { risk: "manage", credential: false, summary: "停用一个插件（保留配置，可再次启用）" },
  "integration/plugins/health": { risk: "read", credential: false, summary: "插件依赖健康报告（二进制 / Python 包 / 凭据 / 可选网络）" },
  "integration/dingtalk/status": { risk: "read", credential: false, summary: "钉钉集成状态：机器人数量 / safeStorage / fetch 可用性" },
  "integration/dingtalk/channels": { risk: "read", credential: false, summary: "列出钉钉机器人（Webhook 只回掩码）" },
  "integration/dingtalk/channels/save": { risk: "manage", credential: true, summary: "新建或更新钉钉机器人（Webhook / 加签密钥写入安全存储）" },
  "integration/dingtalk/channels/delete": { risk: "destructive", credential: false, summary: "删除钉钉机器人及其安全存储凭据" },
  "integration/dingtalk/contacts": { risk: "read", credential: false, summary: "列出本地记录过的钉钉联系人" },
  "integration/dingtalk/contacts/record": { risk: "manage", credential: false, summary: "记录一个钉钉联系人（本地累计，最多 200 条）" },
  "integration/dingtalk/send": { risk: "use", credential: true, summary: "经群机器人 Webhook 发送钉钉消息（真实外发）" },
  "integration/dingtalk/send-to-user": { risk: "use", credential: true, summary: "发送钉钉个人消息（需注入个人消息发送器）" },
  "integration/dingtalk/agent-config/get": { risk: "read", credential: false, summary: "读取钉钉应用配置（clientSecret 只回掩码）" },
  "integration/dingtalk/agent-config/save": { risk: "manage", credential: true, summary: "保存钉钉应用配置（clientSecret 写入安全存储）" },
  "integration/weather/query": { risk: "read", credential: false, summary: "查询城市 / 经纬度天气（经注入 fetch，离线不可用）" },
  "integration/almanac/years": { risk: "read", credential: false, summary: "查询在线万年历（按年缓存，离线不可用）" },
  "integration/lingxing/status": { risk: "read", credential: false, summary: "领星集成状态：transport / 数据目录 / 映射 / 缓存占用" },
  "integration/lingxing/mapping/get": { risk: "read", credential: false, summary: "读取领星映射数据集（字段 / 站点聚合 / 记录）" },
  "integration/lingxing/mapping/import": { risk: "manage", credential: false, summary: "导入领星映射表格（XLSX/CSV，经注入解析器）" },
  "integration/lingxing/mapping/file": { risk: "read", credential: false, summary: "返回最新领星映射源文件路径与内容类型" },
  "integration/lingxing/cache/stats": { risk: "read", credential: false, summary: "领星本地缓存统计（行数 / 天数 / 占用 / 广告 / 活动作业）" },
  "integration/lingxing/cache/sync/start": { risk: "use", credential: true, summary: "启动领星销售缓存同步作业（云查询，需注入 transport）" },
  "integration/lingxing/cache/sync/get": { risk: "read", credential: false, summary: "查询领星销售同步作业状态" },
  "integration/lingxing/cache/rows": { risk: "read", credential: false, summary: "按日读取领星本地明细行" },
  "integration/lingxing/cache/query": { risk: "read", credential: false, summary: "聚合查询领星本地数据（按 ASIN/SKU）" },
  "integration/lingxing/cache/clear": { risk: "destructive", credential: false, summary: "清理领星本地存储（销售 / 紫鸟 / 广告 / 全部）" },
  "integration/lingxing/advertising/sync/start": { risk: "use", credential: true, summary: "启动领星广告缓存同步作业（云查询，需注入 transport）" },
  "integration/lingxing/advertising/sync/get": { risk: "read", credential: false, summary: "查询领星广告同步作业状态" },
  "integration/lingxing/advertising/sync/stop": { risk: "manage", credential: false, summary: "停止领星广告同步作业" },
  "integration/lingxing/advertising/cache/stats": { risk: "read", credential: false, summary: "领星广告缓存统计（店铺 / 视图 / 行数）" },
  "integration/lingxing/advertising/cache/query": { risk: "read", credential: false, summary: "查询领星广告缓存（按范围 / 视图 / 店铺过滤）" },
  "integration/lingxing/credential/save": { risk: "manage", credential: true, summary: "保存领星 API 凭据（写入安全存储，只回掩码）" },
  "integration/lingxing/credential/status": { risk: "read", credential: false, summary: "读取领星凭据状态（只回掩码，不回明文）" },
  "integration/lingxing/analytics": { risk: "read", credential: false, summary: "领星业务分析（区间对比 / 日趋势 / 商品 / 维度 / 分组，源 lingxingBusinessAnalytics）" },
  "integration/lingxing/operator/dashboard": { risk: "read", credential: false, summary: "领星运营看板（按 ASIN 汇总销售与广告指标，源 queryLingxingOperatorDashboard）" },
  "integration/lingxing/operator/export": { risk: "read", credential: false, summary: "导出领星运营看板工作簿（需注入 workbookWriter，未注入即结构化不可用）" },
  "integration/lingxing/currency/rates": { risk: "read", credential: false, summary: "读取领星汇率（注入 fetch 时实时，否则回退内置汇率，源 getLingxingCurrencyRates）" },
  "integration/ziniao/status": { risk: "read", credential: false, summary: "紫鸟集成状态：transport / 数据目录 / 控制文件 / 活动作业" },
  "integration/ziniao/jobs/list": { risk: "read", credential: false, summary: "列出全部紫鸟下载作业（按创建时间倒序）" },
  "integration/ziniao/jobs/current": { risk: "read", credential: false, summary: "查询当前活动或最近的紫鸟下载作业" },
  "integration/ziniao/jobs/start": { risk: "use", credential: true, summary: "创建紫鸟 VC 汇总下载作业（真实抓取，需注入 transport）" },
  "integration/ziniao/jobs/control": { risk: "manage", credential: false, summary: "暂停 / 继续 / 停止紫鸟下载作业" },
  "integration/ziniao/jobs/delete": { risk: "destructive", credential: false, summary: "删除已结束的紫鸟下载作业记录" },
  "integration/ziniao/jobs/recover": { risk: "manage", credential: false, summary: "重启后恢复未完成的紫鸟下载作业（限流则进入冷却）" },
  "integration/ziniao/vc/files": { risk: "read", credential: false, summary: "列举紫鸟保存目录中的 VC 汇总 XLSX 文件" },
  "integration/ziniao/vc/import": { risk: "manage", credential: false, summary: "导入紫鸟 VC 汇总 XLSX 到本地缓存（需注入 workbookReader）" },
  "integration/ziniao/vc/rows": { risk: "read", credential: false, summary: "读取紫鸟 VC 行级明细（源 ziniaoVcRows）" },
  "integration/ziniao/vc/query": { risk: "read", credential: false, summary: "聚合查询紫鸟 VC 数据（源 queryZiniaoVcData）" },
  "integration/ziniao/credential/save": { risk: "manage", credential: true, summary: "保存紫鸟账号凭据（写入安全存储，只回掩码）" },
  "integration/ziniao/credential/status": { risk: "read", credential: false, summary: "读取紫鸟凭据状态（只回掩码，不回明文）" },
  "integration/quark/status": { risk: "read", credential: false, summary: "夸克 CLI 装配状态：路径 / 工作目录 / 搜索历史条目数" },
  "integration/quark/account": { risk: "read", credential: false, summary: "查询夸克登录态（昵称 / 用户 id，不回 token）" },
  "integration/quark/login/start": { risk: "use", credential: true, summary: "启动夸克扫码登录（派生官方 CLI，浏览器打开授权页）" },
  "integration/quark/login/stop": { risk: "manage", credential: false, summary: "停止进行中的夸克登录进程" },
  "integration/quark/logout": { risk: "manage", credential: true, summary: "退出夸克登录（调用官方 CLI unauthorize）" },
  "integration/quark/search": { risk: "read", credential: false, summary: "搜索夸克网盘文件（经官方 CLI，只读）" },
  "integration/quark/browse": { risk: "read", credential: false, summary: "浏览夸克网盘目录（CLI 不支持时降级为 search 模式）" },
  "integration/quark/download": { risk: "use", credential: true, summary: "从夸克网盘下载文件到本地目录（真实落盘）" },
  "integration/quark/upload": { risk: "use", credential: true, summary: "上传本地文件到夸克网盘（真实外发）" },
  "integration/quark/search-history/get": { risk: "read", credential: false, summary: "读取当前会话的夸克搜索历史（最多 12 条）" },
  "integration/quark/search-history/record": { risk: "manage", credential: false, summary: "记录一条夸克搜索关键词（去重、上限 12）" },
  "integration/quark/search-history/clear": { risk: "destructive", credential: false, summary: "清空当前会话的夸克搜索历史" },
  "integration/quark/downloads/clean": { risk: "destructive", credential: false, summary: "清理夸克下载临时产物（按保留时长）" },
  "integration/quark/credential/status": { risk: "read", credential: false, summary: "读取夸克登录态凭据投影（只回掩码 / 存在性，不回 token）" },
  "integration/runninghub/status": { risk: "read", credential: false, summary: "RunningHub 集成状态：fetch / safeStorage / Key 掩码" },
  "integration/runninghub/credentials/save": { risk: "manage", credential: true, summary: "保存 RunningHub API Key（写入安全存储，只回掩码）" },
  "integration/runninghub/credentials/delete": { risk: "destructive", credential: false, summary: "删除 RunningHub 安全存储中的 API Key" },
  "integration/runninghub/models": { risk: "read", credential: true, summary: "列出 RunningHub 模型目录（经注入 fetch，离线不可用）" },
  "integration/runninghub/generate-images": { risk: "use", credential: true, summary: "RunningHub 文生图 / 图生图（真实外发）" },
  "integration/runninghub/edit-images": { risk: "use", credential: true, summary: "RunningHub 图像编辑（上传参考图后执行）" },
  "integration/runninghub/generate-videos": { risk: "use", credential: true, summary: "RunningHub 视频生成（真实外发）" },
  "integration/runninghub/chat": { risk: "use", credential: true, summary: "RunningHub LLM 对话（源 callRunningHubChat，真实外发）" },
  "integration/runninghub/describe-image": { risk: "use", credential: true, summary: "RunningHub 图片描述 / 视觉问答（源 describeRunningHubImage，真实外发）" },
  "integration/runninghub/inspect": { risk: "read", credential: true, summary: "解析 RunningHub AI 应用 / 工作流字段（源 inspectRunningHubApp / inspectRunningHubWorkflow）" },
  "integration/runninghub/submit": { risk: "use", credential: true, summary: "提交 RunningHub AI 应用 / 工作流任务（源 submitRunningHubEntry，真实外发）" },
  "integration/runninghub/task/query": { risk: "read", credential: true, summary: "查询 RunningHub 任务输出（源 queryRunningHubTask）" },
  "integration/runninghub/upload": { risk: "use", credential: true, summary: "上传本地素材到 RunningHub（源 uploadRunningHubAsset，真实外发）" },
  "integration/agnes/status": { risk: "read", credential: false, summary: "Agnes 集成状态：fetch / safeStorage / Key 掩码 / 模型目录" },
  "integration/agnes/credentials/save": { risk: "manage", credential: true, summary: "保存 Agnes API Key（写入安全存储，只回掩码）" },
  "integration/agnes/credentials/delete": { risk: "destructive", credential: false, summary: "删除 Agnes 安全存储中的 API Key" },
  "integration/agnes/generate-images": { risk: "use", credential: true, summary: "Agnes 文生图（真实外发）" },
  "integration/agnes/edit-images": { risk: "use", credential: true, summary: "Agnes 图像编辑 / 参考图（真实外发）" },
  "integration/agnes/generate-videos": { risk: "use", credential: true, summary: "Agnes 视频生成 2.5 / 2.5 Flash / v2.0（真实外发）" },
  "integration/modelscope/status": { risk: "read", credential: false, summary: "ModelScope 集成状态：fetch / safeStorage / 令牌掩码" },
  "integration/modelscope/credentials/save": { risk: "manage", credential: true, summary: "保存 ModelScope 访问令牌（写入安全存储，只回掩码）" },
  "integration/modelscope/credentials/delete": { risk: "destructive", credential: false, summary: "删除 ModelScope 安全存储中的访问令牌" },
  "integration/modelscope/generate-images": { risk: "use", credential: true, summary: "ModelScope 图像生成（真实外发）" },
  "integration/modelscope/edit-images": { risk: "use", credential: true, summary: "ModelScope 图像编辑（真实外发）" },
});

/** 全部可执行的 integration 命令（白名单；由元数据键生成，二者恒等）。 */
const INTEGRATION_COMMANDS = Object.freeze(Object.keys(INTEGRATION_COMMAND_META));
const INTEGRATION_COMMAND_SET = new Set(INTEGRATION_COMMANDS);
function isIntegrationCommand(command) { return typeof command === "string" && INTEGRATION_COMMAND_SET.has(command); }
function describeIntegrationCommands() {
  return INTEGRATION_COMMANDS.map((command) => ({
    command,
    risk: INTEGRATION_COMMAND_META[command].risk,
    credential: INTEGRATION_COMMAND_META[command].credential,
    summary: INTEGRATION_COMMAND_META[command].summary,
  }));
}

const asStr = (value, max = 200) => (typeof value === "string" ? value.slice(0, max) : value == null ? undefined : String(value).slice(0, max));
const asText = (value, max = 4096) => (typeof value === "string" ? value.slice(0, max) : value == null ? "" : String(value).slice(0, max));

function normalizeIntegrationError(err) {
  if (err && typeof err === "object" && typeof err.code === "string" && err.code.startsWith("INTEGRATION_")) {
    return { ok: false, error: err.code, detail: String(err.message || err.code).slice(0, 400) };
  }
  return { ok: false, error: INTEGRATION_ERR_INTERNAL, detail: String((err && err.message) || err || INTEGRATION_ERR_INTERNAL).slice(0, 400) };
}

function createPluginBundle(options = {}) {
  const userDataDir = options.userDataDir ? String(options.userDataDir) : null;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const logger = typeof options.logger === "function" ? options.logger : null;
  const fetchImpl = typeof options.fetch === "function" ? options.fetch : null;
  const personalSender = typeof options.personalSender === "function" ? options.personalSender : null;
  const mcpCallDirect = typeof options.mcpCallDirect === "function" ? options.mcpCallDirect : null;
  const transportFactory = typeof options.transportFactory === "function" ? options.transportFactory : null;
  const workbookReader = typeof options.workbookReader === "function" ? options.workbookReader : null;
  const workbookWriter = typeof options.workbookWriter === "function" ? options.workbookWriter : null;
  const quarkCliPath = options.quarkCliPath ? String(options.quarkCliPath) : null;
  const quarkSpawnImpl = typeof options.quarkSpawnImpl === "function" ? options.quarkSpawnImpl : null;
  const quarkSpawnLoginImpl = typeof options.quarkSpawnLoginImpl === "function" ? options.quarkSpawnLoginImpl : null;
  const quarkNodePath = options.quarkNodePath ? String(options.quarkNodePath) : undefined;
  const paths = userDataDir ? resolveDxosPaths(userDataDir) : null;
  const integrationsRoot = paths ? path.join(paths.root, INTEGRATIONS_DIR_NAME) : null;

  // 凭据后端：生产只用 OS 安全后端；safeStorage 不可用 → 后端不可用（无明文 fallback）。
  const credentials = options.credentials && typeof options.credentials === "object"
    ? options.credentials
    : (options.safeStorage ? safeStorageCredentialBackend({ safeStorage: options.safeStorage, dir: userDataDir }) : null);
  const credentialsAvailable = !!credentials && typeof credentials.available === "function" && credentials.available() === true;

  /** 云 API 传输：优先注入的 mcpCallDirect；否则 transportFactory（每次调用带上安全存储里的凭据）。 */
  function resolveTransport(pluginId) {
    if (mcpCallDirect) return mcpCallDirect;
    if (typeof transportFactory !== "function") return null;
    return (server, tool, args) => {
      let credential = null;
      if (credentialsAvailable && typeof credentials.get === "function") { try { credential = credentials.get(pluginId + ".credential"); } catch { credential = null; } }
      const transport = transportFactory({ pluginId, server, tool, args, credential });
      if (typeof transport !== "function") {
        const error = new Error("transportFactory 未返回可用的传输函数"); error.code = INTEGRATION_ERR_UNAVAILABLE; throw error;
      }
      return transport(server, tool, args);
    };
  }

  // ── 新集成（B7d / B7e2）先建，供依赖探测与端口装配引用（探测只在 health/enable 时调用，闭包可后置赋值） ──
  let quarkIntegration = null;
  let runninghub = null;
  let modelscope = null;
  let agnes = null;

  const probes = Object.assign({}, options.probes);
  if (typeof probes.binary !== "function") {
    probes.binary = (target) => {
      if (target === "quark-drive.cjs") {
        const available = !!(quarkIntegration && quarkIntegration.cliAvailable());
        return available ? { ok: true, status: "ok", detail: "" } : { ok: false, status: "missing", detail: "未配置夸克官方 CLI (quark-drive.cjs)。" + QUARK_VENDOR_HINT };
      }
      const found = resolveBinaryPath(target);
      return found ? { ok: true, status: "ok", detail: "" } : { ok: false, status: "missing", detail: "PATH 中找不到 " + target };
    };
  }
  if (typeof probes.credential !== "function") {
    const refs = { lingxing: "lingxing.credential", ziniao: "ziniao.credential", quark: "quark.credential" };
    probes.credential = (dep, pluginId) => {
      // B7e2：RunningHub / ModelScope 的凭据判定由各自集成给出（RunningHub 有两个 ref，故不做通用 ref 查表）。
      if (pluginId === "runninghub" && runninghub) return runninghub.credentialProbe();
      if (pluginId === "modelscope" && modelscope) return modelscope.credentialProbe();
      if (pluginId === "agnes" && agnes) return agnes.credentialProbe();
      const ref = refs[pluginId];
      if (!ref) return null;
      const set = credentialsAvailable && typeof credentials.get === "function" ? !!credentials.get(ref) : false;
      return set ? { ok: true, status: "ok", detail: "" } : { ok: false, status: "missing", detail: "未配置「" + dep.label + "」" };
    };
  }

  const registry = options.registry || createPluginRegistry({
    userDataDir,
    clock,
    logger,
    fetch: fetchImpl,
    probes,
    plugins: [...integrationPlugins(), ...optionalPlugins(), ...(Array.isArray(options.plugins) ? options.plugins : [])],
    capabilities: { fetch: fetchImpl, safeStorage: credentialsAvailable, personalSender },
  });

  const lingxing = createLingxingIntegration({
    dataDir: integrationsRoot ? path.join(integrationsRoot, "lingxing") : null,
    credentials,
    transport: resolveTransport("lingxing"),
    readWorkbook: workbookReader,
    writeWorkbook: workbookWriter,
    fetch: fetchImpl,
    // 紫鸟 VC 导入需要与紫鸟插件一致的保存目录；ziniao 稍后同装配创建，闭包内延迟取用。
    ziniaoOutputRoot: () => (ziniao ? ziniao.ziniaoOutputRoot() : null),
    clock,
  });
  const ziniao = createZiniaoIntegration({
    dataDir: integrationsRoot ? path.join(integrationsRoot, "ziniao") : null,
    userDataDir,
    credentials,
    transport: resolveTransport("ziniao"),
    controlDir: options.controlDir,
    outDir: options.ziniaoOutDir,
    clock,
  });
  quarkIntegration = createQuarkIntegration({
    dataDir: integrationsRoot ? path.join(integrationsRoot, "quark") : null,
    userDataDir,
    credentials,
    cliPath: quarkCliPath,
    spawnImpl: quarkSpawnImpl,
    spawnLoginImpl: quarkSpawnLoginImpl,
    nodePath: quarkNodePath,
    clock,
  });

  // ── B7e2：RunningHub / ModelScope 可选集成（默认关闭；网络经注入 fetch，凭据走 credential-store，不落明文） ──
  runninghub = createRunningHubIntegration({
    fetch: fetchImpl,
    credentials,
    cacheDir: integrationsRoot ? path.join(integrationsRoot, "runninghub") : null,
    endpoints: options.runninghubEndpoints,
    modelDefinitions: options.runningHubModelDefinitions,
    clock,
  });
  modelscope = createModelScopeIntegration({ fetch: fetchImpl, credentials, clock });
  agnes = createAgnesIntegration({ fetch: fetchImpl, credentials, clock });

  const dingtalk = createDingtalkIntegration({
    dataDir: paths ? paths.root : null,
    credentials,
    fetch: fetchImpl,
    personalSender,
    clock,
  });
  const weather = createWeatherIntegration({ fetch: fetchImpl, endpoints: options.weatherEndpoints, clock });
  const almanac = createAlmanacIntegration({
    fetch: fetchImpl,
    source: options.almanacSource,
    cacheDir: options.almanacCacheDir || (paths ? path.join(paths.root, "integrations", ALMANAC_CACHE_DIR_NAME) : null),
    clock,
  });

  function unavailable(detail) { return { ok: false, error: INTEGRATION_ERR_UNAVAILABLE, detail }; }

  /** 插件闸门：未登记 / 未启用 / 缺依赖 / 缺运行时能力 → 结构化不可用，并给出可执行提示。 */
  async function gate(pluginId) {
    const plugin = registry.get(pluginId);
    if (!plugin) return { ok: false, error: INTEGRATION_ERR_NOT_FOUND, detail: "没有登记该插件：" + pluginId };
    if (!plugin.enabled) {
      return unavailable("插件「" + plugin.name + "」默认关闭；请先启用（integration/plugins/enable，id=" + plugin.id + "）");
    }
    const report = await registry.health(plugin.id);
    if (report.status === "unavailable") {
      return unavailable("插件「" + plugin.name + "」已启用但依赖缺失：" + (report.detail || "请检查依赖"));
    }
    return { ok: true, report };
  }

  /**
   * 闸门 + 动作：动作里的失败统一转结构化。
   * 注意：门内动作多为 async；若只依赖 execute 外层 catch，rejected promise 会绕过同步 try/catch。
   * 因此这里就地 catch 并复用 normalizeIntegrationError，保证"抛带 code 的 Error"也变成 { ok:false }。
   */
  async function gated(pluginId, action) {
    const allowed = await gate(pluginId);
    if (!allowed.ok) return allowed;
    try {
      return await action();
    } catch (error) {
      if (logger) { try { logger("integration-action-failed", { pluginId, message: asStr(error && error.message, 200) }); } catch { /* 忽略 */ } }
      return normalizeIntegrationError(error);
    }
  }

  /**
   * B7e2/B7e3：把 RunningHub / ModelScope / Agnes 接进 B2 legacy 执行器的注入端口。
   *   · 默认关闭 —— 端口已注册但插件未启用时，端口仍返回结构化 INTEGRATION_UNAVAILABLE；
   *   · options.installLegacyPorts === false 时不注册，legacy 执行器保持 B2 的 LEGACY_DEPENDENCY_UNAVAILABLE；
   *   · Agnes 端口直通 plugin-agnes.cjs 的真实实现（generateAgnesImages / editAgnesImages / generateAgnesVideos /
   *     fetchAgnesModelCatalog）；模型目录成功时还原成 legacy 约定的目录数组；
   *   · RunningHub 模型目录 fetchRunningHubModelCatalog 与 Agnes 同一适配（复用插件既有注册表定义）；
   *   · RunningHub 对话 / 图片理解（callRunningHubChat / describeRunningHubImage）把插件返回的
   *     integration 形状还原成 legacy 执行器约定（对话 { text, latencyMs, raw }、图片理解 string）。
   */
  function gateLegacyPort(pluginId, fn) {
    return async (...args) => {
      const plugin = registry.get(pluginId);
      if (!plugin || !plugin.enabled) {
        return { ok: false, error: INTEGRATION_ERR_UNAVAILABLE, detail: "插件「" + (plugin ? plugin.name : pluginId) + "」默认关闭；请先启用（integration/plugins/enable，id=" + pluginId + "）" };
      }
      return fn(...args);
    };
  }
  const legacyPorts = options.installLegacyPorts === false ? { applied: [] } : setLegacyExecutorPorts({
    generateRunningHubImages: gateLegacyPort("runninghub", runninghub.generateRunningHubImages),
    editRunningHubImages: gateLegacyPort("runninghub", runninghub.editRunningHubImages),
    generateRunningHubVideos: gateLegacyPort("runninghub", runninghub.generateRunningHubVideos),
    // B7e3 后续：RunningHub 对话 / 图片理解（源 runninghub.ts:270-289）。插件方法回 integration 形状
    // （{ ok:true, value:{ text, usage, latencyMs, raw } }），这里适配回 legacy 执行器约定；失败原样透传。
    callRunningHubChat: gateLegacyPort("runninghub", async (provider, model, input, params, timeoutMs, transport) => {
      const result = await runninghub.callRunningHubChat(provider, model, input, params, timeoutMs, transport);
      if (result && result.ok === false) return result;
      const value = (result && result.value) || {};
      return { text: value.text, usage: value.usage, latencyMs: value.latencyMs, raw: value.raw };
    }),
    describeRunningHubImage: gateLegacyPort("runninghub", async (provider, model, dataUrl, prompt, timeoutMs, transport) => {
      const result = await runninghub.describeRunningHubImage(provider, model, dataUrl, prompt, timeoutMs, transport);
      if (result && result.ok === false) return result;
      return String((result && result.value && result.value.text) || "");
    }),
    generateModelScopeImages: gateLegacyPort("modelscope", modelscope.generateModelScopeImages),
    editModelScopeImages: gateLegacyPort("modelscope", modelscope.editModelScopeImages),
    // B7e3 后续：Agnes 模型目录（源 protocols.ts:6763-6794 的 openai 目录路径）。插件方法回 integration 形状
    // （{ ok:true, value:{ items } }），这里还原成 legacy 执行器约定（fetchModelCatalog 成功直接返回目录数组）；
    // 「插件未启用」「缺凭据」由闸门与插件方法各自给出准确 detail。
    fetchAgnesModelCatalog: gateLegacyPort("agnes", async (provider, timeoutMs, transport) => {
      const result = await agnes.fetchAgnesModelCatalog(provider, timeoutMs, transport);
      if (result && result.ok === false) return result;
      return result && result.value && Array.isArray(result.value.items) ? result.value.items : [];
    }),
    // B7e3 后续：RunningHub 模型目录（同一适配）。插件方法回 integration 形状 { ok:true, value:{ items } }，
    // 这里还原成 legacy 执行器约定（fetchModelCatalog 成功直接返回目录数组）；模型列表复用插件既有注册表定义。
    fetchRunningHubModelCatalog: gateLegacyPort("runninghub", async (provider, timeoutMs, transport) => {
      const result = await runninghub.fetchRunningHubModelCatalog(provider, timeoutMs, transport);
      if (result && result.ok === false) return result;
      return result && result.value && Array.isArray(result.value.items) ? result.value.items : [];
    }),
    generateAgnesImages: gateLegacyPort("agnes", agnes.generateAgnesImages),
    editAgnesImages: gateLegacyPort("agnes", agnes.editAgnesImages),
    generateAgnesVideos: gateLegacyPort("agnes", agnes.generateAgnesVideos),
  });

  /**
   * B7e2 后续：CLI 协议族端口（cliJimeng / cliCodex / cliGemini）。
   *   · 与插件端口分开成 cliPorts，不改变 legacyPorts.applied 的既有键集合；
   *   · 只在「对应 CLI 已安装」时注册，未安装如实跳过，执行器继续回 LEGACY_DEPENDENCY_UNAVAILABLE；
   *   · options.installLegacyPorts === false 时只探测不注册（与插件端口同一开关）。
   */
  const cliPorts = installLegacyCliPorts({ install: options.installLegacyPorts !== false });

  /** B7e2：把源协议形状（{images,raw} / {videos,raw}）包成 integration 成功形状；结构化失败原样透传。 */
  function pipelineResult(result) {
    if (result && result.ok === false) return result;
    return { ok: true, value: result };
  }

  function bodyBuffer(body) {
    const raw = body && body.buffer;
    if (raw && (Buffer.isBuffer(raw) || raw instanceof Uint8Array)) return Buffer.from(raw);
    if (typeof body.bufferBase64 === "string" && body.bufferBase64) return Buffer.from(body.bufferBase64, "base64");
    return null;
  }

  async function execute(command, payload = {}, context = {}) {
    try {
      const sessionRef = context && context.sessionRef ? context.sessionRef : null;
      if (!sessionRef) return { ok: false, error: "INTEGRATION_UNAUTHENTICATED", detail: "integration:command 需要已认证会话" };
      if (!isIntegrationCommand(command)) {
        return { ok: false, error: "INTEGRATION_COMMAND_NOT_ALLOWED", detail: "未知或未授权的 integration 命令：" + String(command == null ? "" : command) };
      }
      const body = payload && typeof payload === "object" ? payload : {};
      const userId = asText(sessionRef, 200) || "local";

      switch (command) {
        case "integration/health":
          return { ok: true, value: { ok: true, commands: INTEGRATION_COMMANDS.length, plugins: registry.list().length, enabled: registry.list().filter((item) => item.enabled).map((item) => item.id) } };

        case "integration/commands":
          return { ok: true, value: { items: describeIntegrationCommands() } };

        case "integration/plugins/list":
          return { ok: true, value: { items: registry.list() } };

        case "integration/plugins/get": {
          const plugin = registry.get(body.id);
          if (!plugin) return { ok: false, error: INTEGRATION_ERR_NOT_FOUND, detail: "没有登记该插件：" + asStr(body.id, 60) };
          return { ok: true, value: { plugin } };
        }

        case "integration/plugins/health": {
          if (body.id) {
            const report = await registry.health(body.id, { probeNetwork: body.probeNetwork === true, force: body.force === true });
            if (!report) return { ok: false, error: INTEGRATION_ERR_NOT_FOUND, detail: "没有登记该插件：" + asStr(body.id, 60) };
            return { ok: true, value: { plugin: report } };
          }
          return { ok: true, value: { items: await registry.listHealth({ probeNetwork: body.probeNetwork === true, force: body.force === true }) } };
        }

        case "integration/plugins/enable": {
          const result = await registry.enable(body.id, { force: body.force === true, probeNetwork: body.probeNetwork === true });
          return result.ok ? result : { ok: false, error: result.error, detail: result.detail };
        }

        case "integration/plugins/disable": {
          const result = registry.disable(body.id);
          return result.ok ? result : { ok: false, error: result.error, detail: result.detail };
        }

        case "integration/dingtalk/status": {
          const allowed = await gate("dingtalk");
          if (!allowed.ok) return allowed;
          return dingtalk.status();
        }

        case "integration/dingtalk/channels": {
          const allowed = await gate("dingtalk");
          if (!allowed.ok) return allowed;
          return dingtalk.listChannels();
        }

        case "integration/dingtalk/channels/save": {
          const allowed = await gate("dingtalk");
          if (!allowed.ok) return allowed;
          return dingtalk.saveChannel(body);
        }

        case "integration/dingtalk/channels/delete": {
          const allowed = await gate("dingtalk");
          if (!allowed.ok) return allowed;
          return dingtalk.deleteChannel(body.id);
        }

        case "integration/dingtalk/contacts": {
          const allowed = await gate("dingtalk");
          if (!allowed.ok) return allowed;
          return dingtalk.listContacts();
        }

        case "integration/dingtalk/contacts/record": {
          const allowed = await gate("dingtalk");
          if (!allowed.ok) return allowed;
          return dingtalk.recordContact(body.userId, body.name);
        }

        case "integration/dingtalk/send": {
          const allowed = await gate("dingtalk");
          if (!allowed.ok) return allowed;
          return dingtalk.send({ channelId: body.channelId, msg: body.msg && typeof body.msg === "object" ? body.msg : { text: body.text, title: body.title, markdown: body.markdown } });
        }

        case "integration/dingtalk/send-to-user": {
          const allowed = await gate("dingtalk");
          if (!allowed.ok) return allowed;
          return dingtalk.sendToUser({ userId: body.userId, text: body.text });
        }

        case "integration/dingtalk/agent-config/get": {
          const allowed = await gate("dingtalk");
          if (!allowed.ok) return allowed;
          return dingtalk.getAgentConfig();
        }

        case "integration/dingtalk/agent-config/save": {
          const allowed = await gate("dingtalk");
          if (!allowed.ok) return allowed;
          return dingtalk.saveAgentConfig(body);
        }

        case "integration/weather/query": {
          const allowed = await gate("weather");
          if (!allowed.ok) return allowed;
          const latitude = Number(body.latitude);
          const longitude = Number(body.longitude);
          if (body.latitude != null && body.longitude != null && Number.isFinite(latitude) && Number.isFinite(longitude)) {
            return weather.getWeatherAt(latitude, longitude, asStr(body.locale, 20) || "zh-CN");
          }
          if (body.city != null) return weather.getWeather(asStr(body.city, 120) || "", asStr(body.locale, 20) || "zh-CN");
          return { ok: false, error: INTEGRATION_ERR_INVALID_INPUT, detail: "weather/query 需要 city，或 latitude + longitude" };
        }

        case "integration/almanac/years": {
          const allowed = await gate("almanac");
          if (!allowed.ok) return allowed;
          return almanac.onlineCalendarYears(body.years);
        }

        // ── B7d · 领星 ──
        case "integration/lingxing/status":
          return gated("lingxing", () => ({ ok: true, value: lingxing.status() }));

        case "integration/lingxing/mapping/get":
          return gated("lingxing", () => ({ ok: true, value: { mapping: lingxing.getLingxingMapping() } }));

        case "integration/lingxing/mapping/import": {
          const buffer = bodyBuffer(body);
          if (!buffer) return { ok: false, error: INTEGRATION_ERR_INVALID_INPUT, detail: "mapping/import 需要 buffer 或 bufferBase64" };
          return gated("lingxing", async () => ({ ok: true, value: { mapping: await lingxing.importLingxingMapping({ originalname: asText(body.fileName, 300) || "mapping.xlsx", buffer }) } }));
        }

        case "integration/lingxing/mapping/file":
          return gated("lingxing", () => ({ ok: true, value: lingxing.getLingxingMappingFile() }));

        case "integration/lingxing/cache/stats":
          return gated("lingxing", () => ({ ok: true, value: { cache: lingxing.lingxingCacheStats() } }));

        case "integration/lingxing/cache/sync/start":
          return gated("lingxing", () => ({ ok: true, value: { job: lingxing.startLingxingCacheSync(body.days) } }));

        case "integration/lingxing/cache/sync/get":
          return gated("lingxing", () => ({ ok: true, value: { job: lingxing.getLingxingCacheJob(asText(body.id, 80)) } }));

        case "integration/lingxing/cache/rows":
          return gated("lingxing", () => ({ ok: true, value: lingxing.lingxingLocalRows(asText(body.date, 20) || undefined, Number(body.limit) || 200, Number(body.offset) || 0) }));

        case "integration/lingxing/cache/query":
          return gated("lingxing", () => ({ ok: true, value: lingxing.queryLingxingLocalData(body) }));

        case "integration/lingxing/cache/clear":
          return gated("lingxing", () => ({ ok: true, value: { cache: lingxing.clearLingxingStoredData(body.scope) } }));

        case "integration/lingxing/advertising/sync/start":
          return gated("lingxing", () => ({ ok: true, value: { job: lingxing.startLingxingAdvertisingCacheSync(body.days, body.profileIds) } }));

        case "integration/lingxing/advertising/sync/get":
          return gated("lingxing", () => ({ ok: true, value: { job: lingxing.getLingxingAdvertisingCacheJob(asText(body.id, 80)) } }));

        case "integration/lingxing/advertising/sync/stop":
          return gated("lingxing", () => ({ ok: true, value: { job: lingxing.stopLingxingAdvertisingCacheJob(asText(body.id, 80)) } }));

        case "integration/lingxing/advertising/cache/stats":
          return gated("lingxing", () => ({ ok: true, value: { cache: lingxing.lingxingAdvertisingCacheStats() } }));

        case "integration/lingxing/advertising/cache/query":
          return gated("lingxing", () => ({ ok: true, value: lingxing.queryLingxingAdvertisingCache(body) }));

        case "integration/lingxing/credential/save":
          return gated("lingxing", () => ({ ok: true, value: lingxing.saveCredential(body) }));

        case "integration/lingxing/credential/status":
          return gated("lingxing", () => ({ ok: true, value: lingxing.credentialStatus() }));

        case "integration/lingxing/analytics":
          return gated("lingxing", () => ({ ok: true, value: lingxing.lingxingBusinessAnalytics(body) }));

        case "integration/lingxing/operator/dashboard":
          return gated("lingxing", () => ({ ok: true, value: lingxing.queryLingxingOperatorDashboard(body) }));

        case "integration/lingxing/operator/export":
          return gated("lingxing", async () => {
            const result = await lingxing.exportLingxingOperatorDashboard(body);
            return { ok: true, value: {
              fileName: result.fileName,
              mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              bytes: result.data.length,
              dataBase64: Buffer.from(result.data).toString("base64"),
            } };
          });

        case "integration/lingxing/currency/rates":
          return gated("lingxing", async () => ({ ok: true, value: await lingxing.getLingxingCurrencyRates() }));

        // ── B7d · 紫鸟 ──
        case "integration/ziniao/status":
          return gated("ziniao", () => ({ ok: true, value: ziniao.status() }));

        case "integration/ziniao/jobs/list":
          return gated("ziniao", () => ({ ok: true, value: { jobs: ziniao.listZiniaoDownloadJobs() } }));

        case "integration/ziniao/jobs/current":
          return gated("ziniao", () => ({ ok: true, value: { job: ziniao.getZiniaoDownloadJob() } }));

        case "integration/ziniao/jobs/start": {
          const stores = Array.isArray(body.stores)
            ? body.stores.map((store) => ({ selector: asText(store && store.selector, 200), name: asText(store && store.name, 200) })).filter((store) => store.selector)
            : [];
          return gated("ziniao", () => ({
            ok: true,
            value: { job: ziniao.startZiniaoDownloadJob({ from: asText(body.from, 40), to: asText(body.to, 40), outDir: asText(body.outDir, 500), requestIntervalSeconds: Number(body.requestIntervalSeconds) || 30, stores }) },
          }));
        }

        case "integration/ziniao/jobs/control": {
          const action = asText(body.action, 20);
          if (!["pause", "resume", "stop"].includes(action)) return { ok: false, error: INTEGRATION_ERR_INVALID_INPUT, detail: "不支持的任务操作：" + action };
          return gated("ziniao", () => ({ ok: true, value: { job: ziniao.controlZiniaoDownloadJob(asText(body.id, 80), action) } }));
        }

        case "integration/ziniao/jobs/delete":
          return gated("ziniao", () => ({ ok: true, value: ziniao.deleteZiniaoDownloadJobs(Array.isArray(body.ids) ? body.ids.map(String) : []) }));

        case "integration/ziniao/jobs/recover":
          return gated("ziniao", () => ({ ok: true, value: { job: ziniao.recoverZiniaoDownloadJob() } }));

        case "integration/ziniao/vc/files":
          return gated("ziniao", () => ({ ok: true, value: ziniao.listZiniaoVcFiles() }));

        case "integration/ziniao/vc/import":
          return gated("ziniao", async () => ({ ok: true, value: await lingxing.importZiniaoVcFile(asText(body.path, 1000)) }));

        case "integration/ziniao/vc/rows":
          return gated("ziniao", () => ({ ok: true, value: lingxing.ziniaoVcRows(asText(body.date, 20) || undefined, Number(body.limit) || 200, Number(body.offset) || 0) }));

        case "integration/ziniao/vc/query":
          return gated("ziniao", () => ({ ok: true, value: lingxing.queryZiniaoVcData(body) }));

        case "integration/ziniao/credential/save":
          return gated("ziniao", () => ({ ok: true, value: ziniao.saveCredential(body) }));

        case "integration/ziniao/credential/status":
          return gated("ziniao", () => ({ ok: true, value: ziniao.credentialStatus() }));

        // ── B7d · 夸克网盘 ──
        case "integration/quark/status":
          return gated("quark", () => ({ ok: true, value: quarkIntegration.status() }));

        case "integration/quark/account":
          return gated("quark", async () => ({ ok: true, value: await quarkIntegration.quarkStatus() }));

        case "integration/quark/login/start":
          return gated("quark", () => ({ ok: true, value: quarkIntegration.quarkStartLogin() }));

        case "integration/quark/login/stop":
          return gated("quark", () => { quarkIntegration.quarkStopLogin(); return { ok: true, value: { stopped: true } }; });

        case "integration/quark/logout":
          return gated("quark", async () => { await quarkIntegration.quarkLogout(); return { ok: true, value: { ok: true } }; });

        case "integration/quark/search":
          return gated("quark", async () => ({ ok: true, value: await quarkIntegration.quarkSearch(asText(body.query, 120), Number.isInteger(Number(body.category)) ? Number(body.category) : undefined) }));

        case "integration/quark/browse":
          return gated("quark", async () => ({ ok: true, value: await quarkIntegration.quarkBrowse(asText(body.pdirFid, 100) || "0") }));

        case "integration/quark/download": {
          const fid = asText(body.fid, 200);
          if (!fid) return { ok: false, error: INTEGRATION_ERR_INVALID_INPUT, detail: "quark/download 需要 fid" };
          const outDir = asText(body.outDir, 500) || path.join(quarkIntegration.quarkPaths.downloadDir, randomUUID());
          return gated("quark", async () => ({ ok: true, value: { file: await quarkIntegration.quarkDownload(fid, outDir) } }));
        }

        case "integration/quark/upload": {
          const filePath = asText(body.filePath, 1000);
          if (!filePath) return { ok: false, error: INTEGRATION_ERR_INVALID_INPUT, detail: "quark/upload 需要 filePath" };
          return gated("quark", async () => ({ ok: true, value: await quarkIntegration.quarkUpload(body.parentFid, filePath) }));
        }

        case "integration/quark/search-history/get":
          return gated("quark", () => ({ ok: true, value: { entries: quarkIntegration.quarkSearchHistory(userId) } }));

        case "integration/quark/search-history/record":
          return gated("quark", () => ({ ok: true, value: { entries: quarkIntegration.quarkRecordSearch(userId, asText(body.query, 200)) } }));

        case "integration/quark/search-history/clear":
          return gated("quark", () => { quarkIntegration.quarkClearSearchHistory(userId); return { ok: true, value: { entries: [] } }; });

        case "integration/quark/downloads/clean":
          return gated("quark", () => { quarkIntegration.quarkCleanDownloads(Number(body.olderThanMs) || undefined); return { ok: true, value: { cleaned: true } }; });

        case "integration/quark/credential/status":
          return gated("quark", () => ({ ok: true, value: quarkIntegration.quarkCredentialStatus() }));

        // ── B7e2 · RunningHub ──
        case "integration/runninghub/status":
          return gated("runninghub", () => runninghub.status());

        case "integration/runninghub/credentials/save":
          return gated("runninghub", () => runninghub.saveCredential(body));

        case "integration/runninghub/credentials/delete":
          return gated("runninghub", () => runninghub.deleteCredential());

        case "integration/runninghub/models":
          return gated("runninghub", () => runninghub.listModels(body.provider, body.timeoutMs));

        case "integration/runninghub/generate-images":
          return gated("runninghub", async () => pipelineResult(await runninghub.generateRunningHubImages(body.provider, body.model, body.params, body.timeoutMs)));

        case "integration/runninghub/edit-images":
          return gated("runninghub", async () => pipelineResult(await runninghub.editRunningHubImages(body.provider, body.model, body.params, body.images, body.timeoutMs)));

        case "integration/runninghub/generate-videos":
          return gated("runninghub", async () => pipelineResult(await runninghub.generateRunningHubVideos(body.provider, body.model, body.params, body.timeoutMs)));

        case "integration/runninghub/chat":
          return gated("runninghub", () => runninghub.callRunningHubChat(body.provider, body.model, body.input && typeof body.input === "object" ? body.input : { prompt: body.prompt }, body.params, body.timeoutMs));

        case "integration/runninghub/describe-image":
          return gated("runninghub", () => runninghub.describeRunningHubImage(body.provider, body.model, body.image != null ? body.image : body.images, asText(body.prompt, 4000), body.timeoutMs));

        case "integration/runninghub/inspect":
          return gated("runninghub", () => String(body.kind) === "workflow"
            ? runninghub.inspectRunningHubWorkflow(body.provider, asText(body.workflowId || body.id, 200), body.timeoutMs)
            : runninghub.inspectRunningHubApp(body.provider, asText(body.appId || body.id, 200), body.timeoutMs));

        case "integration/runninghub/submit":
          return gated("runninghub", () => runninghub.submitRunningHubEntry(body.provider, String(body.kind) === "workflow" ? "workflow" : "app", asText(body.id, 200), body.fields, body.useWallet === true, body.workflow, asText(body.instanceType, 80)));

        case "integration/runninghub/task/query":
          return gated("runninghub", () => runninghub.queryRunningHubTask(body.provider, asText(body.id, 200), body.useWallet === true));

        case "integration/runninghub/upload":
          // 闸门优先：未启用 / 缺依赖一律先结构化不可用，再校验入参（避免绕过插件开关）。
          return gated("runninghub", () => {
            const buffer = bodyBuffer(body);
            if (!buffer) return { ok: false, error: INTEGRATION_ERR_INVALID_INPUT, detail: "runninghub/upload 需要 buffer 或 bufferBase64" };
            return runninghub.uploadRunningHubAsset(body.provider, { buf: buffer, mime: asText(body.mime, 120) || "application/octet-stream", name: asText(body.fileName, 300) || "asset.bin" }, body.useWallet !== false, body.timeoutMs);
          });

        // ── B7e2 · ModelScope ──
        case "integration/modelscope/status":
          return gated("modelscope", () => modelscope.status());

        case "integration/modelscope/credentials/save":
          return gated("modelscope", () => modelscope.saveCredential(body));

        case "integration/modelscope/credentials/delete":
          return gated("modelscope", () => modelscope.deleteCredential());

        case "integration/modelscope/generate-images":
          return gated("modelscope", async () => pipelineResult(await modelscope.generateModelScopeImages(body.provider, body.model, body.params, body.timeoutMs)));

        case "integration/modelscope/edit-images":
          return gated("modelscope", async () => pipelineResult(await modelscope.editModelScopeImages(body.provider, body.model, body.params, body.images, body.timeoutMs)));

        // ── B7e3 · Agnes ──
        case "integration/agnes/status":
          return gated("agnes", () => agnes.status());

        case "integration/agnes/credentials/save":
          return gated("agnes", () => agnes.saveCredential(body));

        case "integration/agnes/credentials/delete":
          return gated("agnes", () => agnes.deleteCredential());

        case "integration/agnes/generate-images":
          return gated("agnes", async () => pipelineResult(await agnes.generateAgnesImages(body.provider, body.model, body.params, body.timeoutMs)));

        case "integration/agnes/edit-images":
          return gated("agnes", async () => pipelineResult(await agnes.editAgnesImages(body.provider, body.model, body.params, body.images, body.timeoutMs)));

        case "integration/agnes/generate-videos":
          return gated("agnes", async () => pipelineResult(await agnes.generateAgnesVideos(body.provider, body.model, body.params, body.timeoutMs)));

        default:
          return { ok: false, error: "INTEGRATION_COMMAND_NOT_ALLOWED", detail: "未知或未授权的 integration 命令：" + String(command) };
      }
    } catch (error) {
      if (logger) { try { logger("integration-execute-failed", { message: asStr(error && error.message, 200) }); } catch { /* 忽略 */ } }
      return normalizeIntegrationError(error);
    }
  }

  return {
    hostAppId: HOST_APP_ID,
    commands: INTEGRATION_COMMANDS.slice(),
    commandMeta: describeIntegrationCommands(),
    registry,
    credentials,
    dingtalk,
    weather,
    almanac,
    lingxing,
    ziniao,
    quark: quarkIntegration,
    runninghub,
    modelscope,
    agnes,
    legacyPorts,
    cliPorts,
    execute,
    isIntegrationCommand,
  };
}

module.exports = {
  createPluginBundle,
  INTEGRATION_COMMANDS,
  INTEGRATION_COMMAND_META,
  describeIntegrationCommands,
  isIntegrationCommand,
  normalizeIntegrationError,
  HOST_APP_ID,
  INTEGRATIONS_DIR_NAME,
};
