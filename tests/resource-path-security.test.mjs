/**
 * D3-04A · resource-path-security.test —— 路径边界 / traversal / symlink / secret scan。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createResourceFixture, resourceDomain } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const ctx = f.ctx("alice");

test("纯路径判定：traversal / 绝对路径逃逸被拒", () => {
  assert.equal(resourceDomain.isPathInside("/a/b", "/a/b/c"), true);
  assert.equal(resourceDomain.isPathInside("/a/b", "/a/bc"), false);
  assert.equal(resourceDomain.isPathInside("/a/b", "/a"), false);
  assert.equal(resourceDomain.hasTraversal("../../etc/passwd"), true);
  assert.equal(f.managedStore.resolveKey("../../etc/passwd"), null);
  // 前导斜杠只被归一化为 store 内相对 key，永远不会逃出 store
  const absKey = f.managedStore.resolveKey("/etc/passwd");
  assert.ok(absKey && resourceDomain.isPathInside(f.storeRoot, absKey));
});

test("内部 object key 只由 SHA-256 生成；非法 checksum 被拒", () => {
  const checksum = "cd".repeat(32);
  assert.equal(resourceDomain.contentInternalKey(checksum), "objects/sha256/cd/" + checksum);
  assert.equal(resourceDomain.contentInternalKey("../../evil"), null);
  assert.equal(resourceDomain.contentInternalKey("not-hex"), null);
  assert.equal(resourceDomain.contentIdFor(checksum), "co_" + checksum);
});

test("用户文件名不参与最终 object 路径", async () => {
  const evil = f.writeSource("payload.bin", "path test payload");
  const imp = await f.resourceService.importManaged({ context: ctx, sourcePath: evil, name: "../../evil.txt" });
  assert.equal(imp.ok, true);
  const objPath = f.managedStore.objectPath(imp.resource.checksum);
  assert.ok(objPath.startsWith(path.join(f.storeRoot, "objects", "sha256")));
  assert.equal(objPath.includes("evil"), false);
  assert.equal(imp.resource.name, "../../evil.txt");
});

test("源路径 traversal 不存在 -> SOURCE_MISSING（不接受 Renderer 任意路径）", async () => {
  const res = await f.resourceService.importManaged({ context: ctx, sourcePath: "../../../definitely/not/here-d3-04a.txt", name: "Missing Traversal" });
  assert.equal(res.ok, false);
  assert.equal(res.error, "SOURCE_MISSING");
});

test("MANAGED symlink：解析真实目标并复制（之后与原 link 无关）", async () => {
  const real = f.writeSource("sym-real.txt", "symlink target content");
  const linkPath = path.join(f.sourceDir, "managed-sym.txt");
  fs.symlinkSync(real, linkPath);
  const imp = await f.resourceService.importManaged({ context: ctx, sourcePath: linkPath, name: "Managed Sym" });
  assert.equal(imp.ok, true);
  fs.rmSync(real);
  const read = await f.resourceService.readText({ context: ctx, resourceRef: imp.resource.resourceRef });
  assert.equal(read.ok, true);
  assert.equal(read.text, "symlink target content");
});

test("secret scan：metadata 过滤 forbidden keys，DB 不出现未写入的 secret", async () => {
  const sanitized = resourceDomain.sanitizeMetadata({ name: "ok", apiKey: "FAKE_API_KEY", devicePrivateKey: "FAKE_KEY", sessionToken: "FAKE_TOKEN" });
  assert.equal(sanitized.name, "ok");
  assert.equal(sanitized.apiKey, undefined);
  assert.equal(sanitized.devicePrivateKey, undefined);
  assert.equal(sanitized.sessionToken, undefined);

  const fakeDeviceKey = "FAKE_DEVICE_PRIVATE_KEY_never_written_0123456789";
  const src = f.writeSource("scan.txt", "normal content");
  await f.resourceService.importManaged({ context: ctx, sourcePath: src, name: "Scan", tags: ["safe"] });
  const haystack = JSON.stringify({
    jobs: f.resourceStore.allImportJobs(),
    content: f.resourceStore.allContentObjects(),
    audit: f.store.authorizationAudit(),
  });
  assert.equal(haystack.includes(fakeDeviceKey), false);
});
