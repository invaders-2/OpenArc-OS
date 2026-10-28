import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { skillInstallIntent } from "../src/canvas/canvas-next/agent/skillInstallIntent.ts";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "node_modules/.cache/oa-skill-install-card-" + process.pid + ".mjs");
const CLIENT_OUT = path.join(ROOT, "node_modules/.cache/oa-skill-install-client-" + process.pid + ".mjs");
await Promise.all([
  esbuild.build({ entryPoints: [path.join(ROOT, "src/canvas/canvas-next/agent/SkillInstallCard.tsx")], bundle: true, format: "esm", platform: "node", external: ["react", "react-dom"], outfile: OUT, logLevel: "silent" }),
  esbuild.build({ entryPoints: [path.join(ROOT, "src/canvas/canvas-next/agent/skillInstallClient.ts")], bundle: true, format: "esm", platform: "node", outfile: CLIENT_OUT, logLevel: "silent" }),
]);
const { SkillInstallCard } = await import(pathToFileURL(OUT).href);
const { inspectSkillRepository, installSkillPreview } = await import(pathToFileURL(CLIENT_OUT).href);
test.after(() => { fs.rmSync(OUT, { force: true }); fs.rmSync(CLIENT_OUT, { force: true }); });

const preview = {
  previewId: "preview_1", repository: "owner/repo", sourceUrl: "https://github.com/owner/repo",
  branch: "main", commit: "0123456789abcdef0123456789abcdef01234567", sha256: "ab".repeat(32),
  skills: [{ name: "Demo Skill", description: "读取输入并输出摘要", path: "skills/demo/SKILL.md" }],
  scripts: ["scripts/install.py"], excluded: [".git", "node_modules"], bytes: 1024, expiresAt: Date.now() + 1000,
};

test("Agent 只把明确安装意图识别为预览，不把普通终端或讨论链接当安装", () => {
  for (const value of [
    "https://github.com/owner/repo", "npx skills add https://github.com/owner/repo",
    "安装 Skill https://github.com/owner/repo", "请导入技能：https://github.com/owner/repo.git",
  ]) assert.ok(skillInstallIntent(value), value);
  for (const value of [
    "解释一下 https://github.com/owner/repo", "git clone https://github.com/owner/repo",
    "npx skills add https://modelscope.cn/skills/owner/repo", "https://github.com/owner/repo/tree/main",
    "https://user:secret@github.com/owner/repo", "rm -rf /tmp/demo", "",
  ]) assert.equal(skillInstallIntent(value), null, value);
});

test("预览和确认使用不同受控 IPC，不发送用户身份或执行 shell", async () => {
  const calls = [];
  globalThis.window = { openarc: { skill: { command: async (request) => {
    calls.push(request);
    if (request.command === "skill/pack/inspectOnline") return { ok: true, value: { preview } };
    if (request.command === "skill/pack/installStaged") return { ok: true, value: { pack: { id: "pack_1" }, skills: [{ id: "skill_1", enabled: false }] } };
    return { ok: false, error: "UNEXPECTED" };
  } } } };
  const inspected = await inspectSkillRepository("https://github.com/owner/repo");
  assert.equal(inspected.previewId, "preview_1");
  assert.deepEqual(calls, [{ command: "skill/pack/inspectOnline", payload: { source: "https://github.com/owner/repo" } }]);
  const installed = await installSkillPreview("preview_1");
  assert.deepEqual(installed, { packId: "pack_1", skillCount: 1 });
  assert.deepEqual(calls[1], { command: "skill/pack/installStaged", payload: { previewId: "preview_1" } });
  assert.equal(JSON.stringify(calls).includes("userId"), false);
  delete globalThis.window;
});

test("安装卡展示固定版本、脚本风险和默认停用，失败保留重试，取消后无确认按钮", () => {
  const render = (value) => renderToStaticMarkup(React.createElement(SkillInstallCard, { value, onConfirm: () => {}, onCancel: () => {}, onManage: () => {} }));
  const ready = render({ status: "ready", source: preview.sourceUrl, preview });
  assert.match(ready, /0123456789ab/);
  assert.match(ready, /Demo Skill/);
  assert.match(ready, /scripts\/install\.py/);
  assert.match(ready, /默认不启用/);
  assert.match(ready, /确认导入/);
  assert.doesNotMatch(ready, /正在读取公开仓库/);
  const failed = render({ status: "error", source: preview.sourceUrl, preview, error: "网络中断" });
  assert.match(failed, /网络中断/);
  assert.match(failed, /重试导入/);
  const installed = render({ status: "installed", source: preview.sourceUrl, preview, skillCount: 1 });
  assert.match(installed, /已导入 · 未启用/);
  assert.match(installed, /管理 Skill/);
  assert.doesNotMatch(installed, /确认导入/);
  const cancelled = render({ status: "cancelled", source: preview.sourceUrl, preview });
  assert.match(cancelled, /已取消/);
  assert.doesNotMatch(cancelled, /确认导入/);
});

test("实际 Agent 在普通任务之前拦截安装意图，确认只能来自卡片操作", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src/canvas/tapnow/AgentPanel.tsx"), "utf8");
  assert.ok(source.indexOf("if (installSource) { await inspectRepository") < source.indexOf("if (store.backend.runAgentTask)"));
  assert.match(source, /onSkillInstallConfirm=\{\(\) => void confirmRepositoryInstall\(m\)\}/);
  const card = fs.readFileSync(path.join(process.cwd(), "src/canvas/canvas-next/agent/SkillInstallCard.tsx"), "utf8");
  assert.match(card, /data-skill-install/);
  assert.doesNotMatch(source, /skillInstallIntent[\s\S]{0,800}runAgentTask\(\{ goal: installSource/);
});
