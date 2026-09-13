/** D3-04C 探针 04 · 无远程调用：索引 / 搜索 / 预览全程不触网（无远程 Embedding/Vision/OCR/Transcription）。 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { Probe, ROOT, createResourceFixture } from "./lib.mjs";

const require = createRequire(import.meta.url);
const p = new Probe("04-no-remote-call", "本地优先：索引 / 搜索 / 预览不调用任何远程服务");

// 1) 静态扫描：本地搜索/索引/抽取/预览模块不得出现远程端点或网络 API
const MODULES = ["search-domain.cjs", "search-store.cjs", "search-service.cjs", "extractors.cjs", "preview-service.cjs"];
const REMOTE_RE = /https?:\/\/|fetch\s*\(|WebSocket|openai|api\.|anthropic|azure|aws|s3\./i;
let staticHits = 0;
for (const m of MODULES) {
  const src = fs.readFileSync(path.join(ROOT, "electron", m), "utf8");
  if (REMOTE_RE.test(src)) { staticHits += 1; p.case("静态扫描 " + m, "FAIL", "含远程/网络引用"); }
}
p.assert("静态扫描：5 个搜索/索引/预览模块无远程端点与网络 API", staticHits === 0, "hits=" + staticHits);

// 2) 运行时探针：拦截所有网络出口，跑完整 index/search/preview
const netCalls = [];
const wrap = (obj, key, label) => {
  if (!obj || typeof obj[key] !== "function") return;
  const orig = obj[key];
  obj[key] = function (...args) {
    netCalls.push(label);
    throw new Error("NETWORK_BLOCKED:" + label);
    // eslint-disable-next-line no-unreachable
    return orig.apply(this, args);
  };
};
globalThis.fetch = (...a) => { netCalls.push("fetch"); throw new Error("NETWORK_BLOCKED:fetch"); };
wrap(require("node:http"), "request", "http.request");
wrap(require("node:http"), "get", "http.get");
wrap(require("node:https"), "request", "https.request");
wrap(require("node:https"), "get", "https.get");
wrap(require("node:dns"), "lookup", "dns.lookup");
wrap(require("node:net"), "connect", "net.connect");
wrap(require("node:tls"), "connect", "tls.connect");

const f = await createResourceFixture();
const alice = f.ctx("alice");
try {
  const r1 = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "本地文档 鞋子", content: "红色鞋子 详情页 生成提示词 本地索引" });
  const img = f.writeSource("local.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(512, 4)]));
  const r2 = await f.resourceService.importManaged({ context: alice, sourcePath: img, name: "local.png", mimeType: "image/png" });
  await f.searchService.indexResource(r1.resource.resourceId);
  await f.searchService.indexResource(r2.resource.resourceId);
  const zh = await f.searchService.search({ context: alice, query: "鞋子", limit: 10 });
  await f.searchService.search({ context: alice, query: "详情页", limit: 10 });
  await f.searchService.search({ context: alice, query: "生成提示", limit: 10 });
  const pv = await f.previewService.preview({ context: alice, resourceRef: r2.resource.resourceId });
  await f.previewService.handleProtocolRequest(new Request(pv.url));
  const th = await f.previewService.thumbnail({ context: alice, resourceRef: r2.resource.resourceId });
  p.assert("索引 / 中文搜索 / 预览 / Range / thumbnail 全程零网络调用", netCalls.length === 0, netCalls.join(",") || "0 calls");
  p.assert("中文检索仍然工作（无远程也满足硬验收）", zh.ok && zh.total === 1, "total=" + zh.total);
  p.assert("Node 下 thumbnail 明确 UNSUPPORTED（不联网、不伪造）", th.ok === false && th.error === "PREVIEW_UNSUPPORTED", th.error || "");
} finally {
  f.close();
}
p.finish();
if (p.verdict() === "FAIL") process.exitCode = 1;
