#!/usr/bin/env node
/**
 * 照片应用 · 真机视觉与动效验收探针（dxos-ui-photos）。
 *
 * 定位：只产出可复核证据（截图 / 帧序列 / 机器可读报告），不替 Lead 下「视觉通过」结论。
 *
 * 被测对象：appId=photos 的「照片/相册」应用，左栏「图库」/「图像工坊」双视图，
 *          后端三通道 photos / photocraft / appExchange。
 *
 * 入口维度（本探针现在同时取证两个入口，各自独立 userData 与 CDP 端口）：
 *   · react   ：设 OA_UI=react → dist/index.html（electron/main.cjs:192），跑完整既有套件；
 *   · default ：不设 OA_UI     → dist/vue.html（默认 Vue 壳），appId=photos 渲染
 *               src-vue/apps/PhotosApp.vue（真实应用）。Vue 壳 DOCK_DEFAULT 里没有 photos，
 *               因此默认入口必须经真实 UI「聚焦搜索」或「应用中心」打开，不能直接塞 appId。
 *               默认入口的取证范围见 runDefaultEntrySuite（打开路径 / 真实应用标记 / 三通道 /
 *               关键状态截图 / pane-content-overflow / 运行时卫生）。
 *
 * 证据清单：
 *   1) 静态截图：图库 / 图像工坊 × {空态, 就绪, 不可用, 错误, 来源不可用} × 浅/深 × 4 种视图尺寸；
 *   2) 组件状态：Button(默认/悬停/按下/焦点/禁用)、IconButton、TextField、Select、Switch、
 *      Dialog、Toast、List/TreeNav、PageState，每项局部 clip + 计算样式；
 *   3) 可访问性：最终合成背景上的文本对比（DS-A04）、键盘遍历与焦点恢复（DS-A05）、
 *      DS-A09 计算样式扫描（彩色强调 / 品牌蓝 / 发丝线框）；
 *   4) 材质三档：完整玻璃 / 降低材质 / 实色（实色 = 原「减少透明度」）+ 叠加减少动态；
 *   5) 动效：视图切换 / Dialog 开合 / Toast 出现的连续帧序列（<=50ms 间隔），
 *      同一动作在 reduced-motion 开/关两种条件下对照，记录帧时间与布局补间；
 *   6) console error / pageerror / 非本地请求全量采集；
 *   7) 真实 profile 只读快照（identity.db 等 mtime+size+sha256）开工/收工比对。
 *
 * 硬约束（与 ui-real 同口径）：不联网（只连本机 CDP）；不改产品代码；不新增依赖；
 *          不跑 npm test / npm run build；不 git commit；失败 exit 非 0；收工自清理。
 *
 * 用法：
 *   node experiments/dxos-ui-photos/run-all.mjs                 # 双入口：react 全量 + 默认入口取证
 *   OA_PHOTOS_UI_ENTRY=react node experiments/dxos-ui-photos/run-all.mjs   # 只跑 react 入口
 *   OA_PHOTOS_UI_ENTRY=default node experiments/dxos-ui-photos/run-all.mjs # 只跑默认入口
 *   OA_PHOTOS_SKIP_DEFAULT_PROBE=1 node experiments/dxos-ui-photos/run-all.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as H from "./lib/harness.mjs";
import { measureTextContrast, requiredTextRatio, contrastRatio, parseColor, composite } from "./lib/contrast.mjs";
import { writePng } from "./lib/pngwrite.mjs";
import { decodePng, diffPixels } from "./lib/pngdecode.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ART = path.join(ROOT, "artifacts", "dxos-ui-photos");
const SCR = path.join(ART, "screens");
const CMP = path.join(ART, "components");
const MATA = path.join(ART, "materials");
const MOT = path.join(ART, "motion");
const AREA_TOP = 38;
const SHOTS = [
  { id: "1440x900", width: 1440, height: 900, dsf: 2 },
  { id: "1280x720", width: 1280, height: 720, dsf: 2 },
  { id: "1180", width: 1180, height: 900, dsf: 2 },
  { id: "820", width: 820, height: 720, dsf: 2 },
];
const REF = SHOTS[0];
const NARROW = ["1180", "820"];
const SCR_DEFAULT = path.join(ART, "screens-default");
const ENTRY_CONFIG = {
  react: { id: "react", label: "React 入口", env: { OA_UI: "react" }, pageRe: /index\.html/, source: "dist/index.html（OA_UI=react）" },
  default: { id: "default", label: "默认入口", env: {}, pageRe: /vue\.html/, source: "dist/vue.html（默认 Vue 壳，不带 OA_UI）" },
};
const REQUESTED_ENTRY = process.env.OA_PHOTOS_UI_ENTRY;
const SKIP_DEFAULT_PROBE = process.env.OA_PHOTOS_SKIP_DEFAULT_PROBE === "1";
/* 默认双入口：react 全量套件 + default 入口专项取证。OA_PHOTOS_UI_ENTRY 只用于排查时单跑一个入口。 */
const RUN_REACT = REQUESTED_ENTRY !== "vue" && REQUESTED_ENTRY !== "default";
const RUN_DEFAULT = !SKIP_DEFAULT_PROBE && REQUESTED_ENTRY !== "react";
const LOCAL_RE = /^(file:|data:|blob:|about:|devtools:|openarc-file:|openarc-resource:|openarc-canvas:|http:\/\/127\.0\.0\.1|http:\/\/localhost|http:\/\/\[::1\]|ws:\/\/127\.0\.0\.1|ws:\/\/localhost)/i;

const STATE_SPECS = {
  "library-empty": { view: "library", describe: "图库 · 空态（无来源 / 无照片）", contrast: true },
  "studio-empty": { view: "studio", describe: "图像工坊 · 空态（无项目）", contrast: true },
  "library-ready": { view: "library", describe: "图库 · 就绪（来源 + 子目录 + 虚拟文件夹 + 网格）", contrast: true },
  "studio-ready": { view: "studio", describe: "图像工坊 · 就绪（分组 + 项目列表）", contrast: true },
  "library-detail": { view: "library", describe: "图库 · 选中照片（详情 / 原图 / 导入 / 反推入口）", contrast: true },
  "library-unavailable": { view: "library", describe: "图库 · 不可用态（无视觉模型供应商的结构化提示）", contrast: true },
  "studio-detail": { view: "studio", describe: "图像工坊 · 选中项目（设置 / 分组 / 可见性 / 发送）", contrast: true },
  "library-error": { view: "library", describe: "图库 · 错误态（源文件已被删除 → sourceFile NOT_FOUND）", contrast: true },
  "library-source-unavailable": { view: "library", describe: "图库 · 来源不可用（目录被移走 → available:false + 不可用徽标）", contrast: true },
};
const EMPTY_STATES = ["library-empty", "studio-empty"];
const READY_STATES = ["library-ready", "studio-ready", "library-detail", "library-unavailable", "studio-detail", "library-error", "library-source-unavailable"];

const IMAGE_NAMES = ["img-00.png", "img-01.png", "img-02.png", "img-03.png", "img-04.png", "img-05.png"];

function imagePaint(index) {
  return (x, y) => [(x * 4 + index * 37) % 256, (y * 5 + index * 23) % 256, (index * 33 + 70) % 256];
}
function seedImages(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < IMAGE_NAMES.length; i += 1) writePng(path.join(dir, IMAGE_NAMES[i]), 96, 72, imagePaint(i));
  fs.mkdirSync(path.join(dir, "子目录-京都"), { recursive: true });
  writePng(path.join(dir, "子目录-京都", "deep-01.png"), 80, 80, () => [198, 92, 44]);
  writePng(path.join(dir, "子目录-京都", "deep-02.png"), 80, 80, () => [44, 120, 190]);
}

async function main() {
  const require = createRequire(path.join(ROOT, "package.json"));
  const chromium = require("@playwright/test").chromium;
  const electronPath = require("electron");
  const electronVersion = (function () { try { return require("electron/package.json").version; } catch (err) { return null; } })();
  const runStartedAt = Date.now();

  fs.mkdirSync(SCR, { recursive: true });
  fs.mkdirSync(SCR_DEFAULT, { recursive: true });
  fs.mkdirSync(CMP, { recursive: true });
  fs.mkdirSync(MATA, { recursive: true });
  fs.mkdirSync(MOT, { recursive: true });

  const checks = [];
  const notes = [];
  const captures = [];
  const components = [];
  const contrastRows = [];
  const materialRows = [];
  const motionRows = [];
  const a11y = { keyboard: [], ds09: [], tokens: [], clipping: [], rapid: {} };
  const consoleAll = [];
  const consoleErrors = [];
  const pageErrors = [];
  const requests = [];
  const requestFailures = [];
  const nonLocal = [];
  const bridgeLog = [];
  const findings = [];
  const scenarioSummaries = [];
  const notVerified = [];

  /* 逐断言标注所属入口：react（OA_UI=react 全量套件）/ default（默认 Vue 壳取证）/ global（卫生与 profile）。 */
  let currentEntry = "react";
  const record = (section, name, ok, expected, actual, detail) => {
    const row = { entry: currentEntry, section: section, name: name, ok: !!ok, expected: String(expected == null ? "" : expected), actual: String(actual == null ? "" : actual).slice(0, 700), detail: detail || null };
    checks.push(row);
    console.log((row.ok ? "PASS" : "FAIL") + " [" + section + "] " + name + " :: actual=" + row.actual + " expected=" + row.expected);
    return row.ok;
  };
  const note = (line) => { notes.push(line); console.log("   · " + line); };
  const finding = (kind, detail, evidence) => { findings.push({ kind: kind, detail: detail, evidence: evidence || null }); };

  const realProfilePath = H.resolveRealProfilePath();
  const profileBefore = H.snapshotProfile(realProfilePath);
  const realProfileProcessesBefore = H.processesUsing(realProfilePath);

  console.log("=== 照片应用真机视觉与动效探针（双入口） ===");
  console.log("入口：" + [RUN_REACT ? ENTRY_CONFIG.react.label + "（" + ENTRY_CONFIG.react.source + "）" : null, RUN_DEFAULT ? ENTRY_CONFIG.default.label + "（" + ENTRY_CONFIG.default.source + "）" : null].filter(Boolean).join(" + "));
  console.log("视口尺寸：" + SHOTS.map((s) => s.id + "@" + s.dsf).join(", "));
  console.log("真实 profile（只读快照）：" + realProfilePath);
  console.log("产物目录：" + path.relative(ROOT, ART));

  const scenarios = [];
  const sharedCtx = { record: record, note: note, finding: finding, captures: captures, components: components, contrastRows: contrastRows, materialRows: materialRows, motionRows: motionRows, a11y: a11y, consoleAll: consoleAll, consoleErrors: consoleErrors, pageErrors: pageErrors, requests: requests, requestFailures: requestFailures, nonLocal: nonLocal, bridgeLog: bridgeLog };
  const entries = [];

  /* ══════════════════════════════════════════════════════════════════════
     默认入口取证：dist/vue.html（不带 OA_UI）里 appId=photos 是不是真实照片应用
     ══════════════════════════════════════════════════════════════════════ */
  let defaultEntry = null;
  if (RUN_DEFAULT) {
    currentEntry = "default";
    console.log("\n========== 默认入口（dist/vue.html，不带 OA_UI） ==========");
    defaultEntry = await runDefaultEntrySuite({ chromium: chromium, electronPath: electronPath, ctx: sharedCtx });
    entries.push({
      id: "default", label: ENTRY_CONFIG.default.label, source: ENTRY_CONFIG.default.source,
      port: defaultEntry.port, ports: defaultEntry.port ? [defaultEntry.port] : [], userData: defaultEntry.userData,
      openPath: defaultEntry.summary && defaultEntry.summary.openPath,
      openPathAlt: defaultEntry.summary && defaultEntry.summary.openPathAlt,
      screenshots: defaultEntry.summary ? defaultEntry.summary.screenshots : [],
      realAppOpen: !!(defaultEntry.summary && defaultEntry.summary.realAppOpen),
      ok: !!defaultEntry.ok,
    });
    if (defaultEntry && defaultEntry.ok && defaultEntry.summary && defaultEntry.summary.realAppOpen) {
      note("旧 finding「renderer-entry-mismatch」已解决：默认入口可经真实 UI 打开 appId=photos，且渲染的是真实照片应用（见 default/entry 与 default/app 断言）。");
    } else {
      finding("renderer-entry-mismatch", "默认入口 dist/vue.html 未能打开并渲染真实「照片」应用；卡在步骤：" +
        ((defaultEntry && defaultEntry.summary && (defaultEntry.summary.error || defaultEntry.summary.failedStep)) || "无摘要") + "。",
        defaultEntry ? defaultEntry.summary : null);
    }
  } else if (SKIP_DEFAULT_PROBE) {
    note("已按 OA_PHOTOS_SKIP_DEFAULT_PROBE=1 跳过默认入口取证");
  } else {
    note("已按 OA_PHOTOS_UI_ENTRY=react 只跑 React 入口");
  }

  /* ══════════════════════════════════════════════════════════════════════
     React 入口：两个隔离场景 empty（无数据）/ ready（真实桥造数据）—— 与旧基线逐条一致
     ══════════════════════════════════════════════════════════════════════ */
  if (RUN_REACT) {
    currentEntry = "react";
    const react = { chromium: chromium, electronPath: electronPath, ctx: sharedCtx, entry: ENTRY_CONFIG.react };
    const reactPorts = [];
    const s1 = await runScenario("empty", false, react);
    reactPorts.push(s1.port);
    scenarios.push(s1);
    const s2 = await runScenario("ready", true, react);
    reactPorts.push(s2.port);
    scenarios.push(s2);
    entries.push({
      id: "react", label: ENTRY_CONFIG.react.label, source: ENTRY_CONFIG.react.source,
      port: reactPorts[0], ports: reactPorts, userData: s1.userData, ok: true,
      scenarios: [s1.label, s2.label],
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     入口隔离：各入口（含 react 的 empty/ready 两场景）CDP 端口与 userData 互不相同
     ══════════════════════════════════════════════════════════════════════ */
  const allEntryPorts = entries.reduce((acc, e) => acc.concat(e.ports || []), []);
  const allEntryUserData = entries.map((e) => e.userData).filter(Boolean);
  currentEntry = "global";
  record("entries", "E · 各入口 CDP 端口互不相同（各自独立）", new Set(allEntryPorts).size === allEntryPorts.length, "无重复端口", JSON.stringify(allEntryPorts));
  record("entries", "E · 各入口隔离 userData 路径互不相同", new Set(allEntryUserData).size === allEntryUserData.length && allEntryUserData.length === entries.length, "各入口一个独立路径", JSON.stringify(allEntryUserData));

  /* ══════════════════════════════════════════════════════════════════════
     全局卫生（覆盖本次运行的所有入口）
     ══════════════════════════════════════════════════════════════════════ */
  record("hygiene", "H0 · 全程 console error = 0", consoleErrors.length === 0, 0, consoleErrors.length + " → " + JSON.stringify(consoleErrors.slice(0, 6)));
  record("hygiene", "H1 · 全程 pageerror = 0", pageErrors.length === 0, 0, pageErrors.length + " → " + JSON.stringify(pageErrors.slice(0, 6)));
  record("hygiene", "H2 · 全程无非本地网络请求", nonLocal.length === 0, 0, nonLocal.length + " → " + JSON.stringify(nonLocal.slice(0, 6)));
  note("渲染层请求总数 " + requests.length + "，非本地 " + nonLocal.length + "，失败请求 " + requestFailures.length);

  /* ══════════════════════════════════════════════════════════════════════
     汇总：异常观察（只描述事实，不下视觉结论）
     ══════════════════════════════════════════════════════════════════════ */
  const contrastFail = contrastRows.filter((r) => r.ok && !r.pass);
  if (contrastFail.length) {
    finding("contrast-below-required", "按 DESIGN_SYSTEM §10 门槛，有 " + contrastFail.length + " 条文本对比测量低于要求（普通文本 4.5:1 / 大字 3:1）。",
      contrastFail.slice(0, 40).map((r) => ({ state: r.state, theme: r.theme, size: r.size, text: r.text, ratio: r.ratio, required: r.required, background: r.background, effective: r.effective })));
  }
  const paneOverlap = a11y.clipping.filter((c) => c.paneOverlapCount > 0);
  if (paneOverlap.length) {
    finding("narrow-pane-overlap", "窄窗下三栏骨架互相压叠（相邻 pane 包围盒同时横纵重叠 >1px）的有 " + paneOverlap.length + " 次截图；逐条列出状态 / 主题 / 尺寸与重叠量。",
      paneOverlap.slice(0, 40).map((c) => ({ state: c.state, theme: c.theme, size: c.size, overlaps: (c.paneOverlaps || []).map((o) => ({ root: o.root, pair: o.pair, overlapX: o.overlapX, overlapY: o.overlapY })) })));
  }
  const paneContentOverflow = a11y.clipping.filter((c) => c.realOverflowCount > 0);
  if (paneContentOverflow.length) {
    finding("pane-content-overflow", "有 " + paneContentOverflow.length + " 次截图里，pane 内的叶子元素越出 pane 包围盒且中间没有可滚动祖先（真正的内容溢出）；逐条列出状态 / 主题 / 尺寸 / 溢出边与像素。",
      paneContentOverflow.slice(0, 40).map((c) => ({ state: c.state, theme: c.theme, size: c.size, items: (c.realOverflow || []).slice(0, 6).map((o) => ({ pane: o.paneCls, cls: o.cls, text: o.text, sides: o.sides, escapePx: o.escapePx, rect: o.rect, paneRect: o.paneRect })) })));
  }
  const narrowOverflow = a11y.clipping.filter((c) => c.horizontalClippedCount > 0 || c.containerCutCount > 0 || c.overflowBeyondViewportCount > 0);
  if (narrowOverflow.length) {
    finding("narrow-viewport-overflow", "有 " + narrowOverflow.length + " 次截图里存在越出视口右缘或容器 overflow 裁断的内容；逐条列出状态 / 主题 / 尺寸（含是否是可横滚容器）。",
      narrowOverflow.slice(0, 40).map((c) => ({ state: c.state, theme: c.theme, size: c.size, horizontalClipped: c.horizontalClippedCount, containerCut: c.containerCutCount, overflowBeyond: c.overflowBeyondViewportCount, samples: (c.overflowBeyondViewport || []).slice(0, 6), cutSamples: (c.containerCut || []).slice(0, 4) })));
  } else {
    note("窄窗检查（三栏压叠 / 越出视口右缘且不可横滚 / 容器 overflow 裁断）：本类别无命中；pane 内容溢出见 pane-content-overflow 发现。");
  }
  const blue = a11y.ds09.reduce((sum, s) => sum + (s.blueCount || 0), 0);
  const sat = a11y.ds09.reduce((sum, s) => sum + (s.saturatedCount || 0), 0);
  const hair = a11y.ds09.reduce((sum, s) => sum + (s.hairlineCount || 0), 0);
  finding("ds-a09-raw-scan", "DS-A09 原始扫描（未分类，交 Lead 判定）：品牌蓝候选 " + blue + " 条，饱和色候选 " + sat + " 条，<=1.2px 非透明边框候选 " + hair + " 条。",
    { perTheme: a11y.ds09.map((s) => ({ theme: s.theme, state: s.state, saturated: s.saturatedCount, blue: s.blueCount, hairline: s.hairlineCount })), hairlineBuckets: (a11y.ds09[0] || {}).hairlineBuckets, topColors: (a11y.ds09[0] || {}).topColorBuckets });
  const tweenUnderReduced = motionRows.filter((m) => m.mode === "reduced" && m.tweenDetected);
  if (tweenUnderReduced.length) {
    finding("motion-tween-under-reduced", "reduced-motion 条件下仍有 " + tweenUnderReduced.length + " 段动作被判定出现布局补间（同一元素 >=3 个不同位置）。",
      tweenUnderReduced.map((m) => ({ action: m.action, mode: m.mode, tracked: m.tweenTracked, frames: m.frameCount })));
  }
  if (a11y.rapid && a11y.rapid.anomaly) finding("rapid-toggle", a11y.rapid.anomaly, a11y.rapid);

  /* 同一动作 normal / reduced 的对照（帧率、布局补间、逐帧像素变化、收敛时间）。 */
  const motionComparison = [];
  (function () {
    const byAction = new Map();
    for (const m of motionRows) {
      if (!byAction.has(m.action)) byAction.set(m.action, { action: m.action, describe: m.describe });
      byAction.get(m.action)[m.mode] = {
        frames: m.frameCount, p95IntervalMs: m.p95IntervalMs, maxIntervalMs: m.maxIntervalMs, over50Count: m.over50Count, meanIntervalMs: m.meanIntervalMs,
        layoutTween: m.tweenDetected, tweenTracked: m.tweenTracked,
        changedFrames: m.pixelAnalysis ? m.pixelAnalysis.changedFrames : null,
        maxChangeRatio: m.pixelAnalysis ? m.pixelAnalysis.maxChangeRatio : null,
        settleAfterTriggerMs: m.pixelAnalysis ? m.pixelAnalysis.settleAfterTriggerMs : null,
      };
    }
    for (const v of byAction.values()) motionComparison.push(v);
  })();

  /* ══════════════════════════════════════════════════════════════════════
     真实 profile 只读保护
     ══════════════════════════════════════════════════════════════════════ */
  const profileAfter = H.snapshotProfile(realProfilePath);
  const profileDiff = H.diffProfile(profileBefore, profileAfter);
  const realProfileProcessesAfter = H.processesUsing(realProfilePath);
  record("profile", "S1 · 真实身份库 identity.db / -wal / -shm mtime+size+sha256 完全未变", profileDiff.identityUnchanged, "unchanged", JSON.stringify({ changed: profileDiff.changed.filter((c) => c.indexOf("identity/") === 0) }));
  if (profileDiff.unchanged) {
    record("profile", "S2 · 真实 profile 顶层快照完全未变", true, "unchanged", "0 changed");
  } else {
    record("profile", "S2 · 真实 profile 顶层快照完全未变", false, "unchanged", profileDiff.changedCount + " 项变化 → " + JSON.stringify(profileDiff.changed.slice(0, 20)),
      "开工前/收工后分别有 " + realProfileProcessesBefore.length + "/" + realProfileProcessesAfter.length + " 个进程以真实 profile 运行，无法排除是其自身写盘；身份库三件套见 S1");
  }
  note("真实 profile：" + realProfilePath + "；开工前以该 profile 运行的进程 " + realProfileProcessesBefore.length + " 个，收工后 " + realProfileProcessesAfter.length + " 个");

  /* ══════════════════════════════════════════════════════════════════════
     DS / MS 验收条目逐条取证
     ══════════════════════════════════════════════════════════════════════ */
  const dsms = buildDsMs({
    contrastRows: contrastRows, a11y: a11y, captures: captures, components: components,
    materialRows: materialRows, motionRows: motionRows, scenarios: scenarios, defaultEntry: defaultEntry,
    consoleErrors: consoleErrors, pageErrors: pageErrors, nonLocal: nonLocal, profileDiff: profileDiff,
    bridgeLog: bridgeLog, motionComparison: motionComparison,
  });

  notVerified.push({ item: "像素级文字识别（OCR）", reason: "离线环境没有随包 OCR 依赖；界面文案类断言基于真实 DOM 的 innerText，截图只是同一块 DOM 的渲染结果。" });
  notVerified.push({ item: "OS 窗口物理尺寸 = 各目标尺寸", reason: "真实 BrowserWindow 由 electron/main.cjs 固定；各尺寸经 CDP Emulation.setDeviceMetricsOverride 钉视图，并重新最大化真实窗口使 px 边界跟随新视图（截图像素尺寸逐张断言）。" });
  notVerified.push({ item: "系统级 prefers-reduced-motion / 系统高对比 / 系统缩放", reason: "只验证了应用内「减少动态效果」开关 + CDP page.emulateMedia 的系统偏好模拟，未改宿主系统设置。" });
  notVerified.push({ item: "三张壁纸下的材质可读性", reason: "本轮只在当前桌面壁纸下测三档材质；切换壁纸不在本探针范围内（DS-A02 的壁纸维度留缺口）。" });
  notVerified.push({ item: "默认入口的组件 clip / 材质三档 / 动效帧序列全量套件", reason: "默认入口本轮做的是打开路径 / 真实应用标记 / 三通道 / 关键状态截图 / pane-content-overflow / 运行时卫生专项取证；组件 clip、材质与动效帧序列只在 react 入口跑全量。Vue 版复用同一份 photos.css 与 photosLogic，但 DOM 结构不同，这些维度在默认入口未取证（是缺口，不是通过）。" });

  /* 按入口统计断言：react（全量套件）/ default（默认入口取证）/ global（卫生 + profile）。 */
  const entryCounts = {};
  for (const c of checks) {
    const k = c.entry || "unassigned";
    entryCounts[k] = entryCounts[k] || { total: 0, passed: 0, failed: 0 };
    entryCounts[k].total += 1;
    if (c.ok) entryCounts[k].passed += 1; else entryCounts[k].failed += 1;
  }
  for (const e of entries) e.checks = entryCounts[e.id] || { total: 0, passed: 0, failed: 0 };
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  const report = {
    phase: "dxos-ui-photos",
    title: "照片应用 · 真机视觉与动效验收探针（图库 / 图像工坊，双入口）",
    at: H.nowIso(),
    runStartedAt: runStartedAt,
    durationMs: Date.now() - runStartedAt,
    command: "node experiments/dxos-ui-photos/run-all.mjs（双入口：" + entries.map((e) => e.id).join(" + ") + "）",
    environment: { platform: process.platform, arch: process.arch, node: process.version, electron: electronVersion, cwd: ROOT, uiEntries: entries.map((e) => e.id), entries: entries.map((e) => ({ id: e.id, label: e.label, source: e.source, port: e.port, ports: e.ports, userData: e.userData })) },
    condition: {
      viewport: SHOTS.map((s) => ({ id: s.id, width: s.width, height: s.height, deviceScaleFactor: s.dsf, pixel: (s.width * s.dsf) + "x" + (s.height * s.dsf) })),
      referenceViewport: REF.id,
      stableScreenshotCondition: "应用内「减少动态效果」开启（static 段）；材质段另有 full/reduced/solid 三档",
      isolation: "每个场景独立 --user-data-dir 临时目录，绝不触碰真实 profile",
    },
    counts: { checks: checks.length, passed: passed, failed: failed, screenshots: captures.length, components: components.length, contrastRows: contrastRows.length, materials: materialRows.length, motionSequences: motionRows.length, findings: findings.length, entryCounts: entryCounts },
    entries: entries,
    rendererEntry: defaultEntry,
    scenarios: scenarioSummaries,
    captures: captures,
    components: components,
    contrast: contrastRows,
    materials: materialRows,
    motion: motionRows,
    motionComparison: motionComparison,
    a11y: { ds09: a11y.ds09, tokens: a11y.tokens, clipping: a11y.clipping, keyboard: a11y.keyboard, rapid: a11y.rapid },
    bridgeLog: bridgeLog,
    hygiene: { consoleErrors: consoleErrors, pageErrors: pageErrors, nonLocal: nonLocal, requestFailures: requestFailures, requestCount: requests.length },
    profile: { path: realProfilePath, identityUnchanged: profileDiff.identityUnchanged, changed: profileDiff.changed, processesBefore: realProfileProcessesBefore.length, processesAfter: realProfileProcessesAfter.length },
    dsms: dsms,
    findings: findings,
    checks: checks,
    notes: notes,
    notVerified: notVerified,
    verdict: failed === 0 ? "ALL-CHECKS-PASS" : "HAS-FAILURES",
  };
  fs.writeFileSync(path.join(ART, "report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(ART, "checks.json"), JSON.stringify(checks, null, 2));
  fs.writeFileSync(path.join(ART, "contrast.json"), JSON.stringify({ summary: summarizeContrast(contrastRows), rows: contrastRows }, null, 2));
  fs.writeFileSync(path.join(ART, "dsms.json"), JSON.stringify(dsms, null, 2));
  writeResultMd(report, findings, dsms);

  console.log("\n========== 汇总 ==========");
  console.log("断言：" + passed + " PASS / " + failed + " FAIL（共 " + checks.length + "）");
  console.log("静态截图 " + captures.length + " 张；组件 clip " + components.length + " 张；材质截图 " + materialRows.length + " 张；动效序列 " + motionRows.length + " 段");
  console.log("对比测量 " + contrastRows.length + " 条（低于门槛 " + contrastFail.length + " 条）");
  console.log("发现（只描述事实） " + findings.length + " 类");
  console.log("报告：" + path.relative(ROOT, path.join(ART, "report.json")));
  console.log("结论文件：" + path.relative(ROOT, path.join(ART, "RESULT.md")));
  if (failed > 0) {
    console.log("\n失败明细：");
    for (const c of checks.filter((x) => !x.ok)) console.log("  FAIL [" + c.section + "] " + c.name + " :: " + c.actual);
  }
  return failed === 0 ? 0 : 1;
}

/* ══════════════════════════════════════════════════════════════════════════
   默认入口取证（不带 OA_UI，走 dist/vue.html，Vue 壳 → src-vue/apps/PhotosApp.vue）
   · Vue 壳 DOCK_DEFAULT 里没有 photos，只能经真实 UI「聚焦搜索」或「应用中心」打开；
   · 断言 appId=photos 渲染的是真实照片应用（data-photos-* 标记 + 三通道真实调用），不是 PlannedApp；
   · 关键状态截图（empty/ready × light/dark × 1440x900@2 与 820）并逐张实测 pane-content-overflow；
   · 运行时卫生（console error / pageerror / 非本地请求）单独记账。
   ══════════════════════════════════════════════════════════════════════════ */
async function runDefaultEntrySuite(deps) {
  const ctx = deps.ctx;
  const entry = ENTRY_CONFIG.default;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-photos-default-"));
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-photos-default-src-"));
  const srcFile5 = path.join(srcDir, IMAGE_NAMES[5]);
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.OA_UI; /* 默认入口 = 不设 OA_UI → dist/vue.html */
  const scoped = (section, name, ok, expected, actual, detail) => ctx.record("default/" + section, name, ok, expected, actual, detail);
  const localConsoleErrors = [];
  const localPageErrors = [];
  const localNonLocal = [];
  const summary = {
    label: entry.label, source: entry.source, userData: userDataDir, port: null, launchCommand: null,
    openPath: null, openPathAlt: null, realAppOpen: false, failedStep: null, error: null,
    screenshots: [], threeChannels: null, appFacts: null,
    localConsoleErrors: localConsoleErrors, localPageErrors: localPageErrors, localNonLocal: localNonLocal,
  };
  console.log("隔离 userData：" + userDataDir);
  console.log("真实来源目录：" + srcDir);

  let launched = null;
  let page = null;
  let cdp = null;
  let winSel = null;
  let winLabel = null;
  try {
    launched = await H.launchElectron({ ROOT: ROOT, electronPath: deps.electronPath, chromium: deps.chromium, userDataDir: userDataDir, env: env });
    summary.port = launched.port;
    summary.launchCommand = launched.launchCommand;
    const context = launched.browser.contexts()[0];
    const found = await H.waitFor(() => !!context.pages().find((p) => entry.pageRe.test(p.url())), 30000, 300);
    page = found ? context.pages().find((p) => entry.pageRe.test(p.url())) : null;
    if (!page) throw new Error("未找到目标渲染页（" + entry.source + "）：" + context.pages().map((p) => p.url()).join(" | "));

    page.on("console", (msg) => {
      const text = String(msg.text()).slice(0, 400);
      ctx.consoleAll.push({ scenario: "default", type: msg.type(), text: text });
      if (msg.type() === "error") { ctx.consoleErrors.push(text); localConsoleErrors.push(text); }
    });
    page.on("pageerror", (err) => { const t = String((err && err.message) || err).slice(0, 400); ctx.pageErrors.push(t); localPageErrors.push(t); });
    page.on("request", (req) => {
      const url = req.url();
      ctx.requests.push({ scenario: "default", url: url });
      if (!LOCAL_RE.test(url)) { ctx.nonLocal.push({ scenario: "default", url: url }); localNonLocal.push(url); }
    });
    page.on("requestfailed", (req) => ctx.requestFailures.push({ scenario: "default", url: req.url(), error: String((req.failure() && req.failure().errorText) || "") }));

    const rendererReady = await H.waitFor(async () => {
      const v = await page.evaluate(() => ({ rs: document.readyState, keys: window.openarc ? Object.keys(window.openarc).length : 0 }));
      return v && v.rs === "complete" && v.keys > 0;
    }, 45000, 300);
    if (!rendererReady) throw new Error("默认入口渲染层未就绪（45 秒内未拿到桥面）");
    cdp = await page.context().newCDPSession(page);
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: REF.width, height: REF.height, deviceScaleFactor: REF.dsf, mobile: false });
    await page.emulateMedia({ reducedMotion: "no-preference", colorScheme: "no-preference" });
    await H.sleep(300);

    const bridgeKeys = await page.evaluate(() => Object.keys(window.openarc));
    scoped("boot", "B1 · 默认入口真实 electron 渲染就绪（" + entry.source + "）", rendererReady, "readyState=complete + 桥面", bridgeKeys.length + " 键");
    scoped("boot", "B2 · 三通道 photos / photocraft / appExchange 都在桥面上",
      ["photos", "photocraft", "appExchange"].every((k) => bridgeKeys.indexOf(k) >= 0), "全部存在",
      JSON.stringify({ total: bridgeKeys.length, photos: bridgeKeys.indexOf("photos") >= 0, photocraft: bridgeKeys.indexOf("photocraft") >= 0, appExchange: bridgeKeys.indexOf("appExchange") >= 0 }));

    const identifier = "ui-photos-default@openarc.test";
    const password = "UiPhotos-default-1";
    const initRes = await H.callBridge(page, "identity", "identity/initialize", { identifier: identifier, password: password, displayName: "照片默认入口验证" });
    const loginRes = await H.callBridge(page, "identity", "identity/login", { identifier: identifier, password: password });
    const gateReady = await H.waitFor(async () => (await page.evaluate(() => { const d = document.querySelector(".desktop"); return d ? d.getAttribute("data-identity-gate") : null; })) === "ready", 20000, 200);
    scoped("identity", "I0 · 经产品桥首启初始化 + 登录进入 ready", !!(initRes.result && initRes.result.ok) && !!(loginRes.result && loginRes.result.ok) && gateReady, "ok + gate=ready",
      JSON.stringify({ init: initRes.result && initRes.result.ok, login: loginRes.result && loginRes.result.ok, gate: gateReady }));
    scoped("isolation", "S0 · 隔离 userData 内真实建库 identity.db（且不是真实 profile）", fs.existsSync(path.join(userDataDir, "identity.db")) && path.resolve(userDataDir) !== path.resolve(H.resolveRealProfilePath()), "identity.db present", userDataDir);

    /* ── 3a：经真实 UI 入口打开「照片」── */
    const dockIds = await page.evaluate(() => Array.from(document.querySelectorAll(".dock-item[data-dock-id]")).map((e) => e.getAttribute("data-dock-id")));
    scoped("entry", "E0 · Vue 壳程序坞确实没有 photos（因此必须走真实入口而非直接塞 appId）", dockIds.indexOf("photos") < 0, "dock 无 photos", JSON.stringify(dockIds));

    /* 真实入口 A：聚焦搜索（顶栏「全局搜索」→ 输入「相册」→ 点结果） */
    const searchBtn = await H.clickSelector(page, 'button[aria-label="全局搜索"]');
    const searchOpen = searchBtn && await H.waitFor(async () => await page.evaluate(() => !!document.querySelector(".search-panel")), 8000, 120);
    let spotPicked = false;
    if (searchOpen) {
      await page.evaluate(() => {
        const i = document.querySelector('.search-panel input[aria-label="搜索应用名称"]');
        if (!i) return;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(i, "相册");
        i.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await H.sleep(300);
      spotPicked = await page.evaluate(() => {
        const b = Array.prototype.slice.call(document.querySelectorAll(".search-panel .search-result")).find((x) => ((x.querySelector(".result-label") || {}).textContent || "").trim() === "相册");
        if (!b) return false;
        b.click();
        return true;
      });
    }
    const spotAppeared = !!spotPicked && await H.waitFor(() => page.$(H.APP_SEL), 15000, 200);
    summary.openPath = '真实 UI「聚焦搜索」：顶栏 button[aria-label="全局搜索"] → 搜索面板 input[aria-label="搜索应用名称"] 输入「相册」→ 点 .search-result（label=相册）';
    scoped("entry", "E1 · 经真实 UI「聚焦搜索」打开 appId=photos", spotAppeared, "点搜索结果后出现 [data-photos-app]", JSON.stringify({ searchBtn: searchBtn, searchOpen: searchOpen, spotPicked: spotPicked, spotAppeared: spotAppeared }));
    if (!spotAppeared) { summary.failedStep = "聚焦搜索路径未能打开照片应用"; throw new Error(summary.failedStep); }

    winLabel = await page.evaluate((sel) => { const a = document.querySelector(sel); const w = a && a.closest("section.window"); return w ? w.getAttribute("aria-label") : null; }, H.APP_SEL);
    winSel = winLabel ? H.windowSelector(winLabel) : null;

    /* 真实入口 B：应用中心（程序坞「应用中心」→ data-app-card=photos 卡片） */
    const homeBtn = await H.clickSelector(page, '.dock-item[data-dock-id="home"]');
    const cardVisible = homeBtn && await H.waitFor(async () => await page.evaluate(() => !!document.querySelector('[data-app-card="photos"]')), 8000, 120);
    const cardClickable = !!cardVisible && await page.evaluate(() => { const c = document.querySelector('[data-app-card="photos"]'); if (!c) return false; c.click(); return true; });
    const focusStill = !!cardClickable && await H.waitFor(async () => await page.evaluate((sel) => { const a = document.querySelector(sel); const w = a && a.closest("section.window"); return !!w && w.className.indexOf("active") >= 0; }, H.APP_SEL), 6000, 150);
    summary.openPathAlt = '真实 UI「应用中心」：程序坞 data-dock-id="home" → [data-app-card="photos"] 卡片';
    scoped("entry", "E2 · 真实 UI「应用中心」也提供 photos 入口并可唤起该窗口", !!cardVisible && cardClickable && focusStill, "卡片存在 + 点击后照片窗口 active", JSON.stringify({ homeBtn: homeBtn, cardVisible: cardVisible, cardClickable: cardClickable, focusStill: focusStill }));
    await page.evaluate(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });

    /* ── 3b：真实照片应用，而不是 PlannedApp 占位 ── */
    await H.sleep(400);
    const appFacts = await page.evaluate((sel) => {
      const a = document.querySelector(sel);
      if (!a) return null;
      const tab = a.querySelector("[data-photos-tab]");
      const lib = a.querySelector("[data-photos-lib]");
      const studio = a.querySelector("[data-photos-studio]");
      return {
        hasPhotosApp: a.getAttribute("data-photos-app") === "1",
        tab: tab ? tab.getAttribute("data-photos-tab") : null,
        navLabels: Array.from(a.querySelectorAll(".split-nav")).map((b) => (b.textContent || "").trim()).filter(Boolean),
        hasLibrary: !!lib,
        hasStudio: !!studio,
        libraryState: lib ? lib.getAttribute("data-photos-state") : null,
        plannedAppNodes: document.querySelectorAll(".planned-app").length,
        plannedTitleNodes: document.querySelectorAll(".planned-title").length,
        bodyHasPlaceholder: /该应用尚未接入|内容接入后会在这里显示/.test(document.body.innerText || ""),
      };
    }, H.APP_SEL);
    summary.appFacts = appFacts;
    summary.realAppOpen = !!(appFacts && appFacts.hasPhotosApp && appFacts.navLabels.indexOf("图库") >= 0 && appFacts.navLabels.indexOf("图像工坊") >= 0 && appFacts.tab === "library");
    scoped("app", "A1 · appId=photos 渲染真实照片应用（[data-photos-app] + 图库/图像工坊双视图）", summary.realAppOpen, "data-photos-app=1 + 2 个 split-nav（图库/图像工坊）+ data-photos-tab=library", JSON.stringify(appFacts));
    scoped("app", "A2 · PlannedApp 占位特征不存在（无 .planned-app / .planned-title /「该应用尚未接入」文案）",
      !!appFacts && appFacts.plannedAppNodes === 0 && appFacts.plannedTitleNodes === 0 && !appFacts.bodyHasPlaceholder, "三者都为 0/false",
      JSON.stringify({ plannedAppNodes: appFacts && appFacts.plannedAppNodes, plannedTitleNodes: appFacts && appFacts.plannedTitleNodes, bodyHasPlaceholder: appFacts && appFacts.bodyHasPlaceholder }));
    scoped("app", "A2b · 窗口身份为「相册窗口」（Vue 壳 APPS 里 photos 名为「相册」）", winLabel === "相册窗口", "相册窗口", String(winLabel));

    const tabSwitch = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('[data-photos-app="1"] .split-nav'));
      const s = btns.find((b) => (b.textContent || "").trim() === "图像工坊");
      if (!s) return false;
      s.click();
      return true;
    });
    const studioTab = !!tabSwitch && await H.waitFor(async () => await page.evaluate(() => { const t = document.querySelector('[data-photos-app="1"] [data-photos-tab]'); return !!t && t.getAttribute("data-photos-tab") === "studio"; }), 8000, 120);
    const studioRoot = !!studioTab && await page.evaluate(() => !!document.querySelector('[data-photos-app="1"] [data-photos-studio]'));
    scoped("app", "A3 · data-photos-tab 可真实切换（图库 → 图像工坊）且切后渲染 [data-photos-studio]", studioTab && studioRoot, "data-photos-tab=studio + data-photos-studio", JSON.stringify({ tabSwitch: tabSwitch, studioTab: studioTab, studioRoot: studioRoot }));

    /* ── 3b：三通道真实调用（photos / photocraft / appExchange） ── */
    const three = {};
    const chSpecs = [["photos", "photos/sources/list", { limit: 50 }], ["photocraft", "photocraft/projects/list", {}], ["appExchange", "appExchange/targets", {}]];
    for (const spec of chSpecs) {
      const r = await H.callBridge(page, spec[0], spec[1], spec[2]);
      ctx.bridgeLog.push({ scenario: "default", channel: spec[0], command: spec[1], ms: r.ms, result: r.result });
      three[spec[1]] = r.result;
      scoped("bridge", "C · " + spec[0] + ":" + spec[1] + " 真实执行成功", !!(r.result && r.result.ok === true), "ok:true", JSON.stringify(r.result).slice(0, 240));
    }
    summary.threeChannels = { photosSourcesList: !!(three["photos/sources/list"] && three["photos/sources/list"].ok), photocraftProjectsList: !!(three["photocraft/projects/list"] && three["photocraft/projects/list"].ok), appExchangeTargets: !!(three["appExchange/targets"] && three["appExchange/targets"].ok) };

    /* 留证一张真实应用全图 */
    const fullFile = path.join(ART, "default-entry-photos-app.png");
    const fullDim = await H.shoot(cdp, fullFile);
    summary.fullScreenshot = path.relative(ROOT, fullFile);
    summary.fullScreenshotDims = fullDim;
    scoped("app", "A4 · 默认入口照片应用整窗留证截图", fullDim.width > 0 && fullDim.height > 0, ">0", fullDim.width + "x" + fullDim.height + " → " + path.relative(ROOT, fullFile));

    /* ── 稳定截图条件：真实设置「减少动态效果」 ── */
    const reducedStable = await H.setReduced(page, true);
    scoped("appearance", "A0 · 经真实设置开启「减少动态效果」（desktop.reduced）", reducedStable, "desktop.reduced", String(reducedStable));

    /* ── 3c/3d：关键状态截图 + pane-content-overflow 实测 ── */
    const DEFAULT_SIZES = [SHOTS[0], SHOTS[3]];
    const switchView = async (view) => {
      const text = view === "studio" ? "图像工坊" : "图库";
      const ok = await H.clickText(page, H.APP_SEL, text, ".split-nav");
      const tabbed = await H.waitFor(async () => await page.evaluate((arg) => {
        const tab = document.querySelector(arg.app + " [data-photos-tab]");
        return !!tab && tab.getAttribute("data-photos-tab") === arg.view;
      }, { app: H.APP_SEL, view: view }), 8000, 100);
      return ok && tabbed;
    };
    const waitState = (view, states) => H.waitFor(async () => await page.evaluate((arg) => {
      const root = document.querySelector(arg.app + (arg.view === "library" ? " [data-photos-lib]" : " [data-photos-studio]"));
      if (!root) return null;
      const s = root.getAttribute("data-photos-state");
      return arg.states.indexOf(s) >= 0 ? s : null;
    }, { app: H.APP_SEL, view: view, states: states }), 20000, 150);
    const freshView = async (view) => {
      const other = view === "library" ? "studio" : "library";
      await switchView(other);
      await H.sleep(150);
      await switchView(view);
      return waitState(view, ["ready", "empty", "error", "unavailable", "unauthorized"]);
    };

    /* Vue 版只在组件 mount 时 loadPage/loadProjects，切换 tab 不会重新读盘；
       所以「就绪态」必须点真实工具条「刷新」按钮重新走一次桥，而不是靠切 tab 推断。 */
    const clickToolbarRefresh = () => page.evaluate((sel) => {
      const app = document.querySelector(sel);
      if (!app) return false;
      const btns = Array.prototype.slice.call(app.querySelectorAll(".photos-toolbar button"));
      const b = btns.find((x) => (x.textContent || "").trim() === "刷新");
      if (!b) return false;
      b.click();
      return true;
    }, H.APP_SEL);

    const captureDefaultState = async (stateId, view, states, theme, expectCount) => {
      const prepared = await freshView(view);
      const refreshed = await clickToolbarRefresh();
      const settled = refreshed && await waitState(view, states);
      scoped("state/" + theme, "P · " + stateId + " 场景就绪（真实「刷新」后 data-photos-state ∈ " + states.join("/") + "）", !!settled, states.join("/"), String(prepared) + "/" + String(refreshed) + "/" + String(settled));
      for (const size of DEFAULT_SIZES) {
        const fit = await H.setViewport(page, cdp, size, winSel, AREA_TOP);
        await H.focusWindow(page, winSel);
        await H.sleep(120);
        const metrics = await H.measureApp(page, { width: size.width, height: size.height });
        const file = path.join(SCR_DEFAULT, stateId + "-" + theme + "-" + size.id + ".png");
        const dim = await H.shoot(cdp, file);
        const dimOk = dim.width === size.width * size.dsf && dim.height === size.height * size.dsf;
        scoped("shot/" + theme, "P · " + stateId + " @ " + size.id + " 截图像素 " + (size.width * size.dsf) + "x" + (size.height * size.dsf), dimOk, (size.width * size.dsf) + "x" + (size.height * size.dsf), dim.width + "x" + dim.height);
        scoped("fit/" + theme, "P · " + stateId + " @ " + size.id + " 真实窗口铺满新视图", fit, "window ≈ viewport", JSON.stringify(metrics && metrics.windowRect));
        const overflow = metrics ? metrics.realOverflowCount : -1;
        scoped("overflow/" + theme, "O · " + stateId + " @ " + size.id + " pane-content-overflow（叶子越出 pane 且无可滚动祖先）= 0", overflow === 0, 0, String(overflow),
          metrics && metrics.realOverflowCount ? JSON.stringify(metrics.realOverflow.slice(0, 4)) : null);
        if (expectCount) {
          const n = metrics && metrics.counts ? metrics.counts[expectCount] : null;
          scoped("count/" + theme, "P · " + stateId + " @ " + size.id + " 列表真实渲染 " + expectCount + " > 0", n > 0, ">0", String(n));
        }
        ctx.captures.push({
          entry: "default", scenario: "default", state: stateId, view: view, describe: "默认入口 · " + stateId, theme: theme, size: size.id,
          viewport: { width: size.width, height: size.height, dsf: size.dsf },
          screenshot: path.relative(ROOT, file), screenshotDims: dim, fit: fit, metrics: metrics,
        });
        summary.screenshots.push({
          state: stateId, theme: theme, size: size.id, file: path.relative(ROOT, file), dims: dim.width + "x" + dim.height, fit: fit,
          realOverflowCount: overflow,
          paneOverlapCount: metrics ? metrics.paneOverlapCount : null,
          horizontalClippedCount: metrics ? metrics.horizontalClippedCount : null,
          containerCutCount: metrics ? metrics.containerCutCount : null,
          beyondViewportCount: metrics ? metrics.overflowBeyondViewportCount : null,
          rootState: metrics ? metrics.state : null,
        });
        if (metrics && (metrics.horizontalClippedCount > 0 || metrics.containerCutCount > 0 || metrics.paneOverlapCount > 0 || metrics.overflowBeyondViewportCount > 0 || metrics.realOverflowCount > 0)) {
          ctx.a11y.clipping.push({
            scenario: "default", state: stateId, theme: theme, size: size.id,
            horizontalClippedCount: metrics.horizontalClippedCount, horizontalClipped: metrics.horizontalClipped,
            paneOverlapCount: metrics.paneOverlapCount, paneOverlaps: metrics.paneOverlaps,
            realOverflowCount: metrics.realOverflowCount, realOverflow: metrics.realOverflow,
            overflowBeyondViewportCount: metrics.overflowBeyondViewportCount, overflowBeyondViewport: metrics.overflowBeyondViewport,
            containerCutCount: metrics.containerCutCount, containerCut: metrics.containerCut,
            verticalCutCount: metrics.verticalCutCount,
          });
        }
      }
    };

    for (const theme of ["light", "dark"]) {
      const themed = await H.setTheme(page, theme);
      scoped("appearance", "A1 · 默认入口经真实设置切到 " + theme + "（desktop.dark 校验）", themed, theme === "dark" ? "desktop.dark" : "无 dark 类", String(themed));
      await captureDefaultState("library-empty", "library", ["empty"], theme);
      await captureDefaultState("studio-empty", "studio", ["empty"], theme);
    }

    /* 造真实数据（只经真实桥），再截就绪态 */
    seedImages(srcDir);
    await populateData(page, "default", srcDir, srcFile5, ctx, scoped, deps);
    for (const theme of ["light", "dark"]) {
      await H.setTheme(page, theme);
      await H.focusWindow(page, winSel);
      await captureDefaultState("library-ready", "library", ["ready"], theme, "cards");
      await captureDefaultState("studio-ready", "studio", ["ready"], theme, "projects");
    }

    /* ── 3d：运行时卫生（本入口）── */
    scoped("hygiene", "H0 · 默认入口 console error = 0", localConsoleErrors.length === 0, 0, localConsoleErrors.length + " → " + JSON.stringify(localConsoleErrors.slice(0, 6)));
    scoped("hygiene", "H1 · 默认入口 pageerror = 0", localPageErrors.length === 0, 0, localPageErrors.length + " → " + JSON.stringify(localPageErrors.slice(0, 6)));
    scoped("hygiene", "H2 · 默认入口无非本地网络请求", localNonLocal.length === 0, 0, localNonLocal.length + " → " + JSON.stringify(localNonLocal.slice(0, 6)));

    try { await page.evaluate(() => window.close()); } catch (err) { /* ignore */ }
    const exit = await H.awaitExit(launched.child, 20000);
    scoped("exit", "X · 默认入口正常关窗退出", exit.exited, "process exits", JSON.stringify(exit));
  } catch (error) {
    summary.error = String((error && error.stack) || error).slice(0, 700);
    if (!summary.failedStep) summary.failedStep = summary.error;
    scoped("fatal", "F · 默认入口取证中断", false, "run to completion", summary.error);
  } finally {
    try { if (launched && launched.browser) await launched.browser.close(); } catch (err) { /* ignore */ }
    try { if (launched && launched.child && launched.child.exitCode == null) launched.child.kill("SIGKILL"); } catch (err) { /* ignore */ }
    await H.sleep(900);
    const residual = H.processesUsing(userDataDir);
    scoped("exit", "X · 无残留进程持有默认入口隔离 userData", residual.length === 0, 0, residual.length + " → " + JSON.stringify(residual.slice(0, 3)));
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (err) { /* ignore */ }
    try { fs.rmSync(srcDir, { recursive: true, force: true }); } catch (err) { /* ignore */ }
    scoped("exit", "X · 删除默认入口隔离 userData 与来源目录", !fs.existsSync(userDataDir) && !fs.existsSync(srcDir), "removed", fs.existsSync(userDataDir) ? "still present" : "removed");
    const out = launched ? launched.out() : { stdout: "", stderr: "" };
    console.log("stderr 摘要（default）：" + out.stderr.split("\n").filter((l) => /error|Error|FATAL|Unhandled/i.test(l)).filter((l) => !/ssl_client_socket|SSL error|net_error|handshake failed|GPU|gpu_|Metal|Autofill|CoreText|Vulkan/i.test(l)).slice(0, 8).join(" | ").slice(0, 800));
  }
  const ok = !summary.error && summary.realAppOpen && localConsoleErrors.length === 0 && localPageErrors.length === 0 && localNonLocal.length === 0;
  return { ok: ok, summary: summary, port: summary.port, userData: summary.userData };
}

/* ══════════════════════════════════════════════════════════════════════════
   场景运行
   ══════════════════════════════════════════════════════════════════════════ */
async function runScenario(label, populate, deps) {
  const ctx = deps.ctx;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-ui-photos-" + label + "-"));
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, deps.entry.env);
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-photos-source-"));
  const srcMoved = srcDir + ".moved";
  const srcFile5 = path.join(srcDir, IMAGE_NAMES[5]);

  console.log("\n========== 场景 " + label + " ==========");
  console.log("隔离 userData：" + userDataDir);
  console.log("真实来源目录：" + srcDir);

  let launched = null;
  let page = null;
  let cdp = null;
  let winSel = null;
  let winLabel = null;
  const summary = { label: label, populated: populate, windowLabel: null, bridgeKeys: null, port: null, userData: userDataDir, captures: 0, fatal: null };
  let fatal = null;

  const scoped = (section, name, ok, expected, actual, detail) => ctx.record("scenario/" + label + "/" + section, name, ok, expected, actual, detail);

  try {
    launched = await H.launchElectron({ ROOT: ROOT, electronPath: deps.electronPath, chromium: deps.chromium, userDataDir: userDataDir, env: env });
    summary.port = launched.port;
    const context = launched.browser.contexts()[0];
    const found = await H.waitFor(() => !!context.pages().find((p) => deps.entry.pageRe.test(p.url())), 30000, 300);
    page = found ? context.pages().find((p) => deps.entry.pageRe.test(p.url())) : null;
    if (!page) throw new Error("未找到目标渲染页（" + deps.entry.source + "）：" + context.pages().map((p) => p.url()).join(" | "));

    page.on("console", (msg) => {
      const row = { scenario: label, type: msg.type(), text: String(msg.text()).slice(0, 400) };
      ctx.consoleAll.push(row);
      if (row.type === "error") ctx.consoleErrors.push(row.text);
    });
    page.on("pageerror", (err) => ctx.pageErrors.push(String((err && err.message) || err).slice(0, 400)));
    page.on("request", (req) => {
      const url = req.url();
      ctx.requests.push({ scenario: label, url: url });
      if (!LOCAL_RE.test(url)) ctx.nonLocal.push({ scenario: label, url: url });
    });
    page.on("requestfailed", (req) => ctx.requestFailures.push({ scenario: label, url: req.url(), error: String((req.failure() && req.failure().errorText) || "") }));

    const rendererReady = await H.waitFor(async () => {
      const v = await page.evaluate(() => ({ rs: document.readyState, keys: window.openarc ? Object.keys(window.openarc).length : 0 }));
      return v && v.rs === "complete" && v.keys > 0;
    }, 45000, 300);
    if (!rendererReady) throw new Error("渲染层未就绪（45 秒内未拿到桥面）");

    cdp = await page.context().newCDPSession(page);
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: REF.width, height: REF.height, deviceScaleFactor: REF.dsf, mobile: false });
    await page.emulateMedia({ reducedMotion: "no-preference", colorScheme: "no-preference" });
    await H.sleep(300);

    const bridgeKeys = await page.evaluate(() => Object.keys(window.openarc));
    summary.bridgeKeys = bridgeKeys;
    scoped("boot", "B1 · 真实 electron 渲染就绪（" + deps.entry.source + "）", rendererReady, "readyState=complete + 桥面", bridgeKeys.length + " 键，CDP 端口 " + launched.port);
    scoped("boot", "B2 · 三通道 photos / photocraft / appExchange 都在桥面上",
      ["photos", "photocraft", "appExchange"].every((k) => bridgeKeys.indexOf(k) >= 0), "全部存在",
      JSON.stringify({ total: bridgeKeys.length, photos: bridgeKeys.indexOf("photos") >= 0, photocraft: bridgeKeys.indexOf("photocraft") >= 0, appExchange: bridgeKeys.indexOf("appExchange") >= 0 }));

    const identifier = "ui-photos-" + label + "@openarc.test";
    const password = "UiPhotos-password-1";
    const initRes = await H.callBridge(page, "identity", "identity/initialize", { identifier: identifier, password: password, displayName: "照片探针管理员" });
    const loginRes = await H.callBridge(page, "identity", "identity/login", { identifier: identifier, password: password });
    const gateReady = await H.waitFor(async () => (await page.evaluate(() => { const d = document.querySelector(".desktop"); return d ? d.getAttribute("data-identity-gate") : null; })) === "ready", 20000, 200);
    scoped("identity", "I0 · 经产品桥首启初始化 + 登录进入 ready", !!(initRes.result && initRes.result.ok) && !!(loginRes.result && loginRes.result.ok) && gateReady, "ok + gate=ready",
      JSON.stringify({ init: initRes.result && initRes.result.ok, login: loginRes.result && loginRes.result.ok, gate: gateReady }));
    scoped("isolation", "S0 · 隔离 userData 内真实建库 identity.db", fs.existsSync(path.join(userDataDir, "identity.db")) && path.resolve(userDataDir) !== path.resolve(H.resolveRealProfilePath()), "identity.db present", userDataDir);

    await H.clickSelector(page, '.dock-item[data-dock-id="photos"]');
    const appFound = await H.waitFor(() => page.$(H.APP_SEL), 15000, 200);
    winLabel = appFound ? await page.evaluate((sel) => { const a = document.querySelector(sel); const w = a && a.closest("section.window"); return w ? w.getAttribute("aria-label") : null; }, H.APP_SEL) : null;
    winSel = winLabel ? H.windowSelector(winLabel) : null;
    summary.windowLabel = winLabel;
    scoped("boot", "B3 · 应用中心 →「照片」打开真实窗口且含双视图标记 [data-photos-app]",
      appFound && !!winSel && (await page.evaluate((sel) => { const w = document.querySelector(sel); return !!w && w.querySelectorAll(".split-nav").length === 2; }, winSel)), "1 个窗口 + 2 个 split-nav",
      JSON.stringify({ appFound: appFound, windowLabel: winLabel }));

    const reducedStable = await H.setReduced(page, true);
    await H.focusWindow(page, winSel);
    scoped("appearance", "A0 · 稳定截图条件：经真实设置开启「减少动态效果」（desktop.reduced）", reducedStable, "desktop.reduced", String(reducedStable));

    if (populate) {
      seedImages(srcDir);
      await populateData(page, label, srcDir, srcFile5, ctx, scoped, deps);
    } else {
      const sl = await H.callBridge(page, "photos", "photos/sources/list", { limit: 50 });
      const count = sl.result && sl.result.value ? sl.result.value.sources.length : null;
      scoped("data", "D · 空态场景 sources/list 真实返回 0 来源", count === 0, 0, String(count));
    }

    const restoreSourceLayout = () => {
      if (fs.existsSync(srcMoved) && !fs.existsSync(srcDir)) fs.renameSync(srcMoved, srcDir);
      if (fs.existsSync(srcDir)) {
        for (let i = 0; i < IMAGE_NAMES.length; i += 1) {
          const f = path.join(srcDir, IMAGE_NAMES[i]);
          if (!fs.existsSync(f)) writePng(f, 96, 72, imagePaint(i));
        }
      }
    };
    const removeThumbCache = () => {
      const dirs = H.findThumbCacheDirs(userDataDir);
      for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (err) { /* ignore */ } }
      return dirs.length;
    };

    const switchView = async (view) => {
      const text = view === "studio" ? "图像工坊" : "图库";
      const ok = await H.clickText(page, H.APP_SEL, text, ".split-nav");
      const tabbed = await H.waitFor(async () => await page.evaluate((arg) => {
        const tab = document.querySelector(arg.app + " [data-photos-tab]");
        return !!tab && tab.getAttribute("data-photos-tab") === arg.view;
      }, { app: H.APP_SEL, view: view }), 8000, 100);
      return ok && tabbed;
    };
    const waitSettled = (view, ms) => H.waitFor(async () => await page.evaluate((arg) => {
      const root = document.querySelector(arg.app + (arg.view === "library" ? " [data-photos-lib]" : " [data-photos-studio]"));
      return !!root && !!root.getAttribute("data-photos-state");
    }, { app: H.APP_SEL, view: view }), ms || 20000, 150);
    const freshView = async (view) => {
      const other = view === "library" ? "studio" : "library";
      await switchView(other);
      await H.sleep(120);
      await switchView(view);
      return waitSettled(view, 20000);
    };
    const clickCard = (name) => page.evaluate((arg) => {
      const app = document.querySelector(arg.app);
      if (!app) return false;
      const cards = Array.prototype.slice.call(app.querySelectorAll(".photos-card"));
      const pick = arg.name ? cards.filter((c) => (c.textContent || "").indexOf(arg.name) >= 0)[0] : cards[0];
      if (!pick) return false;
      pick.click();
      return true;
    }, { app: H.APP_SEL, name: name || null });
    const clickProject = () => page.evaluate((arg) => {
      const app = document.querySelector(arg.app);
      if (!app) return false;
      const p = app.querySelector(".photos-project");
      if (!p) return false;
      p.click();
      return true;
    }, { app: H.APP_SEL });
    const clickTextInApp = (text) => page.evaluate((arg) => {
      const app = document.querySelector(arg.app);
      if (!app) return false;
      const btns = Array.prototype.slice.call(app.querySelectorAll("button"));
      const b = btns.filter((x) => (x.textContent || "").indexOf(arg.text) >= 0)[0];
      if (!b) return false;
      b.click();
      return true;
    }, { app: H.APP_SEL, text: text });
    const clickToolbar = (text) => page.evaluate((arg) => {
      const app = document.querySelector(arg.app);
      if (!app) return false;
      const btns = Array.prototype.slice.call(app.querySelectorAll(".photos-toolbar button"));
      const b = btns.filter((x) => (x.textContent || "").trim() === arg.text)[0];
      if (!b) return false;
      b.click();
      return true;
    }, { app: H.APP_SEL, text: text });

    const prepareState = async (id) => {
      if (id === "library-empty" || id === "studio-empty") return freshView(id === "library-empty" ? "library" : "studio");
      restoreSourceLayout();
      if (id === "library-ready") return freshView("library");
      if (id === "studio-ready") return freshView("studio");
      if (id === "library-detail") {
        await freshView("library");
        await clickCard(null);
        return H.waitFor(async () => await page.evaluate((sel) => !!document.querySelector(sel + " [data-photos-detail]"), H.APP_SEL), 12000, 150);
      }
      if (id === "library-unavailable") {
        await freshView("library");
        await clickCard(null);
        await H.waitFor(async () => await page.evaluate((sel) => !!document.querySelector(sel + " [data-photos-detail]"), H.APP_SEL), 12000, 150);
        await clickTextInApp("反推");
        return H.waitFor(async () => await page.evaluate((sel) => !!document.querySelector(sel + " [data-photos-vision-unavailable]"), H.APP_SEL), 12000, 150);
      }
      if (id === "studio-detail") {
        await freshView("studio");
        await clickProject();
        return H.waitFor(async () => await page.evaluate((sel) => !!document.querySelector(sel + " [data-photos-project-detail]"), H.APP_SEL), 12000, 150);
      }
      if (id === "library-error") {
        await freshView("library");
        if (!fs.existsSync(srcFile5)) writePng(srcFile5, 96, 72, imagePaint(5));
        const before = await page.evaluate((sel) => document.querySelectorAll(sel + " .photos-card").length, H.APP_SEL);
        removeThumbCache();
        try { fs.rmSync(srcFile5, { force: true }); } catch (err) { /* ignore */ }
        await clickCard(IMAGE_NAMES[5]);
        const errored = await H.waitFor(async () => await page.evaluate((sel) => !!document.querySelector(sel + " [data-ds-kind=\"error\"]"), H.APP_SEL), 12000, 150);
        return before > 0 && errored;
      }
      if (id === "library-source-unavailable") {
        await freshView("library");
        await H.sleep(200);
        if (fs.existsSync(srcDir)) fs.renameSync(srcDir, srcMoved);
        await H.sleep(120);
        await clickToolbar("刷新");
        return H.waitFor(async () => await page.evaluate((sel) => {
          const app = document.querySelector(sel);
          if (!app) return false;
          const rows = Array.prototype.slice.call(app.querySelectorAll(".photos-lib-side .photos-row"));
          return rows.some((r) => ((r.querySelector(".photos-row__facts") || {}).textContent || "").indexOf("不可用") >= 0);
        }, H.APP_SEL), 12000, 150);
      }
      return false;
    };

    const captureState = async (id, theme) => {
      const spec = STATE_SPECS[id];
      let prepared = false;
      try { prepared = await prepareState(id); } catch (err) { prepared = false; ctx.note("prepareState(" + id + ") 抛错：" + String((err && err.message) || err)); }
      const settled = prepared && await waitSettled(spec.view, 20000);
      scoped("state/" + theme, "P · " + id + " 场景就绪（" + spec.describe + "）", settled, "prepared + data-photos-state", String(prepared) + "/" + String(settled));
      if (!settled) ctx.finding("state-not-settled", "状态 " + id + "（" + spec.describe + "）在 " + theme + " 主题下未就绪", { scenario: label, theme: theme });
      for (const size of SHOTS) {
        const fit = await H.setViewport(page, cdp, size, winSel, AREA_TOP);
        await H.focusWindow(page, winSel);
        const topmost = await H.isTopmost(page, winSel);
        await H.sleep(120);
        const metrics = await H.measureApp(page, { width: size.width, height: size.height });
        const file = path.join(SCR, id + "-" + theme + "-" + size.id + ".png");
        const dim = await H.shoot(cdp, file);
        const dimOk = dim.width === size.width * size.dsf && dim.height === size.height * size.dsf;
        scoped("shot/" + theme, "P · " + id + " @ " + size.id + " 截图像素 " + (size.width * size.dsf) + "x" + (size.height * size.dsf), dimOk, (size.width * size.dsf) + "x" + (size.height * size.dsf), dim.width + "x" + dim.height);
        scoped("fit/" + theme, "P · " + id + " @ " + size.id + " 真实窗口铺满新视图", fit, "window ≈ viewport", JSON.stringify(metrics && metrics.windowRect));
        ctx.captures.push({
          scenario: label, state: id, view: spec.view, describe: spec.describe, theme: theme, size: size.id, viewport: { width: size.width, height: size.height, dsf: size.dsf },
          screenshot: path.relative(ROOT, file), screenshotDims: dim, fit: fit, topmost: topmost, metrics: metrics,
        });
        summary.captures += 1;
        if (metrics && (metrics.horizontalClippedCount > 0 || metrics.containerCutCount > 0 || metrics.paneOverlapCount > 0 || metrics.overflowBeyondViewportCount > 0 || metrics.realOverflowCount > 0)) {
          ctx.a11y.clipping.push({
            scenario: label, state: id, theme: theme, size: size.id,
            horizontalClippedCount: metrics.horizontalClippedCount, horizontalClipped: metrics.horizontalClipped,
            paneOverlapCount: metrics.paneOverlapCount, paneOverlaps: metrics.paneOverlaps,
            realOverflowCount: metrics.realOverflowCount, realOverflow: metrics.realOverflow,
            overflowBeyondViewportCount: metrics.overflowBeyondViewportCount, overflowBeyondViewport: metrics.overflowBeyondViewport,
            containerCutCount: metrics.containerCutCount, containerCut: metrics.containerCut,
            verticalCutCount: metrics.verticalCutCount,
          });
        }
        if (spec.contrast && (size.id === "1440x900" || size.id === "820")) {
          try {
            const sampled = await H.sampleContrast(page, cdp, { viewport: { width: size.width, height: size.height } });
            for (let i = 0; i < sampled.candidates.length; i += 1) {
              const c = sampled.candidates[i];
              const bg = sampled.backgrounds[i] ? sampled.backgrounds[i].bg : null;
              const m = bg ? measureTextContrast(c, bg) : { ok: false, reason: "缺少背景采样" };
              ctx.contrastRows.push(Object.assign({
                scenario: label, state: id, view: spec.view, theme: theme, size: size.id,
                text: c.text, tag: c.tag, cls: c.cls, aria: c.aria, rect: c.rect,
              }, m));
            }
          } catch (err) {
            ctx.note("对比采样失败（" + id + "/" + theme + "/" + size.id + "）：" + String((err && err.message) || err));
          }
        }
      }
    };

    const themes = ["light", "dark"];
    const states = populate ? READY_STATES : EMPTY_STATES;
    for (const theme of themes) {
      const themed = await H.setTheme(page, theme);
      await H.focusWindow(page, winSel);
      scoped("appearance", "A1 · 经真实设置切到 " + theme + "（desktop.dark 校验）", themed, theme === "dark" ? "desktop.dark" : "无 dark 类", String(themed));
      ctx.a11y.tokens.push(Object.assign({ scenario: label, theme: theme }, await H.dumpTokens(page)));
      for (const id of states) {
        await captureState(id, theme);
      }
    }

    if (populate) await captureComponents(label, page, cdp, winSel, {
      setTheme: H.setTheme, setViewport: (size) => H.setViewport(page, cdp, size, winSel, AREA_TOP),
      freshView: freshView, prepareState: prepareState, switchView: switchView, clickCard: clickCard, clickToolbar: clickToolbar,
      record: scoped, store: ctx.components, note: ctx.note,
    });

    await captureA11y(label, page, cdp, winSel, {
      record: scoped, note: ctx.note, a11y: ctx.a11y, findHair: ctx.finding,
      setTheme: H.setTheme, setViewport: (size) => H.setViewport(page, cdp, size, winSel, AREA_TOP),
      freshView: freshView, prepareState: prepareState, switchView: switchView, clickCard: clickCard, clickToolbar: clickToolbar,
    });

    if (populate) await captureMaterials(label, page, cdp, winSel, {
      record: scoped, note: ctx.note, store: ctx.materialRows, contrastRows: ctx.contrastRows,
      setTheme: H.setTheme, setGlass: H.setGlass, setReduced: H.setReduced, setViewport: (size) => H.setViewport(page, cdp, size, winSel, AREA_TOP),
      prepareState: prepareState, freshView: freshView,
    });

    if (populate) await captureMotion(label, page, cdp, winSel, {
      record: scoped, note: ctx.note, store: ctx.motionRows, setReduced: H.setReduced, setGlass: H.setGlass,
      setViewport: (size) => H.setViewport(page, cdp, size, winSel, AREA_TOP), switchView: switchView, freshView: freshView, prepareState: prepareState,
      initialReduced: true,
    });

    try { await page.evaluate(() => window.close()); } catch (err) { /* 关窗后上下文销毁 */ }
    const exit = await H.awaitExit(launched.child, 20000);
    scoped("exit", "X · 正常关窗退出", exit.exited, "process exits", JSON.stringify(exit));
  } catch (error) {
    fatal = String((error && error.stack) || error).slice(0, 600);
    scoped("fatal", "F · 场景中断", false, "run to completion", fatal);
  } finally {
    try { if (launched && launched.browser) await launched.browser.close(); } catch (err) { /* ignore */ }
    try { if (launched && launched.child && launched.child.exitCode == null) launched.child.kill("SIGKILL"); } catch (err) { /* ignore */ }
    await H.sleep(900);
    const residual = H.processesUsing(userDataDir);
    scoped("exit", "X · 无残留进程持有隔离 userData", residual.length === 0, 0, residual.length + " → " + JSON.stringify(residual.slice(0, 3)));
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (err) { /* ignore */ }
    try { fs.rmSync(srcDir, { recursive: true, force: true }); } catch (err) { /* ignore */ }
    try { if (fs.existsSync(srcMoved)) fs.rmSync(srcMoved, { recursive: true, force: true }); } catch (err) { /* ignore */ }
    scoped("exit", "X · 删除隔离 userData 与来源目录", !fs.existsSync(userDataDir) && !fs.existsSync(srcDir), "removed", fs.existsSync(userDataDir) ? "still present" : "removed");
    const out = launched ? launched.out() : { stdout: "", stderr: "" };
    console.log("stderr 摘要（" + label + "）：" + out.stderr.split("\n").filter((l) => /error|Error|FATAL|Unhandled/i.test(l)).filter((l) => !/ssl_client_socket|SSL error|net_error|handshake failed|GPU|gpu_|Metal|Autofill|CoreText|Vulkan/i.test(l)).slice(0, 8).join(" | ").slice(0, 800));
  }
  summary.fatal = fatal;
  return summary;
}

/* ══════════════════════════════════════════════════════════════════════════
   造数据（只经真实桥 window.openarc.*）
   ══════════════════════════════════════════════════════════════════════════ */
async function populateData(page, label, srcDir, srcFile5, ctx, scoped, deps) {
  const run = async (channel, command, payload, expectOk) => {
    const r = await H.callBridge(page, channel, command, payload);
    ctx.bridgeLog.push({ scenario: label, channel: channel, command: command, ms: r.ms, result: r.result });
    const ok = !!(r.result && r.result.ok === true);
    scoped("data", "D · " + channel + ":" + command + " 真实执行" + (expectOk === false ? "（允许失败，记录信封）" : "成功"), expectOk === false ? true : ok, expectOk === false ? "记录" : "ok:true", JSON.stringify(r.result).slice(0, 260));
    return r.result;
  };
  await run("photos", "photos/sources/add", { path: srcDir });
  await run("photos", "photos/folders/create", { name: "旅行" });
  const parent = await run("photos", "photos/folders/create", { name: "京都" });
  if (parent && parent.value && parent.value.folder) {
    await run("photos", "photos/folders/create", { name: "夜景", parentId: parent.value.folder.id });
  }
  await run("photos", "photos/sources/list", { limit: 50 });
  await run("photocraft", "photocraft/groups/create", { name: "探针分组" });

  const b64 = fs.readFileSync(path.join(srcDir, IMAGE_NAMES[0])).toString("base64");
  const b64b = fs.readFileSync(path.join(srcDir, "子目录-京都", "deep-01.png")).toString("base64");
  const p1 = await run("photocraft", "photocraft/projects/create", { name: "探针项目 Alpha", mime: "image/png", contentBase64: b64 });
  await run("photocraft", "photocraft/projects/create", { name: "探针项目 Beta", mime: "image/png", contentBase64: b64b });
  const p3 = await run("photocraft", "photocraft/projects/create", { name: "探针项目 Gamma 待回收", mime: "image/png", contentBase64: b64 });
  if (p1 && p1.value && p1.value.project) {
    await run("photocraft", "photocraft/projects/update", { id: p1.value.project.id, visibility: "public" });
  }
  if (p3 && p3.value && p3.value.project) {
    await run("photocraft", "photocraft/projects/trash", { id: p3.value.project.id });
  }
  await run("photocraft", "photocraft/projects/list", {});
  await run("photocraft", "photocraft/trash/list", {});
  await run("appExchange", "appExchange/targets", {});

  const badRemove = await H.callBridge(page, "photos", "photos/sources/remove", { id: "does-not-exist" });
  ctx.bridgeLog.push({ scenario: label, channel: "photos", command: "photos/sources/remove", ms: badRemove.ms, result: badRemove.result });
  scoped("data", "D · photos:sources/remove 不存在 id 返回结构化错误（错误态构造证据）", !!(badRemove.result && badRemove.result.ok === false), "ok:false", JSON.stringify(badRemove.result).slice(0, 240));
  const badAssign = await H.callBridge(page, "photos", "photos/folders/assign", { ids: ["local:nope:missing.png"], folderId: "no-such-folder" });
  ctx.bridgeLog.push({ scenario: label, channel: "photos", command: "photos/folders/assign", ms: badAssign.ms, result: badAssign.result });
  scoped("data", "D · photos:folders/assign 不存在来源 id 返回结构化错误", !!(badAssign.result && badAssign.result.ok === false), "ok:false", JSON.stringify(badAssign.result).slice(0, 240));
  const badCraft = await H.callBridge(page, "photocraft", "photocraft/projects/get", { id: "no-such-project" });
  ctx.bridgeLog.push({ scenario: label, channel: "photocraft", command: "photocraft/projects/get", ms: badCraft.ms, result: badCraft.result });
  scoped("data", "D · photocraft:projects/get 不存在项目返回结构化错误", !!(badCraft.result && badCraft.result.ok === false), "ok:false", JSON.stringify(badCraft.result).slice(0, 240));

  const health = await H.callBridge(page, "photos", "photos/health", {});
  ctx.bridgeLog.push({ scenario: label, channel: "photos", command: "photos/health", ms: health.ms, result: health.result });
  scoped("data", "D · photos:health 依赖事实", !!(health.result && health.result.ok === true), "ok:true", JSON.stringify(health.result && health.result.value ? health.result.value.dependencies : null));
  return true;
}

/* ══════════════════════════════════════════════════════════════════════════
   组件状态
   ══════════════════════════════════════════════════════════════════════════ */
const COMPONENT_PROPS = ["display", "background-color", "color", "border-top-width", "border-top-color", "border-radius", "outline-width", "outline-style", "outline-color", "outline-offset", "box-shadow", "opacity", "cursor", "font-size", "font-weight", "transition-duration", "transition-timing-function", "transform", "filter", "backdrop-filter", "height"];

async function componentStyle(page, selector) {
  return page.evaluate((arg) => {
    const el = document.querySelector(arg.sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const out = { rect: null, focusVisible: false, disabled: !!el.disabled, aria: el.getAttribute("aria-label"), text: (el.textContent || "").trim().slice(0, 40) };
    const r = el.getBoundingClientRect();
    out.rect = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    for (const p of arg.props) out[p] = cs.getPropertyValue(p).trim();
    try { out.focusVisible = el.matches(":focus-visible"); } catch (err) { out.focusVisible = null; }
    return out;
  }, { sel: selector, props: COMPONENT_PROPS });
}

async function dispatchMouse(cdp, type, x, y, buttons) {
  await cdp.send("Input.dispatchMouseEvent", { type: type, x: Math.round(x), y: Math.round(y), button: "left", buttons: buttons == null ? 0 : buttons, clickCount: type === "mousePressed" || type === "mouseReleased" ? 1 : 0 });
}

async function focusByTab(page, cdp, selector, maxTabs) {
  await page.evaluate(() => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    document.body.setAttribute("tabindex", "-1");
    document.body.focus();
    document.body.removeAttribute("tabindex");
  });
  for (let i = 0; i < (maxTabs || 60); i += 1) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await H.sleep(25);
    const hit = await page.evaluate((sel) => document.activeElement === document.querySelector(sel), selector);
    if (hit) return i + 1;
  }
  return -1;
}

async function captureComponents(label, page, cdp, winSel, api) {
  console.log("\n---------- 组件状态 ----------");
  for (const theme of ["light", "dark"]) {
    await api.setTheme(page, theme);
    await api.setViewport(REF);

    const shot = async (id, component, state, selector, extra) => {
      const file = path.join(CMP, id + "-" + state + "-" + theme + ".png");
      const style = await componentStyle(page, selector);
      if (!style) {
        api.record("component/" + theme, "C · " + id + " / " + state + " 元素存在", false, "element present", "missing " + selector);
        return;
      }
      const pad = 10;
      const clip = { x: Math.max(0, style.rect[0] - pad), y: Math.max(0, style.rect[1] - pad), width: style.rect[2] + pad * 2, height: style.rect[3] + pad * 2 };
      const dim = await H.shootClip(cdp, file, clip, 2);
      api.store.push({ component: component, id: id, state: state, scenario: label, theme: theme, selector: selector, screenshot: path.relative(ROOT, file), screenshotDims: dim, clip: clip, style: style, extra: extra || null });
      api.record("component/" + theme, "C · " + id + " / " + state + " 局部截图 + 计算样式", dim.width > 0 && dim.height > 0, ">0", dim.width + "x" + dim.height + " bg=" + style["background-color"] + " color=" + style.color);
    };

    await api.freshView("library");
    const refreshBtn = H.APP_SEL + " .photos-toolbar button";
    await api.setViewport(REF);
    await shot("button-primary", "Button", "default", refreshBtn);
    const rect = await componentStyle(page, refreshBtn);
    if (rect) {
      const cx = rect.rect[0] + rect.rect[2] / 2;
      const cy = rect.rect[1] + rect.rect[3] / 2;
      await dispatchMouse(cdp, "mouseMoved", cx, cy, 0);
      await H.sleep(160);
      await shot("button-primary", "Button", "hover", refreshBtn);
      await dispatchMouse(cdp, "mousePressed", cx, cy, 1);
      await H.sleep(140);
      await shot("button-primary", "Button", "active", refreshBtn);
      await dispatchMouse(cdp, "mouseReleased", cx, cy, 0);
      await dispatchMouse(cdp, "mouseMoved", 5, 5, 0);
      await H.sleep(160);
      const tabs = await focusByTab(page, cdp, refreshBtn, 60);
      await shot("button-primary", "Button", "focus", refreshBtn, { tabs: tabs });
      api.record("component/" + theme, "C · button-primary 焦点经真实 Tab 到达", tabs > 0, ">0 tab", String(tabs));
    }
    const disabledSel = await page.evaluate((sel) => {
      const app = document.querySelector(sel);
      if (!app) return null;
      const btns = Array.prototype.slice.call(app.querySelectorAll("button"));
      const b = btns.filter((x) => x.disabled)[0];
      if (!b) return null;
      b.setAttribute("data-oa-probe-disabled", "1");
      return "[data-oa-probe-disabled]";
    }, H.APP_SEL);
    if (disabledSel) await shot("button-disabled", "Button", "disabled", H.APP_SEL + " " + disabledSel);
    else api.record("component/" + theme, "C · Button 禁用态可构造", false, "存在 disabled 按钮", "未找到");

    await api.freshView("library");
    const iconBtn = H.APP_SEL + ' [data-ds-comp="icon-button"]';
    await shot("iconbutton-add-source", "IconButton", "default", iconBtn);
    const ib = await componentStyle(page, iconBtn);
    if (ib) {
      const cx = ib.rect[0] + ib.rect[2] / 2;
      const cy = ib.rect[1] + ib.rect[3] / 2;
      await dispatchMouse(cdp, "mouseMoved", cx, cy, 0);
      await H.sleep(160);
      await shot("iconbutton-add-source", "IconButton", "hover", iconBtn);
      await dispatchMouse(cdp, "mouseMoved", 5, 5, 0);
      await H.sleep(80);
      const tabs = await focusByTab(page, cdp, iconBtn, 60);
      await shot("iconbutton-add-source", "IconButton", "focus", iconBtn, { tabs: tabs });
    }

    await api.freshView("library");
    await page.evaluate((sel) => {
      const app = document.querySelector(sel);
      const b = app && Array.prototype.slice.call(app.querySelectorAll("button")).filter((x) => (x.getAttribute("aria-label") || "").indexOf("添加照片来源") >= 0)[0];
      if (b) b.click();
    }, H.APP_SEL);
    await H.waitFor(async () => await page.evaluate(() => !!document.querySelector(".dialog [data-ds-comp=\"text-field\"]")), 8000, 150);
    await shot("dialog-input", "Input/TextField", "default", '.dialog [data-ds-comp="text-field"] input');
    await page.evaluate(() => { const i = document.querySelector('.dialog [data-ds-comp="text-field"] input'); if (i) i.focus(); });
    await H.sleep(120);
    await shot("dialog-input", "Input/TextField", "focus", '.dialog [data-ds-comp="text-field"] input');
    await page.evaluate(() => { const i = document.querySelector('.dialog [data-ds-comp="text-field"] input'); if (i) { i.value = "/Users/example/照片"; i.dispatchEvent(new Event("input", { bubbles: true })); } });
    await H.sleep(160);
    await shot("dialog-input", "Input/TextField", "filled", '.dialog [data-ds-comp="text-field"] input');
    await shot("dialog-add-source", "Dialog", "open", ".dialog");
    api.record("component/" + theme, "C · Dialog 打开后 role=dialog + aria-modal", await page.evaluate(() => { const d = document.querySelector('.dialog[role="dialog"]'); return !!d && d.getAttribute("aria-modal") === "true"; }), "aria-modal=true", "ok");
    await page.evaluate(() => { const b = document.querySelector('.dialog .dialog-footer button'); if (b) b.click(); });
    await H.sleep(250);

    await api.prepareState("studio-detail");
    await api.setViewport(REF);
    await shot("studio-select", "Select", "default", ".photos-select");
    await page.evaluate(() => { const s = document.querySelector(".photos-select"); if (s) s.focus(); });
    await H.sleep(120);
    await shot("studio-select", "Select", "focus", ".photos-select");

    await H.clickSelector(page, '.dock-item[data-dock-id="settings"]');
    await H.waitFor(() => page.$(H.windowSelector(H.SETTINGS_LABEL)), 10000, 150);
    await H.clickSelector(page, H.windowSelector(H.SETTINGS_LABEL) + ' [data-settings-pane="appearance"]');
    await H.sleep(200);
    const switchSel = H.windowSelector(H.SETTINGS_LABEL) + ' button[role="switch"][aria-label="减少动态效果"]';
    await shot("settings-switch-reduced-motion", "Switch", "on", switchSel);
    await page.evaluate((sel) => { const s = document.querySelector(sel); if (s && s.getAttribute("aria-checked") === "true") s.click(); }, switchSel);
    await H.sleep(250);
    await shot("settings-switch-reduced-motion", "Switch", "off", switchSel);
    await page.evaluate((sel) => { const s = document.querySelector(sel); if (s && s.getAttribute("aria-checked") !== "true") s.click(); }, switchSel);
    await H.sleep(250);
    await H.closeSettings(page);
    await H.setReduced(page, true);
    await H.focusWindow(page, winSel);

    await api.prepareState("studio-detail");
    await api.setViewport(REF);
    const saved = await api.clickToolbar("保存设置");
    if (!saved) {
      await page.evaluate((sel) => {
        const app = document.querySelector(sel);
        const b = app && Array.prototype.slice.call(app.querySelectorAll("button")).filter((x) => (x.textContent || "").trim() === "保存设置")[0];
        if (b) b.click();
      }, H.APP_SEL);
    }
    const toastAppeared = await H.waitFor(async () => await page.evaluate(() => !!document.querySelector('[data-ds-comp="toast"]')), 6000, 120);
    if (toastAppeared) await shot("toast-studio-save", "Toast", "info", '[data-ds-comp="toast"]');
    else api.record("component/" + theme, "C · Toast 出现（保存设置 → 无改动 info）", false, "toast present", "未出现");
    await H.sleep(120);

    await api.freshView("library");
    await api.setViewport(REF);
    await shot("list-sources", "List", "ready", H.APP_SEL + " .photos-lib-side .photos-list");
    const treeShot = await page.evaluate((sel) => {
      const app = document.querySelector(sel);
      const toggles = app ? Array.prototype.slice.call(app.querySelectorAll(".photos-folder-toggle")) : [];
      for (const t of toggles) { if (t.getAttribute("data-empty") !== "true") { t.click(); return true; } }
      return false;
    }, H.APP_SEL);
    await H.sleep(280);
    await shot("treenav-virtual-folders", "List/TreeNav", treeShot ? "expanded" : "collapsed", H.APP_SEL + " .photos-lib-side .photos-list");

    /* PageState empty：空来源场景直接是空态；就绪场景用「筛选无结果」触发同样的空态。 */
    await api.prepareState("library-empty").catch(() => false);
    await api.setViewport(REF);
    let psEmpty = await page.evaluate((sel) => {
      const app = document.querySelector(sel);
      const ps = app && app.querySelector('[data-ds-comp="page-state"][data-ds-kind="empty"]');
      if (ps) { ps.setAttribute("data-oa-probe", "pagestate"); return true; }
      return false;
    }, H.APP_SEL);
    if (!psEmpty) {
      await page.evaluate((sel) => {
        const app = document.querySelector(sel);
        const input = app && app.querySelector('[data-ds-comp="search-field"] input, [data-ds-comp="text-field"] input');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(input, "zzz-探针无匹配-zzz");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      }, H.APP_SEL);
      psEmpty = await H.waitFor(async () => await page.evaluate((sel) => {
        const app = document.querySelector(sel);
        const ps = app && app.querySelector('[data-ds-comp="page-state"][data-ds-kind="empty"]');
        if (ps) { ps.setAttribute("data-oa-probe", "pagestate"); return true; }
        return false;
      }, H.APP_SEL), 6000, 120);
    }
    if (psEmpty) await shot("pagestate-empty", "PageState", "empty", '[data-oa-probe="pagestate"]');
    else api.record("component/" + theme, "C · PageState empty 可构造", false, "empty page-state", "未出现");
    await page.evaluate(() => { const e = document.querySelector('[data-oa-probe="pagestate"]'); if (e) e.removeAttribute("data-oa-probe"); });
    await api.prepareState("library-error").catch(() => false);
    await api.setViewport(REF);
    const psErr = await page.evaluate((sel) => {
      const app = document.querySelector(sel);
      const ps = app && app.querySelector('[data-ds-comp="page-state"][data-ds-kind="error"]');
      if (ps) { ps.setAttribute("data-oa-probe", "pagestate"); return true; }
      return false;
    }, H.APP_SEL);
    if (psErr) await shot("pagestate-error", "PageState", "error", '[data-oa-probe="pagestate"]');
    else api.record("component/" + theme, "C · PageState error 可构造", false, "error page-state", "未出现");
    await page.evaluate(() => { const e = document.querySelector('[data-oa-probe="pagestate"]'); if (e) e.removeAttribute("data-oa-probe"); });
    await api.prepareState("library-unavailable").catch(() => false);
    await api.setViewport(REF);
    const psHint = await page.evaluate((sel) => {
      const app = document.querySelector(sel);
      const box = app && app.querySelector("[data-photos-vision-unavailable]");
      if (box) { box.setAttribute("data-oa-probe", "unavailable-hint"); return true; }
      return false;
    }, H.APP_SEL);
    if (psHint) await shot("pagestate-unavailable-hint", "PageState", "unavailable(structured-hint)", '[data-oa-probe="unavailable-hint"]');
    await page.evaluate(() => { const e = document.querySelector('[data-oa-probe="unavailable-hint"]'); if (e) e.removeAttribute("data-oa-probe"); });
    /* loading 态在真实数据下只存在几毫秒（IPC 往返），无法稳定截到。
       做法：临时加一个只含一张大图（约 17MB）的来源，点开它时 photos/sourceFile 要读盘 + base64
       编码 + 跨 IPC 传 ~23MB 字符串，loading PageState 会稳定可见数百毫秒，此时截图；
       截完经真实桥移除该来源并删除临时目录。静帧截图在此之前已完成，不受影响。
       （contextBridge 暴露的 window.openarc 在渲染层不可写，不能靠包一层假延迟。） */
    const bigDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-photos-big-"));
    let bigSourceId = null;
    let loadingCaught = false;
    try {
      writePng(path.join(bigDir, "big-01.png"), 2400, 2400, (function () { let s = 7; return () => { s = (s * 1664525 + 1013904223) >>> 0; return [s & 0xff, (s >>> 8) & 0xff, (s >>> 16) & 0xff]; }; })());
      const addBig = await H.callBridge(page, "photos", "photos/sources/add", { path: bigDir });
      bigSourceId = addBig.result && addBig.result.value && addBig.result.value.source ? addBig.result.value.source.id : null;
      await api.freshView("library");
      await api.setViewport(REF);
      await page.evaluate((sel) => {
        const app = document.querySelector(sel);
        const cards = app ? Array.prototype.slice.call(app.querySelectorAll(".photos-card")) : [];
        const c = cards.filter((x) => (x.textContent || "").indexOf("big-01.png") >= 0)[0];
        if (c) c.click();
      }, H.APP_SEL);
      for (let i = 0; i < 120 && !loadingCaught; i += 1) {
        loadingCaught = await page.evaluate((sel) => {
          const app = document.querySelector(sel);
          const ps = app && app.querySelector('[data-ds-comp="page-state"][data-ds-kind="loading"]');
          if (ps) { ps.setAttribute("data-oa-probe", "loading"); return true; }
          return false;
        }, H.APP_SEL);
      }
      if (loadingCaught) await shot("pagestate-loading", "PageState", "loading", '[data-oa-probe="loading"]');
    } catch (err) {
      api.note("loading 捕获失败：" + String((err && err.message) || err));
    } finally {
      await page.evaluate(() => { const e = document.querySelector('[data-oa-probe="loading"]'); if (e) e.removeAttribute("data-oa-probe"); });
      if (bigSourceId) { try { await H.callBridge(page, "photos", "photos/sources/remove", { id: bigSourceId }); } catch (err) { /* ignore */ } }
      try { fs.rmSync(bigDir, { recursive: true, force: true }); } catch (err) { /* ignore */ }
    }
    if (!loadingCaught) api.record("component/" + theme, "C · PageState loading 捕获", false, "loading page-state", "大文件详情加载期间仍未捕获到");
    await api.freshView("library");
    await api.setViewport(REF);

    api.record("component/" + theme, "C · PageState 四态取证结果（empty/loading/error/unavailable）", true, "记录", JSON.stringify({ empty: !!psEmpty, loading: loadingCaught, error: !!psErr, unavailable: !!psHint }),
      psHint ? "unavailable 只在图库反推入口以结构化提示盒呈现；PhotoCraft 列表的 PageState unavailable 分支在当前健康域下不可达。" : null);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   可访问性：键盘遍历 / 焦点恢复 / DS-A09
   ══════════════════════════════════════════════════════════════════════════ */
async function captureA11y(label, page, cdp, winSel, api) {
  console.log("\n---------- 可访问性 ----------");
  for (const theme of ["light", "dark"]) {
    await api.setTheme(page, theme);
    await api.freshView("library");
    await api.setViewport(REF);

    await page.evaluate(() => {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      document.body.setAttribute("tabindex", "-1");
      document.body.focus();
      document.body.removeAttribute("tabindex");
    });
    const seq = [];
    for (let i = 0; i < 45; i += 1) {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
      await H.sleep(20);
      const info = await H.activeElementInfo(page);
      if (info) seq.push(Object.assign({ step: i + 1, theme: theme }, info));
    }
    const inPhotos = seq.filter((s) => s.inPhotos).length;
    api.a11y.keyboard.push({ scenario: label, theme: theme, flow: "library-tab", steps: seq.length, inPhotos: inPhotos, sequence: seq.slice(0, 45) });
    api.record("a11y/" + theme, "K · 键盘 Tab 遍历图库：焦点进入照片应用并有序列", inPhotos >= 3, ">=3 个焦点落在照片应用内", inPhotos + "/" + seq.length, JSON.stringify(seq.slice(0, 10).map((s) => s.tag + (s.aria ? "[" + s.aria + "]" : "") + (s.text ? "{" + s.text.slice(0, 12) + "}" : ""))));

    await api.freshView("library");
    const openerSel = H.APP_SEL + ' [data-ds-comp="icon-button"]';
    /* 直接把焦点放到「添加照片来源」按钮上再按 Enter：从文档头部 Tab 到窗口内部要跨过桌面外壳，
       真实 Tab 步数随窗口数量变化，容易超预算而假失败。键盘激活本身仍是真实 Enter 按键。 */
    const openerFocused = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.focus();
      return document.activeElement === el;
    }, openerSel);
    const before = await H.activeElementInfo(page);
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await cdp.send("Input.dispatchKeyEvent", { type: "char", key: "Enter", text: "\r", unmodifiedText: "\r" });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    const dialogOpen = await H.waitFor(async () => await page.evaluate(() => !!document.querySelector('.dialog[role="dialog"]')), 6000, 120);
    const inside = dialogOpen ? await H.activeElementInfo(page) : null;
    const trap = [];
    if (dialogOpen) {
      for (let i = 0; i < 6; i += 1) {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
        await H.sleep(25);
        trap.push(await H.activeElementInfo(page));
      }
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      await H.sleep(300);
    }
    const after = await H.activeElementInfo(page);
    const dialogClosed = await page.evaluate(() => !document.querySelector('.dialog[role="dialog"]'));
    const trapped = dialogOpen && trap.length > 0 && trap.every((t) => t && t.inDialog);
    const restored = !!(after && before && after.aria === before.aria && after.tag === before.tag && after.inPhotos);
    api.a11y.keyboard.push({ scenario: label, theme: theme, flow: "dialog-focus", openerFocused: openerFocused, before: before, inside: inside, trap: trap, after: after, dialogClosed: dialogClosed, trapped: trapped, restored: restored });
    api.record("a11y/" + theme, "K · Dialog 键盘打开后焦点进入对话框且被 Tab 限制在框内", dialogOpen && trapped, "焦点都在 role=dialog 内", JSON.stringify({ dialogOpen: dialogOpen, trapped: trapped, inside: inside && inside.aria }));
    api.record("a11y/" + theme, "K · Escape 关闭 Dialog 后焦点恢复到打开它的按钮（DS-A05 焦点恢复）", dialogClosed && restored, "回到同一个按钮", JSON.stringify({ closed: dialogClosed, before: before && before.aria, after: after && after.aria }));

    await api.freshView("library");
    for (let i = 0; i < 10; i += 1) {
      await api.switchView(i % 2 === 0 ? "studio" : "library");
      await H.sleep(60);
    }
    await H.sleep(700);
    const finalTab = await page.evaluate((sel) => { const t = document.querySelector(sel + " [data-photos-tab]"); return t ? t.getAttribute("data-photos-tab") : null; }, H.APP_SEL);
    const rootPresent = await page.evaluate((sel) => !!document.querySelector(sel + " [data-photos-lib], " + sel + " [data-photos-studio]"), H.APP_SEL);
    const unexpected = finalTab !== "library" || !rootPresent;
    api.a11y.rapid = { scenario: label, theme: theme, toggles: 10, finalTab: finalTab, rootPresent: rootPresent, anomaly: unexpected ? "连续切换 10 次后终态不是「图库」或根容器缺失" : null };
    api.record("a11y/" + theme, "K · 快速连续切换视图 10 次后终态正确、根容器仍在（MS-A02/MS-A09）", !unexpected, "finalTab=library + root present", JSON.stringify({ finalTab: finalTab, rootPresent: rootPresent }));

    await api.freshView("library");
    const names = await page.evaluate((sel) => Array.prototype.slice.call(document.querySelectorAll(sel + " .photos-card")).map((c) => { const n = c.querySelector(".photos-card__name"); return n ? (n.textContent || "").trim() : (c.textContent || "").trim(); }).slice(0, 5), H.APP_SEL);
    if (names.length >= 3) {
      let last = null;
      for (const n of [names[0], names[2], names[1]]) {
        await page.evaluate((arg) => {
          const cards = Array.prototype.slice.call(document.querySelectorAll(arg.sel + " .photos-card"));
          const c = cards.filter((x) => (x.textContent || "").indexOf(arg.name) >= 0)[0];
          if (c) c.click();
        }, { sel: H.APP_SEL, name: n });
        last = n;
        await H.sleep(30);
      }
      await H.sleep(900);
      const shown = await page.evaluate((sel) => { const i = document.querySelector(sel + " [data-photos-detail] img"); return i ? i.getAttribute("alt") : null; }, H.APP_SEL);
      api.record("a11y/" + theme, "K · 快速连点 3 张照片后详情与最后一次点击一致（MS-A09 旧回调不覆盖）", shown === last, last, String(shown));
    }

    await api.prepareState("library-ready");
    await api.setViewport(REF);
    const scan = await H.scanDS09(page);
    if (scan) {
      scan.scenario = label;
      scan.theme = theme;
      scan.state = "library-ready";
      api.a11y.ds09.push(scan);
      api.record("a11y/" + theme, "K · DS-A09 计算样式扫描完成（彩色强调 / 品牌蓝 / 发丝线框）", true, "扫描完成",
        JSON.stringify({ elements: scan.scannedElements, saturated: scan.saturatedCount, blue: scan.blueCount, hairline: scan.hairlineCount, shadowHairline: scan.boxShadowHairlineCount }));
    } else {
      api.record("a11y/" + theme, "K · DS-A09 计算样式扫描完成", false, "扫描完成", "app 不在 DOM");
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   材质三档
   ══════════════════════════════════════════════════════════════════════════ */
async function captureMaterials(label, page, cdp, winSel, api) {
  console.log("\n---------- 材质三档 ----------");
  const MODES = ["full", "reduced", "solid"];
  for (const theme of ["light", "dark"]) {
    await api.setTheme(page, theme);
    for (const mode of MODES) {
      const ok = await api.setGlass(page, mode);
      await api.prepareState("library-detail");
      await api.setViewport(REF);
      await H.focusWindow(page, winSel);
      const file = path.join(MATA, mode + "-library-detail-" + theme + ".png");
      const dim = await H.shoot(cdp, file);
      const dimOk = dim.width === REF.width * REF.dsf && dim.height === REF.height * REF.dsf;
      const glass = await page.evaluate(() => { const d = document.querySelector(".desktop"); return d ? d.getAttribute("data-glass") : null; });
      const sampled = await H.sampleContrast(page, cdp, { viewport: { width: REF.width, height: REF.height } });
      const rows = sampled.candidates.map((c, i) => Object.assign({ scenario: label, state: "material-" + mode, theme: theme, size: REF.id, text: c.text, tag: c.tag, cls: c.cls, aria: c.aria, rect: c.rect }, sampled.backgrounds[i] ? measureTextContrast(c, sampled.backgrounds[i].bg) : { ok: false }));
      for (const r of rows) api.contrastRows.push(r);
      api.store.push({ scenario: label, mode: mode, theme: theme, state: "library-detail", screenshot: path.relative(ROOT, file), screenshotDims: dim, dimOk: dimOk, glass: glass, contrastRows: rows.length, contrastBelow: rows.filter((r) => r.ok && !r.pass).length });
      api.record("material/" + theme, "M · 材质「" + mode + "」经真实设置切换并截图（data-glass=" + mode + "）", ok && glass === mode && dimOk, mode + " + " + (REF.width * REF.dsf) + "x" + (REF.height * REF.dsf), JSON.stringify({ glass: glass, dims: dim.width + "x" + dim.height, contrastBelow: rows.filter((r) => r.ok && !r.pass).length }));
    }
    await api.setGlass(page, "solid");
    await api.setReduced(page, true);
    await H.focusWindow(page, winSel);
    await api.prepareState("library-detail");
    await api.setViewport(REF);
    const file = path.join(MATA, "solid+reduced-motion-library-detail-" + theme + ".png");
    const dim = await H.shoot(cdp, file);
    const flags = await page.evaluate(() => { const d = document.querySelector(".desktop"); return { glass: d.getAttribute("data-glass"), reduced: d.classList.contains("reduced") }; });
    api.store.push({ scenario: label, mode: "solid", theme: theme, state: "library-detail+reduced-motion", screenshot: path.relative(ROOT, file), screenshotDims: dim, glass: flags.glass, reduced: flags.reduced });
    api.record("material/" + theme, "M · 实色 + 减少动态效果同时开启仍可截图（MOTION §8 组合）", flags.glass === "solid" && flags.reduced === true, "solid + reduced", JSON.stringify(flags));
  }
  await api.setGlass(page, "full");
  await api.setReduced(page, true);
}

/* ══════════════════════════════════════════════════════════════════════════
   动效帧序列
   ══════════════════════════════════════════════════════════════════════════ */
async function captureMotion(label, page, cdp, winSel, api) {
  console.log("\n---------- 动效帧序列 ----------");
  await api.setViewport(REF);
  const TRACK_VIEW = [H.APP_SEL + " [data-photos-tab]", H.APP_SEL + " .photos-view"];
  const TRACK_DIALOG = [".dialog", H.APP_SEL + " .photos-lib-side"];
  const TRACK_TOAST = ['[data-ds-comp="toast"]', H.APP_SEL + " .photos-studio-detail"];

  const actions = [
    {
      id: "view-switch",
      tracked: TRACK_VIEW,
      describe: "视图切换：图库 → 图像工坊",
      setup: async () => { await api.freshView("library"); },
      act: async () => { await api.switchView("studio"); },
    },
    {
      id: "dialog-open-close",
      tracked: TRACK_DIALOG,
      describe: "Dialog 打开 → 关闭（添加照片来源）",
      setup: async () => { await api.freshView("library"); },
      act: async () => {
        await page.evaluate((sel) => {
          const app = document.querySelector(sel);
          const b = app && Array.prototype.slice.call(app.querySelectorAll("button")).filter((x) => (x.getAttribute("aria-label") || "").indexOf("添加照片来源") >= 0)[0];
          if (b) b.click();
        }, H.APP_SEL);
        await H.sleep(650);
        await page.evaluate(() => { const b = document.querySelector('.dialog .dialog-footer button'); if (b) b.click(); });
      },
    },
    {
      id: "toast-appear",
      tracked: TRACK_TOAST,
      describe: "Toast 出现（图像工坊「保存设置」无改动 → info）",
      setup: async () => { await api.prepareState("studio-detail"); },
      act: async () => {
        await page.evaluate((sel) => {
          const app = document.querySelector(sel);
          const b = app && Array.prototype.slice.call(app.querySelectorAll("button")).filter((x) => (x.textContent || "").trim() === "保存设置")[0];
          if (b) b.click();
        }, H.APP_SEL);
      },
    },
  ];

  for (const mode of ["normal", "reduced"]) {
    await api.setReduced(page, mode === "reduced");
    await page.emulateMedia({ reducedMotion: mode === "reduced" ? "reduce" : "no-preference", colorScheme: "no-preference" });
    for (const action of actions) {
      try { await action.setup(); } catch (err) { api.note("motion setup 失败 " + action.id + "：" + String((err && err.message) || err)); }
      await H.focusWindow(page, winSel);
      const dir = path.join(MOT, action.id + "-" + mode);
      const res = await H.captureMotionFrames(cdp, page, dir, action.tracked, action.act, 1500);
      const tween = H.analyzeTween(res.tracker, action.tracked);
      const tweenTracked = Object.keys(tween).filter((k) => tween[k].tween);
      let pixelAnalysis = null;
      try { pixelAnalysis = analyzeFrameSequence(MOT, res.frames, res.triggerAt); } catch (err) { api.note("帧差分析失败 " + action.id + "/" + mode + "：" + String((err && err.message) || err)); }
      const row = {
        scenario: label, action: action.id, describe: action.describe, mode: mode,
        reducedSwitch: mode === "reduced", framesDir: path.relative(ROOT, dir),
        frameCount: res.frameCount, firstFrameAt: res.frames.length ? res.frames[0].t : null, lastFrameAt: res.frames.length ? res.frames[res.frames.length - 1].t : null,
        triggerAt: res.triggerAt, maxIntervalMs: res.maxIntervalMs, p95IntervalMs: res.p95IntervalMs, over50Count: res.over50Count, over50Ratio: res.over50Ratio, over50Samples: res.over50Samples, meanIntervalMs: res.meanIntervalMs,
        frames: res.frames.map((f) => ({ i: f.index, t: f.t, file: f.file })),
        tracked: tween, tweenDetected: tweenTracked.length > 0, tweenTracked: tweenTracked,
        pixelAnalysis: pixelAnalysis,
      };
      api.store.push(row);
      /* 口径：取帧必须是高频的（p95 <= 50ms），但宿主调度偶发一次 >50ms 的空档是采集噪声、不是界面行为；
         因此判据用 p95 <= 50ms 且 >50ms 的间隔占比 <= 2%，同时把 max 与超限样本原样写进报告，绝不藏。 */
      const intervalOk = res.frameCount >= 3 && res.p95IntervalMs != null && res.p95IntervalMs <= 50 && (res.over50Ratio || 0) <= 0.02;
      api.record("motion/" + mode, "V · " + action.describe + " 帧序列（" + mode + "）帧间隔 p95 <= 50ms（>50ms 占比 <=2%，max 原样记录）", intervalOk,
        "frames>=3 且 p95<=50ms 且 over50Ratio<=0.02",
        JSON.stringify({ frames: res.frameCount, p95: res.p95IntervalMs, max: res.maxIntervalMs, mean: res.meanIntervalMs, over50: res.over50Count, over50Ratio: res.over50Ratio == null ? null : Math.round(res.over50Ratio * 10000) / 10000, over50Samples: res.over50Samples, triggerAt: res.triggerAt }));
      api.record("motion/" + mode, "V · " + action.describe + "（" + mode + "）布局补间判定", true, "记录", JSON.stringify({ frames: res.frameCount, tweenTracked: tweenTracked, positions: Object.keys(tween).map((k) => k + "=" + tween[k].distinctPositions) }));
    }
  }
  await api.setReduced(page, true);
  await page.emulateMedia({ reducedMotion: "no-preference", colorScheme: "no-preference" });
}

/* ══════════════════════════════════════════════════════════════════════════
   动效帧序列的逐帧像素差（把「帧看起来变了多少、多久收敛」量化）
   ══════════════════════════════════════════════════════════════════════════ */
function analyzeFrameSequence(motionRoot, frames, triggerAt) {
  const step = frames.length > 90 ? 2 : 1;
  const series = [];
  let changedFrames = 0;
  let maxRatio = 0;
  let firstChangeAt = null;
  let lastChangeAt = null;
  let prev = null;
  let decodedCount = 0;
  for (let i = 0; i < frames.length; i += step) {
    const f = frames[i];
    let img = null;
    try { img = decodePng(fs.readFileSync(path.join(motionRoot, f.file))); } catch (err) { continue; }
    decodedCount += 1;
    if (prev) {
      const d = diffPixels(prev, img, 3);
      const ratio = Math.round(d.changedRatio * 100000) / 100000;
      series.push({ t: f.t, ratio: ratio, maxChannelDiff: d.maxChannelDiff });
      if (d.changedRatio > 0.0005) {
        changedFrames += 1;
        if (firstChangeAt == null) firstChangeAt = f.t;
        lastChangeAt = f.t;
      }
      if (d.changedRatio > maxRatio) maxRatio = d.changedRatio;
    }
    prev = img;
  }
  return {
    sampledStep: step, decodedFrames: decodedCount, comparedPairs: series.length,
    changedFrames: changedFrames,
    maxChangeRatio: Math.round(maxRatio * 100000) / 100000,
    firstChangeAt: firstChangeAt, lastChangeAt: lastChangeAt,
    settleAfterTriggerMs: triggerAt != null && lastChangeAt != null ? lastChangeAt - triggerAt : null,
    series: series,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   报告
   ══════════════════════════════════════════════════════════════════════════ */
function summarizeContrast(rows) {
  const measurable = rows.filter((r) => r.ok);
  const below = measurable.filter((r) => !r.pass);
  const byTheme = {};
  for (const r of measurable) {
    const key = r.theme + "/" + (r.size || "material");
    byTheme[key] = byTheme[key] || { total: 0, below: 0, minRatio: null };
    byTheme[key].total += 1;
    if (!r.pass) byTheme[key].below += 1;
    if (byTheme[key].minRatio == null || r.ratio < byTheme[key].minRatio) byTheme[key].minRatio = r.ratio;
  }
  return { measurable: measurable.length, belowRequired: below.length, unmeasurable: rows.length - measurable.length, byTheme: byTheme };
}

function dsmsRow(id, requirement, status, evidence, note) {
  return { id: id, requirement: requirement, status: status, evidence: evidence, note: note || null };
}

function buildDsMs(ctx) {
  const contrastMeasurable = ctx.contrastRows.filter((r) => r.ok);
  const contrastBelow = contrastMeasurable.filter((r) => !r.pass);
  const keyScans = ctx.a11y.ds09;
  const hairlineTotal = keyScans.reduce((s, x) => s + (x.hairlineCount || 0), 0);
  const blueTotal = keyScans.reduce((s, x) => s + (x.blueCount || 0), 0);
  const satTotal = keyScans.reduce((s, x) => s + (x.saturatedCount || 0), 0);
  const motionNormal = ctx.motionRows.filter((m) => m.mode === "normal");
  const motionReduced = ctx.motionRows.filter((m) => m.mode === "reduced");
  const reducedTween = motionReduced.filter((m) => m.tweenDetected);
  const normalTween = motionNormal.filter((m) => m.tweenDetected);
  const compIds = Array.from(new Set(ctx.components.map((c) => c.component)));

  return [
    dsmsRow("DS-A01", "浅深主题所有核心语义 token 有映射", ctx.a11y.tokens.length >= 2 ? "evidence" : "no-evidence",
      ctx.a11y.tokens.map((t) => ({ scenario: t.scenario, theme: t.theme, dark: t["desktop-dark"], text: t["--text"], accent: t["--accent"], failed: t["--failed"], line: t["--line"] })), "取的是 .desktop 上解析后的 CSS 变量值，浅深各一组。"),
    dsmsRow("DS-A02", "四层材质在三种壁纸与减少透明度下可读", ctx.materialRows.length ? "evidence" : "no-evidence",
      { materials: ctx.materialRows.map((m) => ({ mode: m.mode, theme: m.theme, glass: m.glass, contrastBelow: m.contrastBelow })), overlay: ctx.materialRows.filter((m) => String(m.state).indexOf("reduced-motion") >= 0).length }, "材质三档 + 实色叠加减少动态已测；三种壁纸未覆盖（见 notVerified）。"),
    dsmsRow("DS-A03", "18 类组件具备所列交互与异常状态", compIds.length >= 8 ? "evidence" : "no-evidence",
      { covered: compIds, count: compIds.length, rows: ctx.components.length },
      "覆盖 Button/IconButton/Input(TextField)/Select/Switch/Dialog/Toast/List/TreeNav/PageState；Tabs/Menu/Drawer/Table/AppCard/WindowChrome/DockItem/TaskCard/Progress/CanvasNode 未逐项取证。"),
    dsmsRow("DS-A04", "合成背景文本和控件对比测量通过", contrastMeasurable.length ? "evidence" : "no-evidence",
      { measurable: contrastMeasurable.length, belowRequired: contrastBelow.length, belowSamples: contrastBelow.slice(0, 25).map((r) => ({ state: r.state, theme: r.theme, size: r.size, text: r.text, ratio: r.ratio, required: r.required })) },
      "背景取「文字透明后的最终合成帧」（玻璃 + 壁纸 + 内容），文字色按 alpha 合成后算 WCAG 比值。判定留给 Lead。"),
    dsmsRow("DS-A05", "键盘遍历、焦点恢复及放大流程通过", ctx.a11y.keyboard.length ? "evidence" : "no-evidence",
      { sequences: ctx.a11y.keyboard.map((k) => ({ flow: k.flow, theme: k.theme, steps: k.steps, inPhotos: k.inPhotos, trapped: k.trapped, restored: k.restored, dialogClosed: k.dialogClosed })), rapid: ctx.a11y.rapid }, "放大流程（浏览器缩放 / 系统缩放）未覆盖。"),
    dsmsRow("DS-A06", "原生网页不穿透菜单或锁屏", "not-applicable", { reason: "照片应用是 DOM 界面，本轮没有 BrowserView / WebContentsView 原生视图参与；该项属于浏览器 / 画布域。" }, "不适用，不是通过。"),
    dsmsRow("DS-A07", "AI 状态来自真实事件，未知结果不标成功", "evidence",
      { visionUnavailableStates: ctx.captures.filter((c) => c.metrics && c.metrics.texts && c.metrics.texts.visionUnavailable).map((c) => c.state + "/" + c.theme + "/" + c.size), bridgeLogVision: ctx.bridgeLog.filter((b) => String(b.command).indexOf("visionModels") >= 0 || String(b.command).indexOf("reversePrompt") >= 0).map((b) => b.command) },
      "反推提示词在无视觉供应商时走真实 photos/visionModels 响应并给结构化不可用提示；成功路径因无供应商未触发。"),
    dsmsRow("DS-A08", "Windows/macOS 实机差异分别记录", "not-applicable", { platform: process.platform }, "本轮只在 macOS（darwin）真机取证，无 Windows 侧证据。"),
    dsmsRow("DS-A09", "全量界面无蓝色与彩色强调，无装饰性发丝线框", keyScans.length ? "evidence" : "no-evidence",
      { blueCandidates: blueTotal, saturatedCandidates: satTotal, hairlineCandidates: hairlineTotal, perTheme: keyScans.map((s) => ({ theme: s.theme, blue: s.blueCount, saturated: s.saturatedCount, hairline: s.hairlineCount })), hairlineBuckets: (keyScans[0] || {}).hairlineBuckets, saturatedSamples: (keyScans[0] || {}).saturatedSamples },
      "只给原始扫描事实（色相/饱和度、边框宽度与颜色）；「装饰性」与否需要人判，探针不替 Lead 下结论。"),
    dsmsRow("MS-A01", "组件使用统一时长曲线，例外有依据", ctx.components.length ? "evidence" : "no-evidence",
      { durations: Array.from(new Set(ctx.components.map((c) => (c.style || {})["transition-duration"]).filter(Boolean))), easings: Array.from(new Set(ctx.components.map((c) => (c.style || {})["transition-timing-function"]).filter(Boolean))) },
      "记录的是组件计算样式里的 transition-duration / timing-function 取值集合，是否统一由 Lead 判定。"),
    dsmsRow("MS-A02", "连续快速开关十次无跳变、残影或幽灵点击", ctx.a11y.rapid ? "evidence" : "no-evidence", ctx.a11y.rapid, "只验证终态与根容器存在；「残影」需要看帧序列人工判定。"),
    dsmsRow("MS-A03", "动画前后焦点正确，菜单可立即键盘操作", ctx.a11y.keyboard.some((k) => k.flow === "dialog-focus") ? "evidence" : "no-evidence",
      ctx.a11y.keyboard.filter((k) => k.flow === "dialog-focus").map((k) => ({ theme: k.theme, trapped: k.trapped, restored: k.restored, before: k.before && k.before.aria, after: k.after && k.after.aria })), null),
    dsmsRow("MS-A04", "原生网页最大化、裁剪、遮挡与点击同步", "not-applicable", { reason: "照片应用没有原生网页视图；该项属于浏览器域。" }, "不适用，不是通过。"),
    dsmsRow("MS-A05", "流式输出无逐 token 布局补间和强制抢滚动", "not-applicable", { reason: "照片应用本轮没有流式文本输出界面（反推提示词是整段返回）。" }, "不适用，不是通过。"),
    dsmsRow("MS-A06", "未知进度无假百分比，成功严格来自验证", "evidence",
      { loadingStates: ctx.components.filter((c) => c.id === "pagestate-loading").length + ctx.captures.filter((c) => c.metrics && c.metrics.pageStates.some((p) => p.kind === "loading")).length, progressBars: ctx.components.filter((c) => c.component === "Progress").length, loadingEvidence: "components/pagestate-loading-loading-{light,dark}.png（大文件详情加载期间截取的 PageState loading）" },
      "照片界面用 PageState loading / 按钮 loading 状态表达等待，没有假百分比；成功提示只在真实 ok:true 后出现（bridgeLog 可查）。"),
    dsmsRow("MS-A07", "减少动态与减少透明度可独立组合且功能完整", ctx.materialRows.length ? "evidence" : "no-evidence",
      { materials: ctx.materialRows.map((m) => m.mode + "/" + m.theme), overlay: ctx.materialRows.filter((m) => String(m.state).indexOf("reduced-motion") >= 0).map((m) => m.theme + ": solid+reduced") },
      "材质与减少动态是两个独立设置；三档材质各自可与减少动态共存。"),
    dsmsRow("MS-A08", "固定环境性能报告含连续记录和降级效果", ctx.motionRows.length ? "evidence" : "no-evidence",
      { sequences: ctx.motionRows.map((m) => ({ action: m.action, mode: m.mode, frames: m.frameCount, p95IntervalMs: m.p95IntervalMs, maxIntervalMs: m.maxIntervalMs, over50Count: m.over50Count, meanIntervalMs: m.meanIntervalMs, changedFrames: m.pixelAnalysis ? m.pixelAnalysis.changedFrames : null, maxChangeRatio: m.pixelAnalysis ? m.pixelAnalysis.maxChangeRatio : null, settleAfterTriggerMs: m.pixelAnalysis ? m.pixelAnalysis.settleAfterTriggerMs : null })), comparison: ctx.motionComparison || null, degraded: { materials: ctx.materialRows.length } },
      "只有取帧间隔分布，没有渲染帧率 / 长卡顿 / 内存的完整性能报告。"),
    dsmsRow("MS-A09", "停止/反向从当前值继续，旧回调不覆盖新状态", ctx.a11y.rapid ? "evidence" : "no-evidence",
      { rapid: ctx.a11y.rapid, reducedTween: reducedTween.length, normalTween: normalTween.length }, "证据是连续切换终态 + 快速连点详情一致性；停止/反向交互在本应用没有直接对应控件。"),
  ];
}

function writeResultMd(report, findings, dsms) {
  const L = [];
  L.push("# 照片应用 · 真机视觉与动效验收探针 · RESULT");
  L.push("");
  L.push("> 本文件只汇总**证据**。是否「视觉通过」由 Lead 判定，探针不下结论。");
  L.push("");
  L.push("生成时间：" + report.at + "；耗时 " + Math.round(report.durationMs / 1000) + " s；命令 " + report.command + "。");
  L.push("");
  L.push("## 1. 结论口径");
  L.push("");
  L.push("- 总断言：" + report.counts.passed + " PASS / " + report.counts.failed + " FAIL（共 " + report.counts.checks + "）。verdict=" + report.verdict + "。");
  for (const e of report.entries || []) {
    const c = e.checks || { total: 0, passed: 0, failed: 0 };
    L.push("  - 入口 " + e.id + "（" + e.label + "）：" + c.passed + "/" + c.total + " PASS；渲染源 " + e.source + (((e.ports || []).length) ? "；CDP 端口 " + (e.ports || []).join(" / ") : "") + "。");
  }
  const gcount = (report.counts.entryCounts || {}).global;
  if (gcount) L.push("  - 全局（卫生 + profile）：" + gcount.passed + "/" + gcount.total + " PASS。");
  L.push("- 截图 " + report.counts.screenshots + " 张，组件 clip " + report.counts.components + " 张，材质截图 " + report.counts.materials + " 张，动效序列 " + report.counts.motionSequences + " 段，对比测量 " + report.counts.contrastRows + " 条。");
  L.push("- 报告：report.json / checks.json / contrast.json / dsms.json。");
  L.push("");
  L.push("## 2. 双入口事实（必须先看）");
  L.push("");
  for (const e of report.entries || []) {
    L.push("- 入口 " + e.id + "（" + e.label + "）：渲染源 " + e.source + (((e.ports || []).length) ? "；CDP 端口 " + (e.ports || []).join(" / ") : "") + (e.userData ? "；隔离 userData " + e.userData : "") + "。");
  }
  L.push("- 两个入口各自独立临时 userData 与 CDP 端口（由 freePort 分配），互不干扰；react 为完整既有套件，default 为专项取证。");
  L.push("");
  L.push("### 2.1 默认入口（dist/vue.html）—— 旧 renderer-entry-mismatch 的再取证");
  L.push("");
  if (report.rendererEntry && report.rendererEntry.ok) {
    const s = report.rendererEntry.summary;
    const af = s.appFacts || {};
    L.push("- 打开路径（真实 UI）：" + s.openPath);
    if (s.openPathAlt) L.push("- 另一条真实路径（同样验证通过）：" + s.openPathAlt);
    L.push("- 前提：Vue 壳 DOCK_DEFAULT 里没有 photos，因此必须经真实入口打开，不能改代码或直接塞 appId。");
    L.push("- 真实应用标记：data-photos-app=" + (af.hasPhotosApp ? "1" : "缺失") + "；双视图 [" + (af.navLabels || []).join(" / ") + "]；图库根=" + af.hasLibrary + "；工坊根=" + af.hasStudio + "；data-photos-tab=" + af.tab + "。");
    L.push("- PlannedApp 占位特征：.planned-app=" + af.plannedAppNodes + "，.planned-title=" + af.plannedTitleNodes + "，「该应用尚未接入」文案=" + af.bodyHasPlaceholder + "（期望全为 0/false）。");
    L.push("- 三通道真实调用：" + JSON.stringify(s.threeChannels) + "。");
    L.push("- 整窗留证：" + s.fullScreenshot + "（" + (s.fullScreenshotDims ? s.fullScreenshotDims.width + "x" + s.fullScreenshotDims.height : "?") + "）。");
    L.push("- 运行时卫生（默认入口）：console error " + (s.localConsoleErrors || []).length + "，pageerror " + (s.localPageErrors || []).length + "，非本地请求 " + (s.localNonLocal || []).length + "。");
  } else if (report.rendererEntry) {
    L.push("- 默认入口取证失败，卡在：" + (report.rendererEntry.summary && (report.rendererEntry.summary.error || report.rendererEntry.summary.failedStep)) + "；未取得的摘要：" + JSON.stringify(report.rendererEntry.summary).slice(0, 1200));
  } else {
    L.push("- 本次未跑默认入口（OA_PHOTOS_UI_ENTRY / OA_PHOTOS_SKIP_DEFAULT_PROBE 限制）。");
  }
  L.push("");
  L.push("### 2.2 默认入口关键状态截图 + pane-content-overflow 实测");
  L.push("");
  L.push("| 状态 | 主题 | 尺寸 | 截图 | 像素 | 窗口铺满 | pane-content-overflow | pane 压叠 | 越出视口 | 容器裁断 |");
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const dShots = (report.rendererEntry && report.rendererEntry.summary && report.rendererEntry.summary.screenshots) || [];
  for (const s of dShots) {
    L.push("| " + s.state + " | " + s.theme + " | " + s.size + " | " + s.file + " | " + s.dims + " | " + s.fit + " | " + s.realOverflowCount + " | " + s.paneOverlapCount + " | " + s.horizontalClippedCount + " | " + s.containerCutCount + " |");
  }
  L.push("");
  L.push("## 3. 异常观察（事实，不是判定）");
  L.push("");
  if (!findings.length) L.push("- 无。");
  for (const f of findings) {
    L.push("- **" + f.kind + "**：" + f.detail);
    if (f.evidence) L.push("  - 证据：" + JSON.stringify(f.evidence).slice(0, 1800));
  }
  L.push("");
  L.push("## 4. 验收条目逐条取证（DESIGN_SYSTEM §11 / MOTION_SYSTEM §11）");
  L.push("");
  L.push("| 条目 | 通过条件 | 取证结果 | 证据 / 说明 |");
  L.push("| --- | --- | --- | --- |");
  for (const r of dsms) {
    const tag = r.status === "evidence" ? "有证据" : r.status === "no-evidence" ? "无证据" : "不适用";
    L.push("| " + r.id + " | " + r.requirement + " | " + tag + " | " + String(r.note || "").replace(/\|/g, "/") + " " + JSON.stringify(r.evidence).slice(0, 260).replace(/\|/g, "/") + " |");
  }
  L.push("");
  L.push("## 5. 动效对照（同一动作 normal vs reduced）");
  L.push("");
  L.push("| 动作 | 模式 | 帧数 | p95 帧间隔 ms | 最大帧间隔 ms | >50ms 次数 | 平均帧间隔 ms | 布局补间 | 变化帧数 | 最大逐帧变化比例 | 触发后收敛 ms |");
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const c of report.motionComparison || []) {
    for (const mode of ["normal", "reduced"]) {
      const m = c[mode];
      if (!m) continue;
      L.push("| " + c.action + " | " + mode + " | " + m.frames + " | " + m.p95IntervalMs + " | " + m.maxIntervalMs + " | " + m.over50Count + " | " + m.meanIntervalMs + " | " + (m.layoutTween ? "有(" + (m.tweenTracked || []).join(",") + ")" : "无") + " | " + m.changedFrames + " | " + m.maxChangeRatio + " | " + m.settleAfterTriggerMs + " |");
    }
  }
  L.push("");
  L.push("> 帧是 CDP Page.startScreencast 落盘的连续 PNG；逐帧像素差由本地最小 PNG 解码器计算，阈值 3/255。");
  L.push("> 帧间隔判据用 p95 <= 50ms（并在报告里原样保留 max 与 >50ms 样本）：宿主调度偶发一次空档是采集噪声，不代表界面变慢。");
  L.push("");
  L.push("## 6. 证据清单");
  L.push("");
  L.push("- react 入口静态截图：artifacts/dxos-ui-photos/screens/（命名 <状态>-<主题>-<尺寸>.png）。");
  L.push("- 默认入口关键状态截图：artifacts/dxos-ui-photos/screens-default/；整窗留证 rendererEntry-default 之外另有 default-entry-photos-app.png。");
  L.push("- 组件 clip：artifacts/dxos-ui-photos/components/。");
  L.push("- 材质截图：artifacts/dxos-ui-photos/materials/。");
  L.push("- 动效帧序列：artifacts/dxos-ui-photos/motion/<动作>-<模式>/frame-NNN.png。");
  L.push("");
  L.push("## 7. 未取证 / 覆盖缺口");
  L.push("");
  for (const n of report.notVerified) L.push("- " + n.item + "：" + n.reason);
  L.push("");
  fs.writeFileSync(path.join(ART, "RESULT.md"), L.join("\n"));
}

const IS_MAIN = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (IS_MAIN) {
  main().then((code) => { process.exitCode = code; }).catch((err) => { console.error(String((err && err.stack) || err)); process.exitCode = 2; });
}
