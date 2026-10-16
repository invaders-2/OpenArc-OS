/**
 * B4e 收口补丁 · 全局 MCP「工具调用」开关的权限收紧（真实链路离线单测）。
 *
 * 被测算的都是产品模块，测的就是产品跑的那条线：
 *   · electron/mcp-service.cjs    —— authorizeManage({ requireAdmin })：全局开关只允许 ADMIN（actor.isSuper）；
 *   · electron/mcp-bootstrap.cjs  —— mcp/toolInvocation/set 的 trusted + 授权 + 审计 + 唯一写入口；
 *   · electron/mcp-switch.cjs     —— <userData>/dxos/mcp.json 真实落盘；
 *   · electron/tool-store.cjs     —— insertToolAudit 写 authorization_audit（审计可查）。
 *
 * 口径：开关改变的是整个 MCP 域的调用能力 → MEMBER 写入必须被结构化拒绝（MCP_UNAUTHORIZED +
 * reason=manage-requires-admin），状态不变、0 落盘；ADMIN 写入成功且审计可查。
 * 全程离线：真实 IdentityStore + AuthorizationService + McpStore，不 spawn 进程、不联网。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createMcpFixture } from "./mcp-fixtures.mjs";

const require = createRequire(import.meta.url);
const { createMcpSwitch } = require("../electron/mcp-switch.cjs");
const { registerMcpIpc } = require("../electron/mcp-bootstrap.cjs");
const { ToolStore } = require("../electron/tool-store.cjs");

/** 用产品同一条 mcp:command 通道注册开关写命令；审计落真实 authorization_audit。 */
function attachSwitchIpc({ fx, sw, toolStore }) {
  const actorOf = { [fx.sessions.admin]: fx.users.admin, [fx.sessions.alice]: fx.users.alice, [fx.sessions.bob]: fx.users.bob };
  const handlers = new Map();
  registerMcpIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: () => {} },
    service: fx.mcpService,
    identity: fx.identityRef,
    isTrusted: () => true,
    toolInvocationSwitch: () => sw,
    audit: (entry) => {
      toolStore.insertToolAudit({
        at: Date.now(),
        actorUserId: actorOf[fx.identityRef.current] || null,
        appId: "mcp-center",
        toolRef: "mcp.toolInvocation",
        action: entry.action,
        decision: entry.decision,
        reasonCode: entry.reasonCode,
        requestId: entry.requestId,
      });
      return true;
    },
  });
  return (raw) => handlers.get("mcp:command")({}, raw);
}

test("全局开关：MEMBER 写入被拒（MCP_UNAUTHORIZED + reason + 状态不变 + 0 落盘），ADMIN 写入成功且审计可查", async () => {
  const fx = await createMcpFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-mcp-switch-authz-"));
  try {
    const sw = createMcpSwitch({ userDataDir: dir });
    const toolStore = new ToolStore({ identity: fx.identity, clock: fx.clock });
    const invoke = attachSwitchIpc({ fx, sw, toolStore });
    const auditRows = () => fx.identity.connection.prepare(
      "SELECT * FROM authorization_audit WHERE resource_ref = ? AND action = ? ORDER BY id",
    ).all("mcp.toolInvocation", "mcp.toolInvocation.set");

    // ── MEMBER（alice）：mcp-center 的 mcp.manage 对内置成员角色也成立，但全局开关必须管理员 ──
    assert.equal(path.dirname(sw.filePath), path.join(dir, "dxos"), "落盘路径 = <userData>/dxos/mcp.json");
    assert.equal(fs.existsSync(sw.filePath), false, "写入前不得有 mcp.json");
    fx.as("alice");
    const member = await invoke({ command: "mcp/toolInvocation/set", payload: { enabled: true, requestId: "req-member" } });
    assert.equal(member.ok, false, JSON.stringify(member));
    assert.equal(member.error, "MCP_UNAUTHORIZED");
    assert.equal(member.reason, "manage-requires-admin");
    assert.equal(sw.isToolInvocationEnabled(), false, "MEMBER 写入不得改变开关状态");
    assert.equal(fs.existsSync(sw.filePath), false, "MEMBER 写入必须 0 落盘");
    const deniedRows = auditRows();
    assert.equal(deniedRows.length, 1, JSON.stringify(deniedRows));
    assert.equal(deniedRows[0].decision, "DENY");
    assert.equal(deniedRows[0].reason_code, "manage-requires-admin", "拒绝原因必须留痕");
    assert.equal(deniedRows[0].actor_user_id, fx.users.alice, "审计必须记到真实 MEMBER 账号");
    assert.equal(deniedRows[0].request_id, "req-member");

    // ── ADMIN：同一命令同一载荷必须成功，且 REQUEST / ALLOW 两条审计都能查到 ──
    fx.as("admin");
    const admin = await invoke({ command: "mcp/toolInvocation/set", payload: { enabled: true, requestId: "req-admin" } });
    assert.equal(admin.ok, true, JSON.stringify(admin));
    assert.equal(admin.enabled, true);
    assert.equal(admin.persisted, true);
    assert.equal(admin.audited, true);
    assert.equal(sw.isToolInvocationEnabled(), true);
    assert.equal(JSON.parse(fs.readFileSync(sw.filePath, "utf8")).tools.invocationEnabled, true, "ADMIN 写入必须真实落盘");
    const rows = auditRows();
    const allow = rows.find((r) => r.decision === "ALLOW");
    const request = rows.find((r) => r.decision === "REQUEST");
    assert.ok(request, "写入前必须先落 REQUEST 审计：" + JSON.stringify(rows));
    assert.ok(allow, "写入成功必须落 ALLOW 审计：" + JSON.stringify(rows));
    assert.equal(allow.actor_user_id, fx.users.admin);
    assert.equal(allow.request_id, "req-admin");
    assert.equal(allow.app_id, "mcp-center");

    // ── 成员改回 false 同样被拒，状态保持不变（不是"只有打开要管理员"）──
    fx.as("alice");
    const memberOff = await invoke({ command: "mcp/toolInvocation/set", payload: { enabled: false } });
    assert.equal(memberOff.ok, false);
    assert.equal(memberOff.error, "MCP_UNAUTHORIZED");
    assert.equal(sw.isToolInvocationEnabled(), true, "MEMBER 关闭同样不得生效");
    assert.equal(JSON.parse(fs.readFileSync(sw.filePath, "utf8")).tools.invocationEnabled, true);
  } finally {
    await fx.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
