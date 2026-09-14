/** D4-03A · Tool Registry 权威：id/version/schema/risk/disabled + 禁止注册 shell/mcp。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ToolRegistry, validateSchema, BUILTIN_CONTRACTS } = require("../electron/tool-registry.cjs");

const TOOL_FIELDS = ["toolId", "version", "displayName", "description", "inputSchema", "outputSchema", "riskClass", "sideEffect", "requiresApproval", "requiredPermissions", "resourceActions", "executionProvider", "enabled"];

test("known tool resolves；contract 字段完整且冻结风险语义", () => {
  const reg = new ToolRegistry();
  const r = reg.resolve("test.echo", 1);
  assert.equal(r.ok, true);
  for (const f of TOOL_FIELDS) assert.ok(Object.prototype.hasOwnProperty.call(r.contract, f), "missing field " + f);
  assert.equal(r.contract.riskClass, "READ_ONLY");
  assert.equal(r.contract.sideEffect, "NONE");
  assert.equal(r.contract.requiresApproval, false);
  assert.equal(Object.isFrozen(r.contract), true);
  const meta = reg.list().find((t) => t.toolId === "test.echo");
  assert.ok(meta);
});

test("unknown / injected toolId denied（含路径注入、shell、mcp）", () => {
  const reg = new ToolRegistry();
  assert.equal(reg.resolve("../../shell", 1).error, "TOOL_NOT_FOUND");
  assert.equal(reg.resolve("shell.exec", 1).error, "TOOL_NOT_FOUND");
  assert.equal(reg.resolve("terminal.run", 1).error, "TOOL_NOT_FOUND");
  assert.equal(reg.resolve("filesystem.write", 1).error, "TOOL_NOT_FOUND");
  assert.equal(reg.resolve("process.spawn", 1).error, "TOOL_NOT_FOUND");
  assert.equal(reg.resolve("mcp.*", 1).error, "TOOL_NOT_FOUND");
  for (const c of BUILTIN_CONTRACTS) assert.ok(!/shell|terminal|filesystem|process|mcp|browser/i.test(c.toolId), "禁止注册 " + c.toolId);
});

test("wrong version denied；disabled tool denied", () => {
  const reg = new ToolRegistry();
  assert.equal(reg.resolve("test.echo", 99).error, "TOOL_VERSION_UNSUPPORTED");
  assert.deepEqual(reg.resolve("test.echo", 99).supportedVersions, [1]);
  reg.register({ toolId: "test.disabled", version: 1, displayName: "d", description: "d", inputSchema: { type: "object", additionalProperties: false, properties: {} }, outputSchema: { type: "object" }, riskClass: "READ_ONLY", executionProvider: "test", enabled: false, requiredPermissions: [], resourceActions: [] });
  assert.equal(reg.resolve("test.disabled", 1).error, "TOOL_DISABLED");
});

test("schema validate：required / additionalProperties / pattern / 长度", () => {
  const reg = new ToolRegistry();
  const c = reg.get("test.echo", 1);
  assert.equal(reg.validateInput(c, { message: "hi" }).ok, true);
  assert.equal(reg.validateInput(c, {}).ok, false);
  assert.equal(reg.validateInput(c, { message: "hi", risk: "low" }).ok, false);
  assert.equal(reg.validateInput(c, { message: "" }).ok, false);
  assert.equal(reg.validateInput(c, { message: "x".repeat(300) }).ok, false);
  const rc = reg.get("resource.read.metadata", 1);
  assert.equal(reg.validateInput(rc, { resourceRef: "resource://res_abc" }).ok, true);
  assert.equal(reg.validateInput(rc, { resourceRef: "/Users/x/file.png" }).ok, false);
  assert.equal(reg.validateInput(rc, { path: "/etc/passwd", resourceRef: "resource://res_abc" }).ok, false);
  const v = validateSchema({ type: "object", additionalProperties: false, properties: { a: { type: "integer" } } }, { a: 1.5 });
  assert.equal(v.ok, false);
});

test("registry 只能 trusted code 管理：重复注册拒绝，Harness 不能改 contract", () => {
  const reg = new ToolRegistry();
  assert.throws(() => reg.register(reg.get("test.echo", 1)), /duplicate/);
  assert.throws(() => reg.register({ toolId: "../../shell", version: 1 }), /invalid toolId/);
  const before = reg.get("test.echo", 1);
  assert.equal(before.riskClass, "READ_ONLY");
  assert.throws(() => { before.riskClass = "DENIED"; }, TypeError);
});
