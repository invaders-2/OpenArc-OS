/**
 * D3-01 · A01：重复初始化必须真实拒绝（§5 / §43）。
 *
 * Given: 全新安装
 * When : 两个 initialize 请求**竞争提交**（不是顺序点两次）
 * Then : 恰好一个管理员存在；另一个拿到 ALREADY_INITIALIZED；
 *        只有一个 installation identity、只有一个 root team
 *
 * 三组竞争，逐组加严：
 *   A. 同一连接内两个并发调用（KDF 是异步的，事务体在 await 处可能交错）
 *   B. 两个**独立连接**（两条 SQLite 连接，无共享互斥）—— 模拟两个进程
 *   C. 事务体内注入崩溃（installation 已写、admin 未写）—— §27 failure-safe
 */
import { createRequire } from "node:module";
import { Probe, VERDICT, makeFixture, cleanup, tempDir, fakeClock } from "./lib/id.mjs";

const require = createRequire(import.meta.url);
const { IdentityStore } = require("../../electron/identity-store.cjs");

const p = new Probe("01-init-race", "A01 · 初始化一次性与并发竞争");
const cases = [];

const PW_A = "alpha-password-1";
const PW_B = "bravo-password-2";

// ── A. 同一连接内并发 ────────────────────────────────────────────────────
{
  const fx = makeFixture();
  const req = (identifier, password) =>
    fx.store.initialize({ identifier, password, displayName: identifier.split("@")[0] });

  // 两个请求**同时**发起：不 await 第一个，直接并发
  const [a, b] = await Promise.all([req("admin@openarc.local", PW_A), req("second@openarc.local", PW_B)]);
  const okCount = [a, b].filter((r) => r.ok).length;
  const alreadyCount = [a, b].filter((r) => !r.ok && r.error === "ALREADY_INITIALIZED").length;

  cases.push({
    name: "A1 · 并发两次 initialize：恰好一次成功",
    status: okCount === 1 ? VERDICT.PASS : VERDICT.FAIL,
    detail: `ok=${okCount} (期望 1) — a=${a.ok ? "OK" : a.error}, b=${b.ok ? "OK" : b.error}`,
  });
  cases.push({
    name: "A2 · 败者必须拿到 ALREADY_INITIALIZED",
    status: alreadyCount === 1 ? VERDICT.PASS : VERDICT.FAIL,
    detail: `ALREADY_INITIALIZED=${alreadyCount} (期望 1)`,
  });
  cases.push({
    name: "A3 · 最终只有一个管理员",
    status: fx.store.allUsers().length === 1 ? VERDICT.PASS : VERDICT.FAIL,
    detail: `users=${fx.store.allUsers().length}`,
  });
  cases.push({
    name: "A4 · 只有一个 installation / 一个 root team",
    status: fx.store.installation() !== null && fx.store.allTeams().filter((t) => t.root === 1).length === 1 ? VERDICT.PASS : VERDICT.FAIL,
    detail: `installations=${fx.store.db.prepare("SELECT COUNT(*) c FROM installations").get().c}, rootTeams=${fx.store.allTeams().filter((t) => t.root === 1).length}`,
  });
  cases.push({
    name: "A5 · 域不变量健康",
    status: fx.store.invariants().length === 0 ? VERDICT.PASS : VERDICT.FAIL,
    detail: fx.store.invariants().join("; "),
  });
  fx.cleanup();
}

// ── B. 两个独立连接（无共享互斥）────────────────────────────────────────
{
  const dir = tempDir("d3b");
  const path = (await import("node:path")).default.join.bind(null, dir);
  const file = path("identity.db");
  const clock = fakeClock();

  const s1 = new IdentityStore({ path: file, clock, busyTimeoutMs: 3000 }).open();
  const s2 = new IdentityStore({ path: file, clock, busyTimeoutMs: 3000 }).open();

  const [r1, r2] = await Promise.all([
    s1.initialize({ identifier: "admin@openarc.local", password: PW_A, displayName: "Admin" }),
    s2.initialize({ identifier: "second@openarc.local", password: PW_B, displayName: "Second" }),
  ]);
  const okCount = [r1, r2].filter((r) => r.ok).length;
  cases.push({
    name: "B1 · 两条独立连接并发：恰好一次成功",
    status: okCount === 1 ? VERDICT.PASS : VERDICT.FAIL,
    detail: `ok=${okCount} — r1=${r1.ok ? "OK" : r1.error}, r2=${r2.ok ? "OK" : r2.error}`,
  });

  // 两条连接都各自读一次最终状态，确认不是"各自看到各自的"
  const u1 = s1.allUsers().length;
  const u2 = s2.allUsers().length;
  cases.push({
    name: "B2 · 两条连接读到同一个最终状态（1 个用户）",
    status: u1 === 1 && u2 === 1 ? VERDICT.PASS : VERDICT.FAIL,
    detail: `conn1 users=${u1}, conn2 users=${u2}`,
  });
  cases.push({
    name: "B3 · 跨连接后域不变量健康",
    status: s1.invariants().length === 0 && s2.invariants().length === 0 ? VERDICT.PASS : VERDICT.FAIL,
    detail: [...s1.invariants(), ...s2.invariants()].join("; "),
  });
  s1.close();
  s2.close();
  cleanup(dir);
}

// ── C. 事务中途失败（§27）────────────────────────────────────────────────
{
  const dir = tempDir("d3c");
  const nodePath = (await import("node:path")).default;
  let boom = false;
  const store = new IdentityStore({
    path: nodePath.join(dir, "identity.db"),
    hooks: {
      // 模拟"installation 行已写入、admin 还没写"时进程崩溃
      afterInstallationInsert: () => {
        if (boom) throw new Error("simulated crash after installation insert");
      },
    },
  }).open();

  boom = true;
  const crashed = await store.initialize({ identifier: "admin@openarc.local", password: PW_A, displayName: "Admin" });
  cases.push({
    name: "C1 · 事务中崩溃：命令返回失败而不是半成品成功",
    status: !crashed.ok ? VERDICT.PASS : VERDICT.FAIL,
    detail: `result=${crashed.ok ? "OK" : crashed.error}`,
  });

  const instRows = store.db.prepare("SELECT COUNT(*) c FROM installations").get().c;
  const userRows = store.db.prepare("SELECT COUNT(*) c FROM users").get().c;
  const teamRows = store.db.prepare("SELECT COUNT(*) c FROM teams").get().c;
  cases.push({
    name: "C2 · 崩溃后不留下半个 installation / 无 team 的 admin",
    status: instRows === 0 && userRows === 0 && teamRows === 0 ? VERDICT.PASS : VERDICT.FAIL,
    detail: `installations=${instRows}, users=${userRows}, teams=${teamRows}`,
  });
  cases.push({
    name: "C3 · 崩溃后状态仍是 UNINITIALIZED，可以重试",
    status: store.status().initialized === false ? VERDICT.PASS : VERDICT.FAIL,
    detail: `status=${store.status().status}`,
  });

  boom = false;
  const retried = await store.initialize({ identifier: "admin@openarc.local", password: PW_A, displayName: "Admin" });
  cases.push({
    name: "C4 · 崩溃后重试可成功（不留后遗症）",
    status: retried.ok && store.allUsers().length === 1 ? VERDICT.PASS : VERDICT.FAIL,
    detail: `retry=${retried.ok ? "OK" : retried.error}, users=${store.allUsers().length}`,
  });
  store.close();
  cleanup(dir);
}

// ── D. 顺序重复调用（非竞争，但必须同样拒绝）────────────────────────────
{
  const fx = makeFixture();
  const first = await fx.service.dispatch({ type: "identity/initialize", identifier: "admin@openarc.local", password: PW_A, displayName: "Admin" });
  const second = await fx.service.dispatch({ type: "identity/initialize", identifier: "other@openarc.local", password: PW_B, displayName: "Other" });
  cases.push({
    name: "D1 · 已初始化后再次 initialize → ALREADY_INITIALIZED",
    status: first.ok && !second.ok && second.error === "ALREADY_INITIALIZED" ? VERDICT.PASS : VERDICT.FAIL,
    detail: `second=${second.ok ? "OK" : second.error}`,
  });
  fx.cleanup();
}

p.cases.push(...cases);
p.assertAll(cases);
p.note("A01 判据：Given 全新安装 / When 两个 initialize 竞争 / Then 恰好一个管理员");
const r = p.write();
console.log(`\n== 01-init-race 结论：${r.verdict} — ${JSON.stringify(r.counts)}`);
console.log(`   产物：${r.file}`);
process.exit(r.verdict === VERDICT.FAIL ? 1 : 0);
