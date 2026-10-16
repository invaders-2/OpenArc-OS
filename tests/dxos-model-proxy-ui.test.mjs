/**
 * 系统设置 › 模型与服务商 · 「模型出网代理」一行设置的离线单测。
 *
 * 只测纯逻辑 + 静态契约（不启动浏览器 / Electron）：
 *   · egressProxyLogic.ts  提交前校验、状态视图、错误文案、回包投影
 *   · ModelSettings.vue    开关 / 地址输入 / 保存 / 状态 / 错误 的 data-* 探针钩子与既有样式类
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EGRESS_PROXY_DEFAULT_URL,
  EGRESS_PROXY_ERROR_TEXT,
  egressProxyErrorText,
  egressProxyStatusView,
  normalizeEgressProxyResult,
  validateEgressProxyDraft,
} from "../src-vue/settings/egressProxyLogic.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");
const CJK = /[\u4e00-\u9fff]/;

/* ══ 1 提交前校验（与主进程 model-domain.cjs#validateProxyUrl 同口径） ══ */

test("关闭时忽略地址；地址归一为 origin", () => {
  assert.deepEqual(validateEgressProxyDraft({ enabled: false, url: "随便" }), { ok: true, code: null, message: "", url: null });
  assert.deepEqual(validateEgressProxyDraft(null), { ok: true, code: null, message: "", url: null });
  const on = validateEgressProxyDraft({ enabled: true, url: "http://127.0.0.1:7897/" });
  assert.equal(on.ok, true);
  assert.equal(on.url, "http://127.0.0.1:7897");
  assert.equal(validateEgressProxyDraft({ enabled: true, url: "https://proxy.example.com:8443" }).url, "https://proxy.example.com:8443");
});

test("开启时非法地址全部拦下：结构化 INVALID_INPUT + 中文可执行提示", () => {
  for (const url of [
    "", "   ", "127.0.0.1:7897", "not a url", "socks5://127.0.0.1:1080",
    "http://user:pass@127.0.0.1:7897", "http://127.0.0.1:7897/path",
    "http://127.0.0.1:7897?x=1", "http://127.0.0.1:7897#a", "http://127.0.0.1",
  ]) {
    const check = validateEgressProxyDraft({ enabled: true, url });
    assert.equal(check.ok, false, JSON.stringify(url));
    assert.equal(check.code, "INVALID_INPUT", JSON.stringify(url));
    assert.equal(check.url, null, JSON.stringify(url));
    assert.ok(CJK.test(check.message), JSON.stringify(url) + " 必须有中文提示");
  }
  assert.ok(validateEgressProxyDraft({ enabled: true, url: "http://user:pass@h:1" }).message.includes("不支持带用户名/密码"));
  assert.ok(validateEgressProxyDraft({ enabled: true, url: "socks5://h:1" }).message.includes("http://"));
  assert.ok(validateEgressProxyDraft({ enabled: true, url: "http://h" }).message.includes(EGRESS_PROXY_DEFAULT_URL));
});

/* ══ 2 状态视图 / 错误文案 / 回包投影 ══ */

test("状态视图：tone 只取 DsBadge 合法值；地址与说明如实", () => {
  const tones = new Set(["neutral", "success", "warning", "danger"]);
  const off = egressProxyStatusView({ enabled: false, url: null });
  assert.equal(off.label, "已关闭");
  assert.equal(off.tone, "neutral");
  assert.ok(off.detail.includes("仅用于模型与协议请求"));
  assert.ok(off.detail.includes("默认关闭"));
  const on = egressProxyStatusView({ enabled: true, url: "http://127.0.0.1:7897" });
  assert.equal(on.label, "已启用");
  assert.equal(on.tone, "success");
  assert.ok(on.detail.includes("http://127.0.0.1:7897"));
  for (const view of [off, on]) assert.ok(tones.has(view.tone));
});

test("错误码 → 中文；保留原始码便于定位", () => {
  for (const code of ["PROXY_AUTH_REQUIRED", "PROXY_UNREACHABLE", "PROXY_TUNNEL_FAILED", "PROXY_TIMEOUT", "PROXY_CONFIG_INVALID", "PROXY_UNAUTHORIZED", "INVALID_INPUT", "NO_BRIDGE"]) {
    const text = egressProxyErrorText(code);
    assert.ok(CJK.test(text), code + " 必须有中文文案");
    assert.ok(text.includes(code), code + " 保留原始码");
    assert.ok(EGRESS_PROXY_ERROR_TEXT[code].length > 0);
  }
  assert.equal(egressProxyErrorText("WEIRD_NEW_CODE"), "WEIRD_NEW_CODE");
  assert.ok(CJK.test(egressProxyErrorText(null)));
});

test("回包投影：字段缺失不补造；失败给中文原因；不把任何地址当凭据", () => {
  const ok = normalizeEgressProxyResult({ ok: true, enabled: true, url: "http://127.0.0.1:7897", changed: true });
  assert.deepEqual(ok, { enabled: true, url: "http://127.0.0.1:7897", problem: null, changed: true });
  const off = normalizeEgressProxyResult({ ok: true, enabled: false, url: null, changed: false });
  assert.deepEqual(off, { enabled: false, url: null, problem: null, changed: false });
  const failed = normalizeEgressProxyResult({ ok: false, error: "PROXY_UNAUTHORIZED" });
  assert.equal(failed.enabled, false);
  assert.equal(failed.url, null);
  assert.ok(CJK.test(failed.problem));
  const junk = normalizeEgressProxyResult(undefined);
  assert.ok(CJK.test(junk.problem));
  assert.equal(normalizeEgressProxyResult({ ok: true }).url, null);
});

/* ══ 3 界面契约（静态） ══ */

test("ModelSettings.vue 带齐探针钩子与既有样式类，且只发冻结命令", () => {
  const raw = read("src-vue/settings/ModelSettings.vue");
  const code = stripComments(raw);
  for (const marker of [
    "data-model-egress",
    "data-model-egress-switch",
    "data-model-egress-url",
    "data-model-egress-save",
    "data-model-egress-status",
    "data-model-egress-error",
  ]) {
    assert.ok(raw.includes(marker), "缺少选择器 " + marker);
  }
  for (const cls of ['class="switch"', 'class="set-input mono"', 'class="set-cap"']) {
    assert.ok(raw.includes(cls), "必须复用既有样式类 " + cls);
  }
  assert.ok(raw.includes("仅用于模型与协议请求；默认关闭"), "必须有那句说明");
  assert.ok(code.includes('import DsBadge from "../design-system/DsBadge.vue"'), "复用 DsBadge");
  assert.ok(code.includes("DsButton"), "复用 DsButton");
  assert.ok(code.includes("model/proxy/get") && code.includes("model/proxy/set"), "只经 model 域取/写");
  assert.equal(/\bfetch\s*\(/.test(code), false, "不得调用 fetch");
  assert.equal(/localStorage|sessionStorage/.test(code), false, "不得写存储");
});

test("纯逻辑模块不引入网络 / 存储 / Vue 依赖", () => {
  const code = stripComments(read("src-vue/settings/egressProxyLogic.ts"));
  assert.equal(/\bfetch\s*\(/.test(code), false);
  assert.equal(/localStorage|sessionStorage/.test(code), false);
  assert.equal(code.includes('from "vue"'), false);
  assert.equal(/XMLHttpRequest|WebSocket|EventSource/.test(code), false);
});
