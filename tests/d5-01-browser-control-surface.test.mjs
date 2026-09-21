/**
 * D5-01 Closure-2 · 模型可见面裁决（正反对照）。
 *
 * 结论：`FORBIDDEN_HARNESS_TOOLS` 只限制 **Harness 内置工具**（精确字符串匹配），
 * 不会误拦受控工具；因此**不新增前缀通配、不删除任何一项**，只把两个受控工具
 * 加进 READ/WRITE allowlist。
 *
 * 正例：browser_read_page / browser_navigate 必须可用（在广播面里）。
 * 反例：内置 browser / shell / run_code / CDP 旁路等仍然不可用（不得出现在广播面）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { READ_TOOL_IDS, WRITE_TOOL_IDS, HARNESS_VISIBLE_TOOL_IDS, FORBIDDEN_HARNESS_TOOLS } = require("../electron/dsh-tool-profile.cjs");
const { ToolRegistry, buildBridgeManifest } = require("../electron/tool-registry.cjs");
const dshName = (toolId) => String(toolId).replace(/[^A-Za-z0-9]+/g, "_");

test("allowlist：两个受控浏览器工具在册；FORBIDDEN 表未被改动或通配", () => {
  assert.ok(READ_TOOL_IDS.includes("browser.read.page"), "受控读取必须在 READ allowlist");
  assert.ok(WRITE_TOOL_IDS.includes("browser.navigate"), "受控导航必须在 WRITE allowlist");
  assert.deepEqual(HARNESS_VISIBLE_TOOL_IDS.slice().sort(), [...READ_TOOL_IDS, ...WRITE_TOOL_IDS].sort());
  // 禁用表逐字保留（没有前缀通配、没有删项）
  assert.deepEqual(FORBIDDEN_HARNESS_TOOLS.slice().sort(), [...FORBIDDEN_HARNESS_TOOLS].sort(), "禁用表必须保持原样（下面才是逐字快照）");
  assert.deepEqual(
    FORBIDDEN_HARNESS_TOOLS.slice().sort(),
    ["shell", "terminal", "filesystem", "run_code", "process", "web", "mcp", "browser", "device", "canvas", "adobe", "bash", "pwsh", "fs", "exit_plan_mode"].sort(),
  );
  assert.equal(FORBIDDEN_HARNESS_TOOLS.some((f) => f.includes("*")), false, "禁用表不得使用通配");
});

test("正反对照：受控工具可用；内置浏览器 / 任意脚本旁路不可用", () => {
  const registry = new ToolRegistry();
  const manifest = buildBridgeManifest(registry, { readToolIds: READ_TOOL_IDS, writeToolIds: WRITE_TOOL_IDS });
  const advertised = manifest.toolIds.map(dshName);
  // 正例：两个受控工具都广播出去
  for (const id of ["browser.read.page", "browser.navigate"]) assert.ok(advertised.includes(dshName(id)), "必须广播 " + id);
  assert.equal(manifest.routes["browser.read.page"], "READ_ONLY");
  assert.equal(manifest.routes["browser.navigate"], "SIDE_EFFECT_PROPOSAL", "导航必须走副作用提案，绝不是只读");
  // 反例：内置旁路仍然不在广播面（精确名匹配，含裸 "browser"）
  for (const bad of FORBIDDEN_HARNESS_TOOLS) assert.ok(!advertised.includes(bad), "不得广播 " + bad);
  for (const bad of ["browser", "cdp", "web", "run_code", "shell", "eval", "script"]) assert.ok(!advertised.includes(bad), "旁路能力不得出现：" + bad);
});
