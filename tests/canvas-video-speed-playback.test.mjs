/**
 * 10-29 画布视频：生成提速 + 播放进度条 + 参数随模型。
 *   · Lovart 视频：send 带 mode=fast 与 include_tools=[所选模型]；轮询次数按总时长放开（不再 100 次就判超时）
 *   · APIMart 任务轮询最长间隔 5s
 *   · 音视频预览能力地址：Range 不截成 8MB（Chromium 对自定义协议拿到截短的 206 不会续请求，拖到后段直接播完）
 *   · 画布播放走 canvas/assetMediaUrl 流式地址；视频生成的参考图不再先传临时图床
 *   · 视频编辑器参数弹层只列当前模型支持的取值
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const lovart = require("../electron/provider-adapter-lovart.cjs");
const search = require("../electron/search-domain.cjs");
const read = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");
const cred = lovart.serializeCredential({ accessKey: "ak", secretKey: "sk" });

function fakeLovart({ runningPolls }) {
  const seen = { chat: null, polls: 0 };
  const json = (data) => new Response(JSON.stringify({ code: 0, data }), { status: 200, headers: { "content-type": "application/json" } });
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/project/save")) return json({ project_id: "p1" });
    if (u.pathname.endsWith("/chat")) { seen.chat = JSON.parse(init.body); return json({ thread_id: "t1" }); }
    if (u.pathname.endsWith("/chat/status")) { seen.polls += 1; return json({ status: seen.polls > runningPolls ? "done" : "running" }); }
    if (u.pathname.endsWith("/chat/result")) return json({ items: [{ artifacts: [{ type: "video", content: "https://a.lovart.ai/artifacts/agent/x.mp4" }] }] });
    return new Response("nf", { status: 404 });
  };
  return { seen, fetchImpl };
}

test("Lovart 视频：明确 fast 推理模式 + include_tools 指定所选模型", async () => {
  const { seen, fetchImpl } = fakeLovart({ runningPolls: 2 });
  const out = await lovart.generateVideo({ baseUrl: "https://lgw.lovart.ai", apiKey: cred, model: "generate_video_seedance_v2_5", prompt: "海边", params: { ratio: "16:9", duration: 5 }, fetchImpl, pollIntervalMs: 1 });
  assert.equal(out.ok, true);
  assert.equal(seen.chat.mode, "fast");
  assert.deepEqual(seen.chat.tool_config.include_tools, ["generate_video_seedance_v2_5"]);
  assert.deepEqual(seen.chat.tool_config.prefer_tool_categories, { VIDEO: ["generate_video_seedance_v2_5"] });
});

test("Lovart 视频：做得久（>100 次轮询）也等到出片，不在 5 分钟处判超时", async () => {
  const { seen, fetchImpl } = fakeLovart({ runningPolls: 150 });
  const out = await lovart.generateVideo({ baseUrl: "https://lgw.lovart.ai", apiKey: cred, model: "generate_video_kling_v3", prompt: "x", fetchImpl, timeoutMs: 1800000, pollIntervalMs: 1 });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(seen.polls > 100);
  assert.equal(out.artifacts[0].url, "https://a.lovart.ai/artifacts/agent/x.mp4");
});

test("APIMart 任务轮询最长间隔 5s（原 12s）", () => {
  const src = read("electron/provider-adapter-apimart.cjs");
  assert.match(src, /const POLL_MAX_MS = 5000;/);
  assert.doesNotMatch(src, /Math\.min\(12000, Math\.round\(delay \* 1\.6\)\)/);
});

test("Range：默认仍截 8MB；音视频可整段流式返回", () => {
  const size = 40 * 1024 * 1024;
  const capped = search.parseRange("bytes=0-", size);
  assert.equal(capped.range.end, 8 * 1024 * 1024 - 1);
  const media = search.parseRange("bytes=0-", size, { maxBytes: Number.MAX_SAFE_INTEGER });
  assert.equal(media.range.end, size - 1);
  const tail = search.parseRange("bytes=20000000-", size, { maxBytes: Number.MAX_SAFE_INTEGER });
  assert.equal(tail.range.start, 20000000); assert.equal(tail.range.end, size - 1);
  const pv = read("electron/preview-service.cjs");
  assert.match(pv, /cap\.kind === domain\.PREVIEW_KIND\.VIDEO \|\| cap\.kind === domain\.PREVIEW_KIND\.AUDIO/);
});

test("画布播放走流式地址：命令已放行、服务铸 6 小时能力地址、节点用 useMediaUrl", () => {
  const boot = read("electron/canvas-bootstrap.cjs");
  assert.match(boot, /"canvas\/assetMediaUrl"/);
  const svc = read("electron/canvas-service.cjs");
  assert.match(svc, /assetMediaUrl\(\{ context, ref \} = \{\}\)/);
  assert.match(svc, /MEDIA_URL_TTL_MS = 6 \* 60 \* 60 \* 1000/);
  assert.match(read("electron/identity-bootstrap.cjs"), /attachRuntime\(\{ taskService, modelService, webAccess, previewService,/);
  const nv = read("src/canvas/canvas-next/ui/NodeView.tsx");
  assert.match(nv, /useMediaUrl\(out\.url \|\| ""\)/);
  assert.match(nv, /function VideoControls/);
  assert.doesNotMatch(nv, /<video ref=\{vref\}[^>]*\bcontrols\b/);
});

test("视频生成的参考图不再先传临时图床（主进程按资源引用自己读）", () => {
  const br = read("src/canvas/canvas-next/backend/bridge.ts");
  assert.match(br, /if \(media && x\.kind === "image"\) return \{ \.\.\.x, url: await localRef\(req\.canvasId, x\.url\) \};/);
});

test("视频参数弹层：底栏一个入口，弹层只列当前模型支持的取值", () => {
  const gp = read("src/canvas/canvas-next/ui/GenPanel.tsx");
  assert.match(gp, /data-p="vset"/);
  assert.match(gp, /if \(k === "vset"\) return pop\(\(\) => <VideoSetPop node=\{node\} m=\{mm\} disabled=\{dis\} \/>\);/);
  assert.match(gp, /data-vopt=\{"dur:" \+ d\}/);
});
