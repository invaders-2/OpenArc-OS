/**
 * 「拉取模型」勾选 → 增删计划（src-vue/settings/remoteModelsLogic.ts）的离线单测。
 *
 * 锁死老板提的口径：
 *   ① 刚拉取（picked / dropped 都空）→ 零添加、零移除，绝不默认全加；
 *   ② 只勾选未加入的 → 只有 adds，能力随模型带（勾选值优先，缺省按模型名推断）；
 *   ③ 已加入的取消勾选 → 只有 removals；
 *   ④ 混合 → adds / removals 各自准确；
 *   ⑤ 行内勾选框：已加入默认勾上（取消=移除）、未加入默认不勾（勾上=加入）；
 *   ⑥ 空 / 异常输入不抛，也不产生假计划。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildBulkPick, buildCuratePlan, curateCapabilities, curateRowChecked } from "../src-vue/settings/remoteModelsLogic.ts";

const items = () => [
  { id: "deepseek-chat", suggestedCapabilities: ["chat"] },
  { id: "seedream-4.0", suggestedCapabilities: ["image-generation"] },
  { id: "kling-v2", suggestedCapabilities: ["video-generation"], registered: true },
  { id: "whisper-1", suggestedCapabilities: [] },
];

test("刚拉取：picked / dropped 都空 → 零添加零移除（默认不全部拉取）", () => {
  const plan = buildCuratePlan(items(), { picked: {}, dropped: {} });
  assert.deepEqual(plan, { adds: [], removals: [] });
  // 已加入的那行默认勾上（= 保留），未加入的默认不勾
  assert.equal(curateRowChecked({ id: "kling-v2", registered: true }, { picked: {}, dropped: {} }), true);
  assert.equal(curateRowChecked({ id: "deepseek-chat", registered: false }, { picked: {}, dropped: {} }), false);
  // picks 整体缺省时不抛
  assert.deepEqual(buildCuratePlan(items()), { adds: [], removals: [] });
});

test("只勾选未加入的 → 只有 adds，能力随模型带", () => {
  const plan = buildCuratePlan(items(), {
    picked: { "deepseek-chat": ["chat", "tool-calling"], "seedream-4.0": ["image-generation"] },
    dropped: {},
  });
  assert.deepEqual(plan.removals, []);
  assert.deepEqual(plan.adds, [
    { id: "deepseek-chat", capabilities: ["chat", "tool-calling"] },
    { id: "seedream-4.0", capabilities: ["image-generation"] },
  ]);
  assert.equal(curateRowChecked({ id: "deepseek-chat", registered: false }, { picked: { "deepseek-chat": ["chat"] } }), true);
});

test("勾选值缺省时回落到模型自带/推断能力；显式空能力如实保留空", () => {
  assert.deepEqual(curateCapabilities({ id: "deepseek-chat", suggestedCapabilities: ["chat"] }), ["chat"]);
  assert.deepEqual(curateCapabilities({ id: "gpt-4o" }), ["chat", "vision-input"], "没有 suggestedCapabilities 时按模型名推断");
  assert.deepEqual(curateCapabilities({ id: "whisper-1", suggestedCapabilities: [] }), [], "上游说没有能力就带空，不硬塞 chat");
  assert.deepEqual(curateCapabilities({ id: "gpt-4o" }, ["chat"]), ["chat"], "勾选时记下的能力优先");
  assert.deepEqual(curateCapabilities({ id: "gpt-4o" }, []), [], "显式空数组仍然优先");
  // 计划里同样带出能力：没勾选值 → 用模型自带
  assert.deepEqual(buildCuratePlan(items(), { picked: { "whisper-1": undefined } }).adds, [{ id: "whisper-1", capabilities: [] }]);
});

test("已加入的取消勾选 → 只有 removals", () => {
  const plan = buildCuratePlan(items(), { picked: {}, dropped: { "kling-v2": true } });
  assert.deepEqual(plan.adds, []);
  assert.deepEqual(plan.removals, ["kling-v2"]);
  assert.equal(curateRowChecked({ id: "kling-v2", registered: true }, { dropped: { "kling-v2": true } }), false);
});

test("混合：既勾选未加入的，又取消已加入的", () => {
  const plan = buildCuratePlan(items(), {
    picked: { "deepseek-chat": ["chat"] },
    dropped: { "kling-v2": true },
  });
  assert.deepEqual(plan.adds, [{ id: "deepseek-chat", capabilities: ["chat"] }]);
  assert.deepEqual(plan.removals, ["kling-v2"]);
});

test("已加入的即使被 picked 也不会重复添加；未加入的即使被 dropped 也不算移除", () => {
  const plan = buildCuratePlan(items(), {
    picked: { "kling-v2": ["video-generation"], "deepseek-chat": ["chat"] },
    dropped: { "deepseek-chat": true, "kling-v2": true },
  });
  assert.deepEqual(plan.adds, [{ id: "deepseek-chat", capabilities: ["chat"] }]);
  assert.deepEqual(plan.removals, ["kling-v2"]);
});

test("空 / 异常输入不抛，不产生假计划", () => {
  for (const bad of [null, undefined, "x", 42, {}, [null, undefined, 1, "y", { id: "" }, { noId: true }]]) {
    assert.deepEqual(buildCuratePlan(bad, { picked: { "deepseek-chat": ["chat"] }, dropped: { x: true } }), { adds: [], removals: [] }, JSON.stringify(bad));
  }
  assert.deepEqual(buildCuratePlan(items(), { picked: null, dropped: null }), { adds: [], removals: [] });
  assert.deepEqual(buildCuratePlan(items(), null), { adds: [], removals: [] });
  assert.deepEqual(buildCuratePlan(items(), { picked: { "deepseek-chat": ["chat"] }, dropped: { "kling-v2": false } }), {
    adds: [{ id: "deepseek-chat", capabilities: ["chat"] }],
    removals: [],
  });
  assert.equal(curateRowChecked(null, {}), false);
  assert.equal(curateRowChecked({}, {}), false);
  assert.equal(curateRowChecked({ id: "x", registered: false }, { picked: null }), false);
});


test("批量全选本类：只加未加入的，已加入的恢复保留；跨分类不动", () => {
  const list = [...items(), { id: "wanx-v1", suggestedCapabilities: ["image-generation"] }];
  const before = { picked: { "whisper-1": [] }, dropped: { "kling-v2": true } };
  const next = buildBulkPick(list, before, "select", ["deepseek-chat", "seedream-4.0", "kling-v2"]);
  assert.deepEqual(Object.keys(next.picked).sort(), ["deepseek-chat", "seedream-4.0", "whisper-1"], "本类的未加入模型被勾上，别的类的勾选原样保留");
  assert.deepEqual(next.picked["deepseek-chat"], ["chat"]);
  assert.deepEqual(next.picked["seedream-4.0"], ["image-generation"]);
  assert.deepEqual(next.dropped, {}, "已加入的恢复保留（dropped 清空）");
  // 用新状态算计划：只加未加入的（含之前已勾的 whisper-1），没有移除
  const plan = buildCuratePlan(list, next);
  assert.deepEqual(plan.adds.map((a) => a.id), ["deepseek-chat", "seedream-4.0", "whisper-1"]);
  assert.deepEqual(plan.removals, []);
});

test("批量清空本类：已加入的标记移除 + 清掉本类新勾选；跨分类不动", () => {
  const list = [...items(), { id: "wanx-v1", suggestedCapabilities: ["image-generation"] }];
  const before = { picked: { "deepseek-chat": ["chat"], "wanx-v1": ["image-generation"] }, dropped: {} };
  const next = buildBulkPick(list, before, "clear", ["deepseek-chat", "seedream-4.0", "kling-v2"]);
  assert.deepEqual(Object.keys(next.picked), ["wanx-v1"], "别的类的新勾选保留，本类的被清掉");
  assert.deepEqual(next.dropped, { "kling-v2": true }, "本类已加入的标记移除");
  const plan = buildCuratePlan(list, next);
  assert.deepEqual(plan.adds.map((a) => a.id), ["wanx-v1"]);
  assert.deepEqual(plan.removals, ["kling-v2"]);
});

test("清空已选（reset）：picked 与 dropped 一起清空，回到默认全保留", () => {
  const list = items();
  const next = buildBulkPick(list, { picked: { "deepseek-chat": ["chat"] }, dropped: { "kling-v2": true } }, "reset");
  assert.deepEqual(next, { picked: {}, dropped: {} });
  assert.deepEqual(buildCuratePlan(list, next), { adds: [], removals: [] });
});

test("批量操作不修改传入的对象；空/异常输入不抛", () => {
  const before = { picked: { "deepseek-chat": ["chat"] }, dropped: { "kling-v2": true } };
  const snapshot = JSON.stringify(before);
  buildBulkPick(items(), before, "clear");
  buildBulkPick(items(), before, "select");
  assert.equal(JSON.stringify(before), snapshot, "入参是只读的");
  for (const bad of [null, undefined, "x", 42, [null, 1, { id: "" }]]) {
    assert.deepEqual(buildBulkPick(bad, before, "select"), { picked: { "deepseek-chat": ["chat"] }, dropped: { "kling-v2": true } }, JSON.stringify(bad));
  }
  assert.deepEqual(buildBulkPick(items(), null, "clear", ["kling-v2"]), { picked: {}, dropped: { "kling-v2": true } });
  assert.deepEqual(buildBulkPick(items(), null, "select", []), { picked: {}, dropped: {} }, "空范围不勾任何东西");
  assert.deepEqual(buildBulkPick(items(), before, "select", ["nope"]), { picked: { "deepseek-chat": ["chat"] }, dropped: { "kling-v2": true } }, "范围里有未知 id 不报错");
});

test("同一 id 重复出现只算一次，顺序按清单顺序", () => {
  const dup = [
    { id: "b", suggestedCapabilities: ["chat"] },
    { id: "a", suggestedCapabilities: ["chat"] },
    { id: "b", suggestedCapabilities: ["chat"] },
    { id: "z", suggestedCapabilities: ["chat"], registered: true },
  ];
  const plan = buildCuratePlan(dup, { picked: { a: ["chat"], b: ["chat"] }, dropped: { z: true } });
  assert.deepEqual(plan.adds.map((x) => x.id), ["b", "a"]);
  assert.deepEqual(plan.removals, ["z"]);
});
