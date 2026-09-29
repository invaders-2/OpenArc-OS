/** D4-02C 可控阻塞探针：最小 ACP v1 agent，initialize 永不返回 → 真实触发产品启动预算（HARNESS_START_TIMEOUT）。 */
import readline from "node:readline";

// 收到任何请求都不回应，但保持进程存活：超时必须由产品自己的启动预算判定，而不是探针主动退出。
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", () => {});

process.stdin.resume();
