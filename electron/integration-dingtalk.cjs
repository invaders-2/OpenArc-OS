/**
 * B7c · 钉钉可选插件（移植 server/dingtalk.ts:1-233 的本地部分）。
 *
 * 与源文件的差异（**唯一的实质差异，安全硬要求**）：
 *   · 源文件把 webhook / secret / clientSecret 用 AES 自管理密钥加密后写进 dingtalk.json
 *     （dingtalk.ts:108-120）；本移植改走 credential-store 的 safeStorage 后端
 *     （credential-store.cjs:11-27），**磁盘上永不出现明文**；
 *   · dingtalk.json 只留引用与展示用掩码信息（id / name / enabled / *Ref / host），
 *     listChannels 的投影不再回传完整 webhook（源 dingtalk.ts:136-145 回传了完整 URL），
 *     改为 webhookMask + webhookHost + webhookSet —— 写入口径不变（可覆盖），读出口径收窄。
 *
 * 保留的源行为：
 *   · load()/persist() 的字段与默认值（dingtalk.ts:36-59、108-120）
 *   · slug / maskSecret（dingtalk.ts:121-133）
 *   · saveChannel 的"secret 留空=保留原值"（dingtalk.ts:147-170）
 *   · deleteChannel / resetDingTalkData / listContacts / recordContact（dingtalk.ts:172-197）
 *   · resolveChannel 默认取第一个启用的机器人（dingtalk.ts:199-203）
 *   · send 的加签与 text/markdown 两种消息体（dingtalk.ts:205-233）
 *   · agentConfig 的三段合并 defaultAgent/legacyAgent/已存配置（dingtalk.ts:61-81）
 *
 * 未配置 / 缺依赖一律结构化 { ok:false, error:"INTEGRATION_UNAVAILABLE", detail }，绝不假发送。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHmac, randomBytes } = require("node:crypto");

const { INTEGRATION_ERR_UNAVAILABLE, INTEGRATION_ERR_INVALID_INPUT } = require("./plugin-registry.cjs");

const FILE_NAME = "dingtalk.json";

const asStr = (value, max = 4096) => (typeof value === "string" ? value.slice(0, max) : value == null ? "" : String(value).slice(0, max));

/** dingtalk.ts:130-133 逐字移植：短串全掩、长串头尾各留 4 位。 */
function maskSecret(value) {
  const text = asStr(value, 4096);
  if (!text) return "";
  return text.length <= 8 ? "•".repeat(text.length) : text.slice(0, 4) + "••••" + text.slice(-4);
}

/** dingtalk.ts:121-129：名字 → 稳定 slug（空则 bot）。 */
function slug(name) {
  return (
    asStr(name, 200).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "bot"
  );
}

function webhookHost(value) {
  try { const url = new URL(asStr(value, 2048)); return url.hostname.slice(0, 200); } catch { return ""; }
}

function createDingtalkIntegration(options = {}) {
  const dataDir = options.dataDir ? String(options.dataDir) : null;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const credentials = options.credentials && typeof options.credentials === "object" ? options.credentials : null;
  const fetchImpl = typeof options.fetch === "function" ? options.fetch : null;
  const personalSender = typeof options.personalSender === "function" ? options.personalSender : null;

  const file = dataDir ? path.join(dataDir, FILE_NAME) : null;
  const ref = {
    webhook: (id) => "dingtalk.webhook." + id,
    secret: (id) => "dingtalk.secret." + id,
    agentSecret: "dingtalk.agent.clientSecret",
  };

  const credentialsAvailable = () => !!credentials && typeof credentials.available === "function" && credentials.available() === true;

  function unavailable(detail) { return { ok: false, error: INTEGRATION_ERR_UNAVAILABLE, detail }; }

  // ── 元数据读写：**只含引用**，未知顶层键原样保留 ──
  let rawState = null;
  function readRaw() {
    if (rawState) return rawState;
    if (!file) { rawState = { channels: [] }; return rawState; }
    try {
      if (!fs.existsSync(file)) { rawState = { channels: [] }; return rawState; }
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { rawState = { channels: [] }; return rawState; }
      if (!Array.isArray(parsed.channels)) parsed.channels = [];
      if (!Array.isArray(parsed.contacts)) parsed.contacts = [];
      rawState = parsed;
    } catch {
      rawState = { channels: [] };
    }
    return rawState;
  }

  function persist() {
    if (!file) return false;
    const state = readRaw();
    const temp = file + "." + process.pid + "." + Date.now() + ".tmp";
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(state, null, 2), "utf8");
      fs.renameSync(temp, file);
      return true;
    } catch {
      return false;
    } finally {
      try { if (fs.existsSync(temp)) fs.rmSync(temp, { force: true }); } catch { /* 忽略 */ }
    }
  }

  function metadataChannels() {
    return readRaw().channels.filter((item) => item && typeof item === "object" && asStr(item.id, 120)).map((item) => ({
      id: asStr(item.id, 120),
      name: asStr(item.name, 160) || "机器人",
      enabled: item.enabled !== false,
      webhookRef: asStr(item.webhookRef, 200),
      secretRef: asStr(item.secretRef, 200),
      webhookHost: asStr(item.webhookHost, 200),
    }));
  }

  function defaultAgent() { return { clientId: "", clientSecret: "", robotCode: "", activeProfiles: "ALL" }; }

  // dingtalk.ts:65-76：从旧 mcp.json 的钉钉条目迁移 env（保留读取，绝不回写明文）。
  function legacyAgent() {
    if (!dataDir) return {};
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dataDir, "mcp.json"), "utf8"));
      if (!Array.isArray(raw)) return {};
      const env = (raw.find((item) => /ding|钉钉/i.test(asStr(item && item.id, 200) + " " + asStr(item && item.name, 200))) || {}).env || {};
      return {
        clientId: asStr(env.DINGTALK_Client_ID || env.DINGTALK_CLIENT_ID, 200),
        clientSecret: "",
        robotCode: asStr(env.ROBOT_CODE, 200),
        activeProfiles: asStr(env.ACTIVE_PROFILES, 40) || "ALL",
      };
    } catch { return {}; }
  }

  function agentConfigInternal() {
    const stored = readRaw().agent && typeof readRaw().agent === "object" ? readRaw().agent : {};
    const clientSecretRef = asStr(stored.clientSecretRef, 200) || ref.agentSecret;
    let clientSecret = "";
    if (credentialsAvailable()) {
      try { clientSecret = asStr(credentials.get(clientSecretRef), 4096); } catch { clientSecret = ""; }
    }
    return {
      ...defaultAgent(),
      ...legacyAgent(),
      clientId: asStr(stored.clientId, 200),
      clientSecret,
      robotCode: asStr(stored.robotCode, 200),
      activeProfiles: asStr(stored.activeProfiles, 40) || "ALL",
      clientSecretRef,
    };
  }

  // ── 对外读投影：一律掩码 ──
  function listChannels() {
    return {
      ok: true,
      value: {
        items: metadataChannels().map((channel) => {
          const webhook = credentialsAvailable() ? asStr(credentials.get(channel.webhookRef), 2048) : "";
          const secret = credentialsAvailable() ? asStr(credentials.get(channel.secretRef), 4096) : "";
          return {
            id: channel.id,
            name: channel.name,
            enabled: channel.enabled,
            webhookSet: !!webhook,
            webhookHost: channel.webhookHost || webhookHost(webhook),
            webhookMask: maskSecret(webhook),
            secretSet: !!secret,
            secretMask: maskSecret(secret),
          };
        }),
      },
    };
  }

  function getAgentConfig() {
    const config = agentConfigInternal();
    return {
      ok: true,
      value: {
        clientId: config.clientId,
        clientSecretSet: !!config.clientSecret,
        clientSecretMask: maskSecret(config.clientSecret),
        robotCode: config.robotCode,
        activeProfiles: config.activeProfiles,
        safeStorageAvailable: credentialsAvailable(),
      },
    };
  }

  // dingtalk.ts:94 getAgentEnv（只回给主进程内部使用，绝不走 IPC）。
  function getAgentEnv() {
    const { clientSecretRef, ...rest } = agentConfigInternal();
    return rest;
  }

  function saveChannel(input = {}) {
    const source = input && typeof input === "object" ? input : {};
    const name = asStr(source.name, 160).trim() || "机器人";
    let id = asStr(source.id, 120).trim();
    if (!id) id = slug(name) + "-" + randomBytes(3).toString("hex").slice(0, 6);
    const webhook = asStr(source.webhook, 2048).trim();
    const secret = source.secret != null ? asStr(source.secret, 4096).trim() : "";
    if (!credentialsAvailable() && (webhook || secret)) {
      return unavailable("safeStorage 不可用，钉钉 Webhook / 加签密钥无法加密保存；请先在支持的系统上启用钥匙串");
    }

    const state = readRaw();
    const index = state.channels.findIndex((item) => asStr(item && item.id, 120) === id);
    const previous = index >= 0 ? state.channels[index] : null;
    const webhookRef = (previous && asStr(previous.webhookRef, 200)) || ref.webhook(id);
    const secretRef = (previous && asStr(previous.secretRef, 200)) || ref.secret(id);

    if (credentialsAvailable() && webhook) credentials.put(webhookRef, webhook);
    if (credentialsAvailable() && secret) credentials.put(secretRef, secret);

    const next = {
      ...(previous || {}),
      id,
      name,
      enabled: source.enabled === false ? false : true,
      webhookRef,
      secretRef,
      webhookHost: webhook ? webhookHost(webhook) : ((previous && previous.webhookHost) || ""),
    };
    if (index >= 0) state.channels[index] = next; else state.channels.push(next);
    const persisted = persist();
    return { ok: true, value: { id, persisted } };
  }

  function deleteChannel(id) {
    const target = asStr(id, 120).trim();
    const state = readRaw();
    const before = state.channels.length;
    const removed = state.channels.filter((item) => asStr(item && item.id, 120) !== target);
    state.channels = removed;
    if (credentialsAvailable()) {
      try { credentials.delete(ref.webhook(target)); } catch { /* 忽略 */ }
      try { credentials.delete(ref.secret(target)); } catch { /* 忽略 */ }
    }
    const persisted = persist();
    return { ok: true, value: { changed: removed.length < before, persisted } };
  }

  function resetDingTalkData() {
    const state = readRaw();
    for (const channel of Array.isArray(state.channels) ? state.channels : []) {
      if (!credentialsAvailable()) break;
      try { credentials.delete(asStr(channel && channel.webhookRef, 200)); } catch { /* 忽略 */ }
      try { credentials.delete(asStr(channel && channel.secretRef, 200)); } catch { /* 忽略 */ }
    }
    state.channels = [];
    state.contacts = [];
    state.agent = { ...defaultAgent(), clientSecretRef: ref.agentSecret };
    if (credentialsAvailable()) { try { credentials.delete(ref.agentSecret); } catch { /* 忽略 */ } }
    return { ok: true, value: { persisted: persist() } };
  }

  function listContacts() {
    const contacts = readRaw().contacts || [];
    return {
      ok: true,
      value: {
        items: contacts
          .filter((contact) => contact && asStr(contact.userId, 200))
          .map((contact) => ({ userId: asStr(contact.userId, 200), name: asStr(contact.name, 200) || asStr(contact.userId, 200), lastSeenAt: Number(contact.lastSeenAt) || 0 }))
          .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
          .slice(0, 200),
      },
    };
  }

  // dingtalk.ts:188-197：联系人本地累计（最多 200 条，按最近触达排序）。
  function recordContact(userId, name) {
    const id = asStr(userId, 200).trim();
    if (!id) return { ok: false, error: INTEGRATION_ERR_INVALID_INPUT, detail: "userId 不能为空" };
    const state = readRaw();
    const contacts = Array.isArray(state.contacts) ? state.contacts : [];
    const existing = contacts.find((contact) => asStr(contact && contact.userId, 200) === id);
    if (existing) { existing.name = asStr(name, 200).trim() || existing.name || id; existing.lastSeenAt = clock(); }
    else contacts.unshift({ userId: id, name: asStr(name, 200).trim() || id, lastSeenAt: clock() });
    state.contacts = contacts.sort((a, b) => (Number(b.lastSeenAt) || 0) - (Number(a.lastSeenAt) || 0)).slice(0, 200);
    persist();
    return { ok: true, value: { recorded: id } };
  }

  function saveAgentConfig(input = {}) {
    const source = input && typeof input === "object" ? input : {};
    const current = agentConfigInternal();
    const clientId = source.clientId != null ? asStr(source.clientId, 200).trim() : current.clientId;
    const robotCode = source.robotCode != null ? asStr(source.robotCode, 200).trim() : current.robotCode;
    const activeProfiles = source.activeProfiles != null ? (asStr(source.activeProfiles, 40).trim() || "ALL") : current.activeProfiles;
    const nextSecret = source.clientSecret ? asStr(source.clientSecret, 4096).trim() : "";
    if (nextSecret && !credentialsAvailable()) return unavailable("safeStorage 不可用，钉钉 clientSecret 无法加密保存");
    if (nextSecret && credentialsAvailable()) credentials.put(ref.agentSecret, nextSecret);
    const state = readRaw();
    state.agent = { clientId, robotCode, activeProfiles, clientSecretRef: ref.agentSecret };
    const persisted = persist();
    return { ok: true, value: { ...getAgentConfig().value, persisted } };
  }

  /** dingtalk.ts:199-203：channelId 不填取第一个"启用且有 webhook"的机器人。 */
  function resolveChannel(channelId) {
    const channels = metadataChannels().map((channel) => ({
      ...channel,
      webhook: credentialsAvailable() ? asStr(credentials.get(channel.webhookRef), 2048) : "",
      secret: credentialsAvailable() ? asStr(credentials.get(channel.secretRef), 4096) : "",
    }));
    if (channelId) return channels.find((channel) => channel.id === asStr(channelId, 120)) || null;
    return channels.find((channel) => channel.enabled !== false && channel.webhook) || null;
  }

  function status() {
    const channels = metadataChannels();
    return {
      ok: true,
      value: {
        configured: channels.some((channel) => !!channel.webhookRef),
        channelCount: channels.length,
        enabledChannelCount: channels.filter((channel) => channel.enabled !== false).length,
        safeStorageAvailable: credentialsAvailable(),
        fetchInjected: typeof fetchImpl === "function",
      },
    };
  }

  /** dingtalk.ts:205-233：加签 + text/markdown 两种消息体。 */
  async function send(input = {}) {
    if (typeof fetchImpl !== "function") return unavailable("未注入 fetch（网络访问在主进程统一开关），无法发送钉钉消息");
    if (!credentialsAvailable()) return unavailable("safeStorage 不可用，读不到钉钉 Webhook 凭据；为不落明文，消息发送停用");
    const channelId = input && typeof input === "object" ? input.channelId : undefined;
    const message = input && typeof input === "object" && input.msg && typeof input.msg === "object" ? input.msg : {};
    const channel = resolveChannel(channelId);
    if (!channel) return unavailable("没有可用的钉钉机器人，请先在「钉钉」里添加并配置 Webhook");
    if (!channel.webhook) return unavailable("该机器人缺少 Webhook（channelId=" + channel.id + "）");

    let url = channel.webhook;
    if (channel.secret) {
      const ts = clock();
      const sign = createHmac("sha256", channel.secret).update(ts + "\n" + channel.secret).digest("base64");
      const sep = url.includes("?") ? "&" : "?";
      url += sep + "timestamp=" + ts + "&sign=" + encodeURIComponent(sign);
    }
    const body = message.markdown
      ? { msgtype: "markdown", markdown: { title: asStr(message.title, 200) || "通知", text: asStr(message.markdown, 20000) } }
      : { msgtype: "text", text: { content: asStr(message.text, 20000) } };

    try {
      const response = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const raw = await response.json().catch(() => ({}));
      if (raw && raw.errcode === 0) return { ok: true, value: { channel: channel.name } };
      return { ok: false, error: "INTEGRATION_SEND_FAILED", detail: "钉钉返回 " + (raw && raw.errcode) + ": " + asStr(raw && raw.errmsg, 300) || "未知" };
    } catch (error) {
      return { ok: false, error: "INTEGRATION_SEND_FAILED", detail: asStr(error && error.message, 300) };
    }
  }

  /**
   * 个人消息：**源 dingtalk.ts 未实现**（该文件只有群机器人 webhook 发送）。
   * 这里不假实现：只有注入 personalSender 时才转发，否则结构化不可用。
   */
  async function sendToUser(input = {}) {
    const userId = asStr(input && input.userId, 200).trim();
    const text = asStr(input && input.text, 20000);
    if (!userId || !text) return { ok: false, error: INTEGRATION_ERR_INVALID_INPUT, detail: "sendToUser 需要 userId 与 text" };
    if (typeof personalSender !== "function") {
      return unavailable("未注入钉钉个人消息发送器（需 clientId/clientSecret/robotCode 的 OpenAPI 客户端）；" + (getAgentConfig().value.clientSecretSet ? "凭据已配置但发送器未装配" : "凭据也未配置"));
    }
    try {
      const result = await personalSender({ userId, text, config: getAgentEnv() });
      if (result && result.ok === false) return { ok: false, error: "INTEGRATION_SEND_FAILED", detail: asStr(result.detail || result.error, 300) };
      return { ok: true, value: { userId, channel: "personal" } };
    } catch (error) {
      return { ok: false, error: "INTEGRATION_SEND_FAILED", detail: asStr(error && error.message, 300) };
    }
  }

  /** 测试与主进程内部用：返回真实 webhook（**绝不走 IPC**）。 */
  function resolveChannelInternal(channelId) { return resolveChannel(channelId); }

  return {
    file,
    maskSecret,
    slug,
    metadataChannels,
    listChannels,
    getAgentConfig,
    getAgentEnv,
    saveAgentConfig,
    saveChannel,
    deleteChannel,
    resetDingTalkData,
    listContacts,
    recordContact,
    resolveChannel: resolveChannelInternal,
    status,
    send,
    sendToUser,
  };
}

module.exports = { createDingtalkIntegration, maskSecret, slug, FILE_NAME };
