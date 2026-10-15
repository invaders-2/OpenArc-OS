/**
 * B7x · canvas 画布插件清单校验 + automation 可执行动作投影（全离线：无 Electron、无网络）。
 *
 * 覆盖验收条目：
 *   ① 合法 canvas 清单（节点 + 模板）通过，并进入归一化清单 / 能力投影 / IPC 投影；
 *   ② 非法清单逐条结构化拒绝且错误码稳定：
 *      未知节点类型 / 命名空间越权 / 未知端口类型 / 缺字段 / 危险原型路径 /
 *      v2 能力越权（缺 capabilityVersion）/ 未知执行器 / 声明文件问题 / 模板连线不兼容；
 *   ③ projectDeveloperAppActions 只投影真实可执行动作（tools + canvas agent-tool 的 run 动作），
 *      没有可用动作时 actions 为空（不伪造）。
 *
 * 只读源：shared/canvasPluginValidation.ts、shared/canvasPortCompatibility.ts、
 *         server/developerApps.ts:379-410、server/developerApps.ts:780-819。
 */
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { IdentityStore } = require("../electron/identity-store.cjs");
const { writeZip } = require("../electron/canvas-dxos-zip.cjs");
const domain = require("../electron/developer-domain.cjs");
const canvasModule = require("../electron/developer-canvas-manifest.cjs");
const builtinsModule = require("../electron/developer-canvas-builtins.cjs");
const { createDeveloperBundle } = require("../electron/developer-service.cjs");

const FIXED_NOW = 1_700_000_000_000;
const tmpDirs = [];
const openStores = [];

afterEach(() => { while (openStores.length) { try { openStores.pop().close(); } catch { /* 已关 */ } } });
after(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function makeAuth() {
  return { resolveActor: ({ context }) => (context && context.sessionRef ? { ok: true, user: { id: "u-canvas" } } : { ok: false, error: "no-session" }) };
}

function openBundle() {
  const dir = tempDir("dxos-developer-canvas-");
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  openStores.push(store);
  const bundle = createDeveloperBundle({ userDataDir: dir, identityStore: store, authorization: makeAuth(), clock: () => FIXED_NOW, lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
  return {
    dir,
    db: store.connection,
    call: (command, payload, ctx) => bundle.execute(command, payload || {}, Object.assign({ sessionRef: "sess-canvas", requestId: "req-canvas" }, ctx || {})),
  };
}

function makeManifest(overrides = {}) {
  return Object.assign({
    format: "dx-app/v2",
    id: "demo",
    name: "Demo Canvas App",
    description: "a demo canvas plugin application",
    version: "1.0.0",
    build: 1,
  }, overrides);
}

// ── 清单样例 ─────────────────────────────────────────────────────────────
function imageGenerator(overrides = {}) {
  return Object.assign({
    type: "demo.image-gen",
    version: 1,
    stateVersion: 1,
    capabilityVersion: 2,
    title: "品牌出图",
    defaultSize: { width: 320, height: 240 },
    inputs: [{ id: "prompt", title: "提示词", type: "text" }],
    outputs: [{ id: "images", title: "图片", type: "media.image[]", multiple: true }],
    parameters: { type: "object", properties: { prompt: { type: "string", default: "保持品牌识别一致" } } },
    host: {
      generation: { kind: "image", parameterPanel: "standard", outputPort: "images", fields: ["model", "ratio"] },
      output: { targets: ["inline"], defaultTarget: "inline", defaultPort: "images" },
      cancellable: true,
    },
    agent: {
      aliases: ["品牌出图"],
      actions: [
        { id: "run", title: "生成品牌图片", kind: "run", promptParameter: "params.prompt", acceptsCanvasInputs: true },
        { id: "read", title: "读取生成设置", kind: "read" },
      ],
    },
    semanticRoles: ["generator"],
    executor: { type: "agent-tool", toolName: "canvas.ai.generate" },
  }, overrides);
}

function imageSink(overrides = {}) {
  return Object.assign({
    type: "demo.image-sink",
    version: 1,
    stateVersion: 1,
    capabilityVersion: 2,
    title: "图片收集",
    defaultSize: { width: 240, height: 180 },
    inputs: [{ id: "images", title: "图片", type: "media.image[]", multiple: true }],
    outputs: [],
    executor: { type: "app-bridge", action: "demo.sink" },
  }, overrides);
}

function textSink(overrides = {}) {
  return Object.assign({
    type: "demo.text-sink",
    version: 1,
    stateVersion: 1,
    capabilityVersion: 2,
    title: "文本收集",
    defaultSize: { width: 240, height: 180 },
    inputs: [{ id: "text", title: "文本", type: "text" }],
    outputs: [],
    executor: { type: "app-bridge", action: "demo.text" },
  }, overrides);
}

function nodeManifest(nodes, overrides = {}) {
  return Object.assign({ format: "dx-canvas-nodes/v2", nodes }, overrides);
}

function templateManifest(templates, overrides = {}) {
  return Object.assign({ format: "dx-canvas-templates/v1", templates }, overrides);
}

function buildPackage(canvas, extraEntries = [], manifestOverrides = {}) {
  const entries = [
    { name: "dx-app.json", data: Buffer.from(JSON.stringify(makeManifest(Object.assign({ canvas }, manifestOverrides)))) },
    { name: "index.html", data: Buffer.from("<html><body>canvas demo</body></html>") },
    ...extraEntries,
  ];
  return writeZip(entries);
}

const json = (value) => Buffer.from(JSON.stringify(value));

// ── 单元：端口兼容（源 canvasPortCompatibility.ts 逐字口径） ──────────────
test("canvasPortCompatibility：同型放行 / artifact 收编 / 多值到单值拒绝 / table→json", () => {
  assert.deepEqual(canvasModule.canvasPortCompatibility({ type: "text" }, { type: "text" }), { ok: true, coercion: "none" });
  const artifact = canvasModule.canvasPortCompatibility({ type: "media.image" }, { type: "artifact" });
  assert.equal(artifact.ok, true);
  assert.equal(artifact.coercion, "artifact");
  assert.equal(artifact.reason, undefined);
  assert.equal(canvasModule.canvasPortCompatibility({ type: "event" }, { type: "artifact" }).ok, false);
  assert.equal(canvasModule.canvasPortCompatibility({ type: "media.image[]" }, { type: "file" }).ok, false, "多值不能落到单文件端口");
  assert.deepEqual(canvasModule.canvasPortCompatibility({ type: "media.image[]" }, { type: "file[]" }), { ok: true, coercion: "file" });
  assert.deepEqual(canvasModule.canvasPortCompatibility({ type: "table" }, { type: "json" }), { ok: true, coercion: "none" });
  assert.equal(canvasModule.canvasPortCompatibility({ type: "media.image[]" }, { type: "text" }).ok, false);
  assert.equal(canvasModule.canvasPortCompatibility({ type: "media.image[]" }, { type: "media.image", multiple: true }).ok, true, "目标 multiple 才允许多值拍平");
  assert.equal(canvasModule.canvasPortCompatibility({ type: "media.image[]" }, { type: "media.image" }).ok, false);
});

// ── 单元：内置画布节点（源 builtinCanvasNodes.ts 逐字移植） ────────────────
test("BUILTIN_CANVAS_NODES：内置节点定义与源逐字一致（id / 端口 / 能力）", () => {
  assert.deepEqual(builtinsModule.BUILTIN_CANVAS_NODES.map((node) => node.type), [
    "builtin.director-3d", "builtin.image-asset", "builtin.video-asset", "builtin.audio-asset",
    "builtin.file-asset", "builtin.image-generator", "builtin.midjourney-generator",
    "builtin.video-generator", "builtin.audio-generator", "builtin.llm", "builtin.table",
    "builtin.image-compare", "builtin.group", "builtin.prompt", "builtin.sticky", "builtin.junction",
  ]);
  for (const node of builtinsModule.BUILTIN_CANVAS_NODES) assert.ok(node.type.startsWith("builtin."), node.type);
  const prompt = builtinsModule.BUILTIN_CANVAS_NODES.find((node) => node.type === "builtin.prompt");
  assert.deepEqual(prompt.inputs, [{ id: "text", title: "文本输入", type: "text" }]);
  assert.deepEqual(prompt.outputs, [{ id: "text", title: "文本", type: "text" }]);
  assert.deepEqual(prompt.executor, { type: "builtin", id: "canvas.prompt" });
  assert.equal(prompt.capabilityVersion, 2);
  assert.deepEqual(prompt.semanticRoles, ["source"]);
  const imageGenerator = builtinsModule.BUILTIN_CANVAS_NODES.find((node) => node.type === "builtin.image-generator");
  assert.deepEqual(imageGenerator.inputs.map((port) => port.id), ["prompt", "images", "videos", "audios", "table", "artifacts"]);
  assert.deepEqual(imageGenerator.outputs, [{ id: "images", title: "图片结果", type: "media.image[]", multiple: true }]);
  assert.deepEqual(imageGenerator.executor, { type: "builtin", id: "canvas.generate.image" });
  const junction = builtinsModule.BUILTIN_CANVAS_NODES.find((node) => node.type === "builtin.junction");
  assert.deepEqual(junction.inputs, [{ id: "in", title: "输入", type: "artifact", multiple: true }]);
  assert.deepEqual(junction.outputs, [{ id: "out", title: "输出", type: "artifact", multiple: true }]);
});

test("内置节点端口兼容：合法连线通过 / 类型不匹配 / 未知内置节点 / 未知端口结构化拒绝", () => {
  const expectRejected = (templates, code, message) => assert.throws(
    () => canvasModule.validateCanvasTemplateManifest(templateManifest(templates), "demo", []),
    (error) => error instanceof Error && error.canvasCode === code && (!message || message.test(error.message)),
  );
  const legal = templateManifest([{
    id: "tpl", title: "模板",
    nodes: [{ id: "p", nodeType: "builtin.prompt", x: 0, y: 0 }, { id: "l", nodeType: "builtin.llm", x: 300, y: 0 }],
    connections: [{ from: "p", to: "l", fromPort: "text", toPort: "prompt" }],
  }]);
  // definitions 传空数组（插件无节点清单）：内置节点定义仍参与校验。
  assert.deepEqual(canvasModule.validateCanvasTemplateManifest(legal, "demo", []).templates[0].connections, [{ from: "p", to: "l", fromPort: "text", toPort: "prompt" }]);

  expectRejected([{
    id: "tpl", title: "模板",
    nodes: [{ id: "a", nodeType: "builtin.image-asset", x: 0, y: 0 }, { id: "p", nodeType: "builtin.prompt", x: 300, y: 0 }],
    connections: [{ from: "a", to: "p", fromPort: "image", toPort: "text" }],
  }], "CANVAS_PORT_INCOMPATIBLE", /端口不兼容/);

  expectRejected([{ id: "tpl", title: "模板", nodes: [{ id: "a", nodeType: "builtin.no-such-node", x: 0, y: 0 }] }], "CANVAS_UNKNOWN_NODE_TYPE", /未声明节点类型/);

  expectRejected([{
    id: "tpl", title: "模板",
    nodes: [{ id: "p", nodeType: "builtin.prompt", x: 0, y: 0 }, { id: "l", nodeType: "builtin.llm", x: 300, y: 0 }],
    connections: [{ from: "p", to: "l", fromPort: "nope", toPort: "prompt" }],
  }], "CANVAS_STRUCTURE", /输出端口不存在：builtin\.prompt\.nope/);

  expectRejected([{
    id: "tpl", title: "模板",
    nodes: [{ id: "p", nodeType: "builtin.prompt", x: 0, y: 0 }, { id: "l", nodeType: "builtin.llm", x: 300, y: 0 }],
    connections: [{ from: "p", to: "l", fromPort: "text", toPort: "nope" }],
  }], "CANVAS_STRUCTURE", /输入端口不存在：builtin\.llm\.nope/);
});

// ── ① 合法清单 ───────────────────────────────────────────────────────────
test("合法 canvas 清单：节点 + 模板通过，并进入清单 / 能力 / IPC 投影", async () => {
  const fx = openBundle();
  const nodes = nodeManifest([imageGenerator(), imageSink()]);
  const templates = templateManifest([{
    id: "brand-board",
    title: "品牌看板",
    nodes: [{ id: "gen", nodeType: "demo.image-gen", x: 0, y: 0 }, { id: "sink", nodeType: "demo.image-sink", x: 320, y: 0 }],
    connections: [{ from: "gen", to: "sink", fromPort: "images", toPort: "images" }],
  }]);
  const installed = await fx.call("developer/install", {
    package: buildPackage({ nodeManifests: ["canvas.nodes.json"], templateManifests: ["canvas.templates.json"] }, [
      { name: "canvas.nodes.json", data: json(nodes) },
      { name: "canvas.templates.json", data: json(templates) },
    ]).toString("base64"),
  });
  assert.equal(installed.ok, true, JSON.stringify(installed));

  const got = await fx.call("developer/get", { appId: "dev-demo" });
  assert.equal(got.ok, true, JSON.stringify(got));
  assert.deepEqual(got.value.manifest.canvas, { nodeManifests: ["canvas.nodes.json"], templateManifests: ["canvas.templates.json"] });
  const canvas = got.value.capabilities.canvas;
  assert.ok(canvas, "能力投影必须带 canvas");
  assert.deepEqual(canvas.nodes.map((node) => node.type), ["demo.image-gen", "demo.image-sink"]);
  assert.equal(canvas.nodes[0].executorType, "agent-tool");
  assert.equal(canvas.nodes[0].executorToolName, "canvas.ai.generate");
  assert.equal(canvas.nodes[0].actionCount, 2);
  // IPC 脱敏 depth 封顶为 6：动作列表拍平在 canvas.actions，只含可执行 run 动作。
  assert.deepEqual(canvas.actions, [{ id: "demo.image-gen.run", title: "生成品牌图片", toolName: "canvas.ai.generate", nodeType: "demo.image-gen" }]);
  assert.equal(canvas.nodes[1].executorType, "app-bridge");
  assert.equal(canvas.nodes[1].actionCount, 0);
  assert.deepEqual(canvas.templates, [{ id: "brand-board", title: "品牌看板", nodeCount: 2 }]);
});

test("合法 canvas 清单：直接调用 normalizeCanvasDeclaration（源 developerApps.ts:379-410）", () => {
  const files = [
    { name: "canvas.nodes.json", data: json(nodeManifest([imageGenerator()])) },
    { name: "canvas.templates.json", data: json(templateManifest([{ id: "tpl", title: "模板", nodes: [{ id: "a", nodeType: "demo.image-gen", x: 0, y: 0 }] }])) },
  ];
  const declaration = domain.normalizeCanvasDeclaration({ nodeManifests: ["canvas.nodes.json"], templateManifests: ["canvas.templates.json"] }, files, "demo");
  assert.deepEqual(declaration, { nodeManifests: ["canvas.nodes.json"], templateManifests: ["canvas.templates.json"] });
  // templateManifests 可单独出现：模板只引用 builtin.* 时按移植后的内置定义做存在性 / 端口校验。
  // （反例见下方 "builtin.* 模板不再跳过检查" 用例。）
  const builtinOnly = [{ name: "canvas.templates.json", data: json(templateManifest([{ id: "tpl", title: "模板", nodes: [{ id: "a", nodeType: "builtin.prompt", x: 0, y: 0 }] }])) }];
  assert.deepEqual(domain.normalizeCanvasDeclaration({ templateManifests: ["canvas.templates.json"] }, builtinOnly, "demo"), { nodeManifests: [], templateManifests: ["canvas.templates.json"] });
  assert.equal(domain.normalizeCanvasDeclaration(undefined, files, "demo"), undefined);
});

// ── ② 非法清单：逐条结构化拒绝 ──────────────────────────────────────────
/**
 * 每条用例断言：ok=false / 稳定顶层错误码 / detail.field="canvas" / 稳定 detail.reason / 具体消息。
 * 顶层错误码：声明或清单内容不合法 → DEVELOPER_MANIFEST_INVALID；声明文件问题 → DEVELOPER_PACKAGE_INVALID。
 */
async function assertRejected(fx, packageBuffer, expected) {
  const res = await fx.call("developer/validate", { package: packageBuffer.toString("base64") });
  assert.equal(res.ok, false, expected.name + " 必须被拒绝：" + JSON.stringify(res));
  assert.equal(res.error, expected.error, expected.name + " 错误码：" + JSON.stringify(res));
  assert.equal(res.detail && res.detail.field, "canvas", expected.name + " detail.field：" + JSON.stringify(res));
  assert.equal(res.detail && res.detail.reason, expected.reason, expected.name + " detail.reason：" + JSON.stringify(res));
  if (expected.message) assert.match(String(res.message), expected.message, expected.name + " 消息：" + JSON.stringify(res));
}

test("非法 canvas 清单：结构 / 缺字段 / 文件问题逐条结构化拒绝", async () => {
  const fx = openBundle();
  const nodes = json(nodeManifest([imageGenerator()]));
  const cases = [
    {
      name: "canvas 不是对象",
      pkg: buildPackage([]),
      error: domain.DEVELOPER_ERR_MANIFEST_INVALID,
      reason: "CANVAS_DECLARATION",
      message: /至少需要声明一个节点或模板清单/,
    },
    {
      name: "nodeManifests 不是数组",
      pkg: buildPackage({ nodeManifests: "canvas.nodes.json" }),
      error: domain.DEVELOPER_ERR_MANIFEST_INVALID,
      reason: "CANVAS_DECLARATION",
      message: /必须是字符串数组/,
    },
    {
      name: "声明文件不存在",
      pkg: buildPackage({ nodeManifests: ["missing.nodes.json"] }),
      error: domain.DEVELOPER_ERR_PACKAGE_INVALID,
      reason: "CANVAS_MANIFEST_FILE_MISSING",
      message: /文件不存在/,
    },
    {
      name: "声明文件不是 JSON 扩展名",
      pkg: buildPackage({ nodeManifests: ["canvas.nodes.txt"] }, [{ name: "canvas.nodes.txt", data: nodes }]),
      error: domain.DEVELOPER_ERR_MANIFEST_INVALID,
      reason: "CANVAS_MANIFEST_NOT_JSON_FILE",
      message: /只允许 JSON 文件/,
    },
    {
      name: "声明文件内容不是有效 JSON",
      pkg: buildPackage({ nodeManifests: ["canvas.nodes.json"] }, [{ name: "canvas.nodes.json", data: Buffer.from("{not-json") }]),
      error: domain.DEVELOPER_ERR_PACKAGE_INVALID,
      reason: "CANVAS_MANIFEST_NOT_JSON",
      message: /不是有效 JSON/,
    },
    {
      name: "节点清单缺 format",
      pkg: buildPackage({ nodeManifests: ["canvas.nodes.json"] }, [{ name: "canvas.nodes.json", data: json(nodeManifest([imageGenerator()], { format: "bogus/v1" })) }]),
      error: domain.DEVELOPER_ERR_MANIFEST_INVALID,
      reason: "CANVAS_STRUCTURE",
      message: /format 必须是/,
    },
    {
      name: "节点缺 title",
      pkg: buildPackage({ nodeManifests: ["canvas.nodes.json"] }, [{ name: "canvas.nodes.json", data: json(nodeManifest([Object.assign(imageGenerator(), { title: "" })])) }]),
      error: domain.DEVELOPER_ERR_MANIFEST_INVALID,
      reason: "CANVAS_STRUCTURE",
      message: /title 长度必须为 1–120/,
    },
    {
      name: "参数 default 不属于 enum",
      pkg: buildPackage({ nodeManifests: ["canvas.nodes.json"] }, [{ name: "canvas.nodes.json", data: json(nodeManifest([Object.assign(imageGenerator(), { parameters: { type: "object", properties: { model: { type: "string", enum: ["a", "b"], default: "c" } } } })])) }]),
      error: domain.DEVELOPER_ERR_MANIFEST_INVALID,
      reason: "CANVAS_STRUCTURE",
      message: /default 必须属于 enum/,
    },
  ];
  for (const item of cases) await assertRejected(fx, item.pkg, item);
});

test("非法 canvas 清单：未知节点类型 / 命名空间越权 / 未知端口 / 未知执行器", async () => {
  const fx = openBundle();
  const cases = [
    {
      name: "节点 type 不合命名规则",
      node: Object.assign(imageGenerator(), { type: "BadType" }),
      error: domain.DEVELOPER_ERR_MANIFEST_INVALID,
      reason: "CANVAS_UNKNOWN_NODE_TYPE",
      message: /type 不合法/,
    },
    {
      name: "节点不在 pluginId 命名空间",
      node: Object.assign(imageGenerator(), { type: "other.image-gen" }),
      error: domain.DEVELOPER_ERR_MANIFEST_INVALID,
      reason: "CANVAS_UNKNOWN_NODE_TYPE",
      message: /必须使用 demo\.\* 命名空间/,
    },
    {
      name: "未知端口类型",
      node: Object.assign(imageGenerator(), { inputs: [{ id: "prompt", title: "提示词", type: "image" }] }),
      error: domain.DEVELOPER_ERR_MANIFEST_INVALID,
      reason: "CANVAS_UNKNOWN_PORT_TYPE",
      message: /未知端口类型/,
    },
    {
      name: "未知执行器类型",
      node: Object.assign(imageGenerator(), { executor: { type: "shell", command: "rm -rf /" }, semanticRoles: undefined, host: undefined }),
      error: domain.DEVELOPER_ERR_MANIFEST_INVALID,
      reason: "CANVAS_UNSUPPORTED_EXECUTOR",
      message: /executor\.type 不受支持/,
    },
  ];
  for (const item of cases) {
    const pkg = buildPackage({ nodeManifests: ["canvas.nodes.json"] }, [{ name: "canvas.nodes.json", data: json(nodeManifest([item.node])) }]);
    await assertRejected(fx, pkg, item);
  }
});

test("非法 canvas 清单：危险原型路径 / v2 能力越权 fail closed", async () => {
  const fx = openBundle();
  const operation = {
    id: "read-state",
    title: "读取节点状态",
    kind: "query",
    sideEffect: "none",
    risk: "low",
    idempotency: "idempotent",
    confirmation: "never",
    executorBinding: "canvas.plugin.operation",
    reads: ["params.__proto__.polluted"],
  };
  const dangerous = Object.assign(imageGenerator(), { operations: [operation] });
  await assertRejected(fx, buildPackage({ nodeManifests: ["canvas.nodes.json"] }, [{ name: "canvas.nodes.json", data: json(nodeManifest([dangerous])) }]), {
    name: "operations.reads 含 __proto__",
    error: domain.DEVELOPER_ERR_MANIFEST_INVALID,
    reason: "CANVAS_UNSAFE_PATH",
    message: /包含不合法路径/,
  });

  const migration = Object.assign(imageGenerator(), {
    stateVersion: 2,
    stateMigrations: [{ from: 1, to: 2, operations: [{ type: "rename", from: "params.prompt", to: "constructor.polluted" }] }],
  });
  await assertRejected(fx, buildPackage({ nodeManifests: ["canvas.nodes.json"] }, [{ name: "canvas.nodes.json", data: json(nodeManifest([migration])) }]), {
    name: "stateMigrations 含 constructor",
    error: domain.DEVELOPER_ERR_MANIFEST_INVALID,
    reason: "CANVAS_UNSAFE_PATH",
    message: /rename\.to 不合法/,
  });

  // 越权：v2 能力字段（semanticRoles / operations）必须显式声明 capabilityVersion。
  const noCapability = Object.assign(imageGenerator(), { capabilityVersion: undefined });
  await assertRejected(fx, buildPackage({ nodeManifests: ["canvas.nodes.json"] }, [{ name: "canvas.nodes.json", data: json({ format: "dx-canvas-nodes/v1", nodes: [noCapability] }) }]), {
    name: "v2 能力字段缺 capabilityVersion",
    error: domain.DEVELOPER_ERR_MANIFEST_INVALID,
    reason: "CANVAS_V2_CAPABILITY_REQUIRED",
    message: /必须声明 capabilityVersion: 2/,
  });
});

test("非法 canvas 清单：模板引用越权节点 / 连线端口不兼容", async () => {
  const fx = openBundle();
  const nodes = json(nodeManifest([imageGenerator(), imageSink(), textSink()]));

  await assertRejected(fx, buildPackage(
    { nodeManifests: ["canvas.nodes.json"], templateManifests: ["canvas.templates.json"] },
    [
      { name: "canvas.nodes.json", data: nodes },
      { name: "canvas.templates.json", data: json(templateManifest([{ id: "tpl", title: "模板", nodes: [{ id: "a", nodeType: "other.node", x: 0, y: 0 }] }])) },
    ],
  ), {
    name: "模板引用非本插件节点",
    error: domain.DEVELOPER_ERR_MANIFEST_INVALID,
    reason: "CANVAS_UNKNOWN_NODE_TYPE",
    message: /只能引用 builtin\.\* 或 demo\.\* 节点/,
  });

  await assertRejected(fx, buildPackage(
    { nodeManifests: ["canvas.nodes.json"], templateManifests: ["canvas.templates.json"] },
    [
      { name: "canvas.nodes.json", data: nodes },
      { name: "canvas.templates.json", data: json(templateManifest([{
        id: "tpl",
        title: "模板",
        nodes: [{ id: "gen", nodeType: "demo.image-gen", x: 0, y: 0 }, { id: "text", nodeType: "demo.text-sink", x: 320, y: 0 }],
        connections: [{ from: "gen", to: "text", fromPort: "images", toPort: "text" }],
      }])) },
    ],
  ), {
    name: "模板连线端口不兼容",
    error: domain.DEVELOPER_ERR_MANIFEST_INVALID,
    reason: "CANVAS_PORT_INCOMPATIBLE",
    message: /端口不兼容/,
  });
});

test("builtin.* 模板不再跳过检查：合法内置连线通过，类型不匹配 / 未知内置节点被真实路径抓住", async () => {
  const fx = openBundle();
  // 合法：内置连线（builtin.prompt → builtin.llm，text → prompt）。
  const ok = await fx.call("developer/validate", {
    package: buildPackage({ templateManifests: ["canvas.templates.json"] }, [
      { name: "canvas.templates.json", data: json(templateManifest([{
        id: "tpl", title: "模板",
        nodes: [{ id: "p", nodeType: "builtin.prompt", x: 0, y: 0 }, { id: "l", nodeType: "builtin.llm", x: 300, y: 0 }],
        connections: [{ from: "p", to: "l", fromPort: "text", toPort: "prompt" }],
      }])) },
    ]).toString("base64"),
  });
  assert.equal(ok.ok, true, JSON.stringify(ok));

  // 反例 1：类型不匹配（builtin.image-asset 的 media.image → builtin.prompt 的 text）。
  await assertRejected(fx, buildPackage({ templateManifests: ["canvas.templates.json"] }, [
    { name: "canvas.templates.json", data: json(templateManifest([{
      id: "tpl", title: "模板",
      nodes: [{ id: "a", nodeType: "builtin.image-asset", x: 0, y: 0 }, { id: "p", nodeType: "builtin.prompt", x: 300, y: 0 }],
      connections: [{ from: "a", to: "p", fromPort: "image", toPort: "text" }],
    }])) },
  ]), {
    name: "builtin 内置连线类型不匹配",
    error: domain.DEVELOPER_ERR_MANIFEST_INVALID,
    reason: "CANVAS_PORT_INCOMPATIBLE",
    message: /端口不兼容/,
  });

  // 反例 2：未知内置节点（旧实现按"无法验证"跳过，现在必须拒绝）。
  await assertRejected(fx, buildPackage({ templateManifests: ["canvas.templates.json"] }, [
    { name: "canvas.templates.json", data: json(templateManifest([{ id: "tpl", title: "模板", nodes: [{ id: "a", nodeType: "builtin.no-such-node", x: 0, y: 0 }] }])) },
  ]), {
    name: "未知内置节点",
    error: domain.DEVELOPER_ERR_MANIFEST_INVALID,
    reason: "CANVAS_UNKNOWN_NODE_TYPE",
    message: /未声明节点类型/,
  });

  // 反例 3：已知内置节点上的未知输入端口。
  await assertRejected(fx, buildPackage({ templateManifests: ["canvas.templates.json"] }, [
    { name: "canvas.templates.json", data: json(templateManifest([{
      id: "tpl", title: "模板",
      nodes: [{ id: "p", nodeType: "builtin.prompt", x: 0, y: 0 }, { id: "l", nodeType: "builtin.llm", x: 300, y: 0 }],
      connections: [{ from: "p", to: "l", fromPort: "text", toPort: "nope" }],
    }])) },
  ]), {
    name: "内置节点未知输入端口",
    error: domain.DEVELOPER_ERR_MANIFEST_INVALID,
    reason: "CANVAS_STRUCTURE",
    message: /输入端口不存在：builtin\.llm\.nope/,
  });
});

test("非法 canvas 清单：声明路径越界保持 DEVELOPER_PATH_ESCAPE（与入口路径同一口径）", async () => {
  const fx = openBundle();
  const res = await fx.call("developer/validate", { package: buildPackage({ nodeManifests: ["../evil.json"] }).toString("base64") });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, domain.DEVELOPER_ERR_PATH_ESCAPE);
});

test("canvas 已从整字段拒绝名单移除；其它 OUT 字段仍整字段拒绝", () => {
  assert.equal(domain.REJECTED_MANIFEST_FIELDS.includes("canvas"), false);
  assert.equal(domain.REJECTED_MANIFEST_FIELDS.includes("automation"), true);
  assert.equal(domain.REJECTED_MANIFEST_FIELDS.includes("oauth"), true);
});

// ── ③ app_action 可执行动作投影 ─────────────────────────────────────────
test("projectDeveloperAppActions：只投影 tools 与 canvas agent-tool 的 run 动作", () => {
  const pack = domain.projectDeveloperAppActions({
    appId: "dev-demo",
    manifest: { id: "demo", name: "Demo", version: "1.0.0" },
    capabilities: {
      tools: [{ name: "demo_tool", title: "演示工具", handlerType: "app-api" }],
      canvas: {
        nodes: [
          { type: "demo.image-gen", title: "出图", executorType: "agent-tool", executorToolName: "canvas.ai.generate", actions: [{ id: "run", title: "生成", kind: "run" }, { id: "read", title: "读取", kind: "read" }] },
          { type: "demo.image-sink", title: "收集", executorType: "app-bridge", executorToolName: null, actions: [{ id: "run", title: "收集", kind: "run" }] },
          { type: "demo.skill-gen", title: "技能", executorType: "skill", executorToolName: null, actions: [{ id: "run", title: "技能", kind: "run" }] },
        ],
      },
    },
  });
  assert.deepEqual(pack.manifest.automation.actions, [
    { id: "demo_tool", title: "演示工具", toolName: "demo_tool", source: "tool", handlerType: "app-api" },
    { id: "demo.image-gen.run", title: "生成", toolName: "canvas.ai.generate", source: "canvas", nodeType: "demo.image-gen", actionKind: "run" },
  ]);
});

test("projectDeveloperAppActions：没有可用动作时 actions 为空（不伪造）", () => {
  const pack = domain.projectDeveloperAppActions({
    appId: "dev-empty",
    manifest: { id: "empty", name: "Empty", version: "1.0.0" },
    capabilities: { tools: [], canvas: { nodes: [{ type: "empty.panel", title: "面板", executorType: "builtin", executorToolName: null, actions: [{ id: "run", title: "运行", kind: "run" }] }] } },
  });
  assert.deepEqual(pack.manifest.automation.actions, []);
  assert.equal(pack.id, "dev-empty");
  assert.equal(pack.manifest.id, "empty");
});

test("normalizeDeveloperAppAction：未知动作返回 null（调用方结构化拒绝）", () => {
  const pack = domain.projectDeveloperAppActions({ appId: "dev-demo", manifest: { id: "demo", name: "Demo", version: "1.0.0" }, capabilities: { tools: [{ name: "demo_tool", title: "工具" }] } });
  assert.deepEqual(domain.normalizeDeveloperAppAction({ appId: "dev-demo", actionId: "demo_tool", values: { a: 1 } }, [pack]), { appId: "dev-demo", actionId: "demo_tool", values: { a: 1 } });
  assert.equal(domain.normalizeDeveloperAppAction({ appId: "dev-demo", actionId: "nope" }, [pack]), null);
  assert.equal(domain.normalizeDeveloperAppAction({ appId: "missing", actionId: "demo_tool" }, [pack]), null);
  assert.equal(domain.normalizeDeveloperAppAction({}, [pack]), null);
});
