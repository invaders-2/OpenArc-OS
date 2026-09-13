/** D3-04A 探针 01 · Resource Object / Managed Store / Version / Trash。 */
import fs from "node:fs";
import { Probe, createResourceFixture } from "./lib.mjs";

const p = new Probe("01-store-lifecycle", "Managed Store / Content Addressing / Version / Trash / GC");
const f = await createResourceFixture();
const ctx = f.ctx("alice");
try {
  const src = f.writeSource("life.txt", "lifecycle content");
  const imp = await f.resourceService.importManaged({ context: ctx, sourcePath: src, name: "Life" });
  p.assert("managed import 成功且 MANAGED", imp.ok && imp.resource.storageMode === "MANAGED", imp.error || "ok");
  const objPath = f.managedStore.objectPath(imp.resource.checksum);
  p.assert("object 位于 objects/sha256 且由 hash 命名", !!objPath && objPath.includes("objects/sha256"), objPath);
  fs.rmSync(src);
  const read = await f.resourceService.readText({ context: ctx, resourceRef: imp.resource.resourceRef });
  p.assert("删除原文件后 MANAGED 仍可读", read.ok && read.text === "lifecycle content", read.error || "ok");

  const dupA = f.writeSource("dup-a.txt", "same bytes");
  const dupB = f.writeSource("dup-b.txt", "same bytes");
  const r1 = await f.resourceService.importManaged({ context: ctx, sourcePath: dupA, name: "Dup A" });
  const r2 = await f.resourceService.importManaged({ context: ctx, sourcePath: dupB, name: "Dup B" });
  const c1 = f.resourceStore.libraryResourceById(r1.resource.resourceId).content_object_id;
  const c2 = f.resourceStore.libraryResourceById(r2.resource.resourceId).content_object_id;
  p.assert("dedupe：1 content object / 2 Resource entry", r1.ok && r2.ok && r1.resource.resourceId !== r2.resource.resourceId && c1 === c2, "content=" + c1);

  const p2 = f.writeSource("v2.txt", "version two");
  const rep = await f.resourceService.replaceContent({ context: ctx, resourceRef: imp.resource.resourceRef, sourcePath: p2, expectedVersion: 1 });
  p.assert("replaceContent -> version 2，ResourceRef 不变", rep.ok && rep.resource.version === 2 && rep.resource.resourceRef === imp.resource.resourceRef, rep.error || "v" + (rep.resource && rep.resource.version));
  const conflict = await f.resourceService.replaceContent({ context: ctx, resourceRef: imp.resource.resourceRef, sourcePath: p2, expectedVersion: 1 });
  p.assert("stale expectedVersion -> VERSION_CONFLICT", !conflict.ok && conflict.error === "VERSION_CONFLICT", conflict.error);
  const restore = f.resourceService.restoreVersion({ context: ctx, resourceRef: imp.resource.resourceRef, version: 1 });
  p.assert("restore v1 -> 新版本 v3（不倒退）", restore.ok && restore.resource.version === 3, restore.error || "v" + (restore.resource && restore.resource.version));

  f.resourceService.delete({ context: ctx, resourceRef: imp.resource.resourceRef });
  const list = f.resourceService.list({ context: ctx });
  p.assert("Trash 后 normal list 不含", !list.items.some((i) => i.resourceId === imp.resource.resourceId), "count=" + list.count);
  const got = f.resourceService.get({ context: ctx, resourceRef: imp.resource.resourceRef });
  p.assert("direct get 安全报告 trashed", got.ok && got.resource.trashed && got.resource.availability === "TRASHED", got.resource && got.resource.availability);
  const readTrashed = await f.resourceService.readText({ context: ctx, resourceRef: imp.resource.resourceRef });
  p.assert("Trash 后 read 被拒", !readTrashed.ok && readTrashed.error === "RESOURCE_TRASHED", readTrashed.error);
  const res = f.resourceService.restore({ context: ctx, resourceRef: imp.resource.resourceRef });
  p.assert("restore 同一个 ResourceRef", res.ok && res.resource.resourceRef === imp.resource.resourceRef && !res.resource.trashed, res.error || "ok");

  const content = "gc shared payload";
  const ga = f.writeSource("gc-a.txt", content);
  const gb = f.writeSource("gc-b.txt", content);
  const s1 = await f.resourceService.importManaged({ context: ctx, sourcePath: ga, name: "GC A" });
  const s2 = await f.resourceService.importManaged({ context: ctx, sourcePath: gb, name: "GC B" });
  const contentId = f.resourceStore.libraryResourceById(s1.resource.resourceId).content_object_id;
  const gcPath = f.managedStore.objectPath(s1.resource.checksum);
  const pd1 = f.resourceService.permanentDelete({ context: ctx, resourceRef: s1.resource.resourceRef });
  p.assert("永久删除 A：共享 object 保留（refs=1）", pd1.ok && pd1.contentGc.refs === 1 && fs.existsSync(gcPath), JSON.stringify(pd1.contentGc));
  const pd2 = f.resourceService.permanentDelete({ context: ctx, resourceRef: s2.resource.resourceRef });
  p.assert("永久删除 B：无引用后才 GC", pd2.ok && pd2.contentGc.refs === 0 && pd2.contentGc.removed === true && !fs.existsSync(gcPath), JSON.stringify(pd2.contentGc));

  const integ = await f.resourceService.verifyIntegrity({ context: ctx, resourceRef: imp.resource.resourceRef });
  p.assert("verifyIntegrity MANAGED -> AVAILABLE", integ.ok && integ.integrity.status === "AVAILABLE", integ.integrity && integ.integrity.status);
} finally {
  f.close();
}
p.finish();
if (p.verdict() === "FAIL") process.exitCode = 1;
