/** D3-04A 探针 03 · Crash Recovery / Orphan GC / Path Security / Restart Persistence。 */
import fs from "node:fs";
import path from "node:path";
import { Probe, createResourceFixture, reopenResourceRuntime, resourceDomain, tempRoot, pw } from "./lib.mjs";

const p = new Probe("03-recovery-security", "Crash Recovery / Orphan GC / Path Security / Restart");
const f = await createResourceFixture();
try {
  // path security（纯函数）
  p.assert("contentInternalKey 只接受 SHA-256", resourceDomain.contentInternalKey("ab".repeat(32)) === "objects/sha256/ab/" + "ab".repeat(32) && resourceDomain.contentInternalKey("../../evil") === null, "");
  p.assert("resolveKey 拒绝 traversal", f.managedStore.resolveKey("../../etc/passwd") === null, "");
  const absKey = f.managedStore.resolveKey("/etc/passwd");
  p.assert("前导斜杠只归一化为 store 内相对 key", !!absKey && resourceDomain.isPathInside(f.storeRoot, absKey), "");

  // secret scan
  const san = resourceDomain.sanitizeMetadata({ name: "ok", apiKey: "FAKE", devicePrivateKey: "FAKE", sessionToken: "FAKE" });
  p.assert("metadata 过滤 forbidden keys", san.name === "ok" && san.apiKey === undefined && san.devicePrivateKey === undefined && san.sessionToken === undefined, JSON.stringify(san));

  // recovery：staging orphan（不删未知 objects 文件）
  const stagingDir = path.join(f.storeRoot, "staging");
  const orphan = path.join(stagingDir, "orphan.part");
  fs.writeFileSync(orphan, "orphan");
  const unknownObject = path.join(f.storeRoot, "objects", "not-ours.bin");
  fs.writeFileSync(unknownObject, "unknown");
  const rec = f.resourceService.recoverStartup();
  p.assert("staging orphan 被清理", !fs.existsSync(orphan) && rec.report.stagingOrphans.includes("orphan.part"), "");
  p.assert("不启动即删除未知文件", fs.existsSync(unknownObject), "");
  fs.rmSync(unknownObject, { force: true });

  // DB failure -> 可检测孤儿 -> GC
  const src = f.writeSource("orphan.txt", "orphan content");
  const original = f.resourceStore.insertRegistryResource.bind(f.resourceStore);
  let armed = true;
  f.resourceStore.insertRegistryResource = (...args) => {
    if (armed) {
      armed = false;
      throw new Error("injected");
    }
    return original(...args);
  };
  await f.resourceService.importManaged({ context: f.ctx("alice"), sourcePath: src, name: "Orphan" });
  f.resourceStore.insertRegistryResource = original;
  const orphans = f.resourceStore.orphanContentObjects();
  const recovered = f.resourceService.recoverStartup();
  p.assert("DB commit 失败留下可检测孤儿并 GC", orphans.length >= 1 && recovered.report.gc.length >= 1 && f.resourceStore.orphanContentObjects().length === 0, "orphans=" + orphans.length);
} finally {
  f.close();
}

// restart persistence
{
  const root = tempRoot("oa-d3-04a-probe-restart");
  const dbPath = path.join(root, "identity.db");
  await (async () => {
    const fx = await createResourceFixture({ dbPath, storeRoot: path.join(root, "library") });
    const ctx = fx.ctx("alice");
    const src = fx.writeSource("persist.txt", "persist content");
    const imp = await fx.resourceService.importManaged({ context: ctx, sourcePath: src, name: "Persist" });
    fx.identity.close();
    const reopened = reopenResourceRuntime({ dbPath, storeRoot: path.join(root, "library") });
    const login = await reopened.identity.login({ identifier: "alice@openarc.test", password: pw("alice") });
    const got = reopened.resourceService.get({ context: { sessionRef: login.session.ref, appId: "resource-library" }, resourceRef: imp.resource.resourceRef });
    const read = await reopened.resourceService.readText({ context: { sessionRef: login.session.ref, appId: "resource-library" }, resourceRef: imp.resource.resourceRef });
    p.assert("重启后 ResourceRef / content 一致", got.ok && read.ok && read.text === "persist content", got.error || "ok");
    reopened.identity.close();
  })();
  fs.rmSync(root, { recursive: true, force: true });
}

p.finish();
if (p.verdict() === "FAIL") process.exitCode = 1;
