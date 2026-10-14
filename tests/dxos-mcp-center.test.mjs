/**
 * UI-2b · MCP 中心“只调后端命令”契约单测（纯逻辑，不启动浏览器、不依赖 DOM 渲染库）。
 *
 * 测的是界面真正在用的两份规则：
 *   · src/mcp/mcpCenterLogic.ts —— mcp/agentTools 的字段投影、白名单、提示文案；
 *   · src/mcp/McpCenter.tsx   —— 渲染层的源码边界（**不再自算聚合规则**）。
 *
 * 为什么这条边界要单独锁：
 *   UI-2 的聚合（命名空间 mcp__<server>__<tool>、已连接判定、参数摘要）在渲染层抄了
 *   electron/mcp-agent-tools.cjs 的第二套实现；只要两处各写一份，后端改规则时界面不会跟着变。
 *   现在界面只发 mcp/agentTools，字段全部由主进程给出；参数文案的三种形态由后端
 *   electron/mcp-tool-contract.cjs#paramSummaryText 唯一实现，本测把它逐字锁成回归锚点。
 *
 * 离线、不联网。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
  AGENT_TOOL_RISK_LABEL,
  AGENT_TOOLS_BOUNDARY,
  AGENT_TOOLS_DISABLED_TEXT,
  MCP_AGENT_TOOLS_COMMAND,
  MCP_AGENT_TOOLS_QUERY_KEYS,
  MCP_CONSOLE_COMMANDS,
  MCP_TOOL_DISCOVERY_FAILED,
  MCP_TOOL_PARAM_EMPTY_TEXT,
  MCP_TOOL_RISK_EXTERNAL_SIDE_EFFECT,
  agentToolApprovalText,
  agentToolParamText,
  agentToolRiskText,
  agentToolsDetailText,
  agentToolsEmptyText,
  agentToolsInvocationText,
  agentToolsQuery,
  isAllowedAgentToolsQueryKey,
  isAllowedMcpCommand,
  normalizeAgentToolsResult,
} from "../src/mcp/mcpCenterLogic.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const require = createRequire(import.meta.url);
const bootstrap = require(path.join(ROOT, "electron", "mcp-bootstrap.cjs"));
const toolContract = require(path.join(ROOT, "electron", "mcp-tool-contract.cjs"));

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");

/* ══════════════════════════════════════════════════════════════════════════
   1 命令白名单与载荷键
   ══════════════════════════════════════════════════════════════════════════ */
test("界面白名单是后端 MCP_COMMANDS 的子集，且只新增 mcp/agentTools", () => {
  const backend = bootstrap.MCP_COMMANDS;
  assert.equal(MCP_CONSOLE_COMMANDS.length, 4);
  for (const c of MCP_CONSOLE_COMMANDS) assert.ok(backend.includes(c), c + " 必须是后端白名单命令");
  assert.equal(MCP_CONSOLE_COMMANDS.includes(MCP_AGENT_TOOLS_COMMAND), true);
  assert.equal(MCP_AGENT_TOOLS_COMMAND, "mcp/agentTools");
  assert.equal(isAllowedMcpCommand("mcp/agentTools"), true);
  for (const bad of ["", "mcp/toolCall", "mcp/invoke", "MCP/LIST", "mcp/list ", "__proto__", undefined, 42]) {
    assert.equal(isAllowedMcpCommand(bad), false, JSON.stringify(bad) + " 必须被拒绝");
  }
});

test("mcp/agentTools 载荷只允许 serverId / search", () => {
  assert.deepEqual([...MCP_AGENT_TOOLS_QUERY_KEYS], ["serverId", "search"]);
  assert.deepEqual(agentToolsQuery(), {});
  assert.deepEqual(agentToolsQuery(null), {});
  assert.deepEqual(agentToolsQuery("  "), {});
  assert.deepEqual(agentToolsQuery("conn_1"), { serverId: "conn_1" });
  assert.deepEqual(agentToolsQuery("conn_1", true), { serverId: "conn_1", search: true });
  /* 身份字段从来不是白名单键：即使被塞进参数也不会进上行对象。 */
  assert.deepEqual(agentToolsQuery("conn_1", false), { serverId: "conn_1" });
  assert.equal(isAllowedAgentToolsQueryKey("serverId"), true);
  assert.equal(isAllowedAgentToolsQueryKey("userId"), false);
  assert.equal(isAllowedAgentToolsQueryKey("appId"), false);
});

/* ══════════════════════════════════════════════════════════════════════════
   2 回包投影：字段契约 + 丢弃不完整行
   ══════════════════════════════════════════════════════════════════════════ */
test("normalizeAgentToolsResult 只投影契约字段，不新增也不重算", () => {
  const view = normalizeAgentToolsResult({
    ok: true,
    enabled: false,
    count: 1,
    connectedServers: 2,
    truncated: false,
    tools: [
      {
        fname: "mcp__conn_local__echo",
        serverId: "conn_local",
        serverName: "本机回显",
        toolName: "echo",
        status: "READY",
        description: "回显输入文本",
        paramText: "type=object; properties: text:string(required)",
        riskClass: "EXTERNAL_SIDE_EFFECT",
        requiresApproval: true,
      },
    ],
  });
  assert.equal(view.ok, true);
  assert.equal(view.enabled, false);
  assert.equal(view.count, 1);
  assert.equal(view.connectedServers, 2);
  assert.equal(view.truncated, false);
  assert.equal(view.invalidRows, 0);
  assert.equal(view.tools.length, 1);
  assert.deepEqual(view.tools[0], {
    fname: "mcp__conn_local__echo",
    serverId: "conn_local",
    serverName: "本机回显",
    toolName: "echo",
    status: "READY",
    description: "回显输入文本",
    paramText: "type=object; properties: text:string(required)",
    riskClass: "EXTERNAL_SIDE_EFFECT",
    requiresApproval: true,
  });
  assert.equal(MCP_TOOL_RISK_EXTERNAL_SIDE_EFFECT, "EXTERNAL_SIDE_EFFECT");
});

test("缺 fname / 非对象的工具行被丢弃并计数，不拿空数组冒充“没有工具”", () => {
  const view = normalizeAgentToolsResult({
    ok: true,
    count: 3,
    tools: [{ fname: "mcp__a__x", serverId: "a" }, null, "x", { serverId: "b" }],
  });
  assert.equal(view.tools.length, 1);
  assert.equal(view.invalidRows, 3);
  assert.equal(view.tools[0].toolName, "");
  assert.equal(view.tools[0].requiresApproval, false);
});

test("失败回包（MCP_TOOL_DISCOVERY_FAILED）结构化保留 error/detail，不假装成功", () => {
  const view = normalizeAgentToolsResult({
    ok: false,
    error: "MCP_TOOL_DISCOVERY_FAILED",
    detail: "mcp-agent-tools-unavailable",
    tools: [],
    count: 0,
    connectedServers: 0,
    enabled: false,
    truncated: false,
  });
  assert.equal(view.ok, false);
  assert.equal(view.error, MCP_TOOL_DISCOVERY_FAILED);
  assert.equal(view.detail, "mcp-agent-tools-unavailable");
  assert.equal(view.tools.length, 0);
  assert.equal(agentToolsDetailText(view), "mcp-agent-tools-unavailable");
  const empty = normalizeAgentToolsResult(null);
  assert.equal(empty.ok, false);
  assert.equal(empty.error, null);
  assert.equal(agentToolsDetailText(empty), "主进程没有给出更多说明。");
});

test("count 取回包自报值；缺失时才退回实际行数", () => {
  assert.equal(normalizeAgentToolsResult({ ok: true, count: 7, tools: [] }).count, 7);
  assert.equal(normalizeAgentToolsResult({ ok: true, tools: [{ fname: "f" }] }).count, 1);
  assert.equal(normalizeAgentToolsResult({ ok: true, count: "x" }).count, 0);
});

/* ══════════════════════════════════════════════════════════════════════════
   3 参数文案：三种形态逐字沿用旧派生（回归锚点）
   ══════════════════════════════════════════════════════════════════════════ */
test("三种参数文案与 UI-2 旧派生逐字一致（唯一实现现在在后端）", () => {
  /* 旧派生（已删除）的三种输出：空串 / 空对象 / 原文。 */
  const LEGACY_EMPTY = "未返回参数摘要（服务端未提供 inputSchema）";
  const LEGACY_NONE = "type=object; properties: none（参数为空对象）";
  const LEGACY_TEXT = "type=object; properties: text:string(required)";
  assert.equal(toolContract.paramSummaryText(undefined), LEGACY_EMPTY);
  assert.equal(toolContract.paramSummaryText(""), LEGACY_EMPTY);
  assert.equal(toolContract.paramSummaryText("type=object; properties: none"), LEGACY_NONE);
  assert.equal(toolContract.paramSummaryText(LEGACY_TEXT), LEGACY_TEXT);
  /* 渲染层只做“空值兜底”，兜底文案也逐字等于旧派生。 */
  assert.equal(MCP_TOOL_PARAM_EMPTY_TEXT, LEGACY_EMPTY);
  assert.equal(agentToolParamText(LEGACY_TEXT), LEGACY_TEXT);
  assert.equal(agentToolParamText(undefined), LEGACY_EMPTY);
});

/* ══════════════════════════════════════════════════════════════════════════
   4 风险 / 审批 / 开关提示
   ══════════════════════════════════════════════════════════════════════════ */
test("风险与审批照后端字段显示，不自己推断", () => {
  assert.equal(AGENT_TOOL_RISK_LABEL.EXTERNAL_SIDE_EFFECT, "外部副作用 EXTERNAL_SIDE_EFFECT");
  assert.ok(agentToolRiskText("EXTERNAL_SIDE_EFFECT").includes("EXTERNAL_SIDE_EFFECT"));
  assert.equal(agentToolRiskText("SOMETHING_NEW"), "SOMETHING_NEW（未登记风险等级）");
  assert.equal(agentToolRiskText(""), "风险等级未标注");
  assert.equal(agentToolApprovalText(true), "调用需逐次审批");
  assert.equal(agentToolApprovalText(false), "无需审批");
  assert.equal(agentToolApprovalText(undefined), "审批要求未标注");
});

test("enabled=false 明确提示“工具调用默认关闭”，并说明调用走审批", () => {
  const off = agentToolsInvocationText(false);
  assert.equal(off, AGENT_TOOLS_DISABLED_TEXT);
  assert.ok(off.includes("工具调用默认关闭"));
  assert.ok(off.includes("审批"));
  assert.ok(agentToolsInvocationText(true).includes("审批"));
  assert.ok(agentToolsInvocationText(undefined).includes("未返回"));
  assert.ok(AGENT_TOOLS_BOUNDARY.includes("不提供"));
  assert.ok(AGENT_TOOLS_BOUNDARY.includes("审批"));
});

test("空态文案按已连接服务数区分，不把“没有连接”说成“没有工具”", () => {
  assert.ok(agentToolsEmptyText(0).includes("还没有已连接"));
  assert.ok(agentToolsEmptyText(2).includes("还没有工具快照"));
});

/* ══════════════════════════════════════════════════════════════════════════
   5 源码边界：渲染层不再自算聚合规则
   ══════════════════════════════════════════════════════════════════════════ */
test("McpCenter.tsx 不再有本地聚合函数（源码级断言）", () => {
  const code = stripComments(read("src/mcp/McpCenter.tsx"));
  for (const name of ["aggregateToolsOf", "safeName", "isConnectedStatus", "paramSummaryText", "connectedServerCount", "AggregatedTool"]) {
    assert.equal(code.includes(name), false, "不得再出现本地聚合派生：" + name);
  }
  /* 命名空间拼装与“已连接”正则也不得留在渲染层：那是 B4 的规则。 */
  assert.equal(/mcp__/.test(code), false, "渲染层不得自己拼 mcp__<server>__<tool>");
  assert.equal(/properties:\s*none/.test(code), false, "渲染层不得自己算参数文案");
  assert.equal(code.includes('"connected"'), false, "渲染层不得自己判定已连接状态");
});

test("McpCenter.tsx 经 mcpCenterLogic 只发 mcp/agentTools", () => {
  const code = stripComments(read("src/mcp/McpCenter.tsx"));
  assert.ok(code.includes("MCP_AGENT_TOOLS_COMMAND"), "必须使用登记的命令常量");
  assert.ok(code.includes("loadAgentTools"), "必须有独立的聚合加载动作");
  assert.ok(code.includes('from "./mcpCenterLogic"'), "投影规则必须来自纯逻辑层");
  assert.equal(MCP_CONSOLE_COMMANDS.includes(MCP_AGENT_TOOLS_COMMAND), true);
  /* 界面不再从 mcp/list 的连接记录派生聚合。 */
  assert.equal(code.includes("toolsRawOf(c)"), true, "mcp/list 的工具快照仍用于详情表");
});

test("mcpCenterLogic.ts 本身也不重算参数文案 / 命名空间", () => {
  const code = stripComments(read("src/mcp/mcpCenterLogic.ts"));
  assert.equal(code.includes("aggregateToolsOf"), false);
  assert.equal(code.includes("paramSummaryText"), false);
  assert.equal(/mcp__/.test(code), false);
  assert.equal(/properties:\s*none/.test(code), false);
});

test("界面源码不联网、不写 localStorage、不直连本机端口、不发身份字段", () => {
  for (const rel of ["src/mcp/McpCenter.tsx", "src/mcp/mcpCenterLogic.ts"]) {
    /* 输入框的 placeholder="https://" 是提示文本，不是请求地址；扫描前先规整掉。 */
    const code = stripComments(read(rel)).replace(/placeholder="https:\/\/"/g, 'placeholder=""');
    assert.equal(/\bfetch\s*\(/.test(code), false, rel + " 不得调用 fetch");
    assert.equal(/XMLHttpRequest|WebSocket|EventSource/.test(code), false, rel + " 不得使用网络对象");
    assert.equal(/localStorage|sessionStorage/.test(code), false, rel + " 不得写 localStorage/sessionStorage");
    assert.equal(/https?:\/\/|127\.0\.0\.1|localhost/.test(code), false, rel + " 不得直连本机端口或外网地址");
    assert.equal(/document\.cookie/.test(code), false, rel + " 不得读 cookie");
    /* role 是组件属性（渲染权限），不是上行身份字段；这里只查真正会被送出的三个。 */
    for (const key of ["userId", "sessionRef", "appId"]) {
      assert.equal(code.includes(key), false, rel + " 不得出现身份字段 " + key);
    }
  }
});

test("界面只经 window.openarc.mcp 取数据，不越域", () => {
  const code = stripComments(read("src/mcp/McpCenter.tsx"));
  assert.ok(code.includes("openarc") && code.includes(".mcp"), "必须通过 window.openarc.mcp");
  assert.equal(/openarc\s*\.\s*(agent|model|skill|identity|task)\b/.test(code), false, "不得越域取数据");
});
