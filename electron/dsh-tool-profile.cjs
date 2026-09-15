/**
 * D4-03C4 · official dsh 可见 Tool profile（Harness-visible allowlist）。
 *
 * READ_ONLY tools 与受控 WRITE proposal tools 的**唯一** allowlist。
 * 绝不出现 shell / terminal / filesystem / run_code / process / web / MCP /
 * browser automation / Device Agent。
 */
"use strict";

const READ_TOOL_IDS = Object.freeze(["resource.search", "resource.read.metadata"]);
/** 唯一允许进入 SIDE_EFFECT_PROPOSAL route 的 tool；由 Registry 的 riskClass + executionPolicy 二次确认。 */
const WRITE_TOOL_IDS = Object.freeze(["resource.trash"]);
const HARNESS_VISIBLE_TOOL_IDS = Object.freeze([...READ_TOOL_IDS, ...WRITE_TOOL_IDS]);

/** 永久禁止出现在 Harness 可见面的能力（安全回归用）。 */
const FORBIDDEN_HARNESS_TOOLS = Object.freeze([
  "shell", "terminal", "filesystem", "run_code", "process", "web", "mcp",
  "browser", "device", "canvas", "adobe", "bash", "pwsh", "fs", "exit_plan_mode",
]);

module.exports = { READ_TOOL_IDS, WRITE_TOOL_IDS, HARNESS_VISIBLE_TOOL_IDS, FORBIDDEN_HARNESS_TOOLS };
