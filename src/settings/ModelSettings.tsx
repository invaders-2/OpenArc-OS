import { useCallback, useEffect, useState } from "react";
import { Button } from "../design-system/primitives";

/** D4-01 Closure C · Settings → Models / AI（只经 window.openarc.model.command；credential write-only）。 */
type ModelBridge = { command: (c: Record<string, unknown>) => Promise<any> };
const bridge = (): ModelBridge | undefined => (window as any).openarc?.model;
type Tab = "providers" | "models" | "defaults";

export function ModelSettings({ role }: { role: string | null }) {
  const [tab, setTab] = useState<Tab>("providers");
  const [providers, setProviders] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [defaults, setDefaults] = useState<any>(null);
  const [credStatus, setCredStatus] = useState<Record<string, any>>({});
  const [tests, setTests] = useState<Record<string, any>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pForm, setPForm] = useState({ displayName: "", baseUrl: "", endpointScope: "LOCALHOST", scope: "PERSONAL", credentialSecret: "" });
  const [mForm, setMForm] = useState({ providerId: "", remoteModelId: "", displayName: "", capabilities: ["chat"], scope: "PERSONAL" });
  const [credDraft, setCredDraft] = useState<Record<string, string>>({});

  const cmd = useCallback(async (command: string, payload: Record<string, unknown> = {}): Promise<any> => {
    const b = bridge();
    if (!b) return { ok: false, error: "NO_BRIDGE" };
    try { return await b.command({ command, payload }); } catch { return { ok: false, error: "INTERNAL_ERROR" }; }
  }, []);

  const load = useCallback(async () => {
    setBusy(true); setError(null);
    const [p, m, d] = await Promise.all([cmd("provider/list"), cmd("model/list"), cmd("defaults/get")]);
    if (p.ok) setProviders(p.items); else setError(p.error);
    if (m.ok) setModels(m.items); else setError(m.error);
    if (d.ok) setDefaults(d); else setError(d.error);
    if (p.ok) {
      const entries = await Promise.all(p.items.map(async (it: any) => [it.providerId, await cmd("credential/status", { providerId: it.providerId })] as const));
      setCredStatus(Object.fromEntries(entries));
    }
    setBusy(false);
  }, [cmd]);
  useEffect(() => { void load(); }, [load]);

  const createProvider = async () => {
    const payload: Record<string, unknown> = { displayName: pForm.displayName, baseUrl: pForm.baseUrl, endpointScope: pForm.endpointScope, scope: pForm.scope };
    if (pForm.credentialSecret) payload.credentialSecret = pForm.credentialSecret;
    const res = await cmd("provider/create", payload);
    if (res.ok) { setNotice("Provider created"); setPForm({ displayName: "", baseUrl: "", endpointScope: "LOCALHOST", scope: "PERSONAL", credentialSecret: "" }); await load(); }
    else setError(res.error);
  };
  const setProviderStatus = async (providerId: string, status: string) => { const r = await cmd("provider/setStatus", { providerId, status }); if (!r.ok) setError(r.error); await load(); };
  const saveCred = async (providerId: string, replace: boolean) => {
    const secret = credDraft[providerId] || "";
    if (!secret) return;
    const r = await cmd(replace ? "credential/replace" : "credential/set", { providerId, secret });
    if (r.ok) { setNotice(replace ? "Credential replaced" : "Credential saved"); setCredDraft((prev) => ({ ...prev, [providerId]: "" })); await load(); }
    else setError(r.error);
  };
  const deleteCred = async (providerId: string) => { const r = await cmd("credential/delete", { providerId }); if (r.ok) await load(); else setError(r.error); };
  const runTest = async (providerId: string) => {
    const config = models.find((m) => m.providerId === providerId);
    if (!config) { setError("NO_MODEL_FOR_PROVIDER"); return; }
    const r = await cmd("model/test", { configId: config.configId });
    setTests((prev) => ({ ...prev, [providerId]: r }));
    if (!r.ok && r.error) setError(r.error);
  };
  const testLabel = (t: any) => {
    if (!t) return "";
    return "Endpoint:" + (t.reachable === false ? "FAIL" : "PASS") +
      " Credential:" + (t.credentialAccepted === false ? "FAIL" : "PASS") +
      " Model:" + (t.ok ? "PASS" : "FAIL") +
      " Inference:" + (t.inference ? "PASS" : "FAIL") +
      " Capabilities:" + ((t.verifiedCapabilities && t.verifiedCapabilities.length) ? t.verifiedCapabilities.join(",") : "NOT VERIFIED");
  };
  const createModel = async () => {
    const r = await cmd("model/create", { providerId: mForm.providerId, remoteModelId: mForm.remoteModelId, displayName: mForm.displayName, capabilities: mForm.capabilities, scope: mForm.scope });
    if (r.ok) { setNotice("Model registered"); await load(); } else setError(r.error);
  };
  const setModelStatus = async (configId: string, status: string) => { const r = await cmd("model/setStatus", { configId, status }); if (!r.ok) setError(r.error); await load(); };
  const setDefault = async (capability: string, configId: string, scope: string) => { if (!configId) return; const r = await cmd("defaults/set", { capability, configId, scope }); if (!r.ok) setError(r.error); else { setNotice("Default saved"); await load(); } };
  const credLabel = (providerId: string) => { const c = credStatus[providerId]; if (!c) return "..."; if (c.manageable === false) return "—"; if (!c.storeAvailable) return "Unavailable"; return c.configured ? "Configured" : "Missing"; };
  const opts = (cap: string) => models.filter((m) => m.capabilities.includes(cap)).map((m) => <option key={m.configId} value={m.configId}>{m.displayName || m.remoteModelId}</option>);

  return (
    <div className="d401-settings" data-d4-01="settings">
      <h3>模型 / AI</h3>
      <nav className="d401-tabs" role="tablist" aria-label="模型设置分区">
        {(["providers", "models", "defaults"] as Tab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} data-d4-01-tab={t} onClick={() => setTab(t)}>
            {{ providers: "Providers", models: "Models", defaults: "Defaults" }[t]}
          </button>
        ))}
      </nav>
      {error ? <p className="d401-error" role="alert" data-d4-01-error>{error}</p> : null}
      {notice ? <p className="d401-notice" role="status" data-d4-01-notice>{notice}</p> : null}
      {busy ? <p className="muted" data-d4-01-busy>...</p> : null}

      {tab === "providers" ? (
        <section data-d4-01-pane="providers">
          <div className="d401-form">
            <input data-d4-01-provider-name aria-label="Provider display name" placeholder="Display Name" value={pForm.displayName} onChange={(e) => setPForm({ ...pForm, displayName: e.target.value })} />
            <input data-d4-01-provider-url aria-label="Provider base URL" placeholder="Base URL" value={pForm.baseUrl} onChange={(e) => setPForm({ ...pForm, baseUrl: e.target.value })} />
            <select data-d4-01-provider-scope aria-label="Provider scope" value={pForm.scope} onChange={(e) => setPForm({ ...pForm, scope: e.target.value })}>
              <option value="PERSONAL">PERSONAL</option>
              <option value="ORGANIZATION">ORGANIZATION</option>
            </select>
            <input data-d4-01-provider-secret aria-label="Provider API key" type="password" placeholder="API Key" value={pForm.credentialSecret} onChange={(e) => setPForm({ ...pForm, credentialSecret: e.target.value })} />
            <Button variant="primary" size="sm" data-d4-01-provider-create onClick={() => void createProvider()}>创建 Provider</Button>
          </div>
          {providers.length === 0 ? <p className="muted" data-d4-01-providers-empty>No model providers configured</p> : null}
          <ul className="d401-list" data-d4-01-providers>
            {providers.map((p) => (
              <li key={p.providerId} data-d4-01-provider={p.providerId} className="d401-row">
                <span className="d401-name">{p.displayName}</span>
                <span className="d401-meta">{p.adapterType} | {p.baseUrl} | {p.endpointScope} | {p.scope}</span>
                <span className="d401-meta" data-d4-01-provider-status>{p.status}</span>
                <span className="d401-meta" data-d4-01-cred-status={p.providerId}>{credLabel(p.providerId)}</span>
                <input data-d4-01-cred-input={p.providerId} aria-label={"API key for " + p.displayName} type="password" placeholder="API Key" value={credDraft[p.providerId] || ""} onChange={(e) => setCredDraft({ ...credDraft, [p.providerId]: e.target.value })} />
                <Button variant="secondary" size="sm" data-d4-01-cred-set={p.providerId} onClick={() => void saveCred(p.providerId, false)}>保存</Button>
                <Button variant="secondary" size="sm" data-d4-01-cred-replace={p.providerId} onClick={() => void saveCred(p.providerId, true)}>替换</Button>
                <Button variant="ghost" size="sm" data-d4-01-cred-delete={p.providerId} onClick={() => void deleteCred(p.providerId)}>删除密钥</Button>
                <Button variant="ghost" size="sm" data-d4-01-test={p.providerId} onClick={() => void runTest(p.providerId)}>连接测试</Button>
                {p.status === "enabled"
                  ? <Button variant="ghost" size="sm" data-d4-01-provider-disable={p.providerId} onClick={() => void setProviderStatus(p.providerId, "disabled")}>禁用</Button>
                  : <Button variant="secondary" size="sm" data-d4-01-provider-enable={p.providerId} onClick={() => void setProviderStatus(p.providerId, "enabled")}>启用</Button>}
                {tests[p.providerId] ? <span className="d401-test" data-d4-01-test-result={p.providerId}>{testLabel(tests[p.providerId])}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {tab === "models" ? (
        <section data-d4-01-pane="models">
          <div className="d401-form">
            <select data-d4-01-model-provider aria-label="Model provider" value={mForm.providerId} onChange={(e) => setMForm({ ...mForm, providerId: e.target.value })}>
              <option value="">选择 Provider</option>
              {providers.map((p) => <option key={p.providerId} value={p.providerId}>{p.displayName}</option>)}
            </select>
            <input data-d4-01-model-remote aria-label="Remote model ID" placeholder="Remote Model ID" value={mForm.remoteModelId} onChange={(e) => setMForm({ ...mForm, remoteModelId: e.target.value })} />
            <input data-d4-01-model-name aria-label="Model display name" placeholder="Display Name" value={mForm.displayName} onChange={(e) => setMForm({ ...mForm, displayName: e.target.value })} />
            <select data-d4-01-model-scope aria-label="Model scope" value={mForm.scope} onChange={(e) => setMForm({ ...mForm, scope: e.target.value })}>
              <option value="PERSONAL">PERSONAL</option>
              <option value="ORGANIZATION">ORGANIZATION</option>
            </select>
            <Button variant="primary" size="sm" data-d4-01-model-create onClick={() => void createModel()}>注册 Model</Button>
          </div>
          {models.length === 0 ? <p className="muted" data-d4-01-models-empty>No models configured</p> : null}
          <ul className="d401-list" data-d4-01-models>
            {models.map((m) => (
              <li key={m.configId} data-d4-01-model={m.configId} className="d401-row">
                <span className="d401-name">{m.displayName || m.remoteModelId}</span>
                <span className="d401-meta">{m.remoteModelId} | {m.scope} | v{m.version} | {m.status}</span>
                <span className="d401-meta" data-d4-01-model-declared={m.configId}>Declared: {m.capabilities.join(", ") || "-"}</span>
                <span className="d401-meta" data-d4-01-model-verified={m.configId}>Verified: {m.verifiedCapabilities.join(", ") || "-"}</span>
                {m.status === "enabled"
                  ? <Button variant="ghost" size="sm" data-d4-01-model-disable={m.configId} onClick={() => void setModelStatus(m.configId, "disabled")}>禁用</Button>
                  : <Button variant="secondary" size="sm" data-d4-01-model-enable={m.configId} onClick={() => void setModelStatus(m.configId, "enabled")}>启用</Button>}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {tab === "defaults" && defaults ? (
        <section data-d4-01-pane="defaults">
          <div className="d401-defaults" data-d4-01-defaults-personal>
            <h4>My Defaults</h4>
            <label>Chat <select data-d4-01-default-personal-chat value={defaults.personal.chat || ""} onChange={(e) => void setDefault("chat", e.target.value, "PERSONAL")}><option value="">No default configured</option>{opts("chat")}</select></label>
            <label>Tool Calling <select data-d4-01-default-personal-tool value={defaults.personal["tool-calling"] || ""} onChange={(e) => void setDefault("tool-calling", e.target.value, "PERSONAL")}><option value="">No default configured</option>{opts("tool-calling")}</select></label>
          </div>
          <div className="d401-defaults" data-d4-01-defaults-organization>
            <h4>Organization Defaults {defaults.canManageOrganization ? null : <span className="muted">(read-only)</span>}</h4>
            <label>Chat <select data-d4-01-default-org-chat value={defaults.organization.chat || ""} onChange={(e) => void setDefault("chat", e.target.value, "ORGANIZATION")}><option value="">No default configured</option>{opts("chat")}</select></label>
            <label>Tool Calling <select data-d4-01-default-org-tool value={defaults.organization["tool-calling"] || ""} onChange={(e) => void setDefault("tool-calling", e.target.value, "ORGANIZATION")}><option value="">No default configured</option>{opts("tool-calling")}</select></label>
          </div>
          {role !== "ADMIN" ? <p className="muted" data-d4-01-org-hint>Organization defaults require an authorized admin.</p> : null}
        </section>
      ) : null}
    </div>
  );
}
