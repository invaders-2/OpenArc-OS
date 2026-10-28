/**
 * 画布节点错误「码 → 人话」映射（task-14）。
 *
 * 覆盖：
 *   ① 每个已知码都有人话，且人话里不出现原始码；
 *   ② 未知码 / 空串 → 「生成失败，可稍后重试」，原始码仍保留在 code 里；
 *   ③ 网络类 / 429 从错误串里认出来；
 *   ④ nodeError()（engine catch 的落点）返回 { err: 人话, errCode: 原始码 }，err 不再等于原始码；
 *   ⑤ 没有模型时「重试」被禁用并给出理由；
 *   ⑥ 静态护栏：engine 的两个 catch 都走 nodeError、NodeView 的弹层有 重试/关闭 与「代码：」行。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { errorText, errorCode, errorTextFor, nodeError, retryBlockedReason, FALLBACK_TEXT } = await import(pathToFileURL(path.join(ROOT, "src/canvas/canvas-next/errorText.ts")).href);
const { GenError } = await import(pathToFileURL(path.join(ROOT, "src/canvas/canvas-next/backend/types.ts")).href);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const CASES = [
  ["MODEL_TIMEOUT", "模型响应超时（长时间没有新内容）"],
  ["TIMEOUT", "模型响应超时（长时间没有新内容）"],
  ["MODEL_NOT_FOUND", "该模型不在当前模型清单里（不会改用其它模型）"],
  ["MODEL_CONFIG_UNAVAILABLE", "没有可用的模型配置，请到 设置 → 模型 里配置"],
  ["CREDENTIAL_MISSING", "该模型缺少凭据"],
  ["PROXY_UNAUTHORIZED", "没有权限使用该模型（授权可能已被撤销）"],
  ["CAPABILITY_UNAVAILABLE", "该模型不支持这种生成（OpenArc 不会用别的接口顶替）"],
  ["ENDPOINT_BLOCKED", "该供应商地址不在允许范围内"],
  ["UPLOAD_CONSENT_REQUIRED", "该模型需要把参考素材上传到临时图床，请先到 设置 → 网络 里允许上传"],
  ["CANCELLED", "生成已停止"],
  ["STOPPED", "生成已停止"],
  ["RATE_LIMITED", "请求太频繁被限流，请稍后重试"],
  ["NETWORK", "网络连接中断，请检查网络后重试"],
];

test("① 每个已知码都有人话，且主行不含原始码", () => {
  for (const [code, want] of CASES) {
    const r = errorText(code);
    assert.equal(r.code, code, "code 必须保留原始值：" + code);
    assert.equal(r.text, want, code + " 的人话不对");
    assert.equal(r.text.includes(code), false, code + " 的人话里不该出现原始码");
    assert.ok(r.text.length >= 5, code + " 的人话太短");
  }
});

test("② 未知码 / 空串 → 兜底人话，原始码不丢", () => {
  const unknown = errorText("SOMETHING_WEIRD_500");
  assert.equal(unknown.code, "SOMETHING_WEIRD_500");
  assert.equal(unknown.text, "生成失败，可稍后重试");
  assert.equal(unknown.text.includes("SOMETHING_WEIRD_500"), false);
  const empty = errorText("");
  assert.equal(empty.code, "");
  assert.equal(empty.text, "生成失败，可稍后重试");
  assert.equal(errorTextFor(""), "生成失败，可稍后重试");
});

test("③ 网络类与 429 从错误串里认出来", () => {
  assert.equal(errorCode("TypeError: fetch failed"), "NETWORK");
  assert.equal(errorCode("read ECONNRESET"), "NETWORK");
  assert.equal(errorCode("getaddrinfo ENOTFOUND api.example.com"), "NETWORK");
  assert.equal(errorText("HTTP 429 Too Many Requests").code, "RATE_LIMITED");
  assert.equal(errorText("rate limit exceeded").code, "RATE_LIMITED");
  // 码包在长消息里也能认出来（后端常用 "MODEL_TIMEOUT: xxx" 形式）
  assert.equal(errorCode("MODEL_TIMEOUT: 90s 没有新内容"), "MODEL_TIMEOUT");
  assert.equal(errorCode("upstream said MODEL_NOT_FOUND"), "MODEL_NOT_FOUND");
});

test("④ nodeError：err 是人话、errCode 保留原始码（engine catch 的落点）", () => {
  const g = nodeError(new GenError("MODEL_TIMEOUT", "MODEL_TIMEOUT"));
  assert.equal(g.err, "模型响应超时（长时间没有新内容）");
  assert.equal(g.errCode, "MODEL_TIMEOUT");
  assert.notEqual(g.err, "MODEL_TIMEOUT", "err 不能再等于原始码");
  const n = nodeError(new TypeError("fetch failed"));
  assert.equal(n.err, "网络连接中断，请检查网络后重试");
  assert.equal(n.errCode, "NETWORK");
  const plain = nodeError(new Error("boom"));
  assert.equal(plain.err, FALLBACK_TEXT);
  assert.equal(plain.errCode, "boom", "认不出码时保留原始串，便于排查");
  // 后端把「未知码 + 具体原因」一起给时：主行说具体原因，原始码照旧保留
  const mixed = nodeError(new GenError("PROVIDER_UNAVAILABLE", "TypeError: fetch failed"));
  assert.equal(mixed.err, "网络连接中断，请检查网络后重试");
  assert.equal(mixed.errCode, "PROVIDER_UNAVAILABLE");
});

test("⑤ 没有可用模型时「重试」禁用并给理由", () => {
  assert.match(retryBlockedReason("MODEL_CONFIG_UNAVAILABLE", true), /设置 → 模型/);
  assert.match(retryBlockedReason("MODEL_NOT_FOUND", true), /模型清单/);
  assert.match(retryBlockedReason("", false), /还没有可用的模型/);
  assert.equal(retryBlockedReason("NETWORK", true), null);
  assert.equal(retryBlockedReason("MODEL_TIMEOUT", true), null);
});

test("⑥ 静态护栏：engine 走 nodeError；弹层有 重试/关闭 与「代码：」行", () => {
  const engine = read("src/canvas/canvas-next/engine.ts");
  assert.equal((engine.match(/nodeError\(/g) || []).length, 2, "execute 与出表两个 catch 都要用 nodeError");
  assert.equal(/err:\s*err\.message/.test(engine), false, "不许再把原始 message 直接写进 err");
  const view = read("src/canvas/canvas-next/ui/NodeView.tsx");
  assert.match(view, /data-act="erretry"/);
  assert.match(view, /data-act="errok"/);
  assert.match(view, /代码：/);
  assert.match(view, /retryBlockedReason\(/);
  const menus = read("src/canvas/canvas-next/ui/menus.tsx");
  assert.match(menus, /act === "erretry".*runNode\(store, n\.id\)/s, "重试要真的重跑该节点");
  assert.match(menus, /act === "errok".*errCode: undefined/s, "关闭要同时清掉 errCode");
});
