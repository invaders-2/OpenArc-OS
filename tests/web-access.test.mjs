/** 全局 AI 联网：web.search / web.fetch 的服务、SSRF 防护、工具注册与适配器。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const web = require("../electron/web-access.cjs");
const { ToolRegistry, buildBridgeManifest } = require("../electron/tool-registry.cjs");
const { createToolAdapters } = require("../electron/tool-adapters.cjs");
const { READ_TOOL_IDS, WRITE_TOOL_IDS, FORBIDDEN_HARNESS_TOOLS } = require("../electron/dsh-tool-profile.cjs");
const authz = require("../electron/authorization-domain.cjs");
const { BUILTIN_APP_PERMISSIONS } = require("../electron/builtin-app-grants.cjs");

const PUBLIC_IP = "93.184.216.34";

/** 假网络：按完整 URL 返回预设响应；记录每次请求。 */
function fakeNet(routes, { dns = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    if (typeof route === "function") return route(url, init);
    const { status = 200, headers = {}, body = "" } = route;
    return new Response(body, { status, headers });
  };
  const lookup = async (host) => {
    if (host in dns) { const v = dns[host]; if (v instanceof Error) throw v; return v.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })); }
    return [{ address: PUBLIC_IP, family: 4 }];
  };
  return { calls, fetchImpl, lookup };
}

function make(routes, opts = {}) {
  const net = fakeNet(routes, opts);
  const svc = web.createWebAccess({ getFetch: () => net.fetchImpl, lookup: net.lookup, ...(opts.svc || {}) });
  return { svc, net };
}

const BING_HTML = `<html><body><ol id="b_results">
<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&&p=abc&u=a1${Buffer.from("https://news.example.com/a?x=1").toString("base64url")}&ntb=1">Example &amp; News</a></h2><div class="b_caption"><p>First <strong>snippet</strong> text</p></div></li>
<li class="b_algo"><h2><a href="https://docs.example.org/b">Docs B</a></h2><p>Second snippet</p></li>
<li class="b_algo"><h2><a href="https://docs.example.org/b">Docs B dup</a></h2><p>dup</p></li>
<li class="b_algo"><h2><a href="javascript:alert(1)">bad</a></h2></li>
</ol></body></html>`;

const DDG_HTML = `<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://ddg.example.net/page")}&amp;rut=x">DDG Title</a>
<a class="result__snippet" href="#">DDG <b>snippet</b></a></div>
<div class="result"><a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>`;

test("HTML → 文本：去脚本 / 样式 / 导航，解码实体，保留段落", () => {
  const html = `<html><head><title>T &amp; Co</title><style>.a{}</style><script>evil()</script></head><body><nav>menu</nav><h1>Head</h1><p>Hello&nbsp;world &#20320;&#x597d;</p><ul><li>one</li><li>two</li></ul><footer>foot</footer></body></html>`;
  assert.equal(web.htmlTitle(html), "T & Co");
  const text = web.htmlToText(html);
  assert.match(text, /Head/);
  assert.match(text, /Hello world 你好/);
  assert.match(text, /• one\n• two/);
  assert.doesNotMatch(text, /evil|menu|foot|\.a\{\}/);
});

test("HTML → 文本：有足够长的 <article> 时只取正文", () => {
  const body = "正文内容。".repeat(120);
  const text = web.htmlToText(`<body><div>sidebar junk</div><article><p>${body}</p></article></body>`);
  assert.doesNotMatch(text, /sidebar/);
  assert.match(text, /正文内容/);
});

test("字符集：按 header / meta 解码 GBK", () => {
  const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]); // “你好”
  assert.equal(web.decodeBody(gbk, "text/html; charset=gbk"), "你好");
  const withMeta = Buffer.concat([Buffer.from('<meta charset="gb2312">'), gbk]);
  assert.match(web.decodeBody(withMeta, "text/html"), /你好/);
});

test("搜索结果解析：Bing 解跳转链接、去重、丢掉非 http；DuckDuckGo 解 uddg、丢广告", () => {
  const bing = web.parseBing(BING_HTML);
  assert.equal(bing[0].url, "https://news.example.com/a?x=1");
  assert.equal(bing[0].title, "Example & News");
  assert.equal(bing[0].snippet, "First snippet text");
  assert.equal(bing.filter((r) => r.url === "https://docs.example.org/b").length, 2, "解析层不去重，服务层去重");
  assert.ok(bing.every((r) => /^https?:/.test(r.url)));
  const ddg = web.parseDuckDuckGo(DDG_HTML);
  assert.deepEqual(ddg, [{ title: "DDG Title", url: "https://ddg.example.net/page", snippet: "DDG snippet" }]);
});

test("search：Bing 成功即返回；结果去重并按 limit 截断，标注 untrusted", async () => {
  const q = "openarc 新闻";
  const bingUrl = web.SEARCH_PROVIDERS[0].url(q);
  const { svc, net } = make({ [bingUrl]: { body: BING_HTML, headers: { "content-type": "text/html; charset=utf-8" } } });
  const res = await svc.search({ query: q, limit: 5 });
  assert.equal(res.ok, true);
  assert.equal(res.result.provider, "bing");
  assert.equal(res.result.untrusted, true);
  assert.deepEqual(res.result.results.map((r) => r.url), ["https://news.example.com/a?x=1", "https://docs.example.org/b"]);
  assert.equal(net.calls.length, 1);
  assert.equal(net.calls[0].init.method, "GET");
  assert.equal(net.calls[0].init.redirect, "manual");
  assert.equal(net.calls[0].init.credentials, "omit");
});

test("search：Bing 失败 / 无结果时退到 DuckDuckGo；都失败时给出明确错误码", async () => {
  const q = "fallback";
  const [bing, ddg] = web.SEARCH_PROVIDERS.map((p) => p.url(q));
  const a = make({ [bing]: { status: 503 }, [ddg]: { body: DDG_HTML, headers: { "content-type": "text/html" } } });
  const ok = await a.svc.search({ query: q });
  assert.equal(ok.ok, true);
  assert.equal(ok.result.provider, "duckduckgo");
  const b = make({ [bing]: { body: "<html></html>", headers: { "content-type": "text/html" } }, [ddg]: { body: "<html></html>", headers: { "content-type": "text/html" } } });
  assert.equal((await b.svc.search({ query: q })).error, web.WEB_ERROR.NO_RESULTS);
  const c = make({});
  assert.equal((await c.svc.search({ query: q })).error, web.WEB_ERROR.UNAVAILABLE);
  assert.equal((await c.svc.search({ query: "   " })).ok, false);
});

test("fetch：返回正文 / 标题 / 最终地址，按 maxChars 截断", async () => {
  const long = "<p>" + "段落文字".repeat(400) + "</p>";
  const { svc } = make({ "https://site.example.com/post": { body: `<html><head><title>Post</title></head><body>${long}</body></html>`, headers: { "content-type": "text/html; charset=utf-8" } } });
  const res = await svc.fetch({ url: "https://site.example.com/post#frag", maxChars: 500 });
  assert.equal(res.ok, true);
  assert.equal(res.result.title, "Post");
  assert.equal(res.result.finalUrl, "https://site.example.com/post");
  assert.equal(res.result.text.length, 500);
  assert.equal(res.result.truncated, true);
  assert.equal(res.result.untrusted, true);
});

test("fetch：手动跟随重定向，每一跳都重新校验；跳到内网 / 元数据地址直接拒绝", async () => {
  const { svc, net } = make({
    "https://a.example.com/": { status: 302, headers: { location: "/next" } },
    "https://a.example.com/next": { status: 301, headers: { location: "https://b.example.com/final" } },
    "https://b.example.com/final": { body: "plain ok", headers: { "content-type": "text/plain" } },
    "https://evil.example.com/": { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } },
    "https://evil2.example.com/": { status: 302, headers: { location: "http://localhost:8080/admin" } },
  });
  const ok = await svc.fetch({ url: "https://a.example.com/" });
  assert.equal(ok.ok, true);
  assert.equal(ok.result.finalUrl, "https://b.example.com/final");
  assert.equal(ok.result.text, "plain ok");
  for (const u of ["https://evil.example.com/", "https://evil2.example.com/"]) {
    const res = await svc.fetch({ url: u });
    assert.equal(res.ok, false);
    assert.equal(res.error, web.WEB_ERROR.BLOCKED_HOST);
  }
  assert.ok(!net.calls.some((c) => /169\.254|localhost/.test(c.url)), "被拒的地址绝不发出请求");
});

test("fetch：拒绝私网 / 回环 / 凭据 / 非 http，以及解析到私网的域名", async () => {
  const { svc, net } = make({}, { dns: { "intranet.example.com": ["10.1.2.3"], "v6.example.com": ["::ffff:127.0.0.1"], "nx.example.com": new Error("ENOTFOUND") } });
  const cases = [
    ["http://127.0.0.1/", web.WEB_ERROR.BLOCKED_HOST],
    ["http://192.168.1.1/", web.WEB_ERROR.BLOCKED_HOST],
    ["http://[::1]/", web.WEB_ERROR.BLOCKED_HOST],
    ["http://metadata.google.internal/", web.WEB_ERROR.BLOCKED_HOST],
    ["https://user:pw@example.com/", web.WEB_ERROR.INVALID_URL],
    ["file:///etc/passwd", web.WEB_ERROR.INVALID_URL],
    ["https://intranet.example.com/", web.WEB_ERROR.BLOCKED_HOST],
    ["https://v6.example.com/", web.WEB_ERROR.BLOCKED_HOST],
    ["https://nx.example.com/", web.WEB_ERROR.DNS_FAILED],
  ];
  for (const [url, code] of cases) {
    const res = await svc.fetch({ url });
    assert.equal(res.ok, false, url);
    assert.equal(res.error, code, url);
  }
  assert.equal(net.calls.length, 0);
});

test("fetch：经代理出网时本地 DNS 失败放行，但解析到私网仍拒绝", async () => {
  const net = fakeNet({ "https://nx.example.com/": { body: "via proxy", headers: { "content-type": "text/plain" } } }, { dns: { "nx.example.com": new Error("ENOTFOUND"), "intranet.example.com": ["10.0.0.1"] } });
  const svc = web.createWebAccess({ getFetch: () => net.fetchImpl, lookup: net.lookup, isProxied: () => true });
  assert.equal((await svc.fetch({ url: "https://nx.example.com/" })).ok, true);
  assert.equal((await svc.fetch({ url: "https://intranet.example.com/" })).error, web.WEB_ERROR.BLOCKED_HOST);
});

test("fetch：重定向次数、非文本类型、HTTP 错误、超大正文都有上限", async () => {
  const loop = {};
  for (let i = 0; i < 10; i += 1) loop["https://loop.example.com/" + i] = { status: 302, headers: { location: "/" + (i + 1) } };
  const big = "x".repeat(5000);
  const { svc } = make({
    ...loop,
    "https://img.example.com/a.png": { body: "PNG", headers: { "content-type": "image/png" } },
    "https://err.example.com/": { status: 500, body: "boom", headers: { "content-type": "text/plain" } },
    "https://big.example.com/": { body: big, headers: { "content-type": "text/plain" } },
  }, { svc: { maxBytes: 1000 } });
  assert.equal((await svc.fetch({ url: "https://loop.example.com/0" })).error, web.WEB_ERROR.TOO_MANY_REDIRECTS);
  assert.equal((await svc.fetch({ url: "https://img.example.com/a.png" })).error, web.WEB_ERROR.UNSUPPORTED_CONTENT);
  assert.equal((await svc.fetch({ url: "https://err.example.com/" })).error, web.WEB_ERROR.HTTP_ERROR);
  const b = await svc.fetch({ url: "https://big.example.com/" });
  assert.equal(b.ok, true);
  assert.equal(b.result.text.length, 1000);
  assert.equal(b.result.truncated, true);
});

test("fetch：超时与取消", async () => {
  const hang = (_url, init) => new Promise((_, reject) => { init.signal.addEventListener("abort", () => reject(new Error("aborted"))); });
  const { svc } = make({ "https://slow.example.com/": hang }, { svc: { timeoutMs: 600 } });
  assert.equal((await svc.fetch({ url: "https://slow.example.com/" })).error, web.WEB_ERROR.TIMEOUT);
  const ac = new AbortController();
  const p = svc.fetch({ url: "https://slow.example.com/", signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  assert.equal((await p).error, web.WEB_ERROR.CANCELLED);
});

test("工具注册：web.search / web.fetch 是只读、免审批、走 WebAccess，并在 Harness 可见面里", () => {
  const reg = new ToolRegistry();
  for (const id of ["web.search", "web.fetch"]) {
    const r = reg.resolve(id, 1);
    assert.equal(r.ok, true, id);
    assert.equal(r.contract.riskClass, "READ_ONLY");
    assert.equal(r.contract.requiresApproval, false);
    assert.equal(r.contract.executionProvider, "WebAccess");
    assert.ok(READ_TOOL_IDS.includes(id));
    assert.ok(!WRITE_TOOL_IDS.includes(id));
  }
  assert.deepEqual(reg.resolve("web.search", 1).contract.requiredPermissions, [authz.TOOL_ACTION.WEB_SEARCH]);
  assert.deepEqual(reg.resolve("web.fetch", 1).contract.requiredPermissions, [authz.TOOL_ACTION.WEB_FETCH]);
  const manifest = buildBridgeManifest(reg, { readToolIds: READ_TOOL_IDS, writeToolIds: WRITE_TOOL_IDS });
  const names = JSON.stringify(manifest);
  assert.match(names, /web_search/);
  assert.match(names, /web_fetch/);
  assert.ok(FORBIDDEN_HARNESS_TOOLS.includes("web"), "Harness 内置联网仍然禁用");
  assert.ok(BUILTIN_APP_PERMISSIONS.ai.includes("tool.web.search") && BUILTIN_APP_PERMISSIONS.ai.includes("tool.web.fetch"));
  assert.ok(BUILTIN_APP_PERMISSIONS.canvas.includes("tool.web.search"));
});

test("输入 schema：拒绝内网写法以外的明显坏参数（空查询 / 非 http / 多余字段）", () => {
  const reg = new ToolRegistry();
  const s = reg.resolve("web.search", 1).contract;
  const f = reg.resolve("web.fetch", 1).contract;
  assert.equal(reg.validateInput(s, { query: "ok" }).ok, true);
  assert.equal(reg.validateInput(s, { query: "" }).ok, false);
  assert.equal(reg.validateInput(s, { query: "x", cmd: "rm" }).ok, false);
  assert.equal(reg.validateInput(f, { url: "https://example.com/" }).ok, true);
  assert.equal(reg.validateInput(f, { url: "file:///etc/passwd" }).ok, false);
  assert.equal(reg.validateInput(f, { url: "https://u:p@example.com/" }).ok, false);
});

test("适配器：WebAccess provider 只在注入 webAccess 时存在，按参数分派并校验输出", async () => {
  assert.equal(createToolAdapters({}).adapterFor({ executionProvider: "WebAccess", toolId: "web.search" }), null);
  const seen = [];
  const fake = {
    search: async (a) => { seen.push(["search", a.query, a.limit]); return { ok: true, result: { query: a.query, provider: "bing", results: [{ title: "t", url: "https://x.example/", snippet: "s" }], untrusted: true } }; },
    fetch: async (a) => { seen.push(["fetch", a.url]); return a.url.includes("bad") ? { ok: false, error: "WEB_BLOCKED_HOST" } : { ok: true, result: { url: a.url, finalUrl: a.url, status: 200, contentType: "text/html", title: "T", text: "body", truncated: false, untrusted: true } }; },
  };
  const { adapterFor } = createToolAdapters({ webAccess: fake });
  const reg = new ToolRegistry();
  const searchAdapter = adapterFor({ executionProvider: "WebAccess", toolId: "web.search" });
  const fetchAdapter = adapterFor({ executionProvider: "WebAccess", toolId: "web.fetch" });
  assert.ok(searchAdapter && fetchAdapter);
  const s = await searchAdapter.execute({ args: { query: "q", limit: 3 } });
  assert.equal(s.ok, true);
  assert.equal(reg.validateOutput(reg.resolve("web.search", 1).contract, s.result).ok, true);
  assert.equal((await searchAdapter.verify({ result: s.result })).ok, true);
  const f = await fetchAdapter.execute({ args: { url: "https://x.example/" } });
  assert.equal(reg.validateOutput(reg.resolve("web.fetch", 1).contract, f.result).ok, true);
  assert.deepEqual(await fetchAdapter.execute({ args: { url: "https://bad.example/" } }), { ok: false, error: "WEB_BLOCKED_HOST" });
  assert.deepEqual(seen, [["search", "q", 3], ["fetch", "https://x.example/"], ["fetch", "https://bad.example/"]]);
});

test("formatSearchContext：编号、链接、摘要，超长截断", () => {
  const text = web.formatSearchContext({ results: [{ title: "A", url: "https://a/", snippet: "sa" }, { title: "B", url: "https://b/", snippet: "" }] });
  assert.equal(text, "[1] A\nhttps://a/\nsa\n\n[2] B\nhttps://b/");
  assert.equal(web.formatSearchContext({ results: [] }), "");
  assert.ok(web.formatSearchContext({ results: [{ title: "x".repeat(5000), url: "u" }] }, { maxChars: 100 }).length <= 101);
});

test("画布联网开关：模型不能原生联网时，把搜索结果并进最后一条用户消息", async () => {
  const { withWebSearchContext } = require("../electron/canvas-service.cjs");
  const queries = [];
  const ok = { search: async ({ query }) => { queries.push(query); return { ok: true, result: { results: [{ title: "R", url: "https://r.example/", snippet: "snip" }] } }; } };
  const msgs = [{ role: "system", content: "sys" }, { role: "user", content: "old" }, { role: "assistant", content: "a" }, { role: "user", content: [{ type: "text", text: "今天 金价" }, { type: "image_url", image_url: { url: "data:x" } }] }];
  const out = await withWebSearchContext(msgs, ok, null);
  assert.deepEqual(queries, ["今天 金价"]);
  assert.equal(out.length, msgs.length, "不插入新消息");
  assert.deepEqual(out.slice(0, 3), msgs.slice(0, 3));
  assert.equal(out[3].content[0].type, "text");
  assert.match(out[3].content[0].text, /联网参考[\s\S]*https:\/\/r\.example\/[\s\S]*用户问题/);
  assert.deepEqual(out[3].content.slice(1), msgs[3].content);
  const failed = await withWebSearchContext([{ role: "user", content: "q" }], { search: async () => ({ ok: false, error: "WEB_UNAVAILABLE" }) }, null);
  assert.match(failed[0].content, /没有拿到结果[\s\S]*用户问题】\nq$/);
  assert.deepEqual(await withWebSearchContext([{ role: "assistant", content: "x" }], ok, null), [{ role: "assistant", content: "x" }]);
});
