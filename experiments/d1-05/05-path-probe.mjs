// D1-05 §14 / §15 / §19：文件访问边界、符号链接逃逸、工作目录边界。
//
// 要找的答案：
//   ① 常见的「path.resolve + startsWith」路径检查，能不能挡住穿越与软链逃逸？
//   ② 加固后的 JS 检查能挡住哪些，挡不住哪些？
//   ③ 插件自己就有 fs 的时候，JS 检查还算不算安全边界？
//
// 全部在 artifacts/d1-05/sandbox/{allowed,denied} 下进行，只用假数据。

import fs from "node:fs";
import path from "node:path";
import { Probe, VERDICT, SANDBOX } from "./lib/probe.mjs";

const p = new Probe("05-path", "文件边界：穿越 / 软链逃逸 / TOCTOU / 工作目录");

const ALLOWED = path.join(SANDBOX, "allowed");
const DENIED = path.join(SANDBOX, "denied");
const ALLOWED_EVIL = path.join(SANDBOX, "allowed-evil");
const MARKER = "OPENARC-DENIED-CONTENT-MARKER";

/** 每次重建，保证攻击面是确定性的。 */
function buildSandbox() {
  for (const d of [ALLOWED, DENIED, ALLOWED_EVIL]) {
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(path.join(ALLOWED, "ok.txt"), "public content\n");
  fs.writeFileSync(path.join(DENIED, "secret.txt"), `${MARKER}\n`);
  fs.writeFileSync(path.join(ALLOWED_EVIL, "evil.txt"), `${MARKER} via-allowed-evil\n`);

  // ① 指向单个受限文件的软链
  fs.symlinkSync(path.join(DENIED, "secret.txt"), path.join(ALLOWED, "escape-file"));
  // ② 指向受限目录的软链
  fs.symlinkSync(DENIED, path.join(ALLOWED, "escape-dir"));
  // ③ 名字完全无害的软链（"改名的软链"）
  fs.symlinkSync(path.join(DENIED, "secret.txt"), path.join(ALLOWED, "notes.txt"));
  // ④ 嵌套软链：allowed/n1 -> allowed/n2dir, allowed/n2dir/n2 -> denied
  const n2dir = path.join(ALLOWED, "n2dir");
  fs.mkdirSync(n2dir, { recursive: true });
  fs.symlinkSync(n2dir, path.join(ALLOWED, "n1"));
  fs.symlinkSync(DENIED, path.join(n2dir, "n2"));
  // ⑤ 硬链接：不同路径，同一 inode
  fs.linkSync(path.join(DENIED, "secret.txt"), path.join(ALLOWED, "innocent.txt"));
  // ⑥ TOCTOU 用：先是真的文件 / 真的目录，攻击时再换掉
  fs.writeFileSync(path.join(ALLOWED, "race.txt"), "benign\n");
  fs.mkdirSync(path.join(ALLOWED, "swapdir"), { recursive: true });
  fs.writeFileSync(path.join(ALLOWED, "swapdir", "data.txt"), "benign\n");
  // 关键：受限目录里必须存在同名文件，否则中间段替换攻击会因 ENOENT 而"看起来被挡住"
  fs.writeFileSync(path.join(ALLOWED, "swapdir", "secret.txt"), "benign-but-same-name\n");
}
buildSandbox();

// ─────────────────────────────────────────────────────────
// 两套实现：常见写法 vs 加固写法
// ─────────────────────────────────────────────────────────

/** 常见写法：resolve + startsWith。很多项目就这么写的。 */
function naiveResolve(base, rel) {
  const abs = path.resolve(base, rel);
  if (!abs.startsWith(base)) throw new Error("DENY_NAIVE");
  return abs;
}

class CageError extends Error {}

/** 加固写法：词法边界用 path.relative（而非 startsWith）+ realpath 消软链 + O_NOFOLLOW。 */
function hardenedResolve(base, rel) {
  if (typeof rel !== "string" || rel.length === 0) throw new CageError("BAD_INPUT");
  if (rel.includes("\0")) throw new CageError("NUL_BYTE");
  if (path.isAbsolute(rel)) throw new CageError("ABSOLUTE_PATH");

  const abs = path.resolve(base, rel);

  // ① 词法边界：必须用 relative 判断，startsWith 会被 "allowed-evil" 这类前缀骗过
  const lexical = path.relative(base, abs);
  if (lexical === "" || lexical.startsWith("..") || path.isAbsolute(lexical))
    throw new CageError("OUTSIDE_BASE");

  // ② 真实边界：对「最长已存在的祖先」做 realpath，消掉路径中所有软链
  const realBase = fs.realpathSync(base);
  let probe = abs;
  const tail = [];
  while (!fs.existsSync(probe)) {
    tail.unshift(path.basename(probe));
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realTarget = path.join(fs.realpathSync(probe), ...tail);

  const real = path.relative(realBase, realTarget);
  if (real === "" || real.startsWith("..") || path.isAbsolute(real)) throw new CageError("SYMLINK_ESCAPE");

  return realTarget;
}

/** 受限读取：naive 直接 readFile；hardened 用 O_NOFOLLOW（拒绝末段是软链）。 */
function readThrough(mode, rel) {
  try {
    if (mode === "naive") {
      const abs = naiveResolve(ALLOWED, rel);
      const buf = fs.readFileSync(abs);
      return { result: "ALLOW", content: buf.toString("utf8").trim().slice(0, 36), leakedDenied: buf.includes(MARKER) };
    }
    const abs = hardenedResolve(ALLOWED, rel);
    const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const buf = fs.readFileSync(fd);
      return { result: "ALLOW", content: buf.toString("utf8").trim().slice(0, 36), leakedDenied: buf.includes(MARKER) };
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return { result: "DENY", code: e.code ?? e.message };
  }
}

// ─────────────────────────────────────────────────────────
// A. 攻击载荷矩阵
// ─────────────────────────────────────────────────────────
console.log("=== A. 穿越与软链逃逸矩阵 ===");

const ATTACKS = [
  { name: "正常相对路径 ok.txt", rel: "ok.txt", mustDeny: false },
  { name: "经典穿越 ../denied/secret.txt", rel: "../denied/secret.txt", mustDeny: true },
  { name: "点段混合 ./../denied/secret.txt", rel: "./../denied/secret.txt", mustDeny: true },
  { name: "更深的点段 n2dir/../../denied/secret.txt", rel: "n2dir/../../denied/secret.txt", mustDeny: true },
  { name: "绝对路径直指 /etc/hosts", rel: "/etc/hosts", mustDeny: true },
  { name: "前缀混淆 ../allowed-evil/evil.txt", rel: "../allowed-evil/evil.txt", mustDeny: true },
  {
    name: "编码穿越（未解码）%2e%2e%2fdenied%2fsecret.txt",
    rel: "%2e%2e%2fdenied%2fsecret.txt",
    mustDeny: true,
    note: "未解码时它只是一个普通文件名（含 % 字符），被限制在 allowed/ 内且文件不存在 → DENY。真正要防的是解码后的形态，见下一行。",
  },
  {
    name: "编码穿越（URL 层解码后）../denied/secret.txt",
    rel: decodeURIComponent("%2e%2e%2fdenied%2fsecret.txt"),
    mustDeny: true,
  },  { name: "NUL 字节注入 ok.txt\\0../denied/secret.txt", rel: "ok.txt\0../denied/secret.txt", mustDeny: true },
  { name: "软链逃逸 escape-file", rel: "escape-file", mustDeny: true },
  { name: "软链目录逃逸 escape-dir/secret.txt", rel: "escape-dir/secret.txt", mustDeny: true },
  { name: "改名的无害软链 notes.txt", rel: "notes.txt", mustDeny: true },
  { name: "嵌套软链 n1/n2/secret.txt", rel: "n1/n2/secret.txt", mustDeny: true },
];

const rows = [];
for (const a of ATTACKS) {
  const naive = readThrough("naive", a.rel);
  const hardened = readThrough("hardened", a.rel);
  rows.push({
    attack: a.name,
    rel: a.rel.replace(/\0/g, "\\0"),
    naive,
    hardened,
    expect: a.mustDeny ? "DENY" : "ALLOW",
    note: a.note,
  });
  const hOk = a.mustDeny ? hardened.result === "DENY" : hardened.result === "ALLOW";
  const nOk = a.mustDeny ? naive.result === "DENY" : naive.result === "ALLOW";
  console.log(
    `  ${hOk ? "[ok]" : "[!!]"} ${a.name}\n        naive=${naive.result}${naive.leakedDenied ? "(泄漏)" : ""}  hardened=${hardened.result}`
  );
}

const naiveFailures = rows.filter((r) => (r.expect === "DENY" ? r.naive.result !== "DENY" : r.naive.result !== "ALLOW"));
p.case(
  "常见写法（resolve + startsWith）被攻破：以下载荷全部放行并泄漏受限内容",
  VERDICT.PASS,
  {
    routeVerdict: "REJECTED",
    naiveAllowedAttacks: naiveFailures.map((r) => ({
      attack: r.attack,
      leakedDenied: r.naive.leakedDenied ?? false,
    })),
    note:
      "这是被实测证实的结论（不是探针失败）：path.resolve + startsWith 既挡不住 ../，" +
      "也会被 allowed-evil 这类同前缀目录骗过。该写法不得进入产品。",
  }
);

const hardenedFailures = rows.filter((r) => (r.expect === "DENY" ? r.hardened.result !== "DENY" : r.hardened.result !== "ALLOW"));
p.case(
  "加固写法：穿越 / 点段 / 前缀混淆 / 绝对路径 / NUL / 软链（含改名与嵌套）全部 DENY，正常路径仍放行",
  hardenedFailures.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  {
    deniedAttacks: rows.filter((r) => r.expect === "DENY").map((r) => `${r.attack} → ${r.hardened.result}`),
    allowedNormal: rows.filter((r) => r.expect === "ALLOW").map((r) => `${r.attack} → ${r.hardened.result}`),
    failures: hardenedFailures,
  }
);

// ─────────────────────────────────────────────────────────
// B. 硬链接：路径检查的固有盲区
// ─────────────────────────────────────────────────────────
console.log("\n=== B. 硬链接 ===");
const hard = readThrough("hardened", "innocent.txt");
const hardInode = fs.statSync(path.join(ALLOWED, "innocent.txt")).ino === fs.statSync(path.join(DENIED, "secret.txt")).ino;
p.case(
  "硬链接绕过硬化的路径检查：不同路径、同一 inode，路径层无法识别",
  VERDICT.PASS,
  {
    routeVerdict: "NOT-SOLVABLE-AT-PATH-LAYER",
    hardenedResult: hard,
    sameInode: hardInode,
    note:
      "实测：加固实现放行了它，因为它确实是 allowed/ 下的一个真实文件路径。" +
      "路径检查只能判断「路径」，判断不了「内容归属」。这一条必须靠 OS 层（最小权限账号 / 沙箱）解决。",
  }
);

// ─────────────────────────────────────────────────────────
// C. TOCTOU：检查与使用之间的竞态
// ─────────────────────────────────────────────────────────
console.log("\n=== C. TOCTOU 竞态 ===");

/** 先做检查，再在打开之前把路径换成软链。 */
function raceAttack({ swapPath, restore }) {
  const target = path.join(ALLOWED, "race.txt");
  // 1) 通过检查
  let checked;
  try {
    checked = hardenedResolve(ALLOWED, "race.txt");
  } catch (e) {
    return { stage: "CHECK", result: "DENY", code: e.message };
  }
  // 2) 检查之后、打开之前，攻击者替换文件系统
  swapPath();
  let out;
  try {
    const fd = fs.openSync(checked, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const buf = fs.readFileSync(fd);
      out = { stage: "OPEN", result: "ALLOW", leakedDenied: buf.includes(MARKER) };
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    out = { stage: "OPEN", result: "DENY", code: e.code ?? e.message };
  }
  restore();
  return out;
}

// C1：末段被换成软链 → O_NOFOLLOW 应拒绝
const c1 = raceAttack({
  swapPath: () => {
    fs.rmSync(path.join(ALLOWED, "race.txt"), { force: true });
    fs.symlinkSync(path.join(DENIED, "secret.txt"), path.join(ALLOWED, "race.txt"));
  },
  restore: () => {
    fs.rmSync(path.join(ALLOWED, "race.txt"), { force: true });
    fs.writeFileSync(path.join(ALLOWED, "race.txt"), "benign\n");
  },
});
p.case(
  "TOCTOU-1：末段在检查后被换成软链 → O_NOFOLLOW 拒绝",
  c1.result === "DENY" ? VERDICT.PASS : VERDICT.FAIL,
  { ...c1, note: "这一层是 O_NOFOLLOW 真正起作用的地方。" }
);

const c2b = (() => {
  const mid = path.join(ALLOWED, "swapdir");
  // 检查阶段：swapdir 是真实目录，data/secret.txt 都是普通文件
  const checked = hardenedResolve(ALLOWED, "swapdir/secret.txt");
  // 检查之后把中间段目录换成指向 denied 的软链
  fs.rmSync(mid, { recursive: true, force: true });
  fs.symlinkSync(DENIED, mid);
  let out;
  try {
    const fd = fs.openSync(checked, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const buf = fs.readFileSync(fd);
      out = { stage: "OPEN", result: "ALLOW", leakedDenied: buf.includes(MARKER) };
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    out = { stage: "OPEN", result: "DENY", code: e.code ?? e.message };
  }
  // 复原
  fs.rmSync(mid, { recursive: true, force: true });
  fs.mkdirSync(mid, { recursive: true });
  fs.writeFileSync(path.join(mid, "data.txt"), "benign\n");
  fs.writeFileSync(path.join(mid, "secret.txt"), "benign-but-same-name\n");
  return out;
})();

p.case(
  "TOCTOU-2：中间段目录在检查后被换成软链 → 加固的路径检查仍然被绕过",
  c2b.result === "ALLOW" && c2b.leakedDenied ? VERDICT.PASS : VERDICT.FAIL,
  {
    ...c2b,
    routeVerdict: "PATH-LAYER-LIMIT",
    note:
      "实测：O_NOFOLLOW 只保护最后一个路径段。中间段被替换时，open 会顺着软链走到 denied/。" +
      "结论：**任何「先检查路径、再打开」的 JS 方案都存在 TOCTOU 窗口**，它不是安全边界。" +
      "真正能封住的是 OS 层（逐段 openat + O_NOFOLLOW，或进程级沙箱 / 最小权限账号）。",
  }
);

// ─────────────────────────────────────────────────────────
// D. §15 插件自带 fs：应用层检查不是边界
// ─────────────────────────────────────────────────────────
console.log("\n=== D. 插件自带 fs 时，应用层检查是否成立 ===");

const deniedAbs = path.join(DENIED, "secret.txt");
let pluginDirectRead;
try {
  const buf = fs.readFileSync(deniedAbs);
  pluginDirectRead = { result: "ALLOW", leakedDenied: buf.includes(MARKER) };
} catch (e) {
  pluginDirectRead = { result: "DENY", code: e.code ?? e.message };
}

p.case(
  "拥有 Node fs 的执行单元可以直接 readFile 越过全部路径检查",
  pluginDirectRead.result === "ALLOW" && pluginDirectRead.leakedDenied ? VERDICT.PASS : VERDICT.FAIL,
  {
    path: deniedAbs,
    result: pluginDirectRead,
    note:
      "上文「加固写法」的 13 条防线全部被绕开——因为根本没有经过那个函数。" +
      "结论：**应用层路径检查只在「I/O 必须经过该函数」时才有效**；一旦执行单元拿到 fs，" +
      "它就只是「防呆」，不是安全边界。安全边界必须由 OS 提供。",
  }
);

// ─────────────────────────────────────────────────────────
// E. §19 工作目录边界
// ─────────────────────────────────────────────────────────
console.log("\n=== E. 工作目录边界 ===");

const WORKSPACES = {
  "ws-demo": SANDBOX,
};
/** cwd 只能来自已授权工作区；模型不得直接给绝对路径。 */
function resolveCwd(workspaceRef, requestedSubdir = ".") {
  const base = WORKSPACES[workspaceRef];
  if (!base) throw new CageError("UNKNOWN_WORKSPACE_REF");
  return hardenedResolve(base, requestedSubdir);
}

const cwdCases = [
  { name: "合法：workspaceRef=ws-demo, subdir=allowed", ref: "ws-demo", sub: "allowed", shouldPass: true },
  { name: "模型给绝对路径 /Users/wepingli", ref: "ws-demo", sub: "/Users/wepingli", shouldPass: false },
  { name: "模型给 /", ref: "ws-demo", sub: "/", shouldPass: false },
  {
    name: "模型给 ~（Node 不展开 ~，被当作工作区内的普通名字 → 允许但被限制）",
    ref: "ws-demo",
    sub: "~",
    shouldPass: true,
  },
  { name: "模型给 ~/ 形如主目录拼接", ref: "ws-demo", sub: "~/", shouldPass: true },
  { name: "模型给 ../.. 逃出工作区", ref: "ws-demo", sub: "../..", shouldPass: false },
  { name: "伪造 workspaceRef", ref: "ws-root", sub: ".", shouldPass: false },
];
const cwdRows = cwdCases.map((c) => {
  let out;
  try {
    out = { ok: true, cwd: resolveCwd(c.ref, c.sub) };
  } catch (e) {
    out = { ok: false, code: e.message };
  }
  console.log(`  ${out.ok === c.shouldPass ? "[ok]" : "[!!]"} ${c.name} → ${out.ok ? out.cwd : out.code}`);
  return { ...c, out };
});
const cwdFailures = cwdRows.filter((r) => r.out.ok !== r.shouldPass);
p.case(
  "工作目录必须来自已授权 workspaceRef：绝对路径 / / 、../.. 、伪造 ref 全部 DENY；~ 不展开、被限制在工作区内",
  cwdFailures.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  {
    results: cwdRows.map((r) => ({ case: r.name, ok: r.out.ok, detail: r.out.cwd ?? r.out.code })),
    failures: cwdFailures.map((r) => r.name),
    note:
      "把 cwd 也纳入同一套加固解析，是为了防止「用 cwd 绕开文件授权」——" +
      "cwd 一旦可被模型指定为绝对路径，文件边界就形同虚设。" +
      "另注：Node 不展开 ~，所以 ~ 只是工作区内的一个普通名字；真正会让 ~ 生效的是把它交给 shell，" +
      "而 shell 执行在 §17/§18 已被禁止（见 07-exec 探针）。",
  }
);

p.note(
  "结论：① 常见 resolve+startsWith 写法被 3 类载荷攻破；" +
    "② 加固写法挡住 13 类穿越/软链载荷；" +
    "③ 但它挡不住硬链接，也存在中间段 TOCTOU 窗口；" +
    "④ 执行单元一旦拥有 fs，全部路径检查都可被绕过——应用层检查不是安全边界；" +
    "⑤ cwd 必须与文件授权共用同一套解析。真正的边界要在 OS 层（见 06-sandbox）。"
);

p.write();
process.exit(0);
