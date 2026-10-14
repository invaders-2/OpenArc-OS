/**
 * UI-1 · Skill 中心探针用挂载壳（只在 experiments 里被 esbuild 打包，不进产品构建）。
 *
 * 它做三件事：
 *   1. 复刻产品窗口里 skills 分支的真实外壳（.window > .split > .split-side 导航 + .split-main），
 *      让 SkillCenter 处于和 main.tsx:2895-2925 完全相同的 DOM 位置与容器宽度规则下；
 *   2. 装一个**假 skill 桥**（只在 window.openarc.skill 上放 command / onEvent），
 *      按 ?scenario= 返回不同的数据形状，用来离线、确定性地驱动八类状态；
 *   3. 把收到的命令与下行事件挂到 window.__oaSkillProbe，供 Playwright 断言。
 *
 * 这个桥不发任何网络请求：它就是内存里的一个 switch。
 */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SkillCenter } from "../../src/skills/SkillCenter";
import { McpCenter } from "../../src/mcp/McpCenter";
import "../../src/design-system/tokens.css";
import "../../src/design-system/primitives.css";
import "../../src/styles.css";

type Tab = "market" | "mine" | "installed";

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") || "ready";
const runMode = params.get("run") || "fast";
const importMode = params.get("import") || "ok";

const READY_SKILLS: any[] = [
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
    systemPrompt: "你是中文写作助手。按用户要求创作可直接交付的文本。",
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
    systemPrompt: "你是分析总结助手。",
  },
  {
    id: "team_report",
    name: "团队周报",
    description: "把本周记录整理成周报草稿，含下周计划。",
    kind: "procedure",
    builtin: false,
    layer: "workflow",
    origin: "imported",
    exposure: "slash",
    enabled: true,
    systemPrompt: "你是周报执行器。按工作流逐步执行。",
    v2: {
      version: 1,
      triggers: ["周报", "weekly"],
      checks: ["包含下周计划"],
      steps: [
        { title: "收集素材", detail: "读取本周任务与记录" },
        { title: "生成周报", detail: "按模板输出草稿" },
      ],
    },
    source: {
      format: "agentskills/v1",
      instructions: "# 团队周报\n1. 收集本周素材\n2. 按模板生成周报草稿\n3. 附下周计划",
      metadata: { packId: "pack_1", packName: "团队效率包" },
      files: [{ path: "reference/template.md", content: "模板" }],
    },
  },
  {
    id: "generate_image",
    name: "生成图片",
    description: "从文本提示词生成图片。",
    kind: "image",
    builtin: true,
    layer: "capability",
    origin: "system",
    exposure: "internal",
    enabled: true,
  },
];

const READY_PACKS: any[] = [
  {
    id: "pack_1",
    name: "团队效率包",
    sourceName: "team-pack.zip",
    importedAt: Date.parse("2026-01-02T03:04:05Z"),
    skillCount: 3,
    entryPoints: [],
    skillDocs: [{ path: "SKILL.md" }],
  },
  {
    id: "pack_2",
    name: "写作模板包",
    sourceName: "writing-templates.zip",
    importedAt: Date.parse("2026-01-03T08:09:10Z"),
    skillCount: 2,
    entryPoints: [],
    skillDocs: [{ path: "SKILL.md" }],
  },
];

const skills: any[] = READY_SKILLS.map((s) => ({ ...s }));
const packs: any[] = READY_PACKS.map((p) => ({ ...p }));

const listeners: Array<(e: any) => void> = [];
const probe: any = {
  scenario,
  runMode,
  importMode,
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
(window as any).__oaSkillProbe = probe;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const record = (command: string, payload: Record<string, unknown>) => {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload || {})) {
    if (k === "archiveBase64") safe.archiveBase64Present = typeof v === "string" && v.length > 0;
    else safe[k] = v;
  }
  probe.commands.push({ command, payload: safe });
};

async function command(raw: any) {
  const cmd = raw && raw.command;
  const payload = (raw && raw.payload) || {};
  record(String(cmd), payload);
  switch (cmd) {
    case "skill/health":
      return {
        ok: true,
        value: {
          status: scenario === "degraded" ? "degraded" : "ok",
          dependencies: {
            chatTarget: true,
            modelCall: true,
            cliRuntime: true,
            fsAdapter: true,
            mediaAdapter: false,
            skillWorkspace: scenario !== "degraded",
          },
        },
      };
    case "skill/list":
      if (scenario === "loading") return new Promise(() => {});
      if (scenario === "empty") return { ok: true, value: { items: [] } };
      if (scenario === "error") return { ok: false, error: "SKILL_COMMAND_NOT_ALLOWED", message: "命令不在 skill:command 白名单内" };
      if (scenario === "unauthorized") return { ok: false, error: "SKILL_UNAUTHENTICATED", message: "当前会话未认证，skill 命令被拒绝" };
      if (scenario === "unavailable") return { ok: false, error: "SKILL_DEPENDENCY_UNAVAILABLE", message: "缺少模型适配器" };
      return { ok: true, value: { items: skills } };
    case "skill/pack/list":
      if (scenario === "loading") return new Promise(() => {});
      if (scenario === "empty") return { ok: true, value: { items: [] } };
      if (scenario === "error") return { ok: false, error: "SKILL_COMMAND_NOT_ALLOWED", message: "命令不在白名单内" };
      if (scenario === "unauthorized") return { ok: false, error: "SKILL_UNAUTHENTICATED", message: "未认证" };
      if (scenario === "unavailable") return { ok: false, error: "SKILL_DEPENDENCY_UNAVAILABLE", message: "缺少模型适配器" };
      return { ok: true, value: { items: packs } };
    case "skill/get": {
      const skill = skills.find((s) => s.id === payload.skillId);
      return skill ? { ok: true, value: { skill } } : { ok: false, error: "SKILL_NOT_FOUND", message: "技能不存在" };
    }
    case "skill/enable":
    case "skill/disable": {
      const skill = skills.find((s) => s.id === payload.skillId);
      if (!skill) return { ok: false, error: "SKILL_NOT_FOUND", message: "技能不存在" };
      skill.enabled = cmd === "skill/enable";
      return { ok: true, value: { skill } };
    }
    case "skill/run": {
      probe.emit({
        kind: "progress",
        domain: "skill",
        sequence: 1,
        at: Date.now(),
        payload: { command: "skill/run", phase: "begin", requestId: payload.requestId },
      });
      await sleep(runMode === "slow" ? 6000 : 120);
      if (scenario === "run-fail") {
        probe.emit({
          kind: "progress",
          domain: "skill",
          sequence: 3,
          at: Date.now(),
          payload: { command: "skill/run", phase: "failed", requestId: payload.requestId },
        });
        return { ok: false, error: "SKILL_DEPENDENCY_UNAVAILABLE", message: "缺少模型适配器" };
      }
      probe.emit({
        kind: "progress",
        domain: "skill",
        sequence: 2,
        at: Date.now(),
        payload: { command: "skill/run", phase: "completed", requestId: payload.requestId },
      });
      return { ok: true, value: { text: "【" + payload.skillId + "】已按输入生成结果。", meta: { model: "probe-model" } } };
    }
    case "skill/pack/import":
      if (importMode === "fail") return { ok: false, error: "DXOS_ERR_INVALID_INPUT", message: "Skill 导入失败：不是有效的 ZIP 文件" };
      if (importMode === "unauthorized") return { ok: false, error: "SKILL_UNAUTHENTICATED", message: "当前会话未认证" };
      if (importMode === "oversize") return { ok: false, error: "DXOS_ERR_INVALID_INPUT", message: "Skill 包错误：压缩包不能超过 32 MB" };
      return { ok: true, value: { pack: { id: "pack_new", name: "新导入包" }, skills: [{ id: "x" }], workspace: null } };
    case "skill/pack/export":
      return { ok: true, value: { fileName: "skill-writing.zip", base64: "", bytes: 0, skillCount: 1, entries: 1 } };
    case "skill/delete":
      return { ok: true, value: { skillId: payload.skillId, deleted: true } };
    case "skill/pack/uninstall":
      return { ok: true, value: { packId: payload.packId, deleted: true } };
    default:
      return { ok: false, error: "SKILL_COMMAND_NOT_ALLOWED", message: "未登记命令：" + String(cmd) };
  }
}

const bridge = {
  command,
  onEvent(cb: (e: any) => void) {
    listeners.push(cb);
    return () => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  },
};
(window as any).openarc = { skill: bridge };

/* ══════════════════════════════════════════════════════════════════════════
   UI-1b · 基准页 McpCenter 的挂载壳（?page=mcp）

   对照口径：同主题（light）/ 同窗口（1440×900）/ 同缩放（deviceScaleFactor 2）/
   同 reducedMotion，直接 import 真实 McpCenter（D5-03 已验收的同类管理页）。
   McpCenter 依赖 window.openarc.mcp.command，这里按它的只读投影数据契约喂假桥：
     · mcp/list  → { ok:true, items:[投影记录] }
     · mcp/get   → { ok:true, connection:投影记录 }
     · mcp/testLog → { ok:true, items:[{at,level,event,errorCode,detail}] }
   桥同样只做内存 switch，不发任何网络请求；上行命令挂到 __oaMcpProbe。

   外壳：与产品一致，McpCenter 直挂 window-body —— 产品里 mcp-center 分支没有
   .split/.split-side（见 main.tsx:2657），所以这里不额外套侧栏，避免为了"看起来
   对齐"给它加一列产品里不存在的导航。
   ══════════════════════════════════════════════════════════════════════════ */
const MCP_CONNECTIONS: any[] = [
  {
    connectionId: "conn_local_echo",
    name: "本机回显服务",
    transport: "stdio",
    location: "LOCAL_DEVICE",
    endpoint: { serverKey: "openarc-test-echo" },
    authMode: "NONE",
    credentialConfigured: false,
    enabled: true,
    status: "READY",
    lastErrorCode: null,
    protocolVersion: "2025-06-18",
    serverName: "openarc-test-echo",
    serverVersion: "1.0.0",
    capabilities: { tools: { listChanged: true }, resources: {}, logging: {} },
    tools: [
      { name: "echo", description: "回显输入文本", inputSchemaSummary: "{ text: string }" },
      { name: "sum", description: "整数求和", inputSchemaSummary: "{ a: number, b: number }" },
    ],
    toolsHash: "sha256:5c1f0a7e9b2d",
    visibility: "PERSONAL",
    access: { canView: true, canUse: true, canManage: true, isOwner: true, connectionScope: "USER" },
    createdAt: Date.parse("2026-01-02T03:04:05Z"),
    updatedAt: Date.parse("2026-01-05T09:00:00Z"),
    lastConnectedAt: Date.parse("2026-01-05T09:01:12Z"),
  },
  {
    connectionId: "conn_remote_docs",
    name: "团队文档服务",
    transport: "http",
    location: "REMOTE_SERVICE",
    endpoint: { url: "https://mcp.example.invalid/rpc", endpointScope: "REMOTE_HTTPS" },
    authMode: "BEARER",
    credentialConfigured: true,
    enabled: false,
    status: "DISABLED",
    lastErrorCode: "MCP_AUTH_REQUIRED",
    protocolVersion: null,
    serverName: null,
    serverVersion: null,
    capabilities: null,
    tools: [],
    toolsHidden: false,
    toolsHash: null,
    visibility: "ORGANIZATION",
    access: { canView: true, canUse: false, canManage: false, isOwner: false, connectionScope: "ORG" },
    createdAt: Date.parse("2026-01-03T08:09:10Z"),
    updatedAt: Date.parse("2026-01-04T10:11:12Z"),
    lastConnectedAt: null,
  },
];

const MCP_TEST_LOG: any[] = [
  { at: Date.parse("2026-01-05T09:01:12Z"), level: "INFO", event: "initialize", detail: "协议版本 2025-06-18" },
  { at: Date.parse("2026-01-05T09:01:12Z"), level: "INFO", event: "tools/list", detail: "发现 2 个工具" },
  { at: Date.parse("2026-01-05T09:01:12Z"), level: "WARN", event: "resources/list", detail: "服务端未声明 resources" },
];

const mcpProbe: any = { page: "mcp", commands: [] as any[], connections: MCP_CONNECTIONS };
(window as any).__oaMcpProbe = mcpProbe;

async function mcpCommand(raw: any) {
  const cmd = raw && raw.command;
  const payload = (raw && raw.payload) || {};
  mcpProbe.commands.push({ command: cmd, payload });
  const find = (id: unknown) => MCP_CONNECTIONS.find((c) => c.connectionId === id) || null;
  switch (cmd) {
    case "mcp/list":
      return { ok: true, items: MCP_CONNECTIONS };
    case "mcp/get": {
      const c = find(payload.connectionId);
      return c ? { ok: true, connection: c } : { ok: false, error: "MCP_CONNECTION_NOT_FOUND" };
    }
    case "mcp/testLog":
      return { ok: true, items: MCP_TEST_LOG };
    default:
      return { ok: false, error: "MCP_COMMAND_NOT_ALLOWED" };
  }
}

const mcpBridge = { command: mcpCommand };
(window as any).openarc = { skill: bridge, mcp: mcpBridge };

function McpHarness() {
  return (
    <div className="window" style={{ position: "absolute", inset: 0 }}>
      <McpCenter role="ADMIN" />
    </div>
  );
}

function Harness() {
  const [tab, setTab] = useState<Tab>((params.get("tab") as Tab) || "installed");
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

/* ?page=mcp → 基准页 McpCenter；默认 → Skill 中心。 */
const pageKind = params.get("page") || "skills";
createRoot(document.getElementById("root")!).render(pageKind === "mcp" ? <McpHarness /> : <Harness />);
