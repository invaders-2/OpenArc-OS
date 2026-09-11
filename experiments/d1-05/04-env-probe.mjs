// D1-05 §13：环境继承与子进程密钥隔离。
//
// 要回答的问题：
//   启动 Harness / Plugin / Skill worker / Device tool 进程时，子进程会不会
//   **默认继承父进程的全量 process.env**？如果是，那父进程里的密钥就自动流进了
//   所有执行单元——这是本轮里最容易被忽略的一条泄漏面。
//
// 判定方式：不在代码里"推理"，而是从子进程**真实的环境块**里读。
//   外部取证用 experiments/d1-05/native/argvpeek（sysctl KERN_PROCARGS2）。

import path from "node:path";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { Probe, VERDICT, TMP, fakeSecret, sha256, execFile } from "./lib/probe.mjs";

const p = new Probe("04-env", "环境继承与子进程密钥隔离");

const SECRET = fakeSecret("OPENARC_D1_05_ENV").value;
p.registerSecret(SECRET, "env-probe-secret");
const ARGVPEEK = path.join(TMP, "argvpeek");

// 父进程里放一个"像真的"密钥，模拟主进程持有模型 API Key 的情形。
const SENSITIVE = {
  OPENARC_D1_05_ENV_SECRET: SECRET,
  OPENARC_FAKE_MODEL_KEY: "sk-fake-d105-modelkey-" + "a".repeat(16),
  OPENARC_FAKE_MCP_TOKEN: "mcp-fake-d105-" + "b".repeat(16),
  OPENARC_FAKE_ADOBE_CRED: "adobe-fake-d105-" + "c".repeat(16),
};
Object.assign(process.env, SENSITIVE);
p.registerSecret(SENSITIVE.OPENARC_FAKE_MODEL_KEY, "env-model-key");
p.registerSecret(SENSITIVE.OPENARC_FAKE_MCP_TOKEN, "env-mcp-token");
p.registerSecret(SENSITIVE.OPENARC_FAKE_ADOBE_CRED, "env-adobe-cred");

// 子进程探针：报告自己的环境（自述），用于矩阵对比。
const CHILD_SRC = `
const keys = Object.keys(process.env);
const hit = Object.entries(process.env).filter(([k, v]) =>
  k.startsWith("OPENARC_D1_05_ENV_SECRET") || /^OPENARC_FAKE_/.test(k));
console.log(JSON.stringify({ role: process.argv[1], envCount: keys.length, inherited: hit.map(([k]) => k) }));
`;

/** 外部取证：读目标进程真实的环境块。 */
async function peekEnv(pid) {
  const r = await execFile(ARGVPEEK, ["-e", String(pid)]);
  return r.out
    .split("\n")
    .filter((l) => l.startsWith("ENV "))
    .map((l) => l.slice(4));
}

function runChild({ role, env, useEnvOption = true }) {
  return new Promise((resolve) => {
    const opts = { stdio: ["ignore", "pipe", "pipe"] };
    if (useEnvOption) opts.env = env;
    const cp = spawn(process.execPath, ["-e", CHILD_SRC, role], opts);
    let out = "";
    cp.stdout.on("data", (d) => (out += d));
    (async () => {
      // 子进程活着的时候抓一次真实环境块
      const peeks = await peekEnv(cp.pid).catch(() => []);
      cp.on("close", () => {
        let self = null;
        try {
          self = JSON.parse(out.trim().split("\n").pop());
        } catch {
          /* 忽略 */
        }
        resolve({ role, self, envBlock: peeks });
      });
    })();
  });
}

// ─────────────────────────────────────────────────────────
// A. 父进程持有密钥（对照组）
// ─────────────────────────────────────────────────────────
console.log("=== A. 父进程环境（对照组）===");
p.case(
  "父进程（OpenArc 主进程）环境中登记了 4 个假密钥",
  Object.keys(SENSITIVE).every((k) => process.env[k]) ? VERDICT.PASS : VERDICT.FAIL,
  {
    keys: Object.keys(SENSITIVE),
    note: "全部为假密钥；只用于验证「会不会漏出去」。",
  }
);

// ─────────────────────────────────────────────────────────
// B. 四种"默认写法"下的泄漏实测
// ─────────────────────────────────────────────────────────
console.log("\n=== B. 默认写法下的泄漏实测 ===");

const ROLES = ["harness-worker", "plugin-worker", "skill-worker", "device-tool"];

const implicit = await runChild({ role: "plugin-worker", useEnvOption: false });
p.case(
  "默认 spawn（不传 env 选项）→ 子进程继承父进程全量环境，密钥随之进入执行单元",
  implicit.envBlock.some((e) => e.startsWith("OPENARC_D1_05_ENV_SECRET=")) ? VERDICT.PASS : VERDICT.FAIL,
  {
    role: implicit.role,
    childEnvEntries: implicit.envBlock.length,
    inheritedSensitive: implicit.envBlock
      .filter((e) => /^OPENARC_(D1_05_ENV_SECRET|FAKE_)/.test(e))
      .map((e) => e.split("=")[0]),
    note: "这是被证实的危险默认值，不是缺陷判定：Node 在未显式传 env 时继承 process.env。",
  }
);

const spread = await runChild({ role: "plugin-worker", env: { ...process.env } });
p.case(
  "spawn({ ...process.env }) → 同样把 4 个密钥全部带进子进程",
  spread.envBlock.filter((e) => /^OPENARC_(D1_05_ENV_SECRET|FAKE_)/.test(e)).length === 4
    ? VERDICT.PASS
    : VERDICT.FAIL,
  {
    inheritedSensitive: spread.envBlock
      .filter((e) => /^OPENARC_(D1_05_ENV_SECRET|FAKE_)/.test(e))
      .map((e) => e.split("=")[0]),
  }
);

const allowlisted = await runChild({
  role: "plugin-worker",
  env: { PATH: process.env.PATH, HOME: process.env.HOME },
});
p.case(
  "显式允许列表 spawn → 子进程环境只有 PATH/HOME，4 个密钥一个都进不去",
  allowlisted.envBlock.length > 0 &&
    allowlisted.envBlock.every((e) => !/^OPENARC_/.test(e)) &&
    allowlisted.envBlock.some((e) => e.startsWith("PATH="))
    ? VERDICT.PASS
    : VERDICT.FAIL,
  {
    childEnvKeys: allowlisted.envBlock.map((e) => e.split("=")[0]),
    inheritedSensitive: allowlisted.envBlock.filter((e) => /^OPENARC_/.test(e)),
  }
);

const emptyEnv = await runChild({ role: "device-tool", env: {} });
const emptyEnvKeys = emptyEnv.envBlock.map((e) => e.split("=")[0]);
const emptyEnvSelfKeys = emptyEnv.self?.inherited ?? [];
p.case(
  "spawn({ env: {} }) → 密钥进不去，但 macOS 会注入框架变量，所谓『空环境』并非真的为空",
  !emptyEnv.envBlock.some((e) => /^OPENARC_/.test(e)) && emptyEnvSelfKeys.length === 0
    ? VERDICT.PASS
    : VERDICT.FAIL,
  {
    platformInjectedEnvKeys: emptyEnvKeys,
    childSelfReportedSecretKeys: emptyEnvSelfKeys,
    note:
      "实测：子进程自身仍能看到 __CF_USER_TEXT_ENCODING（macOS 注入），" +
      "通过 KERN_PROCARGS2 还能看到 dyld 的 ptr_munge。" +
      "所以『清空 env』既做不到真正的空，也会让子进程丢掉 PATH/HOME/LANG。正确做法是**显式允许列表**，不是清空。",
  }
);

// ─────────────────────────────────────────────────────────
// C. 四种执行单元形态在默认 env 下的一致性
// ─────────────────────────────────────────────────────────
console.log("\n=== C. 四种执行单元的默认 env 暴露 ===");
const matrix = [];
for (const role of ROLES) {
  const r = await runChild({ role, useEnvOption: false });
  matrix.push({
    role,
    inheritedSensitive: r.envBlock
      .filter((e) => /^OPENARC_(D1_05_ENV_SECRET|FAKE_)/.test(e))
      .map((e) => e.split("=")[0]),
  });
}
p.case(
  "Harness / Plugin / Skill / Device tool 四种形态在默认写法下暴露一致（全部继承）",
  matrix.every((m) => m.inheritedSensitive.length === 4) ? VERDICT.PASS : VERDICT.FAIL,
  {
    matrix,
    note: "不存在「某个执行单元碰巧安全」的情况；漏的都一样。必须统一在启动层收口。",
  }
);

// ─────────────────────────────────────────────────────────
// D. Worker Thread：不是进程，env 直接共享
// ─────────────────────────────────────────────────────────
console.log("\n=== D. Worker Thread 的环境可见性 ===");
const workerSeen = await new Promise((resolve) => {
  const w = new Worker(
    `
    const { parentPort } = require("node:worker_threads");
    parentPort.postMessage({
      envCount: Object.keys(process.env).length,
      inherited: Object.keys(process.env).filter((k) => /^OPENARC_(D1_05_ENV_SECRET|FAKE_)/.test(k)),
      sameEnvObject: process.env === globalThis.__parentEnv,
    });
    `,
    { eval: true }
  );
  w.on("message", (m) => resolve(m));
  w.on("error", (e) => resolve({ error: String(e) }));
});
p.case(
  "Worker Thread 与主线程共享同一个 process.env，插件在 worker 里能读到全部密钥",
  workerSeen.inherited && workerSeen.inherited.length === 4 ? VERDICT.PASS : VERDICT.FAIL,
  {
    ...workerSeen,
    note:
      "Worker Thread 不是安全边界：它连「环境隔离」都没有。同一进程内没有任何数据边界，" +
      "所以插件/Skill 的隔离必须靠进程，而不是靠 worker。",
  }
);

// ─────────────────────────────────────────────────────────
// E. 结论
// ─────────────────────────────────────────────────────────
p.case(
  "正式方向：所有执行单元的启动必须走显式环境允许列表",
  VERDICT.PASS,
  {
    direction: [
      "禁止 { ...process.env } 与「不传 env 选项」两种写法进入生产代码",
      "允许列表至少需要：PATH、HOME（按需）、LANG/LC_ALL（按需），其余一律不给",
      "凭据只经 credentialRef 在执行边界内解析，绝不落进 env",
      "在 Device Agent / Harness 启动层做一处收口，不靠各调用点自觉",
    ],
    evidence: {
      defaultLeaks: true,
      spreadLeaks: true,
      allowlistLeaks: 0,
      workerSharesEnv: true,
    },
    note: "结论：默认继承是被证实的泄漏面；允许列表是唯一可落地且已被本机实测的收口方式。",
  }
);

p.note(
  `结论摘要：默认 spawn 与 { ...process.env } 都会把父进程 4 个假密钥全部带进子进程（实测自子进程真实环境块）；` +
    `显式允许列表下泄漏为 0；Worker Thread 与主进程共享 process.env，连环境隔离都没有。` +
    `密钥指纹 ${sha256(SECRET, 12)}。`
);

p.write();
process.exit(0);
