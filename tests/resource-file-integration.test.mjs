/** D3-04D · resource-file-integration —— File → Resource / Resource → Export / Reveal Source。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const admin = f.adminCtx();

test("Export 同时要求 resource.export 与 read；导出内容与源一致", async () => {
  const r = await f.resourceService.createResource({ context: admin, resourceType: "text", name: "ExportMe", content: "export-body-123" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d3d-export-"));
  const target = path.join(dir, "out.txt");
  const res = await f.resourceService.exportToFile({ context: admin, resourceRef: r.resource.resourceId, targetPath: target });
  assert.equal(res.ok, true);
  assert.equal(fs.readFileSync(target, "utf8"), "export-body-123");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("撤销 read 后 Export 立即 DENY（不能借 Export 绕过）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d3d-export2-"));
  const r = await f.resourceService.createResource({ context: admin, resourceType: "text", name: "NoRead", content: "x" });
  const created = await f.governanceService.createUser({ context: admin, identifier: "ex@openarc.test", password: "ex-password-1", displayName: "EX" });
  const g = f.authService.grantResourcePermission({ context: admin, principalType: "USER", principalId: created.userId, resourceId: r.resource.resourceId, actions: ["resource.export", "resource.view"] });
  assert.equal(g.ok, true);
  const login = await f.identity.login({ identifier: "ex@openarc.test", password: "ex-password-1" });
  const ctx = { sessionRef: login.session.ref, appId: "resource-library" };
  const res = await f.resourceService.exportToFile({ context: ctx, resourceRef: r.resource.resourceId, targetPath: path.join(dir, "x.txt") });
  assert.equal(res.ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Reveal Source 只对 LINKED 资源可用，且路径只在主进程返回", async () => {
  const src = f.writeSource("reveal.txt", "reveal me");
  const linked = f.resourceService.createLinked({ context: admin, sourcePath: src, name: "Reveal" });
  const ok = f.resourceService.resolveRevealPath({ context: admin, resourceRef: linked.resource.resourceId });
  assert.equal(ok.ok, true);
  assert.equal(fs.realpathSync(ok.path), fs.realpathSync(src));
  const managed = await f.resourceService.createResource({ context: admin, resourceType: "text", name: "ManagedNotReveal", content: "x" });
  assert.equal(f.resourceService.resolveRevealPath({ context: admin, resourceRef: managed.resource.resourceId }).ok, false);
});

test("受控 add-to-library 等价路径：Managed / Linked 都得到 ResourceRef", async () => {
  const src = f.writeSource("addme.txt", "add me");
  const managed = await f.resourceService.importManaged({ context: admin, sourcePath: src, name: "ManagedAdd" });
  const linked = f.resourceService.createLinked({ context: admin, sourcePath: src, name: "LinkedAdd" });
  assert.ok(managed.resource.resourceRef.startsWith("resource://"));
  assert.ok(linked.resource.resourceRef.startsWith("resource://"));
  assert.equal(managed.resource.storageMode, "MANAGED");
  assert.equal(linked.resource.storageMode, "LINKED");
});
