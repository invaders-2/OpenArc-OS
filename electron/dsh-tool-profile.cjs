/**
 * D4-03C4 · official dsh 可见 Tool profile（Harness-visible allowlist）。
 *
 * READ_ONLY tools 与受控 WRITE proposal tools 的**唯一** allowlist。
 * 绝不出现 shell / terminal / filesystem / run_code / process / web / MCP /
 * browser automation / Device Agent。
 */
"use strict";

/**
 * 允许经 Tool Facade 暴露的 READ_ONLY tool。
 *
 * D5-01 Closure-2：`browser.read.page` 是**受控工具**，与下面 FORBIDDEN 里的 `browser`
 * 不是同一个东西 —— 后者禁的是 Harness 内置浏览器旁路，匹配方式是**精确字符串**，不是前缀通配。
 */
const READ_TOOL_IDS = Object.freeze(["resource.search", "resource.read.metadata", "browser.read.page", "canvas.read"]);
/**
 * 唯一允许进入 SIDE_EFFECT_PROPOSAL route 的 tool；由 Registry 的 riskClass + executionPolicy 二次确认。
 *
 * D5-02 Full-App：加入 `canvas.edit`（REVERSIBLE_WRITE + CONTROLLED_REVERSIBLE_WRITE）。
 * 没有它时，模型即使提议 canvas_edit 也会被 capability 挡在桥外 —— "AI 编辑画布"整条链断在广播面。
 */
const WRITE_TOOL_IDS = Object.freeze(["resource.trash", "browser.navigate", "canvas.edit"]);
const HARNESS_VISIBLE_TOOL_IDS = Object.freeze([...READ_TOOL_IDS, ...WRITE_TOOL_IDS]);

/**
 * 永久禁止出现在 Harness 可见面的能力（安全回归用）。
 *
 * **作用范围（D5-01 Closure-2 逐处查清）**：本表只被用于"广播出去的 tool 名**精确等于**
 * 这些字符串"的否决断言（`advertised.includes(bad)`），因此：
 *   · 限制的是 **Harness 内置工具**（shell / 内置浏览器 / 任意脚本 / CDP 旁路）；
 *   · **不会**误拦受控工具 —— 受控工具的广播名是 `browser_read_page` / `browser_navigate`
 *     （点号→下划线），与 `browser` 不是同一个字符串。
 * 故**不新增前缀通配、不删除任何一项**；正反对照见 tests/d5-01-browser-control-surface.test.mjs。
 */
const FORBIDDEN_HARNESS_TOOLS = Object.freeze([
  "shell", "terminal", "filesystem", "run_code", "process", "web", "mcp",
  "browser", "device", "canvas", "adobe", "bash", "pwsh", "fs", "exit_plan_mode",
]);

module.exports = { READ_TOOL_IDS, WRITE_TOOL_IDS, HARNESS_VISIBLE_TOOL_IDS, FORBIDDEN_HARNESS_TOOLS };
