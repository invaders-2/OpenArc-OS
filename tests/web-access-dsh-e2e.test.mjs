/** 全局 AI 联网 E2E：真实 dsh → Tool Facade → ControlledToolProxy → WebAccess → 结果回模型 → 续推理。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";
const require = createRequire(import.meta.url);
const { createWebAccess, SEARCH_PROVIDERS } = require("../electron/web-access.cjs");

const QUERY = "OPENARC_WEB_QUERY";
const PAGE = "https://news.example.com/story";
const PAGE_TEXT = "OPENARC_WEB_PAGE_BODY";

function fakeWeb() {
  const calls = [];
  const routes = {
    [SEARCH_PROVIDERS[0].url(QUERY)]: `<li class="b_algo"><h2><a href="${PAGE}">Story</a></h2><p>OPENARC_WEB_SNIPPET</p></li>`,
    [PAGE]: `<html><head><title>Story</title></head><body><p>${PAGE_TEXT}</p></body></html>`,
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method });
    return url in routes ? new Response(routes[url], { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }) : new Response("nope", { status: 404 });
  };
  const svc = createWebAccess({ getFetch: () => fetchImpl, lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
  return { svc, calls };
}

test("dsh 真实工具循环：web_search → web_fetch → 结果回模型 → 任务成功，执行记录齐全", async () => {
  const web = fakeWeb();
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", webAccess: web.svc });
  try {
    fx.grantTool("ai", ["tool.web.search", "tool.web.fetch"]);
    fx.fp.state.toolLoopPlan = [
      { id: "call_web_1", name: "web_search", args: { query: QUERY, limit: 3 } },
      { id: "call_web_2", name: "web_fetch", args: { url: PAGE } },
    ];
    const t = fx.createTask();
    const orch = fx.makeDshOrchestrator({ memoryContext: null });
    const r = await orch.runTask({ context: fx.ctx(), taskId: t.task.taskId, expectedRevision: t.task.revision, verify: { type: "EXACT_TEXT", expected: "OPENARC_DSH_TOOL_OK" } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.task.status, "SUCCEEDED");
    assert.deepEqual(fx.fp.state.toolCalls, ["web_search", "web_fetch"]);
    assert.ok(fx.fp.state.toolLoop.toolNames.includes("web_search") && fx.fp.state.toolLoop.toolNames.includes("web_fetch"));
    assert.deepEqual(web.calls.map((c) => c.url), [SEARCH_PROVIDERS[0].url(QUERY), PAGE]);
    assert.ok(web.calls.every((c) => c.method === "GET"));
    const bodies = fx.fp.state.toolLoopBodies.join("\n");
    assert.match(bodies, /OPENARC_WEB_SNIPPET/, "搜索结果回到模型");
    assert.match(bodies, new RegExp(PAGE_TEXT), "网页正文回到模型");
    assert.match(bodies, /web_search and web_fetch/, "提示词告诉模型可以联网");
    const execs = fx.toolStore.executionsOfTask(t.task.taskId);
    assert.equal(execs.length, 2);
    assert.ok(execs.every((e) => e.status === "SUCCEEDED" && e.verification_status === "PASS"), JSON.stringify(execs));
    assert.deepEqual(execs.map((e) => e.tool_id).sort(), ["web.fetch", "web.search"]);
  } finally { await fx.close(); }
});

test("没有授予联网权限时，工具被拒绝且不发出任何请求", async () => {
  const web = fakeWeb();
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", webAccess: web.svc });
  try {
    fx.fp.state.toolLoopPlan = [{ id: "call_web_1", name: "web_search", args: { query: QUERY } }];
    const t = fx.createTask();
    const orch = fx.makeDshOrchestrator({ memoryContext: null });
    await orch.runTask({ context: fx.ctx(), taskId: t.task.taskId, expectedRevision: t.task.revision });
    assert.equal(web.calls.length, 0);
    const decs = fx.toolStore.decisionsOfTask(t.task.taskId);
    assert.ok(decs.length >= 1 && decs.every((d) => d.decision !== "ALLOWED"), JSON.stringify(decs.map((d) => [d.decision, d.reason_code])));
  } finally { await fx.close(); }
});

test("联网过程给界面：运行中推「正在搜索 / 已搜索」，结束后落库搜索词、结果和读过的网页（不含正文）", async () => {
  const web = fakeWeb();
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", webAccess: web.svc });
  try {
    fx.grantTool("ai", ["tool.web.search", "tool.web.fetch"]);
    fx.fp.state.toolLoopPlan = [
      { id: "call_web_1", name: "web_search", args: { query: QUERY, limit: 3 } },
      { id: "call_web_2", name: "web_fetch", args: { url: PAGE } },
    ];
    const t = fx.createTask();
    const orch = fx.makeDshOrchestrator({ memoryContext: null });
    const pushed = [];
    orch.setProgressSink((taskId, u) => { if (u.kind === "web") pushed.push({ taskId, ...u.activity }); });
    const r = await orch.runTask({ context: fx.ctx(), taskId: t.task.taskId, expectedRevision: t.task.revision });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(pushed.map((p) => p.kind + ":" + p.phase), ["search:start", "search:done", "fetch:start", "fetch:done"]);
    assert.ok(pushed.every((p) => p.taskId === t.task.taskId));
    assert.equal(pushed[0].query, QUERY);
    const ev = fx.taskService.getEvents({ context: fx.ctx(), taskId: t.task.taskId });
    assert.equal(ev.ok, true);
    const webEvents = ev.items.filter((e) => e.eventType === "harness.web_activity").map((e) => e.safePayload);
    assert.equal(webEvents.length, 2, JSON.stringify(ev.items.map((e) => e.eventType)));
    const [s, f] = webEvents;
    assert.equal(s.kind, "search"); assert.equal(s.query, QUERY); assert.equal(s.ok, true);
    assert.deepEqual(s.results.map((x) => x.url), [PAGE]);
    assert.equal(s.results[0].title, "Story");
    assert.equal(f.kind, "fetch"); assert.equal(f.url, PAGE); assert.equal(f.title, "Story");
    assert.doesNotMatch(JSON.stringify(webEvents), new RegExp(PAGE_TEXT), "网页正文不落库");
  } finally { await fx.close(); }
});
