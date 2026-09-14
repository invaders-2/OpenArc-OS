/** D3-04D 探针 05 · 性能：100 users / 20 departments / 10k resources 的治理与 Picker 延迟。 */
import { createRequire } from "node:module";
import { Probe, createResourceFixture, searchDomain } from "./lib.mjs";
const require = createRequire(import.meta.url);
const authzDomain = require("../../electron/authorization-domain.cjs");
const p = new Probe("05-performance", "Governance / Picker 性能基线（100 users / 20 depts / 10 内置 App / 10k resources）");
const f = await createResourceFixture();
f.authService.grantAppResourcePermission({ context: f.adminCtx(), appId: "resource-library", actions: authzDomain.RESOURCE_ACTIONS });
const admin = f.adminCtx();
const N = Number(process.env.D3_04D_PERF_N || 10000);
const U = 100;
const D = 20;
try {
  const t0 = Date.now();
  const depts = [];
  for (let i = 0; i < D; i += 1) depts.push(f.authService.createDepartment({ context: admin, name: "PerfD" + i }).department);
  for (let i = 0; i < U; i += 1) {
    const u = await f.identity.createUser({ identifier: "perf" + i + "@openarc.test", password: "perf-password-" + i, displayName: "Perf" + i, teamId: f.orgId });
    if (i % 5 === 0) f.authService.addDepartmentMember({ context: admin, departmentId: depts[i % D].id, userId: u.userId, membershipRole: "member" });
  }
  const db = f.identity.connection;
  const now = f.now();
  const insReg = db.prepare("INSERT INTO resource_registry (resource_id, resource_type, owner_user_id, organization_id, department_id, collection_id, scope, parent_resource_id, name, description, tags, version, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const insLib = db.prepare("INSERT INTO library_resources (resource_id, resource_type, mime_type, name, description, storage_mode, index_status, trash_state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const idOf = (i) => "res_govperf_" + String(i).padStart(6, "0");
  f.identity.transactSync(() => {
    for (let i = 0; i < N; i += 1) {
      const id = idOf(i);
      insReg.run(id, "text", f.users.admin, f.orgId, depts[i % D].id, null, "DEPARTMENT", null, "GovPerf " + i, "", "[]", 1, "active", now, now);
      insLib.run(id, "text", "text/plain", "GovPerf " + i, "", "LINKED", "PENDING", "ACTIVE", now, now);
    }
  });
  for (let i = 0; i < N; i += 1) {
    f.searchStore.replaceDocument({ resourceId: idOf(i), resourceVersion: 1, contentChecksum: null, status: "READY", name: "GovPerf " + i, description: "", tagsText: "", collectionName: "", contentText: "govperf token", contentTruncated: false, tokens: { name: searchDomain.indexTokenString("GovPerf " + i), description: "", tag: "", collection: "", content: searchDomain.indexTokenString("govperf token") } });
  }
  const seedMs = Date.now() - t0;
  p.note("seed " + U + " users + " + D + " depts + " + N + " resources = " + seedMs + "ms");
  const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.ceil((q / 100) * s.length) - 1))]; };
  const measure = async (label, fn, n = 20) => { const s = []; for (let i = 0; i < n; i += 1) { const t = process.hrtime.bigint(); await fn(); s.push(Number(process.hrtime.bigint() - t) / 1e6); } const p50 = pct(s, 50); const p95 = pct(s, 95); p.note(label + " p50=" + p50.toFixed(1) + "ms p95=" + p95.toFixed(1) + "ms"); return { p50, p95 }; };
  const users = await measure("listUsers", () => f.governanceService.listUsers({ context: admin }));
  const deptsT = await measure("listDepartments", () => f.governanceService.listDepartments({ context: admin }));
  const picker = await measure("picker.query", () => f.pickerService.query({ context: admin, appId: "resource-library", query: "govperf", limit: 40 }), 20);
  const search = await measure("authorized search", () => f.searchService.search({ context: admin, query: "govperf", limit: 40, reconcile: false }), 20);
  p.assert("listUsers 100 用户 p95 < 500ms", users.p95 < 500, users.p95.toFixed(1) + "ms");
  p.assert("listDepartments（含 10k 资源计数）p95 < 1500ms", deptsT.p95 < 1500, deptsT.p95.toFixed(1) + "ms");
  p.assert("Picker p95 < 3000ms（复用 Search Provider）", picker.p95 < 3000, picker.p95.toFixed(1) + "ms");
  p.assert("Authorized search p95 < 1000ms", search.p95 < 1000, search.p95.toFixed(1) + "ms");
  const mem = process.memoryUsage();
  p.assert("RSS < 2048MB", mem.rss / 1048576 < 2048, (mem.rss / 1048576).toFixed(1) + "MB");
} finally { f.close(); }
p.finish();
if (p.verdict() === "FAIL") process.exitCode = 1;
