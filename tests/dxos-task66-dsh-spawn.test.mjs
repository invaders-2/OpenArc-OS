/** task-66 · DSH 子进程必须用运行时自带 Node，不依赖 PATH。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildDshSpawn } = require("../electron/harness-adapter.cjs");

test("buildDshSpawn：Electron 用 process.execPath + ELECTRON_RUN_AS_NODE；Node 不加该变量", () => {
  const electron = buildDshSpawn({
    bin: "/app/node_modules/.bin/dsh",
    args: ["--profile", "acp"],
    env: { PATH: "/usr/bin:/bin" },
    execPath: "/app/Contents/MacOS/Electron",
    versions: { electron: "44.3.0", node: "22.22.3" },
  });
  assert.equal(electron.command, "/app/Contents/MacOS/Electron");
  assert.deepEqual(electron.args, ["/app/node_modules/.bin/dsh", "--profile", "acp"]);
  assert.equal(electron.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(electron.env.PATH, "/usr/bin:/bin");
  assert.equal(electron.interpreter, "electron-node");

  const node = buildDshSpawn({
    bin: "/app/node_modules/.bin/dsh",
    args: ["--version"],
    env: { PATH: "/usr/bin:/bin" },
    execPath: "/usr/local/bin/node",
    versions: { node: "22.22.3" },
  });
  assert.equal(node.command, "/usr/local/bin/node");
  assert.deepEqual(node.args, ["/app/node_modules/.bin/dsh", "--version"]);
  assert.equal(Object.prototype.hasOwnProperty.call(node.env, "ELECTRON_RUN_AS_NODE"), false);
  assert.equal(node.interpreter, "node");

  const bundled = buildDshSpawn({
    bin: "/app/node_modules/.bin/dsh",
    args: ["--profile", "acp"],
    env: { PATH: "/usr/bin:/bin" },
    execPath: "/app/Contents/MacOS/Electron",
    versions: { electron: "44.3.0", node: "22.22.3" },
    nodeBin: "/app/node_modules/.bin/node",
  });
  assert.equal(bundled.command, "/app/node_modules/.bin/node");
  assert.deepEqual(bundled.args, ["/app/node_modules/.bin/dsh", "--profile", "acp"]);
  assert.equal(bundled.env.PATH, "/app/node_modules/.bin" + path.delimiter + "/usr/bin:/bin");
  assert.equal(Object.prototype.hasOwnProperty.call(bundled.env, "ELECTRON_RUN_AS_NODE"), false);
  assert.equal(bundled.interpreter, "bundled-node");
});

test("resolveDshNode：随包 .bin/node 存在则使用，缺失回退 null", () => {
  const { resolveDshNode } = require("../electron/harness-adapter.cjs");
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "oa-task66-runtime-"));
  try {
    assert.equal(resolveDshNode(runtime), null);
    const binDir = path.join(runtime, "node_modules", ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "node"), "#!fake", "utf8");
    assert.equal(resolveDshNode(runtime), path.join(binDir, "node"));
  } finally { fs.rmSync(runtime, { recursive: true, force: true }); }
});

test("最小 PATH 下用 execPath 直接跑无 shebang 的 JS bin 成功；不依赖 PATH 里的 node", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-task66-bin-"));
  const bin = path.join(dir, "fake-dsh.js");
  fs.writeFileSync(bin, "process.stdout.write('TASK66_OK');\n", "utf8");
  try {
    const invocation = buildDshSpawn({ bin, args: [], env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, execPath: process.execPath, versions: process.versions });
    const result = await new Promise((resolve) => {
      const child = spawn(invocation.command, invocation.args, { env: invocation.env, stdio: ["ignore", "pipe", "pipe"] });
      let out = ""; let err = "";
      child.stdout.on("data", (d) => { out += String(d); });
      child.stderr.on("data", (d) => { err += String(d); });
      child.on("exit", (code) => resolve({ code, out, err }));
    });
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out, "TASK66_OK");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
