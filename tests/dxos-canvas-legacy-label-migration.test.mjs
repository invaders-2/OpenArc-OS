/**
 * 画布模型标签 · 旧格式（displayName · configId 末 4 位）→ 新格式的**保真迁移**。
 *
 * 被测：
 *   · electron/canvas-model-label-migration.cjs（纯函数，宿主加载路径调用）；
 *   · electron/canvas-service.cjs 的 getCanvas（宿主加载路径的接线）。
 *
 * 这里跑的是产品真实代码；模型清单用宿主实际消费的形状
 * （ModelService.listModelsForUse 的 { configId, remoteModelId, displayName, providerId, providerName }）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createResourceFixture } from "./resource-fixtures.mjs";
import { CanvasStore } from "../electron/canvas-store.cjs";
import { CanvasService } from "../electron/canvas-service.cjs";
import { buildCanvasModelLabelIndex, CANVAS_MODEL_LABEL_SEPARATOR } from "../src/canvas/canvasModelLabels.ts";

const require = createRequire(import.meta.url);
const migration = require("../electron/canvas-model-label-migration.cjs");
const { migrateCanvasModelLabels, buildCanvasModelLabels, parseLegacyLabel } = migration;

/** 旧实现的标签拼法，逐字复刻，作为迁移的输入生成器（不是被测代码）。 */
const legacyLabel = (m) => String(m.displayName || m.remoteModelId || m.configId) + CANVAS_MODEL_LABEL_SEPARATOR + String(m.configId).slice(-4);

const model = (over) => Object.assign(
  { configId: "cfg-default", remoteModelId: "", displayName: "", providerId: "p", providerName: "Provider" },
  over,
);

/** 去掉模型字段后比较：证明"只改模型字段"。 */
function stripModels(doc) {
  const clone = JSON.parse(JSON.stringify(doc));
  for (const n of clone.nodes || []) { delete n.model; delete n.llmMsModel; }
  for (const l of clone.logs || []) delete l.model;
  return clone;
}

// ---------------------------------------------------------------- 纯函数

test("旧标签保真迁移：末 4 位 + 显示名唯一命中 → 重写为**同一 configId** 的新标签", () => {
  const models = [
    model({ configId: "cfg-ds-aaaa", remoteModelId: "deepseek-chat", displayName: "DeepSeek Chat", providerId: "p1", providerName: "DeepSeek" }),
    model({ configId: "cfg-ds-bbbb", remoteModelId: "deepseek-reasoner", displayName: "DeepSeek Reasoner", providerId: "p1", providerName: "DeepSeek" }),
  ];
  const target = models[1];
  const oldValue = legacyLabel(target); // "DeepSeek Reasoner · bbbb"
  assert.equal(oldValue, "DeepSeek Reasoner" + CANVAS_MODEL_LABEL_SEPARATOR + "bbbb");

  const doc = { nodes: [{ id: "n1", type: "llm", x: 1, y: 2, text: "t", model: oldValue }], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] };
  const { doc: out, report } = migrateCanvasModelLabels(doc, models);

  const index = buildCanvasModelLabels(models);
  assert.equal(out.nodes[0].model, index.labelOf.get("cfg-ds-bbbb"));
  assert.equal(out.nodes[0].model, "deepseek-reasoner");
  assert.equal(index.configOf.get(out.nodes[0].model), "cfg-ds-bbbb", "迁移后必须仍指向原 configId");
  assert.notEqual(index.configOf.get(out.nodes[0].model), "cfg-ds-aaaa", "绝不能落到服务商第一个模型");
  assert.equal(report.changed, true);
  assert.deepEqual(report.migrated, [{ scope: "node", ownerId: "n1", field: "model", from: oldValue, to: "deepseek-reasoner", configId: "cfg-ds-bbbb" }]);
  assert.deepEqual(report.ambiguous, []);
  assert.deepEqual(report.unresolved, []);
});

test("歧义（两条同末 4 位 + 同显示名）→ 原值不动 + 结构化上报，不猜", () => {
  const models = [
    model({ configId: "cfg-x-bbbb", remoteModelId: "same-id", displayName: "Same Display", providerId: "p1", providerName: "P1" }),
    model({ configId: "cfg-y-bbbb", remoteModelId: "same-id", displayName: "Same Display", providerId: "p2", providerName: "P2" }),
  ];
  const oldValue = "Same Display" + CANVAS_MODEL_LABEL_SEPARATOR + "bbbb";
  const doc = { nodes: [{ id: "n1", type: "llm", x: 0, y: 0, model: oldValue }, { id: "n2", type: "llm", x: 1, y: 1, model: legacyLabel(models[1]) }], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] };
  const { doc: out, report } = migrateCanvasModelLabels(doc, models);

  assert.equal(out, doc, "歧义时不得产出新文档");
  assert.equal(out.nodes[0].model, oldValue);
  assert.equal(out.nodes[1].model, legacyLabel(models[1]));
  assert.equal(report.changed, false);
  assert.equal(report.migrated.length, 0);
  assert.equal(report.ambiguous.length, 2);
  assert.deepEqual(report.ambiguous[0], {
    scope: "node", ownerId: "n1", field: "model", value: oldValue,
    name: "Same Display", suffix: "bbbb",
    candidates: ["cfg-x-bbbb", "cfg-y-bbbb"],
  });
});

test("已是新标签 → 不动；重复迁移结果一致（幂等）", () => {
  const models = [
    model({ configId: "cfg-ds-aaaa", remoteModelId: "deepseek-chat", displayName: "DeepSeek Chat", providerName: "DeepSeek" }),
    model({ configId: "cfg-ds-bbbb", remoteModelId: "deepseek-reasoner", displayName: "DeepSeek Reasoner", providerName: "DeepSeek" }),
  ];
  const index = buildCanvasModelLabels(models);
  const doc = {
    nodes: [
      { id: "n1", type: "llm", x: 0, y: 0, model: "deepseek-chat" },
      { id: "n2", type: "llm", x: 1, y: 1, model: legacyLabel(models[1]) },
    ],
    connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [],
  };
  const once = migrateCanvasModelLabels(doc, models);
  assert.equal(once.report.migrated.length, 1);
  assert.equal(once.doc.nodes[0].model, "deepseek-chat");
  assert.equal(once.doc.nodes[1].model, index.labelOf.get("cfg-ds-bbbb"));

  const twice = migrateCanvasModelLabels(once.doc, models);
  assert.equal(twice.doc, once.doc, "第二次不得再产出新文档");
  assert.equal(twice.report.migrated.length, 0);
  assert.equal(twice.report.ambiguous.length, 0);
  assert.equal(twice.report.unresolved.length, 0);
  assert.equal(twice.report.alreadyCurrent, 2);

  const third = migrateCanvasModelLabels(twice.doc, models);
  assert.deepEqual(JSON.parse(JSON.stringify(third.doc)), JSON.parse(JSON.stringify(once.doc)));
});

test("只改模型字段：几何 / 连线 / viewport / 其它节点数据零改动", () => {
  const models = [model({ configId: "cfg-zzzz1111", remoteModelId: "m-1", displayName: "显示名", providerName: "P" })];
  const oldValue = legacyLabel(models[0]); // "显示名 · 1111"
  const doc = {
    nodes: [
      { id: "n1", type: "generator", x: 12.5, y: -3, text: "原始文本", model: oldValue, params: { seed: 7, nested: { a: [1, 2] } }, url: "openarc-asset:r1" },
      { id: "n2", type: "prompt", x: 99, y: 100, model: "别的服务商 · 9999" },
    ],
    connections: [{ id: "c1", from: "n1", to: "n2", meta: { k: 1 } }],
    viewport: { x: 5, y: 6, scale: 0.75 },
    logs: [{ id: "log1", createdAt: 123, status: "success", model: oldValue, prompt: "p", outputs: [{ url: "u" }] }],
    groupList: [{ id: "g1", title: "组", nodeIds: ["n1", "n2"] }],
  };
  const before = JSON.parse(JSON.stringify(doc));
  const { doc: out, report } = migrateCanvasModelLabels(doc, models);

  assert.notEqual(out, doc);
  assert.deepEqual(stripModels(out), stripModels(before), "非模型字段必须逐字不变");
  assert.equal(out.nodes[0].model, "m-1");
  assert.equal(out.logs[0].model, "m-1");
  assert.equal(out.connections, doc.connections, "连线必须是同一引用（不被重建）");
  assert.equal(out.viewport, doc.viewport, "viewport 必须是同一引用");
  assert.equal(out.groupList, doc.groupList);
  assert.equal(out.nodes[1], doc.nodes[1], "没命中的节点保持原引用");
  // n2 的 "别的服务商 · 9999"：后缀 9999 对不上任何 configId → 保持原值并上报
  assert.equal(out.nodes[1].model, "别的服务商 · 9999");
  assert.deepEqual(report.migrated.map((r) => [r.scope, r.ownerId, r.from, r.to]), [
    ["node", "n1", oldValue, "m-1"],
    ["log", "log1", oldValue, "m-1"],
  ]);
  assert.deepEqual(report.unresolved, [{ scope: "node", ownerId: "n2", field: "model", value: "别的服务商 · 9999", reason: "NOT_FOUND" }]);
});

test("严防误迁移：新标签里的短供应商后缀 / 无分隔符的值都不动", () => {
  // "m · X" 是**新**命名里 base 撞车后的 provider 后缀，不是旧 configId 尾号；
  // 即使存在 configId 恰好以 "X" 结尾的配置也不能命中（旧后缀长度必须 = min(4, configId.length)）。
  const models = [model({ configId: "cfg-zzzX", remoteModelId: "m", displayName: "m", providerId: "p1", providerName: "P1" })];
  const doc = { nodes: [{ id: "n1", type: "llm", x: 0, y: 0, model: "m · X" }, { id: "n2", type: "llm", x: 0, y: 0, model: "no-separator" }], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] };
  const { doc: out, report } = migrateCanvasModelLabels(doc, models);
  assert.equal(out, doc);
  assert.equal(report.migrated.length, 0);
  assert.deepEqual(report.unresolved, [
    { scope: "node", ownerId: "n1", field: "model", value: "m · X", reason: "NOT_FOUND" },
    { scope: "node", ownerId: "n2", field: "model", value: "no-separator", reason: "NOT_LEGACY" },
  ]);
});

test("旧标签的显示名回退链：displayName → remoteModelId → configId 都能反查", () => {
  const byDisplay = model({ configId: "cfg-aaaa1100", remoteModelId: "rid-a", displayName: "显示 A", providerName: "P" });
  const byRemote = model({ configId: "cfg-bbbb2200", remoteModelId: "remote-b", displayName: "", providerName: "P" });
  const byConfig = model({ configId: "cfg-cccc3300", remoteModelId: "", displayName: "", providerName: "P" });
  const models = [byDisplay, byRemote, byConfig];
  const doc = { nodes: [
    { id: "n1", type: "llm", x: 0, y: 0, model: legacyLabel(byDisplay) },
    { id: "n2", type: "llm", x: 0, y: 0, model: legacyLabel(byRemote) },
    { id: "n3", type: "llm", x: 0, y: 0, model: legacyLabel(byConfig) },
  ], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] };
  const { doc: out, report } = migrateCanvasModelLabels(doc, models);
  const index = buildCanvasModelLabels(models);
  assert.equal(out.nodes[0].model, index.labelOf.get("cfg-aaaa1100"));
  assert.equal(out.nodes[1].model, index.labelOf.get("cfg-bbbb2200"));
  assert.equal(out.nodes[2].model, index.labelOf.get("cfg-cccc3300"));
  assert.equal(report.migrated.length, 3);
});

test("configId 短于 4 位：旧后缀是全长（min(4, len)），仍能保真迁移", () => {
  const m = model({ configId: "xy1", remoteModelId: "short-model", displayName: "短", providerName: "P" });
  const oldValue = "短" + CANVAS_MODEL_LABEL_SEPARATOR + "xy1";
  const doc = { nodes: [{ id: "n1", type: "llm", x: 0, y: 0, model: oldValue }], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] };
  const { doc: out, report } = migrateCanvasModelLabels(doc, [m]);
  assert.equal(out.nodes[0].model, "short-model");
  assert.equal(report.migrated[0].configId, "xy1");
});

test("清单缺失 / 形状非法：不做任何改动（宁可不迁移，也不猜）", () => {
  const doc = { nodes: [{ id: "n1", type: "llm", x: 0, y: 0, model: "显示 · aaaa" }], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] };
  assert.equal(migrateCanvasModelLabels(doc, []).doc, doc);
  assert.equal(migrateCanvasModelLabels(doc, null).doc, doc);
  assert.equal(migrateCanvasModelLabels(doc, undefined).doc, doc);
  assert.equal(migrateCanvasModelLabels(null, [model({})]).doc, null);
});

test("parseLegacyLabel：从最后一个分隔符切，名字里含分隔符也对", () => {
  assert.deepEqual(parseLegacyLabel("A · B · abcd"), { name: "A · B", suffix: "abcd" });
  assert.deepEqual(parseLegacyLabel("名字 · ab"), { name: "名字", suffix: "ab" });
  assert.equal(parseLegacyLabel("no-separator"), null);
  assert.equal(parseLegacyLabel(" · abcd"), null, "名字为空不算旧标签");
  assert.equal(parseLegacyLabel("名字 · abcde"), null, "后缀超过 4 位不算旧标签");
});

test("命名规则与 TS 唯一真源逐条一致（CJS 端口不漂移）", () => {
  const battery = [
    [model({ configId: "cfg-1111", remoteModelId: "deepseek-chat", displayName: "DeepSeek Chat", providerName: "DeepSeek" })],
    [
      model({ configId: "cfg-aaaa", remoteModelId: "deepseek-chat", displayName: "DeepSeek Chat", providerId: "prov-deepseek", providerName: "DeepSeek" }),
      model({ configId: "cfg-bbbb", remoteModelId: "deepseek-chat", displayName: "DS on SiliconFlow", providerId: "prov-sf", providerName: "硅基流动" }),
      model({ configId: "cfg-cccc", remoteModelId: "gemini-3.1-flash-image", displayName: "Gemini Image", providerId: "prov-g", providerName: "Google" }),
    ],
    [
      model({ configId: "c1", remoteModelId: "m", providerName: "A" }),
      model({ configId: "c2", remoteModelId: "m", providerName: "B" }),
      model({ configId: "c3", remoteModelId: "m", providerName: "A" }),
      model({ configId: "c4", remoteModelId: "m", providerName: "A" }),
      model({ configId: "c5", remoteModelId: "m2", providerName: "A" }),
      model({ configId: "c6", remoteModelId: "", displayName: "m", providerName: "A" }),
      model({ configId: "c7", remoteModelId: "", displayName: "", providerName: "A" }),
    ],
    [
      model({ configId: "xx-abcd1234", remoteModelId: "same-id", providerId: "p", providerName: "P" }),
      model({ configId: "yy-zzabcd1234", remoteModelId: "same-id", providerId: "p", providerName: "P" }),
    ],
    [model({ configId: "ab", remoteModelId: "", displayName: "带 · 分隔符", providerName: "P · Q" })],
  ];
  for (const models of battery) {
    const ts = buildCanvasModelLabelIndex(models);
    const cjs = buildCanvasModelLabels(models);
    assert.deepEqual([...cjs.labelOf.entries()].sort(), [...ts.labelOf.entries()].sort());
    assert.deepEqual([...cjs.configOf.entries()].sort(), [...ts.configOf.entries()].sort());
  }
});

// ---------------------------------------------------------------- 宿主加载路径

/** 真实 CanvasService + CanvasStore；模型清单按宿主实际消费形状注入。 */
async function hostFixture(models, { withLogger = true } = {}) {
  const fx = await createResourceFixture();
  const store = new CanvasStore({ identity: fx.identity, clock: fx.clock });
  const logs = [];
  const service = new CanvasService({
    identity: fx.identity, store, resourceStore: fx.resourceStore, authService: fx.authService,
    clock: fx.clock, logger: withLogger ? { log: (entry) => logs.push(entry) } : null,
  });
  service.attachRuntime({ modelService: { listModelsForUse: () => ({ ok: true, models }) } });
  const context = { sessionRef: fx.sessions.admin, appId: "canvas", source: "ui" };
  return { fx, store, service, context, logs };
}

test("宿主加载路径：旧标签画布文档 → 节点底层 configId 不变（真机/宿主级前后对照）", async () => {
  const models = [
    model({ configId: "cfg-ds-aaaa", remoteModelId: "deepseek-chat", displayName: "DeepSeek Chat", providerId: "prov-ds", providerName: "DeepSeek" }),
    model({ configId: "cfg-ds-bbbb", remoteModelId: "deepseek-reasoner", displayName: "DeepSeek Reasoner", providerId: "prov-ds", providerName: "DeepSeek" }),
  ];
  const f = await hostFixture(models);
  try {
    const oldValue = legacyLabel(models[1]); // "DeepSeek Reasoner · bbbb"
    const doc = {
      nodes: [
        { id: "n_llm", type: "llm", x: 10, y: 20, text: "用户的提示词", model: oldValue, params: { temperature: 0.3 } },
        { id: "n_img", type: "image", x: 200, y: 20, url: "openarc-asset:r1" },
      ],
      connections: [{ id: "c1", from: "n_llm", to: "n_img" }],
      viewport: { x: 3, y: 4, scale: 1 },
      logs: [{ id: "log1", createdAt: 1, status: "success", model: oldValue }],
    };
    const created = f.service.createCanvas({ context: f.context, title: "旧标签画布", doc });
    assert.equal(created.ok, true, JSON.stringify(created));
    const canvasId = created.canvas.canvasId;
    // 前置：库里存的确实是旧标签
    assert.equal(JSON.parse(f.store.boardById(canvasId).doc).nodes[0].model, oldValue);

    const got = f.service.getCanvas({ context: f.context, canvasId });
    assert.equal(got.ok, true, JSON.stringify(got));
    const index = buildCanvasModelLabelIndex(models);
    const node = got.canvas.doc.nodes.find((n) => n.id === "n_llm");

    // 前后对照
    assert.equal(node.model, "deepseek-reasoner", "加载后应为同一 configId 的新标签");
    assert.equal(index.configOf.get(node.model), "cfg-ds-bbbb", "节点底层 configId 未变");
    assert.notEqual(index.configOf.get(node.model), models[0].configId, "绝不是服务商第一个模型");
    assert.ok(index.configOf.has(node.model), "迁移后必须在新清单内（守卫不会再 prune）");
    assert.equal(got.canvas.doc.logs[0].model, "deepseek-reasoner", "运行记录同步迁移");
    // 其它字段零改动
    assert.equal(node.x, 10);
    assert.equal(node.y, 20);
    assert.equal(node.text, "用户的提示词");
    assert.deepEqual(node.params, { temperature: 0.3 });
    assert.equal(got.canvas.doc.nodes[1].url, "openarc-asset:r1");
    assert.deepEqual(got.canvas.doc.connections, doc.connections);
    // revision 不因加载而变
    assert.equal(got.canvas.revision, created.canvas.revision);
    // 审计
    const audit = f.logs.filter((x) => x.event === "canvas-model-label-migration");
    assert.equal(audit.length, 1, JSON.stringify(f.logs));
    assert.equal(audit[0].result, "MIGRATED");
    assert.equal(audit[0].canvasId, canvasId);
    assert.deepEqual(audit[0].migrated.map((r) => [r.from, r.to, r.configId]), [
      [oldValue, "deepseek-reasoner", "cfg-ds-bbbb"],
      [oldValue, "deepseek-reasoner", "cfg-ds-bbbb"],
    ]);
  } finally { f.fx.close(); }
});

test("宿主加载路径：歧义旧标签不迁移（节点底层选择不变），审计报 ambiguous", async () => {
  const models = [
    model({ configId: "cfg-x-bbbb", remoteModelId: "same-id", displayName: "Same Display", providerId: "p1", providerName: "P1" }),
    model({ configId: "cfg-y-bbbb", remoteModelId: "same-id", displayName: "Same Display", providerId: "p2", providerName: "P2" }),
  ];
  const f = await hostFixture(models);
  try {
    const ambiguous = "Same Display" + CANVAS_MODEL_LABEL_SEPARATOR + "bbbb";
    const doc = { nodes: [{ id: "n1", type: "llm", x: 0, y: 0, model: ambiguous }], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] };
    const created = f.service.createCanvas({ context: f.context, title: "歧义画布", doc });
    const got = f.service.getCanvas({ context: f.context, canvasId: created.canvas.canvasId });
    assert.equal(got.canvas.doc.nodes[0].model, ambiguous, "歧义必须保持原值不动");
    const audit = f.logs.filter((x) => x.event === "canvas-model-label-migration");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].result, "SKIPPED");
    assert.deepEqual(audit[0].migrated, []);
    assert.equal(audit[0].ambiguous.length, 1);
    assert.deepEqual(audit[0].ambiguous[0].candidates, ["cfg-x-bbbb", "cfg-y-bbbb"]);
  } finally { f.fx.close(); }
});

test("宿主加载路径：已是新标签 → 不改、不产生审计噪音；重复加载幂等", async () => {
  const models = [model({ configId: "cfg-ds-bbbb", remoteModelId: "deepseek-reasoner", displayName: "DeepSeek Reasoner", providerName: "DeepSeek" })];
  const f = await hostFixture(models);
  try {
    const doc = { nodes: [{ id: "n1", type: "llm", x: 0, y: 0, model: "deepseek-reasoner" }], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] };
    const created = f.service.createCanvas({ context: f.context, title: "新标签画布", doc });
    const a = f.service.getCanvas({ context: f.context, canvasId: created.canvas.canvasId });
    const b = f.service.getCanvas({ context: f.context, canvasId: created.canvas.canvasId });
    assert.equal(a.canvas.doc.nodes[0].model, "deepseek-reasoner");
    assert.deepEqual(JSON.parse(JSON.stringify(a.canvas.doc)), JSON.parse(JSON.stringify(b.canvas.doc)));
    assert.equal(f.logs.length, 0, "无迁移 / 无异常时不产审计记录");
  } finally { f.fx.close(); }
});

test("宿主加载路径：模型层未装配时 getCanvas 原样返回（不迁移、不猜）", async () => {
  const f = await hostFixture([], { withLogger: false });
  try {
    const legacy = "显示 · aaaa";
    const doc = { nodes: [{ id: "n1", type: "llm", x: 0, y: 0, model: legacy }], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] };
    const created = f.service.createCanvas({ context: f.context, title: "无模型层", doc });
    f.service.modelService = null;
    const got = f.service.getCanvas({ context: f.context, canvasId: created.canvas.canvasId });
    assert.equal(got.ok, true);
    assert.equal(got.canvas.doc.nodes[0].model, legacy);
  } finally { f.fx.close(); }
});

test("宿主加载路径：旧标签经宿主迁移后仍可被宿主的 labelToConfig 反查到原 configId", async () => {
  const models = [
    model({ configId: "cfg-ds-aaaa", remoteModelId: "deepseek-chat", displayName: "DeepSeek Chat", providerId: "prov-ds", providerName: "DeepSeek" }),
    model({ configId: "cfg-img-7777", remoteModelId: "seedream-5.0", displayName: "Seedream 5.0", providerId: "prov-vol", providerName: "火山引擎" }),
  ];
  const f = await hostFixture(models);
  try {
    const doc = { nodes: [{ id: "n_img", type: "generator", x: 0, y: 0, model: legacyLabel(models[1]) }], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] };
    const created = f.service.createCanvas({ context: f.context, title: "反查", doc });
    const got = f.service.getCanvas({ context: f.context, canvasId: created.canvas.canvasId });
    // 与 src/canvas/CanvasHost.tsx 的 labelToConfig 同一份索引
    const labelToConfig = buildCanvasModelLabelIndex(models).configOf;
    const wanted = got.canvas.doc.nodes[0].model;
    assert.equal(labelToConfig.get(wanted), "cfg-img-7777");
  } finally { f.fx.close(); }
});
