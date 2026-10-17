"use strict";
/**
 * task-34 F14/F16 的产品口径记录（后端只读常量，供 health / 测试/ 文档投影使用）。
 * 不是功能实现：F14 计费/配额判 OUT；F16 桌面自动超管保持有意差异。
 */
const AI_ORG_PARITY_NOTES = Object.freeze({
  F14: Object.freeze({
    status: "NOT_APPLICABLE",
    reason: "本地计费/配额判 OUT（与本仓云能力同口径）；api_quota_rules 原语保留但不对模型调用接线。",
  }),
  F16: Object.freeze({
    status: "INTENTIONAL_DIFFERENCE",
    reason: "OpenArc 使用首启初始化 + 显式登录/锁屏 + sessionRef；不实现 DX 桌面自动超管会话。",
  }),
  F01: Object.freeze({ status: "AGENT_GATEWAY", command: "agent/jarvis/run" }),
  F03: Object.freeze({ status: "PROJECT_AGENT_061", windowMs: 30 * 60 * 1000 }),
  F04: Object.freeze({ status: "DEVELOPER_APP_AGENT", command: "agent/developer-app/run" }),
  F10: Object.freeze({ status: "BUILTIN_PROFILES_SEEDED", profiles: ["general", "researcher", "maker", "reviewer"] }),
  F15: Object.freeze({ status: "ROLE_MAPPING", mapping: { manager: "owner", editor: "member+can_create_tasks", viewer: "member" } }),
});

module.exports = { AI_ORG_PARITY_NOTES };
