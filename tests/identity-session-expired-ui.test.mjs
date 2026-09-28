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
import { errorText, identityEventConvergence, IDENTITY_ERROR_TEXT, SHOWABLE_ERROR_DETAIL } from "../src/identity/types.ts";

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

// ===========================================================================
// D5-03 第五批 · 命令失败路径收口：errorText 的 detail 白名单
//
// 第四批（U5/U6）修的是「事件 reason 被当 detail 传」。上面 U5 的注释说"没走 errorText
// 白名单那条"——那条评估针对的是**事件 reason**：把 idle / absolute 放进白名单等于继续
// 显示（idle-expiry）。本批方向相反：idle-expiry / absolute-expiry **不在表内**，照样丢掉；
// 表里只有"用户自己就能改"的四条，全挂在 INVALID_INPUT 上。两批口径一致，事件路径仍按第四批修法。
//
// 扫描口径：内部标记不手抄 —— detail 字面量从 electron/** 实扫，
// 并用身份域自己的导出（EXPIRY_DETAIL）与真实调用（validatePassword / evaluateSession）交叉核对。
// 断言只加不删：U1–U6 与期望值一行未改。
// ===========================================================================

const KEBAB_TOKEN = /(^|[^a-z0-9-])[a-z][a-z0-9]*(?:-[a-z0-9]+)+([^a-z0-9-]|$)/;
const KEBAB_LITERAL = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;
const ELECTRON_DIR = new URL("../electron/", import.meta.url);
const readSrc = (rel) => fs.readFileSync(new URL("../src/identity/" + rel, import.meta.url), "utf8");

/** 源码锁只锁**代码**：注释里提到旧写法（如 JSDoc 里的反例）不算违规。 */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** electron/** 的全部源码（只读扫描：本批一个字节都不改 electron）。 */
function electronSources() {
  return fs
    .readdirSync(ELECTRON_DIR)
    .filter((name) => name.endsWith(".cjs"))
    .sort()
    .map((name) => ({ name, src: fs.readFileSync(new URL(name, ELECTRON_DIR), "utf8") }));
}

/** detail 形状的字面量（`detail:` / `reason:` / `fail(CODE, "…")`）—— 命令失败路径真正的泄漏面。 */
function scanDetailLiterals() {
  const patterns = [
    /\bdetail:\s*"([^"\\\n]+)"/g,
    /\breason:\s*"([^"\\\n]+)"/g,
    /\bfail\([^,()]+,\s*"([^"\\\n]+)"\)/g,
  ];
  const found = new Map();
  for (const { name, src } of electronSources()) {
    for (const re of patterns) {
      for (const m of src.matchAll(re)) {
        if (KEBAB_LITERAL.test(m[1]) && !found.has(m[1])) found.set(m[1], name);
      }
    }
  }
  return found;
}

/** 兜底面：electron/** 里**所有** kebab-case 字符串字面量（含以常量表声明的 detail，如 EXPIRY_DETAIL）。 */
function scanKebabLiterals() {
  const found = new Map();
  for (const { name, src } of electronSources()) {
    for (const m of src.matchAll(/["'`]([a-z][a-z0-9]*(?:-[a-z0-9]+)+)["'`]/g)) {
      if (!found.has(m[1])) found.set(m[1], name);
    }
  }
  return found;
}

const DETAIL_LITERALS = scanDetailLiterals();
const KEBAB_LITERALS = scanKebabLiterals();
const ERROR_CODES = Object.keys(IDENTITY_ERROR_TEXT);
const WHITELIST_KEYS = Object.keys(SHOWABLE_ERROR_DETAIL);

test("U7 · 真实内部 detail（electron/** 实扫）一律不进用户文案", () => {
  // ① 扫描自身先自证：被点名的泄漏点必须在清单里，数量也不能退化
  for (const token of ["idle-expiry", "absolute-expiry", "session-missing", "not-locked", "session-locked", "password-too-short"]) {
    assert.equal(KEBAB_LITERALS.has(token), true, "兜底扫描必须覆盖：" + token);
  }
  assert.ok(DETAIL_LITERALS.size >= 60, "detail 字面量扫描结果异常少（" + DETAIL_LITERALS.size + "），扫描可能已失效");
  assert.ok(KEBAB_LITERALS.size >= DETAIL_LITERALS.size, "兜底面必须包含 detail 面");

  // ② 除扫描外，再用身份域自己的口径核对三个被点名的泄漏点
  assert.deepEqual(
    Object.values(domain.EXPIRY_DETAIL).sort(),
    ["absolute-expiry", "idle-expiry"],
    "到期 detail 仍是这两条（探针与日志按它分类，不许改），本批只是不让它们进用户文案",
  );
  for (const token of Object.values(domain.EXPIRY_DETAIL)) {
    assert.equal(KEBAB_LITERAL.test(token), true, token + " 就是内部标记形态，不是给用户看的说法");
  }
  assert.equal(require("../electron/password.cjs").validatePassword("").reason, "password-too-short", "口令规则的理由来自真实调用，不是抄来的");
  const noSession = domain.evaluateSession(null, null, Date.now());
  assert.equal(noSession.ok, false);
  assert.equal(noSession.detail, "session-missing", "会话缺失的 detail 来自身份域真实判定");

  // ③ 三个被点名的泄漏点，按它们真实的码逐条断言
  const real = [
    ["SESSION_EXPIRED", "idle-expiry"],
    ["SESSION_EXPIRED", "absolute-expiry"],
    ["SESSION_REVOKED", "session-missing"],
    ["INVALID_INPUT", "not-locked"],
    ["LOCKED", "session-locked"],
  ];
  for (const [code, token] of real) {
    assert.equal(errorText(code, token), IDENTITY_ERROR_TEXT[code], "命令失败路径的 detail 必须被丢弃（" + code + " × " + token + "）");
    assert.equal(errorText(code, token).includes(token), false, "内部标记不得出现在用户文案里：" + token);
  }

  // ④ 全量兜底：electron/** 扫出来的每一个 kebab 标记 × 每一个身份错误码
  for (const [token, file] of KEBAB_LITERALS) {
    for (const code of ERROR_CODES) {
      const text = errorText(code, token);
      assert.equal(text.includes(token), false, "内部标记泄漏（" + file + " 的 " + token + "，码 " + code + "）：" + JSON.stringify(text));
      assert.equal(KEBAB_TOKEN.test(text), false, "用户文案里出现 kebab-case 内部标记（" + token + "，码 " + code + "）：" + JSON.stringify(text));
      if (!WHITELIST_KEYS.includes(token)) {
        assert.equal(text, IDENTITY_ERROR_TEXT[code], "表外 detail 必须被丢弃、且不改 code 那一句（" + token + "，码 " + code + "）：" + JSON.stringify(text));
      }
    }
  }
});

test("U8 · 表外（未知 / 畸形 / 对象被 String 化）的 detail 一律被过滤", () => {
  const base = IDENTITY_ERROR_TEXT.INVALID_INPUT;
  const dropped = ["", "two words", "UPPER_TOKEN", "Mixed-Token", "[object Object]", "INVALID_INPUT", "输入不合法。", "一句谁也没审过的人话", "idle-expiry-next", "x".repeat(300)];
  for (const detail of dropped) {
    assert.equal(errorText("INVALID_INPUT", detail), base, "表外 detail 必须被丢弃：" + JSON.stringify(detail));
  }
  assert.equal(errorText("INVALID_INPUT"), base, "没有 detail 时就是 code 那一句");
  assert.equal(errorText("INVALID_INPUT", undefined), base);
  assert.equal(errorText("SESSION_EXPIRED", "idle-expiry"), IDENTITY_ERROR_TEXT.SESSION_EXPIRED, "到期给用户的只有规范那一句（第四批口径）");
  assert.equal(errorText("RATE_LIMITED", "[object Object]"), IDENTITY_ERROR_TEXT.RATE_LIMITED, "{retryAfterMs} 经 String() 变成的 [object Object] 同样不许出现");
  assert.equal(errorText(undefined, "idle-expiry"), "", "没有 code 时不再直出 detail —— 裸标记不是句子");
  assert.equal(errorText(undefined), "", "没有 code 也没有 detail 时仍是空串");
  assert.equal(errorText("NOT_A_REAL_CODE", "not-a-real-detail"), "NOT_A_REAL_CODE", "未知 code 的既有语义未动（只由 code 决定）");
});

test("U9 · 白名单内的 detail 换成可读人话（不是原样输出）", () => {
  const entries = Object.entries(SHOWABLE_ERROR_DETAIL);
  assert.ok(entries.length >= 1, "白名单不能是空表（否则「两次密码不一致」这类解释会一起消失）");
  assert.ok(entries.length <= 6, "白名单必须是「小表」：加一项就要能回答 why，当前 " + entries.length + " 项");

  for (const [token, entry] of entries) {
    assert.equal(typeof entry.text, "string");
    assert.ok(entry.text.length >= 4, token + " 的 text 太短，不像一句给用户的话");
    assert.equal(KEBAB_TOKEN.test(entry.text), false, token + " 的 text 里还有内部标记形态：" + entry.text);
    assert.equal(entry.text.includes(token), false, token + " 的 text 只是把标记抄了一遍");
    assert.equal(typeof entry.why, "string");
    assert.ok(entry.why.length >= 12, token + " 必须写清为什么它对用户可理解");
    assert.ok(Array.isArray(entry.codes) && entry.codes.length > 0, token + " 必须声明允许的错误码");

    for (const code of entry.codes) {
      assert.equal(ERROR_CODES.includes(code), true, token + " 声明了身份域不存在的错误码：" + code);
      const text = errorText(code, token);
      assert.equal(text, IDENTITY_ERROR_TEXT[code] + entry.text, token + " 在白名单内的码上应给出「码文案 + 可读短语」");
      assert.equal(text.includes(token), false, "换成可读短语后不得再出现原标记：" + JSON.stringify(text));
      assert.equal(KEBAB_TOKEN.test(text), false, "可读短语不得含内部标记形态：" + JSON.stringify(text));
    }

    for (const code of ERROR_CODES.filter((c) => !entry.codes.includes(c))) {
      assert.equal(errorText(code, token), IDENTITY_ERROR_TEXT[code], token + " 串到了不该出现的码上：" + code);
    }
  }

  assert.equal(errorText("INVALID_INPUT", "password-mismatch"), "输入不合法。两次输入的密码不一致。", "渲染层自己判出的输入错误仍要有解释，不是只剩「输入不合法」");
});

test("U10 · 源码锁：detail 只能经白名单进来，禁止任何形式的原样拼接", () => {
  const types = readSrc("types.ts");
  const typesCode = stripComments(types);

  // ① 旧括注实现与一切"String 化后直出"的写法必须消失（只看代码，注释里的反例不算）
  assert.equal(typesCode.includes("（${detail}）"), false, "通用括注实现必须彻底移除");
  assert.equal(/String\(\s*detail\s*\)/.test(typesCode), false, "禁止 String(detail) 之后直出");
  assert.equal(/\$\{[^}]*\bdetail\b[^}]*\}/.test(typesCode), false, "禁止用模板串把 detail 拼进文案");

  // ② errorText 体内 detail 只能出现一次：白名单调用
  const start = types.indexOf("export const errorText");
  assert.notEqual(start, -1, "errorText 必须还在 types.ts（三个界面的唯一出口）");
  const fn = types.slice(start, types.indexOf("\n};", start));
  const body = fn.slice(fn.indexOf("=>"));
  assert.equal((body.match(/\bdetail\b/g) || []).length, 1, "errorText 体内只能引用 detail 一次（白名单调用），实际：" + body.trim());
  assert.equal(/showableDetailText\(\s*code\s*,\s*detail\s*\)/.test(body), true, "detail 只能交给白名单查询");
  assert.equal(body.includes('if (!code) return "";'), true, "没有 code 时不再直出 detail");

  // ③ 白名单查询本身：detail 只当查表的键，返回的只能是表里的 text
  const hStart = types.indexOf("export function showableDetailText");
  assert.notEqual(hStart, -1, "白名单查询必须是独立函数（便于逐条锁）");
  const helper = types.slice(hStart, types.indexOf("\n}", hStart));
  assert.equal(helper.includes("SHOWABLE_ERROR_DETAIL[detail]"), true, "detail 只能当查表的键");
  assert.equal(helper.includes("entry.text"), true, "返回的只能是表里的 text");
  assert.equal(/\$\{/.test(helper), false, "白名单查询里不许出现模板串");
  assert.equal(helper.includes("String(detail)"), false, "白名单查询不许把 detail String 化");

  // ④ 白名单键必须可溯源：electron/** 的真实标记，或渲染层自己发出的标记；不许凭空发明
  const auth = readSrc("AuthScreens.tsx");
  const useId = readSrc("useIdentity.ts");
  const electronText = electronSources().map((f) => f.src).join("\n");
  for (const token of WHITELIST_KEYS) {
    const traceable = electronText.includes('"' + token + '"') || auth.includes('"' + token + '"') || useId.includes('"' + token + '"');
    assert.equal(traceable, true, "白名单键不允许凭空发明（既不在 electron/** 也不在渲染层）：" + token);
  }

  // ⑤ 渲染层不得再自己写用户人话当 detail —— 文案集中到 errorText 的白名单
  for (const [name, src] of [["AuthScreens.tsx", auth], ["useIdentity.ts", useId]]) {
    const prose = stripComments(src).match(/\bdetail:\s*"[^"\n]*[\u4e00-\u9fff][^"\n]*"/);
    assert.equal(prose, null, name + " 不得把中文人话当 detail 传：" + JSON.stringify(prose && prose[0]));
  }
  assert.equal(auth.includes('detail: "password-mismatch"'), true, "「两次密码不一致」仍要有解释：标记走白名单");
});

test("U11 · 错误码语义未变：10 条文案逐字未动，三个入口仍走同一份 errorText", () => {
  assert.deepEqual(
    IDENTITY_ERROR_TEXT,
    {
      NOT_INITIALIZED: "本机尚未完成初始化。",
      ALREADY_INITIALIZED: "本机已经初始化过了，不能重复创建管理员。",
      INVALID_CREDENTIALS: "账号或密码不正确。",
      SESSION_EXPIRED: "登录状态已过期，请重新登录。",
      SESSION_REVOKED: "登录状态已失效，请重新登录。",
      USER_DISABLED: "该账号已被停用，请联系管理员。",
      LOCKED: "屏幕已锁定，需要重新验证。",
      INVALID_INPUT: "输入不合法。",
      RATE_LIMITED: "尝试过于频繁，请稍后再试。",
      INTERNAL_ERROR: "身份服务内部错误。",
    },
    "code → 人话的表本批一个字节都不改：白名单只决定 detail 那一小段",
  );
  for (const code of Object.values(domain.ERROR)) {
    assert.equal(ERROR_CODES.includes(code), true, "身份域错误码都有集中文案：" + code);
  }

  // 白名单只管文案：收敛判定仍是 identityEventConvergence 那一份（U1–U4 锁的就是它）
  assert.deepEqual(
    identityEventConvergence({ event: "identity/session-expired" }),
    { phase: "unauthenticated", clearSnapshot: true, errorCode: "SESSION_EXPIRED" },
    "本批没有碰任何收敛 / 跳转 / 吸收失败的逻辑",
  );

  const auth = readSrc("AuthScreens.tsx");
  assert.equal(auth.includes("errorText(error.code, error.detail)"), true, "登录 / 锁屏 / 初始化的错误行仍走集中文案");
  const main = fs.readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.equal(main.includes("errorText(identity.error.code, identity.error.detail)"), true, "设置里的错误行也走同一份");
});
