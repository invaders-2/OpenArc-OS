"use strict";

/**
 * UI-4 · 组织治理扩展：组织与成员 / APP 访问 / 审计（appId organization 的内容区）。
 *
 * 数据面边界（与 SkillCenter.tsx:1-17 / TaskConsole.tsx:1-22 / preload.cjs:42-57 同一口径）：
 *   · 只经 window.openarc.identity.command 发受控命令，只订阅 identity.onEvent；
 *   · 不 fetch、不直连本机端口、不读凭据、不写 localStorage；
 *   · **操作者** userId / role / sessionRef 一律不发：sessionRef 由主进程
 *     identity-service.cjs:320-343 从当前认证会话注入，超级管理员判定在
 *     local-account-service.cjs:262-269 完成。命令契约要求的目标 userId
 *     （user-update / user-delete / user-reset-password / app-permission-snapshot /
 *     app-access-summary）是业务参数，不是操作者身份。
 *
 * 后端形状（identity-service.cjs:344-361 / local-account-service.cjs 各方法）：
 *   成功 { ok:true, ...value }（**平铺**，不像 skill/agent 包一层 value）；
 *   失败 { ok:false, error, message?, detail? }。
 *
 * 会员门禁已按 OUT 去除（local-account-service.cjs:40-57）：界面不出现
 * "会员 / 权益 / 套餐 / 积分"，也不显示 maxLocalAccounts / plan 之类字段，
 * 只陈述本地语义"本地模式不限账号数"。
 *
 * 视觉：只用 primitives 与 tokens.css 既有 token；结构对齐 SkillCenter.tsx 的
 * split-side / split-main 与两栏信息密度（行高 / 字阶一致）。纯逻辑见 ./orgConsoleLogic.ts。
 */
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, TextField } from "../design-system/primitives";
import { PageState } from "../design-system/page-states";
/* page-states.css 只被设计系统 gallery 引用过；PageState 是本页错误 / 空 / 加载 /
   未授权 / 不可用状态的唯一实现，这里按需引入它自己的样式表（不改既有类与 token）。 */
import "../design-system/page-states.css";
import { Dialog } from "../desktop/Dialog";
import {
  ACCESS_MODES,
  DATA_SCOPES,
  ORG_SECTIONS,
  ORG_SECTION_LABEL,
  ORG_ROLES,
  POLICY_DECISIONS,
  accessModeLabel,
  isManageDenied,
  accessSummaryRows,
  appAccessRulePayload,
  appPermissionPolicyPayload,
  appRuleSummary,
  codeOfError,
  departmentCreatePayload,
  departmentName,
  departmentUpdatePayload,
  filterMembers,
  isAllowedOrgCommand,
  localAccountSummaryText,
  normalizeAuditRow,
  normalizeIdentityEvent,
  normalizeRole,
  orgErrorText,
  orgListState,
  payloadKeysAllowed,
  policySummary,
  resetPasswordPayload,
  roleLabel,
  rolePrivilegeText,
  userCreatePayload,
  userStatusLabel,
  userStatusTone,
  userUpdatePayload,
} from "./orgConsoleLogic";
import type { AuditEntry, IdentityEventRow, OrgSection } from "./orgConsoleLogic";

/* ══════════════════════════════════════════════════════════════════════════
   桥与结果形状
   ══════════════════════════════════════════════════════════════════════════ */
type OrgBridge = {
  command: (cmd: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onEvent?: (cb: (event: unknown) => void) => () => void;
};

/** 只读访问：不改 window.openarc 的类型声明，也不扩大暴露面。 */
const getIdentityBridge = (): OrgBridge | undefined => {
  if (typeof window === "undefined") return undefined;
  const root = (window as unknown as { openarc?: { identity?: OrgBridge } }).openarc;
  return root && root.identity ? root.identity : undefined;
};

/* ══════════════════════════════════════════════════════════════════════════
   小工具
   ══════════════════════════════════════════════════════════════════════════ */
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const asText = (v: unknown, fallback = "—"): string => {
  if (typeof v === "string") return v.trim() ? v : fallback;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : fallback;
  if (typeof v === "boolean") return v ? "是" : "否";
  return fallback;
};

const listOf = (res: Record<string, unknown>, key: string): Record<string, unknown>[] =>
  Array.isArray(res[key]) ? (res[key] as Record<string, unknown>[]) : [];

const timeText = (ts: unknown): string => {
  const n = Number(ts);
  if (ts == null || !Number.isFinite(n) || n <= 0) return "—";
  return new Date(n).toLocaleString("zh-CN", { hour12: false });
};

/* ══════════════════════════════════════════════════════════════════════════
   页面
   ══════════════════════════════════════════════════════════════════════════ */
type Failure = { code: string; context: string };
type ConfirmState =
  | { kind: "department-delete"; id: string; name: string }
  | { kind: "user-delete"; id: string; name: string }
  | { kind: "user-reset"; id: string; name: string }
  | null;
type UserRow = Record<string, unknown>;
type DeptRow = Record<string, unknown>;

export function GovernanceApp() {
  const [section, setSection] = useState<OrgSection>("org");

  /* 数据 */
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState<Record<string, unknown> | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [departments, setDepartments] = useState<DeptRow[]>([]);
  const [listError, setListError] = useState<Failure | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** 一旦后端回 NOT_SUPER_ADMIN / DXOS_ERR_FORBIDDEN，写操作整体转只读。 */
  const [manageDenied, setManageDenied] = useState<string | null>(null);

  /* 组织与成员 */
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(null);
  const [deptForm, setDeptForm] = useState({ name: "", description: "" });
  const [editDept, setEditDept] = useState<{ departmentId: string; name: string; description: string } | null>(null);
  const [userForm, setUserForm] = useState({ identifier: "", displayName: "", password: "", departmentId: "", role: "user" });
  const [editUser, setEditUser] = useState<{ userId: string; username: string; departmentId: string; role: string; status: string } | null>(null);

  /* APP 访问 */
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [snapshot, setSnapshot] = useState<Record<string, unknown> | null>(null);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [ruleDraft, setRuleDraft] = useState<Record<string, { mode: string; departmentIds: string[] }>>({});
  const [policyDraft, setPolicyDraft] = useState({
    permissionCode: "",
    decision: "deny",
    roles: [] as string[],
    userIds: [] as string[],
    departmentIds: [] as string[],
    dataScope: "",
  });

  /* 审计（B7f：真实数据源 = identity/audit-list 的后端 audit_log / authorization_audit 投影） */
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditError, setAuditError] = useState<Failure | null>(null);
  const [identityEvents, setIdentityEvents] = useState<IdentityEventRow[]>([]);

  /* 二次确认 */
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [resetPw, setResetPw] = useState("");

  const bridge = getIdentityBridge();
  const available = typeof bridge?.command === "function";

  /**
   * 唯一上行通道：{ type, ...payload }（与 useIdentity.ts:137-241 的既有写法一致）。
   * 命令先过本层白名单，再过 @see ALLOWED_PAYLOAD_KEYS 的键白名单，两层都不过就本地拒绝。
   */
  const send = useCallback(
    async (type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
      if (!isAllowedOrgCommand(type)) return { ok: false, error: "ORG_COMMAND_NOT_ALLOWED" };
      if (!payloadKeysAllowed(type, payload)) return { ok: false, error: "ORG_COMMAND_NOT_ALLOWED" };
      const b = getIdentityBridge();
      if (!b || typeof b.command !== "function") return { ok: false, error: "NO_BRIDGE" };
      try {
        const res = await b.command({ type, ...payload });
        return isObject(res) ? res : { ok: false, error: "DXOS_ERR_INTERNAL" };
      } catch {
        // 桥异常与后端异常一样收敛成可见错误码，不允许"点了没反应"。
        return { ok: false, error: "DXOS_ERR_INTERNAL" };
      }
    },
    [],
  );

  /* ── 读取 ─────────────────────────────────────────────────────────────── */

  const loadOrg = useCallback(async () => {
    setLoading(true);
    setListError(null);
    const infoRes = await send("identity/local-account-info");
    if (infoRes.ok === true) setInfo(infoRes);

    let errorCode: string | null = null;
    const deptRes = await send("identity/departments-list");
    if (deptRes.ok === true) {
      setDepartments(listOf(deptRes, "items"));
      setManageDenied(null);
    } else {
      errorCode = codeOfError(deptRes.error);
      setDepartments([]);
      setManageDenied(isManageDenied(errorCode) ? errorCode : null);
    }

    const usersRes = await send("identity/users-list");
    if (usersRes.ok === true) setUsers(listOf(usersRes, "items"));
    else {
      setUsers([]);
      if (!errorCode) errorCode = codeOfError(usersRes.error);
    }

    setListError(errorCode ? { code: errorCode, context: "读取组织与成员" } : null);
    setLoading(false);
  }, [send]);

  /** 以某个用户为维度读 APP 权限快照 + 访问摘要；不给就取第一个本地账号。 */
  const loadApp = useCallback(
    async (targetUserId?: string) => {
      setLoading(true);
      setListError(null);
      setSnapshot(null);
      setSummary(null);

      let errorCode: string | null = null;
      const usersRes = await send("identity/users-list");
      let rows: UserRow[] = [];
      if (usersRes.ok === true) {
        rows = listOf(usersRes, "items");
        setUsers(rows);
      } else {
        errorCode = codeOfError(usersRes.error);
        setUsers([]);
      }

      const target = (targetUserId && targetUserId) || selectedUserId || (rows[0] && String(rows[0].id)) || "";
      if (!errorCode && target) {
        if (target !== selectedUserId) setSelectedUserId(target);
        const snapRes = await send("identity/app-permission-snapshot", { userId: target });
        if (snapRes.ok === true) {
          setSnapshot(snapRes);
          setRuleDraft(draftFromSnapshot(snapRes));
        } else {
          errorCode = codeOfError(snapRes.error);
        }
        const sumRes = await send("identity/app-access-summary", { userId: target });
        if (sumRes.ok === true) setSummary(isObject(sumRes.summary) ? (sumRes.summary as Record<string, unknown>) : {});
        else if (!errorCode) errorCode = codeOfError(sumRes.error);
      }
      setListError(errorCode ? { code: errorCode, context: "读取 APP 访问" } : null);
      setLoading(false);
    },
    [send, selectedUserId],
  );

  /** B7f：审计区块读后端真实审计行（只读投影；字段已去敏）。 */
  const loadAudit = useCallback(
    async () => {
      setLoading(true);
      setAuditError(null);
      const res = await send("identity/audit-list", { limit: 100 });
      if (res.ok === true) {
        const rows = Array.isArray(res.items)
          ? (res.items as unknown[]).map(normalizeAuditRow).filter((row): row is AuditEntry => row !== null)
          : [];
        setAudit(rows);
      } else {
        setAudit([]);
        setAuditError({ code: codeOfError(res.error), context: "读取审计" });
      }
      setLoading(false);
    },
    [send],
  );

  useEffect(() => {
    if (section === "org") void loadOrg();
    else if (section === "app") void loadApp(selectedUserId || undefined);
    else void loadAudit();
    // 切区块或切用户时重读；loadOrg / loadApp 自身不触发重渲染循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, selectedUserId]);

  /* identity:event（identity-service.cjs:96-106）：{ event, at, ...payload }。
     只做展示，不写 localStorage，也不把 sessionRef 带进界面状态。 */
  useEffect(() => {
    if (!available || typeof bridge?.onEvent !== "function") return;
    const off = bridge.onEvent((event) => {
      const row = normalizeIdentityEvent(event);
      if (!row) return;
      setIdentityEvents((cur) => [row, ...cur].slice(0, 100));
    });
    return off;
  }, [available, bridge]);

  /* ── 写操作 ───────────────────────────────────────────────────────────── */

  /**
   * 统一的"进行中"包装：busy 期间对应按钮 disabled + aria-busy，防连点；
   * 每次真实动作都落一行审计投影（成功 OK / 失败 DENY，事件名沿用源语义）。
   */
  const runAction = useCallback(
    async (
      key: string,
      type: string,
      payload: Record<string, unknown>,
      context: string,
      target: string | null,
      successText: string,
      reload: () => Promise<void> | void,
    ): Promise<boolean> => {
      setBusy(key);
      setFailure(null);
      setNotice(null);
      const res = await send(type, payload);
      const ok = res.ok === true;
      const code = ok ? null : codeOfError(res.error);
      setBusy(null);
      if (!ok) {
        const failureCode = code || "DXOS_ERR_INTERNAL";
        setFailure({ code: failureCode, context });
        if (isManageDenied(failureCode)) setManageDenied(failureCode);
        return false;
      }
      setNotice(successText);
      await reload();
      return true;
    },
    [send],
  );

  const canManage = !manageDenied;

  /* ── 组织与成员动作 ───────────────────────────────────────────────────── */

  const createDepartment = async () => {
    const payload = departmentCreatePayload(deptForm);
    const ok = await runAction("create-dept", "identity/department-create", payload, "创建部门", payload.name as string, "部门已创建", loadOrg);
    if (ok) setDeptForm({ name: "", description: "" });
  };

  const saveDepartment = async () => {
    if (!editDept) return;
    const payload = departmentUpdatePayload(editDept);
    const ok = await runAction("save-dept", "identity/department-update", payload, "更新部门", payload.name as string, "部门已更新", loadOrg);
    if (ok) setEditDept(null);
  };

  const toggleDepartment = async (dept: DeptRow) => {
    const id = String(dept.id);
    const next = String(dept.status).toLowerCase() === "active" ? "disabled" : "active";
    await runAction("toggle-dept:" + id, "identity/department-update", { departmentId: id, status: next }, next === "disabled" ? "停用部门" : "启用部门", String(dept.name), next === "disabled" ? "部门已停用" : "部门已启用", loadOrg);
  };

  const deleteDepartment = async () => {
    if (!confirm || confirm.kind !== "department-delete") return;
    const ok = await runAction("confirm", "identity/department-delete", { departmentId: confirm.id }, "删除部门", confirm.name, "部门已删除", loadOrg);
    setBusy(null);
    if (ok) {
      setConfirm(null);
      if (selectedDeptId === confirm.id) setSelectedDeptId(null);
    }
  };

  const createUser = async () => {
    const payload = userCreatePayload(userForm);
    const ok = await runAction("create-user", "identity/user-create", payload, "创建成员", payload.identifier as string, "成员已创建", loadOrg);
    if (ok) setUserForm({ identifier: "", displayName: "", password: "", departmentId: "", role: "user" });
  };

  const saveUser = async () => {
    if (!editUser) return;
    const payload = userUpdatePayload(editUser);
    const ok = await runAction("save-user", "identity/user-update", payload, "更新成员", payload.username ? String(payload.username) : editUser.username, "成员已更新", loadOrg);
    if (ok) setEditUser(null);
  };

  const toggleUser = async (user: UserRow) => {
    const id = String(user.id);
    const disabled = String(user.status).toLowerCase() === "disabled";
    await runAction(
      "toggle-user:" + id,
      "identity/user-update",
      { userId: id, status: disabled ? "active" : "disabled" },
      disabled ? "启用成员" : "禁用成员",
      asText(user.username, id),
      disabled ? "成员已启用" : "成员已禁用",
      loadOrg,
    );
  };

  const resetPassword = async () => {
    if (!confirm || confirm.kind !== "user-reset") return;
    if (!resetPw.trim()) {
      setFailure({ code: "DXOS_ERR_INVALID_INPUT", context: "重置口令" });
      return;
    }
    const payload = resetPasswordPayload({ userId: confirm.id, password: resetPw });
    const ok = await runAction("confirm", "identity/user-reset-password", payload, "重置口令", confirm.name, "口令已重置，该成员的全部会话已撤销", loadOrg);
    setResetPw("");
    if (ok) setConfirm(null);
  };

  const deleteUser = async () => {
    if (!confirm || confirm.kind !== "user-delete") return;
    const ok = await runAction("confirm", "identity/user-delete", { userId: confirm.id }, "删除成员", confirm.name, "成员已删除", loadOrg);
    if (ok) setConfirm(null);
  };

  /* ── APP 访问动作 ─────────────────────────────────────────────────────── */

  const saveRule = async (appId: string) => {
    const draft = ruleDraft[appId] || { mode: "all", departmentIds: [] };
    const payload = appAccessRulePayload({ appId, mode: draft.mode, departmentIds: draft.departmentIds });
    await runAction("rule:" + appId, "identity/app-access-rule-save", payload, "保存访问规则", appId, "APP 打开规则已保存", () => loadApp(selectedUserId));
  };

  const savePolicy = async () => {
    const payload = appPermissionPolicyPayload(policyDraft);
    await runAction("policy", "identity/app-permission-policy-save", payload, "保存权限策略", payload.permissionCode as string, "APP 权限策略已保存", () => loadApp(selectedUserId));
  };

  /* ── 渲染 ─────────────────────────────────────────────────────────────── */

  const snap = snapshot;
  const snapApps = isObject(snap) && Array.isArray(snap.apps) ? (snap.apps as Record<string, unknown>[]) : [];
  const snapRules = isObject(snap) && isObject(snap.externalAppAccess) ? (snap.externalAppAccess as Record<string, unknown>) : {};
  const snapPolicies = isObject(snap) && isObject(snap.permissionPolicies) ? (snap.permissionPolicies as Record<string, unknown>) : {};
  const snapManifests = isObject(snap) && Array.isArray(snap.permissionManifests) ? (snap.permissionManifests as unknown[]) : [];
  const snapDeveloper = isObject(snap) && isObject(snap.developerApps) ? (snap.developerApps as Record<string, unknown>) : null;

  const appCount = snapshot ? 1 : 0;
  const state =
    section === "audit"
      ? loading
        ? "loading"
        : "ready"
      : orgListState({
          loading,
          errorCode: listError ? listError.code : null,
          count: section === "org" ? departments.length : appCount,
        });

  const activeDepartments = departments.filter((d) => String(d.status).toLowerCase() === "active");
  const members = filterMembers(users, selectedDeptId);

  const banner = (
    <header className="org-banner">
      <div className="org-banner__row">
        <h1 className="org-banner__title">组织治理 · {ORG_SECTION_LABEL[section]}</h1>
        <span className="org-muted" data-org-local-mode>
          {info ? localAccountSummaryText(info) : "本地账号 · 不联网、不显示模拟数据"}
        </span>
      </div>
      {failure ? (
        <p className="org-error" role="alert" data-org-error data-org-error-code={failure.code}>
          {failure.context}失败：{orgErrorText(failure.code)}
        </p>
      ) : null}
      {notice ? (
        <p className="org-notice" role="status" data-org-notice>
          {notice}
        </p>
      ) : null}
      {manageDenied ? (
        <p className="org-warn" role="status" data-org-readonly>
          当前会话没有超级管理员权限，本页只读；需要超级管理员执行治理操作。
        </p>
      ) : null}
    </header>
  );

  const stateBlock = (kind: "loading" | "empty" | "error" | "unauthorized" | "unavailable", onRetry: () => void) => (
    <div className="org-state-block" data-org-state={kind}>
      <PageState
        kind={kind}
        title={STATE_TITLE[kind]}
        description={stateDescription(kind, listError)}
        onAction={kind === "error" || kind === "unauthorized" || kind === "unavailable" || kind === "empty" ? onRetry : undefined}
        actionLabel={kind === "empty" ? "重新读取" : undefined}
      />
      {listError ? (
        <p className="org-muted" data-org-dependency data-org-error-code={listError.code}>
          {listError.context}：{orgErrorText(listError.code)}
        </p>
      ) : null}
    </div>
  );

  return (
    <div className="split" data-org-shell="1">
      <nav className="split-side" aria-label="组织治理分区">
        <div className="split-section">组织治理</div>
        {ORG_SECTIONS.map((s) => (
          <button
            key={s}
            type="button"
            className="split-nav"
            aria-current={section === s}
            data-org-nav={s}
            onClick={() => {
              setSection(s);
              setFailure(null);
              setNotice(null);
            }}
          >
            {ORG_SECTION_LABEL[s]}
          </button>
        ))}
      </nav>

      <div className="split-main">
        <div
          className="org-center"
          data-org-center="1"
          data-org-section={section}
          data-org-available={available ? "true" : "false"}
          data-org-manage={canManage ? "true" : "false"}
          data-org-list-state={state}
        >
          {banner}

          {section === "org" ? (
            state === "loading" || state === "error" || state === "unauthorized" || state === "unavailable" ? (
              stateBlock(state, () => void loadOrg())
            ) : (
              <div className="org-split" data-org-pane="org">
                {/* ── 部门 ─────────────────────────────────────────── */}
                <section className="org-list-pane" aria-label="部门列表">
                  <div className="org-pane-head">
                    <h2 className="org-pane-title">部门</h2>
                    <span className="org-muted" data-org-dept-count>
                      {departments.length} 个
                    </span>
                  </div>
                  <div className="org-form">
                    <TextField
                      label="部门名称"
                      labelHidden
                      placeholder="部门名称（至少 2 个字符）"
                      data-org-field="dept-name"
                      value={deptForm.name}
                      onChange={(e) => setDeptForm({ ...deptForm, name: e.target.value })}
                    />
                    <TextField
                      label="部门说明"
                      labelHidden
                      placeholder="说明（可选）"
                      data-org-field="dept-desc"
                      value={deptForm.description}
                      onChange={(e) => setDeptForm({ ...deptForm, description: e.target.value })}
                    />
                    <Button
                      variant="primary"
                      size="sm"
                      status={busy === "create-dept" ? "loading" : "idle"}
                      disabled={!canManage}
                      data-org-action="create-dept"
                      onClick={() => void createDepartment()}
                    >
                      创建部门
                    </Button>
                  </div>
                  {departments.length ? (
                    <ul className="org-list" data-org-depts>
                      {departments.map((d) => {
                        const id = String(d.id);
                        const memberCount = users.filter((u) => Array.isArray(u.departmentIds) && (u.departmentIds as unknown[]).indexOf(id) >= 0).length;
                        const active = String(d.status).toLowerCase() === "active";
                        return (
                          <li key={id} data-org-dept={id}>
                            <div className="org-row" aria-pressed={selectedDeptId === id}>
                              <button
                                type="button"
                                className="org-row__pick"
                                aria-pressed={selectedDeptId === id}
                                data-org-dept-select={id}
                                onClick={() => setSelectedDeptId(selectedDeptId === id ? null : id)}
                              >
                                <span className="org-row__top">
                                  <strong data-org-dept-name>{asText(d.name, id)}</strong>
                                  {/* Badge 不接受任意 data-* 透传，包一层承载探针标记。 */}
                                  <span data-org-dept-status>
                                    <Badge tone={active ? "neutral" : "warning"} className="org-status">
                                      {active ? "已启用" : "已停用"}
                                    </Badge>
                                  </span>
                                </span>
                                <span className="org-row__facts">
                                  <span>成员 {memberCount}</span>
                                  <span>{active ? "可分配" : "已停用，不可分配"}</span>
                                </span>
                                <span className="org-row__desc">部门只在本机生效；停用后不能再作为成员归属或 APP 访问目标。</span>
                              </button>
                            </div>
                            {selectedDeptId === id ? (
                              <div className="org-actions" data-org-dept-actions={id}>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  disabled={!canManage}
                                  data-org-dept-edit={id}
                                  onClick={() =>
                                    setEditDept(
                                      editDept && editDept.departmentId === id
                                        ? null
                                        : { departmentId: id, name: asText(d.name, ""), description: "" },
                                    )
                                  }
                                >
                                  编辑
                                </Button>
                                <Button variant="ghost" size="sm" disabled={!canManage} data-org-dept-toggle={id} onClick={() => void toggleDepartment(d)}>
                                  {active ? "停用" : "启用"}
                                </Button>
                                <Button
                                  variant="danger"
                                  size="sm"
                                  disabled={!canManage}
                                  data-org-dept-delete={id}
                                  onClick={() => setConfirm({ kind: "department-delete", id, name: asText(d.name, id) })}
                                >
                                  删除
                                </Button>
                              </div>
                            ) : null}
                            {editDept && editDept.departmentId === id ? (
                              <div className="org-edit" data-org-edit-dept={id}>
                                <TextField
                                  label="部门名称"
                                  labelHidden
                                  placeholder="部门名称"
                                  data-org-field="edit-dept-name"
                                  value={editDept.name}
                                  onChange={(e) => setEditDept({ ...editDept, name: e.target.value })}
                                />
                                <TextField
                                  label="部门说明"
                                  labelHidden
                                  placeholder="说明（可选）"
                                  data-org-field="edit-dept-desc"
                                  value={editDept.description}
                                  onChange={(e) => setEditDept({ ...editDept, description: e.target.value })}
                                />
                                <Button
                                  variant="primary"
                                  size="sm"
                                  status={busy === "save-dept" ? "loading" : "idle"}
                                  data-org-action="save-dept"
                                  onClick={() => void saveDepartment()}
                                >
                                  保存
                                </Button>
                                <Button variant="ghost" size="sm" data-org-action="cancel-dept" onClick={() => setEditDept(null)}>
                                  取消
                                </Button>
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="org-muted" data-org-dept-empty>
                      还没有部门。先创建部门，再给成员分配归属。
                    </p>
                  )}
                </section>

                {/* ── 成员 ─────────────────────────────────────────── */}
                <section className="org-detail-pane" aria-label="成员列表">
                  <div className="org-pane-head">
                    <h2 className="org-pane-title">成员</h2>
                    <span className="org-muted" data-org-user-count>
                      {selectedDeptId ? "筛选 " + departmentName(departments, selectedDeptId) + " · " : ""}
                      {members.length} 人
                    </span>
                  </div>
                  <div className="org-form">
                    <TextField
                      label="登录标识"
                      labelHidden
                      placeholder="登录标识（至少 2 个字符）"
                      data-org-field="user-identifier"
                      value={userForm.identifier}
                      onChange={(e) => setUserForm({ ...userForm, identifier: e.target.value })}
                    />
                    <TextField
                      label="显示名"
                      labelHidden
                      placeholder="显示名"
                      data-org-field="user-display"
                      value={userForm.displayName}
                      onChange={(e) => setUserForm({ ...userForm, displayName: e.target.value })}
                    />
                    <TextField
                      label="初始口令"
                      labelHidden
                      type="password"
                      placeholder="初始口令（至少 8 位）"
                      data-org-field="user-password"
                      value={userForm.password}
                      onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
                    />
                    <label className="org-field">
                      <span>部门</span>
                      <select
                        data-org-field="user-department"
                        aria-label="成员部门"
                        value={userForm.departmentId}
                        onChange={(e) => setUserForm({ ...userForm, departmentId: e.target.value })}
                      >
                        <option value="">（不分配）</option>
                        {activeDepartments.map((d) => (
                          <option key={String(d.id)} value={String(d.id)}>
                            {asText(d.name, String(d.id))}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="org-field">
                      <span>角色</span>
                      <select
                        data-org-field="user-role"
                        aria-label="成员角色"
                        value={userForm.role}
                        onChange={(e) => setUserForm({ ...userForm, role: e.target.value })}
                      >
                        {ORG_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {roleLabel(r)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Button
                      variant="primary"
                      size="sm"
                      status={busy === "create-user" ? "loading" : "idle"}
                      disabled={!canManage}
                      data-org-action="create-user"
                      onClick={() => void createUser()}
                    >
                      创建成员
                    </Button>
                  </div>
                  <p className="org-muted" data-org-role-hint>
                    部门管理员必须选择部门；超级管理员与成员可以不分配部门。
                  </p>
                  {members.length ? (
                    <ul className="org-list" data-org-users>
                      {members.map((u) => {
                        const id = String(u.id);
                        const role = normalizeRole(u.role);
                        const disabled = String(u.status).toLowerCase() === "disabled";
                        const deptIds = Array.isArray(u.departmentIds) ? (u.departmentIds as unknown[]) : [];
                        return (
                          <li key={id} data-org-user={id}>
                            <div className="org-row">
                              <span className="org-row__body">
                              <span className="org-row__top">
                                <strong data-org-user-name>{asText(u.displayName || u.username, id)}</strong>
                                <span data-org-user-status>
                                  <Badge tone={userStatusTone(u.status)} className="org-status">
                                    {userStatusLabel(u.status)}
                                  </Badge>
                                </span>
                              </span>
                              <span className="org-row__facts">
                                <span data-org-user-role>{roleLabel(role)}</span>
                                <span data-org-user-dept>
                                  {deptIds.map((d) => departmentName(departments, d)).join("、") || "未分配部门"}
                                </span>
                                <span className="org-mono">{asText(u.username, id)}</span>
                              </span>
                              <span className="org-row__desc">{rolePrivilegeText(role)}</span>
                              </span>
                              <span className="org-row__actions">
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  disabled={!canManage}
                                  data-org-user-edit={id}
                                  onClick={() =>
                                    setEditUser(
                                      editUser && editUser.userId === id
                                        ? null
                                        : {
                                            userId: id,
                                            username: asText(u.username, ""),
                                            departmentId: deptIds.length ? String(deptIds[0]) : "",
                                            role,
                                            status: disabled ? "disabled" : "active",
                                          },
                                    )
                                  }
                                >
                                  编辑
                                </Button>
                                <Button variant="ghost" size="sm" disabled={!canManage} data-org-user-toggle={id} onClick={() => void toggleUser(u)}>
                                  {disabled ? "启用" : "禁用"}
                                </Button>
                                <Button variant="secondary" size="sm" disabled={!canManage} data-org-user-reset={id} onClick={() => setConfirm({ kind: "user-reset", id, name: asText(u.username, id) })}>
                                  重置密码
                                </Button>
                                <Button variant="danger" size="sm" disabled={!canManage} data-org-user-delete={id} onClick={() => setConfirm({ kind: "user-delete", id, name: asText(u.username, id) })}>
                                  删除
                                </Button>
                              </span>
                            </div>
                            {editUser && editUser.userId === id ? (
                              <div className="org-edit" data-org-edit-user={id}>
                                <TextField
                                  label="登录标识"
                                  labelHidden
                                  placeholder="登录标识"
                                  data-org-field="edit-username"
                                  value={editUser.username}
                                  onChange={(e) => setEditUser({ ...editUser, username: e.target.value })}
                                />
                                <label className="org-field">
                                  <span>部门</span>
                                  <select
                                    data-org-field="edit-department"
                                    aria-label="成员部门"
                                    value={editUser.departmentId}
                                    onChange={(e) => setEditUser({ ...editUser, departmentId: e.target.value })}
                                  >
                                    <option value="">（不分配）</option>
                                    {activeDepartments.map((d) => (
                                      <option key={String(d.id)} value={String(d.id)}>
                                        {asText(d.name, String(d.id))}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label className="org-field">
                                  <span>角色</span>
                                  <select
                                    data-org-field="edit-role"
                                    aria-label="成员角色"
                                    value={editUser.role}
                                    onChange={(e) => setEditUser({ ...editUser, role: e.target.value })}
                                  >
                                    {ORG_ROLES.map((r) => (
                                      <option key={r} value={r}>
                                        {roleLabel(r)}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <Button
                                  variant="primary"
                                  size="sm"
                                  status={busy === "save-user" ? "loading" : "idle"}
                                  data-org-action="save-user"
                                  onClick={() => void saveUser()}
                                >
                                  保存
                                </Button>
                                <Button variant="ghost" size="sm" data-org-action="cancel-user" onClick={() => setEditUser(null)}>
                                  取消
                                </Button>
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="org-muted" data-org-user-empty>
                      {selectedDeptId ? "该部门下还没有成员。" : "还没有成员。创建后即可分配角色与部门。"}
                    </p>
                  )}
                </section>
              </div>
            )
          ) : null}

          {section === "app" ? (
            state === "loading" || state === "error" || state === "unauthorized" || state === "unavailable" || state === "empty" ? (
              stateBlock(state, () => void loadApp(selectedUserId || undefined))
            ) : (
              <div className="org-split" data-org-pane="app">
                <section className="org-list-pane" aria-label="本地账号">
                  <div className="org-pane-head">
                    <h2 className="org-pane-title">本地账号</h2>
                    <span className="org-muted">{users.length} 人</span>
                  </div>
                  <ul className="org-list" data-org-app-users>
                    {users.map((u) => {
                      const id = String(u.id);
                      return (
                        <li key={id} data-org-app-user={id}>
                          <button
                            type="button"
                            className="org-row org-row--stack"
                            aria-pressed={selectedUserId === id}
                            data-org-app-user-select={id}
                            onClick={() => setSelectedUserId(id)}
                          >
                            <span className="org-row__top">
                              <strong>{asText(u.displayName || u.username, id)}</strong>
                              <Badge tone={userStatusTone(u.status)} className="org-status">
                                {roleLabel(u.role)}
                              </Badge>
                            </span>
                            <span className="org-row__facts">
                              <span className="org-mono">{asText(u.username, id)}</span>
                              <span>{userStatusLabel(u.status)}</span>
                            </span>
                            <span className="org-row__desc">{rolePrivilegeText(u.role)}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>

                <section className="org-detail-pane" aria-label="APP 访问详情">
                  <section className="org-section" aria-label="访问摘要" data-org-summary>
                    <div className="org-section-head">
                      <h3>访问摘要</h3>
                      <span className="org-muted">identity/app-access-summary · 当前是"能打开哪些 APP"</span>
                    </div>
                    {summary && accessSummaryRows(summary).length ? (
                      <ul className="org-list" data-org-summary-list>
                        {accessSummaryRows(summary).map((row) => (
                          <li key={row.appId} className="org-row org-row--compact" data-org-summary-app={row.appId}>
                            <span className="org-row__top">
                              <strong className="org-mono">{row.appId}</strong>
                              <Badge tone={row.allowed ? "success" : "warning"} className="org-status">
                                {row.allowed ? "允许打开" : "不允许"}
                              </Badge>
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="org-muted">没有读到访问摘要。</p>
                    )}
                  </section>

                  <section className="org-section" aria-label="APP 打开规则" data-org-rules>
                    <div className="org-section-head">
                      <h3>APP 打开规则</h3>
                      <span className="org-muted">identity/app-access-rule-save · 规则只在本机生效</span>
                    </div>
                    <ul className="org-list" data-org-app-list>
                      {snapApps.map((app) => {
                        const id = String(app.id);
                        const draft = ruleDraft[id] || { mode: "all", departmentIds: [] };
                        const locked = id === "market";
                        return (
                          <li key={id} data-org-app={id}>
                            <div className="org-row">
                              <span className="org-row__body">
                              <span className="org-row__top">
                                <strong>{asText(app.name, id)}</strong>
                                <span data-org-app-current>
                                  <Badge tone="neutral" className="org-status">
                                    {appRuleSummary(snapRules[id])}
                                  </Badge>
                                </span>
                              </span>
                              <span className="org-row__facts">
                                <span className="org-mono">{id}</span>
                                {locked ? <span>市场入口固定在全部本地账号，不可改</span> : null}
                              </span>
                              </span>
                              <span className="org-row__actions">
                                <label className="org-field">
                                  <span>打开范围</span>
                                  <select
                                    data-org-app-mode={id}
                                    aria-label={"打开范围 " + id}
                                    disabled={locked || !canManage}
                                    value={draft.mode}
                                    onChange={(e) => setRuleDraft({ ...ruleDraft, [id]: { ...draft, mode: e.target.value } })}
                                  >
                                    {ACCESS_MODES.map((m) => (
                                      <option key={m} value={m}>
                                        {accessModeLabel(m)}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                {draft.mode === "departments" ? (
                                  <span className="org-dept-picks" data-org-app-depts={id}>
                                    {departments.map((d) => (
                                      <label key={String(d.id)} className="org-pick">
                                        <input
                                          type="checkbox"
                                          data-org-app-dept={id + ":" + String(d.id)}
                                          checked={draft.departmentIds.indexOf(String(d.id)) >= 0}
                                          disabled={!canManage}
                                          onChange={() => {
                                            const cur = draft.departmentIds;
                                            const next = cur.indexOf(String(d.id)) >= 0 ? cur.filter((x) => x !== String(d.id)) : [...cur, String(d.id)];
                                            setRuleDraft({ ...ruleDraft, [id]: { ...draft, departmentIds: next } });
                                          }}
                                        />
                                        <span>{asText(d.name, String(d.id))}</span>
                                      </label>
                                    ))}
                                  </span>
                                ) : null}
                                <Button
                                  variant="primary"
                                  size="sm"
                                  disabled={locked || !canManage}
                                  status={busy === "rule:" + id ? "loading" : "idle"}
                                  data-org-action="save-rule"
                                  data-org-app-save={id}
                                  onClick={() => void saveRule(id)}
                                >
                                  保存规则
                                </Button>
                              </span>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </section>

                  <section className="org-section" aria-label="权限策略" data-org-policies>
                    <div className="org-section-head">
                      <h3>权限策略</h3>
                      <span className="org-muted">identity/app-permission-policy-save · 权限代码形如 app.&lt;app&gt;.&lt;action&gt;</span>
                    </div>
                    {Object.keys(snapPolicies).length ? (
                      <ul className="org-list" data-org-policy-list>
                        {Object.entries(snapPolicies).map(([code, policy]) => (
                          <li key={code} className="org-row org-row--compact" data-org-policy={code}>
                            <span className="org-row__top">
                              <strong className="org-mono">{code}</strong>
                              <span className="org-muted">{policySummary(policy)}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="org-muted" data-org-policy-empty>
                        当前没有已保存的权限策略。
                      </p>
                    )}
                    <div className="org-form org-form--stack">
                      <TextField
                        label="权限代码"
                        labelHidden
                        placeholder="app.<app>.<action>"
                        data-org-field="policy-code"
                        value={policyDraft.permissionCode}
                        onChange={(e) => setPolicyDraft({ ...policyDraft, permissionCode: e.target.value })}
                      />
                      <label className="org-field">
                        <span>决策</span>
                        <select
                          data-org-field="policy-decision"
                          aria-label="策略决策"
                          value={policyDraft.decision}
                          onChange={(e) => setPolicyDraft({ ...policyDraft, decision: e.target.value })}
                        >
                          {POLICY_DECISIONS.map((d) => (
                            <option key={d} value={d}>
                              {d === "allow" ? "允许" : "拒绝"}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="org-field">
                        <span>数据范围</span>
                        <select
                          data-org-field="policy-scope"
                          aria-label="数据范围"
                          value={policyDraft.dataScope}
                          onChange={(e) => setPolicyDraft({ ...policyDraft, dataScope: e.target.value })}
                        >
                          <option value="">（不声明）</option>
                          {DATA_SCOPES.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      </label>
                      <span className="org-picks" data-org-policy-roles>
                        {ORG_ROLES.map((r) => (
                          <label key={r} className="org-pick">
                            <input
                              type="checkbox"
                              data-org-policy-role={r}
                              checked={policyDraft.roles.indexOf(r) >= 0}
                              onChange={() => {
                                const next = policyDraft.roles.indexOf(r) >= 0 ? policyDraft.roles.filter((x) => x !== r) : [...policyDraft.roles, r];
                                setPolicyDraft({ ...policyDraft, roles: next });
                              }}
                            />
                            <span>{roleLabel(r)}</span>
                          </label>
                        ))}
                      </span>
                      <Button
                        variant="primary"
                        size="sm"
                        status={busy === "policy" ? "loading" : "idle"}
                        disabled={!canManage}
                        data-org-action="save-policy"
                        onClick={() => void savePolicy()}
                      >
                        保存策略
                      </Button>
                    </div>
                  </section>

                  <section className="org-section" aria-label="权限快照" data-org-snapshot>
                    <div className="org-section-head">
                      <h3>权限快照</h3>
                      <span className="org-muted">identity/app-permission-snapshot · 只读投影</span>
                    </div>
                    <dl className="org-kv">
                      <dt>APP 目录</dt>
                      <dd data-org-snapshot-apps>{snapApps.length} 个（含开发者 App）</dd>
                      <dt>打开规则</dt>
                      <dd data-org-snapshot-rules>{Object.keys(snapRules).length} 条</dd>
                      <dt>权限策略</dt>
                      <dd data-org-snapshot-policies>{Object.keys(snapPolicies).length} 条</dd>
                      <dt>权限清单</dt>
                      <dd data-org-snapshot-manifests>{snapManifests.length} 条</dd>
                      <dt>开发者 App</dt>
                      <dd data-org-snapshot-developer>
                        {snapDeveloper
                          ? snapDeveloper.available === true
                            ? "可用"
                            : "尚未接线（" + asText(snapDeveloper.code, "AGENT_DEPENDENCY_UNAVAILABLE") + "）"
                          : "—"}
                      </dd>
                    </dl>
                  </section>
                </section>
              </div>
            )
          ) : null}

          {section === "audit" ? (
            <div className="org-split" data-org-pane="audit">
              <section className="org-list-pane" aria-label="后端审计行">
                <div className="org-pane-head">
                  <h2 className="org-pane-title">后端审计行</h2>
                  <span className="org-muted" data-org-audit-count>
                    {audit.length} 条
                  </span>
                </div>
                <p className="org-muted" data-org-audit-note>
                  数据源：identity/audit-list 只读投影的后端 audit_log / authorization_audit 真实行（已去敏：
                  不含 session_ref_hash / request_id / old_permissions；按时间倒序，最多 100 条）。
                </p>
                {auditError ? (
                  <p className="org-muted" data-org-audit-failure>
                    {orgErrorText(auditError.code)}
                  </p>
                ) : null}
                {audit.length ? (
                  <ul className="org-audit-list" data-org-audit>
                    {audit.map((a, i) => (
                      <li key={i} className="org-audit-item" data-org-audit-item data-org-audit-event={a.event}>
                        <span className="org-audit-item__head">
                          <strong className="org-mono">{a.event}</strong>
                          <span data-org-audit-result={a.result}>
                            <Badge tone={a.result === "OK" ? "success" : "danger"} className="org-status">
                              {a.result === "OK" ? "成功" : "被拒绝"}
                            </Badge>
                          </span>
                        </span>
                        <span className="org-row__facts">
                          <span>{a.sources.join(" / ")}</span>
                          {a.target ? <span>目标 {a.target}</span> : null}
                          {a.errorCode ? <span className="org-mono" data-org-audit-error>{a.errorCode}</span> : null}
                          <span>{timeText(a.at)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="org-muted" data-org-audit-empty>
                    后端还没有审计记录。创建部门 / 成员或保存 APP 访问后，这里会出现真实审计行。
                  </p>
                )}
              </section>

              <section className="org-detail-pane" aria-label="身份会话事件">
                <div className="org-pane-head">
                  <h2 className="org-pane-title">身份会话事件</h2>
                  <span className="org-muted" data-org-session-count>
                    {identityEvents.length} 条
                  </span>
                </div>
                <p className="org-muted">来自 identity.onEvent（identity-service.cjs:96-106 的 P1 信封）；只读下发，不缓存凭据。</p>
                {identityEvents.length ? (
                  <ul className="org-audit-list" data-org-session-events>
                    {identityEvents.map((e, i) => (
                      <li key={i} className="org-audit-item" data-org-session-event={e.event}>
                        <span className="org-audit-item__head">
                          <strong className="org-mono">{e.event}</strong>
                          <span className="org-muted">{timeText(e.at)}</span>
                        </span>
                        <span className="org-row__facts">
                          {e.reason ? <span>原因 {e.reason}</span> : null}
                          {e.userId ? <span className="org-mono">{e.userId}</span> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="org-muted" data-org-session-empty>
                    还没有收到身份会话事件。
                  </p>
                )}
              </section>
            </div>
          ) : null}
        </div>
      </div>

      <Dialog
        open={confirm !== null}
        title={confirm && confirm.kind === "department-delete" ? "删除部门" : confirm && confirm.kind === "user-delete" ? "删除成员" : "重置口令"}
        onClose={() => {
          setConfirm(null);
          setResetPw("");
        }}
        footer={
          <>
            <Button
              variant="ghost"
              data-org-action="cancel"
              onClick={() => {
                setConfirm(null);
                setResetPw("");
              }}
            >
              取消
            </Button>
            <Button
              variant={confirm && confirm.kind === "user-reset" ? "primary" : "danger"}
              status={busy === "confirm" ? "loading" : "idle"}
              data-org-action="confirm"
              onClick={() => {
                if (!confirm) return;
                if (confirm.kind === "department-delete") void deleteDepartment();
                else if (confirm.kind === "user-delete") void deleteUser();
                else void resetPassword();
              }}
            >
              {confirm && confirm.kind === "user-reset" ? "重置" : "删除"}
            </Button>
          </>
        }
      >
        <div data-org-confirm={confirm ? confirm.kind : "none"}>
          {confirm && confirm.kind === "department-delete" ? (
            <>
              <p>将删除部门「{confirm.name}」。</p>
              <p className="org-muted">成员关系会一并解除；部门下仍有资源时后端会拒绝删除，不会级联改动资源归属。</p>
            </>
          ) : null}
          {confirm && confirm.kind === "user-delete" ? (
            <>
              <p>将删除成员「{confirm.name}」。</p>
              <p className="org-muted">删除后不可恢复；审计行会保留。系统必须保留至少一位启用的超级管理员。</p>
            </>
          ) : null}
          {confirm && confirm.kind === "user-reset" ? (
            <>
              <p>为「{confirm.name}」设置新的初始口令。</p>
              <TextField
                label="新口令"
                labelHidden
                type="password"
                placeholder="新口令（至少 8 位）"
                data-org-field="reset-password"
                value={resetPw}
                onChange={(e) => setResetPw(e.target.value)}
              />
              <p className="org-muted">重置会撤销该成员的全部会话，他需要用新口令重新登录。</p>
            </>
          ) : null}
        </div>
      </Dialog>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   状态文案
   ══════════════════════════════════════════════════════════════════════════ */
const STATE_TITLE: Record<string, string> = {
  loading: "正在读取组织数据",
  empty: "还没有可配置的账号",
  error: "组织数据读取失败",
  unauthorized: "当前会话没有治理权限",
  unavailable: "本地账号服务不可用",
};

function stateDescription(kind: string, error: Failure | null): string {
  if (kind === "loading") return "正在通过 identity 命令读取部门与成员，不会自动重试。";
  if (kind === "empty") return "本机还没有本地账号。完成首次设置后即可在这里创建部门与成员。";
  if (kind === "unauthorized") return error ? orgErrorText(error.code) : "请用超级管理员账号登录后再操作。";
  if (kind === "unavailable") return error ? orgErrorText(error.code) : "所需依赖尚未接线，操作不会产生任何变更。";
  return error ? orgErrorText(error.code) : "可以重试；失败不会改动任何数据。";
}

/** 权限快照 → 每个 APP 的规则草稿（市场入口固定为全部账号，与后端 :776-777 一致）。 */
function draftFromSnapshot(snapshot: Record<string, unknown>): Record<string, { mode: string; departmentIds: string[] }> {
  const drafts: Record<string, { mode: string; departmentIds: string[] }> = {};
  const rules = isObject(snapshot.externalAppAccess) ? (snapshot.externalAppAccess as Record<string, unknown>) : {};
  for (const app of listOf(snapshot, "apps")) {
    const id = String(app.id);
    const rule = id === "market" ? { mode: "all", departmentIds: [] as string[] } : rules[id];
    const obj = isObject(rule) ? rule : {};
    const mode = typeof obj.mode === "string" && ACCESS_MODES.indexOf(obj.mode) >= 0 ? obj.mode : "all";
    const departmentIds = Array.isArray(obj.departmentIds) ? (obj.departmentIds as unknown[]).map(String) : [];
    drafts[id] = { mode, departmentIds };
  }
  return drafts;
}

