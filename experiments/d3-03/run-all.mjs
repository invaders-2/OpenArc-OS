"use strict";

/**
 * D3-03 · run-all
 * 依次运行本阶段的所有探针；当前阶段只有 TLS/mTLS 矩阵，
 * 后续阶段直接往 groups 里追加即可（保持"任一组失败即退出 1"）。
 */
import { runTlsMatrix } from "./run-tls-matrix.mjs";

const groups = [];

console.log("");
console.log("=== D3-03 / TLS-mTLS matrix ===");
const tls = await runTlsMatrix();
groups.push({ name: "tls-matrix", ok: tls.ok, count: tls.results.length });

const failed = groups.filter((g) => !g.ok);
console.log("");
console.log("[run-all] " + (groups.length - failed.length) + "/" + groups.length + " 组通过" + (failed.length ? "；FAIL: " + failed.map((g) => g.name).join(" / ") : ""));
process.exit(failed.length ? 1 : 0);
