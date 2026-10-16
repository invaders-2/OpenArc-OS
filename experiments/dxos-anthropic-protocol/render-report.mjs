#!/usr/bin/env node
/**
 * report.json → REPORT.md（人类可读）。只读 artifacts/dxos-anthropic-protocol/report.json，
 * 不改产品代码。用法：node experiments/dxos-anthropic-protocol/render-report.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ART = path.join(ROOT, "artifacts", "dxos-anthropic-protocol");
const report = JSON.parse(fs.readFileSync(path.join(ART, "report.json"), "utf8"));

const rows = report.rows || [];
const bySection = new Map();
for (const row of rows) { if (!bySection.has(row.section)) bySection.set(row.section, []); bySection.get(row.section).push(row); }
const line = (row) => "- " + (row.ok ? "PASS" : "FAIL") + " · **" + row.name + "** — 期望：" + row.expected + "；实际：" + row.actual;

const out = [];
out.push("# dxos-anthropic-protocol · 真机验收报告");
out.push("");
out.push("生成时间：" + report.at + "　·　Electron：" + report.electron + "　·　CDP 端口：" + report.cdpPort);
out.push("");
out.push("**未做真实联网**：本机对 \`https://api.anthropic.com\` 的匿名探测返回 \`403 {\"type\":\"forbidden\",\"message\":\"Request not allowed\"}\`（WAF/地域拦截，不是 401），官方文档站（platform.claude.com / docs.claude.com）同样地区拦截。因此本次真机验收由本地 mock（\`experiments/dxos-anthropic-protocol/anthropic-mock.mjs\`）只替代最后一跳网络，其余全部是真实 Electron 主进程与真实产品入口（\`dist/vue.html\`）。真实联网调用需要用户自己的 Anthropic key。");
out.push("");
out.push("## 结果");
out.push("");
out.push("- 总览：PASS=" + report.passed + "，FAIL=" + report.failed + (report.ok ? "（通过）" : "（未通过）"));
out.push("");
for (const [section, list] of bySection) {
  out.push("### " + section);
  out.push("");
  for (const row of list) out.push(line(row));
  out.push("");
}
out.push("## 协议与模型 id 的只读依据");
out.push("");
out.push("本仓已安装官方 SDK \`node_modules/@anthropic-ai/sdk\` **0.123.0**，以其生成类型/客户端代码作为协议形状依据（官方文档站对本机不可达）：");
out.push("");
out.push("- \`x-api-key\` 鉴权 + \`anthropic-version: 2023-06-01\`：\`@anthropic-ai/sdk/client.js:841\` 默认头。");
out.push("- \`POST /v1/messages\` 请求体 \`{ model, max_tokens, system?, messages, tools?, stream? }\`，响应 \`{ content: [{type:'text'|'tool_use'}], stop_reason, usage:{input_tokens,output_tokens} }\`：\`resources/messages/messages.d.ts:1882\`。");
out.push("- 具名 SSE 事件（\`message_start\` / \`content_block_start\` / \`content_block_delta\`（\`text_delta\` / \`input_json_delta\`）/ \`content_block_stop\` / \`message_delta\`（usage）/ \`message_stop\` / \`error\`）：\`resources/messages/messages.d.ts:2094-2156\`。");
out.push("- \`GET /v1/models\` → \`{ data: ModelInfo[] }\`（\`id\` / \`display_name\` / \`max_tokens\`）：\`resources/models.d.ts:13-155\`。");
out.push("- 官方现役模型 id（SDK 的 \`Model\` 联合类型，\`resources/messages/messages.d.ts:2064\`）：\`claude-fable-5-1\`、\`claude-mythos-5-1\`、\`claude-sonnet-5\`、\`claude-fable-5\`、\`claude-mythos-5\`、\`claude-opus-5\`、\`claude-opus-4-8\`、\`claude-opus-4-7\`、\`claude-mythos-preview\`、\`claude-opus-4-6\`、\`claude-sonnet-4-6\`、\`claude-haiku-4-5\`、\`claude-haiku-4-5-20251001\`、\`claude-opus-4-5\`、\`claude-opus-4-5-20251101\`、\`claude-sonnet-4-5\`、\`claude-sonnet-4-5-20250929\`。");
out.push("");
out.push("## 截图");
out.push("");
const shots = [];
for (const key of ["settingsShots", "chat"]) {
  const value = report.evidence && report.evidence[key];
  if (!value) continue;
  for (const s of (Array.isArray(value) ? value : (value.shots || []))) shots.push(s);
}
for (const s of shots) out.push("- \`" + (s.file || s) + "\`（" + (s.width || "") + "×" + (s.height || "") + "）");
out.push("");
out.push("## 遗留 / 未覆盖");
out.push("");
out.push("- **真实联网未做**：\`api.anthropic.com\` 403 地区拦截；需要用户 key 才能在真机上做真实调用。");
out.push("- **tools / 工具调用**：适配器会把 OpenAI 形状的 \`tools\` 转成 \`{name, description, input_schema}\`，并把 \`tool_use\` 块归一回既有 \`tool_calls\` 形状；但没有任何真实 key，未在真机对官方工具回路做在线验证（离线单测覆盖了请求体与解析形状）。");
out.push("- **thinking / 缓存块**：\`thinking_delta\`、\`signature_delta\`、\`citations_delta\` 不进入可见文本（当前只认 \`text_delta\` + \`input_json_delta\`）；\`cache_creation_input_tokens\` / \`cache_read_input_tokens\` 目前不单独投影到 usage（只取 input/output）。extended thinking 与 prompt caching 本轮未启用。");
out.push("");
out.push("## 复跑");
out.push("");
out.push("\`\`\`bash");
out.push("node experiments/dxos-anthropic-protocol/run.mjs");
out.push("node experiments/dxos-anthropic-protocol/render-report.mjs");
out.push("\`\`\`");
out.push("");
fs.writeFileSync(path.join(ART, "REPORT.md"), out.join("\n"), "utf8");
console.log("写入 " + path.relative(ROOT, path.join(ART, "REPORT.md")));
