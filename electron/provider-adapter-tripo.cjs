"use strict";
/**
 * Tripo3D adapter (official API v3). Key: Bearer sk_...; no live calls without a key.
 * Docs: https://developers.tripo3d.ai
 */
const crypto = require("node:crypto");
const modelDomain = require("./model-domain.cjs");

const BASE_URL = "https://openapi.tripo3d.ai";
const CN_BASE_URL = "https://openapi.tripo3d.com";
const MODEL = "v2.5-20250123";
const TASK_TIMEOUT_MS = 300000;
const POLL_MS = 2000;
const PROVIDER_PRESET = Object.freeze({
  adapterType: "tripo3d",
  displayName: "Tripo3D",
  baseUrl: BASE_URL,
  endpointScope: "REMOTE_HTTPS",
  credentialMode: "single",
  auth: "bearer",
  docs: "https://developers.tripo3d.ai",
  capabilities: ["3d-generation"],
});

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error, detail = null) => ({ ok: false, error: String(error), detail });
function apiKey(secret) { return String(secret || "").replace(/^Bearer\s+/i, "").trim(); }
function authHeaders(secret) { return { Authorization: "Bearer " + apiKey(secret), "Content-Type": "application/json", Accept: "application/json" }; }
function tripoError(status, parsed) {
  const code = parsed && (parsed.code != null ? String(parsed.code) : (parsed.error_code != null ? String(parsed.error_code) : ""));
  const message = parsed && (parsed.message || parsed.error || parsed.detail) ? String(parsed.message || parsed.error || parsed.detail).slice(0, 240) : "tripo-http-" + status;
  if (code === "2010" || /insufficient credit/i.test(message)) return { ok: false, error: "CREDIT_INSUFFICIENT", code: "2010", detail: message };
  if (status === 402 || status === 403) return { ok: false, error: "CREDIT_INSUFFICIENT", code, detail: message };
  if (status === 401) return { ok: false, error: modelDomain.ERROR_CODE.AUTH_FAILED, code, detail: message };
  if (status === 429) return { ok: false, error: modelDomain.ERROR_CODE.RATE_LIMITED, code, detail: message };
  if (status === 404) return { ok: false, error: modelDomain.ERROR_CODE.MODEL_NOT_FOUND, code, detail: message };
  if (status >= 500) return { ok: false, error: modelDomain.ERROR_CODE.PROVIDER_UNAVAILABLE, code, detail: message };
  return { ok: false, error: modelDomain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR, code, detail: message };
}

function normalizeError(status) {
  if (status === 401 || status === 403) return modelDomain.ERROR_CODE.AUTH_FAILED;
  if (status === 429) return modelDomain.ERROR_CODE.RATE_LIMITED;
  if (status === 404) return modelDomain.ERROR_CODE.MODEL_NOT_FOUND;
  if (status >= 500) return modelDomain.ERROR_CODE.PROVIDER_UNAVAILABLE;
  return modelDomain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR;
}

function createTask({ baseUrl = BASE_URL, apiKey: secret, kind = "text", prompt = "", imageUrl = null, fileToken = null, model = MODEL, texture = true, pbr = true, fetchImpl = fetch, signal = null, timeoutMs = 30000 } = {}) {
  return (async () => {
    if (!apiKey(secret)) return fail(modelDomain.ERROR_CODE.CREDENTIAL_MISSING);
    if (kind === "image" && !fileToken && !imageUrl) return fail(modelDomain.ERROR_CODE.INVALID_INPUT, "image-file-token-required");
    if (kind !== "image" && !prompt) return fail(modelDomain.ERROR_CODE.INVALID_INPUT, "prompt-required");
    const path = kind === "image" ? "/v3/generation/image-to-model" : "/v3/generation/text-to-model";
    const body = kind === "image" ? { input: fileToken || imageUrl, model, texture, pbr } : { prompt, model, texture, pbr };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    try {
      const response = await fetchImpl(new URL(path, baseUrl).toString(), { method: "POST", headers: authHeaders(secret), body: JSON.stringify(body), signal: controller.signal, redirect: "error" });
      const parsed = await response.json().catch(() => null);
      if (!response.ok || (parsed && Number(parsed.code) === 2010)) return tripoError(response.status, parsed);
      const data = parsed && parsed.data ? parsed.data : parsed;
      const taskId = String((data && (data.task_id || data.id)) || "");
      if (!taskId) return fail(modelDomain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR, "missing-task-id");
      return ok({ taskId, raw: data });
    } catch (error) {
      return fail(controller.signal.aborted ? modelDomain.ERROR_CODE.MODEL_TIMEOUT : modelDomain.ERROR_CODE.PROVIDER_UNAVAILABLE, String((error && error.message) || error).slice(0, 200));
    } finally { clearTimeout(timer); }
  })();
}

async function getTask({ baseUrl = BASE_URL, apiKey: secret, taskId, fetchImpl = fetch, signal = null, timeoutMs = TASK_TIMEOUT_MS, pollMs = POLL_MS, onPoll = null } = {}) {
  if (!apiKey(secret)) return fail(modelDomain.ERROR_CODE.CREDENTIAL_MISSING);
  if (!taskId) return fail(modelDomain.ERROR_CODE.INVALID_INPUT, "taskId");
  const started = Date.now();
  let polls = 0;
  for (;;) {
    if (signal && signal.aborted) return fail(modelDomain.ERROR_CODE.CANCELLED);
    if (Date.now() - started > timeoutMs) return fail(modelDomain.ERROR_CODE.MODEL_TIMEOUT, "tripo-poll-timeout");
    polls += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), 20000);
    let parsed;
    try {
      const response = await fetchImpl(new URL("/v3/tasks/" + encodeURIComponent(String(taskId)), baseUrl).toString(), { method: "GET", headers: authHeaders(secret), signal: controller.signal, redirect: "error" });
      parsed = await response.json().catch(() => null);
      if (!response.ok) return fail(normalizeError(response.status), parsed && parsed.message ? String(parsed.message).slice(0, 200) : "tripo-http-" + response.status);
    } catch (error) {
      return fail(controller.signal.aborted ? modelDomain.ERROR_CODE.MODEL_TIMEOUT : modelDomain.ERROR_CODE.PROVIDER_UNAVAILABLE, String((error && error.message) || error).slice(0, 200));
    } finally { clearTimeout(timer); }
    const data = parsed && parsed.data ? parsed.data : parsed;
    const status = String((data && data.status) || "").toLowerCase();
    if (typeof onPoll === "function") onPoll({ polls, status });
    if (status === "success" || status === "succeeded" || status === "completed") {
      const modelUrl = String((data && data.output && (data.output.model_url || data.output.modelUrl)) || (data && (data.model_url || data.modelUrl)) || "");
      if (!modelUrl) return fail(modelDomain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR, "missing-model-url");
      return ok({ taskId, status, modelUrl, polls, output: data.output || null });
    }
    if (["failed", "failure", "cancelled", "canceled", "error"].includes(status)) return fail(modelDomain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR, "tripo-task-" + status);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function isAllowedModelUrl(raw) {
  let url;
  try { url = new URL(String(raw || "")); } catch { return false; }
  if (url.username || url.password) return false;
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "tripo3d.ai" || host.endsWith(".tripo3d.ai") || host === "tripo3d.com" || host.endsWith(".tripo3d.com");
}

async function downloadModel({ url, fetchImpl = fetch, signal = null, timeoutMs = 120000, maxBytes = 128 * 1024 * 1024 } = {}) {
  if (!isAllowedModelUrl(url)) return fail("MODEL_HOST_BLOCKED");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: "GET", headers: { Accept: "model/gltf-binary,application/octet-stream", "User-Agent": "OpenArc-Tripo/1.0" }, signal: controller.signal, redirect: "error" });
    if (!response.ok) return fail(normalizeError(response.status));
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length) return fail(modelDomain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR, "empty-model");
    if (data.length > maxBytes) return fail(modelDomain.ERROR_CODE.INVALID_INPUT, "model-too-large");
    return ok({ data, bytes: data.length, mime: response.headers.get("content-type") || "model/gltf-binary" });
  } catch (error) {
    return fail(controller.signal.aborted ? modelDomain.ERROR_CODE.MODEL_TIMEOUT : modelDomain.ERROR_CODE.PROVIDER_UNAVAILABLE, String((error && error.message) || error).slice(0, 200));
  } finally { clearTimeout(timer); }
}

async function uploadFile({ baseUrl = BASE_URL, apiKey: secret, data, mime = "image/png", filename = "reference.png", fetchImpl = fetch, signal = null, timeoutMs = 60000 } = {}) {
  if (!apiKey(secret)) return fail(modelDomain.ERROR_CODE.CREDENTIAL_MISSING);
  if (!data || !data.length) return fail(modelDomain.ERROR_CODE.INVALID_INPUT, "empty-file");
  if (data.length > 50 * 1024 * 1024) return fail(modelDomain.ERROR_CODE.INVALID_INPUT, "tripo-file-too-large");
  const boundary = "----openarc" + crypto.randomBytes(12).toString("hex");
  const head = Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + String(filename).replace(/"/g, "") + "\"\r\nContent-Type: " + mime + "\r\n\r\n");
  const tail = Buffer.from("\r\n--" + boundary + "--\r\n");
  const body = Buffer.concat([head, Buffer.from(data), tail]);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  try {
    const response = await fetchImpl(new URL("/v3/files", baseUrl).toString(), { method: "POST", headers: { ...authHeaders(secret), "content-type": "multipart/form-data; boundary=" + boundary, "content-length": String(body.length) }, body, signal: controller.signal, redirect: "error" });
    const parsed = await response.json().catch(() => null);
    if (!response.ok || (parsed && Number(parsed.code) === 2010)) return tripoError(response.status, parsed);
    const token = String((parsed && parsed.data && (parsed.data.file_token || parsed.data.token)) || (parsed && parsed.file_token) || "");
    if (!token) return fail(modelDomain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR, "missing-file-token");
    return ok({ fileToken: token });
  } catch (error) {
    return fail(controller.signal.aborted ? modelDomain.ERROR_CODE.MODEL_TIMEOUT : modelDomain.ERROR_CODE.PROVIDER_UNAVAILABLE, String((error && error.message) || error).slice(0, 200));
  } finally { clearTimeout(timer); }
}

async function imageToModel({ baseUrl = BASE_URL, apiKey, fileToken, model = MODEL, texture = true, pbr = true, fetchImpl = fetch, signal = null, timeoutMs = 30000 } = {}) {
  return createTask({ baseUrl, apiKey, kind: "image", fileToken, model, texture, pbr, fetchImpl, signal, timeoutMs });
}

module.exports = { BASE_URL, CN_BASE_URL, MODEL, PROVIDER_PRESET, uploadFile, imageToModel, createTask, getTask, downloadModel, isAllowedModelUrl, authHeaders };
