/** D3-04C · resource-search-performance.test —— 10,000 条索引记录的搜索延迟 / 内存 / 扫描预算。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createResourceFixture, searchDomain } from "./resource-fixtures.mjs";

const require = createRequire(import.meta.url);
const authzDomain = require("../electron/authorization-domain.cjs");

const N = 10000;
const f = await createResourceFixture();
after(() => f.close());
const alice = f.ctx("alice");

// 内置应用 resource-library 的全局 App Grant（与真实启动路径一致；批量注入不经过 ResourceService）。
const appGrant = f.authService.grantAppResourcePermission({ context: f.adminCtx(), appId: "resource-library", actions: authzDomain.RESOURCE_ACTIONS });
assert.equal(appGrant.ok, true, "seed app grant failed: " + appGrant.error);

function seed() {
  const db = f.identity.connection;
  const now = f.now();
  const insReg = db.prepare(
    "INSERT INTO resource_registry (resource_id, resource_type, owner_user_id, organization_id, department_id, collection_id, scope, parent_resource_id, name, description, tags, version, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const insLib = db.prepare(
    "INSERT INTO library_resources (resource_id, resource_type, mime_type, name, description, storage_mode, index_status, trash_state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  );
  const idOf = (i) => "res_perf_" + String(i).padStart(6, "0");
  f.identity.transactSync(() => {
    for (let i = 0; i < N; i += 1) {
      const id = idOf(i);
      const name = "Perf Resource " + i;
      insReg.run(id, "text", f.users.alice, f.orgId, null, null, "PERSONAL", null, name, "", "[]", 1, "active", now, now);
      insLib.run(id, "text", "text/plain", name, "", "LINKED", "PENDING", "ACTIVE", now, now);
    }
  });
  for (let i = 0; i < N; i += 1) {
    const id = idOf(i);
    const name = "Perf Resource " + i;
    const content = i % 1000 === 0 ? "perftoken needlecommon uniquetoken" : "perftoken needlecommon filler";
    f.searchStore.replaceDocument({
      resourceId: id,
      resourceVersion: 1,
      contentChecksum: null,
      status: "READY",
      name,
      description: "",
      tagsText: "",
      collectionName: "",
      contentText: content,
      contentTruncated: false,
      tokens: { name: searchDomain.indexTokenString(name), description: "", tag: "", collection: "", content: searchDomain.indexTokenString(content) },
    });
  }
  return idOf;
}

function percentile(samples, p) {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

test("10,000 条索引：搜索 p50/p95 延迟与内存基线", async () => {
  const t0 = Date.now();
  const idOf = seed();
  const seedMs = Date.now() - t0;
  assert.equal(f.searchStore.countDocuments(), N);
  assert.equal(f.searchStore.ftsCount(), N);

  const samples = [];
  let last;
  for (let i = 0; i < 40; i += 1) {
    const s = process.hrtime.bigint();
    last = await f.searchService.search({ context: alice, query: "needlecommon", limit: 40 });
    samples.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  assert.equal(last.ok, true);
  assert.equal(last.items.length, 40);
  assert.ok(last.items.every((it) => it.matchedFields.includes("content")));
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  const max = Math.max(...samples);

  // 纯索引路径（跳过 reconcile）：衡量 FTS + 批量授权本身
  const pureSamples = [];
  for (let i = 0; i < 40; i += 1) {
    const s = process.hrtime.bigint();
    await f.searchService.search({ context: alice, query: "needlecommon", limit: 40, reconcile: false });
    pureSamples.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  const pureP95 = percentile(pureSamples, 95);
  const mem = process.memoryUsage();
  console.log(
    "[perf] seed=" + seedMs + "ms docs=" + N +
    " reconcile p50=" + p50.toFixed(1) + " p95=" + p95.toFixed(1) + " max=" + max.toFixed(1) +
    " pure p95=" + pureP95.toFixed(1) +
    " heapUsed=" + (mem.heapUsed / 1048576).toFixed(1) + "MB rss=" + (mem.rss / 1048576).toFixed(1) + "MB",
  );
  assert.ok(p95 < 3000, "reconcile p95 应 < 3000ms，实际 " + p95.toFixed(1));
  assert.ok(pureP95 < 1000, "纯索引 p95 应 < 1000ms，实际 " + pureP95.toFixed(1));
  assert.ok(mem.rss / 1048576 < 1536, "RSS 应受控，实际 " + (mem.rss / 1048576).toFixed(1) + "MB");
});

test("10,000 条索引：唯一 token 精确命中，且授权外用户 0 结果", async () => {
  const ctx = { sessionRef: f.sessions.dana, appId: "resource-library", source: "ui" };
  const hit = await f.searchService.search({ context: alice, query: "uniquetoken", limit: 10 });
  assert.equal(hit.ok, true);
  assert.equal(hit.total, 10, "uniquetoken 每 1000 条命中一条 * 10");
  assert.ok(hit.items.every((it) => it.resourceId.startsWith("res_perf_")));
  // dana 对这些 PERSONAL 资源无权：total 必须是 0，且不返回任何字段
  const denied = await f.searchService.search({ context: ctx, query: "needlecommon", limit: 40 });
  assert.equal(denied.ok, true);
  assert.equal(denied.total, 0);
  assert.equal(denied.items.length, 0);
  assert.equal(JSON.stringify(denied).includes("Perf Resource"), false, "不得泄漏未授权资源名");
});

test("10,000 条索引：扫描预算生效，不因超大结果集失控", async () => {
  const res = await f.searchService.search({ context: alice, query: "perftoken", limit: 40, offset: 0 });
  assert.equal(res.ok, true);
  assert.ok(res.scanned <= searchDomain.LIMITS.MAX_SCAN, "scanned 不得超过 MAX_SCAN");
  assert.ok(res.items.length <= 40);
  assert.equal(typeof res.totalIsLowerBound, "boolean");
});
