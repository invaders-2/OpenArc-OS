/** D3-04C · resource-search-injection.test —— FTS 特殊输入 / 长度边界 / 不绕过滤。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const alice = f.ctx("alice");
const dana = f.ctx("dana");

test("FTS 特殊字符不崩溃、不绕过滤", async () => {
  await f.resourceService.createResource({ context: alice, resourceType: "text", name: "InjectBase", content: "base token" });
  const queries = ['"', "'", "*", "NEAR", "OR", "(a)", "a - b", "**", "AND", "NOT", "^", "a:b", "{x}", '""', "or or or"];
  for (const q of queries) {
    let res;
    try {
      res = await f.searchService.search({ context: alice, query: q, limit: 5 });
    } catch (e) {
      assert.fail("查询 " + JSON.stringify(q) + " 抛出异常：" + e.message);
    }
    assert.ok(res && (res.ok === true || typeof res.error === "string"), "查询 " + JSON.stringify(q) + " 应有结构化结果");
  }
});

test("超长 query -> QUERY_TOO_LONG；空 query -> QUERY_EMPTY", async () => {
  const long = "a".repeat(300);
  const tooLong = await f.searchService.search({ context: alice, query: long, limit: 5 });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.error, "QUERY_TOO_LONG");
  const empty = await f.searchService.search({ context: alice, query: "   ", limit: 5 });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, "QUERY_EMPTY");
});

test("注入尝试不能绕过授权：dana 用操作符搜 alice secret -> 0", async () => {
  await f.resourceService.createResource({ context: alice, resourceType: "memory", name: "InjectionSecret", content: "injectionsecret-token" });
  for (const q of ['injectionsecret-token OR *', "injectionsecret-token*", '"injectionsecret-token"', "NEAR/2 injectionsecret"]) {
    const res = await f.searchService.search({ context: dana, query: q, limit: 10 });
    assert.equal(res.total || 0, 0, "dana 用 " + q + " 不得命中");
  }
});
