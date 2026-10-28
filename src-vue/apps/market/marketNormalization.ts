export type IntegrationDep = { id: string; kind: string; label: string; required: boolean; status: string; detail: string };
export type IntegrationPlugin = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  status: string;
  dependencies: IntegrationDep[];
  missingRequired: string[];
  detail: string;
};
export type ThirdApp = {
  id: string;
  name: string;
  version: string;
  packageUrl: string | null;
  packageFile: string | null;
  sha256: string;
  size: number | null;
  minSystemVersion: string | null;
  maxSystemVersion: string | null;
  entry: string | null;
  description: string | null;
  author: string | null;
  homepage: string | null;
  source: "local" | "online";
};
export type ThirdRejected = { id: string | null; reason: string };
export type ThirdInstalled = {
  id: string;
  name: string | null;
  version: string | null;
  status: string;
  source: string | null;
  installedAt: number | null;
  currentVersion: string | null;
  effectiveSource: string;
};
export type ThirdCatalog = { present: boolean; ok: boolean; apps: ThirdApp[]; rejected: ThirdRejected[]; error: string | null; detail: string | null };
export type ThirdOnline = { configured: boolean; ok: boolean; apps: ThirdApp[]; rejected: ThirdRejected[]; error: string | null; detail: string | null };
export type ThirdList = { systemVersion: string; local: ThirdCatalog; online: ThirdOnline; installed: ThirdInstalled[] };
export type ThirdHealth = {
  ok: boolean;
  effectiveSource: string;
  installedLoadable: boolean;
  loader: string | null;
  loadUrl: string | null;
  fallbackReason: string | null;
  installed: { version: string | null; digest: string | null; kind: string | null; entry: string | null; reason: string | null; detail: string | null } | null;
  error: string | null;
  detail: string | null;
};
export type MarketSkill = {
  id: string;
  name?: string;
  description?: string;
  origin?: string;
  builtin?: boolean;
  layer?: string;
  kind?: string;
  enabled?: boolean;
  systemPrompt?: string;
  exposure?: string;
  source?: { instructions?: string; files?: { path?: string; content?: string }[] };
  v2?: { inputs?: string[]; output?: string; steps?: { title?: string; detail?: string }[] };
};

export const asText = (value: unknown): string => (typeof value === "string" ? value : "");
export const asNum = (value: unknown): number | null => (Number.isFinite(Number(value)) ? Number(value) : null);

export function normalizeIntegrationPlugin(raw: any): IntegrationPlugin | null {
  if (!raw || typeof raw !== "object") return null;
  const id = asText(raw.id);
  if (!id) return null;
  const deps = Array.isArray(raw.dependencies) ? raw.dependencies : [];
  return {
    id,
    name: asText(raw.name) || id,
    description: asText(raw.description),
    enabled: raw.enabled === true,
    status: asText(raw.status) || "disabled",
    dependencies: deps.filter((entry: any) => entry && typeof entry === "object").map((entry: any) => ({
      id: asText(entry.id), kind: asText(entry.kind), label: asText(entry.label), required: entry.required === true,
      status: asText(entry.status) || "unknown", detail: asText(entry.detail),
    })),
    missingRequired: (Array.isArray(raw.missingRequired) ? raw.missingRequired : []).map(asText).filter(Boolean),
    detail: asText(raw.detail),
  };
}

export function normalizeThirdApp(raw: any, source: "local" | "online"): ThirdApp | null {
  if (!raw || typeof raw !== "object") return null;
  const id = asText(raw.id);
  if (!id) return null;
  return {
    id,
    name: asText(raw.name) || id,
    version: asText(raw.version) || "—",
    packageUrl: asText(raw.packageUrl) || null,
    packageFile: asText(raw.packageFile) || null,
    sha256: asText(raw.sha256),
    size: asNum(raw.size),
    minSystemVersion: asText(raw.minSystemVersion) || null,
    maxSystemVersion: asText(raw.maxSystemVersion) || null,
    entry: asText(raw.entry) || null,
    description: asText(raw.description) || null,
    author: asText(raw.author) || null,
    homepage: asText(raw.homepage) || null,
    source: raw.source === "online" ? "online" : source,
  };
}
export function normalizeRejected(raw: any, unknownReason = "原因未知"): ThirdRejected[] {
  return (Array.isArray(raw) ? raw : []).filter((item) => item && typeof item === "object").map((item: any) => ({ id: asText(item.id) || null, reason: asText(item.reason) || unknownReason }));
}
export function normalizeThirdList(raw: any, unknownReason = "原因未知"): ThirdList {
  const box = raw && typeof raw === "object" ? raw : {};
  const local = box.local && typeof box.local === "object" ? box.local : {};
  const online = box.online && typeof box.online === "object" ? box.online : {};
  return {
    systemVersion: asText(box.systemVersion) || "—",
    local: {
      present: local.present === true,
      ok: local.ok === true,
      apps: (Array.isArray(local.apps) ? local.apps : []).map((app: any) => normalizeThirdApp(app, "local")).filter(Boolean) as ThirdApp[],
      rejected: normalizeRejected(local.rejected, unknownReason),
      error: asText(local.error) || null,
      detail: asText(local.detail) || null,
    },
    online: {
      configured: online.configured === true,
      ok: online.ok === true,
      apps: (Array.isArray(online.apps) ? online.apps : []).map((app: any) => normalizeThirdApp(app, "online")).filter(Boolean) as ThirdApp[],
      rejected: normalizeRejected(online.rejected, unknownReason),
      error: asText(online.error) || null,
      detail: asText(online.detail) || null,
    },
    installed: (Array.isArray(box.installed) ? box.installed : []).map((item: any) => ({
      id: asText(item.id),
      name: asText(item.name) || null,
      version: asText(item.version) || null,
      status: asText(item.status) || "installed",
      source: asText(item.source) || null,
      installedAt: asNum(item.installedAt),
      currentVersion: asText(item.currentVersion) || null,
      effectiveSource: asText(item.effectiveSource) || "builtin",
    })).filter((item: ThirdInstalled) => !!item.id),
  };
}
export function normalizeHealth(raw: any): ThirdHealth {
  const box = raw && typeof raw === "object" ? raw : {};
  const installed = box.installed && typeof box.installed === "object" ? box.installed : null;
  return {
    ok: box.ok !== false,
    effectiveSource: asText(box.effectiveSource) || "builtin",
    installedLoadable: box.installedLoadable === true,
    loader: asText(box.loader) || null,
    loadUrl: asText(box.loadUrl) || null,
    fallbackReason: asText(box.fallbackReason) || null,
    installed: installed ? {
      version: asText(installed.version) || null,
      digest: asText(installed.digest) || null,
      kind: asText(installed.kind) || null,
      entry: asText(installed.entry) || null,
      reason: asText(installed.reason) || null,
      detail: asText(installed.detail) || null,
    } : null,
    error: asText(box.error) || null,
    detail: asText(box.detail) || null,
  };
}
export function normalizeMarketSkill(raw: unknown): MarketSkill | null {
  if (!raw || typeof raw !== "object") return null;
  const box = raw as Record<string, unknown>;
  const id = typeof box.id === "string" ? box.id : "";
  if (!id) return null;
  return {
    id,
    name: typeof box.name === "string" ? box.name : "",
    description: typeof box.description === "string" ? box.description : "",
    origin: typeof box.origin === "string" ? box.origin : "",
    builtin: box.builtin === true,
    layer: typeof box.layer === "string" ? box.layer : "",
    kind: typeof box.kind === "string" ? box.kind : "",
    exposure: typeof box.exposure === "string" ? box.exposure : "",
    enabled: box.enabled !== false,
    systemPrompt: typeof box.systemPrompt === "string" ? box.systemPrompt : "",
    source: box.source && typeof box.source === "object" ? (box.source as MarketSkill["source"]) : undefined,
    v2: box.v2 && typeof box.v2 === "object" ? (box.v2 as MarketSkill["v2"]) : undefined,
  };
}
