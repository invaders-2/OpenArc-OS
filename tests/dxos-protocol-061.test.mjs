/**
 * DX OS 0.6.1 · gemini-general 模型协议移植契约测试（不联网、不启动 DX OS、不写用户目录）。
 *
 * 源：DXSRC/server/protocol-engine/builtins.ts
 *   · gemini-general :865-871  → 本移植唯一新增项（...spread geminiProtocol 后仅改 id/label/summary）
 *   · dxos-media      :296-338  → OUT（DX OS 公共 API，指向 api.dx-os.com）
 *   · dxos-http       :2476     → OUT（bearerProvider('dxos-http', 'DX OS API')）
 *
 * 源 BUILTIN_MODEL_PROTOCOLS_V2 :2504 共 20 条；去掉 1 条云协议 dxos-media 后，
 * 移植侧应为 openai-images + 18 = 19 条。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const validator = require("../electron/protocol-engine/validator.cjs");
const builtins = require("../electron/protocol-engine/builtins.cjs");

test("061 移植计数：19 个模型 + 15 个供应商", () => {
  assert.equal(builtins.BUILTIN_MODEL_PROTOCOLS_V2.length, 19);
  assert.equal(builtins.BUILTIN_PROVIDER_PROTOCOLS_V2.length, 15);
});

test("061 gemini-general 已移植：id 列表含它、不含任何 DX 云协议", () => {
  const modelIds = builtins.BUILTIN_MODEL_PROTOCOLS_V2.map((protocol) => protocol.id);
  const providerIds = builtins.BUILTIN_PROVIDER_PROTOCOLS_V2.map((protocol) => protocol.id);

  assert.ok(modelIds.includes("gemini-general"), "必须含 gemini-general");
  assert.equal(modelIds.includes("dxos-media"), false, "dxos-media 是 OUT 云协议，不得移植");
  assert.equal(providerIds.includes("dxos-http"), false, "dxos-http 是 OUT 云协议，不得移植");

  // 源顺序（builtins.ts:2504）：geminiProtocol 之后紧跟 geminiGeneralProtocol，再是 xaiProtocol。
  assert.equal(modelIds.indexOf("gemini-general"), modelIds.indexOf("gemini") + 1);
  // metadata 与最终导出一致登记，显式 ported:true。
  const meta = builtins.BUILTIN_PROTOCOL_METADATA_V2.find((entry) => entry.id === "gemini-general" && entry.kind === "model");
  assert.ok(meta, "metadata 必须登记 gemini-general");
  assert.equal(meta.ported, true);
});

test("061 gemini-general 与源逐字一致：仅覆盖 id/label/summary", () => {
  const protocol = builtins.getBuiltinProtocolV2("model", "gemini-general");
  assert.ok(protocol, "getBuiltinProtocolV2 必须能取到 gemini-general");
  assert.equal(protocol.kind, "model");
  assert.equal(protocol.label, "Gemini 通用协议");
  assert.equal(protocol.summary, "第三方聚合站 Gemini 通用协议：使用 generateContent 请求体，但由外层 Bearer provider 负责认证。");

  const gemini = builtins.getBuiltinProtocolV2("model", "gemini");
  // 逐字等于 { ...geminiProtocol, id, label, summary }（源 :865-871 的 ...spread）。
  assert.deepEqual(protocol, {
    ...gemini,
    id: "gemini-general",
    label: "Gemini 通用协议",
    summary: "第三方聚合站 Gemini 通用协议：使用 generateContent 请求体，但由外层 Bearer provider 负责认证。",
  });

  const normalized = validator.validateProtocolV2(protocol);
  assert.equal(normalized.id, "gemini-general");
});
