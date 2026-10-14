/**
 * B7e2 · legacy 执行器注入端口（B2 未移植的 runninghub / modelscope / agnes 分支的执行入口）。
 *
 * 背景（只读源：electron/protocol-engine/legacy-executor-images.cjs / legacy-executor-media.cjs）：
 *   B2 把 protocols.ts 的图片 / 视频 / 图像编辑里 runninghub / modelscope / agnes 三条协议分支
 *   留成结构化占位，一律返回 { ok:false, error:"LEGACY_DEPENDENCY_UNAVAILABLE", detail:"<属哪个批次>" }。
 *   本文件提供"端口"这一接缝：端口注册到本模块后，legacy 执行器分支改为"有端口就调用、没有端口仍结构化不可用"。
 *
 * 端口形状（按 legacy-executor-images/media 里真实调用点的实参顺序确定；见两文件的对应分支）：
 *   generateAgnesImages(provider, model, params, timeoutMs, transport, clock)
 *   generateModelScopeImages(provider, model, params, timeoutMs, transport, clock)
 *   generateRunningHubImages(provider, model, params, timeoutMs, transport, clock)
 *   generateAgnesVideos(provider, model, params, timeoutMs, transport, clock)
 *   generateRunningHubVideos(provider, model, params, timeoutMs, transport, clock)
 *   editAgnesImages(provider, model, params, inputs, timeoutMs, transport, clock)
 *   editModelScopeImages(provider, model, params, inputs, timeoutMs, transport, clock)
 *   editRunningHubImages(provider, model, params, inputs, timeoutMs, transport, clock)
 *   callRunningHubChat(provider, model, input, params, timeoutMs, transport)                  成功 { text, latencyMs, raw }
 *   describeRunningHubImage(provider, model, dataUrl, prompt, timeoutMs, transport)           成功返回文本 string
 * 另有一组 CLI 协议族端口（B7e2 后续，实现见 electron/legacy-cli-ports.cjs），按「一个 CLI 一个端口」
 * 收敛，动作由第一个实参 operation 区分（image.generate / image.edit / video.generate / chat /
 * describeImage / models）：
 *   cliJimeng(operation, payload)  即梦（dreamina）
 *   cliCodex(operation, payload)   OpenAI Codex
 *   cliGemini(operation, payload)  Gemini / Antigravity
 *   · transport 是 electron/protocol-engine/transport.cjs 的形状 { fetch }；clock 是 { now, sleep }；
 *   · 成功返回值沿用源协议形状：生成图片 / 编辑 → { images, raw }，生成视频 → { videos, raw }；
 *     失败返回结构化 { ok:false, error, detail }。
 *
 * 与源 runninghub.ts / modelscope.ts 的差异（硬要求，不是行为漂移）：
 *   · 网络一律经注入 transport.fetch 或插件注入的 fetch；未注入即结构化 INTEGRATION_UNAVAILABLE；
 *   · 凭据走 credential-store，未配置即结构化 INTEGRATION_UNAVAILABLE，磁盘不落明文。
 *
 * OUT（任务书硬约束，绝不引入）：api.dx-os.com、云发布 / 更新、云端实时房间。
 */

"use strict";

/** 允许注册的端口名（与执行器里 require 的字符串一一对应，白名单式，未知名拒绝注册）。 */
const LEGACY_EXECUTOR_PORT_NAMES = Object.freeze([
  "generateAgnesImages",
  "generateModelScopeImages",
  "generateRunningHubImages",
  "generateAgnesVideos",
  "generateRunningHubVideos",
  "editAgnesImages",
  "editModelScopeImages",
  "editRunningHubImages",
  // B7e3 后续：RunningHub 对话 / 图片理解（与 integration/runninghub/chat|describe-image 同名；
  // 插件启用时由 electron/plugin-service.cjs 注入，未注入时执行器仍结构化拒绝）。
  "callRunningHubChat",
  "describeRunningHubImage",
  // B7e2 后续：CLI 协议族端口（一个 CLI 一个，动作由 operation 形参区分；实现见 legacy-cli-ports.cjs）。
  "cliJimeng",
  "cliCodex",
  "cliGemini",
]);

const LEGACY_PORT_UNKNOWN = "LEGACY_PORT_UNKNOWN";
const LEGACY_PORT_INVALID = "LEGACY_PORT_INVALID";

const PORT_NAME_SET = new Set(LEGACY_EXECUTOR_PORT_NAMES);

/** 进程内端口表（模块级单例；测试与装配显式清理，避免跨用例串扰）。 */
const ports = new Map();

function normalizePortName(name) {
  const key = typeof name === "string" ? name.trim() : "";
  return PORT_NAME_SET.has(key) ? key : "";
}

/** 批量注册端口；未知名 / 非函数一律拒绝并回报，绝不静默忽略。 */
function setLegacyExecutorPorts(input) {
  const applied = [];
  const rejected = [];
  if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const [name, fn] of Object.entries(input)) {
      const key = normalizePortName(name);
      if (!key || typeof fn !== "function") {
        rejected.push(name);
        continue;
      }
      ports.set(key, fn);
      applied.push(key);
    }
  }
  return { applied: applied.sort(), rejected: rejected.sort() };
}

/** 单个端口注册。 */
function installLegacyExecutorPort(name, fn) {
  const key = normalizePortName(name);
  if (!key) return { ok: false, error: LEGACY_PORT_UNKNOWN, detail: "未登记的 legacy 执行器端口：" + String(name) };
  if (typeof fn !== "function") return { ok: false, error: LEGACY_PORT_INVALID, detail: "端口实现必须是函数：" + key };
  ports.set(key, fn);
  return { ok: true, value: { name: key } };
}

/** 取端口；未注册返回 null（执行器据此继续走"结构化不可用"）。 */
function getLegacyExecutorPort(name) {
  const key = normalizePortName(name);
  return key ? ports.get(key) || null : null;
}

function hasLegacyExecutorPort(name) {
  return typeof getLegacyExecutorPort(name) === "function";
}

/** 已注册端口名（排序，便于断言）。 */
function listLegacyExecutorPorts() {
  return [...ports.keys()].sort();
}

/** 端口快照（浅拷贝，便于诊断）。 */
function snapshotLegacyExecutorPorts() {
  return Object.fromEntries(ports);
}

/** 清理：不传参清空全部；传数组只清指定名。 */
function clearLegacyExecutorPorts(names) {
  if (names === undefined || names === null) {
    const cleared = [...ports.keys()].sort();
    ports.clear();
    return { cleared };
  }
  const list = Array.isArray(names) ? names : [names];
  const cleared = [];
  for (const name of list) {
    const key = normalizePortName(name);
    if (key && ports.delete(key)) cleared.push(key);
  }
  return { cleared: cleared.sort() };
}

/**
 * 从集成对象提取端口：端口名与集成方法名同名，直接绑定。
 * 集成方法返回源协议形状（生成 { images, raw } / { videos, raw }，失败 { ok:false, error, detail }），
 * 因此这里保持原样转发，不做形状转换。
 *
 * 注意（B7e3 后续）：RunningHub 的 callRunningHubChat / describeRunningHubImage 端口名虽与插件方法同名，
 * 但插件方法返回 integration 形状（{ ok:true, value }），必须经 electron/plugin-service.cjs 适配成
 * legacy 形状后再注册；不要用本函数直接绑定这两个端口（会把 integration 形状透传给 legacy 执行器）。
 */
function portsFromIntegration(integration) {
  const result = {};
  if (!integration || typeof integration !== "object") return result;
  for (const name of LEGACY_EXECUTOR_PORT_NAMES) {
    if (typeof integration[name] === "function") result[name] = integration[name].bind(integration);
  }
  return result;
}

/** 把集成对象的方法注册成端口。 */
function installIntegrationPorts(integration) {
  return setLegacyExecutorPorts(portsFromIntegration(integration));
}

module.exports = {
  LEGACY_EXECUTOR_PORT_NAMES,
  LEGACY_PORT_UNKNOWN,
  LEGACY_PORT_INVALID,
  setLegacyExecutorPorts,
  installLegacyExecutorPort,
  getLegacyExecutorPort,
  hasLegacyExecutorPort,
  listLegacyExecutorPorts,
  snapshotLegacyExecutorPorts,
  clearLegacyExecutorPorts,
  portsFromIntegration,
  installIntegrationPorts,
};
