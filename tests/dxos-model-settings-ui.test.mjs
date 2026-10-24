/**
 * 系统设置 › 模型与服务商 · 「协议设置」与「CLI」区块的离线单测。
 *
 * 只测纯逻辑，不启动浏览器 / Electron：
 *   · providerLogos.ts      服务商/协议 id → 品牌 logo（有/无、按主题选亮暗、未知 id 兜底）
 *   · cliPanelLogic.ts      冻结错误码 → 中文、CLI 登录四态、安装提示、回包投影
 *   · protocolSettingsLogic.ts  protocol/validate 的 issues → 文案、execution/ported 如实标注
 * 另外对着真实后端（electron/protocol-engine）核对 logo map 的键**不多不少**就是本仓的 provider id 宇宙。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
  PROVIDER_BRAND_LOGOS,
  PROVIDER_LOGOS,
  PROVIDER_LOGO_THEMES,
  PROVIDER_NAME_ALIASES,
  hasProviderLogo,
  providerInitials,
  providerLogoRender,
  providerLogoUrl,
  resolveProviderLogo,
  resolveProviderLogoKey,
} from "../src-vue/settings/providerLogos.ts";
import {
  CLI_ERROR_TEXT,
  cliErrorText,
  cliInstallHint,
  cliLoggedInText,
  cliStatusView,
  formatCliValue,
  normalizeCliList,
  normalizeCliModels,
} from "../src-vue/settings/cliPanelLogic.ts";
import {
  parseProtocolDraft,
  protocolDraftKind,
  protocolEngineText,
  protocolExecutionView,
  protocolPortedText,
  protocolSaveView,
  protocolSourceText,
  protocolValidateView,
} from "../src-vue/settings/protocolSettingsLogic.ts";
import {
  PROVIDER_INSECURE_WARNING,
  PROVIDER_SCOPE_HINT_CREATE,
  PROVIDER_SCOPE_HINT_EDIT,
  PROVIDER_SCOPE_OPTIONS,
  buildProviderCreatePayload,
  buildProviderUpdatePayload,
  isPlainRemoteHttp,
  isProviderScope,
  isScopeChange,
  needsInsecureOptIn,
  originOf,
  providerScopeHint,
  providerScopeLabel,
  scopeSelectDisabled,
  validateProviderDraft,
} from "../src-vue/settings/providerFormLogic.ts";
import {
  CAPABILITY_LABEL,
  CAPABILITY_SHORT,
  MODEL_CAPABILITIES,
  REMOTE_CLASSIFY_NOTE,
  REMOTE_GROUP_META,
  REMOTE_GROUP_ORDER,
  classifyRemoteModel,
  groupRemoteModels,
  guessCapabilitiesFromId,
  inferModelCoarseType,
  normalizeModelCapabilities,
} from "../src-vue/settings/modelCategories.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const require = createRequire(import.meta.url);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");

const builtins = require(path.join(ROOT, "electron", "protocol-engine", "builtins.cjs"));
const legacy = require(path.join(ROOT, "electron", "protocol-engine", "legacy-protocols.cjs"));

const V2_IDS = builtins.BUILTIN_PROVIDER_PROTOCOLS_V2.map((protocol) => protocol.id);
const LEGACY_IDS = Object.keys(legacy.PROVIDER_PROTOCOLS);
const REAL_IDS = [...new Set([...V2_IDS, ...LEGACY_IDS])].sort();
const LOGO_KEYS = Object.entries(PROVIDER_LOGOS)
  .filter(([, value]) => value !== null)
  .map(([key]) => key)
  .sort();
/** 无品牌资源的 5 个品牌（fhl / agtoken / zkki / apimart / pippit）对应的真实键。 */
const NO_RESOURCE_KEYS = ["agtoken", "agtoken-http", "apimart", "apimart-http", "cli:pippit", "fhl-http", "zkki", "zkki-http"];
const CJK = /[\u4e00-\u9fff]/;

/* ══ 1 provider → logo 映射 ══ */

test("logo map 的键不多不少 = 本仓真实 provider id 宇宙（v2 15 + legacy 21，去重 34）", () => {
  assert.equal(V2_IDS.length, 15, "v2 供应商协议 15 条");
  assert.equal(LEGACY_IDS.length, 21, "legacy 供应商协议 21 条（含协议包新增的官方 lovart）");
  assert.equal(REAL_IDS.length, 34, "两者交集 {openai-relay, agnes}，去重后 34");
  assert.deepEqual(Object.keys(PROVIDER_LOGOS).sort(), REAL_IDS, "映射键必须是真实 id，不新增也不遗漏");
});

test("有 logo / 无 logo 的判定：命中品牌资源表的键有 logo，其余为 null（不编造）", () => {
  assert.deepEqual(LOGO_KEYS, [
    "agnes", "aliyun-bailian", "aliyun-bailian-http", "cli:codex", "cli:dreamina-canvas", "cli:gemini", "cli:jimeng",
    "gemini-http", "grok2api", "lovart", "minimax", "minimax-http", "modelscope", "modelscope-http", "ollama", "ollama-http",
    "openai", "openai-http", "openai-relay", "runninghub", "volcengine", "volcengine-http", "volcengine-speech",
    "volcengine-speech-http", "xai", "xai-http",
  ]);
  for (const key of LOGO_KEYS) {
    assert.equal(hasProviderLogo(key), true, key + " 应有 logo");
    assert.ok(PROVIDER_LOGOS[key].light.path.length > 0 && PROVIDER_LOGOS[key].dark.path.length > 0);
  }
  // 没有资源的 fhl / agtoken / zkki / apimart / pippit 对应的键必须是 null
  // （lovart 的品牌 SVG 已由协议包 vendor 落地并补进品牌表，因此不在"无资源"之列）。
  assert.deepEqual(NO_RESOURCE_KEYS, ["agtoken", "agtoken-http", "apimart", "apimart-http", "cli:pippit", "fhl-http", "zkki", "zkki-http"]);
  for (const key of NO_RESOURCE_KEYS) {
    assert.equal(hasProviderLogo(key), false, key + " 没有品牌资源，不得编造");
  }
  for (const key of ["nope", ""]) assert.equal(hasProviderLogo(key), false, key + " 不得编造");
});

test("按主题选文件：单色 SVG 亮暗同文件（mask 跟主题色），RunningHub 亮暗是两版 PNG；路径都相对 public 根", () => {
  for (const key of LOGO_KEYS) {
    const light = resolveProviderLogo(key, "light");
    const dark = resolveProviderLogo(key, "dark");
    assert.ok(light && dark, key + " 亮暗都要能解析");
    assert.equal(light.theme, "light");
    assert.equal(dark.theme, "dark");
    assert.ok(light.url.startsWith("./"), light.url);
    assert.equal(light.url.startsWith("/"), false, "不得写绝对路径");
    assert.equal(light.url.includes("DX OS"), false, "不得引用 DX OS 的图标资产");
  }
  // 新的方形 mark（首选）：11 个抓取品牌亮暗同一文件，靠 mask + currentColor 适配主题。
  assert.equal(resolveProviderLogo("volcengine", "light").url, "./provider-logos/volcengine.svg");
  assert.equal(resolveProviderLogo("volcengine", "dark").url, "./provider-logos/volcengine.svg");
  assert.equal(resolveProviderLogo("modelscope", "light").url, "./provider-logos/modelscope.svg");
  assert.equal(resolveProviderLogo("modelscope", "dark").url, "./provider-logos/modelscope.svg");
  assert.equal(resolveProviderLogo("gemini-http", "light").url, "./provider-logos/google-gemini.svg");
  // RunningHub 用本仓黑白两版 PNG，按主题切文件。
  assert.equal(resolveProviderLogo("runninghub", "light").url, "./novai-canvas/static/images/RunningHub-B.png");
  assert.equal(resolveProviderLogo("runninghub", "dark").url, "./novai-canvas/static/images/RunningHub-W.png");
  // 只有 RunningHub 这种双文件品牌的亮暗 URL 不同。
  const dualFile = LOGO_KEYS.filter((key) => resolveProviderLogo(key, "light").url !== resolveProviderLogo(key, "dark").url);
  assert.deepEqual(dualFile, ["runninghub"]);
  assert.deepEqual(PROVIDER_LOGO_THEMES, ["light", "dark"]);
});

test("未知 id 兜底：返回 null（界面回退彩色首字母），主题缺失按 light", () => {
  assert.equal(resolveProviderLogo("nope", "dark"), null);
  assert.equal(resolveProviderLogo({ providerId: "api-1699", displayName: "某中转" }, "light"), null);
  assert.equal(resolveProviderLogoKey({ providerId: "nope" }), null);
  assert.equal(resolveProviderLogoKey(null), null);
  assert.equal(resolveProviderLogo("volcengine", undefined).theme, "light");
  assert.equal(resolveProviderLogo("volcengine", "weird").theme, "light");
  assert.equal(providerLogoUrl("novai-canvas/x.png"), "./novai-canvas/x.png");
  assert.equal(providerLogoUrl("./novai-canvas/x.png"), "./novai-canvas/x.png");
});

test("首字母回退与显示名别名（provider/list 不返回 protocol 字段）", () => {
  assert.equal(providerInitials("火山引擎"), "火");
  assert.equal(providerInitials("deepseek"), "DE");
  assert.equal(providerInitials(""), "?");
  assert.equal(providerInitials(null), "?");
  assert.deepEqual(PROVIDER_NAME_ALIASES["火山引擎"], "volcengine");
  assert.equal(resolveProviderLogoKey({ providerId: "api-1", displayName: "火山引擎方舟" }), "volcengine");
  assert.equal(resolveProviderLogoKey({ providerId: "api-2", displayName: "ModelScope" }), "modelscope");
  assert.equal(resolveProviderLogoKey({ providerId: "api-3", displayName: "RunningHub" }), "runninghub");
  assert.equal(resolveProviderLogoKey({ providerId: "api-4", displayName: "我的中转站" }), null);
});

test("豆包语音归入火山引擎方形 mark（manifest aliases 指定，不另造品牌）", () => {
  assert.equal(resolveProviderLogoKey("volcengine-speech"), "volcengine");
  assert.equal(resolveProviderLogoKey("volcengine-speech-http"), "volcengine");
  // 与火山引擎共用同一个方形 mark，且没有为语音单独编造资源。
  assert.equal(resolveProviderLogo("volcengine-speech", "light").url, resolveProviderLogo("volcengine", "light").url);
  assert.equal(resolveProviderLogo("volcengine-speech", "light").url, "./provider-logos/volcengine.svg");
  assert.equal(PROVIDER_BRAND_LOGOS.some((b) => b.brand.includes("speech")), false);
});

/* ══ 2 CLI 错误码 / 状态 ══ */

const FROZEN_CLI_ERRORS = [
  "CLI_COMMAND_NOT_ALLOWED",
  "CLI_NOT_READY",
  "CLI_INVALID_INPUT",
  "CLI_UNAVAILABLE",
  "CLI_UNSUPPORTED",
  "CLI_FAILED",
  "DXOS_ERR_INTERNAL",
];

test("冻结 CLI 错误码全部映射成中文，且文案里不出现原始码", () => {
  for (const code of FROZEN_CLI_ERRORS) {
    assert.ok(Object.prototype.hasOwnProperty.call(CLI_ERROR_TEXT, code), code + " 必须有登记文案");
    const text = cliErrorText(code);
    assert.ok(text.length > 0, code + " 文案不能为空");
    assert.ok(CJK.test(text), code + " 文案必须是中文");
    assert.equal(text.includes(code), false, code + " 原始码不得上屏");
  }
  assert.equal(cliErrorText("WHATEVER_UNKNOWN").includes("WHATEVER_UNKNOWN"), false);
  assert.ok(CJK.test(cliErrorText("")) && cliErrorText("").includes("没有返回错误码"));
  assert.ok(CJK.test(cliErrorText("NO_BRIDGE")));
});

test("CLI 登录状态 → 四态映射；未登记状态不猜语义", () => {
  const tones = new Set(["neutral", "success", "warning", "danger"]);
  for (const state of ["idle", "pending", "authorized", "failed"]) {
    const view = cliStatusView(state);
    assert.equal(view.state, state);
    assert.ok(view.label.length > 0 && view.detail.length > 0, state + " 必须有标签与说明");
    assert.ok(tones.has(view.tone), state + " 的 tone 必须合法");
  }
  assert.equal(cliStatusView("idle").label, "未开始");
  assert.equal(cliStatusView("pending").tone, "warning");
  assert.equal(cliStatusView("authorized").tone, "success");
  assert.equal(cliStatusView("failed").tone, "danger");
  assert.ok(cliStatusView("pending").detail.includes("不要当作已登录"));
  const unknown = cliStatusView("weird");
  assert.equal(unknown.state, null);
  assert.equal(unknown.label, "未知状态");
  assert.equal(cliLoggedInText(true), "已登录");
  assert.equal(cliLoggedInText(false), "未登录");
  assert.equal(cliLoggedInText(null), "未返回");
});

test("未安装一律给「怎么装」的执行提示，不是空白", () => {
  assert.ok(cliInstallHint({ id: "codex", name: "Codex" }).includes("npm install -g @openai/codex"));
  assert.ok(cliInstallHint({ id: "gemini", name: "Gemini" }).includes("@google/gemini-cli"));
  const generic = cliInstallHint({ id: "mystery", name: "Mystery", runtime: { command: "mystery-cli" } });
  assert.ok(generic.length > 0);
  assert.ok(CJK.test(generic));
  assert.ok(generic.includes("mystery-cli"));
  assert.ok(cliInstallHint(null).length > 0, "连工具信息都没有时也要给通用步骤");
});

test("cli/list 回包投影：字段缺失不补造，失败带中文原因", () => {
  const ok = normalizeCliList({
    ok: true,
    tools: [{ id: "codex", name: "Codex", installed: true, version: "1.2.3", detail: null, capabilities: ["chat"], loginRequired: true }],
  });
  assert.equal(ok.problem, null);
  assert.equal(ok.tools.length, 1);
  assert.deepEqual(ok.tools[0], {
    id: "codex", name: "Codex", installed: true, version: "1.2.3", detail: null,
    capabilities: ["chat"], loginRequired: true, runtime: null,
  });
  const missing = normalizeCliList({ ok: true, tools: [{ id: "x" }] });
  assert.equal(missing.tools[0].installed, false);
  assert.equal(missing.tools[0].version, null);
  assert.deepEqual(missing.tools[0].capabilities, []);
  const failed = normalizeCliList({ ok: false, error: "CLI_NOT_READY" });
  assert.deepEqual(failed.tools, []);
  assert.equal(failed.problem, cliErrorText("CLI_NOT_READY"));
  const malformed = normalizeCliList({ ok: true });
  assert.deepEqual(malformed.tools, []);
  assert.ok(CJK.test(malformed.problem));
});

test("cli/models 与额度值投影", () => {
  const models = normalizeCliModels({ ok: true, models: [{ id: "gpt-5", name: "GPT-5" }, "raw-model"], cached: true });
  assert.deepEqual(models.models, [{ id: "gpt-5", name: "GPT-5" }, { id: "raw-model", name: "raw-model" }]);
  assert.equal(models.cached, true);
  assert.equal(normalizeCliModels({ ok: true }).cached, null);
  assert.equal(formatCliValue(undefined), "未返回");
  assert.equal(formatCliValue(0), "0");
  assert.equal(formatCliValue({ remaining: 3 }), '{"remaining":3}');
});

/* ══ 3 协议校验 issues / execution ══ */

test("protocol/validate：通过就说通过，失败逐条列出 issues 且不吐原始码", () => {
  const passed = protocolValidateView({ ok: true, protocol: { id: "x" } });
  assert.equal(passed.ok, true);
  assert.deepEqual(passed.issues, []);
  assert.ok(CJK.test(passed.text));

  const failed = protocolValidateView({ ok: false, error: "PROTOCOL_INVALID", issues: ["缺少 label", "id 只能使用小写字母"] });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "PROTOCOL_INVALID");
  assert.deepEqual(failed.issues, ["缺少 label", "id 只能使用小写字母"]);
  assert.ok(failed.text.includes("缺少 label"));
  assert.ok(failed.text.includes("id 只能使用小写字母"));
  assert.equal(failed.text.includes("PROTOCOL_INVALID"), false, "原始码不得上屏");

  const noIssues = protocolValidateView({ ok: false, error: "PROTOCOL_INVALID" });
  assert.deepEqual(noIssues.issues, []);
  assert.ok(noIssues.text.includes("没有返回逐条 issues"));
  const unknown = protocolValidateView({ ok: false, error: "SOMETHING_NEW" });
  assert.equal(unknown.text.includes("SOMETHING_NEW"), false);
});

test("protocol/save：成功报条目 id，失败报中文原因 + detail", () => {
  const saved = protocolSaveView({ ok: true, entry: { id: "my-proto" } });
  assert.equal(saved.ok, true);
  assert.equal(saved.entryId, "my-proto");
  assert.ok(saved.text.includes("my-proto"));
  const noEntry = protocolSaveView({ ok: true });
  assert.equal(noEntry.entryId, null);
  assert.ok(CJK.test(noEntry.text));
  const rejected = protocolSaveView({ ok: false, error: "PROTOCOL_SAVE_REJECTED", detail: "协议校验失败：缺少 label" });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.text.includes("缺少 label"));
  assert.equal(rejected.text.includes("PROTOCOL_SAVE_REJECTED"), false);
});

test("execution / engine / ported 如实标注：conditional 与 unavailable 必须带出前提", () => {
  assert.equal(protocolExecutionView({ execution: "declarative" }).label, "声明式可执行");
  assert.equal(protocolExecutionView({ execution: "available" }).label, "内置实现，可直接执行");
  const cond = protocolExecutionView({ execution: "conditional", unavailableReason: "需安装 Codex CLI" });
  assert.equal(cond.label, "需要前提");
  assert.ok(cond.detail.includes("需安装 Codex CLI"));
  const unavail = protocolExecutionView({ execution: "unavailable", unavailableReason: "CLI 桥批次未实现" });
  assert.equal(unavail.tone, "danger");
  assert.ok(unavail.detail.includes("CLI 桥批次未实现"));
  const missing = protocolExecutionView({});
  assert.equal(missing.execution, null);
  assert.equal(missing.label, "未标注");
  assert.ok(missing.detail.includes("不推断"));
  const condNoReason = protocolExecutionView({ execution: "conditional" });
  assert.ok(condNoReason.detail.includes("后端未给出前提说明"));

  assert.equal(protocolEngineText("v2"), "声明式引擎（v2）");
  assert.equal(protocolEngineText("legacy"), "内置执行器（legacy）");
  assert.equal(protocolEngineText(""), "未返回");
  assert.equal(protocolPortedText(true), "已移植");
  assert.equal(protocolPortedText(false), "未移植");
  assert.equal(protocolPortedText(undefined), "未返回");
  assert.equal(protocolSourceText("builtin"), "内置");
  assert.equal(protocolSourceText("user"), "自建");
  assert.equal(protocolSourceText("plugin"), "插件");
});

test("草稿 JSON 解析与 kind 取值：空/坏 JSON 都给可执行中文提示", () => {
  assert.equal(parseProtocolDraft("").ok, false);
  assert.ok(CJK.test(parseProtocolDraft("").message));
  const bad = parseProtocolDraft("{not json");
  assert.equal(bad.ok, false);
  assert.ok(bad.message.includes("JSON 解析失败"));
  const good = parseProtocolDraft('{"kind":"provider","id":"x"}');
  assert.equal(good.ok, true);
  assert.equal(good.value.kind, "provider");
  assert.equal(protocolDraftKind('{"kind":"provider"}', "model"), "provider");
  assert.equal(protocolDraftKind("", "model"), "model");
  assert.equal(protocolDraftKind("", ""), "model");
});

/* ══ 4 界面边界与探针钩子 ══ */

test("两个面板只发冻结命令，不联网 / 不写 localStorage", () => {
  const protocolPanel = stripComments(read("src-vue/settings/ProtocolSettingsPanel.vue"));
  for (const command of ["protocol/list", "protocol/get", "protocol/validate", "protocol/save"]) {
    assert.ok(protocolPanel.includes(command), "协议设置必须用到 " + command);
  }
  assert.ok(protocolPanel.includes("openarc?.model"), "协议设置必须经 model 域取数");

  const cliPanel = stripComments(read("src-vue/settings/CliPanel.vue"));
  for (const command of ["cli/list", "cli/status", "cli/models", "cli/credit", "cli/login/start", "cli/login/status", "cli/logout"]) {
    assert.ok(cliPanel.includes(command), "CLI 面板必须用到 " + command);
  }
  assert.ok(cliPanel.includes("openarc?.cli"));
  for (const [rel, code] of [["src-vue/settings/ProtocolSettingsPanel.vue", protocolPanel], ["src-vue/settings/CliPanel.vue", cliPanel]]) {
    assert.equal(/\bfetch\s*\(/.test(code), false, rel + " 不得调用 fetch");
    assert.equal(/XMLHttpRequest|WebSocket|EventSource/.test(code), false, rel + " 不得使用网络对象");
    assert.equal(/localStorage|sessionStorage/.test(code), false, rel + " 不得写 localStorage/sessionStorage");
  }
});

test("设置页保留既有 d401 契约，并挂上两个新块的入口与容器", () => {
  const settings = read("src-vue/settings/ModelSettings.vue");
  for (const marker of [
    'data-d4-01="settings"',
    'data-d4-01-pane="providers"',
    'data-d4-01-pane="defaults"',
    "data-model-settings-protocol",
    "data-model-settings-protocol-toggle",
    "data-model-settings-protocol-container",
    "data-model-settings-cli",
    "data-model-settings-cli-toggle",
    "data-model-settings-cli-container",
    "data-provider-logo",
    "data-provider-logo-kind",
    "data-provider-logo-render",
    "data-provider-logo-theme",
    "mp2-logo-mark",
  ]) {
    assert.ok(settings.includes(marker), "设置页必须包含 " + marker);
  }
  const protocolPanel = read("src-vue/settings/ProtocolSettingsPanel.vue");
  for (const marker of ["data-protocol-settings", "data-protocol-settings-row", "data-protocol-settings-logo", "data-protocol-settings-logo-render", "data-protocol-settings-logo-theme", "pset-logo-mark", "data-protocol-settings-validate", "data-protocol-settings-save"]) {
    assert.ok(protocolPanel.includes(marker), "协议设置必须包含 " + marker);
  }
  const cliPanel = read("src-vue/settings/CliPanel.vue");
  for (const marker of ["data-cli-panel", "data-cli-tool", "data-cli-installed", "data-cli-install-hint", "data-cli-expand", "data-cli-action", "data-cli-error-code"]) {
    assert.ok(cliPanel.includes(marker), "CLI 面板必须包含 " + marker);
  }
});

/* ══ 5 品牌资源自动匹配（新增）与 manifest 防漂移 ══ */

const MANIFEST = JSON.parse(read("public/provider-logos/manifest.json"));

test("13 个抓取品牌全部能命中：manifest 每个 brand 的 aliases 逐条解析到自身", () => {
  assert.equal(MANIFEST.items.length, 13, "manifest 应登记 13 个抓取品牌（12 个 lobe 抓取 + 1 个官方仓库 lovart）");
  for (const item of MANIFEST.items) {
    const aliases = MANIFEST.aliases[item.brand];
    assert.ok(Array.isArray(aliases) && aliases.length, item.brand + " 必须有 aliases");
    for (const alias of aliases) {
      assert.equal(resolveProviderLogoKey(alias), item.brand, alias + " 应命中 " + item.brand);
    }
    const logo = resolveProviderLogo(aliases[0], "light");
    assert.ok(logo, item.brand + " 应能解析出 logo");
    assert.equal(logo.url, "./" + item.file, item.brand + " 应指向抓取文件");
  }
});

test("deepseek 品牌资源：别名 deepseek / deepseek-http 命中，头像走 mask 且文件真实存在", () => {
  assert.equal(resolveProviderLogoKey("deepseek"), "deepseek");
  assert.equal(resolveProviderLogoKey("deepseek-http"), "deepseek");
  assert.equal(resolveProviderLogoKey({ providerId: "prv_x", displayName: "DeepSeek" }), "deepseek");
  assert.equal(hasProviderLogo("deepseek"), true);
  const light = resolveProviderLogo("deepseek", "light");
  const dark = resolveProviderLogo("deepseek", "dark");
  assert.equal(light.url, "./provider-logos/deepseek.svg");
  assert.equal(dark.url, "./provider-logos/deepseek.svg");
  assert.equal(light.render, "mask", "单色 SVG 走 CSS mask 跟随主题文字色");
  assert.equal(light.multiColor, false);
  assert.equal(light.label, "DeepSeek");
  assert.ok(fs.existsSync(path.join(ROOT, "public", "provider-logos", "deepseek.svg")), "deepseek.svg 必须真实存在");
  // 首字母兜底函数仍然成立（不是靠它冒充品牌图形）。
  assert.equal(providerInitials("deepseek"), "DE");
});

test("runninghub 走本仓 PNG（浅 RunningHub-B / 深 RunningHub-W），不占用 provider-logos", () => {
  assert.equal(resolveProviderLogoKey("runninghub"), "runninghub");
  assert.equal(resolveProviderLogoKey({ providerId: "api-3", displayName: "RunningHub" }), "runninghub");
  const light = resolveProviderLogo("runninghub", "light");
  const dark = resolveProviderLogo("runninghub", "dark");
  assert.equal(light.url, "./novai-canvas/static/images/RunningHub-B.png");
  assert.equal(dark.url, "./novai-canvas/static/images/RunningHub-W.png");
  assert.equal(light.multiColor, false);
  assert.equal(light.render, "img", "PNG 用 <img>，按主题选文件");
  assert.equal(light.path.startsWith("provider-logos/"), false, "runninghub 不占用新的抓取资源");
  assert.ok(fs.existsSync(path.join(ROOT, "public", light.path)), light.path + " 必须真实存在");
  assert.ok(fs.existsSync(path.join(ROOT, "public", dark.path)), dark.path + " 必须真实存在");
});

test("5 个无资源品牌（fhl / agtoken / zkki / apimart / pippit）一律回退彩色首字母", () => {
  for (const brand of ["fhl", "agtoken", "zkki", "apimart", "pippit"]) {
    assert.equal(resolveProviderLogoKey(brand), null, brand + " 不得命中别的品牌");
    assert.equal(resolveProviderLogo(brand, "light"), null, brand);
    assert.equal(hasProviderLogo(brand + "-http"), false, brand + "-http");
  }
  assert.equal(resolveProviderLogoKey("cli:pippit"), null, "cli:pippit 也回退");
  assert.equal(providerInitials("FHL"), "FH", "回退文案仍用彩色首字母");
  assert.equal(providerInitials("ZKKI"), "ZK");
});

test("自定义未知 id / 未知显示名回退，不硬套别的品牌", () => {
  for (const identity of [
    { providerId: "prv_9f3a2b", displayName: "我的中转站" },
    { providerId: "api-1699", displayName: "某中转" },
    { providerId: "cli:whatever", displayName: "自建网关" },
    { providerId: "nope" },
    null,
    undefined,
  ]) {
    assert.equal(resolveProviderLogo(identity, "light"), null);
    assert.equal(resolveProviderLogoKey(identity), null);
  }
  // 自定义 providerId 但显示名是已知品牌 → 命中（与既有「显示名别名」用例同口径）。
  assert.equal(resolveProviderLogoKey({ providerId: "api-99", displayName: "Claude 中转" }), "claude");
});

test("mask / img 选择按 multiColor 与文件类型", () => {
  assert.equal(providerLogoRender("provider-logos/openai.svg", false), "mask", "单色 SVG 走 mask");
  assert.equal(providerLogoRender("provider-logos/openai.svg", true), "img", "多色 SVG 走 img");
  assert.equal(providerLogoRender("novai-canvas/static/images/RunningHub-B.png", false), "img", "PNG 走 img");
  assert.equal(providerLogoRender("novai-canvas/static/images/modelscope.gif", false), "img", "GIF 走 img");
  for (const item of MANIFEST.items) {
    const logo = resolveProviderLogo(MANIFEST.aliases[item.brand][0], "dark");
    assert.equal(logo.render, item.multiColor ? "img" : "mask", item.brand);
    assert.equal(logo.multiColor, item.multiColor, item.brand);
  }
  assert.equal(resolveProviderLogo("runninghub", "dark").render, "img");
});

test("两个面板按 render 分支：mask 用 currentColor + mask-image，img 才用 <img>", () => {
  for (const rel of ["src-vue/settings/ModelSettings.vue", "src-vue/settings/ProtocolSettingsPanel.vue"]) {
    const code = stripComments(read(rel));
    assert.ok(code.includes("render === 'mask'"), rel + " 必须有 mask 分支");
    assert.ok(code.includes("maskImage"), rel + " 必须用 CSS mask");
    assert.ok(code.includes("WebkitMaskImage"), rel + " 必须带 -webkit-mask-image 前缀");
    assert.ok(code.includes("background-color: currentColor"), rel + " mask 标记必须 background: currentColor");
  }
});

test("防漂移：TS 品牌表与 manifest 的品牌集合 / 文件 / multiColor 一致，aliases 逐条自动命中", () => {
  const fromManifest = PROVIDER_BRAND_LOGOS.filter((b) => b.manifestFile !== null);
  assert.deepEqual(
    fromManifest.map((b) => b.brand).sort(),
    MANIFEST.items.map((i) => i.brand).sort(),
    "TS 里来源为 manifest 的品牌集合必须与 manifest.items 完全一致",
  );
  for (const item of MANIFEST.items) {
    const spec = PROVIDER_BRAND_LOGOS.find((b) => b.brand === item.brand);
    assert.ok(spec, item.brand + " 必须在 TS 品牌表里");
    assert.equal(spec.manifestFile, item.file, item.brand + " 的 manifest file 必须与 TS 一致");
    assert.equal(spec.multiColor, item.multiColor, item.brand + " 的 multiColor 必须与 TS 一致");
    assert.equal(spec.light, item.file, item.brand + " 的浅色文件应是抓取文件");
    assert.equal(spec.dark, item.file, item.brand + " 的深色文件应是抓取文件（单色靠 mask）");
    assert.ok(fs.existsSync(path.join(ROOT, "public", item.file)), item.file + " 必须真实存在");
  }
  for (const [brand, aliases] of Object.entries(MANIFEST.aliases)) {
    for (const alias of aliases) assert.equal(resolveProviderLogoKey(alias), brand, alias + " → " + brand);
  }
  for (const entry of MANIFEST.missing) {
    assert.equal(MANIFEST.items.some((i) => i.brand === entry.brand), false, entry.brand + " 不在抓取清单里");
    const spec = PROVIDER_BRAND_LOGOS.find((b) => b.brand === entry.brand) || null;
    if (entry.brand === "runninghub") {
      // 抓取源 404，但本仓有黑白两版 PNG，走本仓资源而不是编造。
      assert.ok(spec && spec.manifestFile === null, "runninghub 必须是本仓自有资源");
      assert.ok(resolveProviderLogoKey(entry.brand), "runninghub 应能命中本仓 PNG");
    } else {
      assert.equal(spec, null, entry.brand + " 不得编造资源");
      assert.equal(resolveProviderLogoKey(entry.brand), null, entry.brand);
    }
  }
});

/* ══ 6 拉取模型 · 四类分类（纯逻辑） ══ */

const providerAdapter = require(path.join(ROOT, "electron", "provider-adapter.cjs"));
const manifestDomain = require(path.join(ROOT, "electron", "model-manifest-domain.cjs"));

/** 覆盖四类、embedding、音频名、多能力名、空/空白 id 的语料。 */
const CLASSIFY_CORPUS = [
  "deepseek-chat", "gpt-4o", "gpt-4.1", "gemini-2.5-flash", "qwen-vl-max", "claude-3-5-sonnet",
  "glm-4v", "o3-mini", "dall-e-3", "gpt-image-1", "flux-pro-1.1", "seedream-4.0", "stable-diffusion-3",
  "sdxl-turbo", "midjourney-v6", "imagen-3", "cogview-4", "wanx-v1", "kolors", "seedance-1-0-pro",
  "kling-v1", "veo-3", "sora", "hailuo-02", "wan2.1", "cogvideo-x", "vidu-q1",
  "text-embedding-3-large", "bge-m3", "rerank-v1", "whisper-1", "tts-1-hd", "gpt-4o-audio-preview",
  "omni-moderation-latest", "some-unknown-model", "", "   ",
];

test("分类映射：文本=chat（含 tool-calling/vision-input）、图像=image-generation、视频=video-generation", () => {
  const grouping = groupRemoteModels([
    { id: "deepseek-chat", suggestedCapabilities: ["chat", "tool-calling"] },
    { id: "gpt-4o", suggestedCapabilities: ["chat", "vision-input"] },
    { id: "dall-e-3", suggestedCapabilities: ["image-generation"] },
    { id: "seedream-4", suggestedCapabilities: ["image-generation"] },
    { id: "seedance-1", suggestedCapabilities: ["video-generation"] },
  ]);
  assert.deepEqual(grouping.groups.map((g) => g.id), REMOTE_GROUP_ORDER);
  assert.deepEqual(grouping.groups.map((g) => g.label), ["文本模型", "图像模型", "视频模型", "音频模型", "未识别"]);
  assert.deepEqual(grouping.counts, { text: 2, image: 2, video: 1, audio: 0, unknown: 0 });
  assert.equal(grouping.total, 5);
  const gpt4o = grouping.groups.find((g) => g.id === "text").items.find((i) => i.id === "gpt-4o");
  assert.deepEqual(gpt4o.capabilities, ["chat", "vision-input"], "文本组要逐项标注 vision-input");
  assert.ok(gpt4o.reasons.join("").includes("vision-input"));
  // 多能力优先级：图像 > 视频 > 文本
  const multi = classifyRemoteModel({ id: "x", suggestedCapabilities: ["chat", "image-generation"] });
  assert.equal(multi.group, "image");
  // 明确不是四类的模型域能力（embedding）进未识别，不硬塞
  const emb = classifyRemoteModel({ id: "text-embedding-3-large", suggestedCapabilities: ["embedding"] });
  assert.equal(emb.group, "unknown");
  assert.deepEqual(emb.capabilities, ["embedding"]);
  assert.ok(emb.reasons.join("").includes("embedding"));
  // 筛选只按 id
  const filtered = groupRemoteModels([{ id: "deepseek-chat" }, { id: "dall-e-3" }], { query: "deep" });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.counts.text, 1);
});

test("音频口径：模型域没有音频能力枚举 → 音频组恒空 + 明确说明；只有协议域声明 audio.* 才归入", () => {
  assert.ok(REMOTE_GROUP_META.audio.note.includes("模型域当前没有音频能力枚举"));
  assert.ok(REMOTE_GROUP_META.audio.note.includes("audio.*"));
  assert.ok(REMOTE_CLASSIFY_NOTE.includes("suggestedCapabilities"));

  const byName = groupRemoteModels([{ id: "whisper-1", suggestedCapabilities: [] }]);
  assert.equal(byName.counts.audio, 0, "不许凭模型名把未知塞进音频组");
  assert.equal(byName.counts.unknown, 1);
  const whisper = byName.groups.find((g) => g.id === "unknown").items[0];
  assert.ok(whisper.reasons.join("").includes("音频"));
  assert.ok(whisper.reasons.join("").includes("不硬塞"));

  const byProtocol = groupRemoteModels([{ id: "some-audio-model", suggestedCapabilities: [], protocolIntents: ["audio.tts"] }]);
  assert.equal(byProtocol.counts.audio, 1, "协议域确有 audio.tts 声明才归入音频组");
  assert.equal(byProtocol.groups.find((g) => g.id === "audio").items[0].id, "some-audio-model");

  const noProtocol = groupRemoteModels([{ id: "tts-1", protocolIntents: [] }]);
  assert.equal(noProtocol.counts.audio, 0);
});

test("未识别兜底：suggestedCapabilities 缺省才回落到本地镜像；空 id / 非对象不计数", () => {
  const fromMirror = classifyRemoteModel({ id: "gpt-4o" });
  assert.equal(fromMirror.group, "text");
  assert.deepEqual(fromMirror.capabilities, ["chat", "vision-input"]);
  const emptyMirror = classifyRemoteModel({ id: "tts-1" });
  assert.equal(emptyMirror.group, "unknown");
  assert.deepEqual(emptyMirror.capabilities, []);
  const grouping = groupRemoteModels([{ id: "" }, null, {}, { id: "x" }, "raw-string"]);
  assert.equal(grouping.total, 1, "只有有 id 的对象才计数");
  assert.equal(grouping.groups.find((g) => g.id === "text").items[0].id, "x");
});

test("防漂移：本地镜像逐条等于 electron 的 guessCapabilities / inferModelType", () => {
  assert.equal(typeof providerAdapter.guessCapabilities, "function");
  assert.equal(typeof manifestDomain.inferModelType, "function");
  for (const id of CLASSIFY_CORPUS) {
    assert.deepEqual(guessCapabilitiesFromId(id), providerAdapter.guessCapabilities(id), "guessCapabilities 漂移 @" + JSON.stringify(id));
    assert.deepEqual(inferModelCoarseType(id), manifestDomain.inferModelType(id), "inferModelType 漂移 @" + JSON.stringify(id));
  }
  // 能力枚举必须与模型域一致（多一个少一个都算漂移）
  const domain = require(path.join(ROOT, "electron", "model-domain.cjs"));
  assert.deepEqual([...MODEL_CAPABILITIES], [...domain.CAPABILITIES]);
  assert.equal(MODEL_CAPABILITIES.includes("audio-generation"), false, "模型域没有音频能力枚举");
  assert.equal(normalizeModelCapabilities(["chat", "chat", "nope", "", null]).join(","), "chat");
});

test("四类元数据齐全：label/note/emptyText 都有，能力短标签覆盖六枚举", () => {
  for (const id of REMOTE_GROUP_ORDER) {
    const meta = REMOTE_GROUP_META[id];
    assert.ok(meta.label.length > 0 && meta.note.length > 0 && meta.emptyText.length > 0, id + " 必须有完整说明");
  }
  for (const cap of MODEL_CAPABILITIES) {
    assert.ok(CAPABILITY_SHORT[cap], cap + " 必须有短标签");
    assert.ok(CAPABILITY_LABEL[cap], cap + " 必须有全称");
  }
});

/* ══ 7 编辑服务商表单 · 字段校验与明文开关必选 ══ */

const BLANK_DRAFT = { displayName: "", baseUrl: "", endpointScope: "LOCALHOST", scope: "PERSONAL", status: "enabled", allowInsecureHttp: false, credentialSecret: "" };

test("编辑表单字段校验：名称/地址必填，非法 URL 拒绝，合法 https 通过", () => {
  const blank = validateProviderDraft({ ...BLANK_DRAFT });
  assert.equal(blank.ok, false);
  assert.equal(blank.code, "INVALID_INPUT");
  assert.ok(blank.fieldErrors.displayName && blank.fieldErrors.baseUrl);

  const badUrl = validateProviderDraft({ ...BLANK_DRAFT, displayName: "x", baseUrl: "not a url" });
  assert.equal(badUrl.code, "INVALID_INPUT");
  assert.ok(badUrl.fieldErrors.baseUrl);
  assert.equal(badUrl.fieldErrors.displayName, undefined);

  const good = validateProviderDraft({ ...BLANK_DRAFT, displayName: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" });
  assert.equal(good.ok, true);
  assert.equal(good.code, null);
  assert.deepEqual(good.fieldErrors, {});
  assert.equal(good.origin, "https://api.deepseek.com");
  assert.equal(originOf("https://api.deepseek.com/v1"), "https://api.deepseek.com");
  assert.equal(originOf("nope"), null);
});

test("编辑 payload 每次显式带 allowInsecureHttp 布尔；scope 显式携带", () => {
  const payload = buildProviderUpdatePayload({
    providerId: "prv_1", displayName: "  A  ", baseUrl: "https://x.example.com/v1",
    endpointScope: "REMOTE_HTTPS", scope: "ORGANIZATION", status: "disabled", allowInsecureHttp: false,
  });
  assert.ok(Object.prototype.hasOwnProperty.call(payload, "allowInsecureHttp"), "必须显式携带，后端才可能清零");
  assert.equal(payload.allowInsecureHttp, false);
  assert.equal(payload.providerId, "prv_1");
  assert.equal(payload.displayName, "A");
  assert.equal(payload.status, "disabled");
  assert.equal(payload.endpointScope, "REMOTE_HTTPS");
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "scope"), true, "scope 必须显式携带：后端只在值与旧值不同时才要求超级管理员");
  assert.equal(payload.scope, "ORGANIZATION");

  const on = buildProviderUpdatePayload({ ...BLANK_DRAFT, providerId: "p", displayName: "a", baseUrl: "http://8.8.8.8/v1", endpointScope: "REMOTE_HTTP_EXPLICIT", allowInsecureHttp: true });
  assert.equal(on.allowInsecureHttp, true);

  // adapterType：create 恒发（预设选了协议才生效），update 显式给了才改、缺省沿用原值。
  assert.equal(buildProviderCreatePayload({ ...BLANK_DRAFT, displayName: "x", baseUrl: "https://api.anthropic.com", adapterType: "anthropic" }).adapterType, "anthropic");
  assert.equal(buildProviderCreatePayload({ ...BLANK_DRAFT, displayName: "x", baseUrl: "https://api.deepseek.com" }).adapterType, "openai-compatible");
  assert.equal(buildProviderUpdatePayload({ ...BLANK_DRAFT, providerId: "p", displayName: "x", baseUrl: "https://api.anthropic.com", adapterType: "anthropic" }).adapterType, "anthropic");
  assert.equal(Object.prototype.hasOwnProperty.call(buildProviderUpdatePayload({ providerId: "p", displayName: "x", baseUrl: "https://api.anthropic.com", scope: "PERSONAL", allowInsecureHttp: false }), "adapterType"), false);
});

test("范围：标签/校验/禁用条件/是否算变更，编辑态可改且不静默", () => {
  assert.deepEqual(PROVIDER_SCOPE_OPTIONS.map((o) => o.id), ["PERSONAL", "ORGANIZATION"]);
  assert.equal(providerScopeLabel("PERSONAL"), "个人");
  assert.equal(providerScopeLabel("ORGANIZATION"), "组织");
  assert.equal(providerScopeLabel("WHATEVER"), "WHATEVER");

  assert.equal(isProviderScope("PERSONAL"), true);
  assert.equal(isProviderScope("ORGANIZATION"), true);
  assert.equal(isProviderScope("TEAM"), false);
  assert.equal(isProviderScope(""), false);
  assert.equal(isProviderScope(null), false);

  // 非法范围在提交前就被拦下（结构化 INVALID_INPUT），不把垃圾值发给后端
  const bad = validateProviderDraft({ ...BLANK_DRAFT, displayName: "x", baseUrl: "https://api.example.com/v1", scope: "TEAM" });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "INVALID_INPUT");
  assert.ok(bad.fieldErrors.scope);
  assert.equal(validateProviderDraft({ ...BLANK_DRAFT, displayName: "x", baseUrl: "https://api.example.com/v1", scope: "ORGANIZATION" }).ok, true);

  // 同值不算变更（非管理员改别的字段仍可行）；不同值才算变更
  assert.equal(isScopeChange("PERSONAL", "PERSONAL"), false);
  assert.equal(isScopeChange("PERSONAL", "ORGANIZATION"), true);
  assert.equal(isScopeChange("ORGANIZATION", "PERSONAL"), true);
  assert.equal(isScopeChange(null, "ORGANIZATION"), false);

  // 编辑态范围可选择（不是只读），只在保存中禁用；说明保留「组织需要管理员」
  assert.equal(scopeSelectDisabled({ busy: false }), false, "编辑态范围必须可改");
  assert.equal(scopeSelectDisabled({ busy: true }), true, "保存中禁用");
  assert.equal(scopeSelectDisabled({}), false);
  assert.match(providerScopeHint("edit"), /组织需要管理员/);
  assert.match(providerScopeHint("edit"), /模型/);
  assert.equal(providerScopeHint("create"), PROVIDER_SCOPE_HINT_CREATE);
  assert.equal(providerScopeHint("edit"), PROVIDER_SCOPE_HINT_EDIT);

  // 同步代码事实：编辑表单的范围选择不再对 mode==='edit' 只读，且带范围错误位
  const form = stripComments(read("src-vue/settings/ProviderForm.vue"));
  assert.equal(/:disabled="mode === 'edit'"/.test(form), false, "编辑态不得再把范围锁成只读");
  assert.ok(form.includes("data-d4-01-provider-scope-error"), "非法范围要有结构化错误位");
  assert.ok(form.includes("data-d4-01-provider-scope-hint"), "范围要保留说明");
});

test("明文开关必选逻辑：只有公网 http 出现必选勾选，取消勾选必须显式落 0", () => {
  assert.equal(isPlainRemoteHttp("http://43.130.6.197:8080"), true);
  assert.equal(isPlainRemoteHttp("http://8.8.8.8"), true);
  assert.equal(isPlainRemoteHttp("http://localhost:8080"), false, "loopback 不需要这个开关");
  assert.equal(isPlainRemoteHttp("http://127.0.0.1:9"), false);
  assert.equal(isPlainRemoteHttp("http://192.168.1.5:1234"), false, "私网走 allowLan 口径，不是这个开关");
  assert.equal(isPlainRemoteHttp("https://api.example.com/v1"), false);
  assert.equal(isPlainRemoteHttp("not a url"), false);
  assert.equal(needsInsecureOptIn("http://8.8.8.8"), true);
  assert.ok(PROVIDER_INSECURE_WARNING.includes("明文 HTTP") && PROVIDER_INSECURE_WARNING.includes("中间人") && PROVIDER_INSECURE_WARNING.includes("密钥"));

  const missing = validateProviderDraft({ ...BLANK_DRAFT, displayName: "x", baseUrl: "http://8.8.8.8/v1", allowInsecureHttp: false });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "ENDPOINT_BLOCKED", "未勾选给结构化 ENDPOINT_BLOCKED");
  assert.ok(missing.fieldErrors.insecureHttp);
  assert.equal(validateProviderDraft({ ...BLANK_DRAFT, displayName: "x", baseUrl: "http://8.8.8.8/v1", allowInsecureHttp: true }).ok, true);

  // 从明文 http 换成 https 时必须显式 false —— 省略会让后端保留旧值（不会真正清零）
  const cleared = buildProviderUpdatePayload({ ...BLANK_DRAFT, providerId: "p", displayName: "x", baseUrl: "https://safe.example.com/v1", endpointScope: "REMOTE_HTTPS", allowInsecureHttp: false });
  assert.equal(cleared.allowInsecureHttp, false);
  assert.ok(Object.prototype.hasOwnProperty.call(cleared, "allowInsecureHttp"));
  // create 只在公网明文且勾选时才为 true
  assert.equal(buildProviderCreatePayload({ ...BLANK_DRAFT, displayName: "x", baseUrl: "http://8.8.8.8/v1", allowInsecureHttp: true }).allowInsecureHttp, true);
  assert.equal(buildProviderCreatePayload({ ...BLANK_DRAFT, displayName: "x", baseUrl: "http://8.8.8.8/v1", allowInsecureHttp: false }).allowInsecureHttp, false);
  assert.equal(buildProviderCreatePayload({ ...BLANK_DRAFT, displayName: "x", baseUrl: "https://safe.example.com/v1", allowInsecureHttp: true }).allowInsecureHttp, false, "非公网明文恒为 false");

  // 跨 origin 改地址：不阻止提交，但要带出「需要新密钥」的下一步
  const moved = validateProviderDraft(
    { ...BLANK_DRAFT, displayName: "x", baseUrl: "https://new.example.com/v1", credentialSecret: "" },
    { initialBaseUrl: "https://old.example.com/v1", credentialConfigured: true },
  );
  assert.equal(moved.ok, true);
  assert.equal(moved.originChanged, true);
  assert.equal(moved.requiresNewCredential, true);
  const movedWithSecret = validateProviderDraft(
    { ...BLANK_DRAFT, displayName: "x", baseUrl: "https://new.example.com/v1", credentialSecret: "sk-new" },
    { initialBaseUrl: "https://old.example.com/v1", credentialConfigured: true },
  );
  assert.equal(movedWithSecret.requiresNewCredential, false);
});

test("界面接线：添加与编辑复用同一个 ProviderForm；四类面板只在 model 桥发命令", () => {
  const settings = stripComments(read("src-vue/settings/ModelSettings.vue"));
  const form = stripComments(read("src-vue/settings/ProviderForm.vue"));
  const panel = stripComments(read("src-vue/settings/RemoteModelsPanel.vue"));
  assert.ok(settings.includes('import ProviderForm from "./ProviderForm.vue"'), "必须复用共享表单组件");
  assert.ok(settings.includes('import RemoteModelsPanel from "./RemoteModelsPanel.vue"'));
  assert.ok(settings.includes("data-d4-01-provider-status"), "详情要有启用-停用");
  assert.ok(settings.includes("data-d4-01-provider-edit"), "详情要有编辑按钮");
  // task-56：添加/编辑改为同一个 DsDialog 内的共享 ProviderForm；不再有内联 edit-form 容器。
  assert.ok(settings.includes("data-d4-01-provider-add") && settings.includes("openProviderCreate"), "列表页要有添加入口");
  assert.ok(settings.includes("openProviderEdit(current.providerId)"), "详情编辑按钮要打开编辑弹窗");
  assert.ok(settings.includes('<DsDialog class="mp2-form-dialog" :open="providerDialogOpen"'), "添加/编辑必须共用同一个 DsDialog");
  assert.ok(settings.includes(':mode="providerDialogMode"'), "同一个 ProviderForm 要按弹窗模式切 create/edit");
  assert.ok(settings.includes(":initial=\"providerDialogMode === 'edit' && current ?"), "编辑模式要把当前服务商预填给表单");
  for (const command of ["provider/create", "provider/update", "provider/setStatus", "credential/replace", "model/create"]) {
    assert.ok(settings.includes(command), "ModelSettings 必须真正调用 " + command);
  }
  assert.ok(settings.includes("provider/update") && settings.includes("credential/replace"), "编辑先 update 再 replace");
  for (const [rel, code] of [["src-vue/settings/ProviderForm.vue", form], ["src-vue/settings/RemoteModelsPanel.vue", panel]]) {
    assert.equal(/\bfetch\s*\(/.test(code), false, rel + " 不得调用 fetch");
    assert.equal(/localStorage|sessionStorage/.test(code), false, rel + " 不得写存储");
  }
  assert.ok(form.includes("data-d4-01-provider-insecure-http") && form.includes("data-d4-01-provider-insecure-warning"), "编辑/添加表单都带明文开关与警示");
  // 预设区（8 条服务商预设）与双密钥：选择器与协议展示都在共享表单里，命令仍只由 ModelSettings 发。
  for (const sel of ["data-d4-01-presets", "data-d4-01-preset=", "data-d4-01-preset-selected", "data-d4-01-preset-adapter", "data-d4-01-provider-adapter", "data-d4-01-provider-secret-access", "data-d4-01-provider-secret-key"]) {
    assert.ok(form.includes(sel), "预设区缺少选择器 " + sel);
  }
  assert.ok(form.includes("PROVIDER_PRESETS") && form.includes("applyPreset"), "预设来自 providerPresets.ts 的纯表");
  assert.ok(settings.includes("protocol/list") && settings.includes("knownProtocols"), "协议可用性来自运行期 protocol/list");
  assert.ok(settings.includes("adapterType: current.adapterType"), "编辑态当前协议传给表单，不被预设误改");
  assert.ok(panel.includes("data-d4-01-remote-group") && panel.includes("data-d4-01-remote-add-item"), "四类分组与单条加入按钮");
  assert.ok(panel.includes("groupRemoteModels"), "分类只来自纯函数模块");
});

test("拉取模型：默认不加入、勾选才加、已加入可取消勾选＝移除（接线）", () => {
  const settings = stripComments(read("src-vue/settings/ModelSettings.vue"));
  const panel = stripComments(read("src-vue/settings/RemoteModelsPanel.vue"));
  // 已加入的行不再是 disabled 勾选框：取消勾选＝本次移除
  assert.equal(/:disabled="m\.registered"/.test(panel), false, "已加入的行必须能取消勾选");
  assert.ok(panel.includes("curateRowChecked"), "行内勾选状态来自纯逻辑（已加入默认勾上、未加入默认不勾）");
  assert.ok(panel.includes("buildCuratePlan"), "差异计算只来自纯逻辑模块");
  for (const attr of ["data-d4-01-remote-remove-item", "data-d4-01-remote-register", "data-d4-01-remote-plan"]) {
    assert.ok(panel.includes(attr), "缺少 " + attr);
  }
  assert.ok(panel.includes('t("移除")') && panel.includes('t("加入")'), "已加入行给「移除」，未加入行给「加入」");
  assert.ok(panel.includes("将添加 {a} 个 / 将移除 {r} 个"), "底部按差异给出动作");
  assert.ok(panel.includes("拉取到的模型默认都不加入"), "底部如实说明默认不加入");
  // 事件：勾选/取消勾选/单个加入/单个移除/保存差异
  for (const ev of ['"toggle-drop"', '"toggle-pick"', '"add-one"', '"remove-one"', "save"]) {
    assert.ok(panel.includes(ev), "RemoteModelsPanel 缺少事件 " + ev);
  }
  // ModelSettings 接线：model/delete 真的被调用，部分失败如实报数
  assert.ok(settings.includes("model/delete"), "ModelSettings 必须真正调用 model/delete");
  assert.ok(settings.includes(':dropped="dropped[remoteOpenFor] || {}"'), "取消勾选的状态由 ModelSettings 持有并下传");
  for (const ev of ["@toggle-drop=", "@remove-one=", "@save="]) assert.ok(settings.includes(ev), "ModelSettings 缺少接线 " + ev);
  assert.equal(settings.includes("@register="), false, "旧的 register 事件已被勾选差异保存取代");
  assert.ok(settings.includes("已添加 {a} 个 / 已移除 {r} 个（失败 {f}）"), "部分失败必须如实报数");
  assert.ok(settings.includes('cmd("model/delete", { configId: target.configId })'), "按 providerId + remoteModelId 找到 configId 再删");
  assert.ok(settings.includes("registerEntries") === false, "旧的批量注册函数已由 applyCurate 取代");
  // 320 行时逐个点勾选框会丢点击：每个分类页给「全选本类 / 清空本类」，顶部给「清空已选」，一次整体写状态
  for (const sel of ["data-d4-01-remote-select-section", "data-d4-01-remote-clear-section", "data-d4-01-remote-clear-all"]) {
    assert.ok(panel.includes(sel), "缺少批量操作入口 " + sel);
  }
  assert.ok(panel.includes('t("全选本类")') && panel.includes('t("清空本类")') && panel.includes('t("清空已选")'), "批量按钮文案");
  assert.ok(panel.includes("buildBulkPick") && panel.includes('emit("set-picks"'), "批量勾选走纯逻辑并整体回传");
  assert.ok(settings.includes(':picked="picked[remoteOpenFor] || {}"') && settings.includes("@set-picks="), "ModelSettings 接批量状态");
});

