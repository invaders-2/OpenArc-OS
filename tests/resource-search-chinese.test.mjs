/** D3-04C · resource-search-chinese.test —— 中文搜索硬验收。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const alice = f.ctx("alice");
const dana = f.ctx("dana");

test("中文 fixture：鞋子 / 详情页 / 生成提示 必须命中", async () => {
  const a = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "鞋子白底图", content: "鞋子白底精修 产品详情页" });
  const b = await f.resourceService.createResource({ context: alice, resourceType: "prompt", name: "视频生成提示词", content: "视频生成工作流 提示" });
  for (const q of ["鞋子", "详情页", "生成提示", "视频生成", "工作流"]) {
    const r = await f.searchService.search({ context: alice, query: q, limit: 10 });
    assert.ok(r.total >= 1, "查询 " + q + " 应命中，实际 " + r.total);
  }
});

test("中文长句与专有名词：羌族服饰云纹刺绣 / 本地资源库权限", async () => {
  await f.resourceService.createResource({ context: alice, resourceType: "memory", name: "设计灵感", content: "羌族服饰云纹刺绣 纹样" });
  await f.resourceService.createResource({ context: alice, resourceType: "memory", name: "权限笔记", content: "本地资源库权限模型" });
  assert.equal((await f.searchService.search({ context: alice, query: "云纹刺绣", limit: 5 })).total, 1);
  assert.equal((await f.searchService.search({ context: alice, query: "资源库权限", limit: 5 })).total, 1);
});

test("中文搜索不泄漏无权资源（Personal Memory 隐私）", async () => {
  await f.resourceService.createResource({ context: alice, resourceType: "memory", name: "私人", content: "明年新品内部代号 Aurora" });
  const own = await f.searchService.search({ context: alice, query: "Aurora", limit: 5 });
  assert.equal(own.total, 1);
  const other = await f.searchService.search({ context: dana, query: "Aurora", limit: 5 });
  assert.equal(other.total, 0);
  assert.equal(JSON.stringify(other).includes("Aurora"), false);
});
