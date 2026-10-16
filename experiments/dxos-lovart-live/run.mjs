/**
 * dxos-lovart-live · Lovart 真实联网验收探针（服务 / 适配器层，不含 UI）
 *
 * 目的：在真实网络下驱动既有实现，回填并复验 artifacts/lovart-live/ 的手工证据：
 *   1) provider/models → ModelService.listRemoteModels → 适配器 GET /v1/openapi/tools/catalog
 *   2) image/generate → ProviderProtocolService.generateImage → 适配器 send→watch→result，
 *      产物经白名单主机 a.lovart.ai 真实下载并落盘 <userData>/dxos/media
 *
 * 网络：本机到 Lovart 必须走系统代理。Node 只在启动时读取 env proxy，
 * 所以本探针若发现 NODE_USE_ENV_PROXY/HTTPS_PROXY 未设置，会用同一命令自我重入一次。
 *   NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 node experiments/dxos-lovart-live/run.mjs
 *
 * 凭据：运行时读取 OA_LOVART_KEYS（默认 /tmp/oa-lovart.keys，形如 AK=… / SK=…）。
 * 绝不打印、绝不写入报告/截图；报告只留 sha256 前 12 位。
 *
 * 额度纪律：只发一次生成请求；失败如实上报原始错误，不重试、不伪造成功。
 *
 * 边界：这是服务/适配器层验证。应用内（UI 走 market/ui 链路）未验证 ——
 * 依赖尚未实现的「模型出网代理」功能，落地后补。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createModelFixture } from "../../tests/model-fixtures.mjs";

const require = createRequire(import.meta.url);
const lovart = require("../../electron/provider-adapter-lovart.cjs");
const { ProviderProtocolService } = require("../../electron/provider-protocol-service.cjs");

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), "..", "..");
const OUT_DIR = path.join(ROOT, "artifacts", "dxos-lovart-live");

const KEY_PATH = process.env.OA_LOVART_KEYS || "/tmp/oa-lovart.keys";
const PROXY = process.env.OA_LOVART_PROXY || "http://127.0.0.1:7897";
const BASE_URL = process.env.OA_LOVART_BASE_URL || lovart.DEFAULT_BASE_URL;
const PROMPT = process.env.OA_LOVART_PROMPT
  || "A single red apple on a clean white table, product photography, soft studio light";
const MODE = process.env.OA_LOVART_MODE || "fast";
const TIMEOUT_MS = Number(process.env.OA_LOVART_TIMEOUT_MS || 300000);

/* ── 代理自举：Node 启动时才解析 env proxy ─────────────────────────────── */
if (process.env.OA_LOVART_NO_REEXEC !== "1"
  && !(process.env.NODE_USE_ENV_PROXY === "1" && (process.env.HTTPS_PROXY || process.env.https_proxy))) {
  const proxyEnv = { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY, https_proxy: PROXY, http_proxy: PROXY, OA_LOVART_NO_REEXEC: "1" };
  const child = spawnSync(process.execPath, [SELF, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, ...proxyEnv } });
  process.exit(child.status == null ? 1 : child.status);
}

/* ── 记录与自检 ───────────────────────────────────────────────────────── */
const records = [];
function record(name, pass, expected, actual) {
  records.push({ name, pass: !!pass, expected, actual });
  console.log((pass ? "PASS" : "FAIL") + " · " + name);
  if (!pass) console.log("        期望: " + expected + "\n        实际: " + actual);
}

/* ── 凭据（只在运行时读取，绝不外泄） ─────────────────────────────────── */
function sha12(value) { return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 12); }
function loadKeys() {
  const text = fs.readFileSync(KEY_PATH, "utf8");
  const map = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    map[m[1].toUpperCase()] = m[2].replace(/^["']|["']$/g, "");
  }
  if (!map.AK || !map.SK) throw new Error("密钥文件缺少 AK / SK：" + KEY_PATH);
  return { accessKey: map.AK, secretKey: map.SK };
}

/* ── 走代理的 fetchImpl（注入给适配器 / 服务），顺带记录真实请求轨迹 ─────── */
const trace = [];
const statusSequence = [];
const rawResponses = {};
async function proxyFetch(url, options = {}) {
  const startedAt = Date.now();
  const response = await fetch(url, options);
  const target = new URL(String(url));
  const entry = { url: String(url), path: target.pathname, method: options.method || "GET", status: response.status, ms: Date.now() - startedAt };
  trace.push(entry);
  if (target.pathname.endsWith("/chat/status")) {
    try {
      const body = await response.clone().json();
      const value = body && body.data && body.data.status;
      if (value != null) { entry.threadStatus = String(value); statusSequence.push(String(value)); }
    } catch { /* 非 JSON 就只留状态码 */ }
  }
  const keep = ["/v1/openapi/tools/catalog", "/v1/openapi/mode/query", "/v1/openapi/chat/result"];
  if (keep.includes(target.pathname) && rawResponses[target.pathname] === undefined) {
    try { rawResponses[target.pathname] = await response.clone().text(); } catch { /* 忽略 */ }
  }
  return response;
}

function pngInfo(buffer) {
  const magic = buffer.subarray(0, 8).toString("hex");
  if (magic !== "89504e470d0a1a0a") return { magic, format: "not-png", width: null, height: null };
  return { magic, format: "png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function writeReports(report) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2) + "\n");
  const lines = [];
  lines.push("# dxos-lovart-live · Lovart 真实联网验收（服务 / 适配器层）", "");
  lines.push("**结论**：" + (report.passed ? "全部通过" : "**有失败项**") + " —— 真实联网下驱动既有 provider/models 与 image/generate。", "");
  lines.push("- 代理：" + report.proxy + "（NODE_USE_ENV_PROXY=1）");
  lines.push("- baseUrl：" + report.baseUrl);
  lines.push("- 凭据来源：" + report.keyFingerprint.source + "（AK sha256[:12]=" + report.keyFingerprint.ak_sha256_12 + "，SK sha256[:12]=" + report.keyFingerprint.sk_sha256_12 + "；不落明文）");
  lines.push("- 生成提示词：" + JSON.stringify(report.generation.prompt) + "，mode=" + JSON.stringify(report.generation.mode));
  lines.push("- 应用内（UI / market:ui）未验证：依赖尚未实现的「模型出网代理」；本探针只覆盖服务与适配器层。", "");
  lines.push("## 检查项", "");
  lines.push("| # | 检查 | 结果 | 证据 |", "| --- | --- | --- | --- |");
  report.records.forEach((r, i) => { lines.push("| " + (i + 1) + " | " + r.name + " | " + (r.pass ? "PASS" : "FAIL") + " | " + String(r.actual).slice(0, 300) + " |"); });
  lines.push("", "## 真实生成证据", "");
  lines.push("- 耗时：" + report.generation.elapsedMs + " ms；轮询次数：" + report.generation.polls + "；状态序列：" + report.generation.statusSequence.join(" → "));
  lines.push("- thread_id：" + report.generation.threadId + "；project_id：" + report.generation.projectId);
  lines.push("- 产物 URL host：" + report.generation.artifactHost);
  lines.push("- 产物字节：" + report.generation.bytes + "；魔数：" + report.generation.magic + "；像素：" + report.generation.width + "×" + report.generation.height);
  lines.push("- sha256：" + report.generation.sha256);
  lines.push("- 落盘：" + report.generation.localFile);
  lines.push("", "## 真实请求轨迹", "");
  report.trace.forEach((t) => { lines.push("- " + t.method + " " + t.path + (t.threadStatus ? " [" + t.threadStatus + "]" : "") + " → HTTP " + t.status + "（" + t.ms + "ms）"); });
  if (report.error) lines.push("", "## 原始错误", "", JSON.stringify(report.error, null, 2));
  lines.push("");
  fs.writeFileSync(path.join(OUT_DIR, "REPORT.md"), lines.join("\n"));
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const keys = loadKeys();
  const credentialJson = lovart.serializeCredential(keys);
  const keyFingerprint = { source: KEY_PATH, ak_sha256_12: sha12(keys.accessKey), sk_sha256_12: sha12(keys.secretKey) };
  console.log("· 代理 " + PROXY + " → " + BASE_URL);
  console.log("· 凭据 AK sha256[:12]=" + keyFingerprint.ak_sha256_12 + " SK sha256[:12]=" + keyFingerprint.sk_sha256_12 + "（不落明文）");

  const report = {
    kind: "dxos-lovart-live", at: new Date().toISOString(), proxy: PROXY, baseUrl: BASE_URL,
    keyFingerprint, records: [], trace, statusSequence,
    generation: { prompt: PROMPT, mode: MODE, attempted: false, ok: false, elapsedMs: null, polls: 0, statusSequence: [], threadId: null, projectId: null, artifactHost: null, bytes: null, magic: null, width: null, height: null, sha256: null, localFile: null },
    applicationInApp: { verified: false, reason: "UI 走 market/ui 链路，依赖尚未实现的「模型出网代理」功能；本探针只验证服务/适配器层。" },
  };

  /* ── 1) provider/models：ModelService.listRemoteModels → 真站 catalog ── */
  const fixture = await createModelFixture({ fetchImpl: proxyFetch, timeoutMs: 20000 });
  let remoteItems = [];
  try {
    const admin = fixture.adminCtx();
    const context = { sessionRef: admin.sessionRef, appId: "ai" };
    fixture.modelService.grantAppModelAccess({ context: admin, appId: "ai", actions: ["model.view", "model.use", "model.manage", "model.test"] });
    const created = fixture.modelService.createProvider({ context, displayName: "Lovart Live", baseUrl: BASE_URL, adapterType: "lovart", credentialSecret: credentialJson });
    record("L0 · provider/create adapterType=lovart", created.ok === true && created.provider && created.provider.adapterType === "lovart",
      "ok:true + adapterType:lovart", JSON.stringify({ ok: created.ok, providerId: created.provider && created.provider.providerId, adapterType: created.provider && created.provider.adapterType, error: created.error }));

    const remote = await fixture.modelService.listRemoteModels({ context, providerId: created.provider.providerId });
    remoteItems = remote && Array.isArray(remote.items) ? remote.items : [];
    const byCategory = remoteItems.reduce((acc, item) => { const key = item.category || "NONE"; acc[key] = (acc[key] || 0) + 1; return acc; }, {});
    record("L1 · provider/models 真站 catalog = 53 个工具", remote.ok === true && remoteItems.length === 53,
      "ok:true + 53 项", JSON.stringify({ ok: remote.ok, count: remoteItems.length, byCategory, error: remote.error }));
    record("L2 · 分类口径 IMAGE=34 / VIDEO=19", byCategory.IMAGE === 34 && byCategory.VIDEO === 19,
      "IMAGE=34, VIDEO=19", JSON.stringify(byCategory));
    const imageItems = remoteItems.filter((item) => item.category === "IMAGE");
    record("L3 · IMAGE 能力建议全部为 image-generation", imageItems.length === 34 && imageItems.every((item) => Array.isArray(item.suggestedCapabilities) && item.suggestedCapabilities.join(",") === "image-generation"),
      "34/34 image-generation", JSON.stringify(imageItems.slice(0, 3).map((item) => ({ id: item.id, caps: item.suggestedCapabilities }))));

    if (imageItems.length) {
      const model = fixture.modelService.createModel({ context, providerId: created.provider.providerId, remoteModelId: imageItems[0].id, capabilities: ["image-generation"] });
      const tested = await fixture.modelService.testConnection({ context, configId: model.model && model.model.configId });
      record("L4 · model/test 走签名 POST /mode/query（catalog 公开，验不了凭据）",
        tested.ok === true && tested.credentialAccepted === true && tested.inference === false && tested.probe === "mode/query",
        "ok:true + credentialAccepted:true + inference:false + probe:mode/query", JSON.stringify(tested));
    }
  } finally {
    try { fixture.close(); } catch { /* ignore */ }
  }
  report.records = records;

  // 允许只做离线/免额度复验（provider/models + model/test），不触发真实生成。
  if (process.env.OA_LOVART_SKIP_GENERATE === "1") {
    report.passed = records.every((r) => r.pass);
    writeReports(report);
    console.log("\nOA_LOVART_SKIP_GENERATE=1：跳过真实生成（不消耗额度）。");
    return report.passed ? 0 : 1;
  }

  /* ── 2) image/generate：真站真实生成 + a.lovart.ai 真实下载 ─────────── */
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-lovart-live-"));
  const providerId = "p_lovart_live";
  const provider = () => ({ id: providerId, name: "Lovart Live", base_url: BASE_URL, protocol: "lovart", api_key: credentialJson, enabled: true, models: [] });
  const store = { get: (id) => (String(id) === providerId ? provider() : null), listInternal: () => [provider()] };
  const service = new ProviderProtocolService({ store, userDataDir: tmpDir, fetchImpl: proxyFetch, clock: () => Date.now(), timeoutMs: TIMEOUT_MS });

  report.generation.attempted = true;
  const startedAt = Date.now();
  // model=null：不复刻 tool_config（软偏好），照用户已跑通的手工流：chat{prompt,project_id,mode}。
  const generated = await service.generateImage({ providerId, model: null, prompt: PROMPT, params: { mode: MODE } });
  report.generation.elapsedMs = Date.now() - startedAt;
  report.generation.statusSequence = [...statusSequence];

  if (!generated.ok) {
    report.generation.detail = generated.detail || null;
    report.error = { error: generated.error || null, detail: generated.detail || null, requestId: generated.requestId || null, httpTrace: trace };
    record("L5 · image/generate 真实生成成功", false, "ok:true", JSON.stringify({ error: generated.error, detail: generated.detail }));
    console.log("\n原始错误（不重试）：" + JSON.stringify(report.error));
    report.records = records;
    report.passed = false;
    writeReports(report);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return 1;
  }

  const image = generated.images && generated.images[0];
  report.generation.ok = true;
  report.generation.polls = generated.lovart && generated.lovart.polls != null ? generated.lovart.polls : statusSequence.length;
  report.generation.threadId = generated.lovart && generated.lovart.threadId || null;
  report.generation.projectId = generated.lovart && generated.lovart.projectId || null;
  report.generation.artifactHost = image && image.url ? new URL(image.url).hostname : null;

  record("L5 · image/generate 真实生成成功", true, "ok:true", JSON.stringify({ ok: generated.ok, images: generated.images.length, lovart: generated.lovart }));
  record("L6 · 产物主机 = a.lovart.ai（新增白名单已放行）", report.generation.artifactHost === "a.lovart.ai",
    "a.lovart.ai", String(report.generation.artifactHost));

  const savedPath = path.join(tmpDir, "dxos", "media", String(image && image.fileName || ""));
  const exists = !!image && image.saved !== false && fs.existsSync(savedPath);
  record("L7 · 产物经 a.lovart.ai 真实下载并落盘 dxos/media", exists,
    "saved:true + 文件存在", JSON.stringify({ fileName: image && image.fileName, exists, saved: image && image.saved }));
  if (exists) {
    const buffer = fs.readFileSync(savedPath);
    const info = pngInfo(buffer);
    report.generation.bytes = buffer.length;
    report.generation.magic = info.magic;
    report.generation.width = info.width;
    report.generation.height = info.height;
    report.generation.sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    const localFile = path.join(OUT_DIR, "lovart-live-generated.png");
    fs.copyFileSync(savedPath, localFile);
    report.generation.localFile = localFile;
    record("L8 · 产物是真实 PNG（魔数 89504e470d0a1a0a）", info.magic === "89504e470d0a1a0a", "89504e470d0a1a0a", info.magic);
    record("L9 · 真实像素尺寸 > 0", info.width > 0 && info.height > 0, ">0", info.width + "×" + info.height);
  }
  record("L10 · 轮询序列以 done 收尾", statusSequence.length > 0 && statusSequence[statusSequence.length - 1] === "done",
    "…→done", statusSequence.join("→") || "(无)");

  const rawMap = { "/v1/openapi/tools/catalog": "catalog-live.json", "/v1/openapi/mode/query": "mode-query-live.json", "/v1/openapi/chat/result": "chat-result-live.json" };
  for (const [endpoint, file] of Object.entries(rawMap)) {
    if (rawResponses[endpoint] !== undefined) fs.writeFileSync(path.join(OUT_DIR, file), rawResponses[endpoint]);
  }

  report.records = records;
  report.passed = records.every((r) => r.pass);
  const serialized = JSON.stringify(report);
  const leaked = serialized.includes(keys.accessKey) || serialized.includes(keys.secretKey);
  record("L11 · 报告不含 AK/SK 明文", leaked === false, "不出现明文", leaked ? "存在明文（必须修）" : "仅 sha256[:12] 指纹");
  report.records = records;
  report.passed = records.every((r) => r.pass);
  writeReports(report);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log("\n落盘：" + OUT_DIR);
  console.log("PASS=" + records.filter((r) => r.pass).length + " FAIL=" + records.filter((r) => !r.pass).length);
  return report.passed ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  const message = String((error && error.stack) || error).slice(0, 2000);
  console.error("探针异常：" + message);
  try {
    writeReports({
      kind: "dxos-lovart-live", at: new Date().toISOString(), proxy: PROXY, baseUrl: BASE_URL,
      keyFingerprint: { source: KEY_PATH }, records, trace, statusSequence,
      generation: { prompt: PROMPT, mode: MODE, attempted: false, ok: false, statusSequence: [] },
      applicationInApp: { verified: false, reason: "探针异常中断" },
      error: { error: "PROBE_EXCEPTION", detail: message },
      passed: false,
    });
  } catch { /* ignore */ }
  process.exitCode = 1;
}
