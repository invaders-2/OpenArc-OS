/**
 * B4c · 项目级 Agent 模式（project-agent-mode.cjs）离线测试。
 *
 * 覆盖父任务点名的验收场景：
 *   1) 一轮完整回合：能力发现 → 工具调用 → 结果回填 → 独立完成验收
 *   2) 工具失败回填：失败 observation 写回账本并回填给模型
 *   3) 依赖缺失：核心依赖未注入时结构化 AGENT_DEPENDENCY_UNAVAILABLE（不绕过）
 *   4) 多目标能力选择：capability_discover 命中多候选时按首选 Target 约束工具
 *   5) 各来源路由：file / skill / mcp / catalog（system+app）分别走注入执行器
 *
 * 全部离线：toolLoop / fallback 用冻结真实模块；agentRuntime / usage / capability /
 * toolRunner / skillRunner / mcpAdapter / toolCatalog / providerAdapter 用注入桩。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const projectAgent = require("../electron/project-agent-mode.cjs");
const toolLoop = require("../electron/agent-runtime-tool-loop.cjs");
const fallback = require("../electron/agent-runtime-fallback.cjs");

let runSeq = 0;
function nextRunId() {
  runSeq += 1;
  return "run-" + runSeq;
}

function capTool(name, intent, domain) {
  return {
    type: "function",
    function: { name, description: name + " 工具说明", parameters: { type: "object", properties: {} } },
    x_dx_capability: { schema: "dx-agent-capability/v1", id: "cap:" + name, domain, intents: [intent] },
  };
}

const TOOLS = [
  capTool("fs_list", "file.read", "file-system"),
  capTool("fs_read", "file.read", "file-system"),
  capTool("media_generate_image", "media.image.generate", "media"),
  capTool("skill__demo", "skill.demo", "skill"),
  capTool("mcp__search", "mcp.search", "mcp"),
  capTool("app_render", "app.demo", "app"),
];

const DESCRIPTORS = [
  { name: "fs_list", source: "file", risk: "read" },
  { name: "fs_read", source: "file", risk: "read" },
  { name: "media_generate_image", source: "system", risk: "write" },
  { name: "skill__demo", source: "skill", sourceId: "demo", risk: "write" },
  { name: "mcp__search", source: "mcp", sourceId: "search", risk: "read" },
  { name: "app_render", source: "app", sourceId: "app-1", risk: "write" },
];

const REVIEW_JSON = '{"complete":true,"reason":"账本与原始目标一致","missingActions":[]}';

/**
 * 装配测试台。modelPlan(request, planCount) 只在非验收的模型调用上触发；
 * 验收调用（tools 为空）固定返回 REVIEW_JSON。
 */
function buildHarness({ modelPlan, toolRunner, skillRunner, mcpAdapter, toolCatalog, capability, reviewJson, tools = null, descriptors = null } = {}) {
  const runId = nextRunId();
  const events = [];
  const usageEvents = [];
  const calls = [];
  let planCount = 0;

  const prepared = {
    trace: { runId, steps: [] },
    systemPromptAdditions: ["附加系统提示"],
    route: {
      model: { providerId: "p1", model: "m-primary", provider: { id: "p1", name: "主站点" } },
      modelRoutes: [{ providerId: "p1", model: "m-primary", provider: { id: "p1", name: "主站点" } }],
      tools: tools || TOOLS,
      toolDescriptors: descriptors || DESCRIPTORS,
    },
  };
  const runtime = { runId, signal: new AbortController().signal, prepared };

  const agentRuntime = {
    normalizeEnvelope: (raw, actor) => ({ ...raw, actorId: actor.id }),
    prepare: () => runtime,
    create: () => runtime,
    start: (id) => events.push(["start", id]),
    append: (id, type, data) => events.push([type, data]),
    complete: (id, result) => events.push(["complete", { id, result }]),
    fail: (id, error) => events.push(["fail", { id, message: String((error && error.message) || error) }]),
    cancel: (id) => events.push(["cancel", id]),
  };
  const usage = {
    beginAgentUsage: (input) => {
      const id = "u" + (usageEvents.length + 1);
      usageEvents.push({ id, input, finished: null });
      return { id, startedAt: 1000 };
    },
    finishAgentUsage: (id, input) => {
      const record = usageEvents.find((item) => item.id === id);
      if (record) record.finished = input;
      return { id, status: input.status };
    },
  };
  const capabilityStub = capability || {
    discoverCapabilityTargetsForUser: async (userId, intents) => {
      const targets = {};
      for (const intent of intents) targets[intent] = [{ providerName: "本地", model: "m-fast", operationId: "op-" + intent }];
      return targets;
    },
    normalizeCapabilityReferences: (value) => (value && typeof value === "object" ? value : {}),
    normalizeCapabilityRequirements: (value) => (value && typeof value === "object" ? value : {}),
    selectedCapabilityTargets: (targets) => Object.entries(targets).flatMap(([intent, candidates]) => candidates[0] ? [{ intent, ...candidates[0] }] : []),
  };
  const defaultToolRunner = {
    runTool: (name) => {
      if (name === "fs_list") return { entries: [{ name: "a.txt", type: "file" }] };
      if (name === "fs_read") return { content: "hello", nodeId: "node-1", name: "a.txt" };
      throw new Error("未知文件工具：" + name);
    },
  };
  const providerAdapter = {
    autoFallback: () => false,
    chatWithTools: async (request) => {
      calls.push(request);
      if (!request.tools || request.tools.length === 0) return { content: reviewJson || REVIEW_JSON };
      planCount += 1;
      return modelPlan(request, planCount);
    },
  };

  projectAgent.resetProjectAgentModeForTests();
  projectAgent.configureProjectAgentMode({
    agentRuntime, usage, fallback, toolLoop: toolLoop.serverAgentToolLoops, capability: capabilityStub,
    toolRunner: toolRunner || defaultToolRunner,
    skillRunner: skillRunner || null,
    mcpAdapter: mcpAdapter || null,
    toolCatalog: toolCatalog || null,
    providerAdapter,
    clock: () => 1000,
  });
  return { runId, events, usageEvents, calls, prepared, toolRunner: toolRunner || defaultToolRunner };
}

const PROJECT = { id: "proj-1", name: "演示项目", root_node_id: "root-1" };
const ACTOR = { id: "user-1", role: "user", displayName: "小李" };

function findEvent(events, name) { return events.find((event) => event[0] === name); }
function planCalls(h) { return h.calls.filter((call) => call.tools && call.tools.length); }

test("project-agent 完整回合：能力发现 → fs_list 执行 → 完成验收", async () => {
  const h = buildHarness({
    modelPlan: (request, count) => {
      if (count === 1) return { content: "", toolCalls: [{ id: "t1", name: "fs_list", arguments: JSON.stringify({ path: "." }) }] };
      return { content: "目录已列出：a.txt", toolCalls: [] };
    },
  });
  const result = await projectAgent.runProjectAgentMode(PROJECT, ACTOR, "列出当前目录");

  assert.equal(result.complete, true);
  assert.equal(result.text, "目录已列出：a.txt");
  assert.equal(result.filesChanged, false);
  assert.deepEqual(result.agentTrace, h.prepared.trace);

  assert.deepEqual(findEvent(h.events, "start"), ["start", h.runId]);
  assert.ok(h.events.some((event) => event[0] === "capability.started" && event[1].toolName === "fs_list"));
  assert.ok(h.events.some((event) => event[0] === "capability.completed" && event[1].toolName === "fs_list"));
  const review = findEvent(h.events, "planned");
  assert.equal(review[1].phase, "completion-review");
  assert.equal(review[1].complete, true);
  assert.ok(findEvent(h.events, "complete"));

  // 2 次计划调用 + 1 次验收调用
  assert.equal(planCalls(h).length, 2);
  assert.equal(h.calls.length, 3);
  // model / tool 两类用量都记账
  assert.ok(h.usageEvents.some((item) => item.input.kind === "model"));
  assert.ok(h.usageEvents.some((item) => item.input.kind === "tool" && item.input.toolName === "fs_list"));
  // 初始根清单不计用量；循环内的 fs_list 记一次工具用量（源 projectAgentMode.ts:122 / :247）
  assert.equal(h.usageEvents.filter((item) => item.input.toolName === "fs_list").length, 1);
});

test("project-agent 多目标能力选择：discover 多候选时按首选 Target 约束工具", async () => {
  const discovered = [];
  const capability = {
    discoverCapabilityTargetsForUser: async (userId, intents) => {
      discovered.push({ userId, intents });
      const targets = {};
      for (const intent of intents) {
        targets[intent] = [
          { providerName: "首选站点", model: "m-first", operationId: "op-first" },
          { providerName: "备用站点", model: "m-second", operationId: "op-second" },
        ];
      }
      return targets;
    },
    normalizeCapabilityReferences: (value) => (value && typeof value === "object" ? value : {}),
    normalizeCapabilityRequirements: (value) => (value && typeof value === "object" ? value : {}),
    selectedCapabilityTargets: (targets) => Object.entries(targets).flatMap(([intent, candidates]) => candidates[0] ? [{ intent, ...candidates[0] }] : []),
  };
  const h = buildHarness({
    capability,
    modelPlan: (request, count) => {
      if (count === 1) return { content: "", toolCalls: [{ id: "t1", name: "fs_list", arguments: "{}" }] };
      return { content: "完成", toolCalls: [] };
    },
  });
  h.capability = capability;
  const result = await projectAgent.runProjectAgentMode(PROJECT, ACTOR, "看看目录");

  assert.equal(result.complete, true);
  // 引导意图 file.read 被送进能力发现
  assert.deepEqual(discovered[0].intents, ["file.read"]);
  assert.equal(discovered[0].userId, ACTOR.id);
  // 工具被首选 Target 约束（只取第一候选）
  const firstPlan = planCalls(h)[0];
  const fsListTool = firstPlan.tools.find((tool) => tool.function.name === "fs_list");
  assert.match(fsListTool.function.description, /\[V2 自动目标\] 首选站点 \/ m-first \/ op-first/);
  assert.doesNotMatch(fsListTool.function.description, /备用站点/);
  // 能力完成事件带 activated 与选中目标
  const capabilityEvent = h.events.find((event) => event[0] === "capability.completed" && event[1].toolName === "capability_discover");
  assert.ok(capabilityEvent);
});

test("project-agent 各来源路由：file / system / skill / mcp / app 分别执行并登记产物", async () => {
  const skillCalls = [];
  const mcpCalls = [];
  const catalogCalls = [];
  const h = buildHarness({
    modelPlan: (request, count) => {
      if (count === 1) {
        return { content: "", toolCalls: [{ id: "d1", name: "capability_discover", arguments: JSON.stringify({ intents: ["media.image.generate", "skill.demo", "mcp.search", "app.demo"] }) }] };
      }
      if (count === 2) {
        return { content: "", toolCalls: [
          { id: "t1", name: "fs_list", arguments: "{}" },
          { id: "t2", name: "media_generate_image", arguments: JSON.stringify({ prompt: "一只猫" }) },
          { id: "t3", name: "skill__demo", arguments: "{}" },
          { id: "t4", name: "mcp__search", arguments: "{}" },
          { id: "t5", name: "app_render", arguments: "{}" },
        ] };
      }
      return { content: "全部完成", toolCalls: [] };
    },
    skillRunner: { runSkill: async (skillId, args, ctx) => { skillCalls.push({ skillId, args, ctx }); return { images: [{ nodeId: "img-skill", name: "skill.png" }] }; } },
    mcpAdapter: { callByName: async (name, args) => { mcpCalls.push({ name, args }); return { text: "搜索结果" }; } },
    toolCatalog: { runCatalogTool: async (name, args, actor, options) => {
      catalogCalls.push({ name, args, actor, options });
      if (name === "media_generate_image") return { images: [{ nodeId: "img-sys", name: "cat.png" }] };
      return { nodeId: "node-app", name: "render.html" };
    } },
  });
  const result = await projectAgent.runProjectAgentMode(PROJECT, ACTOR, "生成图片并渲染", [], { providerId: "p9", llmModel: "m9" });

  assert.equal(result.complete, true);
  assert.equal(result.filesChanged, true);
  // skill 路由带 sourceId 与偏好上下文
  assert.deepEqual(skillCalls, [{ skillId: "demo", args: {}, ctx: { rootId: "root-1", userId: "user-1", providerId: "p9", model: "m9", imageProviderId: undefined, imageModel: undefined } }]);
  assert.deepEqual(mcpCalls, [{ name: "mcp__search", args: {} }]);
  // catalog 路由注入 __rootId/__providerId；app 带 sourceId 选项
  assert.equal(catalogCalls.length, 2);
  assert.equal(catalogCalls[0].name, "media_generate_image");
  assert.equal(catalogCalls[0].args.__rootId, "root-1");
  assert.equal(catalogCalls[0].args.__providerId, "p9");
  assert.equal(catalogCalls[1].name, "app_render");
  assert.deepEqual(catalogCalls[1].options, { sourceId: "app-1" });
  // 产物登记
  const artifacts = h.events.filter((event) => event[0] === "artifact.created").map((event) => event[1].artifactId);
  assert.ok(artifacts.includes("img-sys"));
  assert.ok(artifacts.includes("img-skill"));
  assert.ok(artifacts.includes("node-app"));
});

test("project-agent 工具失败回填：失败 observation 写账本并回填给模型", async () => {
  const h = buildHarness({
    toolRunner: {
      runTool: (name) => {
        if (name === "fs_list") return { entries: [{ name: "a.txt", type: "file" }] };
        throw new Error("ENOENT: a.txt 不存在");
      },
    },
    modelPlan: (request, count) => {
      if (count === 1) return { content: "", toolCalls: [{ id: "f1", name: "fs_read", arguments: JSON.stringify({ path: "a.txt" }) }] };
      return { content: "读取失败，已按错误信息报告", toolCalls: [] };
    },
  });
  const result = await projectAgent.runProjectAgentMode(PROJECT, ACTOR, "读取 a.txt");

  assert.equal(result.complete, true);
  const failed = h.events.find((event) => event[0] === "capability.failed");
  assert.ok(failed);
  assert.equal(failed[1].toolName, "fs_read");
  assert.match(failed[1].message, /ENOENT: a.txt 不存在/);

  // 失败结果在第二次计划调用前作为 tool 消息回填
  const secondPlan = planCalls(h)[1];
  const toolMessage = secondPlan.messages.find((message) => message.role === "tool" && message.tool_call_id === "f1");
  assert.ok(toolMessage, "失败 observation 应回填为 tool 消息");
  assert.match(toolMessage.content, /ENOENT: a.txt 不存在/);
  assert.doesNotMatch(toolMessage.content, /"ok":true/);
});

test("project-agent 依赖缺失：核心依赖 fallback 未注入时结构化拒绝", async () => {
  buildHarness({ modelPlan: () => ({ content: "x", toolCalls: [] }) });
  projectAgent.configureProjectAgentMode({ fallback: null });
  await assert.rejects(
    () => projectAgent.runProjectAgentMode(PROJECT, ACTOR, "任何任务"),
    (error) => {
      assert.equal(error.code, "AGENT_DEPENDENCY_UNAVAILABLE");
      assert.equal(error.dependency, "fallback.runWithAgentModelFallback");
      return true;
    },
  );
});

test("project-agent 依赖缺失：toolLoop / providerAdapter 未注入同样结构化拒绝", async () => {
  for (const [key, dependency] of [["toolLoop", "toolLoop"], ["providerAdapter", "providerAdapter"]]) {
    buildHarness({ modelPlan: () => ({ content: "x", toolCalls: [] }) });
    projectAgent.configureProjectAgentMode({ [key]: null });
    await assert.rejects(
      () => projectAgent.runProjectAgentMode(PROJECT, ACTOR, "任何任务"),
      (error) => {
        assert.equal(error.code, "AGENT_DEPENDENCY_UNAVAILABLE");
        assert.equal(error.dependency, dependency);
        return true;
      },
    );
  }
});

test("project-agent 依赖缺失：skillRunner 未注入时技能分支记录结构化失败（不绕过）", async () => {
  const h = buildHarness({
    skillRunner: null,
    modelPlan: (request, count) => {
      if (count === 1) return { content: "", toolCalls: [{ id: "d1", name: "capability_discover", arguments: JSON.stringify({ intents: ["skill.demo"] }) }] };
      if (count === 2) return { content: "", toolCalls: [{ id: "s1", name: "skill__demo", arguments: "{}" }] };
      return { content: "技能不可用", toolCalls: [] };
    },
  });
  const result = await projectAgent.runProjectAgentMode(PROJECT, ACTOR, "调用技能");

  assert.equal(result.complete, true);
  const failed = h.events.find((event) => event[0] === "capability.failed");
  assert.ok(failed);
  assert.equal(failed[1].toolName, "skill__demo");
  assert.match(failed[1].message, /skillRunner/);
});

test("project-agent 验收不通过：退回本轮补齐后仍不通过则 complete=false", async () => {
  const reviewResponses = [
    '{"complete":false,"reason":"缺少产物","missingActions":["实际生成图片"]}',
    '{"complete":false,"reason":"仍未生成","missingActions":["生成图片"]}',
  ];
  let reviewIndex = 0;
  const h = buildHarness({
    reviewJson: null,
    modelPlan: () => ({ content: "我已完成", toolCalls: [] }),
  });
  // 覆盖 providerAdapter，让验收连续两次拒绝
  projectAgent.configureProjectAgentMode({
    providerAdapter: {
      autoFallback: () => false,
      chatWithTools: async (request) => {
        h.calls.push(request);
        if (!request.tools || request.tools.length === 0) return { content: reviewResponses[Math.min(reviewIndex++, reviewResponses.length - 1)] };
        return { content: "我已完成", toolCalls: [] };
      },
    },
  });
  const result = await projectAgent.runProjectAgentMode(PROJECT, ACTOR, "生成一张图");

  assert.equal(result.complete, false);
  assert.match(result.text, /任务尚未通过完成验收：仍未生成/);
  assert.ok(findEvent(h.events, "fail"));
});

test("project-agent 纯函数：compactObservation / mediaArtifacts / fileArtifact / parseCompletionReview", () => {
  assert.equal(projectAgent.compactObservation("x".repeat(9000)).length, 8000);
  const compact = projectAgent.compactObservation({ data: "secret", text: "y".repeat(9000), entries: Array.from({ length: 305 }, (_, i) => ({ name: "n" + i, type: "file", extra: 1 })) });
  assert.equal(compact.data, undefined);
  assert.equal(compact.text.length, 8000);
  assert.equal(compact.entries.length, 300);
  assert.equal(compact.entriesTruncated, 5);

  assert.deepEqual(projectAgent.mediaArtifacts({ images: [{ nodeId: "i1", name: "a.png" }], videos: [{ id: "v1" }], audios: [] }), [
    { id: "i1", nodeId: "i1", kind: "image", name: "a.png" },
    { id: "v1", nodeId: "v1", kind: "video", name: "" },
  ]);
  assert.deepEqual(projectAgent.fileArtifact({ nodeId: "n1", name: "f.txt" }), [{ id: "n1", nodeId: "n1", kind: "file", name: "f.txt" }]);
  assert.deepEqual(projectAgent.fileArtifact({ nodeId: "n1", deliverable: false }), []);

  assert.deepEqual(projectAgent.parseCompletionReview('前言 {"complete":true,"reason":"ok","missingActions":[]} 结尾'), { complete: true, reason: "ok", missingActions: [] });
  assert.equal(projectAgent.parseCompletionReview("不是 JSON").complete, false);
  assert.equal(projectAgent.parseCompletionReview('{"complete":false,"reason":"缺少产物"}').missingActions.length, 0);
});

test("project-agent 0.6.1 30 分钟窗口：到期先 checkpoint 并返回 waitingForUser", async () => {
  const h = buildHarness({ modelPlan: () => ({ content: "完成", toolCalls: [] }) });
  let saved = null;
  const result = await projectAgent.runProjectAgentMode(PROJECT, ACTOR, "长任务", [], {}, {
    windowMs: 0,
    saveCheckpoint: (checkpoint) => { saved = checkpoint; },
  });
  assert.equal(result.waitingForUser, true);
  assert.match(result.question, /继续任务/);
  assert.ok(saved && saved.state, "窗口到期必须先持久化 checkpoint");
  assert.ok(result.checkpoint && result.checkpoint.state, "返回的 checkpoint 必须可续跑");
  assert.equal(h.events.some((event) => event[0] === "complete"), false, "等待用户时不得把 Run 标完成");
});

test("project-agent 缺画布上下文：结构化 TOOL_CONTEXT_UNAVAILABLE 立即收口，不无界重试", async () => {
  const canvasTool = capTool("canvas_run", "canvas.run", "app.canvas");
  const canvasDescriptor = {
    name: "canvas_run", source: "app", sourceId: "canvas", risk: "write",
    requiredContext: ["app.canvas.current"],
    handler: { type: "client", command: "canvas/run" },
  };
  const h = buildHarness({
    tools: [canvasTool],
    descriptors: [canvasDescriptor],
    modelPlan: () => ({ content: "", toolCalls: [{ id: "c1", name: "canvas_run", arguments: "{}" }] }),
    toolCatalog: {
      runCatalogTool: async () => {
        const error = new Error("该工具需要画布前台上下文（app.canvas.current）。当前任务没有可用画布窗口，已停止重试。");
        error.code = "TOOL_CONTEXT_UNAVAILABLE";
        error.retryable = false;
        error.requiredContext = ["app.canvas.current"];
        throw error;
      },
    },
  });
  const result = await projectAgent.runProjectAgentMode(PROJECT, ACTOR, "在画布画一只猫");
  assert.equal(result.complete, false);
  assert.equal(result.errorCode, "TOOL_CONTEXT_UNAVAILABLE");
  assert.deepEqual(result.requiredContext, ["app.canvas.current"]);
  assert.match(result.text, /app\.canvas\.current/);
  assert.equal(planCalls(h).length, 1, "上下文确定缺失时只允许一次模型计划，不得无限重试");
  assert.ok(h.events.some((event) => event[0] === "capability.failed" && event[1].toolName === "canvas_run"));
  assert.equal(h.events.some((event) => event[0] === "planned" && event[1].phase === "completion-review"), false, "立即收口，不进入完成验收循环");
});
