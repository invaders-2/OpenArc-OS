/**
 * CLI 区块纯逻辑（无 DOM / 无网络）。契约冻结自任务书「二、CLI」：
 *   cli/list          {}       → { tools:[{id,name,installed,version|null,detail|null,capabilities[],loginRequired}] }
 *   cli/status        {tool}   → { tool, installed, version|null, loggedIn|null, runtime?, detail|null }
 *   cli/models        {tool}   → { tool, models:[{id,name}], cached? }
 *   cli/credit        {tool}   → { tool, credit }
 *   cli/login/start   {tool}   → { tool, started:true, url?, code?, detail }
 *   cli/login/status  {tool}   → { tool, status:"idle"|"pending"|"authorized"|"failed", detail }
 *   cli/logout        {tool}   → { tool, loggedOut:true }
 *
 * 界面不出现原始错误码：文案全中文，原始码只留在 data-cli-error-code 属性里。
 */

export interface CliRuntime {
  command?: string | null;
  mode?: string | null;
  home?: string | null;
  label?: string | null;
  provider?: string | null;
}

export interface CliTool {
  id: string;
  name: string;
  installed: boolean;
  version: string | null;
  detail: string | null;
  capabilities: string[];
  loginRequired: boolean;
  runtime: CliRuntime | null;
}

export type CliLoginState = "idle" | "pending" | "authorized" | "failed";
export type CliTone = "neutral" | "success" | "warning" | "danger";

export interface CliStatusView {
  label: string;
  tone: CliTone;
  detail: string;
}

import { t } from "../i18n/index.ts";

/** 冻结错误码 → 中文文案。原始码不上屏（只进 data-*）；英文经 t() 覆盖。 */
export const CLI_ERROR_TEXT: Readonly<Record<string, string>> = {
  CLI_COMMAND_NOT_ALLOWED: "这个 CLI 命令不在允许清单里",
  CLI_NOT_READY: "CLI 后端还没有就绪",
  CLI_INVALID_INPUT: "参数不完整或格式不对",
  CLI_UNAVAILABLE: "本机找不到这个 CLI，很可能还没有安装",
  CLI_UNSUPPORTED: "当前的 CLI 版本不支持这个能力",
  CLI_FAILED: "CLI 执行失败",
  DXOS_ERR_INTERNAL: "内部错误",
  // 渲染层自身的两种状态（不是后端错误码，但同样给中文，不裸奔）。
  NO_BRIDGE: "CLI 通道还没有接入（当前版本未提供 CLI 桥）",
  MALFORMED_REPLY: "CLI 后端回包缺字段，界面不猜测内容",
};

export function cliErrorText(code: unknown): string {
  const key = String(code ?? "").trim();
  if (!key) return t("CLI 操作失败（后端没有返回错误码）");
  return t(CLI_ERROR_TEXT[key] ?? "CLI 操作失败（后端返回了未登记的错误码）");
}

const CLI_STATUS_VIEW: Readonly<Record<CliLoginState, CliStatusView>> = {
  idle: { label: "未开始", tone: "neutral", detail: "还没有发起登录。" },
  pending: {
    label: "等待授权",
    tone: "warning",
    detail: "已经发起登录：请按上面给出的链接或口令完成授权，然后点「检查登录状态」，不要当作已登录。",
  },
  authorized: { label: "已登录", tone: "success", detail: "CLI 已授权，可以直接使用。" },
  failed: { label: "登录失败", tone: "danger", detail: "上一次登录没有成功；可以重新发起，或先登出再登录。" },
};

/** 四态映射；未登记状态不猜语义。 */
export function cliStatusView(status: unknown): CliStatusView & { state: CliLoginState | null } {
  const value = String(status ?? "").trim().toLowerCase();
  if (value === "idle" || value === "pending" || value === "authorized" || value === "failed") {
    return { state: value, label: t(CLI_STATUS_VIEW[value].label), tone: CLI_STATUS_VIEW[value].tone, detail: t(CLI_STATUS_VIEW[value].detail) };
  }
  return {
    state: null,
    label: t("未知状态"),
    tone: "neutral",
    detail: t("后端返回了未登记的登录状态，界面不猜测它的含义。"),
  };
}

export function cliLoggedInText(loggedIn: unknown): string {
  if (loggedIn === true) return t("已登录");
  if (loggedIn === false) return t("未登录");
  return t("未返回");
}

export function cliInstalledText(installed: unknown): string {
  return installed === true ? t("已安装") : installed === false ? t("未安装") : t("状态未返回");
}

/** 「怎么装」的执行提示：未安装时绝不空白。只登记确有把握的包管理器命令，其余给通用步骤。 */
const CLI_INSTALL_HINTS: Readonly<Record<string, string>> = {
  codex: "在终端执行 npm install -g @openai/codex（需要 Node.js），再用 codex --version 确认能运行。",
  gemini: "在终端执行 npm install -g @google/gemini-cli，再用 gemini --version 确认能运行。",
  claude: "在终端执行 npm install -g @anthropic-ai/claude-code，再用 claude --version 确认能运行。",
};

export function cliInstallHint(tool: Partial<CliTool> | null | undefined): string {
  const id = String(tool?.id ?? "").trim().toLowerCase().replace(/^cli:/, "");
  const known = CLI_INSTALL_HINTS[id];
  if (known) return t(known);
  const command = String(tool?.runtime?.command ?? "").trim() || id || "该工具的命令";
  const name = String(tool?.name ?? "").trim() || id || "该 CLI";
  return t("在终端安装 {name} 的命令行工具（命令：{command}），确认直接运行不报错后回到这里点「重新读取」。OpenArc 不会替你安装任何软件。", { name, command });
}

function pickValue(reply: any, key: string): any {
  if (!reply || typeof reply !== "object") return undefined;
  if (reply[key] !== undefined) return reply[key];
  if (reply.value && typeof reply.value === "object" && reply.value[key] !== undefined) return reply.value[key];
  return undefined;
}

/** 单个工具条目：字段缺失时不补造（installed 缺省按 false，version/detail 缺省 null）。 */
export function normalizeCliTool(raw: any): CliTool {
  const value = raw && typeof raw === "object" ? raw : {};
  const capabilities = Array.isArray(value.capabilities)
    ? value.capabilities.map((item: unknown) => String(item)).filter((item: string) => item.length > 0)
    : [];
  return {
    id: String(value.id ?? value.tool ?? "").trim(),
    name: String(value.name ?? value.id ?? value.tool ?? "").trim(),
    installed: value.installed === true,
    version: value.version == null || value.version === "" ? null : String(value.version),
    detail: value.detail == null || value.detail === "" ? null : String(value.detail),
    capabilities,
    loginRequired: value.loginRequired === true,
    runtime: value.runtime && typeof value.runtime === "object" ? value.runtime : null,
  };
}

/** cli/list 回包投影：只在真的有 tools 数组时才认；缺字段如实标 problem。 */
export function normalizeCliList(reply: any): { tools: CliTool[]; problem: string | null } {
  if (!reply || reply.ok !== true) {
    return { tools: [], problem: cliErrorText(reply && reply.error ? reply.error : "MALFORMED_REPLY") };
  }
  const raw = pickValue(reply, "tools");
  if (!Array.isArray(raw)) return { tools: [], problem: cliErrorText("MALFORMED_REPLY") };
  const tools = raw.map(normalizeCliTool).filter((tool) => tool.id.length > 0);
  return { tools, problem: null };
}

export function formatCliValue(value: unknown): string {
  if (value == null || value === "") return t("未返回");
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** cli/models 回包投影：id/name 逐条如实展开，不做模型名推断。 */
export function normalizeCliModels(reply: any): { models: { id: string; name: string }[]; cached: boolean | null } {
  const raw = pickValue(reply, "models");
  const models = Array.isArray(raw)
    ? raw
        .map((item: any) => {
          if (typeof item === "string") return { id: item, name: item };
          if (!item || typeof item !== "object") return null;
          const id = String(item.id ?? item.model ?? "").trim();
          if (!id) return null;
          return { id, name: String(item.name ?? item.label ?? id) };
        })
        .filter((item: any): item is { id: string; name: string } => item !== null)
    : [];
  const cachedRaw = pickValue(reply, "cached");
  return { models, cached: typeof cachedRaw === "boolean" ? cachedRaw : null };
}
