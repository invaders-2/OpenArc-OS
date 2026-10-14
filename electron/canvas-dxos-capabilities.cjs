/**
 * B5c · 画布内核能力清单（源 server/canvasKernelCapabilities.ts，67 行）。
 *
 * 源做的事：把"当前安装的内置节点 + 插件 manifest"投影成 Kernel 能看到的**小工具面**
 *   · descriptor() 统一补能力身份 ← 源 :14-22（capabilityId=app:canvas:<name>、source=app、
 *     sourceId=canvas、domain=app.canvas、requiredContext=['app.canvas.current']、handler={type:'client'}）
 *   · 节点类型 / operation / action 的**动态枚举** ← 源 :6-12、:26-31
 *   · 静态工具表（run/compose/rename/move/resize/group/ungroup/connect/disconnect/delete/arrange）
 *     ← 源 :32-44，含 risk 与 sideEffects（delete → risk:'delete'、sideEffects:['delete:canvas-node']；
 *     run/compose → risk:'external'、sideEffects 含 call:model-provider）
 *   · 三个动态工具 create/operate/execute ← 源 :45-65
 *
 * 本仓差异（为什么不照抄工具名）：
 *   · OpenArc 没有 manifest operation/action，画布命令面是固定的 canvas-domain.COMMANDS
 *     （node.add/edit/move/copy/delete/group、edge.connect/disconnect）。因此这里把静态工具表
 *     **映射到真实存在的画布命令**，做不到的能力不列出（不造假能力）。
 *   · 源 canvas.execute_node 的"Graph Runtime / V2 Target"在本仓对应 canvas/run（一次生成 =
 *     一个 Task，见 canvas-service.cjs:367）。生成的风险与副作用沿用源 :33 的口径。
 *   · 本批次新增的素材库 / Agent 附件能力也在这里登记（与 dxos-canvas-commands.cjs 的命令表同源）。
 */
"use strict";

const crypto = require("node:crypto");
const domain = require("./canvas-domain.cjs");

const FORMAT = "dxos-canvas-kernel-capabilities/v1";
const SOURCE_ID = "canvas-kernel";

const readOnly = Object.freeze({ risk: "read", credential: "none", sideEffects: [] });
const write = Object.freeze({ risk: "write", credential: "none", sideEffects: ["modify:canvas"] });
const remove = Object.freeze({ risk: "delete", credential: "none", sideEffects: ["delete:canvas-node"] });
/** 源 :33：生成类能力必须显式声明"会调模型供应商"，凭据仍由 Model Service 持有（画布不持有）。 */
const external = Object.freeze({ risk: "external", credential: "none", sideEffects: ["modify:canvas", "call:model-provider"] });

const STATIC_TOOLS = Object.freeze([
  { name: "canvas.read", title: "读取画布", summary: "读取画布的标题、版本与有界节点摘要（不含素材字节与绝对路径）。", command: "canvas/read", profile: readOnly, commandType: null },
  { name: "canvas.create_node", title: "创建画布节点", summary: "按给定类型在画布上新建节点（对应 node.add）。", command: "canvas/command", profile: write, commandType: "node.add" },
  { name: "canvas.edit_node", title: "编辑画布节点", summary: "修改节点可编辑字段（对应 node.edit，id/type 不可改）。", command: "canvas/command", profile: write, commandType: "node.edit" },
  { name: "canvas.move_node", title: "移动画布节点", summary: "移动一个或多个节点（对应 node.move）。", command: "canvas/command", profile: write, commandType: "node.move" },
  { name: "canvas.copy_node", title: "复制画布节点", summary: "复制节点并偏移落位（对应 node.copy）。", command: "canvas/command", profile: write, commandType: "node.copy" },
  { name: "canvas.delete_nodes", title: "删除画布节点", summary: "删除节点并同时断开其连线（对应 node.delete）。", command: "canvas/command", profile: remove, commandType: "node.delete" },
  { name: "canvas.group_nodes", title: "节点分组", summary: "把两个以上节点收进一个群组（对应 node.group）。", command: "canvas/command", profile: write, commandType: "node.group" },
  { name: "canvas.connect_nodes", title: "连接节点", summary: "建立 from→to 的连线（对应 edge.connect）。", command: "canvas/command", profile: write, commandType: "edge.connect" },
  { name: "canvas.disconnect_nodes", title: "断开节点", summary: "按边 id 或 from/to 断开连线（对应 edge.disconnect）。", command: "canvas/command", profile: write, commandType: "edge.disconnect" },
  { name: "canvas.undo", title: "撤销画布命令", summary: "按命令账本回退上一条已应用命令。", command: "canvas/undo", profile: write, commandType: "undo" },
  { name: "canvas.run_generation", title: "运行画布生成", summary: "为某个节点发起一次生成（一次生成 = 一个 Task，含预算与停止归属）。", command: "canvas/run", profile: external, commandType: null },
  { name: "canvas.stop_generation", title: "停止画布生成", summary: "停止正在运行的生成并终结其 Task。", command: "canvas/runStop", profile: write, commandType: null },
  { name: "canvas.asset_library.list", title: "列举素材库", summary: "列举当前用户可见的素材库与条目（复用资源域 ResourceRef）。", command: "canvas/assetLibrary/list", profile: readOnly, commandType: null },
  { name: "canvas.asset_library.import", title: "导入素材", summary: "把字节导入素材库；同 checksum 复用同一 ResourceRef（去重）。", command: "canvas/assetLibrary/import", profile: write, commandType: null },
  { name: "canvas.asset_library.reference", title: "引用素材", summary: "返回素材的稳定 ResourceRef 与当前引用计数。", command: "canvas/assetLibrary/reference", profile: readOnly, commandType: null },
  { name: "canvas.agent_attachments.list", title: "列举 Agent 附件", summary: "列举挂载到画布上的 Agent 产物附件。", command: "canvas/agentAttachments/list", profile: readOnly, commandType: null },
  { name: "canvas.agent_attachments.mount", title: "挂载 Agent 附件", summary: "把 Agent 产物导入资源域并作为节点挂到画布上。", command: "canvas/agentAttachments/mount", profile: write, commandType: null },
  { name: "canvas.agent_attachments.unmount", title: "卸载 Agent 附件", summary: "从画布移除附件节点并标记卸载（资源本身保留）。", command: "canvas/agentAttachments/unmount", profile: remove, commandType: null },
]);

function schemaForTool(tool, nodeTypes) {
  switch (tool.name) {
    case "canvas.read":
      return { type: "object", properties: { canvasId: { type: "string" } }, required: ["canvasId"], additionalProperties: false };
    case "canvas.create_node":
      return { type: "object", properties: { canvasId: { type: "string" }, baseRevision: { type: "integer" }, nodeType: { type: "string", enum: nodeTypes }, title: { type: "string" } }, required: ["canvasId", "nodeType"], additionalProperties: true };
    case "canvas.edit_node":
      return { type: "object", properties: { canvasId: { type: "string" }, baseRevision: { type: "integer" }, nodeId: { type: "string" }, patch: { type: "object" } }, required: ["canvasId", "nodeId", "patch"], additionalProperties: false };
    case "canvas.move_node":
      return { type: "object", properties: { canvasId: { type: "string" }, baseRevision: { type: "integer" }, nodeId: { type: "string" }, x: { type: "number" }, y: { type: "number" } }, required: ["canvasId", "nodeId", "x", "y"], additionalProperties: false };
    case "canvas.copy_node":
      return { type: "object", properties: { canvasId: { type: "string" }, baseRevision: { type: "integer" }, nodeId: { type: "string" }, dx: { type: "number" }, dy: { type: "number" } }, required: ["canvasId", "nodeId"], additionalProperties: false };
    case "canvas.delete_nodes":
      return { type: "object", properties: { canvasId: { type: "string" }, baseRevision: { type: "integer" }, nodeIds: { type: "array", items: { type: "string" } } }, required: ["canvasId", "nodeIds"], additionalProperties: false };
    case "canvas.group_nodes":
      return { type: "object", properties: { canvasId: { type: "string" }, baseRevision: { type: "integer" }, nodeIds: { type: "array", items: { type: "string" } }, title: { type: "string" } }, required: ["canvasId", "nodeIds"], additionalProperties: false };
    case "canvas.connect_nodes":
      return { type: "object", properties: { canvasId: { type: "string" }, baseRevision: { type: "integer" }, from: { type: "string" }, to: { type: "string" } }, required: ["canvasId", "from", "to"], additionalProperties: false };
    case "canvas.disconnect_nodes":
      return { type: "object", properties: { canvasId: { type: "string" }, baseRevision: { type: "integer" }, edgeId: { type: "string" }, from: { type: "string" }, to: { type: "string" } }, required: ["canvasId"], additionalProperties: false };
    case "canvas.undo":
      return { type: "object", properties: { canvasId: { type: "string" }, baseRevision: { type: "integer" } }, required: ["canvasId"], additionalProperties: false };
    case "canvas.run_generation":
      return { type: "object", properties: { canvasId: { type: "string" }, nodeId: { type: "string" }, kind: { type: "string", enum: ["chat", "image"] } }, required: ["canvasId"], additionalProperties: false };
    case "canvas.stop_generation":
      return { type: "object", properties: { canvasId: { type: "string" }, runId: { type: "string" } }, required: ["canvasId", "runId"], additionalProperties: false };
    case "canvas.asset_library.list":
      return { type: "object", properties: { libraryId: { type: "string" } }, additionalProperties: false };
    case "canvas.asset_library.import":
      return { type: "object", properties: { libraryId: { type: "string" }, name: { type: "string" }, mime: { type: "string" }, dataUrl: { type: "string" }, title: { type: "string" }, group: { type: "string" }, sourceKey: { type: "string" } }, required: ["libraryId", "dataUrl"], additionalProperties: false };
    case "canvas.asset_library.reference":
      return { type: "object", properties: { libraryId: { type: "string" }, itemId: { type: "string" } }, required: ["libraryId", "itemId"], additionalProperties: false };
    case "canvas.agent_attachments.list":
      return { type: "object", properties: { canvasId: { type: "string" }, includeRemoved: { type: "boolean" } }, required: ["canvasId"], additionalProperties: false };
    case "canvas.agent_attachments.mount":
      return { type: "object", properties: { canvasId: { type: "string" }, files: { type: "array", items: { type: "object" } }, runId: { type: "string" } }, required: ["canvasId", "files"], additionalProperties: false };
    case "canvas.agent_attachments.unmount":
      return { type: "object", properties: { canvasId: { type: "string" }, attachmentId: { type: "string" } }, required: ["canvasId", "attachmentId"], additionalProperties: false };
    default:
      return { type: "object", properties: {}, additionalProperties: true };
  }
}

/**
 * 源 :14-22 的 descriptor()：统一补能力身份。
 */
function capabilityDescriptor(tool, { nodeTypes }) {
  return {
    capabilityId: "app:canvas:" + tool.name,
    name: tool.name.replace(/\./g, "_"),
    title: tool.title,
    summary: tool.summary,
    description: tool.summary,
    source: "app",
    sourceId: SOURCE_ID,
    appId: "canvas",
    domain: "app.canvas",
    enabled: true,
    executable: true,
    status: "ready",
    statusText: "Canvas 客户端受控执行",
    risk: tool.profile.risk,
    credential: tool.profile.credential,
    sideEffects: [...tool.profile.sideEffects],
    permissions: [],
    whenToUse: [],
    intents: [tool.name, ...(tool.commandType ? ["canvas.operation." + tool.commandType] : [])],
    inputSchema: schemaForTool(tool, nodeTypes),
    requiredContext: ["app.canvas.current"],
    handler: { type: "client", command: tool.command, commandType: tool.commandType || null },
  };
}

/**
 * @param nodeTypes 附加的节点类型（内置的 canvas-domain.NODE_TYPES 始终在列，源 :6-12 的插件枚举位置）
 */
function buildCanvasKernelCapabilities({ nodeTypes = [], extraTools = [] } = {}) {
  const types = [...new Set([...domain.NODE_TYPES, ...(Array.isArray(nodeTypes) ? nodeTypes : [])].filter((t) => typeof t === "string" && t))].sort();
  const tools = [...STATIC_TOOLS, ...(Array.isArray(extraTools) ? extraTools : [])];
  return {
    format: FORMAT,
    generatedAt: Date.now(),
    digest: crypto.createHash("sha256").update(JSON.stringify(tools.map((tool) => [tool.name, tool.profile.risk, tool.command, tool.commandType]))).digest("hex"),
    nodeTypes: types,
    agentCommands: [...domain.AGENT_COMMANDS].sort(),
    capabilities: tools.map((tool) => capabilityDescriptor(tool, { nodeTypes: types })),
  };
}

/** agent-tool-catalog.cjs:62-65 期望的 descriptor 形状（sourceList 不 await）。 */
function toCatalogDescriptors(capabilities) {
  return capabilities.map((capability) => ({
    name: capability.name,
    title: capability.title,
    description: capability.summary,
    source: "app",
    sourceId: SOURCE_ID,
    enabled: true,
    executable: true,
    status: "ready",
    statusText: capability.statusText,
    inputSchema: capability.inputSchema,
    permissions: [],
    risk: capability.risk,
    sideEffects: capability.sideEffects,
    whenToUse: [],
    domain: "app.canvas",
    intents: capability.intents,
    requiredContext: capability.requiredContext,
    credential: capability.credential,
    handler: capability.handler,
  }));
}

/** 注入 configureToolCatalog({ sources: { canvas: buildCanvasCatalogSource() } }) 的来源契约。 */
function buildCanvasCatalogSource({ nodeTypes = [], extraTools = [] } = {}) {
  return {
    list() { return toCatalogDescriptors(buildCanvasKernelCapabilities({ nodeTypes, extraTools }).capabilities); },
  };
}

module.exports = {
  FORMAT, SOURCE_ID, STATIC_TOOLS,
  buildCanvasKernelCapabilities, toCatalogDescriptors, buildCanvasCatalogSource, capabilityDescriptor,
};
