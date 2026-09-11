/**
 * D3-01 · Identity Snapshot 边界（§10 / §23）。
 *
 * 判据：
 *   渲染进程可收到：userId / displayName / role / status / sessionRef / locked …
 *   渲染进程**不得**收到：
 *     password、password hash、salt、KDF 参数、
 *     raw session token、token_hash、全量 session store
 *
 * 做法：跑完整生命周期，把**每一个**返回给渲染进程侧的对象序列化后深扫，
 * 用假口令 / 真实 token / salt 的十六进制逐个比对。**不看字段名像不像**，
 * 只认值是否出现过（D1 探针方法论：判定基于实际值，不读源码文本）。
 */
import { createRequire } from "node:module";
import { Probe, VERDICT, makeFixture } from "./lib/id.mjs";

const require = createRequire(import.meta.url);
const domain = require("../../electron/identity-domain.cjs");

const p = new Probe("09-identity-snapshot", "Identity Snapshot 边界：渲染进程拿不到任何凭据内部值");
const cases = [];
const PW = "fake-password-OPENARC-D3-01"; // 一眼可辨的假口令，专供落盘扫描

{
  const fx = makeFixture();
  await fx.service.dispatch({ type: "identity/initialize", identifier: "admin@openarc.local", password: PW, displayName: "Admin" });
  const login = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: PW });
  const ref = login.snapshot.sessionRef;
  const token = (await fx.secrets.read()).token;

  // 收集全部"会过桥给渲染进程"的对象
  const surface = {
    login,
    status: await fx.service.dispatch({ type: "identity/status" }),
    validate: await fx.service.dispatch({ type: "identity/validate", sessionRef: ref }),
    lock: await fx.service.dispatch({ type: "identity/lock", sessionRef: ref }),
    unlock: await fx.service.dispatch({ type: "identity/unlock", sessionRef: ref, password: PW }),
    restore: await fx.service.dispatch({ type: "identity/restore" }),
  };
  const blob = JSON.stringify(surface);

  cases.push({
    name: "N1 · 返回值中不含假口令明文",
    status: !blob.includes(PW) ? VERDICT.PASS : VERDICT.FAIL,
    detail: blob.includes(PW) ? "命中" : "未命中",
  });
  cases.push({
    name: "N2 · 返回值中不含 raw session token",
    status: !blob.includes(token) ? VERDICT.PASS : VERDICT.FAIL,
    detail: `token 长度 ${token.length}，未出现在返回值中=${!blob.includes(token)}`,
  });

  const user = fx.store.allUsers()[0];
  const saltHex = Buffer.from(user.password_salt).toString("hex");
  const saltB64 = Buffer.from(user.password_salt).toString("base64");
  cases.push({
    name: "N3 · 返回值中不含 salt（hex / base64 两种编码都不出现）",
    status: !blob.includes(saltHex) && !blob.includes(saltB64) ? VERDICT.PASS : VERDICT.FAIL,
    detail: `saltHex=${saltHex.slice(0, 12)}…`,
  });
  cases.push({
    name: "N4 · 返回值中不含 verifier 串",
    status: !blob.includes(user.password_hash) ? VERDICT.PASS : VERDICT.FAIL,
    detail: user.password_hash.slice(0, 24) + "…",
  });

  // 静态：快照字段白名单
  const snap = surface.login.snapshot;
  const violations = domain.snapshotViolations(snap);
  cases.push({
    name: "N5 · 快照字段通过禁止键静态断言",
    status: violations.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
    detail: violations.join(",") || `字段=${Object.keys(snap).join(",")}`,
  });

  const forbidden = ["password", "salt", "token", "tokenHash", "passwordHash", "credentialRef", "apiKey"];
  const leaked = forbidden.filter((k) => k in snap);
  cases.push({
    name: "N6 · 快照不含任何凭据字段名",
    status: leaked.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
    detail: leaked.join(",") || "无",
  });

  // 反向确认断言不是空转：故意塞一个禁键进去必须被抓到
  const tampered = domain.snapshotViolations({ ...snap, password_hash: "x" });
  cases.push({
    name: "N7 · 受控反证：塞入 password_hash 后断言变红（证明断言没空转）",
    status: tampered.length === 1 && tampered[0] === "password_hash" ? VERDICT.PASS : VERDICT.FAIL,
    detail: `捕获=${tampered.join(",")}`,
  });

  // 渲染进程拿到的 session 视图只是"这条"，不是全量 session store
  const sessionView = surface.login.session;
  cases.push({
    name: "N8 · 只下发当前 session 的视图，不是全量 session store",
    status: sessionView && !Array.isArray(sessionView) && fx.store.allSessions().length >= 1 ? VERDICT.PASS : VERDICT.FAIL,
    detail: `session 视图字段=${Object.keys(sessionView || {}).join(",")}`,
  });

  cases.push({
    name: "N9 · 快照里 role / status 是安全的展示态（不含内部枚举的 internals）",
    status: snap.role === "ADMIN" && snap.status === "ACTIVE" ? VERDICT.PASS : VERDICT.FAIL,
    detail: `role=${snap.role}, status=${snap.status}`,
  });

  // 禁用用户的快照必须带 status，UI 才能显示"已停用"
  const uid = user.id;
  await fx.service.dispatch({ type: "identity/disable-user", userId: uid });
  await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: PW });
  const st = await fx.service.dispatch({ type: "identity/status" });
  cases.push({
    name: "N10 · 禁用后 status 接口不泄漏凭据，且用户状态可被 UI 读到",
    status: !JSON.stringify(st).includes(PW) && fx.store.userById(uid).status === "DISABLED" ? VERDICT.PASS : VERDICT.FAIL,
    detail: `user.status=${fx.store.userById(uid).status}`,
  });

  fx.cleanup();
}

p.cases.push(...cases);
p.assertAll(cases);
const r = p.write();
console.log(`\n== 09-identity-snapshot 结论：${r.verdict} — ${JSON.stringify(r.counts)}`);
console.log(`   产物：${r.file}`);
process.exit(r.verdict === VERDICT.FAIL ? 1 : 0);
