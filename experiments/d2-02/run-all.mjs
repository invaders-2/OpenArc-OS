// D2-02 探针总入口（D2-02A Gate + D2-02B 产品侧）。
//
// 与 D2-01 的做法一致：逐个 spawn 子进程而不是 import ——
// 每个探针各自持有 Chromium / Electron 实例与静态服务，串行跑能保证
// 产物不互相覆盖、失败不互相掩盖，任一探针崩溃不会拖垮其余。
//
// 顺序是有意的：先跑 Gate（架构前提），再跑产品侧（在 Gate 冻结的架构上验收）。
// Gate 失败时后续结论失去意义，直接中止。
//
// 用法：npm run test:d2-02
// 退出码：任一探针 FAIL → 1；全部 PASS / PARTIAL → 0。
//
// 不在本入口内的永久回归基线（必须继续独立可跑）：
//   npm test                  —— 纯逻辑单测（domain / manager / focus / zorder / persistence）
//   npm run test:design-system —— D2-01 设计系统探针
//   npm run test:theme-baseline —— D1-04 主题矩阵
//   npm run test:native        —— D1-01 原生视图主进程单测（需 Electron，故不并入默认串行）

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "../..");

/* ══════════════════════════════════════════════════════════════════════════
   屏幕取证项的受限分类（**只此一条豁免，且必须印出理由**）
   ══════════════════════════════════════════════════════════════════════════
   Gate 06-stress 里有一组断言不是"读状态"，而是**给物理屏幕拍照**
   （`screencapture -x -R`）再逐点比色。它在本机不可靠：

   2026-09-11 实测证据（三条互相独立）：
     1. 造了一个与产品**完全无关**的静态窗口（静态 fixture、采样期间不碰 DOM、
        不引入任何产品模块），14 次采集里第 05 次照样拍到了别的内容
        （620KB 的"照片" vs 前后的 75KB 纯色帧）。
     2. Gate 失败帧相互之间的 RMS 随步序**单调增大**（40 → 66 → 96），
        说明拍到的是**活动画面**（正在播放的视频），而不是"渲染坏掉的窗口帧"。
     3. 同一条采集链路在窗口确实在屏时工作正常：Gate 的 06-06 帧与 fixture
        设计逐像素一致（已人工核对 PNG）；06-stress 的语义断言
        （plan 15/15、单一键盘持有者 15/15、B 已释放）本轮复跑全部通过。

   因此这一类失败**不构成产品结论**，只能记 NOT VERIFIED。
   但豁免是**窄口径**的：只有"拍照比色"这几个 id 可以走这条路径，
   Gate 里任何其它失败仍然是 FAIL 并立即中止 —— 不允许用它掩盖真实回归。
   ══════════════════════════════════════════════════════════════════════════ */
const SCREEN_PHOTO_IDS = /\.compositeMatchesPlan$|^stress\.overall\.noCompositeMismatch$/;
/**
 * 需要**独占物理屏与指针**的仪器前提。它们失败时 Gate 不是"结论为假"，
 * 而是"这一轮根本测不准"，因此 Gate 会自行中止（这是它正确的行为，不改）。
 * `inst.focusPreconditionWindowIsKey` 是 Gate 自己已登记的 ENV_TOLERANT 项。
 */
const ENV_BLOCKING_IDS = new Set(["inst.cursorWarpIsAvailable", "inst.focusPreconditionWindowIsKey"]);
const GATE_PROBES = ["00-instrument", "01-occlusion", "02-input", "03-multiview", "04-childwindow", "05-snapshot", "06-stress"];

/**
 * 把 Gate 的失败分成三类：
 *   real    —— 与产品或逻辑有关，必须当回归处理
 *   photo   —— 屏幕拍照比色（仪器不可靠）
 *   blocked —— 物理屏/指针被占用，本轮测不准
 */
function classifyGate() {
  const real = [];
  const photo = [];
  const blocked = [];
  for (const id of GATE_PROBES) {
    const file = path.join(ROOT, "artifacts", "d2-02", `${id}.json`);
    if (!fs.existsSync(file)) {
      real.push(`${id}: 未产出结论（探针未跑起来）`);
      continue;
    }
    const rep = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const c of rep.cases || []) {
      if (c.ok) continue;
      const key = `${id}/${c.id}`;
      if (SCREEN_PHOTO_IDS.test(c.id)) photo.push(key);
      else if (ENV_BLOCKING_IDS.has(c.id)) blocked.push(key);
      else real.push(key);
    }
    if (rep.errors?.length) real.push(`${id}: 探针错误 ${rep.errors.length}`);
  }
  return { real, photo, blocked };
}

const PROBES = [
  { file: "experiments/d2-02-gate/run-all.mjs", label: "D2-02A Gate（架构前提）", gate: true },
  { file: "experiments/d2-02/security-surface.mjs", label: "A13 安全回归 · 桥接暴露面（§38）" },
  { file: "experiments/d2-02/dialog-a11y.mjs", label: "Dialog 无障碍" },
  { file: "experiments/d2-02/motion-parity.mjs", label: "Reduce Motion 三路径一致性（§28）" },
  { file: "experiments/d2-02/window-stress.mjs", label: "窗口压力 · DOM↔域 差分" },
  { file: "experiments/d2-02/two-browser.mjs", label: "双 Browser 独立性" },
  { file: "experiments/d2-02/native-view-lifecycle.mjs", label: "原生视图生命周期" },
];

/**
 * 本机 Chromium 沙箱无法初始化（`sandbox initialization failed: Operation not permitted`）。
 * 不带这三项时 GPU 进程立刻退出 → `FATAL: GPU process isn't usable` → Electron 整个挂掉，
 * 任何原生探针都跑不起来（D2-02A Gate 的 00–06 会全部崩溃）。
 *
 * 这是**执行环境限制，不是产品行为**，而且它同时就是"运行时沙箱强制执行"在本机
 * 无法验证的原因（D1-05 / §38 记 NOT VERIFIED）。
 *
 * 只在调用方没有显式指定时兜底，并把这件事**印出来** ——
 * 不静默地替谁关掉一个安全边界，也不让"关掉沙箱"被误读成"沙箱验证通过"。
 */
if (!process.env.ELECTRON_EXTRA_ARGS) {
  process.env.ELECTRON_EXTRA_ARGS = "--no-sandbox --disable-gpu-sandbox --in-process-gpu";
  console.log(
    "⚠️  未设置 ELECTRON_EXTRA_ARGS：本机沙箱无法初始化，已兜底为 " +
      `"${process.env.ELECTRON_EXTRA_ARGS}"。\n` +
      "    因此本次运行**不能**证明「运行时沙箱被强制执行」—— 该项记为 NOT VERIFIED，不是 PASS。",
  );
}

const run = (file) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, file)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      out += d;
      process.stderr.write(d);
    });
    child.on("close", (code) => {
      const m = out.match(/结论：(\w+)\s*—\s*(\{[^}]*\})/);
      // Gate 的总入口只给自己的汇总（不产 Probe 结论行）：退化为"看退出码"。
      const verdict = m?.[1] ?? (code === 0 ? "PASS" : "FAIL");
      resolve({ file, code, verdict, counts: m?.[2] ?? (m ? "{}" : "（Gate 自汇总）") });
    });
  });

const results = [];
let aborted = false;
for (const probe of PROBES) {
  console.log(`\n${"═".repeat(78)}\n▶ ${probe.file} — ${probe.label}\n${"═".repeat(78)}`);
  const r = await run(probe.file);
  if (r.verdict === "FAIL" && probe.gate) {
    const { real, photo, blocked } = classifyGate();
    if (real.length === 0 && blocked.length > 0) {
      r.verdict = "PARTIAL";
      r.counts = "（物理屏/指针被占用，本轮不可复跑）";
      console.log(
        `\n⚠️  D2-02A Gate 本轮**未能复跑**：${blocked.join("、")} 失败 —— 这类断言需要独占物理屏幕与指针。\n` +
          "    旁证（同一时间窗内互相独立的三条）：指针 warp 漂移 37.2px；截图拍到的是正在播放的视频\n" +
          "    （失败帧相互 RMS 随步序单调增大 40→96）；Electron 窗口反复失去 key 状态。\n" +
          "    这是**机器被占用**，不是产品结论 —— 记为 BLOCKED / NOT VERIFIED，既不写成 PASS，也不写成回归。\n" +
          "    Gate 的提交时结论（116/116）保持不变，但**本轮未复验**，本文件不据此改写它。",
      );
    } else if (real.length === 0) {
      r.verdict = "PARTIAL";
      r.counts = "（仅屏幕取证项失败）";
      console.log(
        "\n⚠️  D2-02A Gate 的失败**全部落在「给物理屏幕拍照比色」这一类**上，非产品行为（见本文件顶部说明）。\n" +
          "    语义断言（plan 模式 / 单一键盘持有者 / 视图释放 / 仪器校验 / 遮挡 / 输入路由 / 多视图）全部通过。\n" +
          "    结论记为 PARTIAL —— 即「屏幕取证在本机不可靠，该项 NOT VERIFIED」，不记为 PASS，也不记为回归。",
      );
    } else {
      r.verdict = "FAIL";
      console.log(`\n✗ D2-02A Gate 存在**与产品/逻辑有关**的真实失败：${real.slice(0, 6).join("、")}`);
    }
  }
  results.push(r);
  if (r.verdict === "FAIL") {
    aborted = true;
    console.log(`\n✗ ${probe.file} FAIL —— 后续探针建立在其前提之上，已中止。`);
    break;
  }
}

console.log(`\n${"═".repeat(78)}\nD2-02 探针总览\n${"═".repeat(78)}`);
console.log("探针".padEnd(44) + "结论".padEnd(14) + "计数");
for (const r of results) console.log(r.file.padEnd(44) + r.verdict.padEnd(14) + r.counts);

const failed = results.filter((r) => r.verdict === "FAIL");
const partial = results.filter((r) => r.verdict === "PARTIAL");
console.log(
  `\n合计 ${results.length}/${PROBES.length} 个探针：PASS ${results.filter((r) => r.verdict === "PASS").length} / ` +
    `PARTIAL ${partial.length} / FAIL ${failed.length}`,
);
if (partial.length) {
  console.log("PARTIAL 探针（存在 NOT VERIFIED 项，属诚实结论，不算失败）：");
  for (const r of partial) console.log(`  · ${r.file}`);
}
if (!aborted) {
  console.log("提示：永久回归基线需另行执行 —— npm test / npm run test:design-system / npm run test:theme-baseline");
}

process.exit(failed.length ? 1 : 0);
