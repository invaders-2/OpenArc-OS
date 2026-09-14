/** D4-03B Closure · official dsh 加载 OpenArc 只读 Tool Plugin（managed openarc-acp profile）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { resolveDshBin, resolveDshRuntime, dshVersion } = require("../electron/harness-adapter.cjs");

const BUNDLE = path.join(import.meta.dirname, "..", "electron", "dsh-openarc-read-tools");
const MANIFEST_TOOLS = [
  { toolId: "resource.search", name: "resource_search", description: "Search authorized resources.", inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string", minLength: 1, maxLength: 200 }, limit: { type: "integer", minimum: 1, maximum: 20 } }, required: ["query"] }, outputSchema: { type: "object", additionalProperties: false, properties: { count: { type: "integer" }, items: { type: "array", items: { type: "object" } } }, required: ["count", "items"] } },
  { toolId: "resource.read.metadata", name: "resource_read_metadata", description: "Read safe metadata of one resource.", inputSchema: { type: "object", additionalProperties: false, properties: { resourceRef: { type: "string", pattern: "^resource://[A-Za-z0-9_-]+$" } }, required: ["resourceRef"] }, outputSchema: { type: "object", additionalProperties: false, properties: { resourceRef: { type: "string" }, name: { type: "string" } }, required: ["resourceRef", "name"] } },
];

function prepareProfile(root) {
  const dshHome = path.join(root, "dsh-home");
  const profileDir = path.join(dshHome, "profiles", "openarc-acp");
  fs.mkdirSync(path.join(profileDir, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(dshHome, "home"), { recursive: true });
  fs.cpSync(BUNDLE, path.join(profileDir, "node_modules", "dsh-openarc-read-tools"), { recursive: true });
  fs.writeFileSync(path.join(profileDir, "package.json"), JSON.stringify({ name: "dsh-profile-openarc-acp", private: true, dependencies: {}, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app", "dsh-openarc-read-tools"], patchReload: "startup" } } }, null, 2));
  fs.writeFileSync(path.join(profileDir, "cordis.patch.yml"), "[]\n");
  const manifestPath = path.join(root, "openarc-read-tools.manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ contractHash: "test", tools: MANIFEST_TOOLS }, null, 2));
  return { dshHome, manifestPath };
}

test("official dsh 0.1.5-rc.2 通过 official profile bundle 加载 OpenArc Tool Plugin 并注册 exactly 2 个 READ_ONLY tool", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-dsh-facade-"));
  try {
    const { dshHome, manifestPath } = prepareProfile(root);
    const bin = resolveDshBin(resolveDshRuntime());
    assert.ok(bin, "dsh bin resolved");
    assert.equal(dshVersion(resolveDshRuntime()), "0.1.5-rc.2");
    const env = {
      PATH: process.env.PATH, HOME: path.join(dshHome, "home"), DSH_HOME: dshHome,
      DSH_TELEMETRY_MODE: "DISABLED", DSH_PERMISSION_MODE: "read-only",
      OPENARC_TOOL_FACADE_MANIFEST: manifestPath,
      OPENARC_TOOL_FACADE_URL: "http://127.0.0.1:9",
      OPENARC_TOOL_FACADE_CAPABILITY: "tfc_probe_token",
    };
    const child = spawn(bin, ["--profile", "openarc-acp"], { env, cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err += String(d); });
    child.stdout.on("data", () => {});
    const deadline = Date.now() + 25000;
    while (!err.includes("[openarc-read-tools] registered") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    child.kill("SIGKILL");
    await new Promise((r) => child.on("exit", r));
    assert.match(err, /\[openarc-read-tools\] registered resource_search,resource_read_metadata/, "official dsh did not register the OpenArc tools: " + err.slice(-400));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("OpenArc dsh plugin 不 import 业务模块（静态扫描）", () => {
  const src = fs.readFileSync(path.join(BUNDLE, "index.js"), "utf8");
  for (const bad of ["ResourceService", "resource-service", "search-service", "identity-store", "node:child_process", "better-sqlite3", "node:sqlite", "dsh-tools"]) {
    assert.ok(!src.includes(bad), "plugin 不得 import/引用 " + bad);
  }
});

test("空 manifest → 插件注册 0 个 tool（不伪造工具）", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-dsh-facade-"));
  try {
    const { dshHome, manifestPath } = prepareProfile(root);
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    m.contractHash = "expected-hash";
    m.tools = [];
    fs.writeFileSync(manifestPath, JSON.stringify(m));
    const bin = resolveDshBin(resolveDshRuntime());
    const env = { PATH: process.env.PATH, HOME: path.join(dshHome, "home"), DSH_HOME: dshHome, DSH_TELEMETRY_MODE: "DISABLED", OPENARC_TOOL_FACADE_MANIFEST: manifestPath, OPENARC_TOOL_FACADE_URL: "http://127.0.0.1:9", OPENARC_TOOL_FACADE_CAPABILITY: "t" };
    const child = spawn(bin, ["--profile", "openarc-acp"], { env, cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err += String(d); });
    const deadline = Date.now() + 25000;
    while (!err.includes("[openarc-read-tools] registered") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    child.kill("SIGKILL");
    await new Promise((r) => child.on("exit", r));
    assert.match(err, /\[openarc-read-tools\] registered ?\n/, "empty manifest → 0 tool registered: " + err.slice(-200));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
