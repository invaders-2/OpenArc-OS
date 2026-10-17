/**
 * B3b+ · 模型路由移植回归（DX server/modelResolver.ts → electron/model-resolver.cjs）。
 *
 * 覆盖 task-3 验收：
 *   · 有可用模型时 capabilityRouter 路由成功，不再抛 AGENT_DEPENDENCY_UNAVAILABLE；
 *   · capabilityTargetResolver 用真实 modelResolver + modelDescriptor 能发现目标；
 *   · 无模型时结构化失败（MODEL_ROUTE_NO_CANDIDATE，不是依赖缺失）；
 *   · 回退策略：best_available 返回带 missing/warnings 的回退路由；strict 缺能力结构化失败；
 *   · 候选评分：preferredModels 权重能让首选模型排到路由链第一位。
 *
 * 全部离线：node:sqlite 内存库 + 真实 legacy 协议表（protocol-engine/legacy-protocols.cjs）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const foundationSchema = require("../electron/dxos-foundation-schema.cjs");
const agentSchema = require("../electron/dxos-agent-schema.cjs");
const kernel = require("../electron/agent-kernel.cjs");
const capabilityRouter = require("../electron/capability-router.cjs");
const targetResolver = require("../electron/capability-target-resolver.cjs");
const modelResolver = require("../electron/model-resolver.cjs");
const { IdentityStore } = require("../electron/identity-store.cjs");
const { createAgentBundle } = require("../electron/agent-service.cjs");

const tempDirs = [];
after(() => { for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true }); });

function newDb() {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const statement of foundationSchema.dxosDdl()) db.exec(statement);
  for (const statement of agentSchema.dxosAgentDdl()) db.exec(statement);
  return db;
}

function configureKernel(db, over = {}) {
  kernel.resetAgentKernelForTests();
  return kernel.configureAgentKernel(Object.assign({ db, clock: () => Date.now() }, over));
}

function realModelDeps(providers) {
  return modelResolver.createModelResolverBundle({ providers: () => providers });
}

function makeProvider(over = {}) {
  return Object.assign({
    id: "p1",
    name: "供应商一",
    base_url: "https://api.example.com",
    api_key: "sk-test-key-000000",
    protocol: "openai",
    enabled: true,
    sort: 1,
    models: [{ model: "gpt-4o", caps: ["llm"] }, { model: "gpt-image-1", caps: ["image"] }],
  }, over);
}

const toolResolver = {
  resolveReactTools: () => ({ descriptors: [], openaiTools: [] }),
  resolveTools: () => ({ descriptors: [], openaiTools: [] }),
};

function caught(fn) {
  try { fn(); } catch (error) { return error; }
  throw new Error("expected function to throw");
}

test("capabilityRouter：注入真实 modelResolver 后路由成功，不再抛 AGENT_DEPENDENCY_UNAVAILABLE", () => {
  const db = newDb();
  const providers = [makeProvider()];
  configureKernel(db, Object.assign(realModelDeps(providers), { toolResolver }));

  const route = capabilityRouter.resolveAgentRoute({});
  assert.equal(route.model.model, "gpt-4o");
  assert.equal(route.model.providerId, "p1");
  assert.equal(route.model.operationId, "llm.tools");
  assert.deepEqual(route.requiresAll, ["llm.tools"]);
  assert.ok(route.modelRoutes.length >= 1, "必须返回有序路由链");
  assert.ok(route.reasons.some((reason) => reason.includes("暴露 0 个 Agent 工具")), route.reasons.join("｜"));

  // 视觉意图要求 llm.chat.vision + llm.tools：gpt-4o legacy profile 同时具备，路由仍成功。
  const vision = capabilityRouter.resolveAgentRoute({ hasImageInput: true });
  assert.deepEqual(vision.requiresAll, ["llm.chat.vision", "llm.tools"]);
  assert.equal(vision.model.model, "gpt-4o");
});

test("capabilityTargetResolver：真实 modelResolver + modelDescriptor 能发现目标，不再抛依赖缺失", async () => {
  const db = newDb();
  const providers = [makeProvider()];
  configureKernel(db, realModelDeps(providers));

  const discovered = targetResolver.discoverCapabilityTargets(["media.image.generate"], providers, {}, {});
  assert.equal(discovered["media.image.generate"].length, 1);
  const target = discovered["media.image.generate"][0];
  assert.equal(target.providerId, "p1");
  assert.equal(target.model, "gpt-image-1");
  assert.equal(target.operationId, "image.generate");
  assert.equal(target.mode, "declarative");
  assert.ok(target.parameters && target.parameters.schemaId, "参数 schema 必须来自真实协议 profile");

  const byUser = await targetResolver.discoverCapabilityTargetsForUser("u1", ["media.image.generate"], {}, {});
  assert.equal(byUser["media.image.generate"][0].model, "gpt-image-1");
});

test("无模型：结构化 MODEL_ROUTE_NO_CANDIDATE（业务失败，不是 AGENT_DEPENDENCY_UNAVAILABLE）", () => {
  const request = { taskIntent: "agent.project.write", requiresAll: ["llm.tools"], requiresAny: [] };
  const direct = caught(() => modelResolver.resolveModelRoutesFromProviders([], request));
  assert.equal(direct.code, modelResolver.MODEL_ROUTE_NO_CANDIDATE);
  assert.notEqual(direct.code, "AGENT_DEPENDENCY_UNAVAILABLE");
  assert.match(direct.message, /没有可用的模型站点/);

  // 关闭的站点 / 缺少密钥的站点同样不产生候选（providerUsable 口径）。
  for (const provider of [
    makeProvider({ enabled: false }),
    makeProvider({ api_key: "" }),
    makeProvider({ base_url: "" }),
  ]) {
    const error = caught(() => modelResolver.resolveModelRoutesFromProviders([provider], request));
    assert.equal(error.code, modelResolver.MODEL_ROUTE_NO_CANDIDATE);
  }

  // 经 capabilityRouter：内核已注入 modelResolver 时得到业务失败码，而不是依赖缺失。
  const db = newDb();
  configureKernel(db, Object.assign(realModelDeps([]), { toolResolver }));
  const routed = caught(() => capabilityRouter.resolveAgentRoute({}));
  assert.equal(routed.code, modelResolver.MODEL_ROUTE_NO_CANDIDATE);
  assert.notEqual(routed.code, kernel.AGENT_DEPENDENCY_UNAVAILABLE);
});

test("回退策略：strict 缺能力结构化失败；best_available 返回带 missing/warnings 的回退路由", () => {
  // ollama legacy 协议只声明 chat/vision，没有 llm.tools 操作 → 有能力缺口但族匹配仍成立。
  const provider = makeProvider({
    id: "p-ollama", name: "本机 Ollama", protocol: "ollama", api_key: "",
    base_url: "http://127.0.0.1:11434",
    models: [{ model: "llama3.2", caps: ["llm"] }],
  });
  const baseRequest = { taskIntent: "agent.project.write", requiresAll: ["llm.tools"], requiresAny: [] };

  const best = modelResolver.resolveModelRoutesFromProviders([provider], Object.assign({}, baseRequest, { fallbackPolicy: "best_available" }));
  assert.equal(best.length, 1);
  assert.equal(best[0].model, "llama3.2");
  assert.deepEqual(best[0].missing, ["llm.tools"]);
  assert.ok(best[0].warnings.some((warning) => warning.includes("缺少能力：llm.tools")), best[0].warnings.join("｜"));

  const strict = caught(() => modelResolver.resolveModelRoutesFromProviders([provider], Object.assign({}, baseRequest, { fallbackPolicy: "strict" })));
  assert.equal(strict.code, modelResolver.MODEL_ROUTE_STRICT_CAPABILITY);
  assert.match(strict.message, /指定模型不支持所需能力/);
  assert.match(strict.message, /llm\.tools/);
});

test("候选评分：preferredModels / 显式首选权重把目标模型排到路由链第一位", () => {
  const provider = makeProvider({
    models: [{ model: "gpt-4o", caps: ["llm"] }, { model: "gpt-4o-mini", caps: ["llm"] }],
  });
  const request = {
    taskIntent: "agent.project.write",
    requiresAll: ["llm.tools"],
    requiresAny: [],
    fallbackPolicy: "best_available",
    preferredModels: [{ providerId: "p1", model: "gpt-4o-mini", weight: 2000 }],
  };
  const routes = modelResolver.resolveModelRoutesFromProviders([provider], request);
  assert.deepEqual(routes.map((route) => route.model), ["gpt-4o-mini", "gpt-4o"]);
  // 非首选模型的 alternatives 里能看到首选（保留回退语义）。
  assert.ok(routes[1].alternatives.some((item) => item.model === "gpt-4o-mini"));
});

test("agent-service 装配：providerProtocol 存在时 configureAgentKernel 注入真实路由依赖（端到端可达）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-model-resolver-bundle-"));
  tempDirs.push(dir);
  const identityStore = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  const providers = [makeProvider()];
  const bundle = createAgentBundle({
    identityStore,
    authorization: { resolveActor: () => ({ ok: true, user: { id: "u1", role: "ADMIN", team_id: "org1" }, organizationId: "org1" }) },
    authStore: { appGrantsForApp: () => [{ appId: "ai", actions: ["files.read"] }] },
    // 生产装配里 providerProtocol 由 model-bootstrap 挂在 modelService 上；这里只给内核需要的 store 视图。
    modelService: { providerProtocol: { store: { listInternal: () => providers } } },
    userDataDir: dir,
    clock: () => Date.now(),
    dbPath: path.join(dir, "identity.db"),
  });
  try {
    const routed = await bundle.execute("agent/capability/route", { instruction: "整理一下这份材料" }, { sessionRef: "sess-model", requestId: "req-model" });
    assert.equal(routed.ok, true, JSON.stringify(routed));
    assert.equal(routed.value.route.model.model, "gpt-4o");
    assert.equal(routed.value.route.model.operationId, "llm.tools");

    const health = await bundle.execute("agent/health", {}, { sessionRef: "sess-model", requestId: "req-health" });
    assert.equal(health.ok, true);
    assert.equal(health.value.dependencies.db, true);
  } finally {
    try { identityStore.close(); } catch { /* 已关 */ }
  }
});
