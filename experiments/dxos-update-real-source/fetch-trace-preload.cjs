/**
 * dxos-update-real-source · 真机取证用的 fetch 追踪预载（仅测试用，不进产品链路）。
 *
 * 由 harness 以 NODE_OPTIONS=--require=<本文件的 /tmp 副本> 注入 Electron 主进程：
 *   · 不改变任何请求/响应语义（原样调用原 fetch 与响应自己的 arrayBuffer）；
 *   · 每笔请求记录 URL / 方法 / redirect 模式 / 状态 / Location / 耗时；
 *   · 每笔被 arrayBuffer() 完整读出的响应记录字节数与 sha256（下载资产的直接证据）；
 *     Electron 主进程的 fetch 响应未必是全局 Response 的实例，所以**逐个响应实例**包一层，
 *     同时对全局 Response.prototype 也包一层（两条路都试，谁生效都不影响原行为）；
 *   · 小体积 JSON 响应额外留原文（latest.json / manifest.json 这类清单的直接证据）；
 *   · 只追加写 OA_FETCH_TRACE_FILE 指向的 JSONL；路径不存在即静默跳过。
 *
 * 记录里含 ModelScope 的 LFS 签名参数（auth_key）—— 所以 harness 只把脱敏后的副本放进
 * artifacts/dxos-update-real-source/fetch-trace.jsonl，原始文件留在临时目录并随进程回收。
 */
"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");

const file = process.env.OA_FETCH_TRACE_FILE;

if (file) {
  const write = (record) => {
    try { fs.appendFileSync(file, JSON.stringify(record) + "\n"); } catch { /* 取证失败绝不能影响被测行为 */ }
  };

  const recordBody = (response, buffer, started) => {
    try {
      // response.arrayBuffer() 给的是 ArrayBuffer；crypto.update 只吃 Buffer/TypedArray。
      const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      const record = {
        kind: "body",
        at: started,
        url: String((response && response.url) || ""),
        bytes: bytes.length,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        ms: Date.now() - started,
      };
      let contentType = "";
      try { contentType = String(response.headers.get("content-type") || ""); } catch { contentType = ""; }
      record.contentType = contentType || null;
      if (bytes.length <= 8192 && /json/i.test(contentType)) record.text = bytes.toString("utf8");
      write(record);
    } catch { /* 取证失败绝不能影响被测行为 */ }
  };

  const wrapResponse = (response) => {
    if (!response || typeof response.arrayBuffer !== "function") return response;
    try {
      const original = response.arrayBuffer.bind(response);
      Object.defineProperty(response, "arrayBuffer", {
        configurable: true,
        writable: true,
        value: async function tracedArrayBuffer() {
          const started = Date.now();
          const buffer = await original();
          recordBody(response, buffer, started);
          return buffer;
        },
      });
    } catch { /* 不能包装就不阻断请求 */ }
    return response;
  };

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === "function") {
    globalThis.fetch = async function tracedFetch(input, init) {
      const url = typeof input === "string" ? input : (input && typeof input.url === "string" ? input.url : String(input));
      const started = Date.now();
      const base = { kind: "fetch", at: started, method: (init && init.method) || "GET", url, redirect: (init && init.redirect) || "follow" };
      try {
        const response = await originalFetch.call(this, input, init);
        const record = { ...base, status: response.status, ms: Date.now() - started };
        try {
          record.location = response.headers.get("location") || null;
          record.contentType = response.headers.get("content-type") || null;
          const length = Number(response.headers.get("content-length"));
          record.contentLength = Number.isFinite(length) && length > 0 ? length : null;
        } catch { /* 头部不可读就留空 */ }
        write(record);
        return wrapResponse(response);
      } catch (error) {
        write({ ...base, ms: Date.now() - started, error: String((error && error.message) || error) });
        throw error;
      }
    };
  }

}
