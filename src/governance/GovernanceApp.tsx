import React, { useCallback, useEffect, useState } from "react";
import { Button } from "../design-system/primitives";

/**
 * D3-04D · Organization 治理 App（真实调用 governance:command）。
 *
 * 治理 UI 不是授权权威：每个 mutation 都在主进程 GovernanceService / AuthorizationService
 * 内重新校验；本组件只负责呈现与派发受控命令。
 */
type GovBridge = { command: (c: Record<string, unknown>) => Promise<any> };
const bridge = (): GovBridge | undefined => (window as any).openarc?.governance;
type Tab = "users" | "departments" | "apps" | "audit" | "access";

export function GovernanceApp() {
  const [tab, setTab] = useState<Tab>("users");
  const [users, setUsers] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [apps, setApps] = useState<any[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ identifier: "", password: "", displayName: "", role: "MEMBER" });
  const [deptForm, setDeptForm] = useState({ name: "", description: "" });
  const [accessRef, setAccessRef] = useState("");
  const [access, setAccess] = useState<any>(null);
  const [toolAccess, setToolAccess] = useState<Record<string, any>>({});
  const [toolPick, setToolPick] = useState<Record<string, string[]>>({});

  const cmd = useCallback(async (payload: Record<string, unknown>): Promise<any> => {
    const b = bridge();
    if (!b) return { ok: false, error: "NO_BRIDGE" };
    try { return await b.command(payload); } catch { return { ok: false, error: "INTERNAL_ERROR" }; }
  }, []);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    if (tab === "users") {
      const res = await cmd({ type: "governance/listUsers" });
      if (res.ok) setUsers(res.items); else setError(res.error);
    } else if (tab === "departments") {
      const res = await cmd({ type: "governance/listDepartments" });
      if (res.ok) setDepartments(res.items); else setError(res.error);
    } else if (tab === "apps") {
      const res = await cmd({ type: "governance/listApps" });
      if (res.ok) setApps(res.items); else setError(res.error);
    } else if (tab === "audit") {
      const res = await cmd({ type: "governance/listAudit", limit: 100 });
      if (res.ok) setAudit(res.items); else setError(res.error);
    }
    setBusy(false);
  }, [cmd, tab]);

  useEffect(() => { void load(); }, [load]);

  const createUser = async () => {
    const res = await cmd({ type: "governance/createUser", ...form });
    if (res.ok) { setNotice("用户已创建"); setForm({ identifier: "", password: "", displayName: "", role: "MEMBER" }); await load(); } else setError(res.error);
  };
  const createDept = async () => {
    const res = await cmd({ type: "governance/createDepartment", ...deptForm });
    if (res.ok) { setNotice("部门已创建"); setDeptForm({ name: "", description: "" }); await load(); } else setError(res.error);
  };
  const setStatus = async (userId: string, status: string) => {
    const res = await cmd({ type: "governance/setUserStatus", userId, status });
    if (!res.ok) setError(res.error); else await load();
  };
  const toggleApp = async (appId: string, status: string) => {
    const res = await cmd({ type: "governance/setAppStatus", appId, status });
    if (!res.ok) setError(res.error); else await load();
  };
  const loadAccess = async () => {
    setAccess(null);
    const res = await cmd({ type: "governance/listResourceAccess", resourceRef: accessRef.trim() });
    if (res.ok) setAccess(res); else setError(res.error);
  };
  const loadToolAccess = async (appId: string) => {
    const res = await cmd({ type: "governance/getAppToolAccess", appId });
    if (res.ok) {
      setToolAccess((m) => ({ ...m, [appId]: res }));
      setToolPick((m) => ({ ...m, [appId]: [] }));
    } else setError(res.error);
  };
  const toggleToolPick = (appId: string, action: string) => {
    setToolPick((m) => {
      const cur = m[appId] || [];
      return { ...m, [appId]: cur.includes(action) ? cur.filter((a) => a !== action) : [...cur, action] };
    });
  };
  const grantTools = async (appId: string) => {
    const res = await cmd({ type: "governance/grantAppToolAccess", appId, actions: toolPick[appId] || [] });
    if (res.ok) { setNotice("工具权限已授予"); await loadToolAccess(appId); } else setError(res.error);
  };
  const revokeTool = async (appId: string, grantId: string) => {
    const res = await cmd({ type: "governance/revokeAppToolAccess", grantId });
    if (res.ok) { setNotice("工具权限已撤销"); await loadToolAccess(appId); } else setError(res.error);
  };

  return (
    <div className="gov" data-d3-04d="app">
      <header className="gov-head">
        <h2>组织治理</h2>
        <nav className="gov-tabs" role="tablist" aria-label="治理分区">
          {(["users", "departments", "apps", "access", "audit"] as Tab[]).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} data-d3-04d-tab={t} onClick={() => setTab(t)}>
              {{ users: "用户", departments: "部门", apps: "App 权限", access: "资源权限", audit: "审计" }[t]}
            </button>
          ))}
        </nav>
      </header>
      {error ? <p className="gov-error" role="alert" data-d3-04d-error>{error}</p> : null}
      {notice ? <p className="gov-notice" role="status">{notice}</p> : null}

      {tab === "users" ? (
        <section className="gov-pane" data-d3-04d-pane="users">
          <div className="gov-form">
            <input data-d3-04d-user-identifier placeholder="identifier" value={form.identifier} onChange={(e) => setForm({ ...form, identifier: e.target.value })} />
            <input data-d3-04d-user-display placeholder="显示名" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
            <input data-d3-04d-user-password type="password" placeholder="初始口令" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            <select data-d3-04d-user-role value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="MEMBER">MEMBER</option>
              <option value="ADMIN">ADMIN</option>
            </select>
            <Button variant="primary" size="sm" data-d3-04d-create-user onClick={() => void createUser()}>创建用户</Button>
          </div>
          <ul className="gov-list" data-d3-04d-users>
            {users.map((u) => (
              <li key={u.userId} data-d3-04d-user={u.userId} className="gov-row">
                <span className="gov-name">{u.displayName || u.identifier}</span>
                <span className="gov-meta">{u.identifier} · {u.role} · {u.status}</span>
                <span className="gov-meta">{u.departments.map((d: any) => d.name).filter(Boolean).join(", ") || "无部门"}</span>
                {u.status === "ACTIVE" ? (
                  <Button variant="ghost" size="sm" data-d3-04d-user-disable={u.userId} onClick={() => void setStatus(u.userId, "DISABLED")}>禁用</Button>
                ) : (
                  <Button variant="secondary" size="sm" data-d3-04d-user-enable={u.userId} onClick={() => void setStatus(u.userId, "ACTIVE")}>启用</Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {tab === "departments" ? (
        <section className="gov-pane" data-d3-04d-pane="departments">
          <div className="gov-form">
            <input data-d3-04d-dept-name placeholder="部门名" value={deptForm.name} onChange={(e) => setDeptForm({ ...deptForm, name: e.target.value })} />
            <input data-d3-04d-dept-desc placeholder="描述" value={deptForm.description} onChange={(e) => setDeptForm({ ...deptForm, description: e.target.value })} />
            <Button variant="primary" size="sm" data-d3-04d-create-dept onClick={() => void createDept()}>创建部门</Button>
          </div>
          <ul className="gov-list" data-d3-04d-departments>
            {departments.map((d) => (
              <li key={d.departmentId} data-d3-04d-dept={d.departmentId} className="gov-row">
                <span className="gov-name">{d.name}</span>
                <span className="gov-meta">{d.status} · 成员 {d.memberCount} · 资源 {d.resourceCount} · Collection {d.collectionCount}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {tab === "apps" ? (
        <section className="gov-pane" data-d3-04d-pane="apps">
          <ul className="gov-list" data-d3-04d-apps>
            {apps.map((a) => (
              <li key={a.appId} data-d3-04d-app={a.appId} className="gov-row">
                <span className="gov-name">{a.name} <code>{a.appId}</code></span>
                <span className="gov-meta">{a.status} · grants {a.grantCount} · Memory {a.memoryAccess ? "yes" : "no"}</span>
                {a.status === "enabled" ? (
                  <Button variant="ghost" size="sm" data-d3-04d-app-disable={a.appId} onClick={() => void toggleApp(a.appId, "disabled")}>禁用</Button>
                ) : (
                  <Button variant="secondary" size="sm" data-d3-04d-app-enable={a.appId} onClick={() => void toggleApp(a.appId, "enabled")}>启用</Button>
                )}
                <Button variant="secondary" size="sm" data-gov-tool-toggle={a.appId} onClick={() => void loadToolAccess(a.appId)}>工具权限</Button>
              </li>
            ))}
          </ul>
          {Object.entries(toolAccess).map(([appId, ta]) => (
            <div key={appId} className="gov-tool" data-gov-tool-access={appId}>
              <h3>工具权限 · {ta.app?.name || appId}</h3>
              <p className="gov-meta">TOOL scope · 默认不授予，勾选后显式授予；已授予动作只能整体撤销</p>
              <ul className="gov-list" data-gov-tool-actions>
                {(ta.availableActions || []).map((action: string) => {
                  const granted = (ta.grantedActions || []).includes(action);
                  return (
                    <li key={action} data-gov-tool-action={action} className="gov-row">
                      <label className="gov-tool-pick">
                        <input type="checkbox" checked={granted || (toolPick[appId] || []).includes(action)} disabled={granted} onChange={() => toggleToolPick(appId, action)} />
                        <code>{action}</code>
                      </label>
                      <span className="gov-meta">{granted ? "已授予" : "未授予"}</span>
                    </li>
                  );
                })}
              </ul>
              <div className="gov-form">
                <Button variant="primary" size="sm" data-gov-tool-grant={appId} onClick={() => void grantTools(appId)}>授予所选工具权限</Button>
              </div>
              <ul className="gov-list" data-gov-tool-grants>
                {(ta.grants || []).map((g: any) => (
                  <li key={g.grantId} data-gov-tool-grant-id={g.grantId} className="gov-row">
                    <span className="gov-meta">{(g.actions || []).join(", ")}{g.expiresAt ? " · " + g.expiresAt : ""}</span>
                    <Button variant="ghost" size="sm" data-gov-tool-revoke={g.grantId} onClick={() => void revokeTool(appId, g.grantId)}>撤销全部工具权限</Button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ) : null}

      {tab === "access" ? (
        <section className="gov-pane" data-d3-04d-pane="access">
          <div className="gov-form">
            <input data-d3-04d-access-ref placeholder="resource://..." value={accessRef} onChange={(e) => setAccessRef(e.target.value)} />
            <Button variant="secondary" size="sm" data-d3-04d-access-load onClick={() => void loadAccess()}>查看权限来源</Button>
          </div>
          {access ? (
            <div data-d3-04d-access>
              <p data-d3-04d-access-owner>Owner: {access.resource.ownerUserId || "-"} · Scope: {access.resource.scope} · Agent: {access.agentAccess ? "yes" : "no"}</p>
              <ul data-d3-04d-access-sources>
                {access.sources.map((s: any, i: number) => (
                  <li key={i} data-d3-04d-access-source={s.source}>{s.source} · {s.subjectType}:{s.subjectId} · {(s.actions || []).slice(0, 4).join(",")}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {tab === "audit" ? (
        <section className="gov-pane" data-d3-04d-pane="audit">
          <ul className="gov-list" data-d3-04d-audit>
            {audit.map((a, i) => (
              <li key={i} data-d3-04d-audit-item className="gov-row">
                <span className="gov-name">{a.action}</span>
                <span className="gov-meta">{a.decision} · {a.reasonCode} · actor {a.actorUserId || "-"} · {a.resourceRef || a.departmentId || "-"}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
