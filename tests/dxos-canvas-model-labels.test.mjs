/**
 * 画布侧模型显示名（供应商真实模型名优先）· 纯函数单测。
 * 被测：src/canvas/canvasModelLabels.ts（产品真实代码，宿主 CanvasHost 投影的唯一命名真源）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCanvasModelLabelIndex, canvasModelBaseName, CANVAS_MODEL_LABEL_SEPARATOR } from "../src/canvas/canvasModelLabels.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const model = (over) => Object.assign({ configId: "cfg-default", remoteModelId: "", displayName: "", providerId: "p", providerName: "Provider" }, over);

test("远程名优先：有 remoteModelId 时显示供应商真实模型名（不是本地显示名 / 也不是 configId 尾巴）", () => {
  const m = model({ configId: "cfg-1111", remoteModelId: "deepseek-chat", displayName: "DeepSeek Chat", providerName: "DeepSeek" });
  assert.equal(canvasModelBaseName(m), "deepseek-chat");
  const idx = buildCanvasModelLabelIndex([m]);
  assert.equal(idx.labelOf.get("cfg-1111"), "deepseek-chat");
  assert.equal(idx.configOf.get("deepseek-chat"), "cfg-1111");
  // 单一模型、无重名 → 不加供应商后缀，保持上游原名
  assert.ok(!idx.labelOf.get("cfg-1111").includes(CANVAS_MODEL_LABEL_SEPARATOR));
});

test("回退顺序：无 remoteModelId → displayName；两者都空 → configId", () => {
  assert.equal(canvasModelBaseName(model({ remoteModelId: "", displayName: "本地显示名" })), "本地显示名");
  assert.equal(canvasModelBaseName(model({ remoteModelId: "", displayName: "", configId: "cfg-zzzz" })), "cfg-zzzz");
  assert.equal(canvasModelBaseName(model({ remoteModelId: "  ", displayName: "  本地名  " })), "本地名");
  const idx = buildCanvasModelLabelIndex([
    model({ configId: "a", remoteModelId: "", displayName: "本地显示名" }),
    model({ configId: "b", remoteModelId: "", displayName: "" }),
  ]);
  assert.equal(idx.labelOf.get("a"), "本地显示名");
  assert.equal(idx.labelOf.get("b"), "b");
});

test("重名消歧：同一 remoteModelId 落在多个服务商 → 追加供应商名，逐条唯一且可逆", () => {
  const input = [
    model({ configId: "cfg-aaaa", remoteModelId: "deepseek-chat", displayName: "DeepSeek Chat", providerId: "prov-deepseek", providerName: "DeepSeek" }),
    model({ configId: "cfg-bbbb", remoteModelId: "deepseek-chat", displayName: "DS on SiliconFlow", providerId: "prov-sf", providerName: "硅基流动" }),
    model({ configId: "cfg-cccc", remoteModelId: "gemini-3.1-flash-image", displayName: "Gemini Image", providerId: "prov-g", providerName: "Google" }),
  ];
  const idx = buildCanvasModelLabelIndex(input);
  assert.equal(idx.labelOf.get("cfg-aaaa"), "deepseek-chat" + CANVAS_MODEL_LABEL_SEPARATOR + "DeepSeek");
  assert.equal(idx.labelOf.get("cfg-bbbb"), "deepseek-chat" + CANVAS_MODEL_LABEL_SEPARATOR + "硅基流动");
  // 不重名的模型保持供应商原名，不无谓追加
  assert.equal(idx.labelOf.get("cfg-cccc"), "gemini-3.1-flash-image");
  // 双向一致
  for (const m of input) assert.equal(idx.configOf.get(idx.labelOf.get(m.configId)), m.configId);
  assert.equal(idx.labelOf.size, input.length);
  assert.equal(idx.configOf.size, input.length);
});

test("同供应商下同 id 多条配置 → 追加 configId 末 4 位；末 4 位撞车时自动加长", () => {
  const input = [
    model({ configId: "cfg-aaa1111", remoteModelId: "deepseek-chat", providerId: "prov-d", providerName: "DeepSeek" }),
    model({ configId: "cfg-bbb2222", remoteModelId: "deepseek-chat", providerId: "prov-d", providerName: "DeepSeek" }),
  ];
  const idx = buildCanvasModelLabelIndex(input);
  assert.equal(idx.labelOf.get("cfg-aaa1111"), "deepseek-chat" + CANVAS_MODEL_LABEL_SEPARATOR + "DeepSeek" + CANVAS_MODEL_LABEL_SEPARATOR + "1111");
  assert.equal(idx.labelOf.get("cfg-bbb2222"), "deepseek-chat" + CANVAS_MODEL_LABEL_SEPARATOR + "DeepSeek" + CANVAS_MODEL_LABEL_SEPARATOR + "2222");

  // 末 4 位相同 → 加长到能区分
  const collide = [
    model({ configId: "xx-abcd1234", remoteModelId: "same-id", providerId: "p", providerName: "P" }),
    model({ configId: "yy-zzabcd1234", remoteModelId: "same-id", providerId: "p", providerName: "P" }),
  ];
  const cidx = buildCanvasModelLabelIndex(collide);
  const l1 = cidx.labelOf.get("xx-abcd1234");
  const l2 = cidx.labelOf.get("yy-zzabcd1234");
  assert.notEqual(l1, l2);
  assert.ok(l1.endsWith("abcd1234"), "后缀必须是从末位起唯一：" + l1);
  assert.ok(l2.endsWith("abcd1234"), "后缀必须是从末位起唯一：" + l2);
  assert.equal(cidx.configOf.get(l1), "xx-abcd1234");
  assert.equal(cidx.configOf.get(l2), "yy-zzabcd1234");
});

test("双射不变式：任意清单下 label 唯一、configId 唯一、label ⇄ configId 互相还原", () => {
  const input = [
    model({ configId: "c1", remoteModelId: "m", providerName: "A" }),
    model({ configId: "c2", remoteModelId: "m", providerName: "B" }),
    model({ configId: "c3", remoteModelId: "m", providerName: "A" }),
    model({ configId: "c4", remoteModelId: "m", providerName: "A" }),
    model({ configId: "c5", remoteModelId: "m2", providerName: "A" }),
    model({ configId: "c6", remoteModelId: "", displayName: "m", providerName: "A" }),
    model({ configId: "c7", remoteModelId: "", displayName: "", providerName: "A" }),
  ];
  const idx = buildCanvasModelLabelIndex(input);
  const labels = input.map((m) => idx.labelOf.get(m.configId));
  assert.equal(new Set(labels).size, input.length, "label 必须逐条唯一：" + JSON.stringify(labels));
  assert.equal(idx.configOf.size, input.length);
  for (const m of input) assert.equal(idx.configOf.get(idx.labelOf.get(m.configId)), m.configId);
});

test("稳定性：输入数组顺序变化不改变任何 configId 的 label", () => {
  const input = [
    model({ configId: "s1", remoteModelId: "same", providerName: "A" }),
    model({ configId: "s2", remoteModelId: "same", providerName: "B" }),
    model({ configId: "s3", remoteModelId: "same", providerName: "B" }),
    model({ configId: "s4", remoteModelId: "other", providerName: "A" }),
  ];
  const a = buildCanvasModelLabelIndex(input);
  const b = buildCanvasModelLabelIndex([...input].reverse());
  const c = buildCanvasModelLabelIndex([input[2], input[0], input[3], input[1]]);
  for (const m of input) {
    assert.equal(a.labelOf.get(m.configId), b.labelOf.get(m.configId));
    assert.equal(a.labelOf.get(m.configId), c.labelOf.get(m.configId));
  }
});

test("单一真源：CanvasHost 用索引命名与反查，旧实现（displayName 优先 + configId 尾号）已移除", () => {
  const src = fs.readFileSync(path.join(HERE, "..", "src", "canvas", "CanvasHost.tsx"), "utf8");
  assert.ok(src.includes("buildCanvasModelLabelIndex"), "宿主必须使用唯一命名函数");
  assert.ok(src.includes("labelToConfig.current = modelLabels.configOf"), "反向映射必须来自同一索引");
  assert.ok(!/\.slice\(-4\)/.test(src), "旧标签格式（configId 末 4 位）不得残留");
  assert.ok(!/m\.displayName \|\| m\.remoteModelId/.test(src), "旧回退顺序（displayName 优先）不得残留");
});
