/** D3-04A 探针 04 · Large streaming import 内存与耗时。 */
import fs from "node:fs";
import path from "node:path";
import { Probe, createResourceFixture } from "./lib.mjs";

const p = new Probe("04-large-streaming", "10MB / 100MB streaming import：内存与耗时");
const f = await createResourceFixture();
const ctx = f.ctx("alice");
try {
  for (const mb of [10, 100]) {
    const file = path.join(f.sourceDir, "large-" + mb + "mb.bin");
    const chunk = Buffer.alloc(1024 * 1024, 3);
    const fd = fs.openSync(file, "w");
    for (let i = 0; i < mb; i += 1) fs.writeSync(fd, chunk);
    fs.closeSync(fd);
    const before = process.memoryUsage();
    const t0 = Date.now();
    const imp = await f.resourceService.importManaged({ context: ctx, sourcePath: file, name: "Large " + mb + "MB", resourceType: "file" });
    const duration = Date.now() - t0;
    const after = process.memoryUsage();
    const externalDelta = after.external - before.external;
    p.assert(mb + "MB import 成功，size 正确", imp.ok && imp.resource.size === mb * 1024 * 1024, imp.error || "size=" + (imp.resource && imp.resource.size));
    p.assert(mb + "MB external 增量有界（不整文件读入）", externalDelta < Math.max(64 * 1024 * 1024, mb * 1024 * 1024 * 0.5), "duration=" + duration + "ms externalDelta=" + Math.round(externalDelta / 1024 / 1024) + "MB");
    p.note(mb + "MB duration=" + duration + "ms heapDelta=" + Math.round((after.heapUsed - before.heapUsed) / 1024 / 1024) + "MB externalDelta=" + Math.round(externalDelta / 1024 / 1024) + "MB");
  }
} finally {
  f.close();
}
p.finish();
if (p.verdict() === "FAIL") process.exitCode = 1;
