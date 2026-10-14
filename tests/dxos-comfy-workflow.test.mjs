/**
 * B7e1 · ComfyUI 工作流纯逻辑测试（全离线：无 Electron、无网络、无子进程）。
 *
 * 覆盖任务书 item 2 的"解析 / 参数校验 / 节点映射按源逐字"：
 *   · apiWorkflow / safeFields / safeOutputs 的逐字拒绝语义；
 *   · prepareComfyRun 的必填校验、种子随机、可选素材裁剪、上传清单；
 *   · pruneSkippedComfyBranches 的"可选素材关闭全部输出"拒绝；
 *   · 能力推断 / Agent 清单 / 随包工作流（内嵌 3 份 + 外部目录增量）；
 *   · 配置 / 地址 / 实例归一化。
 *
 * 只读源：electron/comfy-workflow.cjs（移植自 server/comfyWorkflows.ts、server/comfyui.ts）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const workflow = require("../electron/comfy-workflow.cjs");
const comfyDomain = require("../electron/comfy-domain.cjs");

const tmpDirs = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
process.on("exit", () => { for (const dir of tmpDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } } });

function basePreset(overrides = {}) {
  return {
    id: "p1",
    name: "测试工作流",
    instanceId: "gpu-0",
    workflow: {
      // 参考图单独走一条不汇入输出的预览分支：跳过它不会关闭输出，便于单独验证裁剪。
      "1": { class_type: "LoadImage", inputs: { image: "a.png" } },
      "4": { class_type: "PreviewImage", inputs: { images: ["1", 0] } },
      "2": { class_type: "Sampler", inputs: { prompt: "hello" } },
      "3": { class_type: "SaveImage", inputs: { images: ["2", 0] } },
    },
    fields: [
      { id: "f-prompt", label: "提示词", type: "textarea", nodeId: "2", input: "prompt", required: true },
      { id: "f-image", label: "参考图", type: "image", nodeId: "1", input: "image", required: false, mediaSlot: 1, missingPolicy: "skip" },
    ],
    outputs: [{ id: "o1", label: "结果", nodeId: "3", type: "image" }],
    ...overrides,
  };
}

// ── apiWorkflow ──────────────────────────────────────────────────────────
test("apiWorkflow：逐字拒绝非对象 / UI 工作流 / 空图 / 无 class_type 节点", () => {
  assert.throws(() => workflow.apiWorkflow([]), /工作流必须是 JSON 对象/);
  assert.throws(() => workflow.apiWorkflow(null), /工作流必须是 JSON 对象/);
  assert.throws(() => workflow.apiWorkflow({ nodes: [{ id: 1 }], links: [] }), /这不是 ComfyUI API 工作流/);
  assert.throws(() => workflow.apiWorkflow({}), /工作流中没有节点/);
  assert.throws(() => workflow.apiWorkflow({ "1": { inputs: {} } }), /这不是 ComfyUI API 工作流/);
  assert.throws(() => workflow.apiWorkflow({ "1": [] }), /节点 1 格式无效/);
});

test("apiWorkflow：接受 {prompt:...} 包装与裸图，归一化 inputs / _meta", () => {
  const wrapped = workflow.apiWorkflow({ prompt: { "5": { class_type: "KSampler", inputs: { seed: 1 }, _meta: { title: "采样" } } } });
  assert.deepEqual(Object.keys(wrapped), ["5"]);
  assert.equal(wrapped["5"].class_type, "KSampler");
  assert.equal(wrapped["5"].inputs.seed, 1);
  assert.equal(wrapped["5"]._meta.title, "采样");
  const bare = workflow.apiWorkflow({ "7": { class_type: "EmptyLatentImage" } });
  assert.deepEqual(bare["7"].inputs, {}, "无 inputs 时归一化为空对象");
});

// ── safeFields / safeOutputs ─────────────────────────────────────────────
test("safeFields：映射到不存在的节点输入逐字拒绝", () => {
  const graph = workflow.apiWorkflow({ "1": { class_type: "A", inputs: { x: 1 } } });
  assert.throws(() => workflow.safeFields([{ nodeId: "9", input: "x" }], graph), /映射字段 1 指向不存在的节点输入/);
  assert.throws(() => workflow.safeFields([{ nodeId: "1", input: "nope" }], graph), /映射字段 1 指向不存在的节点输入/);
});

test("safeFields：媒体槽位自动去重，超过 20 个逐字拒绝", () => {
  const graph = workflow.apiWorkflow({ "1": { class_type: "A", inputs: { img: "a" } } });
  const fields = workflow.safeFields([
    { id: "a", nodeId: "1", input: "img", type: "image" },
    { id: "b", nodeId: "1", input: "img", type: "image" },
  ], graph);
  assert.equal(fields[0].mediaSlot, 1);
  assert.equal(fields[1].mediaSlot, 2, "同类型第二个槽位自动 +1");
  assert.equal(fields[0].missingPolicy, "skip");
  const many = Array.from({ length: 21 }, (_, i) => ({ id: "m" + i, nodeId: "1", input: "img", type: "image", mediaSlot: 1 }));
  assert.throws(() => workflow.safeFields(many, graph), /image 映射槽位超过 20 个/);
});

test("safeFields / safeOutputs：类型与角色白名单回落 + 输出节点校验", () => {
  const graph = workflow.apiWorkflow({ "1": { class_type: "A", inputs: { x: 1 }, _meta: { title: "节点一" } } });
  const fields = workflow.safeFields([{ id: "f", nodeId: "1", input: "x", type: "bogus", role: "bogus", required: true }], graph);
  assert.equal(fields[0].type, "text", "未知字段类型回落 text");
  assert.equal(fields[0].role, undefined, "未知输入角色不落地");
  assert.equal(fields[0].required, true);
  const outputs = workflow.safeOutputs([{ nodeId: "1", type: "bogus", role: "bogus" }], graph);
  assert.equal(outputs[0].type, "image");
  assert.equal(outputs[0].role, "result");
  assert.equal(outputs[0].label, "节点一");
  assert.throws(() => workflow.safeOutputs([{ nodeId: "9" }], graph), /输出 1 指向不存在的节点/);
});

// ── prepareComfyRun ──────────────────────────────────────────────────────
test("prepareComfyRun：必填文本 / 必填素材 / 未知节点全部结构化拒绝", () => {
  const preset = basePreset();
  assert.throws(() => workflow.prepareComfyRun(preset, {}, {}), /请填写提示词/);
  const withPrompt = workflow.prepareComfyRun(preset, { "f-prompt": "一只猫" }, {});
  assert.equal(withPrompt.prompt["2"].inputs.prompt, "一只猫");
  assert.equal(withPrompt.prompt["1"], undefined, "可选素材 skip 后节点被裁剪");
  assert.equal(withPrompt.prompt["4"], undefined, "仅依赖被裁剪分支的下游节点一并移除");
  assert.deepEqual([...withPrompt.skipped].sort(), ["1", "4"]);
  assert.throws(() => workflow.prepareComfyRun({ ...preset, fields: [{ id: "x", label: "必填图", type: "image", nodeId: "1", input: "image", required: true }] }, {}, {}), /请上传必填图/);
  assert.throws(() => workflow.prepareComfyRun({ ...preset, fields: [{ id: "x", label: "丢失", type: "text", nodeId: "99", input: "x" }] }, {}, {}), /映射节点已不存在：99/);
});

test("prepareComfyRun：seed -1 / 空串 / random 走随机，min=max 时结果唯一", () => {
  const preset = basePreset({
    fields: [{ id: "s", label: "种子", type: "seed", nodeId: "2", input: "prompt", required: true, min: 7, max: 7 }],
  });
  for (const value of [-1, "", "random"]) {
    const prepared = workflow.prepareComfyRun(preset, { s: value }, {});
    assert.equal(prepared.prompt["2"].inputs.prompt, 7, "seed=" + JSON.stringify(value) + " 应随机到 [7,7]");
  }
  const fixed = workflow.prepareComfyRun(preset, { s: 123 }, {});
  assert.equal(fixed.prompt["2"].inputs.prompt, 123, "显式 seed 原样保留");
});

test("prepareComfyRun：已提供素材进入 uploads，未提供但策略 default 时保留默认值", () => {
  const preset = basePreset({
    fields: [
      { id: "f-prompt", label: "提示词", type: "textarea", nodeId: "2", input: "prompt", required: true },
      { id: "f-image", label: "参考图", type: "image", nodeId: "1", input: "image", required: false, mediaSlot: 1, missingPolicy: "default" },
    ],
  });
  const byDefault = workflow.prepareComfyRun(preset, { "f-prompt": "x" }, {});
  assert.equal(byDefault.prompt["1"].inputs.image, "a.png", "default 策略保留工作流里的默认素材");
  assert.deepEqual(byDefault.uploads, []);
  const withFile = workflow.prepareComfyRun(preset, { "f-prompt": "x" }, { "f-image": { name: "cat.png", mime: "image/png" } });
  assert.equal(withFile.uploads.length, 1);
  assert.deepEqual(withFile.uploads[0], { fieldId: "f-image", nodeId: "1", input: "image", name: "cat.png", mime: "image/png" });
});

test("prepareComfyRun：同一节点同时有已提供与未提供媒体映射时拒绝", () => {
  const preset = basePreset({
    fields: [
      { id: "f-prompt", label: "提示词", type: "textarea", nodeId: "2", input: "prompt", required: true },
      { id: "img-a", label: "图 A", type: "image", nodeId: "1", input: "image", mediaSlot: 1 },
      { id: "img-b", label: "图 B", type: "image", nodeId: "1", input: "other", mediaSlot: 2 },
    ],
  });
  preset.workflow["1"].inputs.other = "b.png";
  assert.throws(
    () => workflow.prepareComfyRun(preset, { "f-prompt": "x" }, { "img-a": { name: "a.png" } }),
    /同时包含已提供和未提供的媒体映射/,
  );
});

test("pruneSkippedComfyBranches：可选素材覆盖全部输出时逐字拒绝", () => {
  const preset = {
    id: "closes-outputs",
    instanceId: "gpu-0",
    workflow: {
      "1": { class_type: "LoadImage", inputs: { image: "a.png" } },
      "3": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
    },
    fields: [{ id: "f", label: "图", type: "image", nodeId: "1", input: "image", missingPolicy: "skip", mediaSlot: 1 }],
    outputs: [{ id: "o", nodeId: "3", type: "image" }],
  };
  assert.throws(() => workflow.prepareComfyRun(preset, {}, {}), /会关闭当前工作流的全部输出/);
});

test("pruneSkippedComfyBranches：合并分支只删悬空边、保留汇合节点", () => {
  const prompt = {
    "1": { class_type: "LoadImage", inputs: { image: "a.png" } },
    "2": { class_type: "LoadImage", inputs: { image: "b.png" } },
    "3": { class_type: "Merge", inputs: { a: ["1", 0], b: ["2", 0] } },
    "4": { class_type: "SaveImage", inputs: { images: ["3", 0] } },
  };
  const skipped = workflow.pruneSkippedComfyBranches(prompt, ["1"], ["4"], ["1", "2"]);
  assert.deepEqual([...skipped].sort(), ["1"]);
  assert.equal(prompt["1"], undefined);
  assert.deepEqual(prompt["3"].inputs, { b: ["2", 0] }, "只删除指向被裁剪节点的边");
  assert.deepEqual(prompt["4"].inputs.images, ["3", 0]);
});

// ── 能力 / 清单 / 随包 ──────────────────────────────────────────────────
test("能力推断与 Agent 清单：始终含 app.comfy.workflow.run，角色 / primary 有缺省", () => {
  const fields = [{ id: "i", label: "图", type: "image", role: "reference_image" }, { id: "t", label: "词", type: "textarea" }];
  const outputs = [{ id: "o", label: "结果", nodeId: "9", type: "image" }];
  const caps = workflow.inferComfyWorkflowCapabilities(fields, outputs);
  assert.ok(caps.includes("app.comfy.workflow.run"));
  assert.ok(caps.includes("media.image.edit"), "有图片输入 → 图片编辑能力");
  const manifest = workflow.comfyWorkflowAgentManifest({ id: "p", name: "P", description: "d", fields, outputs, capabilities: [], aliases: ["a"], recommended: true });
  assert.deepEqual(manifest.capabilities[0], "app.comfy.workflow.run");
  assert.equal(manifest.inputs[1].role, "prompt", "textarea 缺省角色是 prompt");
  assert.equal(manifest.outputs[0].primary, true, "唯一输出默认 primary");
  assert.equal(manifest.recommended, true);
});

test("随包工作流：内嵌 3 份，旧 ID 一次性迁移，同名去重", () => {
  const bundled = workflow.bundledComfyWorkflows();
  assert.equal(bundled.length, 3);
  assert.deepEqual(bundled.map((item) => item.id).sort(), ["builtin-minimax-h3", "builtin-qwen21-image-to-image", "builtin-qwen21-text-to-image"]);
  const seeded = workflow.withBundledComfyWorkflows([]);
  assert.equal(seeded.length, 3);
  assert.ok(seeded.every((item) => item.workflow && Object.keys(item.workflow).length > 0), "随包项必须带真实 API 图");
  const migrated = workflow.withBundledComfyWorkflows([{ id: "c4af11de-46f0-4f6e-a869-48a25caed26c", name: "旧文生图", workflow: { "1": { class_type: "X", inputs: {} } } }]);
  assert.equal(migrated.length, 3, "旧 ID 迁移后不重复追加");
  assert.ok(migrated.some((item) => item.id === "builtin-qwen21-text-to-image" && item.builtin === true));
  assert.equal(migrated.find((item) => item.id === "builtin-qwen21-text-to-image").workflow["1"].class_type, "X", "迁移保留用户保存的图");
});

test("loadBundledWorkflows：只加载合法 JSON 预设，坏文件跳过", () => {
  const dir = tempDir("dxos-comfy-bundled-");
  fs.writeFileSync(path.join(dir, "good.json"), JSON.stringify({ id: "extra-1", name: "额外", workflow: { "1": { class_type: "X", inputs: {} } }, fields: [], outputs: [] }));
  fs.writeFileSync(path.join(dir, "broken.json"), "{ not json");
  fs.writeFileSync(path.join(dir, "array.json"), "[]");
  const items = workflow.loadBundledWorkflows(dir);
  assert.deepEqual(items.map((item) => item.id), ["extra-1"]);
  assert.deepEqual(workflow.loadBundledWorkflows(path.join(dir, "missing")), []);
});

// ── 运行结果提取 ─────────────────────────────────────────────────────────
test("comfyResultsFromHistory：按 outputs 映射裁剪文件与文本，去重", () => {
  const preset = { outputs: [{ id: "o", label: "结果", nodeId: "9", type: "image" }] };
  const item = {
    outputs: {
      "9": { images: [{ filename: "a.png", subfolder: "sub", type: "output" }, { filename: "a.png", subfolder: "sub", type: "output" }] },
      "8": { images: [{ filename: "ignored.png" }] },
    },
  };
  const results = workflow.comfyResultsFromHistory(preset, item);
  assert.equal(results.length, 1, "重复文件去重，未映射节点被忽略");
  assert.deepEqual(results[0], { name: "a.png", type: "image", subfolder: "sub", outputType: "output", nodeId: "9", label: "结果" });
  const textPreset = { outputs: [{ id: "t", label: "文本", nodeId: "1", type: "text" }] };
  const textResults = workflow.comfyResultsFromHistory(textPreset, { outputs: { "1": { text: ["甲", "甲"], result: "乙" } } });
  assert.deepEqual(textResults.map((item2) => item2.text), ["甲", "乙"]);
});

// ── 配置 / 地址 / 实例 ───────────────────────────────────────────────────
test("地址与实例归一化：拒绝带账号 / query 的地址与非法局域网主机名", () => {
  assert.equal(workflow.normalizeComfyBaseUrl("https://user:pass@example.com"), "");
  assert.equal(workflow.normalizeComfyBaseUrl("https://example.com/?a=1"), "");
  assert.equal(workflow.normalizeComfyBaseUrl("ftp://example.com"), "");
  assert.equal(workflow.normalizeComfyBaseUrl("https://example.com/"), "https://example.com");
  assert.equal(workflow.normalizeComfyLanHost("192.168.1.9"), "192.168.1.9");
  assert.equal(workflow.normalizeComfyLanHost("http://box.local/"), "box.local");
  assert.equal(workflow.normalizeComfyLanHost("host:1234"), "");
  assert.equal(workflow.normalizeComfyLanHost("a/b"), "");
});

test("normalizeComfyConfig：实例 id 与端口冲突只在后者解决", () => {
  const config = workflow.normalizeComfyConfig({
    rootDir: "/nonexistent/root",
    instances: [
      { id: "gpu-0", port: 9000, mode: "local" },
      { id: "gpu-0", port: 9000, mode: "local" },
      { id: "gpu-0", port: 9000, mode: "lan", lanHost: "box.local" },
    ],
  });
  assert.deepEqual(config.instances.map((item) => item.id), ["gpu-0", "gpu-0-2", "gpu-0-3"]);
  assert.equal(config.instances[0].port, 9000);
  assert.equal(config.instances[1].port !== 9000, true, "后出现的端口冲突必须换端口");
  assert.equal(new Set(config.instances.map((item) => item.port)).size, 3);
});

test("comfyInstanceBaseUrl：local 走 listen，lan / remote 走对应地址", () => {
  const config = { listen: "0.0.0.0" };
  assert.equal(workflow.comfyInstanceBaseUrl(config, { mode: "local", port: 8188 }), "http://127.0.0.1:8188");
  assert.equal(workflow.comfyInstanceBaseUrl(config, { mode: "lan", lanHost: "box.local", port: 8188 }), "http://box.local:8188");
  assert.equal(workflow.comfyInstanceBaseUrl(config, { mode: "remote", baseUrl: "https://comfy.example.com" }), "https://comfy.example.com");
  assert.throws(() => workflow.comfyInstanceBaseUrl(config, { mode: "remote", baseUrl: "" }), /云端 ComfyUI 地址无效/);
  assert.throws(() => workflow.comfyInstanceBaseUrl(config, { mode: "lan", lanHost: "", port: 1 }), /局域网 ComfyUI 地址无效/);
});

test("comfy-domain：命令表含 22 条，风险 / 中文 summary 齐全，credential 不直接投影", () => {
  const commands = comfyDomain.listComfyCommands();
  assert.equal(commands.length, 24);
  assert.equal(Object.keys(comfyDomain.COMFY_COMMANDS).length, 24);
  for (const entry of commands) {
    assert.ok(["read", "use", "manage", "destructive"].includes(entry.risk), entry.command + " 风险等级非法");
    assert.equal(typeof entry.needsCredential, "boolean");
    assert.equal("credential" in entry, false, "IPC 投影必须改名为 needsCredential（避免脱敏掩码）");
    assert.ok(entry.summary.length > 0 && /[\u4e00-\u9fa5]/.test(entry.summary), entry.command + " 需要中文 summary");
  }
  assert.equal(comfyDomain.comfyCommandRisk("comfy/nope"), null);
  assert.equal(comfyDomain.isComfyCommand("comfy/nope"), false);
  assert.equal(comfyDomain.COMFY_ERR_DEPENDENCY_UNAVAILABLE, "COMFY_DEPENDENCY_UNAVAILABLE");
  assert.equal(comfyDomain.COMFY_ERR_INTEGRATION_UNAVAILABLE, "INTEGRATION_UNAVAILABLE");
});
