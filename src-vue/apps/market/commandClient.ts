export interface MarketResult {
  ok: boolean;
  value?: unknown;
  error: string;
  detail: string;
}

export interface CommandBridge {
  command: (request: { command: string; payload: Record<string, unknown> }) => Promise<unknown>;
}

type CommandOptions = { missingCode: string; missingDetail?: string; internalCode: string };

export async function commandClient(api: CommandBridge | null | undefined, command: string, payload: Record<string, unknown>, options: CommandOptions): Promise<MarketResult> {
  if (!api || typeof api.command !== "function") return { ok: false, error: options.missingCode, detail: options.missingDetail || "" };
  let raw: unknown;
  try {
    raw = await api.command({ command, payload });
  } catch (error) {
    const detail = error && typeof error === "object" ? String((error as { message?: unknown }).message || error) : String(error);
    return { ok: false, error: options.internalCode, detail };
  }
  const box = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (box.ok === true) return { ok: true, value: box.value, error: "", detail: "" };
  return { ok: false, value: box.value, error: typeof box.error === "string" ? box.error : options.internalCode, detail: typeof box.detail === "string" ? box.detail : "" };
}

export function marketCall(command: string, payload: Record<string, unknown> = {}) {
  const api = window.openarc?.marketUpdate || window.openarc?.market;
  return commandClient(api, command, payload, { missingCode: "MARKET_NOT_READY", missingDetail: "当前环境没有市场桥（只在 OpenArc 桌面应用里可用）", internalCode: "DXOS_ERR_INTERNAL" });
}
export function integrationCall(command: string, payload: Record<string, unknown> = {}) {
  return commandClient(window.openarc?.integration, command, payload, { missingCode: "BRIDGE_ABSENT", internalCode: "DXOS_ERR_INTERNAL" });
}
export function skillCall(command: string, payload: Record<string, unknown> = {}) {
  return commandClient(window.openarc?.skill, command, payload, { missingCode: "SKILL_NOT_READY", missingDetail: "当前环境没有技能桥（只在 OpenArc 桌面应用里可用）", internalCode: "SKILL_INTERNAL" });
}
