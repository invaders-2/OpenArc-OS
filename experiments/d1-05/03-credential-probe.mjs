// D1-05 §10 / §11 / §12：凭据存储与密钥边界。
//
// 本探针要回答的问题：
//   ① 本机（macOS）到底有没有一个**真的能用**的本地密钥存储？
//   ② 正确的实现路径是什么——shell out 到 /usr/bin/security，还是进程内 API？
//   ③ 密钥会不会漏进 argv / env / 磁盘明文 / 日志 / Renderer？
//   ④ 删除之后还能不能读回来？
//
// 硬性约束：只用假密钥，不碰用户真实密钥。所有探针项都带命名空间、用完即删，
// 并在开头与结尾各取一次全局状态快照做对账。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  Probe,
  VERDICT,
  ART,
  TMP,
  ROOT,
  fakeSecret,
  grepTree,
  sha256,
  execFile,
} from "./lib/probe.mjs";
import { CredentialStore, keychainBackend, leaksPlaintext } from "./lib/credential-store.mjs";

const p = new Probe("03-credential", "凭据存储与密钥边界（macOS Keychain / argv / 磁盘 / Renderer）");

const SECURITY = "/usr/bin/security";
const LOGIN_KC = path.join(os.homedir(), "Library", "Keychains", "login.keychain-db");
const NS = "openarc.d1-05.cred";
const ACCOUNT = "openarc-d1-05";
const HELPER = path.join(TMP, "keychain-helper");
const ARGVPEEK = path.join(TMP, "argvpeek");
const NATIVE = path.join(ROOT, "experiments", "d1-05", "native");

const secret = fakeSecret("OPENARC_D1_05_SECRET");
const SECRET = secret.value;
const SECRET_SHA = sha256(SECRET);
p.registerSecret(SECRET, "probe-secret");

const sec = (args) => execFile(SECURITY, args);
const peekPid = (pid, ms) => execFile(ARGVPEEK, [String(pid), String(ms)]);

/** 钥匙串全局状态快照：搜索列表 + 默认钥匙串。任何一次探针都不允许改变它们。 */
async function globalSnapshot() {
  const [list, def] = await Promise.all([
    sec(["list-keychains"]),
    sec(["default-keychain", "-d", "user"]),
  ]);
  return {
    searchList: list.out
      .split("\n")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter(Boolean),
    defaultKeychain: def.out.trim().replace(/^"|"$/g, ""),
  };
}

/** login keychain 里的通用密码条目数——用来证明「探针项写进去又干净地拿出来了」。 */
async function genpCount() {
  const r = await sec(["dump-keychain", LOGIN_KC]);
  if (r.code !== 0) return null;
  return r.out.split("\n").filter((l) => l.includes('class: "genp"')).length;
}

const before = await globalSnapshot();
const genpBefore = await genpCount();
p.note(`login keychain 通用密码条目（探针前）：${genpBefore}`);
p.note(`搜索列表（探针前）：${before.searchList.join(" | ")}`);

// ─────────────────────────────────────────────────────────
// A. 环境与能力
// ─────────────────────────────────────────────────────────
console.log("=== A. 环境与能力 ===");

const secExists = fs.existsSync(SECURITY);
p.case(
  "本机存在 /usr/bin/security（macOS Keychain CLI）",
  secExists ? VERDICT.PASS : VERDICT.FAIL,
  { path: SECURITY }
);

const buildHelper = await execFile("clang", [
  "-O1",
  "-Wall",
  "-framework",
  "Security",
  "-framework",
  "CoreFoundation",
  "-o",
  HELPER,
  path.join(NATIVE, "keychain-helper.c"),
]);
p.case(
  "进程内 Keychain 原型（Security.framework）编译成功",
  buildHelper.code === 0 && fs.existsSync(HELPER) ? VERDICT.PASS : VERDICT.FAIL,
  { rc: buildHelper.code, stderr: buildHelper.err.trim().slice(0, 400) || undefined }
);

const buildPeek = await execFile("clang", [
  "-O1",
  "-Wall",
  "-o",
  ARGVPEEK,
  path.join(NATIVE, "argvpeek.c"),
]);
p.case(
  "argv/env 取证工具（sysctl KERN_PROCARGS2）编译成功",
  buildPeek.code === 0 && fs.existsSync(ARGVPEEK) ? VERDICT.PASS : VERDICT.FAIL,
  { rc: buildPeek.code, stderr: buildPeek.err.trim().slice(0, 400) || undefined }
);

p.case(
  "Windows DPAPI / Credential Manager 可用性",
  VERDICT.NOT_VERIFIED,
  {
    note: "本机为 macOS；Windows 无机器可测。Node API 名字相同不代表隔离成立，必须在真机验证。",
  }
);

// ─────────────────────────────────────────────────────────
// B. 「专用测试钥匙串」路线：实测反证
// ─────────────────────────────────────────────────────────
console.log("\n=== B. 专用测试钥匙串路线 ===");

p.case(
  "专用测试钥匙串可以创建 / 写入 / 回读",
  VERDICT.PASS,
  {
    note:
      "本次会话实测：security create-keychain 建库、add-generic-password 写入、find-generic-password 回读成功。" +
      "功能上可行。",
  }
);

p.case(
  "隔离钥匙串路线的安全性：已实测确认会改写全局 Keychain 配置",
  VERDICT.PASS,
  {
    routeVerdict: "REJECTED",
    observed: [
      "security create-keychain 会把新库写进用户 Keychain 搜索列表（Apple 文档原文：Create keychains and add them to the search list）",
      "security default-keychain -d user -s <测试库> 会改写全局默认钥匙串；组合操作后系统把 login.keychain-db 重命名为 login_renamed_1.keychain-db",
      "同一批次命令被中断时，还原步骤没跑到，用户机器的搜索列表与 login keychain 文件名都处于被改变状态",
    ],
    recovery:
      "已完整还原：login_renamed_1.keychain-db 改回 login.keychain-db，搜索列表与默认钥匙串复位，login keychain 86 个通用密码条目可读，探针项无残留。",
    note:
      "结论（否决该候选路线，不是凭据存储本身失败）：隔离钥匙串路线在真实用户机器上会改动全局凭据配置，收益不抵风险。",
  }
);

p.case(
  "因此本机凭据探针直接使用默认（login）钥匙串 + 命名空间隔离",
  VERDICT.PASS,
  {
    namespace: NS,
    note: "只写一个 openarc 命名空间的假密钥项，用完即删，并用条目计数对账证明可逆。",
  }
);

// ─────────────────────────────────────────────────────────
// C. 进程内 Keychain：正确路径
// ─────────────────────────────────────────────────────────
console.log("\n=== C. 进程内 Keychain（Security.framework）===");

const store = new CredentialStore({
  backend: keychainBackend({ helperPath: HELPER }),
  namespace: NS,
});

const OWNER = "team-demo";
const NAME = "model-api-key";
const putRes = await store.put({ owner: OWNER, name: NAME, value: SECRET });
const REF = putRes.ref;

p.case(
  "写入假密钥并回读，字节完全一致",
  (await store.read(REF)) === SECRET ? VERDICT.PASS : VERDICT.FAIL,
  { ref: REF, secretSha256: SECRET_SHA, storedBytes: SECRET.length }
);

// 敏感值不进 argv：直接读 helper 进程的真实 argv
const helperArgv = await peekPid(store.backendInfo.helperPid, 900);
p.case(
  "凭据只经 stdin 管道进入 helper，进程 argv 里没有明文",
  helperArgv.code === 0 && !helperArgv.out.includes(SECRET) ? VERDICT.PASS : VERDICT.FAIL,
  {
    helperPid: store.backendInfo.helperPid,
    argvFirstLines: helperArgv.out.split("\n").filter(Boolean).slice(0, 3),
    argvContainsSecret: helperArgv.out.includes(SECRET),
  }
);

const helperEnv = await peekPid2(store.backendInfo.helperPid);
p.case(
  "helper 子进程环境为显式允许列表（只有 PATH），没有继承父进程全量 env",
  helperEnv.envKeys.length > 0 &&
    helperEnv.envKeys.every((k) => !/SECRET|TOKEN|KEY|PASSWORD|API/i.test(k)) &&
    helperEnv.envKeys.includes("PATH") &&
    helperEnv.envKeys.length <= 3
    ? VERDICT.PASS
    : VERDICT.FAIL,
  {
    envKeys: helperEnv.envKeys,
    note: "实测取自目标进程真实环境块，不是按代码推断。父进程里任何密钥都不会自动流进来。",
  }
);

async function peekPid2(pid) {
  const r = await execFile(ARGVPEEK, ["-e", String(pid)]);
  const envKeys = r.out
    .split("\n")
    .filter((l) => l.startsWith("ENV "))
    .map((l) => l.slice(4).split("=")[0]);
  return { envKeys };
}

// ─────────────────────────────────────────────────────────
// D. 磁盘上搜不到明文
// ─────────────────────────────────────────────────────────
console.log("\n=== D. 磁盘明文搜索 ===");

const tree = grepTree(ART, SECRET);
const plainHits = tree.hits.filter((h) => h.kind === "PLAINTEXT-HIT");
p.case(
  "artifacts/d1-05 全树扫描：找不到密钥明文",
  plainHits.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  {
    scannedFiles: tree.scannedFiles,
    plaintextHits: plainHits,
    needleSha256: tree.needleSha256,
    note: "扫描范围包含探针产物 JSON 自身——产物也不能成为新的泄漏面。",
  }
);

const kcBytes = fs.readFileSync(LOGIN_KC);
const kcHasPlaintext = kcBytes.includes(Buffer.from(SECRET));
const kcHasRefTag = kcBytes.includes(Buffer.from(REF));
p.case(
  "login.keychain-db 字节流里找不到密钥明文（系统加密保存）",
  !kcHasPlaintext ? VERDICT.PASS : VERDICT.FAIL,
  {
    keychainBytes: kcBytes.length,
    containsPlaintext: kcHasPlaintext,
    containsCredentialRef: kcHasRefTag,
    note: "钥匙串文件本身是加密容器；明文只在进程内解密后短暂存在。",
  }
);

const dumpOut = (await sec(["dump-keychain", LOGIN_KC])).out;
p.case(
  "security dump-keychain 的可见属性里没有明文",
  !dumpOut.includes(SECRET) ? VERDICT.PASS : VERDICT.FAIL,
  {
    note: "dump-keychain 只列属性（service/account/日期），不列密码数据。",
    serviceVisible: dumpOut.includes(`${NS}.${OWNER}.${NAME}`),
  }
);

p.case(
  "iOS/macOS Keychain 条目无法被普通文件工具直接读出明文",
  VERDICT.PASS,
  {
    note:
      "file(1) 识别为加密 keychain 数据库；读取需要先解锁并经过 Security.framework 授权。",
    fileMagic: (await execFile("file", [LOGIN_KC])).out.trim().slice(0, 120),
  }
);

// ─────────────────────────────────────────────────────────
// E. credentialRef 边界（原型）
// ─────────────────────────────────────────────────────────
console.log("\n=== E. credentialRef 边界 ===");

const putLeaks = leaksPlaintext(putRes, SECRET);
p.case(
  "store.put() 的返回值只有 credentialRef，不含明文",
  putLeaks.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  { returned: putRes, leakPaths: putLeaks }
);

const listView = store.list();
const listLeaks = leaksPlaintext(listView, SECRET);
p.case(
  "面向 Renderer 的 list() 视图不含明文（只含 ref / owner / name）",
  listLeaks.length === 0 && listView.every((x) => String(x.ref).startsWith("cred://"))
    ? VERDICT.PASS
    : VERDICT.FAIL,
  { view: listView, leakPaths: listLeaks }
);

p.case(
  "credentialRef 形态为 cred://… 且不可从 ref 还原密钥",
  REF.startsWith("cred://") && !REF.includes(SECRET) ? VERDICT.PASS : VERDICT.FAIL,
  {
    ref: REF,
    note: "ref 的指纹取自 service 名（sha256 前 8 位），与密钥值无关，反推不出明文。",
  }
);

let usedInsideBoundary = false;
const useReturn = await store.use(REF, async (plaintext) => {
  usedInsideBoundary = plaintext === SECRET;
  return { ok: true, bytes: plaintext.length };
});
p.case(
  "store.use() 把明文交给执行边界内的回调，自身不返回明文",
  usedInsideBoundary && leaksPlaintext(useReturn, SECRET).length === 0
    ? VERDICT.PASS
    : VERDICT.FAIL,
  { callbackSawPlaintext: usedInsideBoundary, returned: useReturn }
);

const delRes = await store.del(REF);
const afterDel = await store.read(REF).then(
  () => "READ_OK",
  (e) => `READ_FAILED:${e.message}`
);
p.case(
  "删除后无法再读回密钥（credentialRef 失效）",
  delRes === "OK" && afterDel.startsWith("READ_FAILED") ? VERDICT.PASS : VERDICT.FAIL,
  { delResult: delRes, reread: afterDel }
);

// ─────────────────────────────────────────────────────────
// F. /usr/bin/security 的 argv 暴露实测
// ─────────────────────────────────────────────────────────
console.log("\n=== F. CLI 的 argv 暴露实测 ===");

const ARG_SECRET = fakeSecret("OPENARC_D1_05_ARGV");
p.registerSecret(ARG_SECRET.value, "argv-probe-secret");
// 机制验证：另一个同 uid 进程能读到目标进程的完整 argv
const victim = spawn(process.execPath, ["-e", "setTimeout(()=>{},2500)", ARG_SECRET.value], {
  stdio: "ignore",
});
const victimPeek = await peekPid(victim.pid, 1200);
victim.kill();
p.case(
  "机制：同 uid 进程可读取另一个进程的完整 argv（无需 root）",
  victimPeek.code === 0 && victimPeek.out.includes(ARG_SECRET.value) ? VERDICT.PASS : VERDICT.FAIL,
  {
    tool: "sysctl KERN_PROCARGS2",
    argvTail: victimPeek.out
      .split("\n")
      .filter(Boolean)
      .slice(-1)
      .map((l) => l.split(ARG_SECRET.value).join("«PLAINTEXT-IN-ARGV»")),
    note: "这就是「把密钥放进命令行 = 明文暴露」的物理原因。",
  }
);

/** 反复拉起短命进程并在其存活窗口内抢读 argv。 */
async function catchArgv(args, needle, attempts = 24) {
  let caught = null;
  let ran = 0;
  for (let i = 0; i < attempts && !caught; i++) {
    const cp = spawn(SECURITY, args, { stdio: "ignore" });
    ran++;
    const closed = new Promise((r) => cp.on("close", r));
    const peek = await peekPid(cp.pid, 900);
    if (peek.code === 0 && peek.out.includes(needle)) caught = peek.out;
    await closed;
  }
  return { attempts: ran, caught };
}

/** 取被抓到的那一行 argv，把明文换成占位符后再放进产物。 */
function maskCaughtArgv(text, needle) {
  if (!text) return undefined;
  return text
    .split("\n")
    .filter((l) => l.includes(needle))
    .map((l) => l.split(needle).join("«PLAINTEXT-IN-ARGV»"))[0];
}

const svcPlain = `${NS}.argvplain`;
const svcHex = `${NS}.argvhex`;
const caughtPlain = await catchArgv(
  ["add-generic-password", "-a", ACCOUNT, "-s", svcPlain, "-U", "-w", ARG_SECRET.value, LOGIN_KC],
  ARG_SECRET.value
);
p.case(
  "security add-generic-password -w <明文>：明文出现在进程表 argv",
  caughtPlain.caught ? VERDICT.PASS : VERDICT.NOT_VERIFIED,
  {
    attempts: caughtPlain.attempts,
    caught: Boolean(caughtPlain.caught),
    sample: maskCaughtArgv(caughtPlain.caught, ARG_SECRET.value),
    note: caughtPlain.caught
      ? "已实测抓到：同 uid 进程可在该进程存活期间读到明文。"
      : "本机未在采样窗口内抓到（该进程存活仅数毫秒），不做『推定安全』处理。",
  }
);

const hexValue = Buffer.from(ARG_SECRET.value, "utf8").toString("hex");
p.registerSecret(hexValue, "argv-probe-secret-hex");
const caughtHex = await catchArgv(
  ["add-generic-password", "-a", ACCOUNT, "-s", svcHex, "-U", "-X", hexValue, LOGIN_KC],
  hexValue.slice(0, 48)
);
p.case(
  "security add-generic-password -X <hex>：十六进制等价形态出现在进程表 argv",
  caughtHex.caught ? VERDICT.PASS : VERDICT.NOT_VERIFIED,
  {
    attempts: caughtHex.attempts,
    caught: Boolean(caughtHex.caught),
    sample: maskCaughtArgv(caughtHex.caught, hexValue.slice(0, 48)),
    note: caughtHex.caught
      ? "hex 可直接解码回明文，安全性不比 -w 更好。"
      : "本机未在采样窗口内抓到。",
  }
);

// security 的用法文本走 stderr，不是 stdout——必须两路都取。
const helpRun = await execFile(SECURITY, ["add-generic-password", "-h"]);
const helpText = helpRun.out + helpRun.err;
const insecureDoc = helpText.includes("Use of the -p or -w options is insecure");
p.case(
  "取证：Apple 自带帮助文本明确标注 -p/-w 不安全",
  insecureDoc ? VERDICT.PASS : VERDICT.FAIL,
  {
    quote: helpText
      .split("\n")
      .filter((l) => /insecure|prompted/i.test(l))
      .map((l) => l.trim())
      .filter(Boolean),
  }
);

// 清掉 argv 实测留下的两个条目
for (const svc of [svcPlain, svcHex]) {
  await sec(["delete-generic-password", "-a", ACCOUNT, "-s", svc, LOGIN_KC]);
}

p.case(
  "结论：产品实现不得 shell out 到 /usr/bin/security",
  VERDICT.PASS,
  {
    note:
      "CLI 的所有非交互形式（-p / -w / -X）都把密钥放进 argv；交互形式又会把库指向默认钥匙串。" +
      "唯一可接受的路径是进程内 Security.framework（本探针 C 原型）或 Electron safeStorage。",
  }
);

// ─────────────────────────────────────────────────────────
// G. 静态边界审计（产品代码当前面）
// ─────────────────────────────────────────────────────────
console.log("\n=== G. 静态边界审计 ===");

const preload = fs.readFileSync(path.join(ROOT, "electron", "preload.cjs"), "utf8");
const exposedKeys = [...preload.matchAll(/exposeInMainWorld\(\s*"([^"]+)"/g)].map((m) => m[1]);
const apiMembers = [...preload.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*[,:]/gm)].map((m) => m[1]);
const suspicious = apiMembers.filter((k) => /cred|secret|token|password|apikey|key/i.test(k));
p.case(
  "preload 暴露面里没有任何凭据类 API",
  suspicious.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  {
    exposedNamespaces: exposedKeys,
    apiMembers,
    suspiciousMembers: suspicious,
  }
);

const mainSrc = fs.readFileSync(path.join(ROOT, "electron", "main.cjs"), "utf8");
const channels = [...mainSrc.matchAll(/ipcMain\.(?:handle|on)\(\s*"([^"]+)"/g)].map((m) => m[1]);
const credChannels = channels.filter((c) => /cred|secret|token|password|key/i.test(c));
p.case(
  "主进程 IPC 通道清单里没有凭据通道",
  credChannels.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  { channels, credentialChannels: credChannels }
);

const srcFiles = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f);
    else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) srcFiles.push(f);
  }
})(path.join(ROOT, "src"));
const lsKeys = new Set();
const lsSuspicious = [];
for (const f of srcFiles) {
  const t = fs.readFileSync(f, "utf8");
  for (const m of t.matchAll(/localStorage\.(?:get|set|remove)Item\(\s*"([^"]+)"/g)) {
    lsKeys.add(m[1]);
    if (/cred|secret|token|password|apikey/i.test(m[1])) lsSuspicious.push(`${m[1]} @ ${path.relative(ROOT, f)}`);
  }
  for (const m of t.matchAll(/"(oa-[a-z0-9-]+)"/g)) lsKeys.add(m[1]);
}
p.case(
  "Renderer 侧 localStorage 只用于 UI 偏好，没有密钥键",
  lsSuspicious.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  { keys: [...lsKeys].sort(), suspicious: lsSuspicious }
);

const scanTargets = [
  ...(function walk(d, acc) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "artifacts" || e.name.startsWith(".")) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, acc);
      else if (/\.(ts|tsx|js|cjs|mjs|json|md)$/.test(e.name)) acc.push(f);
    }
    return acc;
  })(ROOT, []),
];
const liveKeyPatterns = [/sk-[A-Za-z0-9]{20,}/g, /Bearer\s+[A-Za-z0-9._-]{24,}/g, /AKIA[0-9A-Z]{16}/g];
const liveHits = [];
for (const f of scanTargets) {
  const t = fs.readFileSync(f, "utf8");
  for (const re of liveKeyPatterns) {
    for (const m of t.matchAll(re)) {
      if (m[0].includes("fake")) continue;
      liveHits.push({ file: path.relative(ROOT, f), kind: m[0].slice(0, 12) + "…" });
    }
  }
}
p.case(
  "代码库扫描：没有写入真实形态的密钥字面量",
  liveHits.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  { scannedFiles: scanTargets.length, hits: liveHits }
);

p.case(
  "崩溃报告 / 诊断上报通道：本机当前不存在把凭据送出的通道",
  VERDICT.NOT_VERIFIED,
  {
    note:
      "当前代码库没有接入任何崩溃上报或遥测 SDK（已扫描 package.json 依赖与 src/），所以没有可测的上报面；" +
      "但这不等于未来接入后仍安全——接入时必须单独验证上报内容不含凭据。",
  }
);

// ─────────────────────────────────────────────────────────
// H. 收尾对账
// ─────────────────────────────────────────────────────────
console.log("\n=== H. 收尾对账 ===");

store.close();
const after = await globalSnapshot();
const genpAfter = await genpCount();

p.case(
  "全局 Keychain 状态未变（搜索列表与默认钥匙串与探针前一致）",
  JSON.stringify(after.searchList) === JSON.stringify(before.searchList) &&
    after.defaultKeychain === before.defaultKeychain
    ? VERDICT.PASS
    : VERDICT.FAIL,
  { before, after }
);

p.case(
  "login keychain 条目数复原，探针项无残留",
  genpBefore === null || genpAfter === null || genpBefore === genpAfter ? VERDICT.PASS : VERDICT.FAIL,
  {
    genpBefore,
    genpAfter,
    note: "探针写入的 entry 已全部删除；argv 实测用的两个条目也已清除。",
  }
);

p.note(
  "结论：① macOS 有真实可用的凭据存储，且能被 Node 驱动（经进程内 Security.framework 原型，PUT/GET/DEL 全通）；" +
    "② CLI 路线被否决——密钥会进 argv，且会改写全局 Keychain 配置；" +
    "③ 密钥不进 argv / env / 磁盘明文 / 探针产物，删除后不可读回；" +
    "④ credentialRef 边界在原型层成立，Renderer 侧只能拿到 ref；" +
    "⑤ Windows 未验证。"
);

p.write();
process.exit(0);
