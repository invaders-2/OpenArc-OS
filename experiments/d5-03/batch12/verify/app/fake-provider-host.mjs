/**
 * D5-03 第十一批 · 受控假 Provider 的**独立进程**宿主。
 *
 * 为什么必须独立进程：把 Provider 放在 Electron 主进程里，它就与产品共用一个事件循环 ——
 * 退出时那条监听 socket 会一直把进程留住（实测：收尾跑完、`app.quit()` 不再推进，只能被外部杀），
 * 于是「应用正常退出」这件事根本测不出来。放到子进程后，Electron 退出只受产品自己影响。
 *
 * 用法：node fake-provider-host.mjs <behavior>
 * 就绪后 stdout 打一行 JSON：{"baseUrl":"http://127.0.0.1:<port>"}
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "../../../../..");
const { startFakeProvider } = await import(pathToFileURL(path.join(ROOT, "tests/model-fake-provider.mjs")).href);

const behavior = process.argv[2] || "success";
const fp = await startFakeProvider({ behavior });
process.stdout.write(JSON.stringify({ baseUrl: fp.baseUrl, behavior, pid: process.pid }) + "\n");

const shutdown = async () => { try { await fp.close(); } catch { /* ignore */ } process.exit(0); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.resume();
