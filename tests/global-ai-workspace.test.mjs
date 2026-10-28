/** 全局 AI 第 2 期：工作文件夹（读 / 写 / 运行命令）与技能目录。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";
const require = createRequire(import.meta.url);
const { createAgentWorkspace, createWorkspaceProvider } = require("../electron/agent-workspace.cjs");
const { createSkillCatalog, createSkillCatalogProvider } = require("../electron/agent-skill-catalog.cjs");
const { ToolRegistry, buildBridgeManifest } = require("../electron/tool-registry.cjs");
const { READ_TOOL_IDS, WRITE_TOOL_IDS } = require("../electron/dsh-tool-profile.cjs");
const { buildAgentNotes, buildPrompt } = require("../electron/task-harness-orchestrator.cjs");

const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "oa-ws-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms, what) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(25); } assert.fail("超时：" + what); };

test("工作文件夹：列 / 读 / 搜都限在文件夹内，越界和内部目录一律拒绝", () => {
  const root = tmp();
  const outside = tmp();
  try {
    const ws = createAgentWorkspace({ root });
    fs.mkdirSync(path.join(root, "notes"));
    fs.writeFileSync(path.join(root, "notes", "a.md"), "hello\nOpenArc rocks\n");
    fs.writeFileSync(path.join(outside, "secret.txt"), "nope");
    fs.symlinkSync(outside, path.join(root, "escape"));
    const listed = ws.list({ path: ".", depth: 2 });
    assert.ok(listed.entries.some((e) => e.path === "notes/a.md" && e.type === "file"));
    assert.equal(ws.read({ path: "notes/a.md" }).text, "hello\nOpenArc rocks\n");
    const found = ws.search({ query: "openarc" });
    assert.deepEqual(found.results.map((r) => [r.path, r.line]), [["notes/a.md", 2]]);
    for (const bad of ["../x", "/etc/passwd", "escape/secret.txt", "notes/../../x"]) {
      assert.throws(() => ws.read({ path: bad }), /WORKSPACE_PATH_(OUTSIDE|INVALID)/, bad);
    }
    assert.throws(() => ws.snapshot(".openarc/x"), /WORKSPACE_PATH_RESERVED/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test("工作文件夹写入：只写批准时的正文；现状变了就不写；覆盖前备份；恢复核查按哈希三态", async () => {
  const root = tmp();
  try {
    const ws = createAgentWorkspace({ root });
    const p = createWorkspaceProvider({ workspace: ws });
    const contract = { toolId: "workspace.write" };
    fs.writeFileSync(path.join(root, "a.txt"), "old");
    const plan = await p.plan({ args: { path: "a.txt", content: "new" }, contract });
    assert.equal(plan.preconditions.expectedHash, sha("old"));
    assert.equal(plan.expectedEffects[0].action, "overwrite");
    // 批准后用户自己改了文件 → 不写
    fs.writeFileSync(path.join(root, "a.txt"), "changed");
    const stale = await p.execute({ contract, preconditions: plan.preconditions, callId: "c1" });
    assert.equal(stale.ok, false); assert.equal(stale.knownNoEffect, true);
    assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "changed");
    const plan2 = await p.plan({ args: { path: "a.txt", content: "new" }, contract });
    assert.equal((await p.recoveryVerify({ call: { toolId: "workspace.write" }, preconditions: plan2.preconditions })).outcome, "NOT_APPLIED");
    const done = await p.execute({ contract, preconditions: plan2.preconditions, callId: "c2" });
    assert.equal(done.ok, true);
    assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "new");
    assert.equal(fs.readFileSync(path.join(root, done.result.backup), "utf8"), "changed");
    assert.equal((await p.verify({ contract, preconditions: plan2.preconditions, result: done.result })).applied, true);
    assert.equal((await p.recoveryVerify({ call: { toolId: "workspace.write" }, preconditions: plan2.preconditions })).outcome, "APPLIED");
    // 新建嵌套文件
    const plan3 = await p.plan({ args: { path: "deep/dir/b.md", content: "# hi" }, contract });
    assert.equal(plan3.preconditions.expectedHash, "absent");
    assert.equal((await p.execute({ contract, preconditions: plan3.preconditions, callId: "c3" })).ok, true);
    assert.equal(fs.readFileSync(path.join(root, "deep/dir/b.md"), "utf8"), "# hi");
    // 篡改过的正文（哈希不符）→ 不写
    const forged = await p.execute({ contract, preconditions: { ...plan3.preconditions, content: "evil" }, callId: "c4" });
    assert.equal(forged.knownNoEffect, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("工作文件夹运行命令：在文件夹里执行、返回退出码和输出、超时会被杀掉、去掉疑似密钥的环境变量", { skip: process.platform === "win32" }, async () => {
  const root = tmp();
  try {
    process.env.OPENARC_TEST_SECRET_TOKEN = "should-not-leak";
    const ws = createAgentWorkspace({ root });
    const p = createWorkspaceProvider({ workspace: ws });
    const contract = { toolId: "workspace.exec" };
    const plan = await p.plan({ args: { script: "pwd; echo out; echo err 1>&2; echo ${OPENARC_TEST_SECRET_TOKEN:-none}; exit 3" }, contract });
    const res = await p.execute({ contract, preconditions: plan.preconditions, callId: "e1" });
    assert.equal(res.ok, true);
    assert.equal(res.result.exitCode, 3);
    assert.match(res.result.stdout, new RegExp(fs.realpathSync(root).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(res.result.stdout, /out\nnone/);
    assert.match(res.result.stderr, /err/);
    assert.equal((await p.verify({ contract, preconditions: plan.preconditions, result: res.result })).ok, true);
    const slow = await p.plan({ args: { script: "sleep 5", timeoutSec: 1 }, contract });
    const t0 = Date.now();
    const killed = await p.execute({ contract, preconditions: slow.preconditions, callId: "e2" });
    assert.equal(killed.result.timedOut, true);
    assert.ok(Date.now() - t0 < 4000);
    assert.equal((await p.recoveryVerify({ call: { toolId: "workspace.exec" }, preconditions: plan.preconditions })).outcome, "INDETERMINATE");
  } finally { delete process.env.OPENARC_TEST_SECRET_TOKEN; fs.rmSync(root, { recursive: true, force: true }); }
});

test("技能目录：只给启用、可见、不是系统能力的技能；能读说明和附带文件", async () => {
  const skills = [
    { id: "copy", name: "文案", description: "写营销文案", enabled: true, layer: "preset", origin: "official", builtin: true, systemPrompt: "Write crisp copy." },
    { id: "mine", name: "我的流程", description: "周报", enabled: true, layer: "workflow", origin: "imported", ownerUserId: "u1", source: { instructions: "# Weekly\nUse template.md", files: [{ path: "template.md", content: "## Template" }] } },
    { id: "other", name: "别人的", description: "x", enabled: true, layer: "workflow", origin: "imported", ownerUserId: "u2", source: { instructions: "no" } },
    { id: "off", name: "关掉的", description: "x", enabled: false, layer: "preset", origin: "official", builtin: true, systemPrompt: "no" },
    { id: "img", name: "生图", description: "x", enabled: true, layer: "capability", origin: "system", builtin: true },
  ];
  const catalog = createSkillCatalog({ listSkills: () => skills });
  assert.deepEqual(catalog.list({ userId: "u1" }).skills.map((s) => s.id), ["copy", "mine"]);
  assert.match(catalog.promptCatalog({ userId: "u1" }), /我的流程 \(id: mine\): 周报/);
  const loaded = catalog.load({ userId: "u1", skillId: "mine" });
  assert.match(loaded.instructions, /Weekly/);
  assert.deepEqual(loaded.files, [{ path: "template.md", chars: 11 }]);
  assert.equal(catalog.load({ userId: "u1", skillId: "mine", file: "template.md" }).content, "## Template");
  assert.throws(() => catalog.load({ userId: "u1", skillId: "other" }), /SKILL_NOT_FOUND/);
  const provider = createSkillCatalogProvider({ catalog });
  const r = await provider.execute({ context: { actorUserId: "u1" }, args: { skillId: "copy" }, contract: { toolId: "skill.load" } });
  assert.equal(r.ok, true); assert.equal(r.result.instructions, "Write crisp copy.");
});

test("新工具进了 dsh 可见清单：读工具走只读路径，写文件 / 运行命令走审批提议路径", () => {
  const registry = new ToolRegistry();
  for (const id of ["skill.list", "skill.load", "workspace.list", "workspace.read", "workspace.search"]) assert.ok(READ_TOOL_IDS.includes(id), id);
  for (const id of ["workspace.write", "workspace.exec"]) assert.ok(WRITE_TOOL_IDS.includes(id), id);
  const m = buildBridgeManifest(registry, { readToolIds: READ_TOOL_IDS, writeToolIds: WRITE_TOOL_IDS });
  assert.equal(m.routes["workspace.read"], "READ_ONLY");
  assert.equal(m.routes["workspace.exec"], "SIDE_EFFECT_PROPOSAL");
  assert.equal(m.routes["workspace.write"], "SIDE_EFFECT_PROPOSAL");
  assert.ok(m.tools.some((t) => t.name === "workspace_exec"));
  assert.equal(registry.get("workspace.exec", 1).requiresApproval, true);
  const notes = buildAgentNotes({ workspace: true, skillCatalog: "- A (id: a): b" });
  assert.match(notes, /workspace_exec/); assert.match(notes, /id: a/);
  const prompt = buildPrompt({ goal: "g", toolsEnabled: true, agentNotes: notes });
  assert.doesNotMatch(prompt, /Never assume shell or filesystem access/);
  assert.match(buildPrompt({ goal: "g", toolsEnabled: true }), /Never assume shell or filesystem access/);
});

test("真实 dsh：读文件直接执行；写文件先审批，批准后写入，结果交回模型", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "input.txt"), "OPENARC_INPUT_MARKER");
  const ws = createAgentWorkspace({ root });
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", workspace: ws, sideEffectApprovalWaitMs: 60000, facadeMaxCalls: 8 });
  try {
    fx.grantTool("ai", ["tool.workspace.read", "tool.workspace.write"]);
    fx.fp.state.toolLoopPlan = [
      { id: "call_ws_read", name: "workspace_read", args: { path: "input.txt" } },
      { id: "call_ws_write", name: "workspace_write", args: { path: "out/result.md", content: "# Result\nOPENARC_WRITTEN" } },
    ];
    const orch = fx.makeDshOrchestrator({ memoryContext: null, workspaceTools: true });
    const t = fx.createTask("read then write");
    const p = orch.runTask({ context: fx.ctx(), taskId: t.task.taskId, expectedRevision: t.task.revision });
    await waitFor(() => fx.sideEffectStore.callsOfTask(t.task.taskId).length === 1, 60000, "写入审批");
    const call = fx.sideEffectStore.callsOfTask(t.task.taskId)[0];
    assert.equal(call.toolId, "workspace.write");
    assert.equal(fs.existsSync(path.join(root, "out/result.md")), false, "批准前不写");
    const snap = fx.sideEffectRuntime.approvalSnapshot ? fx.sideEffectRuntime.approvalSnapshot({ approvalRequestId: call.callId }) : null;
    if (snap) { assert.match(snap.targetDisplayName, /工作文件夹 · out\/result.md（新建）/); assert.match(snap.contentPreview, /OPENARC_WRITTEN/); }
    assert.equal(fx.sideEffectRuntime.decideApproval({ context: { sessionRef: fx.f.sessions.admin, source: "user" }, approvalRequestId: call.callId, decision: "APPROVE" }).ok, true);
    const r = await p;
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(fs.readFileSync(path.join(root, "out/result.md"), "utf8"), "# Result\nOPENARC_WRITTEN");
    const bodies = fx.fp.state.toolLoopBodies.join("\n");
    assert.match(bodies, /OPENARC_INPUT_MARKER/, "读到的文件内容交给了模型");
    assert.match(bodies, /out\/result.md/, "写入结果交回模型");
    assert.match(bodies, /workspace_exec/, "首轮提示说明了工作文件夹");
  } finally { await fx.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
