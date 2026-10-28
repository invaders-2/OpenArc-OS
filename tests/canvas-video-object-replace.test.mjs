import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const require = createRequire(import.meta.url), esbuild = require("esbuild");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(ROOT, "node_modules/.cache/oa-video-object-replace-" + process.pid + ".mjs");
await esbuild.build({ entryPoints: [path.join(ROOT, "src/canvas/canvas-next/engine.ts")], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" });
const { rolesFor } = await import(pathToFileURL(out).href);
test.after(() => fs.rmSync(out, { force: true }));

const source = { node: { id: "v1", kind: "video" }, edge: { id: "e-video" }, order: 0 };
const reference = { node: { id: "i1", kind: "image" }, edge: { id: "e-image" }, order: 1 };
const model = { maxRefs: 4, modes: ["视频编辑"] };

test("对象替换：源视频和替换参考图都进入请求", () => {
  const { roles, ignored } = rolesFor("video", { mode: "视频编辑" }, model, [source, reference]);
  assert.equal(roles.get("e-video"), "source_video");
  assert.equal(roles.get("e-image"), "reference");
  assert.equal(ignored.size, 0);
});

test("对象替换入口：只在支持视频编辑的模型出现，并带连续性提示", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/canvas/canvas-next/ui/GenPanel.tsx"), "utf8");
  assert.match(source, /data-p="object-replace"/);
  assert.match(source, /m\?\.modes\?\.includes\("视频编辑"\)/);
  assert.match(source, /保持其他人物、背景、光照、镜头运动和场景连续性不变/);
});
