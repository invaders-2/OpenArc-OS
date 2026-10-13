"use strict";
/** 协议传输抽象 + 可回放/可录制的测试传输。源：DXSRC/protocol-engine/transport.ts:1-174 */
const { createHash } = require("node:crypto");

const defaultProtocolClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function createVirtualProtocolClock(startAt = 0) {
  let current = startAt;
  return {
    now: () => current,
    sleep: async (ms) => { current += Math.max(0, ms); },
    elapsed: () => current - startAt,
  };
}

const SECRET_HEADERS = new Set(["authorization", "proxy-authorization", "x-api-key", "x-goog-api-key", "api-key"]);

function sha256(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return createHash("sha256").update(bytes).digest("hex");
}

function stableHeaders(value) {
  const headers = new Headers(value);
  return Object.fromEntries([...headers.entries()]
    .map(([key, headerValue]) => [key.toLowerCase(), SECRET_HEADERS.has(key.toLowerCase()) ? `<secret:${key.toLowerCase()}>` : headerValue])
    .sort(([left], [right]) => left.localeCompare(right)));
}

async function transcriptBody(body, contentType = "") {
  if (body == null) return { kind: "empty" };
  if (body instanceof FormData) {
    const fields = [];
    for (const [name, value] of body.entries()) {
      if (typeof value === "string") fields.push({ name, value });
      else {
        const bytes = new Uint8Array(await value.arrayBuffer());
        fields.push({ name, file: { name: value.name, type: value.type, bytes: bytes.byteLength, sha256: sha256(bytes) } });
      }
    }
    return { kind: "multipart", fields };
  }
  if (typeof body === "string") {
    if (/json/i.test(contentType) || /^[\s]*[{[]/.test(body)) {
      try { return { kind: "json", value: JSON.parse(body) }; } catch { /* keep text */ }
    }
    return { kind: "text", value: body };
  }
  if (body instanceof URLSearchParams) return { kind: "text", value: body.toString() };
  if (body instanceof Blob) {
    const bytes = new Uint8Array(await body.arrayBuffer());
    return { kind: "binary", bytes: bytes.byteLength, sha256: sha256(bytes) };
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return { kind: "binary", bytes: bytes.byteLength, sha256: sha256(bytes) };
  }
  return { kind: "text", value: String(body) };
}

async function requestTranscript(input, init) {
  const request = input instanceof Request ? input : null;
  const headers = new Headers(request?.headers);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  const body = init?.body ?? (request?.body ? await request.clone().blob() : null);
  return {
    method: String(init?.method || request?.method || "GET").toUpperCase(),
    url: String(request?.url || input),
    headers: stableHeaders(headers),
    body: await transcriptBody(body, headers.get("content-type") || ""),
  };
}

async function responseTranscript(response) {
  const clone = response.clone();
  const contentType = clone.headers.get("content-type") || "";
  const body = /json|text|xml|html|javascript|x-www-form-urlencoded/i.test(contentType)
    ? await transcriptBody(await clone.text(), contentType)
    : await transcriptBody(await clone.arrayBuffer(), contentType);
  return { status: response.status, headers: stableHeaders(response.headers), body };
}

const defaultProtocolTransport = {
  fetch(input, init) { return globalThis.fetch(input, init); },
};

class RecordingTransport {
  constructor(inner = defaultProtocolTransport, captureResponses = true) { this.inner = inner; this.captureResponses = captureResponses; this.transcript = []; }
  async fetch(input, init) {
    const entry = { request: await requestTranscript(input, init) };
    this.transcript.push(entry);
    const response = await this.inner.fetch(input, init);
    if (this.captureResponses) entry.response = await responseTranscript(response);
    return response;
  }
}

class ReplayTransport {
  constructor(responses) { this.responses = responses; this.requests = []; this.cursor = 0; }
  async fetch(input, init) {
    this.requests.push(await requestTranscript(input, init));
    const response = this.responses[this.cursor++];
    if (!response) throw new Error(`ReplayTransport 缺少第 ${this.cursor} 个响应。`);
    return new Response(response.body ?? null, { status: response.status ?? 200, headers: response.headers });
  }
  assertComplete() {
    if (this.cursor !== this.responses.length) throw new Error(`ReplayTransport 仍有 ${this.responses.length - this.cursor} 个响应未使用。`);
  }
}

class MockTransport {
  constructor(handler) { this.handler = handler; this.requests = []; }
  fetch(input, init) { this.requests.push({ input, init }); return Promise.resolve(this.handler(input, init)); }
}

module.exports = {
  defaultProtocolClock, createVirtualProtocolClock, defaultProtocolTransport,
  RecordingTransport, ReplayTransport, MockTransport, stableHeaders,
};
