/**
 * D2-02A Gate 原生探针宿主。
 *
 * 必须以**目录**方式启动（`electron <nativeDir>`），不能直接把 .cjs 文件当参数传给 Electron：
 * 传文件路径时 Electron 会退化成 Node 模式（`process.type === undefined`，
 * `require("electron")` 返回 npm 包里的二进制路径字符串而非 API 对象）。
 * 这条踩坑记录见 docs/decisions/D2-02-window-system.md。
 *
 * 用法：GATE_PROBE=00-instrument electron <nativeDir> [chromium switches]
 * 输出：最后一行 `RESULT {...}`。
 */
const { app } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const name = process.env.GATE_PROBE || "";
const out = (l) => process.stdout.write(l + "\n");
const report = { probe: name, cases: [], errors: [], env: {}, probes: [] };

const sandboxPrefix = (ms) => new Promise((r) => setTimeout(r, ms));

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

  // 宿主负责 whenReady；探针只关心业务。
  await app.whenReady();
  report.env = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    electronNode: process.versions.node,
    platform: process.platform + "/" + process.arch,
    processType: process.type,
    electronSwitches: process.argv.slice(2),
  };
  try {
    await mod.run({ report, out, sleep: sandboxPrefix, add: makeAdd(report, out) });
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
