/**
 * BATCH15 · **只读证据补齐预载**（不属于产品，不属于门禁）。
 *
 * 为什么存在：门禁 `visibility-e2e.mjs` 的 `record()` 把 `actual` 截到 2400 字符，
 * V11 的 8 个落点里最后 1~2 个落点的原始值（pixel / last / click.attempt）因此没有落盘，
 * 无法直接给出逐落点表。本预载在**不修改任何冻结文件、不改动任何判据、不改动任何返回值**
 * 的前提下，把门禁进程内部生成的、超过 2000 字符的探针 JSON 原样另存一份到 verify/captured/。
 *
 * 边界：包装后的 `JSON.stringify` 返回值与原函数完全一致；只有 stdout 之外的
 * 旁路落盘，门禁自己的产物 JSON 与结论不受影响。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 输出目录可由环境变量指定（NODE_OPTIONS 里的路径不能含空格，故用无空格入口 + 环境变量定位落盘目录）。
const OUT = process.env.BATCH15_CAPTURE_DIR || path.join(HERE, "captured");
fs.mkdirSync(OUT, { recursive: true });

const MARKERS = ['"pixelGreen"', '"hitOk"', '"backView"', '"probes"'];
const original = JSON.stringify;
let seq = 0;

JSON.stringify = function patched(value, ...rest) {
  const text = original.call(this, value, ...rest);
  try {
    if (typeof text === "string" && text.length > 2000 && MARKERS.some((m) => text.includes(m))) {
      seq += 1;
      const name = "payload-" + String(seq).padStart(3, "0") + "-" + text.length + ".json";
      fs.writeFileSync(path.join(OUT, name), text);
    }
  } catch { /* 旁路失败绝不影响门禁 */ }
  return text;
};

process.on("exit", () => {
  try { fs.writeFileSync(path.join(OUT, "_index.txt"), "captured=" + seq + "\n"); } catch { /* ignore */ }
});
