/**
 * D2-02B 产品侧原生探针宿主。
 *
 * 与 experiments/d2-02-gate/native/main.cjs 同样的启动方式，两点差别：
 *   1. 探针读的是**产品真实模块**（electron/native-view-controller.cjs），
 *      不是顺手写的等价物。Gate 证的是"Electron API 能不能做到"，
 *      这里证的是"我们写的那段代码是否真的做到了"。
 *   2. 探针文件放在 experiments/d2-02/native/probes/。
 *
 * 必须以**目录**方式启动（`electron <dir>`）。传 .cjs 文件路径时 Electron 会退化成
 * Node 模式：`process.type === undefined`、`require("electron")` 返回二进制路径字符串。
 * 另：本机执行环境会导出 `ELECTRON_RUN_AS_NODE=1`，由 runNative/cleanEnv 显式剥离。
 *
 * 用法：GATE_PROBE=01-lifecycle electron experiments/d2-02/native --no-sandbox …
 * 输出：最后一行 `RESULT {...}`。
 */
const { app } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const name = process.env.GATE_PROBE || "";
const out = (l) => process.stdout.write(l + "\n");
const report = { probe: name, cases: [], errors: [], env: {} };

(async () => {
  let mod = null;
  try {
    if (!name) throw new Error("未指定 GATE_PROBE");
    const file = path.join(__dirname, "probes", `${name}.cjs`);
    if (!fs.existsSync(file)) throw new Error("探针不存在：" + file);
    mod = require(file);
  } catch (e) {
    report.errors.push("装载失败：" + String((e && e.stack) || e));
    return finish();
  }

  await app.whenReady();
  report.env = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform + "/" + process.arch,
    processType: process.type,
    electronSwitches: process.argv.slice(2),
  };
  try {
    await mod.run({ report, out, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), add: makeAdd(report, out) });
  } catch (e) {
    report.errors.push(String((e && e.stack) || e));
  }
  finish();

  function makeAdd(rep, write) {
    return (id, ok, detail, data) => {
      rep.cases.push({ id, ok: !!ok, detail: String(detail), data: data === undefined ? null : data });
      write(`${ok ? "PASS" : "FAIL"} ${id} :: ${detail}`);
    };
  }
  function finish() {
    out("RESULT " + JSON.stringify(report));
    app.quit();
  }
})();
