/**
 * D5-03 · 解析器四元组探针（前后对比用）。
 * 只读：resolveDshRuntime / resolveDshBin / dshVersion / resolveAcpSdk。
 */
"use strict";
const path = require("node:path");
const adapter = require(path.join(__dirname, "..", "..", "electron", "harness-adapter.cjs"));

function probe(label, fn) {
  try { const v = fn(); return { label, ok: true, value: v === undefined ? null : v }; }
  catch (e) { return { label, ok: false, threw: true, code: e && e.code ? e.code : null, message: String(e && e.message) }; }
}

const runtime = probe("resolveDshRuntime()", () => adapter.resolveDshRuntime());
let bin = null, version = null, sdk = null, sdkVersion = null;
// 逐个独立探测：前一个失败不影响后一个（"返回哪种缺失"本身就是要记录的事实）。
bin = probe("resolveDshBin()", () => adapter.resolveDshBin());
version = probe("dshVersion()", () => adapter.dshVersion());
sdk = probe("resolveAcpSdk()", () => adapter.resolveAcpSdk());
if (sdk.ok && sdk.value) { try { sdkVersion = require(path.join(path.dirname(path.dirname(sdk.value)), "package.json")).version; } catch { sdkVersion = null; } }

console.log(JSON.stringify({
  cwd: process.cwd(),
  envOverride: { OPENARC_DSH_RUNTIME: process.env.OPENARC_DSH_RUNTIME || null, OPENARC_DSH_BIN: process.env.OPENARC_DSH_BIN || null },
  runtime, bin, version, sdk, sdkPackageVersion: sdkVersion,
}, null, 2));
