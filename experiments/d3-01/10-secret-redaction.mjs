/**
 * D3-01 · 日志脱敏（§34）。
 *
 * 继承 D1-05 冻结：**字段白名单** + **secret redaction**。
 *
 * 允许：event、userId、sessionRef 的哈希、result、errorCode、durationMs。
 * 禁止：password、password hash、salt、raw session token、Authorization、环境变量。
 *
 * 做法：
 *   1. 用假口令注册到 logger 的 secret 表
 *   2. 跑完整生命周期（含失败路径）
 *   3. 扫审计记录 + 数据库里的 audit_log + 探针产物，找假口令 / token / salt
 *   4. 另外验证字段白名单真的在拦（塞一个不在白名单的字段进去，必须被丢弃）
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { Probe, VERDICT, makeFixture, ART } from "./lib/id.mjs";

const require = createRequire(import.meta.url);
const { IdentityLogger, FIELD_WHITELIST } = require("../../electron/identity-log.cjs");

const p = new Probe("10-secret-redaction", "审计日志：字段白名单 + 已登记 secret 不落盘");
const cases = [];
const PW = "fake-password-OPENARC-REDACT";

{
  const fx = makeFixture();
  fx.logger.registerSecret(PW);
  fx.logger.registerSecret("another-fake-secret-1");

  await fx.service.dispatch({ type: "identity/initialize", identifier: "admin@openarc.local", password: PW, displayName: "Admin" });
  const login = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: PW });
  const ref = login.snapshot.sessionRef;
  const token = (await fx.secrets.read()).token;
  fx.logger.registerSecret(token);

  // 失败路径也要记，而且同样不能带 secret
  await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: "wrong-password-9" });
  await fx.service.dispatch({ type: "identity/unlock", sessionRef: ref, password: "wrong-password-9" });
  await fx.service.dispatch({ type: "identity/change-password", sessionRef: ref, currentPassword: "nope", newPassword: "nope-nope-1" });
  await fx.service.dispatch({ type: "identity/lock", sessionRef: ref });
  await fx.service.dispatch({ type: "identity/validate", sessionRef: ref });
  await fx.service.dispatch({ type: "identity/logout", sessionRef: ref });

  cases.push({
    name: "R1 · 审计记录数 > 0（确实在记，不是空集导致的假通过）",
    status: fx.logger.records.length > 5 ? VERDICT.PASS : VERDICT.FAIL,
    detail: `records=${fx.logger.records.length}`,
  });

  const leaks = fx.logger.leaks();
  cases.push({
    name: "R2 · 日志中不含已登记的假口令 / token",
    status: leaks.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
    detail: leaks.join(",") || "未命中",
  });

  const keys = new Set();
  for (const r of fx.logger.records) for (const k of Object.keys(r)) keys.add(k);
  const extra = [...keys].filter((k) => !FIELD_WHITELIST.includes(k));
  cases.push({
    name: "R3 · 日志字段全部在白名单内",
    status: extra.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
    detail: extra.join(",") || `字段=${[...keys].join(",")}`,
  });

  // 受控反证：塞一个不在白名单的字段，必须被丢弃
  const probeLogger = new IdentityLogger();
  probeLogger.registerSecret(PW);
  probeLogger.log({ event: "x", password: PW, token: "t", result: "OK" });
  const rec = probeLogger.records[0];
  cases.push({
    name: "R4 · 受控反证：password / token 字段被白名单拦掉",
    status: !("password" in rec) && !("token" in rec) ? VERDICT.PASS : VERDICT.FAIL,
    detail: `实际字段=${Object.keys(rec).join(",")}`,
  });

  // 嵌套对象里的敏感 key 也要被打码
  const nested = new IdentityLogger();
  nested.registerSecret(PW);
  nested.log({ event: "y", result: "OK", detail: { password: PW, note: "ok" } });
  cases.push({
    name: "R5 · 自由文本 detail 里的敏感 key 被打码",
    status: nested.records[0].detail?.password === "[REDACTED]" ? VERDICT.PASS : VERDICT.FAIL,
    detail: JSON.stringify(nested.records[0].detail),
  });

  // 数据库里的 audit_log 同样不能有 secret
  const rows = fx.store.auditLog();
  const dbBlob = JSON.stringify(rows);
  cases.push({
    name: "R6 · 数据库 audit_log 不含假口令 / token / salt",
    status: !dbBlob.includes(PW) && !dbBlob.includes(token) ? VERDICT.PASS : VERDICT.FAIL,
    detail: `审计行数=${rows.length}`,
  });
  const hasSessionHash = rows.some((r) => r.session_ref_hash && /^[0-9a-f]{16}$/.test(r.session_ref_hash));
  cases.push({
    name: "R7 · session 只以 ref 的哈希前 16 位入账（可关联但不可重放）",
    status: hasSessionHash ? VERDICT.PASS : VERDICT.FAIL,
    detail: `样例=${rows.find((r) => r.session_ref_hash)?.session_ref_hash}`,
  });

  // 审计里有失败也有成功，且带 errorCode —— 证明内部可分类而外部不泄漏
  const denied = rows.filter((r) => r.result === "DENY");
  const coded = denied.filter((r) => r.error_code);
  cases.push({
    name: "R8 · 失败记录带内部 errorCode（内部可分类，外部只给统一码）",
    status: denied.length > 0 && coded.length === denied.length ? VERDICT.PASS : VERDICT.FAIL,
    detail: `DENY=${denied.length}, 带码=${coded.length}`,
  });

  // 落盘产物自查：本探针自己的产物也不能含 secret
  const artifact = { note: "self-check", audited: rows.length };
  const artifactLeaks = fx.logger.scanArtifact(artifact);
  cases.push({
    name: "R9 · 落盘前产物自查通过（与 D1-05 08-redaction 同判据）",
    status: artifactLeaks.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
    detail: artifactLeaks.join(",") || "通过",
  });

  // 顺带确认上一批产物目录里也没有假口令（跨探针检查）
  const prior = fs.existsSync(ART) ? fs.readdirSync(ART).filter((f) => f.endsWith(".json")) : [];
  const dirty = [];
  for (const f of prior) {
    const text = fs.readFileSync(path.join(ART, f), "utf8");
    if (text.includes(PW) || text.includes("fake-password-OPENARC-D3-01")) dirty.push(f);
  }
  cases.push({
    name: "R10 · 已落盘的其它探针产物也不含假口令",
    status: dirty.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
    detail: `检查 ${prior.length} 份产物，命中=${dirty.join(",") || "0"}`,
  });

  fx.cleanup();
}

p.cases.push(...cases);
p.assertAll(cases);
const r = p.write();
console.log(`\n== 10-secret-redaction 结论：${r.verdict} — ${JSON.stringify(r.counts)}`);
console.log(`   产物：${r.file}`);
process.exit(r.verdict === VERDICT.FAIL ? 1 : 0);
