"use strict";
/**
 * 协议产物下载器。
 * 源：DXSRC/protocol-engine/artifactDownload.ts:1-118（DNS 固定 + 重定向上限 3 + 大小上限 +
 * 凭据只发给 provider 精确 origin）。
 *
 * 相对上游**新增** SSRF 防护（P2 任务硬要求；上游只校验 http(s)/无凭据，见源文件 :12-19）：
 *   · 只允许 http/https
 *   · 拒绝 localhost / 回环 / 私网 / 链路本地 / CGNAT / 云元数据地址
 *   · 拒绝 IPv4-mapped IPv6、十进制/十六进制等 URL 归一化后的私网地址
 *   · DNS 解析后再校验一次解析结果，防 DNS rebinding
 */
const { lookup: dnsLookup } = require("node:dns/promises");
const { request: httpRequest } = require("node:http");
const { request: httpsRequest } = require("node:https");
const { isIP } = require("node:net");

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const MAX_REDIRECTS = 3;

const METADATA_HOSTS = new Set([
  "metadata.google.internal", "metadata", "metadata.goog",
  "169.254.169.254", "100.100.100.200", "fd00:ec2::254",
]);

function normalizedHostname(value) {
  return String(value || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isBlockedArtifactAddress(address) {
  const host = normalizedHostname(address);
  if (!host) return true;
  const zoneStripped = host.split("%")[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(zoneStripped);
  if (mapped) return isBlockedArtifactAddress(mapped[1]);
  const family = isIP(zoneStripped);
  if (family === 4) {
    const [a, b] = zoneStripped.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 192 && b === 0) return true;
    if (a >= 224) return true;
    return false;
  }
  if (family === 6) {
    if (zoneStripped === "::1" || zoneStripped === "::") return true;
    if (zoneStripped.startsWith("fe80:")) return true;
    if (/^f[cd][0-9a-f]{2}:/.test(zoneStripped)) return true;
    if (zoneStripped.startsWith("ff")) return true;
    return false;
  }
  return false;
}

function isBlockedArtifactHost(hostname) {
  const host = normalizedHostname(hostname);
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (METADATA_HOSTS.has(host)) return true;
  if (isIP(host)) return isBlockedArtifactAddress(host);
  return false;
}

function validateProtocolArtifactUrl(raw) {
  let url;
  try { url = new URL(String(raw || "")); } catch { throw new Error("协议产物 URL 无效"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("协议产物只允许无凭据的 HTTP(S) URL");
  }
  if (isBlockedArtifactHost(url.hostname)) {
    throw new Error("协议产物 URL 指向本机或私网地址，已拒绝（SSRF 防护）");
  }
  return url;
}

function selectPinnedProtocolAddress(_url, addresses) {
  if (!addresses.length) throw new Error("协议产物 URL 无法解析");
  return addresses[0];
}

async function pinnedAddress(url) {
  const hostname = normalizedHostname(url.hostname);
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await dnsLookup(hostname, { all: true, verbatim: true });
  const selected = selectPinnedProtocolAddress(url, addresses);
  if (isBlockedArtifactAddress(selected.address)) throw new Error("协议产物解析到本机或私网地址，已拒绝（SSRF 防护）");
  return selected;
}

function createPinnedLookup(address) {
  return ((_hostname, options, callback) => {
    if (options && typeof options === "object" && options.all === true) {
      callback(null, [{ address: address.address, family: address.family }]);
    } else {
      callback(null, address.address, address.family);
    }
  });
}

function requestPinned(url, address, maxBytes, timeoutMs, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const lookup = createPinnedLookup(address);
    const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = requestFn(url, {
      method: "GET", lookup, ...(url.protocol === "https:" ? { servername: url.hostname } : {}),
      headers: { Accept: "image/*, video/*, audio/*, application/octet-stream", ...extraHeaders },
    }, (response) => {
      const declared = Number(response.headers["content-length"] || 0);
      if (declared > maxBytes) {
        response.destroy();
        reject(new Error("协议产物超过大小限制 " + maxBytes + " 字节"));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          response.destroy(new Error("协议产物超过大小限制 " + maxBytes + " 字节"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode || 0, headers: response.headers, data: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("协议产物下载超时")));
    request.on("error", reject);
    request.end();
  });
}

async function downloadArtifact(raw, options = {}, trustedProvider) {
  const maxBytes = Math.max(1, Math.min(Number(options.maxBytes) || DEFAULT_MAX_BYTES, DEFAULT_MAX_BYTES));
  const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs) || 180000, 10 * 60000));
  let url = validateProtocolArtifactUrl(raw);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const address = await pinnedAddress(url);
    const response = await requestPinned(url, address, maxBytes, timeoutMs, trustedProvider && trustedProvider.origin === url.origin ? trustedProvider.headers : {});
    if (REDIRECTS.has(response.status)) {
      const location = Array.isArray(response.headers.location) ? response.headers.location[0] : response.headers.location;
      if (!location || redirects === MAX_REDIRECTS) throw new Error("协议产物重定向过多或缺少 Location");
      url = validateProtocolArtifactUrl(new URL(location, url).toString());
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error("协议产物下载失败 HTTP " + response.status);
    const contentType = Array.isArray(response.headers["content-type"]) ? response.headers["content-type"][0] : response.headers["content-type"];
    return { data: response.data, mime: String(contentType || "application/octet-stream").split(";")[0], sourceUrl: url.toString() };
  }
  throw new Error("协议产物下载失败");
}

const downloadProtocolArtifact = downloadArtifact;

/** 凭据只转发给精确 API origin；重定向到 CDN 时自动去掉凭据。源：DXSRC :107-118 */
function createProviderArtifactDownloader(baseUrl, headers) {
  const providerUrl = validateProtocolArtifactUrl(baseUrl);
  const origin = providerUrl.origin;
  const safeHeaders = Object.fromEntries(Object.entries(headers).filter(([name, value]) => name && value && !/[\r\n]/.test(name + value)));
  return (raw, options) => downloadArtifact(raw, options, { origin, headers: safeHeaders });
}

module.exports = {
  validateProtocolArtifactUrl, selectPinnedProtocolAddress, createPinnedLookup,
  downloadProtocolArtifact, createProviderArtifactDownloader,
  isBlockedArtifactAddress, isBlockedArtifactHost,
};
