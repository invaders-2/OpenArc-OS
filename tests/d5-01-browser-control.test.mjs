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

/**
 * 假控制器：只提供受控浏览器能力真正使用的那几个方法，模拟真实控制器的**派发三态**语义
 * （真实实现见 electron/native-view-controller.cjs 的 #trackDispatch / waitForDispatch / dispatchEvidence）。
 *
 * `commitMode` 是导航结果的注入点：
 *   · "applied"      这次派发的加载真的完成；
 *   · "redirect"     完成但落在别的地址（服务器 302）；
 *   · "notapplied"   这次加载被中止，且当前地址不是目标 → 能证明没生效；
 *   · "unconfirmed"  等不到落地 → **不可知**；
 *   · "foreign"      **用户自己**导航到了同一个地址，而这次加载被中止 → 地址相等但不可归因。
 */
function fakeController(entries = [entry()], { commitMode = "applied", body = null } = {}) {
  const calls = [];
  const ledger = new Map();
  let seq = 0;
  let pending = null;
  return {
    calls,
    entries,
    ledger,
    inventory: () => entries.filter((e) => e.alive),
    ownerOfView: (viewId) => entries.find((e) => e.viewId === viewId && e.alive) || null,
    readText: async () => (body == null ? "PAGE-TEXT ".repeat(600) : body),
    liveUrl: (viewId) => { const e = entries.find((x) => x.viewId === viewId); return e && e.alive ? e.url : null; },
    navigate: (windowId, url, tabId) => {
      calls.push({ windowId, url, tabId });
      const e = entries.find((x) => x.viewId === windowId + "#" + tabId);
      seq += 1;
      const ev = { seq, viewId: windowId + "#" + tabId, requested: String(url), from: e ? String(e.url) : "", at: 1, started: { url: String(url), at: 1 }, commitments: [], loaded: null, loadError: null, superseded: false };
      ledger.set(ev.viewId + "#" + seq, ev);
      pending = { seq, viewId: ev.viewId, requested: String(url), ev };
      return { ok: true, seq };
    },
    async waitForDispatch(viewId, _opts = {}) {
      if (!pending || pending.viewId !== String(viewId)) return { verdict: "INDETERMINATE", reason: "NO_DISPATCH" };
      const { seq: s, requested, ev } = pending;
      const e = entries.find((x) => x.viewId === viewId);
      if (commitMode === "notapplied") { ev.loadError = "ERR_ABORTED"; return { verdict: "NOT_APPLIED", seq: s, reason: "ERR_ABORTED", requested }; }
      if (commitMode === "unconfirmed") return { verdict: "INDETERMINATE", seq: s, reason: "DISPATCH_UNCONFIRMED", requested };
      if (commitMode === "foreign") { ev.loadError = "ERR_ABORTED"; if (e) e.url = requested; return { verdict: "INDETERMINATE", seq: s, reason: "ABORTED:ERR_ABORTED", requested }; }
      const finalUrl = commitMode === "redirect" ? requested.replace(/\/page2$/, "/page3") : requested;
      if (e) e.url = finalUrl;
      ev.loaded = { at: 2, url: finalUrl };
      return { verdict: "APPLIED", seq: s, url: finalUrl, requested, from: ev.from, redirected: finalUrl !== requested, noop: finalUrl === ev.from };
    },
    dispatchEvidence(viewId) {
      let latest = null;
      for (const ev of ledger.values()) if (ev.viewId === String(viewId)) latest = ev;
      return latest ? { ...latest } : null;
    },
  };
}
const newAuthority = ({ entries, audits, commitMode, body } = {}) => {
  // 注意：CommitMode 语义见 fakeController 注释（D5-01 Closure-3 起为派发三态）。
  const list = audits || [];
  const a = new BrowserControlAuthority({ clock: () => 1_700_000_000_000, audit: (r) => list.push(r) });
  const controller = fakeController(entries, { commitMode, body });
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

test("目标解析：显式 viewId 必须在授权表内；缺省只有唯一目标才可推断；多目标明确拒绝", () => {
  const { a } = newAuthority({ entries: [entry(), entry({ viewId: "browser#t2", tabId: "t2" })] });
  // 未授权前：模型给什么 viewId 都不成立
  assert.equal(a.resolveTarget({ userId: USER, viewId: "browser#t1" }).error, "BROWSER_CONTROL_NOT_SELECTED", "未授权目标不得被解析");
  assert.equal(a.resolveTarget({ userId: USER }).error, "BROWSER_CONTROL_NOT_SELECTED", "一个都没授权 → 拒绝");
  select(a);
  assert.equal(a.resolveTarget({ userId: USER, viewId: "browser#t2" }).error, "BROWSER_CONTROL_NOT_SELECTED", "只有 t1 被授权，t2 不得被推断");
  assert.deepEqual(a.resolveTarget({ userId: USER }), { ok: true, viewId: "browser#t1" }, "恰好一个已授权目标可推断");
  select(a, { tabId: "t2" });
  assert.equal(a.resolveTarget({ userId: USER }).error, "BROWSER_CONTROL_TARGET_AMBIGUOUS", "多个目标必须显式指定，绝不猜");
  assert.deepEqual(a.resolveTarget({ userId: USER, viewId: "browser#t2" }), { ok: true, viewId: "browser#t2" });
  // 生命周期收尾：标签真的没了就从授权表摘掉（不改绑、不残留）
  a.controller.entries[1].alive = false;
  assert.equal(a.pruneDead(), 1);
  assert.deepEqual(a.list({ userId: USER }).map((t) => t.viewId), ["browser#t1"]);
});

test("导航三态：本次落地 / 302 / 能证明未生效 / 不可知 —— 一律不以'当前 URL 相等'当作成功依据", async () => {
  const ok = newAuthority();
  select(ok.a);
  const r = await nav(ok.a, "http://127.0.0.1:5391/page2");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.url, "http://127.0.0.1:5391/page2", "url = 这次派发真实落地的地址");
  assert.equal(r.redirected, false);
  assert.equal(r.requested, "http://127.0.0.1:5391/page2");
  assert.ok(Number.isInteger(r.dispatchSeq), "必须带派发序号（归因证据）");

  const redir = newAuthority({ commitMode: "redirect" });
  select(redir.a);
  const rr = await nav(redir.a, "http://127.0.0.1:5391/page2");
  assert.equal(rr.ok, true, JSON.stringify(rr));
  assert.equal(rr.redirected, true, "服务器跳转必须如实标记，绝不假装去了批准的那个地址");
  assert.equal(rr.url, "http://127.0.0.1:5391/page3");
  assert.equal(rr.requested, "http://127.0.0.1:5391/page2");

  // 能证明没生效：这次加载被中止，且当前真实地址不是目标 → NOT_APPLIED（可判 FAILED，0 重试）。
  const na = newAuthority({ commitMode: "notapplied" });
  select(na.a);
  const notApplied = await nav(na.a, "http://127.0.0.1:5391/page2");
  assert.equal(notApplied.ok, false);
  assert.equal(notApplied.error, "BROWSER_CONTROL_NAVIGATE_NOT_APPLIED");
  assert.equal(notApplied.notApplied, true);
  assert.equal(notApplied.dispatched, true);

  // 等不到落地 → 不可知（不是"未执行"）。
  const bad = newAuthority({ commitMode: "unconfirmed" });
  select(bad.a);
  const un = await nav(bad.a, "http://127.0.0.1:5391/page2");
  assert.equal(un.ok, false);
  assert.equal(un.error, "BROWSER_CONTROL_NAVIGATE_UNCONFIRMED");
  assert.equal(un.dispatched, true, "请求已发出但没落地 = 结果不可知（不是'未执行'）");
  assert.equal(un.notApplied, undefined, "不可知绝不能被当成'没生效'");
  assert.ok(bad.audits.some((x) => x.action === "browser.navigate" && x.decision === "DENY"));
});

test("归因：用户自己导航到同一地址时，地址相等也不算本次成功（凭派发证据判不可知）", async () => {
  const s = newAuthority({ commitMode: "foreign" });
  select(s.a);
  const r = await nav(s.a, "http://127.0.0.1:5391/page2");
  assert.equal(r.ok, false, "地址恰好等于目标也不能算成功：" + JSON.stringify(r));
  assert.equal(r.error, "BROWSER_CONTROL_NAVIGATE_UNCONFIRMED");
  assert.equal(String(s.controller.liveUrl("browser#t1")), "http://127.0.0.1:5391/page2", "页面确实停在目标地址（但那是用户的导航）");
  // 证据账本里这次派发只有"被中止"，没有 loaded → 任何下游都不得据此声称生效。
  const ev = s.a.dispatchEvidence({ viewId: "browser#t1", seq: r.dispatchSeq });
  assert.ok(ev, "必须留下派发证据");
  assert.equal(ev.loaded, null);
  assert.equal(ev.loadError, "ERR_ABORTED");
});

test("inspect：只读目标现状（含 URL），未授权/失效一律拒绝且不含正文", () => {
  const { a } = newAuthority();
  assert.equal(a.inspect({ userId: USER, viewId: "browser#t1" }).error, "BROWSER_CONTROL_NOT_SELECTED");
  select(a);
  const st = a.inspect({ userId: USER, viewId: "browser#t1" });
  assert.equal(st.ok, true);
  assert.equal(st.url, "http://127.0.0.1:5391/form");
  assert.equal("text" in st, false, "现状投影绝不带正文");
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
  // 读取的 viewId 允许缺省（由后端在**已授权目标**里解析）；导航的 url 在工具门就收窄到 http(s) 且不含凭据。
  assert.deepEqual(readTool.inputSchema.required, []);
  assert.deepEqual(navTool.inputSchema.required, ["url"]);
  const registry2 = new ToolRegistry();
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "https://u:p@example.com/x", "http://a b/"]) {
    assert.equal(registry2.validateInput(navTool, { url: bad }).ok, false, "工具门必须拒绝 " + bad);
  }
  for (const good of ["http://127.0.0.1:5391/page2", "https://example.com/a?b=c#d", "http://[::1]:8080/x"]) {
    assert.equal(registry2.validateInput(navTool, { url: good }).ok, true, "工具门必须接受 " + good);
  }
});

test("去敏与截断工具函数：URL 去凭据/查询串/片段；正文去控制字符", () => {
  assert.equal(safeUrlForAudit("https://u:p@example.com/a/b?token=SECRET#frag"), "https://example.com/a/b");
  assert.equal(safeUrlForAudit("not a url"), "");
  assert.deepEqual(boundedText("abc", 2), { text: "ab", truncated: true });
  assert.deepEqual(boundedText("a\u0000b", 10), { text: "ab", truncated: false });
});
