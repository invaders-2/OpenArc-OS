/** 探针子进程：如实报告自己看到的 argv / execPath / stdin，并把读到的东西写回 stdout。 */
"use strict";
const info = { event: "child-up", argv: process.argv, execPath: process.execPath, pid: process.pid, ppid: process.ppid, stdinType: typeof process.stdin, stdinIsTTY: !!(process.stdin && process.stdin.isTTY) };
process.stdout.write(JSON.stringify(info) + "\n");
let got = "";
if (process.stdin && typeof process.stdin.on === "function") {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => { got += String(d); process.stdout.write(JSON.stringify({ event: "child-stdin", data: String(d).slice(0, 200) }) + "\n"); });
  process.stdin.on("end", () => { process.stdout.write(JSON.stringify({ event: "child-stdin-end", got: got.slice(0, 200) }) + "\n"); });
}
setTimeout(() => process.exit(0), 4000);
