/**
 * UI-5 · 模型与协议探针用挂载壳（只在 experiments 里被 esbuild 打包，不进产品构建）。
 *
 * 它做四件事：
 *   1. 复刻产品设置窗口里 model pane 的真实外壳
 *      （.window > .split > .split-side 设置分类 + .split-main.settings-content > .settings-pane），
 *      让 ModelSettings 处在和 src/main.tsx 的 settings 分支完全相同的 DOM 位置与容器宽度规则下；
 *   2. 装一个**假 model 桥**（只在 window.openarc.model 上放 command / onEvent）。
 *      协议表 / protocol/get / manifest/get 的**数据不是手写的**：由 run-all.mjs 直接调用
 *      主进程的 protocol-engine repository 与 manifest service 生成 fixture.js（window.__OA_MODEL_FIXTURE__），
 *      与 IPC 返回的是同一份真实结构；provider/callStream 按 provider-protocol-service.cjs#streamSink
 *      的真实 P1 信封（channel/domain/kind/sequence/at/payload）逐条下发事件；
 *   3. 另装一个**假 skill 桥**并把 SkillCenter 挂进同款外壳，供基准对照（?page=skill）；
 *   4. 把收到的命令与下行事件挂到 window.__oaModelProbe，供 Playwright 断言。
 *
 * 这两个桥都不发任何网络请求：它们是内存里的 switch；fixture 由本地文件注入，不 fetch。
 */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ModelSettings } from "../../src/settings/ModelSettings";
import { SkillCenter } from "../../src/skills/SkillCenter";
import "../../src/design-system/tokens.css";
import "../../src/design-system/primitives.css";
import "../../src/design-system/page-states.css";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") || "ready";
const pageKind = params.get("page") || "model";
/* UI-5b 动作入口的探针开关：慢调用用于进行中截图；entry-error 用于失败截图。 */
const runMode = params.get("run") || "fast";

/* ══════════════════════════════════════════════════════════════════════════
   真实 fixture（由 run-all.mjs 从主进程服务导出）
   ══════════════════════════════════════════════════════════════════════════ */
const FIXTURE = (window as any).__OA_MODEL_FIXTURE__ || {
  protocolList: { ok: true, items: [], shadowedLegacy: [] },
  protocolGet: {},
  manifest: {},
};

/* ══════════════════════════════════════════════════════════════════════════
   探针记录
   ══════════════════════════════════════════════════════════════════════════ */
const listeners: Array<(e: any) => void> = [];
let sequence = 0;
const probe: any = {
  scenario,
  commands: [] as any[],
  events: [] as any[],
  wire: { channel: "model:event", domain: "model", kinds: [] as string[] },
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
(window as any).__oaModelProbe = probe;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const record = (command: string, payload: Record<string, unknown>) => {
  probe.commands.push({ command, payload });
};

/** 与 dxos-foundation-events.cjs#createEventChannel 同形：序号在同一 channel 内单调 +1。 */
const emitProgress = (payload: Record<string, unknown>) => {
  sequence += 1;
  probe.wire.kinds.push("progress");
  probe.emit({ channel: "model:event", domain: "model", kind: "progress", sequence, at: Date.now(), payload });
};
const emitErrorLog = (message: string, data: Record<string, unknown>) => {
  sequence += 1;
  probe.wire.kinds.push("log");
  probe.emit({ channel: "model:event", domain: "model", kind: "log", sequence, at: Date.now(), payload: { level: "error", message, data } });
};

/* ══════════════════════════════════════════════════════════════════════════
   假 model 桥（内存 switch）
   ══════════════════════════════════════════════════════════════════════════ */
const PROVIDER = {
  providerId: "prov_local",
  displayName: "本地演示供应商",
  adapterType: "openai",
  baseUrl: "https://provider.invalid/v1",
  endpointScope: "LOCALHOST",
  scope: "PERSONAL",
  status: "enabled",
};
const MODELS = [
  { configId: "cfg_image", providerId: "prov_local", remoteModelId: "gpt-image", displayName: "GPT Image", capabilities: ["image-generation"], verifiedCapabilities: [], scope: "PERSONAL", version: 1, status: "enabled" },
  { configId: "cfg_chat", providerId: "prov_local", remoteModelId: "gpt-5", displayName: "GPT-5", capabilities: ["chat"], verifiedCapabilities: [], scope: "PERSONAL", version: 1, status: "enabled" },
];

const STREAM_CHUNKS = ["这是", "一次", "离线", "流式", "演示", "：", "增量", "全部", "来自", "model:event", "的", "P1", "信封", "。"];

/** 对应 provider-protocol-service.cjs#call 的流式分支：start → text.delta* → usage → complete。 */
async function callStream(payload: Record<string, any>) {
  const content = payload && Array.isArray(payload.messages) && payload.messages[0] ? String(payload.messages[0].content || "") : "";
  if (!content.trim()) return { ok: false, error: "INVALID_INPUT" };
  /* 对应 provider-protocol-service.cjs#readSse 的异常路径：已发增量 → response.error(log) → PARTIAL_RESPONSE。 */
  if (scenario === "stream-error") {
    emitProgress({ type: "response.start" });
    await sleep(80);
    emitProgress({ type: "text.delta", text: "前半段增量" });
    await sleep(150);
    emitErrorLog("provider stream error: PARTIAL_RESPONSE", { type: "response.error", partial: "前半段增量" });
    return { ok: false, error: "PARTIAL_RESPONSE" };
  }
  emitProgress({ type: "response.start" });
  await sleep(60);
  let text = "";
  for (const chunk of STREAM_CHUNKS) {
    emitProgress({ type: "text.delta", text: chunk });
    text += chunk;
    await sleep(scenario === "stream-cancel" ? 420 : 90);
  }
  const usage = { prompt_tokens: 12, completion_tokens: text.length };
  emitProgress({ type: "usage", usage });
  await sleep(40);
  emitProgress({ type: "response.complete" });
  return { ok: true, requestId: payload.requestId, text, toolCalls: [], usage, snapshot: { providerId: payload.providerId, model: payload.model } };
}

async function command(raw: any) {
  const cmd = raw && raw.command;
  const payload = (raw && raw.payload) || {};
  record(String(cmd), payload);
  const finish = (result: any) => result;

  switch (cmd) {
    case "provider/list":
      if (scenario === "noprovider") return finish({ ok: true, items: [] });
      return finish({ ok: true, items: [PROVIDER] });
    case "model/list":
      if (scenario === "noprovider") return finish({ ok: true, items: [] });
      return finish({ ok: true, items: MODELS });
    case "defaults/get":
      return finish({
        ok: true,
        personal: { chat: "cfg_chat", "tool-calling": "cfg_chat", "image-generation": "cfg_image" },
        organization: { chat: null, "tool-calling": null, "image-generation": null },
        canManageOrganization: true,
      });
    case "credential/status":
      /* ?scenario=nocred：供应商已启用但没有可用凭据（用于缺凭据提示截图）。 */
      if (scenario === "nocred") return finish({ ok: true, configured: false, storeAvailable: true, manageable: true });
      return finish({ ok: true, configured: true, storeAvailable: true, manageable: true });
    case "model/test":
      return finish({ ok: true, reachable: true, credentialAccepted: true, inference: true, verifiedCapabilities: [] });
    case "protocol/list":
      if (scenario === "loading") return new Promise(() => {});
      if (scenario === "empty") return finish({ ok: true, items: [], shadowedLegacy: [] });
      if (scenario === "error") return finish({ ok: false, error: "MODEL_COMMAND_NOT_ALLOWED", detail: "protocol/list" });
      if (scenario === "unavailable") return finish({ ok: false, error: "PROTOCOL_NOT_READY" });
      return finish(FIXTURE.protocolList);
    case "protocol/get": {
      const key = String(payload.kind) + ":" + String(payload.id);
      const hit = FIXTURE.protocolGet[key];
      if (!hit) return finish({ ok: false, error: "PROTOCOL_NOT_FOUND" });
      return finish(hit);
    }
    case "manifest/get": {
      const key = String(payload.protocolId) + "|" + String(payload.model) + "|" + String(payload.intent);
      const hit = FIXTURE.manifest[key];
      if (!hit) return finish({ ok: false, error: "PROTOCOL_NOT_FOUND" });
      return finish(hit);
    }
    case "provider/callStream":
      return finish(await callStream(payload));
    /* ── UI-5b 动作入口（与 electron/provider-protocol-service.cjs 同形）── */
    case "protocol/validate": {
      if (scenario === "entry-error") return finish({ ok: false, error: "PROTOCOL_INVALID", issues: ["protocol.id 缺失", "workflows[0].submit 未定义"] });
      return finish({ ok: true, protocol: payload.protocol });
    }
    case "protocol/save": {
      if (scenario === "entry-error") return finish({ ok: false, error: "PROTOCOL_SAVE_REJECTED", detail: "同 id 已存在且内容冲突" });
      return finish({ ok: true, entry: { kind: String(payload.kind || "model"), id: (payload.protocol && payload.protocol.id) || "custom", version: 1, hash: "sha256:probe" } });
    }
    case "image/generate": {
      if (scenario === "entry-error") return finish({ ok: false, error: "CREDENTIAL_MISSING" });
      if (runMode === "slow") await sleep(700);
      return finish({ ok: true, requestId: "ireq_probe", images: [{ mime: "image/png", bytes: 128, saved: true }], snapshot: { providerId: payload.providerId, model: payload.model } });
    }
    case "protocol/execute": {
      if (scenario === "entry-error") return finish({ ok: false, error: "PROTOCOL_EXECUTION_FAILED", detail: "（探针）工作流节点失败" });
      if (runMode === "slow") await sleep(700);
      return finish({ ok: true, requestId: "xreq_probe", taskId: "task_probe", outputs: [{ type: "image", count: 1 }], captures: [], snapshot: { providerId: payload.providerId, model: payload.model } });
    }
    default:
      return finish({ ok: false, error: "MODEL_COMMAND_NOT_ALLOWED", detail: String(cmd) });
  }
}

const modelBridge = {
  command,
  onEvent(cb: (e: any) => void) {
    listeners.push(cb);
    return () => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  },
};

/* ══════════════════════════════════════════════════════════════════════════
   基准页 SkillCenter（?page=skill）的假桥（只做内存 switch）
   ══════════════════════════════════════════════════════════════════════════ */
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
    systemPrompt: "你是周报执行器。",
    v2: { version: 1, triggers: ["周报"], steps: [{ title: "收集素材", detail: "读取本周任务与记录" }, { title: "生成周报", detail: "按模板输出草稿" }] },
    source: { format: "agentskills/v1", instructions: "# 团队周报", files: [{ path: "reference/template.md" }] },
  },
];

async function skillCommand(raw: any) {
  const cmd = raw && raw.command;
  const payload = (raw && raw.payload) || {};
  switch (cmd) {
    case "skill/health":
      return { ok: true, value: { status: "ok", dependencies: { chatTarget: true, modelCall: true, cliRuntime: true, fsAdapter: true, mediaAdapter: true, skillWorkspace: true } } };
    case "skill/list":
      return { ok: true, value: { items: READY_SKILLS } };
    case "skill/pack/list":
      return { ok: true, value: { items: [] } };
    case "skill/get": {
      const skill = READY_SKILLS.find((s) => s.id === payload.skillId);
      return skill ? { ok: true, value: { skill } } : { ok: false, error: "SKILL_NOT_FOUND", message: "技能不存在" };
    }
    default:
      return { ok: false, error: "SKILL_COMMAND_NOT_ALLOWED", message: "未登记命令" };
  }
}

const skillBridge = { command: skillCommand, onEvent: () => () => {} };
(window as any).openarc = { model: modelBridge, skill: skillBridge };

/* ══════════════════════════════════════════════════════════════════════════
   外壳（与 main.tsx settings 分支同一 DOM 结构）
   ══════════════════════════════════════════════════════════════════════════ */
function ModelShell() {
  return (
    <div className="window" style={{ position: "absolute", inset: 0 }}>
      <div className="split">
        <nav className="split-side" aria-label="设置分类">
          <div className="split-section">系统</div>
          <button type="button" className="split-nav" data-settings-pane="appearance">外观与交互</button>
          <button type="button" className="split-nav" aria-current="true" data-settings-pane="model">模型 / AI</button>
          <button type="button" className="split-nav" data-settings-pane="devices">设备</button>
        </nav>
        <div className="split-main settings-content" data-settings-active="model">
          <div className="settings-pane">
            <h1>模型 / AI</h1>
            <p className="subtitle">统一配置所有应用使用的模型服务。</p>
            <ModelSettings role="ADMIN" />
          </div>
        </div>
      </div>
    </div>
  );
}

function SkillShell() {
  const [tab, setTab] = useState<"market" | "mine" | "installed">("installed");
  return (
    <div className="window" style={{ position: "absolute", inset: 0 }}>
      <div className="split">
        <nav className="split-side" aria-label="Skill 分类">
          <div className="split-section">Skill</div>
          <button className="split-nav" aria-current={tab === "market"} onClick={() => setTab("market")}>市场</button>
          <button className="split-nav" aria-current={tab === "mine"} onClick={() => setTab("mine")}>我的技能</button>
          <div className="split-section">本机</div>
          <button className="split-nav" aria-current={tab === "installed"} onClick={() => setTab("installed")}>已安装</button>
        </nav>
        <div className="split-main">
          <SkillCenter tab={tab} role="ADMIN" />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(pageKind === "skill" ? <SkillShell /> : <ModelShell />);
