/** D4-02B · Isolation probe：隔离 DSH_HOME、env scrub、provider secret 0 hit、workspace 不变、真实 ~/.dsh 不被触碰。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHarnessFixture, readTree, PROVIDER_SECRET } from "./fixtures/harness-acp/fixture.mjs";

const require = createRequire(import.meta.url);
const { buildHarnessEnv, buildAcpPatch, resolveDshBin, resolveDshRuntime } = require("../electron/harness-adapter.cjs");

const fx = await createHarnessFixture();
const state = { adapter: null, start: null, root: null, forbidden: null, workspace: null, hashBefore: null };
after(async () => { try { await state.adapter?.dispose(); } catch { /* ignore */ } await fx.close(); });

function hashOf(p) { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }
function realDshSnapshot() {
  const home = os.homedir();
  const d = path.join(home, ".dsh");
  if (!fs.existsSync(d)) return { exists: false };
  return { exists: true, entries: fs.readdirSync(d).sort(), mtimeMs: fs.statSync(d).mtimeMs };
}

test("D4-02B-I1 · buildHarnessEnv：显式 allowlist + secret scrub + capability", () => {
  const saved = {};
  const injected = ["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "SSH_AUTH_SOCK"];
  for (const k of injected) { saved[k] = process.env[k]; process.env[k] = "leak-" + k; }
  try {
    const env = buildHarnessEnv({ dshHome: "/tmp/x", bridgeBaseUrl: "http://127.0.0.1:1/v1", capability: "cap-token", workspace: "/tmp/x/ws" });
    for (const k of injected) assert.equal(k in env, false, "必须清除 " + k);
    assert.equal(env.OPENARC_MODEL_PROXY_CAPABILITY, "cap-token");
    assert.equal(env.DSH_HOME, "/tmp/x");
    assert.equal(env.DSH_PERMISSION_MODE, "read-only");
    // 只允许 allowlist + HOME/DSH/OPENARC 变量
    const allowed = new Set(["PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SHELL", "HOME", "DSH_HOME", "DSH_PERMISSION_MODE", "DSH_TELEMETRY_MODE", "OPENARC_HARNESS_BRIDGE", "OPENARC_MODEL_PROXY_CAPABILITY", "OPENARC_HARNESS_WORKSPACE"]);
    for (const k of Object.keys(env)) assert.ok(allowed.has(k), "env 不应包含 " + k);
  } finally { for (const k of injected) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
});

test("D4-02B-I2 · buildAcpPatch：工具/MCP/直连/retry 关闭，模型指向 OpenArc bridge", () => {
  const patch = buildAcpPatch();
  for (const id of ["tool-bash", "tool-fs", "tool-fs-search", "tool-web", "tool-subagent", "skill", "web", "llm-deepseek", "llm-retry"]) {
    assert.ok(new RegExp("- id: " + id + "\\n  disabled: true").test(patch), id + " 必须 disabled");
  }
  assert.ok(patch.includes("apiKeyEnv: OPENARC_MODEL_PROXY_CAPABILITY"));
  assert.ok(patch.includes("maxRetries: 0"));
  assert.ok(patch.includes("baseURL: !!js process.env.OPENARC_HARNESS_BRIDGE"));
  assert.equal(/mcp/i.test(patch), false);
});

test("D4-02B-I3 · 真实运行：isolated DSH_HOME、真实 ~/.dsh 不变、workspace 不变", async () => {
  const before = realDshSnapshot();
  state.adapter = fx.makeAdapter();
  const start = await state.adapter.start({ context: fx.ctx, modelConfigId: fx.modelConfigId, maxCalls: 4, ttlMs: 120000 });
  state.start = start;
  const workspace = start.workspace;
  state.workspace = workspace;
  const protectedPath = path.join(workspace, "protected.txt");
  fs.writeFileSync(protectedPath, "openarc protected content\n");
  state.hashBefore = hashOf(protectedPath);
  // workspace 之外放一枚 forbidden 文件
  state.forbidden = path.join(path.dirname(workspace), "OPENARC_HARNESS_FORBIDDEN_FILE.txt");
  fs.writeFileSync(state.forbidden, "forbidden\n");

  assert.notEqual(start.dshHome, path.join(os.homedir(), ".dsh"));
  assert.ok(start.dshHome.startsWith(os.tmpdir()), "DSH_HOME 必须是隔离临时目录");
  const r = await state.adapter.prompt("Return exactly: OPENARC_ACP_OK", { timeoutMs: 90000 });
  assert.equal(r.ok, true);
  await state.adapter.closeSession();

  assert.equal(hashOf(protectedPath), state.hashBefore, "workspace 文件不得被修改");
  assert.equal(fs.existsSync(state.forbidden), true, "workspace 外文件不得被删除");
  const after = realDshSnapshot();
  assert.deepEqual(after, before, "真实 ~/.dsh 不得被触碰");
  assert.equal(fs.existsSync(path.join(os.homedir(), ".dsh")) && fs.statSync(path.join(os.homedir(), ".dsh")).mtimeMs !== (before.exists ? before.mtimeMs : null), false);
});

test("D4-02B-I4 · DSH_HOME / workspace / stderr 无 Provider Secret；capability 不落盘", () => {
  const dshScan = readTree(state.start.dshHome);
  const wsScan = readTree(state.start.workspace);
  const cap = state.adapter.capability.token;
  for (const [name, scan] of [["DSH_HOME", dshScan], ["workspace", wsScan]]) {
    assert.equal(scan.text.includes(PROVIDER_SECRET), false, name + " 不得含 Provider Secret");
    assert.equal(scan.text.includes(cap), false, name + " 不得持久化完整 Proxy capability");
  }
  assert.equal(state.adapter.stderr.includes(PROVIDER_SECRET), false);
  assert.equal(state.adapter.stderr.includes(cap), false);
  // 本次 probe 没有 tool / permission
  assert.equal(state.adapter.permissions.length, 0);
  assert.equal(state.adapter.events.some((e) => e.type === "tool.proposed"), false);
});

test("D4-02B-I5 · dsh / SDK 版本来自冻结路径（PIN，不走用户 PATH）", () => {
  const runtime = resolveDshRuntime();
  const bin = resolveDshBin(runtime);
  assert.ok(bin && fs.existsSync(bin), "dsh 必须从冻结 runtime 路径解析");
  assert.ok(bin.includes(path.join("node_modules", ".bin", "dsh")));
  assert.equal(fx.adapterRuntime ?? true, true);
  assert.equal(state.start.dshVersion, "0.1.5-rc.2");
  assert.equal(state.start.sdkVersion, "1.4.0");
});
