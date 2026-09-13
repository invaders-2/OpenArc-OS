/** D3-04C 探针 05 · 性能：10,000 条授权索引的搜索延迟与内存基线。 */
import { createRequire } from "node:module";
import { Probe, createResourceFixture, searchDomain } from "./lib.mjs";

const require = createRequire(import.meta.url);
const authzDomain = require("../../electron/authorization-domain.cjs");
const p = new Probe("05-performance", "Authorized Search 性能 / 扫描预算 / 内存基线");
const N = Number(process.env.D3_04C_PERF_N || 10000);
const f = await createResourceFixture();
f.authService.grantAppResourcePermission({ context: f.adminCtx(), appId: "resource-library", actions: authzDomain.RESOURCE_ACTIONS });
const alice = f.ctx("alice");
try {
  const db = f.identity.connection;
  const now = f.now();
  const insReg = db.prepare("INSERT INTO resource_registry (resource_id, resource_type, owner_user_id, organization_id, department_id, collection_id, scope, parent_resource_id, name, description, tags, version, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const insLib = db.prepare("INSERT INTO library_resources (resource_id, resource_type, mime_type, name, description, storage_mode, index_status, trash_state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const idOf = (i) => "res_perf_" + String(i).padStart(6, "0");
  const t0 = Date.now();
  f.identity.transactSync(() => {
    for (let i = 0; i < N; i += 1) {
      const id = idOf(i);
      const name = "Perf Resource " + i;
      insReg.run(id, "text", f.users.alice, f.orgId, null, null, "PERSONAL", null, name, "", "[]", 1, "active", now, now);
      insLib.run(id, "text", "text/plain", name, "", "LINKED", "PENDING", "ACTIVE", now, now);
    }
  });
  for (let i = 0; i < N; i += 1) {
    const content = i % 1000 === 0 ? "perftoken needlecommon uniquetoken" : "perftoken needlecommon filler";
    f.searchStore.replaceDocument({ resourceId: idOf(i), resourceVersion: 1, contentChecksum: null, status: "READY", name: "Perf Resource " + i, description: "", tagsText: "", collectionName: "", contentText: content, contentTruncated: false, tokens: { name: searchDomain.indexTokenString("Perf Resource " + i), description: "", tag: "", collection: "", content: searchDomain.indexTokenString(content) } });
  }
  const seedMs = Date.now() - t0;
  p.assert(N + " 条索引记录建立（" + seedMs + "ms）", f.searchStore.countDocuments() === N && f.searchStore.ftsCount() === N, "docs=" + f.searchStore.countDocuments());

  const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.ceil((q / 100) * s.length) - 1))]; };
  const samples = [];
  let last;
  for (let i = 0; i < 40; i += 1) { const s = process.hrtime.bigint(); last = await f.searchService.search({ context: alice, query: "needlecommon", limit: 40 }); samples.push(Number(process.hrtime.bigint() - s) / 1e6); }
  const pure = [];
  for (let i = 0; i < 40; i += 1) { const s = process.hrtime.bigint(); await f.searchService.search({ context: alice, query: "needlecommon", limit: 40, reconcile: false }); pure.push(Number(process.hrtime.bigint() - s) / 1e6); }
  const mem = process.memoryUsage();
  p.note("reconcile p50=" + pct(samples, 50).toFixed(1) + "ms p95=" + pct(samples, 95).toFixed(1) + "ms / pure-index p95=" + pct(pure, 95).toFixed(1) + "ms / rss=" + (mem.rss / 1048576).toFixed(1) + "MB");
  p.assert("搜索返回 40 条授权结果", last.ok && last.items.length === 40 && last.items.every((i) => i.matchedFields.includes("content")), "items=" + last.items.length);
  p.assert("reconcile p95 < 3000ms", pct(samples, 95) < 3000, pct(samples, 95).toFixed(1) + "ms");
  p.assert("纯索引路径 p95 < 1000ms", pct(pure, 95) < 1000, pct(pure, 95).toFixed(1) + "ms");
  p.assert("RSS < 1536MB", mem.rss / 1048576 < 1536, (mem.rss / 1048576).toFixed(1) + "MB");
  const uniq = await f.searchService.search({ context: alice, query: "uniquetoken", limit: 20 });
  p.assert("唯一 token 精确命中 " + Math.ceil(N / 1000) + " 条", uniq.total === Math.ceil(N / 1000), "total=" + uniq.total);
  const deny = await f.searchService.search({ context: { sessionRef: f.sessions.dana, appId: "resource-library" }, query: "needlecommon", limit: 40 });
  p.assert("DEFAULT DENY：无权用户 0 结果且不泄漏名称", deny.total === 0 && !JSON.stringify(deny).includes("Perf Resource"), "total=" + deny.total);
  const scan = await f.searchService.search({ context: alice, query: "perftoken", limit: 40 });
  p.assert("扫描预算生效（scanned <= MAX_SCAN）", scan.scanned <= searchDomain.LIMITS.MAX_SCAN, "scanned=" + scan.scanned);
} finally {
  f.close();
}
p.finish();
if (p.verdict() === "FAIL") process.exitCode = 1;
