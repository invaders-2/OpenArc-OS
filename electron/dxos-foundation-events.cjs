/**
 * P1 · DX OS 地基：统一事件通道规范。
 *
 * 为什么先定这一层：后续十几个域都要把进度 / 日志 / 审批请求推给渲染层。
 * 如果各域自己拼 envelope，就会出现"有的带序号有的不带、有的带时间有的不带"，
 * 前端无法按序重放。这里固定三类事件 + 单调序号 + 时间戳，并提供 sendTo 帮助函数。
 */
"use strict";

const { createDxosError, DXOS_ERR_INVALID_INPUT } = require("./dxos-foundation-errors.cjs");

const DXOS_EVENT_KINDS = Object.freeze(["progress", "log", "approval"]);
const DXOS_LOG_LEVELS = Object.freeze(["debug", "info", "warn", "error"]);
const DOMAIN_RE = /^[a-z][a-z0-9-]{0,31}$/;

function eventChannelName(domain) {
  if (typeof domain !== "string" || !DOMAIN_RE.test(domain)) {
    throw createDxosError(DXOS_ERR_INVALID_INPUT, "事件域必须是 [a-z][a-z0-9-]* 且不超过 32 字符");
  }
  return domain + ":event";
}

function isDxosEventKind(kind) {
  return DXOS_EVENT_KINDS.includes(kind);
}

function isDxosLogLevel(level) {
  return DXOS_LOG_LEVELS.includes(level);
}

/**
 * 唯一的下行发送口。webContents 已销毁 / 不是 webContents 时返回 false，
 * 绝不抛出——事件推送失败不应改变业务路径的结果。
 */
function sendTo(webContents, channel, event) {
  if (!webContents || typeof webContents.send !== "function") return false;
  if (typeof webContents.isDestroyed === "function" && webContents.isDestroyed()) return false;
  try {
    webContents.send(channel, event);
    return true;
  } catch {
    return false;
  }
}

function normalizePayload(payload) {
  if (payload == null) return Object.freeze({});
  if (typeof payload !== "object") return Object.freeze({ value: payload });
  return Object.freeze({ ...payload });
}

/**
 * 一个域一个 channel 实例：序号在同一 channel 内单调递增，跨域互不影响。
 * 因此前端可以只按 (channel, sequence) 判断是否丢事件，不必猜时间。
 */
function createEventChannel(options = {}) {
  const domain = options.domain;
  const channel = eventChannelName(domain);
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  let sequence = 0;

  function build(kind, payload) {
    if (!isDxosEventKind(kind)) throw createDxosError(DXOS_ERR_INVALID_INPUT, "未知事件类型：" + String(kind));
    sequence += 1;
    return Object.freeze({ channel, domain, kind, sequence, at: clock(), payload: normalizePayload(payload) });
  }

  return {
    domain,
    channel,
    get sequence() {
      return sequence;
    },
    progress(payload) {
      return build("progress", payload);
    },
    log(level, message, data) {
      const normalized = isDxosLogLevel(level) ? level : "info";
      return build("log", { level: normalized, message: message == null ? "" : String(message), data: data === undefined ? null : data });
    },
    approval(payload) {
      return build("approval", payload);
    },
    emit(kind, payload) {
      return build(kind, payload);
    },
    /** 发到指定 webContents；返回 false 表示对端已销毁，事件丢弃。 */
    sendTo(webContents, event) {
      return sendTo(webContents, channel, event || build("progress", {}));
    },
  };
}

module.exports = {
  DXOS_EVENT_KINDS,
  DXOS_LOG_LEVELS,
  eventChannelName,
  isDxosEventKind,
  isDxosLogLevel,
  sendTo,
  createEventChannel,
};
