/**
 * P2 · 真实调用脚本（OpenAI 兼容 chat + 图像协议）。
 *
 * 用法：
 *   OPENARC_OPENAI_BASE_URL=https://api.example.com/v1 \
 *   OPENARC_OPENAI_API_KEY=... \
 *   OPENARC_OPENAI_MODEL=gpt-4o-mini \
 *   node experiments/dxos-p2/real-call.mjs
 *
 * 图像协议独立变量（未设置时回落到上面的 OpenAI 变量）：
 *   OPENARC_IMAGE_BASE_URL / OPENARC_IMAGE_API_KEY / OPENARC_IMAGE_MODEL
 *
 * 未设置必需变量时打印明确 SKIP 文案并 exit 0；脚本里没有任何硬编码密钥。
 * 密钥只放进程内存（memoryCredentialBackend），落盘的 providers.json 不含明文。
 */
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { createProviderProtocolBundle } = require("../../electron/provider-protocol-service.cjs");
const { memoryCredentialBackend } = require("../../electron/credential-store.cjs");

const env = process.env;
const openAiBaseUrl = String(env.OPENARC_OPENAI_BASE_URL || "").trim();
const openAiApiKey = String(env.OPENARC_OPENAI_API_KEY || "").trim();
const openAiModel = String(env.OPENARC_OPENAI_MODEL || "gpt-4o-mini").trim();
const imageBaseUrl = String(env.OPENARC_IMAGE_BASE_URL || openAiBaseUrl).trim();
const imageApiKey = String(env.OPENARC_IMAGE_API_KEY || openAiApiKey).trim();
const imageModel = String(env.OPENARC_IMAGE_MODEL || "gpt-image-1").trim();

if (!openAiBaseUrl || !openAiApiKey) {
  console.log("[dxos-p2] SKIP: 未设置 OPENARC_OPENAI_BASE_URL / OPENARC_OPENAI_API_KEY，跳过真实调用（exit 0）。");
  console.log("[dxos-p2] SKIP: 不猜测密钥、不使用任何硬编码 fallback。");
  process.exit(0);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-p2-real-"));
const bundle = createProviderProtocolBundle({ userDataDir, backend: memoryCredentialBackend() });

const openAiProvider = bundle.store.create({
  name: "dxos-p2-openai",
  baseUrl: openAiBaseUrl,
  protocol: "openai",
  models: [{ model: openAiModel, caps: ["llm", "image"] }],
});
bundle.store.setKeys(openAiProvider.id, { apiKey: openAiApiKey });

const results = { chat: null, image: null };

try {
  const chat = await bundle.service.call({
    providerId: openAiProvider.id,
    model: openAiModel,
    messages: [
      { role: "system", content: "You are a connectivity probe. Reply with one short sentence." },
      { role: "user", content: "Reply with exactly: dxos-p2-ok" },
    ],
    params: { max_tokens: 64 },
  });
  results.chat = { ok: chat.ok, error: chat.error || null, text: chat.text || null, usage: chat.usage || null };
  console.log("[dxos-p2] chat:", JSON.stringify(results.chat));
} catch (error) {
  console.log("[dxos-p2] chat ERROR:", String(error && error.message || error));
}

if (imageBaseUrl && imageApiKey) {
  try {
    const imageProvider = imageBaseUrl === openAiBaseUrl && imageApiKey === openAiApiKey
      ? openAiProvider
      : (() => { const p = bundle.store.create({ name: "dxos-p2-image", baseUrl: imageBaseUrl, protocol: "openai", models: [{ model: imageModel, caps: ["image"] }] }); bundle.store.setKeys(p.id, { apiKey: imageApiKey }); return p; })();
    const image = await bundle.service.generateImage({
      providerId: imageProvider.id,
      model: imageModel,
      prompt: "A minimal flat icon of a paper plane on a plain white background",
      size: "1024x1024",
      count: 1,
    });
    const images = (image.images || []).map((item) => ({ mediaPath: item.mediaPath || null, sourceUrl: item.sourceUrl || item.url || null, mime: item.mime || null, bytes: item.bytes || null }));
    results.image = { ok: image.ok, error: image.error || null, images };
    console.log("[dxos-p2] image:", JSON.stringify(results.image));
  } catch (error) {
    console.log("[dxos-p2] image ERROR:", String(error && error.message || error));
  }
} else {
  console.log("[dxos-p2] image SKIP: 未设置图像协议变量。");
}

const report = {
  format: "dxos-p2-real-call/v1",
  at: new Date().toISOString(),
  runId: crypto.randomBytes(6).toString("hex"),
  userDataDir,
  openAiBaseUrl,
  imageBaseUrl: imageBaseUrl || null,
  results,
};
fs.mkdirSync(path.join(process.cwd(), "artifacts", "dxos-p2"), { recursive: true });
const reportPath = path.join(process.cwd(), "artifacts", "dxos-p2", "real-call-" + report.runId + ".json");
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log("[dxos-p2] report:", reportPath);
process.exit(results.chat && results.chat.ok ? 0 : 1);
