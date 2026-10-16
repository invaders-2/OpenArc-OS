/**
 * D4-03A · Tool Registry（唯一权威）。
 *
 * Registry 只由 OpenArc trusted code 管理：Harness 不能 register / modify schema /
 * enable / 改 risk class。每个 Tool 有固定 contract（id/version/schema/risk/sideEffect/
 * requiresApproval/permissions/executionProvider/enabled）。
 *
 * 内置少量测试 Tool（test.echo / resource.read.metadata）；**绝不注册** shell / terminal /
 * filesystem.write / process.spawn / MCP / browser side-effect。
 *
 * B4e 例外（唯一入口）：MCP 外部工具由 electron/mcp-tool-contract.cjs 在目录快照时**幂等登记**为
 * riskClass = EXTERNAL_SIDE_EFFECT 的 contract（requiresApproval 由 risk 推导）；它不在 BUILTIN_CONTRACTS，
 * 也不进 dsh manifest allowlist（READ_TOOL_IDS / WRITE_TOOL_IDS 是唯一真源），执行权仍在外部 MCP 服务端。
 */
"use strict";
const crypto = require("node:crypto");
const domain = require("./tool-domain.cjs");
const { RISK_CLASS, SIDE_EFFECT, TOOL_ERROR, isWellFormedToolId, approvalRequiredForRisk, sideEffectForRisk } = domain;

const CONTRACT_FIELDS = ["toolId", "version", "displayName", "description", "inputSchema", "outputSchema", "riskClass", "sideEffect", "requiresApproval", "requiredPermissions", "resourceActions", "executionProvider", "enabled", "expectedSideEffects",
  // D4-03C1：write contract 必须显式声明 side-effect authority 合同。
  "idempotencySupport", "verificationStrategy", "approvalPolicy", "leasePolicy",
  // D4-03C2：只有显式声明 executionPolicy 的 contract 才允许真实受控写入。
  "executionPolicy",
  // D5-02：显式声明哪些顶层参数是结构化对象（豁免 §23/§24 denylist 的同名误判）。
  "structuredArguments",
  // D5-04：外部 MCP 工具的反向目标（serverId/toolName），供 side-effect provider 解析执行对象。
  "externalTarget"];

/** 极简 JSON Schema 子集校验器：object/string/integer/number/boolean/array + additionalProperties:false。*/
function validateSchema(schema, value, path = "$") {
  const errors = [];
  if (!schema || typeof schema !== "object") return { ok: true, errors };
  const type = schema.type;
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const typeOk = !type || (type === "integer" ? Number.isInteger(value) : type === "number" ? typeof value === "number" : type === "object" ? actual === "object" : type === "array" ? actual === "array" : actual === type);
  if (!typeOk) { errors.push({ path, reason: "TYPE_MISMATCH", expected: type }); return { ok: false, errors }; }
  if (type === "object" && value && typeof value === "object") {
    const props = schema.properties || {};
    for (const req of schema.required || []) if (!Object.prototype.hasOwnProperty.call(value, req)) errors.push({ path: path + "." + req, reason: "REQUIRED" });
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(props, key)) {
        if (schema.additionalProperties === false) errors.push({ path: path + "." + key, reason: "ADDITIONAL_PROPERTY" });
        continue;
      }
      const sub = validateSchema(props[key], value[key], path + "." + key);
      if (!sub.ok) errors.push(...sub.errors);
    }
  }
  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) errors.push({ path, reason: "MIN_LENGTH" });
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push({ path, reason: "MAX_LENGTH" });
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push({ path, reason: "PATTERN" });
    if (schema.enum && !schema.enum.includes(value)) errors.push({ path, reason: "ENUM" });
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) errors.push({ path, reason: "MINIMUM" });
    if (schema.maximum != null && value > schema.maximum) errors.push({ path, reason: "MAXIMUM" });
  }
  if (Array.isArray(value)) {
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push({ path, reason: "MAX_ITEMS" });
    if (schema.items) value.forEach((v, i) => { const sub = validateSchema(schema.items, v, path + "[" + i + "]"); if (!sub.ok) errors.push(...sub.errors); });
  }
  return { ok: errors.length === 0, errors };
}

/** 内置少量真实测试 Tool contract。*/
const BUILTIN_CONTRACTS = Object.freeze([
  {
    toolId: "test.echo",
    version: 1,
    displayName: "Test Echo",
    description: "测试专用：原样返回 message。无副作用，绝不在生产 profile 注册。",
    inputSchema: { type: "object", additionalProperties: false, properties: { message: { type: "string", minLength: 1, maxLength: 200 } }, required: ["message"] },
    outputSchema: { type: "object", additionalProperties: false, properties: { echo: { type: "string" } }, required: ["echo"] },
    riskClass: RISK_CLASS.READ_ONLY,
    sideEffect: SIDE_EFFECT.NONE,
    requiresApproval: false,
    requiredPermissions: [],
    resourceActions: [],
    executionProvider: "test",
    enabled: true,
    expectedSideEffects: ["no side effect"],
  },
  {
    toolId: "test.write",
    version: 1,
    displayName: "Test Write (approval probe)",
    description: "测试专用：可逆写入探针，永久 requiresApproval；D4-03A 绝不执行。",
    inputSchema: { type: "object", additionalProperties: false, properties: { target: { type: "string", minLength: 1, maxLength: 100 } }, required: ["target"] },
    outputSchema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } }, required: ["ok"] },
    riskClass: RISK_CLASS.REVERSIBLE_WRITE,
    sideEffect: SIDE_EFFECT.WRITE,
    requiresApproval: true,
    requiredPermissions: [],
    resourceActions: [],
    executionProvider: "test",
    enabled: true,
    expectedSideEffects: ["writes test target (dry-run only in D4-03A; never executed)"],
    idempotencySupport: true,
    verificationStrategy: "READ_AFTER_WRITE",
    approvalPolicy: "ONE_CALL",
    leasePolicy: "SINGLE_ACTIVE",
  },
  {
    toolId: "test.noverify",
    version: 1,
    displayName: "Test Write without verification (C1 boundary probe)",
    description: "测试专用：REVERSIBLE_WRITE 但无 verificationStrategy → 永久 SIDE_EFFECT_VERIFICATION_UNAVAILABLE。",
    inputSchema: { type: "object", additionalProperties: false, properties: { target: { type: "string", minLength: 1, maxLength: 100 } }, required: ["target"] },
    outputSchema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } }, required: ["ok"] },
    riskClass: RISK_CLASS.REVERSIBLE_WRITE,
    sideEffect: SIDE_EFFECT.WRITE,
    requiresApproval: true,
    requiredPermissions: [],
    resourceActions: [],
    executionProvider: "test",
    enabled: true,
    expectedSideEffects: ["never executed: no verification strategy"],
    idempotencySupport: true,
    verificationStrategy: null,
    approvalPolicy: "ONE_CALL",
    leasePolicy: "SINGLE_ACTIVE",
  },
  {
    toolId: "resource.read.metadata",
    version: 1,
    displayName: "Read Resource Metadata",
    description: "读取 Resource metadata（D4-03A 只做 dry-run ExecutionPlan，不执行）。",
    inputSchema: { type: "object", additionalProperties: false, properties: { resourceRef: { type: "string", pattern: "^resource://[A-Za-z0-9_-]+$" } }, required: ["resourceRef"] },
    outputSchema: { type: "object", additionalProperties: false, properties: { resourceRef: { type: "string" }, name: { type: "string" }, resourceType: { type: "string" }, mimeType: { type: "string" }, version: { type: "integer" }, updatedAt: { type: "integer" }, size: { type: "number" }, scope: { type: "string" } }, required: ["resourceRef", "name", "resourceType", "mimeType", "version", "updatedAt"] },
    riskClass: RISK_CLASS.READ_ONLY,
    sideEffect: SIDE_EFFECT.READ,
    requiresApproval: false,
    requiredPermissions: ["tool.resource.readMetadata"],
    resourceActions: ["resource.read"],
    executionProvider: "ResourceService",
    enabled: true,
    expectedSideEffects: ["reads resource metadata"],
  },
  {
    toolId: "resource.search",
    version: 1,
    displayName: "Search Resources",
    description: "在已授权范围内搜索 Resource（READ_ONLY，D4-03B 真实执行，服务端授权过滤）。",
    inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string", minLength: 1, maxLength: 200 }, limit: { type: "integer", minimum: 1, maximum: 20 }, kind: { type: "string", maxLength: 40 } }, required: ["query"] },
    outputSchema: { type: "object", additionalProperties: false, properties: { items: { type: "array", maxItems: 20, items: { type: "object", additionalProperties: false, properties: { resourceRef: { type: "string" }, name: { type: "string" }, resourceType: { type: "string" }, mimeType: { type: "string" }, version: { type: "integer" }, snippet: { type: "string" } }, required: ["resourceRef", "name", "resourceType", "version"] } }, count: { type: "integer" }, truncated: { type: "boolean" }, maxLimit: { type: "integer" } }, required: ["items", "count", "truncated"] },
    riskClass: RISK_CLASS.READ_ONLY,
    sideEffect: SIDE_EFFECT.READ,
    requiresApproval: false,
    requiredPermissions: ["tool.resource.search"],
    resourceActions: [],
    executionProvider: "SearchService",
    enabled: true,
    expectedSideEffects: ["reads authorized resource index (no mutation)"],
  },
  {
    // D5-01 Closure · 最小受控浏览器能力（读取）：目标标签由用户在渲染层显式选择，
    // 后端校验账号 / App / 标签归属；正文作为**不可信参考数据**有界返回。
    toolId: "browser.read.page",
    version: 1,
    displayName: "Read Browser Page",
    description: "读取用户已授权控制的浏览器标签的页面信息与有界正文（READ_ONLY；不支持任意脚本）。",
    // viewId 缺省时由后端在**已授权目标**里解析（恰好一个才可推断，多个必须显式指定）；
    // 模型给了 viewId 也只是"请求"，是否可用一律由 BrowserControlAuthority 判定。
    inputSchema: { type: "object", additionalProperties: false, properties: { viewId: { type: "string", pattern: "^[A-Za-z0-9_:.#-]{1,80}$" } }, required: [] },
    outputSchema: { type: "object", additionalProperties: false, properties: { viewId: { type: "string" }, url: { type: "string" }, title: { type: "string" }, text: { type: "string" }, truncated: { type: "boolean" }, untrusted: { type: "boolean" } }, required: ["viewId", "url", "title", "text", "truncated"] },
    riskClass: RISK_CLASS.READ_ONLY,
    sideEffect: SIDE_EFFECT.READ,
    requiresApproval: false,
    requiredPermissions: ["tool.browser.read"],
    resourceActions: [],
    executionProvider: "BrowserControl",
    enabled: true,
    expectedSideEffects: ["reads the selected tab's page text (untrusted reference data, bounded)"],
  },
  {
    // 导航：**副作用**，绝不标成只读；requiresApproval + CONTROLLED_REVERSIBLE_WRITE，
    // 只有既有工具门 / 审批路径放行后才会执行（复用产品 safeURL 策略）。
    toolId: "browser.navigate",
    version: 1,
    displayName: "Navigate Browser Tab",
    description: "导航用户已授权控制的浏览器标签到指定 http(s) 地址（REVERSIBLE_WRITE；需审批）。",
    // url 在**工具门**就先收窄到 http(s) 且不含凭据（pattern 里排除 "@"），
    // 执行前还会再过一次产品 safeURL —— 两层都拒绝，绝不只靠一层。
    inputSchema: { type: "object", additionalProperties: false, properties: { viewId: { type: "string", pattern: "^[A-Za-z0-9_:.#-]{1,80}$" }, url: { type: "string", maxLength: 2000, pattern: "^https?://[^\\s@]+$" } }, required: ["url"] },
    // url = **真实落地地址**（可能因服务器 302 与 requested 不同，redirected 如实标记）；
    // noop = 同址导航（确实发出过请求，但没有地址变化），绝不冒充写入。
    outputSchema: { type: "object", additionalProperties: false, properties: { viewId: { type: "string" }, url: { type: "string" }, ok: { type: "boolean" }, requested: { type: "string" }, redirected: { type: "boolean" }, noop: { type: "boolean" }, dispatchSeq: { type: "integer" } }, required: ["viewId", "url", "ok"] },
    riskClass: RISK_CLASS.REVERSIBLE_WRITE,
    sideEffect: SIDE_EFFECT.WRITE,
    requiresApproval: true,
    requiredPermissions: ["tool.browser.navigate"],
    resourceActions: [],
    executionProvider: "BrowserControl",
    enabled: true,
    expectedSideEffects: ["browser tab navigation (reversible by navigating back)"],
    idempotencySupport: true,
    verificationStrategy: "READ_AFTER_WRITE",
    approvalPolicy: "ONE_CALL",
    leasePolicy: "SINGLE_ACTIVE",
    executionPolicy: "CONTROLLED_REVERSIBLE_WRITE",
  },
  {
    // D5-02：读取画布（节点/连线摘要，READ_ONLY）。目标画布必须属于当前账号或被共享给它。
    toolId: "canvas.read",
    version: 1,
    displayName: "Read Canvas",
    description: "读取指定画布的节点与连线摘要（READ_ONLY；不含凭据、不含资源字节）。",
    inputSchema: { type: "object", additionalProperties: false, properties: { canvasId: { type: "string", pattern: "^[A-Za-z0-9_.#:-]{1,120}$" } }, required: ["canvasId"] },
    outputSchema: { type: "object", additionalProperties: false, properties: { canvasId: { type: "string" }, revision: { type: "integer" }, nodeCount: { type: "integer" }, edgeCount: { type: "integer" }, nodes: { type: "array" }, untrusted: { type: "boolean" } }, required: ["canvasId", "revision", "nodeCount", "edgeCount"] },
    riskClass: RISK_CLASS.READ_ONLY,
    sideEffect: SIDE_EFFECT.READ,
    requiresApproval: false,
    requiredPermissions: ["tool.canvas.read"],
    resourceActions: [],
    executionProvider: "CanvasControl",
    enabled: true,
    expectedSideEffects: ["reads the canvas document summary (no mutation)"],
  },
  {
    // D5-02：编辑画布。**与手工路径同一个命令处理层**（canvas-domain.applyCommand）+
    // 同一份版本检查（baseRevision）+ 同一份权限规则（evaluateCanvasAccess）。
    // 只接受结构化命令（不接受整篇文档覆盖），目标节点以 id 标识。
    toolId: "canvas.edit",
    version: 1,
    displayName: "Edit Canvas",
    description: "对指定画布执行一条结构化命令（添加/编辑/移动/复制/删除/分组/连线/断开；REVERSIBLE_WRITE，需审批）。",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        canvasId: { type: "string", pattern: "^[A-Za-z0-9_.#:-]{1,120}$" },
        baseRevision: { type: "integer", minimum: 1 },
        command: {
          type: "object", additionalProperties: true,
          properties: { type: { type: "string", pattern: "^[a-z]+\\.[a-z]+$" } },
          required: ["type"],
        },
      },
      required: ["canvasId", "command"],
    },
    outputSchema: { type: "object", additionalProperties: false, properties: { canvasId: { type: "string" }, revision: { type: "integer" }, commandType: { type: "string" }, nodeIds: { type: "array" }, edgeIds: { type: "array" } }, required: ["canvasId", "revision", "commandType"] },
    riskClass: RISK_CLASS.REVERSIBLE_WRITE,
    sideEffect: SIDE_EFFECT.WRITE,
    requiresApproval: true,
    requiredPermissions: ["tool.canvas.edit"],
    resourceActions: [],
    executionProvider: "CanvasControl",
    enabled: true,
    expectedSideEffects: ["canvas document mutation (reversible via undo record)"],
    // command 是**结构化命令对象**（合同 schema 已收窄 type / additionalProperties），
    // 与 §23/§24 denylist 里的 shell "command" 字符串同名不同物：显式声明豁免，绝不改 denylist 本身。
    structuredArguments: ["command"],
    // 如实声明：recovery/verify 都已实现（READ_AFTER_WRITE + 画布命令日志 fingerprint 的 recoveryVerify），
    // idempotencyKey = callId+toolId+version+argumentsHash+targets，不引入自动重试（AUTO_RETRY 恒为 0）。
    idempotencySupport: true,
    verificationStrategy: "READ_AFTER_WRITE",
    approvalPolicy: "ONE_CALL",
    leasePolicy: "SINGLE_ACTIVE",
    executionPolicy: "CONTROLLED_REVERSIBLE_WRITE",
  },
  {
    toolId: "resource.trash",
    version: 1,
    displayName: "Trash Resource",
    description: "D4-03C2 第一条受控真实 REVERSIBLE_WRITE：把 Resource 移入 Trash（ResourceService.delete）。",
    inputSchema: { type: "object", additionalProperties: false, properties: { resourceRef: { type: "string", pattern: "^resource://[A-Za-z0-9_-]+$" } }, required: ["resourceRef"] },
    outputSchema: { type: "object", additionalProperties: false, properties: { resourceRef: { type: "string" }, trashed: { type: "boolean" }, version: { type: "integer" } }, required: ["resourceRef", "trashed"] },
    riskClass: RISK_CLASS.REVERSIBLE_WRITE,
    sideEffect: SIDE_EFFECT.WRITE,
    requiresApproval: true,
    requiredPermissions: ["tool.resource.trash"],
    resourceActions: ["resource.delete"],
    executionProvider: "ResourceService",
    enabled: true,
    expectedSideEffects: ["resource.trash_state -> TRASHED (reversible via ResourceService.restore)"],
    idempotencySupport: true,
    verificationStrategy: "READ_AFTER_WRITE",
    approvalPolicy: "ONE_CALL",
    leasePolicy: "SINGLE_ACTIVE",
    executionPolicy: "CONTROLLED_REVERSIBLE_WRITE",
  },
  {
    // 10-16 · 素材库 AI：读正文。文本类返回有界正文；图片返回 canvasUrl（openarc-asset:<id>），
    // 可直接作为 canvas.edit 的 node.add 图片节点 url，在画布里引用素材库原图（不复制字节）。
    toolId: "resource.read.content",
    version: 1,
    displayName: "Read Resource Content",
    description: "读取资源库里一个资源的正文（文本类最多 32000 字，超出截断）。图片返回 canvasUrl，可用于 canvas_edit 的 node.add（type:image, url:canvasUrl）在画布里引用原图；其它二进制只返回类型。READ_ONLY。",
    inputSchema: { type: "object", additionalProperties: false, properties: { resourceRef: { type: "string", pattern: "^resource://[A-Za-z0-9_-]+$" }, maxChars: { type: "integer", minimum: 200, maximum: 32000 } }, required: ["resourceRef"] },
    outputSchema: { type: "object", additionalProperties: false, properties: { resourceRef: { type: "string" }, name: { type: "string" }, mimeType: { type: "string" }, contentKind: { type: "string" }, text: { type: "string" }, truncated: { type: "boolean" }, size: { type: "number" }, canvasUrl: { type: "string" }, note: { type: "string" } }, required: ["resourceRef", "name", "contentKind"] },
    riskClass: RISK_CLASS.READ_ONLY,
    sideEffect: SIDE_EFFECT.READ,
    requiresApproval: false,
    requiredPermissions: ["tool.resource.readContent"],
    resourceActions: ["resource.read"],
    executionProvider: "ResourceContent",
    enabled: true,
    expectedSideEffects: ["reads bounded resource content (no mutation)"],
  },
  {
    // 10-16 · 素材库 AI：把生成的文本存回素材库。新建资源 = 可逆写入（移入废纸篓即撤销），需审批。
    // 幂等：资源记录生成来源 callId；同一 callId 重放时复用已有资源，恢复核验按 callId 三态判定。
    toolId: "resource.save.text",
    version: 1,
    displayName: "Save Text To Library",
    description: "把生成的文本结果保存为资源库里的新文本资源（REVERSIBLE_WRITE，需审批；可在资源库移入废纸篓撤销）。",
    inputSchema: { type: "object", additionalProperties: false, properties: { name: { type: "string", minLength: 1, maxLength: 120, pattern: "^[^/\\\\:*?\"<>|\\u0000-\\u001f]+$" }, content: { type: "string", minLength: 1, maxLength: 200000 }, description: { type: "string", maxLength: 500 } }, required: ["name", "content"] },
    outputSchema: { type: "object", additionalProperties: false, properties: { resourceRef: { type: "string" }, name: { type: "string" }, version: { type: "integer" }, size: { type: "number" }, reused: { type: "boolean" } }, required: ["resourceRef", "name"] },
    riskClass: RISK_CLASS.REVERSIBLE_WRITE,
    sideEffect: SIDE_EFFECT.WRITE,
    requiresApproval: true,
    requiredPermissions: ["tool.resource.saveText"],
    // 新建资源没有既有 ResourceRef：创建权限由 ResourceService.importText 的 authorizeCreate 在执行时裁决。
    resourceActions: [],
    executionProvider: "ResourceContent",
    enabled: true,
    expectedSideEffects: ["creates one text resource in the library (reversible via trash)"],
    idempotencySupport: true,
    verificationStrategy: "READ_AFTER_WRITE",
    approvalPolicy: "ONE_CALL",
    leasePolicy: "SINGLE_ACTIVE",
    executionPolicy: "CONTROLLED_REVERSIBLE_WRITE",
  },
]);

/** dsh tool 名必须是合法标识符：resource.search → resource_search。 */
function toolDefinitionName(toolId) { return String(toolId).replace(/[^A-Za-z0-9]+/g, "_"); }

/**
 * official dsh Tool Runtime 只接受 JSON Schema 子集
 * （type/oneOf/properties/required/additionalProperties/items/enum/const + annotations）。
 * Manifest 里的 model-facing schema 是该子集的投影；完整约束仍由 OpenArc Registry 权威校验。
 */
const DSH_SCHEMA_KEYS = ["type", "oneOf", "properties", "required", "additionalProperties", "items", "enum", "const", "description", "title", "default"];
function projectJsonSchema(schema) {
  if (schema == null || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map((s) => projectJsonSchema(s));
  const out = {};
  for (const key of DSH_SCHEMA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) continue;
    const v = schema[key];
    if (key === "properties" && v && typeof v === "object") { out.properties = {}; for (const [k, sub] of Object.entries(v)) out.properties[k] = projectJsonSchema(sub); }
    else if (key === "items") out.items = projectJsonSchema(v);
    else if (key === "oneOf" && Array.isArray(v)) out.oneOf = v.map((s) => projectJsonSchema(s));
    else out[key] = v;
  }
  return out;
}

/**
 * D4-03B Closure · Safe Tool Manifest。
 * 只暴露 READ_ONLY contract 的 schema metadata；WRITE / EXTERNAL / PRIVILEGED 一律拒绝。
 * contractHash 覆盖 toolId/version/input/output/risk，dsh 侧旧 manifest 与 Registry 不一致时
 * 必须 TOOL_CONTRACT_STALE，绝不静默继续。
 */
function buildToolManifest(registry, { toolIds = null } = {}) {
  const ids = (toolIds && toolIds.length ? toolIds : registry.ids()).slice().sort();
  const tools = [];
  for (const id of ids) {
    const versions = registry.versionsOf(id);
    const version = versions.length ? versions[versions.length - 1] : null;
    if (version == null) throw new Error("manifest tool not registered: " + id);
    const c = registry.get(id, version);
    if (c.riskClass !== RISK_CLASS.READ_ONLY) throw new Error("manifest 只允许 READ_ONLY tool: " + id);
    tools.push({ toolId: c.toolId, version: c.version, name: toolDefinitionName(c.toolId), displayName: c.displayName, description: String(c.description || "").slice(0, 300), inputSchema: projectJsonSchema(c.inputSchema), outputSchema: projectJsonSchema(c.outputSchema), riskClass: c.riskClass });
  }
  const hashInput = tools.map((t) => ({ toolId: t.toolId, version: t.version, inputSchema: t.inputSchema, outputSchema: t.outputSchema, riskClass: t.riskClass }));
  const contractHash = crypto.createHash("sha256").update(JSON.stringify(hashInput)).digest("hex");
  return Object.freeze({ contractHash, toolIds: Object.freeze(ids), tools: Object.freeze(tools) });
}

/**
 * D4-03C4 · Side-effect proposal manifest（WRITE route）。
 *
 * **与 READ_ONLY facade 显式分离**：WRITE tool 只暴露 schema metadata，供 official dsh
 * 提出 Tool Proposal；它绝不能走 READ_ONLY execution route。只有显式声明
 * executionPolicy = CONTROLLED_REVERSIBLE_WRITE 的 REVERSIBLE_WRITE contract 才允许进入。
 */
function buildWriteToolManifest(registry, { toolIds = null } = {}) {
  const ids = (toolIds && toolIds.length ? toolIds : registry.ids()).slice().sort();
  const tools = [];
  for (const id of ids) {
    const versions = registry.versionsOf(id);
    const version = versions.length ? versions[versions.length - 1] : null;
    if (version == null) throw new Error("write manifest tool not registered: " + id);
    const c = registry.get(id, version);
    if (c.riskClass !== RISK_CLASS.REVERSIBLE_WRITE) throw new Error("write manifest 只允许 REVERSIBLE_WRITE tool: " + id);
    if (c.executionPolicy !== "CONTROLLED_REVERSIBLE_WRITE") throw new Error("write manifest 只允许受控 executionPolicy: " + id);
    tools.push({ toolId: c.toolId, version: c.version, name: toolDefinitionName(c.toolId), displayName: c.displayName, description: String(c.description || "").slice(0, 300), inputSchema: projectJsonSchema(c.inputSchema), outputSchema: projectJsonSchema(c.outputSchema), riskClass: c.riskClass });
  }
  const hashInput = tools.map((t) => ({ toolId: t.toolId, version: t.version, inputSchema: t.inputSchema, outputSchema: t.outputSchema, riskClass: t.riskClass }));
  const contractHash = crypto.createHash("sha256").update(JSON.stringify(hashInput)).digest("hex");
  return Object.freeze({ contractHash, toolIds: Object.freeze(ids), tools: Object.freeze(tools) });
}

const ROUTE = Object.freeze({ READ_ONLY: "READ_ONLY", SIDE_EFFECT_PROPOSAL: "SIDE_EFFECT_PROPOSAL" });

/**
 * official dsh Tool Runtime 的**组合** manifest：READ_ONLY tools + 受控 WRITE proposal tools，
 * 并给每个 toolId 标注唯一 route。route 由 Tool Registry 的 riskClass 推导，
 * Harness 无法自行声明 route。
 */
function buildBridgeManifest(registry, { readToolIds = [], writeToolIds = [] } = {}) {
  const readIds = [...readToolIds].map(String).filter(Boolean).sort();
  const writeIds = [...writeToolIds].map(String).filter(Boolean).sort();
  const read = readIds.length ? buildToolManifest(registry, { toolIds: readIds }) : { tools: [], toolIds: [] };
  const write = writeIds.length ? buildWriteToolManifest(registry, { toolIds: writeIds }) : { tools: [], toolIds: [] };
  const tools = [...read.tools, ...write.tools];
  const routes = {};
  for (const t of read.tools) routes[t.toolId] = ROUTE.READ_ONLY;
  for (const t of write.tools) routes[t.toolId] = ROUTE.SIDE_EFFECT_PROPOSAL;
  const toolIds = [...read.toolIds, ...write.toolIds].sort();
  const hashInput = tools.map((t) => ({ toolId: t.toolId, version: t.version, inputSchema: t.inputSchema, outputSchema: t.outputSchema, riskClass: t.riskClass }));
  const contractHash = crypto.createHash("sha256").update(JSON.stringify(hashInput)).digest("hex");
  return Object.freeze({ contractHash, toolIds: Object.freeze(toolIds), tools: Object.freeze(tools), routes: Object.freeze(routes) });
}

function frozenContract(c) {
  return Object.freeze({ ...c, requiredPermissions: Object.freeze([...(c.requiredPermissions || [])]), resourceActions: Object.freeze([...(c.resourceActions || [])]), expectedSideEffects: Object.freeze([...(c.expectedSideEffects || [])]), structuredArguments: Object.freeze([...(c.structuredArguments || [])]) });
}

class ToolRegistry {
  constructor({ contracts = null } = {}) {
    this.tools = new Map();
    for (const c of (contracts && contracts.length ? contracts : BUILTIN_CONTRACTS)) this.register(c);
  }
  key(toolId, version) { return String(toolId) + "@" + String(version); }
  register(contract) {
    if (!contract || typeof contract !== "object") throw new Error("tool contract required");
    const toolId = String(contract.toolId || "");
    if (!isWellFormedToolId(toolId)) throw new Error("invalid toolId: " + toolId);
    const version = Number(contract.version);
    if (!Number.isInteger(version) || version < 1) throw new Error("invalid tool version: " + contract.version);
    if (!domain.RISK_CLASS_ALL.includes(contract.riskClass)) throw new Error("invalid riskClass: " + contract.riskClass);
    if (contract.sideEffect && !domain.SIDE_EFFECT_ALL.includes(contract.sideEffect)) throw new Error("invalid sideEffect: " + contract.sideEffect);
    if (contract.inputSchema && contract.inputSchema.type !== "object") throw new Error("inputSchema must be object");
    if (this.tools.has(this.key(toolId, version))) throw new Error("duplicate tool contract: " + this.key(toolId, version));
    const normalized = frozenContract({
      sideEffect: sideEffectForRisk(contract.riskClass),
      requiresApproval: approvalRequiredForRisk(contract.riskClass),
      idempotencySupport: contract.idempotencySupport !== undefined ? !!contract.idempotencySupport : false,
      verificationStrategy: contract.verificationStrategy || null,
      approvalPolicy: contract.approvalPolicy || (contract.riskClass === RISK_CLASS.READ_ONLY ? "NONE" : "ONE_CALL"),
      leasePolicy: contract.leasePolicy || (contract.riskClass === RISK_CLASS.READ_ONLY ? "NONE" : "SINGLE_ACTIVE"),
      executionPolicy: contract.executionPolicy || null,
      ...contract, toolId, version,
    });
    this.tools.set(this.key(toolId, version), normalized);
    return normalized;
  }
  /** 稳定 toolId 集合（版本无关）。*/
  ids() { return [...new Set([...this.tools.keys()].map((k) => k.split("@")[0]))].sort(); }
  versionsOf(toolId) { return [...this.tools.keys()].filter((k) => k.split("@")[0] === String(toolId)).map((k) => Number(k.split("@")[1])).sort((a, b) => a - b); }
  get(toolId, version) { return this.tools.get(this.key(toolId, version)) || null; }
  list() { return [...this.tools.values()].map((c) => ({ toolId: c.toolId, version: c.version, displayName: c.displayName, riskClass: c.riskClass, sideEffect: c.sideEffect, requiresApproval: c.requiresApproval, enabled: c.enabled })); }
  /**
   * resolve：未知 / 版本不符 / disabled 均返回 ok:false，但尽量带 contract 供 decision 记录 risk。
   */
  resolve(toolId, version) {
    if (!isWellFormedToolId(toolId)) return { ok: false, error: TOOL_ERROR.TOOL_NOT_FOUND };
    const versions = this.versionsOf(toolId);
    if (!versions.length) return { ok: false, error: TOOL_ERROR.TOOL_NOT_FOUND };
    const v = Number(version);
    const contract = this.get(toolId, v);
    if (!contract) return { ok: false, error: TOOL_ERROR.TOOL_VERSION_UNSUPPORTED, supportedVersions: versions };
    if (contract.enabled === false) return { ok: false, error: TOOL_ERROR.TOOL_DISABLED, contract };
    return { ok: true, contract };
  }
  validateInput(contract, args) { return validateSchema(contract.inputSchema, args); }
  validateOutput(contract, result) { return validateSchema(contract.outputSchema, result); }
  /** dry-run：只生成 ExecutionPlan，绝不执行。*/
  buildExecutionPlan(contract, args, resourceRefs = []) {
    return Object.freeze({
      toolId: contract.toolId,
      toolVersion: contract.version,
      resourceRefs: Object.freeze([...resourceRefs]),
      riskClass: contract.riskClass,
      sideEffect: contract.sideEffect,
      requiredPermissions: Object.freeze([...(contract.requiredPermissions || [])]),
      resourceActions: Object.freeze([...(contract.resourceActions || [])]),
      approvalRequired: !!contract.requiresApproval,
      expectedSideEffects: Object.freeze([...(contract.expectedSideEffects || [])]),
      executionProvider: contract.executionProvider,
      dryRun: true,
      execute: false,
    });
  }
}

module.exports = { ToolRegistry, validateSchema, BUILTIN_CONTRACTS, CONTRACT_FIELDS, buildToolManifest, buildWriteToolManifest, buildBridgeManifest, ROUTE, toolDefinitionName, projectJsonSchema };
