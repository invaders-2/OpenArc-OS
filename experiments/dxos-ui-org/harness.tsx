"use strict";

/**
 * UI-4 · 组织治理扩展探针用挂载壳（只在 experiments 里被 esbuild 打包，不进产品构建）。
 *
 * 它做四件事：
 *   1. 复刻产品窗口里 organization 分支的真实外壳：main.tsx:2678 直接渲染 <GovernanceApp />，
 *      GovernanceApp 自己产出 .split > .split-side + .split-main，所以这里只套 .window；
 *   2. 装一个**假 identity 桥**（只在 window.openarc.identity 上放 command / onEvent），
 *      按 ?scenario= / ?slow= 返回不同数据形状，离线、确定性地驱动各类状态；
 *   3. 另装一个**假 skill 桥**并把 SkillCenter 挂进同款外壳，供基准对照（?page=skill）；
 *   4. 把收到的命令与下行事件挂到 window.__oaOrgProbe，供 Playwright 断言。
 *
 * 两个桥都不发任何网络请求：它们是内存里的 switch。命令载荷里的 password 只记
 * "已提供"标记，不落明文。
 */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { GovernanceApp } from "../../src/governance/GovernanceApp";
import { SkillCenter } from "../../src/skills/SkillCenter";
import "../../src/design-system/tokens.css";
import "../../src/design-system/primitives.css";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") || "ready";
const slow = params.get("slow") === "1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ══════════════════════════════════════════════════════════════════════════
   假数据（形状对齐 identity-service.cjs:344-361 / local-account-service.cjs 投影）
   ══════════════════════════════════════════════════════════════════════════ */
const DEPTS: any[] = [
  { id: "dept_ops", name: "运营部", parentId: null, status: "active" },
  { id: "dept_eng", name: "工程部", parentId: null, status: "active" },
  { id: "dept_old", name: "旧部门", parentId: null, status: "disabled" },
];

const USERS: any[] = [
  { id: "usr_admin", username: "admin", displayName: "本地管理员", departmentId: null, departmentIds: [], role: "superadmin", status: "active", local: true },
  { id: "usr_ops", username: "ops", displayName: "运营小李", departmentId: "dept_ops", departmentIds: ["dept_ops"], role: "admin", status: "active", local: true },
  { id: "usr_member", username: "member", displayName: "普通成员", departmentId: null, departmentIds: [], role: "user", status: "disabled", local: true },
];

const APPS: any[] = [
  { id: "market", name: "应用市场", desc: "应用市场", status: "enabled" },
  { id: "resource-library", name: "资源库", desc: "资源库", status: "enabled" },
  { id: "developer-demo", name: "开发者示例", desc: "开发者示例", status: "enabled" },
];

const RULES: Record<string, any> = {
  market: { mode: "all", departmentIds: [] },
  "resource-library": { mode: "all", departmentIds: [] },
  "developer-demo": { mode: "departments", departmentIds: ["dept_eng"] },
};

const POLICIES: Record<string, any> = {
  "app.developer-demo.export": { decision: "allow", userIds: [], departmentIds: ["dept_eng"], roles: ["admin"], dataScope: "department" },
};

/* B7f：identity/audit-list 的假后端行。只由成功的治理写动作追加（不预置编造行），
   字段形状对齐 local-account-service.cjs 的 listAuditEvents 去敏投影。 */
const AUDIT_ROWS: any[] = [];
const AUDIT_EVENT_BY_COMMAND: Record<string, string> = {
  "identity/department-create": "department.create",
  "identity/department-update": "department.update",
  "identity/department-delete": "department.delete",
  "identity/user-create": "user.create",
  "identity/user-update": "user.update",
  "identity/user-delete": "user.delete",
  "identity/user-reset-password": "user.password.reset",
  "identity/app-access-rule-save": "app_access.update",
  "identity/app-permission-policy-save": "app_permission.update",
};
const AUDIT_SOURCE_BY_EVENT: Record<string, string[]> = {
  "department.create": ["audit_log"],
  "department.update": ["audit_log"],
  "department.delete": ["audit_log", "authorization_audit"],
  "user.create": ["audit_log"],
  "user.update": ["audit_log"],
  "user.delete": ["audit_log", "authorization_audit"],
  "user.password.reset": ["audit_log"],
  "app_access.update": ["audit_log", "authorization_audit"],
  "app_permission.update": ["audit_log", "authorization_audit"],
};
function recordAudit(type: string, payload: Record<string, unknown>, res: any) {
  const event = AUDIT_EVENT_BY_COMMAND[type];
  if (!event) return;
  AUDIT_ROWS.unshift({
    at: Date.now(),
    event,
    result: res && res.ok === true ? "OK" : "DENY",
    errorCode: res && res.ok !== true ? String(res.error || "DXOS_ERR_INTERNAL") : null,
    sources: AUDIT_SOURCE_BY_EVENT[event] || ["audit_log"],
    target: typeof payload.name === "string" ? payload.name : typeof payload.username === "string" ? payload.username : null,
    actor: "usr_admin",
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   探针记录
   ══════════════════════════════════════════════════════════════════════════ */
const listeners: Array<(e: any) => void> = [];
const probe: any = {
  scenario,
  slow,
  commands: [] as any[],
  events: [] as any[],
  emit(event: any) {
    probe.events.push(event);
    for (const fn of listeners) {
      try {
        fn(event);
      } catch {
        /* 探针监听器异常不影响页面 */
      }
    }
  },
};
(window as any).__oaOrgProbe = probe;

const record = (type: string, payload: Record<string, unknown>) => {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload || {})) safe[k] = k === "password" ? "***" : v;
  probe.commands.push({ command: type, payload: safe });
};

function nextDeptId() {
  return "dept_new_" + String(DEPTS.length + 1);
}

/* ══════════════════════════════════════════════════════════════════════════
   假 identity 桥
   ══════════════════════════════════════════════════════════════════════════ */
async function handleIdentityCommand(raw: any) {
  const type = String(raw && raw.type);
  const payload: Record<string, unknown> = { ...(raw || {}) };
  delete (payload as any).type;
  record(type, payload);

  if (scenario === "loading" && (type === "identity/departments-list" || type === "identity/users-list")) {
    return new Promise(() => {});
  }
  if (scenario === "empty" && type === "identity/departments-list") return { ok: true, items: [] };
  if (scenario === "empty" && type === "identity/users-list") return { ok: true, items: [] };
  if (scenario === "error" && type === "identity/departments-list") {
    return { ok: false, error: "DXOS_ERR_INTERNAL", message: "探针：读取失败" };
  }
  if (scenario === "session" && type === "identity/departments-list") {
    return { ok: false, error: "SESSION_EXPIRED", message: "探针：会话已过期" };
  }
  if (scenario === "not-super-admin" && type === "identity/departments-list") {
    return { ok: false, error: "NOT_SUPER_ADMIN", message: "探针：需要超级管理员权限" };
  }
  if (scenario === "unavailable" && type === "identity/departments-list") {
    return { ok: false, error: "AGENT_DEPENDENCY_UNAVAILABLE", message: "探针：依赖未接线" };
  }

  switch (type) {
    case "identity/local-account-info":
      // empty 场景下计数必须同步为 0，否则界面会显示"3 个账号 / 3 个部门"却一个都列不出来。
      if (scenario === "empty") return { ok: true, local: true, initialized: true, userCount: 0, departmentCount: 0 };
      return { ok: true, local: true, initialized: true, userCount: USERS.length, departmentCount: DEPTS.length };
    case "identity/audit-list": {
      const name = typeof payload.event === "string" && payload.event ? payload.event : null;
      const limit = Math.max(1, Math.min(200, Number(payload.limit) || 50));
      const rows = name ? AUDIT_ROWS.filter((row) => row.event === name) : AUDIT_ROWS;
      return { ok: true, items: rows.slice(0, limit), total: rows.length, limit, offset: 0 };
    }
    case "identity/departments-list":
      return { ok: true, items: DEPTS.map((d) => ({ ...d })) };
    case "identity/department-create": {
      if (slow) await sleep(2500);
      const name = String(payload.name == null ? "" : payload.name).trim();
      if (name.length < 2) return { ok: false, error: "DXOS_ERR_INVALID_INPUT", message: "部门名称至少需要 2 个字符" };
      if (DEPTS.some((d) => d.name === name)) return { ok: false, error: "DXOS_ERR_CONFLICT", message: "已存在同名部门" };
      const dept = { id: nextDeptId(), name, parentId: null, status: "active" };
      DEPTS.push(dept);
      probe.emit({ event: "identity/profile-updated", at: Date.now(), userId: "usr_admin" });
      return { ok: true, department: { ...dept } };
    }
    case "identity/department-update": {
      const dept = DEPTS.find((d) => d.id === payload.departmentId);
      if (!dept) return { ok: false, error: "DXOS_ERR_NOT_FOUND", message: "部门不存在" };
      if (payload.name !== undefined) {
        const name = String(payload.name).trim();
        if (name.length < 2) return { ok: false, error: "DXOS_ERR_INVALID_INPUT", message: "部门名称至少需要 2 个字符" };
        dept.name = name;
      }
      if (payload.status !== undefined) dept.status = payload.status === "disabled" ? "disabled" : "active";
      return { ok: true, department: { ...dept } };
    }
    case "identity/department-delete": {
      const idx = DEPTS.findIndex((d) => d.id === payload.departmentId);
      if (idx < 0) return { ok: false, error: "DXOS_ERR_NOT_FOUND", message: "部门不存在" };
      DEPTS.splice(idx, 1);
      for (const u of USERS) {
        u.departmentIds = (u.departmentIds || []).filter((x: string) => x !== payload.departmentId);
        u.departmentId = u.departmentIds[0] || null;
      }
      return { ok: true, deleted: true };
    }
    case "identity/users-list":
      return { ok: true, items: USERS.map((u) => ({ ...u })) };
    case "identity/user-create": {
      if (slow) await sleep(2500);
      const identifier = String(payload.identifier == null ? "" : payload.identifier).trim();
      if (identifier.length < 2) return { ok: false, error: "DXOS_ERR_INVALID_INPUT", message: "用户名至少需要 2 个字符" };
      if (!String(payload.password || "").length) return { ok: false, error: "DXOS_ERR_INVALID_INPUT", message: "密码不能为空" };
      const role = String(payload.role || "user");
      if (role === "admin" && !payload.departmentId) {
        return { ok: false, error: "DXOS_ERR_INVALID_INPUT", message: "admin 角色需要 departmentId（既有两值 role 列用 department-admin 成员关系承载 admin）" };
      }
      if (USERS.some((u) => u.username === identifier)) return { ok: false, error: "INVALID_INPUT", message: "用户名已存在或输入不合法" };
      const user = {
        id: "usr_new_" + String(USERS.length + 1),
        username: identifier,
        displayName: String(payload.displayName || identifier),
        departmentId: payload.departmentId || null,
        departmentIds: payload.departmentId ? [payload.departmentId] : [],
        role,
        status: "active",
        local: true,
      };
      USERS.push(user);
      return { ok: true, user: { ...user } };
    }
    case "identity/user-update": {
      const user = USERS.find((u) => u.id === payload.userId);
      if (!user) return { ok: false, error: "DXOS_ERR_NOT_FOUND", message: "用户不存在" };
      if (payload.username !== undefined) {
        const username = String(payload.username).trim();
        if (username.length < 2) return { ok: false, error: "DXOS_ERR_INVALID_INPUT", message: "用户名至少需要 2 个字符" };
        if (USERS.some((u) => u.username === username && u.id !== user.id)) return { ok: false, error: "DXOS_ERR_CONFLICT", message: "用户名已存在" };
        user.username = username;
      }
      if (payload.departmentId !== undefined) {
        user.departmentIds = payload.departmentId ? [String(payload.departmentId)] : [];
        user.departmentId = user.departmentIds[0] || null;
      }
      if (payload.role !== undefined) {
        const role = String(payload.role);
        if (role === "admin" && !(user.departmentIds || []).length) {
          return { ok: false, error: "DXOS_ERR_INVALID_INPUT", message: "admin 角色需要部门（department-admin 成员关系承载 admin）" };
        }
        user.role = role;
      }
      if (payload.status !== undefined) user.status = payload.status === "disabled" ? "disabled" : "active";
      return { ok: true, user: { ...user } };
    }
    case "identity/user-delete": {
      const user = USERS.find((u) => u.id === payload.userId);
      if (!user) return { ok: false, error: "DXOS_ERR_NOT_FOUND", message: "用户不存在" };
      const otherAdmins = USERS.filter((u) => u.role === "superadmin" && u.status === "active" && u.id !== user.id);
      if (user.role === "superadmin" && !otherAdmins.length) {
        return { ok: false, error: "DXOS_ERR_CONFLICT", message: "系统必须保留至少一位启用的超级管理员" };
      }
      USERS.splice(USERS.indexOf(user), 1);
      return { ok: true, deleted: true };
    }
    case "identity/user-reset-password": {
      const user = USERS.find((u) => u.id === payload.userId);
      if (!user) return { ok: false, error: "DXOS_ERR_NOT_FOUND", message: "用户不存在" };
      if (String(payload.password || "").length < 8) return { ok: false, error: "DXOS_ERR_INVALID_INPUT", message: "口令至少 8 位" };
      return { ok: true, userId: user.id, revokedSessions: 2 };
    }
    case "identity/app-permission-snapshot":
      return {
        ok: true,
        apps: APPS.map((a) => ({ ...a })),
        externalAppAccess: JSON.parse(JSON.stringify(RULES)),
        permissionPolicies: JSON.parse(JSON.stringify(POLICIES)),
        permissionManifests: [],
        developerApps: { available: false, code: "AGENT_DEPENDENCY_UNAVAILABLE", items: [] },
        local: true,
      };
    case "identity/app-access-summary": {
      const user = USERS.find((u) => u.id === payload.userId) || null;
      const summary: Record<string, boolean> = {};
      for (const app of APPS) {
        const rule = RULES[app.id] || { mode: "all", departmentIds: [] };
        if (!user) summary[app.id] = false;
        else if (user.role === "superadmin") summary[app.id] = true;
        else if (app.id === "market") summary[app.id] = true;
        else if (rule.mode === "all") summary[app.id] = true;
        else if (rule.mode === "superadmins") summary[app.id] = false;
        else if (rule.mode === "admins") summary[app.id] = user.role === "admin";
        else summary[app.id] = (user.departmentIds || []).some((id: string) => (rule.departmentIds || []).indexOf(id) >= 0);
      }
      summary["api-settings"] = false;
      summary["accounts"] = false;
      return { ok: true, summary };
    }
    case "identity/app-access-rule-save": {
      const appId = String(payload.appId);
      if (!APPS.some((a) => a.id === appId)) return { ok: false, error: "DXOS_ERR_NOT_FOUND", message: "该 APP 当前未安装" };
      const normalized = appId === "market" ? { mode: "all", departmentIds: [] } : payload.rule;
      RULES[appId] = normalized;
      return { ok: true, rule: normalized };
    }
    case "identity/app-permission-policy-save": {
      const code = String(payload.permissionCode || "").trim();
      if (!/^app\.[a-z0-9][a-z0-9-]{1,48}\.[a-z][a-z0-9_.:-]{1,96}$/.test(code)) {
        return { ok: false, error: "DXOS_ERR_INVALID_INPUT", message: "不支持的 APP 权限代码" };
      }
      POLICIES[code] = payload.policy;
      return { ok: true, policy: payload.policy };
    }
    default:
      return { ok: false, error: "ORG_COMMAND_NOT_ALLOWED", message: "探针：未登记命令 " + type };
  }
}

/** 包一层：先由假后端处理，再按成功 / 失败追加一条审计行（identity/audit-list 的数据来源）。 */
async function identityCommand(raw: any) {
  const type = String(raw && raw.type);
  const payload: Record<string, unknown> = { ...(raw || {}) };
  delete (payload as any).type;
  const res = await handleIdentityCommand(raw);
  recordAudit(type, payload, res);
  return res;
}

const identityBridge = {
  command: identityCommand,
  onEvent(cb: (e: any) => void) {
    listeners.push(cb);
    return () => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  },
};

/* ══════════════════════════════════════════════════════════════════════════
   基准页 SkillCenter（?page=skill）的假 skill 桥（与 experiments/dxos-ui-tasks 同口径）
   ══════════════════════════════════════════════════════════════════════════ */
const SKILLS: any[] = [
  {
    id: "writing",
    name: "写作生成",
    description: "生成诗歌、文案、故事、脚本、邮件、标题等原创文本，输出可直接交付的成品。",
    kind: "text",
    builtin: true,
    layer: "preset",
    origin: "official",
    exposure: "slash",
    enabled: true,
    systemPrompt: "你是中文写作助手。",
    inputSchema: { type: "object", properties: { instruction: { type: "string" } }, required: ["instruction"] },
  },
  {
    id: "analysis",
    name: "文本分析",
    description: "总结、归纳、对比、提取要点、诊断问题，输出结构化结论。",
    kind: "text",
    builtin: true,
    layer: "preset",
    origin: "official",
    exposure: "slash",
    enabled: false,
  },
];
const PACKS: any[] = [
  { id: "pack_1", name: "团队效率包", sourceName: "team-pack.zip", importedAt: Date.parse("2026-01-02T03:04:05Z"), skillCount: 3, entryPoints: [], skillDocs: [{ path: "SKILL.md" }] },
];
const skillProbe: any = { page: "skill", commands: [] as any[] };
(window as any).__oaSkillProbe = skillProbe;

async function skillCommand(raw: any) {
  const cmd = String(raw && raw.command);
  skillProbe.commands.push({ command: cmd, payload: raw && raw.payload });
  switch (cmd) {
    case "skill/health":
      return { ok: true, value: { status: "ok", dependencies: { chatTarget: true, modelCall: true, cliRuntime: true, fsAdapter: true, mediaAdapter: true, skillWorkspace: true } } };
    case "skill/list":
      return { ok: true, value: { items: SKILLS } };
    case "skill/pack/list":
      return { ok: true, value: { items: PACKS } };
    case "skill/get":
      return { ok: true, value: { skill: SKILLS.find((s) => s.id === (raw.payload || {}).skillId) || null } };
    default:
      return { ok: false, error: "SKILL_COMMAND_NOT_ALLOWED", message: "探针：未登记命令" };
  }
}

const skillBridge = { command: skillCommand, onEvent: () => () => {} };
(window as any).openarc = { identity: identityBridge, skill: skillBridge };

/* 会话事件：挂载后推两条，让审计区块的身份会话事件有真实来源。 */
setTimeout(() => probe.emit({ event: "identity/session-changed", at: Date.now(), reason: "restore", userId: "usr_admin" }), 60);
setTimeout(() => probe.emit({ event: "identity/profile-updated", at: Date.now(), userId: "usr_admin" }), 140);

/* ══════════════════════════════════════════════════════════════════════════
   外壳
   ══════════════════════════════════════════════════════════════════════════ */
function SkillShell() {
  const [tab, setTab] = useState<"market" | "mine" | "installed">("installed");
  return (
    <div className="window" style={{ position: "absolute", inset: 0 }}>
      <div className="split">
        <nav className="split-side" aria-label="Skill 分类">
          <div className="split-section">Skill</div>
          <button className="split-nav" aria-current={tab === "market"} onClick={() => setTab("market")}>
            市场
          </button>
          <button className="split-nav" aria-current={tab === "mine"} onClick={() => setTab("mine")}>
            我的技能
          </button>
          <div className="split-section">本机</div>
          <button className="split-nav" aria-current={tab === "installed"} onClick={() => setTab("installed")}>
            已安装
          </button>
        </nav>
        <div className="split-main">
          <SkillCenter tab={tab} role="ADMIN" />
        </div>
      </div>
    </div>
  );
}

function OrgShell() {
  // main.tsx:2678 直接渲染 <GovernanceApp />（GovernanceApp 自己产出 .split）。
  return (
    <div className="window" style={{ position: "absolute", inset: 0 }}>
      <GovernanceApp />
    </div>
  );
}

const pageKind = params.get("page") || "org";
createRoot(document.getElementById("root")!).render(pageKind === "skill" ? <SkillShell /> : <OrgShell />);
