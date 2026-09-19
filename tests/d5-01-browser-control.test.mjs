/**
 * D5-01 Closure · 受控 AI 浏览器能力（服务层契约）。
 *
 * 覆盖：显式选择与归属校验、稳定目标绑定、每次执行前重新检查、标签关闭/撤销/登出/切账号后
 * 一律拒绝且**不回落**到其它标签、正文有界且标记不可信、URL 安全与审计去敏、
 * 以及两个新工具契约的副作用声明（导航必须 requiresApproval + CONTROLLED_REVERSIBLE_WRITE）。
 *
 * 说明：本文件是**服务层**证据；产品链路（真实 electron . + 工具门 + 审批）见报告 §3 的实际检查。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { BrowserControlAuthority, safeUrlForAudit, boundedText, MAX_TEXT_CHARS } = require("../electron/browser-control-authority.cjs");
const { ToolRegistry } = require("../electron/tool-registry.cjs");

const USER = "usr_alice";
const entry = (over = {}) => ({
  viewId: "browser#t1",
  windowId: "browser",
  tabId: "t1",
  url: "http://127.0.0.1:5391/form",
  title: "FORM",
  sessionKey: USER,
  alive: true,
  ...over,
});

function fakeController(entries = [entry()]) {
  const calls = [];
  return {
    calls,
    entries,
    inventory: () => entries.filter((e) => e.alive),
    ownerOfView: (viewId) => entries.find((e) => e.viewId === viewId && e.alive) || null,
    readText: async () => "PAGE-TEXT ".repeat(600),
    navigate: (windowId, url, tabId) => {
      calls.push({ windowId, url, tabId });
      return { ok: true };
    },
  };
}
const newAuthority = ({ entries, audits } = {}) => {
  const list = audits || [];
  const a = new BrowserControlAuthority({ clock: () => 1_700_000_000_000, audit: (r) => list.push(r) });
  const controller = fakeController(entries);
  a.attachController(controller);
  a.setSession(USER);
  return { a, controller, audits: list };
};
const select = (a, over = {}) => a.select({ context: { source: "user" }, userId: USER, windowId: "browser", tabId: "t1", ...over });
const read = (a) => a.readPage({ userId: USER, viewId: "browser#t1" });
const nav = (a, url) => a.navigate({ userId: USER, viewId: "browser#t1", url });

test("选择目标：必须是 trusted user + 本人分区 + 存在的标签；模型自报无效", () => {
  const { a } = newAuthority();
  assert.equal(select(a, { context: { source: "agent" } }).error, "BROWSER_CONTROL_FORBIDDEN", "agent 来源不得选择控制目标");
  assert.equal(select(a, { userId: "usr_bob" }).error, "BROWSER_CONTROL_FORBIDDEN", "别人的账号不得选择");
  assert.equal(select(a, { tabId: "t9" }).error, "BROWSER_CONTROL_TARGET_GONE", "不存在的标签不得选择");
  const other = newAuthority({ entries: [entry({ sessionKey: "usr_bob" })] });
  assert.equal(select(other.a).error, "BROWSER_CONTROL_FORBIDDEN", "分区归属不是本人 → 拒绝");
  const ok = select(a);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(a.list({ userId: USER }), [{ viewId: "browser#t1", origin: "http://127.0.0.1:5391/form", selectedAt: 1_700_000_000_000 }]);
});

test("读取：有界正文 + 不可信标记 + 审计去敏；未选择/未授权一律拒绝", async () => {
  const { a, controller, audits } = newAuthority();
  assert.equal((await read(a)).error, "BROWSER_CONTROL_NOT_SELECTED", "未选择目标前不得读取");
  select(a);
  const r = await read(a);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.text.length, MAX_TEXT_CHARS, "正文必须按上限截断");
  assert.equal(r.truncated, true);
  assert.equal(r.untrusted, true, "页面正文必须标记为不可信参考数据");
  assert.equal(r.url.includes("?"), false, "返回/审计的 URL 必须去查询串");
  assert.equal(controller.calls.length, 0, "读取绝不触发导航");
  const last = audits[audits.length - 1];
  assert.equal(last.action, "browser.read_page");
  assert.equal(last.decision, "ALLOW");
  assert.equal(JSON.stringify(last).includes("PAGE-TEXT"), false, "审计不得包含正文");
});

test("导航：只走 http(s)、复用产品策略；失败/未选择不产生动作", async () => {
  const { a, controller, audits } = newAuthority();
  select(a);
  assert.equal((await nav(a, "file:///etc/passwd")).error, "BROWSER_CONTROL_URL_REJECTED");
  assert.equal((await nav(a, "javascript:alert(1)")).error, "BROWSER_CONTROL_URL_REJECTED");
  assert.equal(controller.calls.length, 0, "非法 URL 必须零动作");
  const ok = await nav(a, "http://127.0.0.1:5391/page2");
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(controller.calls, [{ windowId: "browser", url: "http://127.0.0.1:5391/page2", tabId: "t1" }]);
  assert.equal(ok.url, "http://127.0.0.1:5391/page2");
  const denied = audits.filter((x) => x.decision === "DENY");
  assert.ok(denied.length >= 2, "拒绝必须落审计");
});

test("标签关闭/撤销/登出/切账号：旧目标立即失效，且**不回落**到其它标签", async () => {
  const { a, controller, audits } = newAuthority({ entries: [entry(), entry({ viewId: "browser#t2", tabId: "t2", url: "http://127.0.0.1:5391/page2" })] });
  select(a);
  assert.equal((await read(a)).ok, true);
  // 标签关闭（视图被释放）
  controller.entries[0].alive = false;
  const gone = await read(a);
  assert.equal(gone.error, "BROWSER_CONTROL_TARGET_GONE");
  assert.equal(controller.calls.length, 0, "绝不自动转向活动标签");
  // 重新选择后用户撤销
  controller.entries[0].alive = true;
  select(a);
  a.release({ context: { source: "user" }, userId: USER, windowId: "browser", tabId: "t1" });
  assert.equal((await read(a)).error, "BROWSER_CONTROL_NOT_SELECTED");
  // 登出 / 切账号
  select(a);
  a.setSession("usr_bob");
  assert.equal((await read(a)).error, "BROWSER_CONTROL_NOT_SELECTED", "切账号后旧目标必须失效");
  assert.deepEqual(a.list({ userId: USER }), [], "旧账号的目标不得残留");
  assert.ok(audits.some((x) => x.action === "browser.control_released"));
});

test("工具契约：读取是 READ_ONLY；导航是受控副作用（requiresApproval + CONTROLLED_REVERSIBLE_WRITE）", () => {
  const registry = new ToolRegistry();
  const readTool = registry.get("browser.read.page", 1);
  const navTool = registry.get("browser.navigate", 1);
  assert.ok(readTool && navTool, "两个最小浏览器工具必须注册");
  assert.equal(readTool.riskClass, "READ_ONLY");
  assert.equal(readTool.requiresApproval, false);
  assert.equal(navTool.riskClass, "REVERSIBLE_WRITE", "导航不得标成只读");
  assert.equal(navTool.requiresApproval, true, "导航必须走审批");
  assert.equal(navTool.executionPolicy, "CONTROLLED_REVERSIBLE_WRITE", "导航必须走既有副作用契约");
  // 输入面必须是白名单 + 有界（不能出现任意脚本/选择器/动作字段）
  for (const tool of [readTool, navTool]) {
    const props = Object.keys(tool.inputSchema.properties);
    assert.deepEqual(props.sort(), tool.toolId === "browser.navigate" ? ["url", "viewId"] : ["viewId"]);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(props.includes("script"), false);
    assert.equal(props.includes("selector"), false);
  }
});

test("去敏与截断工具函数：URL 去凭据/查询串/片段；正文去控制字符", () => {
  assert.equal(safeUrlForAudit("https://u:p@example.com/a/b?token=SECRET#frag"), "https://example.com/a/b");
  assert.equal(safeUrlForAudit("not a url"), "");
  assert.deepEqual(boundedText("abc", 2), { text: "ab", truncated: true });
  assert.deepEqual(boundedText("a\u0000b", 10), { text: "ab", truncated: false });
});
