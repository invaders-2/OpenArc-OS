/**
 * P1+ · IPC 脱敏深度可配置回归（electron/dxos-foundation-errors.cjs）。
 *
 * task-3 要求：redactValue 深度上限从写死 6 改为可配置且默认 ≥24；
 * 秘密键脱敏 / 循环引用 / 数组 100 项截断行为保持不变。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const errors = require("../electron/dxos-foundation-errors.cjs");

afterEach(() => { errors.resetRedactionForTests(); });

/** 构造 depth 层嵌套对象，返回 { root, leaf }。 */
function nested(depth) {
  const root = { level: 0 };
  let cursor = root;
  for (let index = 1; index <= depth; index += 1) {
    cursor.next = { level: index };
    cursor = cursor.next;
  }
  return { root, leaf: cursor };
}

function chainLength(value) {
  let count = 0;
  let cursor = value;
  while (cursor && cursor.next && typeof cursor.next === "object") {
    count += 1;
    cursor = cursor.next;
  }
  return { count, leaf: cursor };
}

test("默认深度 ≥24：20 层嵌套对象不被 <max-depth> 截断，叶子值保留", () => {
  assert.ok(errors.DEFAULT_REDACT_MAX_DEPTH >= 24, "默认上限必须 ≥24");
  const { root, leaf } = nested(20);
  const redacted = errors.redactValue(root);
  const { count, leaf: outputLeaf } = chainLength(redacted);
  assert.equal(count, 20);
  assert.deepEqual(outputLeaf, leaf);
  assert.ok(!JSON.stringify(redacted).includes("<max-depth>"));
});

test("默认深度边界：超过 24 层的部分折叠为 <max-depth>，之前层级完整", () => {
  const { root } = nested(30);
  const redacted = errors.redactValue(root);
  assert.equal(redacted.level, 0);
  // depth 0..23 是 24 层对象；第 24 层（depth 24）的值被折叠。
  let cursor = redacted;
  let objects = 0;
  while (cursor && typeof cursor === "object") { objects += 1; cursor = cursor.next; }
  assert.equal(objects, errors.DEFAULT_REDACT_MAX_DEPTH);
  assert.equal(cursor, "<max-depth>");
});

test("可配置：configureRedaction({ maxDepth }) 同时影响默认调用，非法值回落默认 24", () => {
  assert.deepEqual(errors.configureRedaction({ maxDepth: 8 }), { maxDepth: 8 });
  const { root } = nested(12);
  assert.ok(JSON.stringify(errors.redactValue(root)).includes("<max-depth>"), "超过 8 层必须折叠");

  for (const invalid of [0, -3, 1.5, "nope", null]) {
    assert.deepEqual(errors.configureRedaction({ maxDepth: invalid }), { maxDepth: errors.DEFAULT_REDACT_MAX_DEPTH }, String(invalid));
  }
  assert.deepEqual(errors.resetRedactionForTests(), { maxDepth: errors.DEFAULT_REDACT_MAX_DEPTH });
  assert.ok(!JSON.stringify(errors.redactValue(nested(20).root)).includes("<max-depth>"), "reset 后恢复默认 24");
});

test("按次覆盖：redactValue(value, { maxDepth }) 不改变进程级配置", () => {
  const { root } = nested(12);
  const truncated = errors.redactValue(root, { maxDepth: 4 });
  assert.ok(JSON.stringify(truncated).includes("<max-depth>"));
  const kept = errors.redactValue(root, { maxDepth: 30 });
  assert.ok(!JSON.stringify(kept).includes("<max-depth>"));
  assert.deepEqual(errors.configureRedaction(), { maxDepth: errors.DEFAULT_REDACT_MAX_DEPTH }, "按次覆盖不得写回进程级配置");
});

test("秘密键在任何深度仍按字段名掩码（不因深度放宽而泄漏）", () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: { h: { apiKey: "sk-live-abcd1234" } } } } } } } } };
  const redacted = errors.redactValue(deep);
  assert.equal(redacted.a.b.c.d.e.f.g.h.apiKey, "****1234");
  assert.ok(!JSON.stringify(redacted).includes("sk-live-abcd1234"));

  const provider = { id: "p1", apiKey: "abcd1234", headers: { Authorization: "Bearer abcdefghij" }, note: "ok" };
  assert.deepEqual(errors.redactValue(provider), { id: "p1", apiKey: "****1234", headers: { Authorization: "****ghij" }, note: "ok" });
});

test("循环引用 / 数组 100 项截断 / 绝对路径替换保持既有行为", () => {
  const circular = { id: "c1" };
  circular.self = circular;
  assert.deepEqual(errors.redactValue(circular), { id: "c1", self: "<circular>" });

  const array = errors.redactValue(Array.from({ length: 130 }, (_, index) => index));
  assert.equal(array.length, 100);
  assert.equal(array[99], 99);

  // 绝对路径在深层文本里同样替换（redactText 行为不变）。
  const { root } = nested(10);
  let cursor = root;
  for (let index = 1; index <= 10; index += 1) cursor = cursor.next;
  cursor.path = "/Users/someone/private/secret.txt";
  assert.equal(errors.redactValue(root).level, 0);
  assert.ok(!JSON.stringify(errors.redactValue(root)).includes("/Users/"));
});

test("toIpcResult / normalizeError 走默认深度：12 层 detail 不再被旧上限 6 截断", async () => {
  const { root, leaf } = nested(12);
  const ok = await errors.toIpcResult(() => root);
  assert.equal(ok.ok, true);
  assert.deepEqual(chainLength(ok.value).leaf, leaf);

  const failed = await errors.toIpcResult(() => { throw errors.createDxosError(errors.DXOS_ERR_INVALID_INPUT, "参数无效", root); });
  assert.equal(failed.ok, false);
  const detailLeaf = chainLength(failed.detail).leaf;
  assert.deepEqual(detailLeaf, leaf);
  assert.ok(!JSON.stringify(failed.detail).includes("<max-depth>"));
});
