/**
 * task-41 · 生成失败诊断日志（canvas/diagLog）。
 *
 * 背景：用户视频失败但真机没有新 run（失败发生在发请求前），数据库看不到原因。
 * 修法：bridge 在 generate / editImage 的 catch 里调一次 canvas/diagLog，
 * 主进程把 { at, canvasId, nodeId, kind, code, detail, stage } 写 userData/logs/canvas-errors.log，
 * 单文件 ≤2MB 轮转一次，落盘前脱敏（data URL / 密钥 / URL userinfo），不改生成结果。
 *
 * 覆盖：
 *   ① 写入器：字段截断 + 脱敏 + 非法输入拒绝；
 *   ② 轮转：超过 2MB 阈值时旧文件转成 .1，新文件继续写；
 *   ③ 命令：canvas/diagLog 已登记、走 registerCanvasIpc 真正落盘；
 *   ④ bridge：生成失败时恰好调用一次 diagLog（esbuild 打真实 bridge.ts，注入假 canvas 命令）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const canvasBootstrap = require("../electron/canvas-bootstrap.cjs");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tempDir(prefix = "oa-diag-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/* ══ ① 写入器：截断 / 脱敏 / 非法输入 ══ */

test("① diagLog 写入器：字段截断到上限、落盘脱敏、非法输入拒绝且不落盘", () => {
  const dir = tempDir();
  try {
    const logger = canvasBootstrap.createDiagLogger({ dir, now: () => 1700000000000 });
    const long = "长".repeat(5000);
    const ok = logger.write({
      canvasId: "c".repeat(300),
      nodeId: "n".repeat(300),
      kind: "k".repeat(100),
      code: "code".repeat(100),
      detail: long,
      stage: "s".repeat(200),
    });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const line = fs.readFileSync(path.join(dir, canvasBootstrap.DIAG_LOG_FILE), "utf8").trim();
    const entry = JSON.parse(line);
    assert.deepEqual(Object.keys(entry).sort(), ["at", "canvasId", "code", "detail", "kind", "nodeId", "stage"]);
    assert.equal(entry.canvasId.length, canvasBootstrap.DIAG_LIMITS.canvasId);
    assert.equal(entry.nodeId.length, canvasBootstrap.DIAG_LIMITS.nodeId);
    assert.equal(entry.kind.length, canvasBootstrap.DIAG_LIMITS.kind);
    assert.equal(entry.code.length, canvasBootstrap.DIAG_LIMITS.code);
    assert.equal(entry.detail.length, canvasBootstrap.DIAG_LIMITS.detail);
    assert.equal(entry.stage.length, canvasBootstrap.DIAG_LIMITS.stage);
    assert.equal(entry.at, 1700000000000);

    // 脱敏：data URL / 密钥 / URL userinfo 都不能原样落盘
    const sentinel = "data:image/png;base64," + "A".repeat(3000);
    logger.write({
      at: 1, canvasId: "cv_1", nodeId: "n_1", kind: "video", code: "PROVIDER_UPLOAD_TOO_LARGE",
      detail: "upload failed key sk-live1234567890 Bearer abcdef123456 url https://user:pass@example.com/x " + sentinel,
      stage: "generate",
    });
    const text = fs.readFileSync(path.join(dir, canvasBootstrap.DIAG_LOG_FILE), "utf8");
    assert.equal(text.includes("sk-live1234567890"), false, "密钥不能落盘");
    assert.equal(text.includes("abcdef123456"), false, "Bearer token 不能落盘");
    assert.equal(text.includes("user:pass@"), false, "URL userinfo 不能落盘");
    assert.equal(text.includes("A".repeat(200)), false, "data URL 主体不能落盘");
    assert.match(text, /<redacted-key>/);
    assert.match(text, /<data-url:image\/png>/);
    assert.match(text, /\/\/<redacted>@example\.com/);

    const before = fs.statSync(path.join(dir, canvasBootstrap.DIAG_LOG_FILE)).size;
    for (const bad of [null, undefined, 42, "str", [], {}, { canvasId: "c" }]) {
      const rejected = logger.write(bad);
      assert.equal(rejected.ok, false, "非法 payload 必须拒绝：" + JSON.stringify(bad));
      assert.equal(rejected.error, "INVALID_INPUT");
    }
    assert.equal(fs.statSync(path.join(dir, canvasBootstrap.DIAG_LOG_FILE)).size, before, "被拒绝的输入不得写半条");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ══ ② 轮转（≤2MB 轮转一次） ══ */

test("② 轮转：超过阈值时当前日志转成 .1，新文件继续写（不无限增长）", () => {
  const dir = tempDir();
  try {
    const maxBytes = 350;
    const logger = canvasBootstrap.createDiagLogger({ dir, maxBytes });
    const write = (n) => logger.write({ at: n, canvasId: "cv", nodeId: "n", kind: "image", code: "CODE_" + n, detail: "d".repeat(120), stage: "generate" });
    const first = write(1);
    assert.equal(first.ok, true);
    const second = write(2);
    assert.equal(second.ok, true);
    assert.equal(second.rotated, true, "第二次超过阈值必须轮转");
    const file = path.join(dir, canvasBootstrap.DIAG_LOG_FILE);
    assert.equal(fs.existsSync(file + ".1"), true, "旧文件应转成 .1");
    assert.match(fs.readFileSync(file + ".1", "utf8"), /CODE_1/);
    const current = fs.readFileSync(file, "utf8");
    assert.match(current, /CODE_2/);
    assert.equal(current.includes("CODE_1"), false, "新文件从空开始");
    assert.ok(fs.statSync(file).size <= maxBytes, "当前文件不得超过阈值");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ══ ③ canvas/diagLog 命令：登记 + 落盘 + 拒绝非法 payload ══ */

test("③ canvas/diagLog 已登记，走 registerCanvasIpc 真正写盘；非法输入返回 INVALID_INPUT", async () => {
  assert.ok(canvasBootstrap.RENDERER_COMMANDS.includes("canvas/diagLog"), "命令必须进渲染层白名单");
  const dir = tempDir();
  let handler = null;
  const ipcMain = { handle: (channel, fn) => { if (channel === "canvas:command") handler = fn; }, removeHandler: () => {} };
  try {
    canvasBootstrap.registerCanvasIpc({ ipcMain, service: {}, identity: { current: "sess_probe" }, isTrusted: () => true, diagLogDir: dir });
    assert.equal(typeof handler, "function", "canvas:command handler 必须注册");
    const ok = await handler({}, { command: "canvas/diagLog", payload: { at: 42, canvasId: "cv_1", nodeId: "n_1", kind: "video", code: "PROVIDER_UPLOAD_TOO_LARGE", detail: "参考图上传失败", stage: "generate" } });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const file = path.join(dir, canvasBootstrap.DIAG_LOG_FILE);
    const entry = JSON.parse(fs.readFileSync(file, "utf8").trim());
    assert.deepEqual({ canvasId: entry.canvasId, nodeId: entry.nodeId, kind: entry.kind, code: entry.code, stage: entry.stage, at: entry.at }, {
      canvasId: "cv_1", nodeId: "n_1", kind: "video", code: "PROVIDER_UPLOAD_TOO_LARGE", stage: "generate", at: 42,
    });
    const rejected = await handler({}, { command: "canvas/diagLog", payload: null });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error, "INVALID_INPUT");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ══ ④ bridge：生成失败时恰好调用一次 diagLog ══ */

test("④ bridge.generate 失败：调用一次 canvas/diagLog（真实 bridge.ts，注入假命令），错误照常抛给上层", async () => {
  const bundlePath = path.join(os.tmpdir(), "oa-diag-bridge-" + process.pid + ".mjs");
  await esbuild.build({ entryPoints: [path.join(ROOT, "src/canvas/canvas-next/backend/bridge.ts")], bundle: true, format: "esm", platform: "neutral", outfile: bundlePath, logLevel: "silent" });
  try {
    const commands = [];
    globalThis.window = {
      openarc: {
        canvas: {
          command: async (raw) => {
            commands.push(raw);
            if (raw && raw.type === "canvas/run") return { ok: false, error: "MODEL_CONFIG_UNAVAILABLE", detail: "模型已停用" };
            if (raw && raw.type === "canvas/diagLog") return { ok: true };
            return { ok: true };
          },
        },
      },
    };
    const mod = await import(pathToFileURL(bundlePath).href);
    const backend = mod.createBridgeBackend();
    const raw = {
      canvasId: "cv_diag", nodeId: "n_diag", kind: "image",
      model: { id: "mcf_diag", name: "seedream", kind: "image", vendor: "APIMART", secs: 10, n: 1 },
      prompt: "画一只猫", resolvedPrompt: "画一只猫",
      params: { model: "mcf_diag", ratio: "1:1", size: "1K", count: 1, search: false, style: "无", camera: { on: false, body: 0, lens: 0, focal: 2, aperture: 3 } },
      inputs: [],
    };
    await assert.rejects(() => backend.generate(raw, () => {}, new AbortController().signal), (error) => error && error.code === "MODEL_CONFIG_UNAVAILABLE");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const diag = commands.filter((item) => item && item.type === "canvas/diagLog");
    assert.equal(diag.length, 1, "失败时必须恰好报一次诊断：" + JSON.stringify(commands.map((c) => c && c.type)));
    const payload = diag[0].payload;
    assert.deepEqual({ canvasId: payload.canvasId, nodeId: payload.nodeId, kind: payload.kind, code: payload.code, stage: payload.stage }, {
      canvasId: "cv_diag", nodeId: "n_diag", kind: "image", code: "MODEL_CONFIG_UNAVAILABLE", stage: "generate",
    });
    assert.match(String(payload.detail), /模型已停用/);
    assert.equal(typeof payload.at, "number");
    assert.equal(JSON.stringify(payload).includes("sk-"), false, "bridge 只传失败事实，不传凭据");
  } finally {
    try { fs.rmSync(bundlePath, { force: true }); } catch { /* ignore */ }
    delete globalThis.window;
  }
});
