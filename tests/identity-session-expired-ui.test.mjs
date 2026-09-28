/**
 * D5-03 第四批 · 渲染层消费 identity/session-expired。
 *
 * 测的是 useIdentity 事件订阅实际用的那一份判定（src/identity/types.ts::identityEventConvergence）
 * 加 absorb 的错误码表：会话自然到期必须与"下一条命令失败"收敛到同一个状态、同一句解释，
 * 而不是停留在看似已登录的壳里等下一次命令失败。
 *
 * 边界（如实写清，不用它当少测的理由）：
 *   · 渲染层没有 hook 级测试基建：真机路径是 tests/identity-ui.mjs 的 Electron 探针
 *     （需要 dist + 真机窗口，按 W35 统一串行跑）。这里不拉起 React，也不引入任何测试框架。
 *   · 因此纯函数负责"判定到哪一步"，useIdentity 只负责把判定写进 state；
 *     后者的接线由 U4 的源码断言锁定（与 E12 对 main.cjs 的接线断言同一手法），不靠"看着像"。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import { errorText, identityEventConvergence, IDENTITY_ERROR_TEXT } from "../src/identity/types.ts";

const require = createRequire(import.meta.url);
const domain = require("../electron/identity-domain.cjs");

const uiSource = () => fs.readFileSync(new URL("../src/identity/useIdentity.ts", import.meta.url), "utf8");

test("U1 · 自然到期：收敛为未认证，并用身份域真实码 SESSION_EXPIRED 走既有 absorb", () => {
  assert.equal(domain.EVENT.SESSION_EXPIRED, "identity/session-expired", "渲染层消费的就是身份域这个事件名");

  const idle = identityEventConvergence({ event: "identity/session-expired" });
  assert.equal(idle.phase, "unauthenticated", "自然过期后必须立刻回未认证，不能停在看似已登录的壳里");
  assert.equal(idle.clearSnapshot, true, "会话已经没了：本地投影必须清空（与登出同一条）");
  assert.equal(idle.errorCode, "SESSION_EXPIRED", "用身份域真实的码，不在渲染层自造");
  assert.equal(idle.errorCode, domain.ERROR.SESSION_EXPIRED, "判定用的码必须与身份域同一张表");
  assert.equal(typeof IDENTITY_ERROR_TEXT[idle.errorCode], "string", "登录页对这一码有集中文案，不是裸枚举");

  const absolute = identityEventConvergence({ event: "identity/session-expired", reason: "absolute" });
  assert.deepEqual(absolute, idle, "idle / absolute 只是说法不同，收敛到同一处");
});

test("U2 · 既有事件行为不变：锁定 / 登出 / 解锁 / 会话变更", () => {
  assert.deepEqual(
    identityEventConvergence({ event: "identity/locked" }),
    { phase: "locked", clearSnapshot: false, errorCode: null },
    "锁定进锁屏，且不动投影",
  );
  assert.deepEqual(
    identityEventConvergence({ event: "identity/logged-out" }),
    { phase: "unauthenticated", clearSnapshot: true, errorCode: null },
    "登出与旧实现逐字一致：清投影 + 登录页，且不写错误（正常登出不是错误）",
  );
  assert.deepEqual(
    identityEventConvergence({ event: "identity/unlocked", snapshot: { locked: false } }),
    { phase: "ready", clearSnapshot: false, errorCode: null },
  );
  assert.deepEqual(
    identityEventConvergence({ event: "identity/session-changed", snapshot: { locked: false } }),
    { phase: "ready", clearSnapshot: false, errorCode: null },
  );
  assert.deepEqual(
    identityEventConvergence({ event: "identity/unlocked", snapshot: { locked: true } }),
    { phase: "locked", clearSnapshot: false, errorCode: null },
    "锁定中的会话解锁后仍按快照回锁屏（旧实现同）",
  );
});

test("U3 · 未知事件一律不动，与旧实现的 default 分支一致", () => {
  const still = { phase: null, clearSnapshot: false, errorCode: null };
  assert.deepEqual(identityEventConvergence({ event: "identity/profile-updated", snapshot: { locked: false } }), still);
  assert.deepEqual(identityEventConvergence({ event: "identity/nope" }), still);
  assert.deepEqual(identityEventConvergence({}), still);
  assert.deepEqual(
    identityEventConvergence({ event: "identity/unlocked" }),
    { phase: "ready", clearSnapshot: false, errorCode: null },
    "解锁事件没有快照时仍是 ready（旧实现同）",
  );
});

test("U4 · 接线：订阅用的就是这份判定，且 hook 里没有第二条过期分支", () => {
  const src = uiSource();
  assert.equal(src.includes("identityEventConvergence"), true, "useIdentity 必须调用同一份判定，不能自己再写一套");
  assert.equal(
    /identityEventConvergence\(\{\s*event:\s*event\.event/.test(src),
    true,
    "传进去的就是主进程事件",
  );
  assert.equal(src.includes("if (intent.clearSnapshot) setSnapshot(EMPTY);"), true, "清投影走同一条（与登出同一句）");
  assert.equal(src.includes("absorb({ ok: false, error: intent.errorCode"), true, "到期按既有 absorb 失败收敛，不新造状态机");
  assert.equal(
    src.includes('"SESSION_EXPIRED", "SESSION_REVOKED", "USER_DISABLED"'),
    true,
    "既有 absorb 的失败收敛表仍在：SESSION_EXPIRED → unauthenticated",
  );
  assert.equal(src.includes('case "identity/session-expired"'), false, "判定只有一处：hook 里不得再写第二条过期分支");
});
/**
 * U5 / U6 · EXP-01 回归锁（真机实测缺陷：登录页显示「登录状态已过期，请重新登录。（idle）」）。
 *
 * 修法选了「事件订阅不再把 reason 当 detail 传」，没走 errorText 白名单那条：
 * 白名单会让 idle-expiry / absolute-expiry 这类**运维口径**的说法继续出现在登录页，
 * 而到期给用户的话规范里只有一句。事件 payload 的 reason 仍然原样去运维侧
 * （连接日志 detail = expired:idle / expired:absolute，由 d5-03-mcp-lifecycle 的 L8/L9 锁定）。
 */

/**
 * 与 useIdentity 的事件分支**逐字对应**：到期 → absorb({ ok:false, error: intent.errorCode })（不带 detail）；
 * 其余事件不写错误（登录页没有解释行）。判定来自 identityEventConvergence，文案来自 errorText —— 都是产品那一份。
 */
function eventFailure(event) {
  const intent = identityEventConvergence(event);
  if (!intent.errorCode) return null;
  return { ok: false, error: intent.errorCode };
}

const eventUserText = (event) => {
  const failed = eventFailure(event);
  return failed ? errorText(failed.error, failed.detail) : "";
};

test("U5 · 到期事件给用户的就是规范那一句，内部枚举（idle / absolute / SESSION_EXPIRED）一个都不出现", () => {
  const canonical = IDENTITY_ERROR_TEXT.SESSION_EXPIRED;
  assert.equal(canonical, "登录状态已过期，请重新登录。", "规范里到期就是这一句，不许改写成第二种说法");

  for (const reason of ["idle", "absolute"]) {
    const failed = eventFailure({ event: "identity/session-expired", reason });
    assert.deepEqual(failed, { ok: false, error: "SESSION_EXPIRED" }, "交给 absorb 的失败结果里只有身份域的码，没有运维口径的 detail");
    const text = errorText(failed.error, failed.detail);
    assert.equal(text, canonical, "到期文案必须（且只能）是这一句，实测 " + JSON.stringify(text));
    for (const token of ["idle", "absolute", "SESSION_EXPIRED", "expired"]) {
      assert.equal(text.includes(token), false, "内部值泄漏进用户文案：" + token + " → " + JSON.stringify(text));
    }
  }

  // 接线：reason 不得进 absorb 的 detail（EXP-01 的直接原因）；absorb 的调用形状与收敛仍与 U4 锁的一致
  const src = uiSource();
  assert.equal(/detail:\s*event\.reason/.test(src), false, "事件 reason 是运维口径，不得当 detail 传给 absorb");
  assert.equal(
    /absorb\(\{\s*ok:\s*false,\s*error:\s*intent\.errorCode\s*\},\s*"unauthenticated"\)/.test(src),
    true,
    "到期仍走既有 absorb 失败收敛（与登出同一条），只是不带 detail",
  );
});

test("U6 · 既有四类事件行为不变：不写错误、登录页不产出任何解释行（旧实现同）", () => {
  const cases = [
    ["identity/logged-out", undefined],
    ["identity/locked", undefined],
    ["identity/unlocked", { locked: false }],
    ["identity/session-changed", { locked: false }],
  ];
  for (const [event, snapshot] of cases) {
    assert.equal(eventFailure({ event, snapshot }), null, event + " 不写错误（正常登出/锁定不是错误）");
    assert.equal(eventUserText({ event, snapshot }), "", event + " 不产出用户文案");
  }
  assert.deepEqual(
    eventFailure({ event: "identity/session-expired", reason: "idle" }),
    { ok: false, error: "SESSION_EXPIRED" },
    "到期仍是唯一写错误的那条，与旧实现一致",
  );
});
