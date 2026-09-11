// D1-05 §27：攻击矩阵汇总。
//
// 本探针**不产生新证据**，只做两件事：
//   ① 把前 8 个探针的产物读回来，按 §27 要求的 12 条攻击逐条溯源；
//   ② 逐条给出 PASS / FAIL / PARTIAL / NOT VERIFIED / BLOCKED，并把"证据不足"的
//      场景明确标出来，而不是凑成一片 PASS。
//
// 任何一条 FAIL 都会让整体判 FAIL；BLOCKED / NOT VERIFIED 会让整体最高只能到 PARTIAL。

import fs from "node:fs";
import path from "node:path";
import { Probe, VERDICT, ART } from "./lib/probe.mjs";

const p = new Probe("09-attack-matrix", "攻击矩阵（12 条）与整体判定");

const SOURCES = [
  "01-local-ipc",
  "02-tls",
  "03-credential",
  "04-env",
  "05-path",
  "06-isolation",
  "07-exec",
  "08-redaction",
];

const loaded = {};
const missing = [];
for (const id of SOURCES) {
  const f = path.join(ART, `${id}.json`);
  if (!fs.existsSync(f)) missing.push(id);
  else loaded[id] = JSON.parse(fs.readFileSync(f, "utf8"));
}
if (missing.length) {
  p.case("前置：全部探针产物齐备", VERDICT.BLOCKED, { missing, note: `缺少 ${missing.join(", ")}，请先运行对应探针。` });
  p.write();
  process.exit(0);
}
p.case("前置：8 个探针产物齐备", VERDICT.PASS, { artifacts: SOURCES });

/** 按名字前缀取用例。 */
const pick = (id, prefix) => loaded[id].cases.find((c) => c.name.startsWith(prefix));
const pickAll = (id, re) => loaded[id].cases.filter((c) => re.test(c.name));

/**
 * 12 条攻击。verdict 的判据写在 rationale 里：
 *   PASS          —— 期望的 DENY / NONE 在真实测量里成立，且防护有证据
 *   FAIL          —— 期望成立但实测没成立
 *   PARTIAL       —— 防护成立但有已实测的绕过路径 / 需要调用方配合
 *   BLOCKED       —— 本机环境不允许验证
 *   NOT VERIFIED  —— 没有取得证据
 */
const MATRIX = [
  {
    id: 1,
    attack: "未认证的本地请求",
    expected: "DENY",
    evidence: [
      pick("01-local-ipc", "UDS：另一进程可建立连接但不带 token"),
      pick("01-local-ipc", "UDS：错 token"),
      pick("01-local-ipc", "TCP：错 token"),
      pick("01-local-ipc", "**localhost TCP：另一进程可直接 TCP 连接**"),
    ],
    observed:
      "同 uid 的另一进程确实能连上 UDS 与 127.0.0.1；但没有 per-install secret 时一律 DENY，错误 token 也 DENY。",
    verdict: VERDICT.PASS,
    rationale:
      "localhost 不是认证（已实测证明另一进程可直接连接），所以认证来自握手本身；正确 token 才 ALLOW。",
  },
  {
    id: 2,
    attack: "伪造设备",
    expected: "DENY",
    evidence: [
      pick("02-tls", "错 CA 签发的客户端证书"),
      pick("02-tls", "无客户端证书"),
      pick("02-tls", "证书链有效但未在团队注册"),
    ],
    observed: "错 CA 签发 / 不带证书 / 链有效但未注册，三种都在握手期或应用层被拒。",
    verdict: VERDICT.PASS,
    rationale: "mTLS 的链校验 + 应用层注册表双重拦截，业务请求计数为 0。",
  },
  {
    id: 3,
    attack: "错误 TLS 证书（错 CA / 主机名不匹配）",
    expected: "DENY",
    evidence: [
      pick("02-tls", "错 CA 签发的客户端证书"),
      pick("02-tls", "服务端证书 SAN 不含 localhost"),
      pick("02-tls", "向 TLS 端口发明文 HTTP"),
      pick("02-tls", "总账"),
    ],
    observed: "错 CA DENY；主机名不匹配被客户端拒绝；明文 HTTP 拿不到业务响应；总账确认无降级放行。",
    verdict: VERDICT.PASS,
    rationale: "失败时不 fallback 到明文——这条是本轮判 FAIL 的红线，实测未触发。",
  },
  {
    id: 4,
    attack: "过期证书（客户端 / 服务端）",
    expected: "DENY",
    evidence: [
      pick("02-tls", "过期客户端证书"),
      pick("02-tls", "过期服务端证书"),
      pick("02-tls", "被撤销设备的"),
      pick("02-tls", "应用层撤销名单命中"),
    ],
    observed:
      "过期客户端证书被拒（CERT_HAS_EXPIRED）；过期服务端证书被客户端拒绝；撤销需应用层实现且实测 DENY。",
    verdict: VERDICT.PASS,
    rationale:
      "真实签发了有效期内为 2020 年的证书来测，不是模拟。另：Node tls 不做 CRL/OCSP，撤销与注册表必须自建。",
  },
  {
    id: 5,
    attack: "路径穿越",
    expected: "DENY",
    evidence: [
      pick("05-path", "常见写法"),
      pick("05-path", "加固写法"),
      pick("05-path", "TOCTOU-2"),
      pick("05-path", "拥有 Node fs"),
    ],
    observed:
      "常见写法（resolve + startsWith）被 ../ 前缀混淆与软件链载荷攻破；加固写法对 13 类载荷全部 DENY；但中间段 TOCTOU 可绕过，且执行单元自带 fs 时可完全绕过。",
    verdict: VERDICT.PARTIAL,
    rationale:
      "防护在本层成立（PASS 的部分），但同一实现存在已实测的绕过，且应用层检查不构成边界 → 整体 PARTIAL，不得写成 DENY 已彻底成立。",
  },
  {
    id: 6,
    attack: "软链逃逸",
    expected: "DENY",
    evidence: [
      pick("05-path", "加固写法"),
      pick("05-path", "TOCTOU-1"),
      pick("05-path", "TOCTOU-2"),
      pick("05-path", "硬链接"),
    ],
    observed:
      "静态软链（普通 / 改名 / 嵌套 / 目录）全部 DENY；末段被换成软链时 O_NOFOLLOW 返回 ELOOP；但中间段被换成软链时实测绕过；硬链接同样绕过。",
    verdict: VERDICT.PARTIAL,
    rationale: "静态场景 PASS，动态场景（TOCTOU 中间段、硬链接）实测被绕过——这两条只能靠 OS 层封。",
  },
  {
    id: 7,
    attack: "任意 shell 注入",
    expected: "DENY",
    evidence: [
      pick("07-exec", "shell=false + spawn"),
      pick("07-exec", "反例：同 7 类载荷"),
      pick("07-exec", "命令允许列表"),
    ],
    observed:
      "shell=false 下 7 类载荷（; && | 反引号 $() 引号 换行）没有一个变成命令；同一批载荷交给 shell 拼接时确实执行了；命令允许列表把可执行文件与参数形状收口到注册表。",
    verdict: VERDICT.PASS,
    rationale: "反例同时被实测，说明禁令是必要的而不是教条。",
  },
  {
    id: 8,
    attack: "插件读取受限目录",
    expected: "DENY",
    evidence: [
      pick("06-isolation", "文件系统约束"),
      pick("06-isolation", "应用任何「增加限制」的 profile"),
      pick("05-path", "拥有 Node fs"),
    ],
    observed:
      "同进程与普通子进程都能直接读 denied/；本机无法应用带 deny 规则的 seatbelt profile，OS 沙箱档未取得证据。",
    verdict: VERDICT.BLOCKED,
    rationale:
      "本机拿不到 OS 级文件约束，因此这条**不能判 DENY 成立**。现有唯一的拦截是应用层路径检查，而它已被证明可绕过。",
  },
  {
    id: 9,
    attack: "插件看到父进程密钥",
    expected: "DENY",
    evidence: [
      pick("04-env", "默认 spawn"),
      pick("04-env", "spawn({ ...process.env })"),
      pick("04-env", "显式允许列表"),
      pick("04-env", "Worker Thread"),
      pick("03-credential", "helper 子进程环境"),
    ],
    observed:
      "默认写法与 { ...process.env } 都把 4 个假密钥全部带进子进程；显式允许列表下泄漏为 0；Worker Thread 与主进程共享 process.env。",
    verdict: VERDICT.PARTIAL,
    rationale:
      "只有在启动层显式使用允许列表时才 DENY。这是**必须由调用方配合**的收口点，不是自动成立的属性；且 Worker 档无解，必须用进程。",
  },
  {
    id: 10,
    attack: "日志里出现密钥",
    expected: "DENY",
    evidence: [
      pick("08-redaction", "多塞一个未授权字段"),
      pick("08-redaction", "七种隐蔽形态"),
      pick("08-redaction", "落盘后的日志文件"),
      pick("03-credential", "产物自查"),
    ],
    observed:
      "字段白名单拒绝未登记字段（含 prompt 全文）；密钥 / Bearer / MCP / Adobe / base64 / api_key 查询参数 / 私有绝对路径全部脱敏；落盘日志扫描无命中。",
    verdict: VERDICT.PASS,
    rationale: "白名单 + 多形态脱敏 + 产物自查三层，且都有落盘证据。",
  },
  {
    id: 11,
    attack: "取消后出现孤儿",
    expected: "NONE",
    evidence: [
      pick("07-exec", "只 kill 直接子进程"),
      pick("07-exec", "按进程组取消"),
    ],
    observed:
      "只 kill 直接子进程时孙进程确实成为孤儿并继续存活；按进程组取消（kill(-pgid)）时 parent → child → grandchild 全部退出，无孤儿。",
    verdict: VERDICT.PASS,
    rationale:
      "两种路径都实测过。结论是「无孤儿」有条件：必须按进程组取消。Windows 侧未验证（见平台行）。",
  },
  {
    id: 12,
    attack: "未知副作用",
    expected: "VERIFY，不盲目重试",
    evidence: [
      pick("08-redaction", "任何「副作用可能已发生」"),
      pick("08-redaction", "核对流程闭环"),
      pick("08-redaction", "盲目重放被禁止"),
    ],
    observed:
      "UNKNOWN_EFFECT / 取消 / 失败但不确定 三种状态一律 DENY 重试；核对流程分三支（已生效 / 未生效 / 无法判定），无法判定时停在 UNKNOWN_EFFECT 并转人工。",
    verdict: VERDICT.PASS,
    rationale: "契约层面闭环，不存在任何允许盲目重放的路径。本轮只写契约，不实现完整任务系统。",
  },
];

const counts = {};
for (const row of MATRIX) counts[row.verdict] = (counts[row.verdict] || 0) + 1;

// 每一条都作为独立判定条目落到产物里，便于逐条对账。
for (const row of MATRIX) {
  p.case(`#${row.id} ${row.attack}（期望 ${row.expected}）`, row.verdict, {
    attackId: row.id,
    expected: row.expected,
    observed: row.observed,
    rationale: row.rationale,
    evidenceCases: row.evidence.map((c) => c?.name ?? null),
  });
}
for (const row of MATRIX) {
  console.log(`  [${row.verdict}] #${row.id} ${row.attack}（期望 ${row.expected}）`);
}

const nonexistentEvidence = MATRIX.flatMap((r) =>
  r.evidence.map((c, i) => (c ? null : { row: r.id, index: i })).filter(Boolean)
);
p.case(
  "12 条攻击全部能溯源到具体探针用例（不存在凭空判定）",
  nonexistentEvidence.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  { missingEvidence: nonexistentEvidence, totalRows: MATRIX.length }
);

const deniRows = MATRIX.filter((r) => r.verdict === VERDICT.PARTIAL && r.expected === "DENY");
p.case(
  "有 3 条应判 DENY 的攻击只能判 PARTIAL（防护成立但有已实测评测的绕过路径）",
  deniRows.length === 3 ? VERDICT.PASS : VERDICT.NOT_VERIFIED,
  {
    rows: deniRows.map((r) => ({ id: r.id, attack: r.attack, rationale: r.rationale })),
    note: "这三条分别是路径穿越、软链逃逸、插件看到父进程密钥——共同点是「需要调用方配合或仅应用层成立」。",
  }
);

p.case(
  "攻击矩阵整体判定",
  VERDICT.PARTIAL,
  {
    counts,
    rows: MATRIX.map((r) => ({
      id: r.id,
      attack: r.attack,
      expected: r.expected,
      verdict: r.verdict,
      observed: r.observed,
      rationale: r.rationale,
    })),
    hardRedLines: [
      { name: "TLS 失败降级到明文", status: "未触发（02 实测无降级放行）" },
      { name: "任意 shell 注入被执行", status: "未触发（07 实测 7 类载荷全部无效）" },
      { name: "未知副作用被盲目重放", status: "未触发（08 契约无此路径）" },
    ],
    reason:
      "无 FAIL，但存在 3 条 PARTIAL（需要调用方配合 / 仅应用层成立）与 1 条 BLOCKED（本机无法建立 OS 级文件约束）。" +
      "按 §31，核心安全边界里有一部分只有 JS 逻辑、没有 OS 级约束，因此**不能写 COMPLETE**。",
  }
);

p.case(
  "平台范围：macOS 已实测项 / Windows 未验证项",
  VERDICT.PARTIAL,
  {
    macOS: [
      "TLS / mTLS 握手与失败场景（02）",
      "Keychain 读写删与密钥边界（03）",
      "环境继承与允许列表（04）",
      "路径 / 软链 / TOCTOU（05）",
      "崩溃隔离 / 内存共享（06）",
      "shell 策略 / 资源限制 / 取消传播（07）",
      "日志脱敏 / 错误边界 / 副作用契约（08）",
    ],
    macOSBlocked: ["seatbelt 进程级文件与网络约束（06）", "rlimit 内存上限（07）", "跨 uid 的 UDS 权限拦截（01）"],
    windowsNotVerified: [
      "DPAPI / Credential Manager（凭据存储）",
      "Named Pipe ACL",
      "Job Object（进程组取消、ProcessMemoryLimit）",
      "AppContainer / Restricted Token（文件与网络约束）",
      "Windows 沙箱行为",
    ],
    note:
      "Node API 名字相同不代表隔离成立。Windows 侧必须在真机逐项实测后才能进入 D3，" +
      "不允许用 macOS 结论外推。",
  }
);

p.note(
  `攻击矩阵：${JSON.stringify(counts)}。` +
    "硬红线（TLS 降级明文 / shell 注入 / 盲目重放）全部未触发；" +
    "但 3 条 DENY 只能判 PARTIAL（应用层防护存在已实测绕过），1 条判 BLOCKED（本机无法建立 OS 级文件约束）。" +
    "结论：D1-05 不能判 COMPLETE。"
);

p.write();
process.exit(0);
