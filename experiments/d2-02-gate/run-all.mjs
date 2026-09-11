/**
 * D2-02A Window Architecture Gate 全量运行。
 *
 * 顺序有依赖：00 号探针先证明"仪器可信"，后面五个探针的结论才成立。
 * 因此 00 失败即中止，不继续跑其余探针（避免在不可信的测量上得出架构结论）。
 *
 * 运行：ELECTRON_EXTRA_ARGS="--no-sandbox --disable-gpu-sandbox --in-process-gpu" \
 *       node experiments/d2-02-gate/run-all.mjs
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const artifacts = path.join(here, "..", "..", "artifacts", "d2-02");
const steps = [
  ["00-instrument", "仪器校验（capturePage 局限 / screencapture 真值 / 焦点 / 输入注入）"],
  ["01-occlusion", "遮挡与层级（网页盖住 DOM、鼠标跟随真实层级、部分遮挡、圆角）"],
  ["02-input", "输入路由与对话框阻断（§17 硬验收）"],
  ["03-multiview", "多视图并存、生命周期、会话与分区（§11/§12/§13）"],
  ["04-childwindow", "候选 D 原生 child 窗口的收益与代价"],
  ["05-snapshot", "部分遮挡的三种缓解策略对比"],
  ["06-stress", "双浏览器 + 覆盖层连续压力流程（§39）"],
];

const summary = [];
let failedEarly = false;
/** 只与执行环境有关、与产品无关的用例：失败不中止 Gate，但会在汇总里显示。 */
const ENV_TOLERANT = ["inst.focusPreconditionWindowIsKey"];
for (const [probe, title] of steps) {
  console.log(`\n${"=".repeat(78)}\n== ${probe} · ${title}\n${"=".repeat(78)}`);
  const r = spawnSync(process.execPath, [path.join(here, `${probe}.mjs`)], {
    stdio: "inherit",
    env: process.env,
  });
  const artifact = path.join(artifacts, `${probe}.json`);
  let stats = { pass: 0, fail: 0, total: 0 };
  let realFailures = [];
  if (fs.existsSync(artifact)) {
    const report = JSON.parse(fs.readFileSync(artifact, "utf8"));
    const cases = report.cases || [];
    stats = { pass: cases.filter((c) => c.ok).length, fail: cases.filter((c) => !c.ok).length, total: cases.length };
    realFailures = cases.filter((c) => !c.ok && !ENV_TOLERANT.includes(c.id)).map((c) => c.id);
    if (report.errors?.length) stats.errors = report.errors.length;
  }
  summary.push({ probe, title, exit: r.status, ...stats, realFailures });
  if (probe === "00-instrument" && (realFailures.length > 0 || stats.errors)) {
    console.log(
      `\n⚠️ 仪器校验未通过（非环境项失败：${realFailures.join(", ") || "探针错误"}）—— 测量手段不可信，后续结论无意义，已中止。`,
    );
    failedEarly = true;
    break;
  }
}

console.log(`\n${"=".repeat(78)}\n== D2-02A Gate 汇总\n${"=".repeat(78)}`);
for (const s of summary) {
  console.log(
    `  ${s.exit === 0 ? "OK  " : "FAIL"} ${s.probe.padEnd(16)} ${String(s.pass).padStart(3)}/${String(s.total).padEnd(3)} 通过` +
      `${s.errors ? `  探针错误 ${s.errors}` : ""}  ${s.title}`,
  );
}
fs.mkdirSync(artifacts, { recursive: true });
fs.writeFileSync(path.join(artifacts, "gate-summary.json"), JSON.stringify({ summary, failedEarly }, null, 2));

const anyFail = failedEarly || summary.some((s) => s.exit !== 0);
console.log(anyFail ? "\nD2-02A Gate：存在失败项" : "\nD2-02A Gate：全部通过");
process.exit(anyFail ? 1 : 0);
