/**
 * D5-01 Closure · 受控 AI 浏览器能力（最小集）。
 *
 * 作用域（**基础浏览器控制，不是完整自主浏览**）：
 *   · 读取**用户明确授权**的目标标签的页面信息与**有界正文**；
 *   · 导航该目标标签（复用产品既有 URL 安全策略 safeURL 与原生视图控制器）。
 * 明确不做：任意脚本执行、通用点击、表单提交、上传、批量操作。
 *
 * 六条硬约束（与 PLAN §8 / §22-24 及既有工具门契约一致）：
 *   1. **目标由用户在渲染层显式选择**（trusted user context），后端校验
 *      账号 / App / 标签归属（分区 sessionKey = userId）与授权；模型自报的 tabId 一律无效。
 *   2. 目标绑定**稳定标签身份** `windowId#tabId`（与原生 viewId 同口径）；标签关闭、替换、
 *      登出、切账号、撤权后旧目标立即失效，**绝不自动转向当前活动标签或管理界面**。
 *   3. **每次执行前重新检查**（目标存在、归属、未失效、URL 合规），不做"选一次用到底"。
 *   4. 导航按**副作用契约**处理（由调用方即工具门/审批路径决定是否放行），
 *      本模块绝不把它标成只读绕过检查。
 *   5. 页面正文是**不可信参考数据**：有界、不落日志、不进审计；绝不读取 Cookie / 令牌 / 密码。
 *   6. 审计只记目标标签、操作与结果；URL 按既有去敏规则（去凭据、去查询串与片段）。
 */
"use strict";

const { safeURL } = require("./policy.cjs");

/** 正文上限：单次读取返回给模型的最大字符数（超出截断并如实标记）。 */
const MAX_TEXT_CHARS = 4000;
/** 页面信息里的标题上限。 */
const MAX_TITLE_CHARS = 200;

/** URL 去敏：只保留 scheme + host + path（去凭据、查询串、片段）。 */
function safeUrlForAudit(raw) {
  try {
    const u = new URL(String(raw || ""));
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return "";
  }
}

/** 正文清洗：不做 HTML 解析（正文取自 innerText），只做有界 + 去控制字符。 */
function boundedText(text, limit = MAX_TEXT_CHARS) {
  const s = String(text == null ? "" : text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return s.length > limit ? { text: s.slice(0, limit), truncated: true } : { text: s, truncated: false };
}

class BrowserControlAuthority {
  /**
   * @param opts.clock   () => number
   * @param opts.audit   ({actorUserId, appId, toolRef, action, decision, reasonCode}) => void
   * @param opts.log     诊断日志（**绝不放正文**）
   */
  constructor({ clock, audit, log } = {}) {
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.audit = typeof audit === "function" ? audit : () => {};
    this.log = typeof log === "function" ? log : () => {};
    /** controller：main.cjs 在原生视图控制器创建后注入（晚绑定）。 */
    this.controller = null;
    /** 控制目标：key = userId + "|" + appId → Map<"windowId#tabId", target> */
    this.targets = new Map();
    /** 当前会话键（userId）；登出/切账号时清空全部目标。 */
    this.sessionKey = null;
  }

  attachController(controller) {
    this.controller = controller || null;
  }

  #keyOf(userId, appId) {
    return String(userId) + "|" + String(appId);
  }

  #targetsOf(userId, appId) {
    const k = this.#keyOf(userId, appId);
    if (!this.targets.has(k)) this.targets.set(k, new Map());
    return this.targets.get(k);
  }

  /** 会话切换（登出 / 切账号）：旧控制目标一律失效，绝不跨用户保留。 */
  setSession(userId) {
    const next = userId ? String(userId) : null;
    if (next === this.sessionKey) return;
    this.sessionKey = next;
    this.targets.clear();
    this.log("browser-control: session changed, cleared all control targets");
  }

  /** 标签关闭 / 被替换：把该标签从所有目标里摘掉（不自动改绑到别的标签）。 */
  onTabClosed(windowId, tabId) {
    const id = String(windowId) + "#" + String(tabId);
    let removed = 0;
    for (const map of this.targets.values()) if (map.delete(id)) removed += 1;
    if (removed) this.log("browser-control: tab closed, control target invalidated " + id);
    return removed;
  }

  /** 用户在渲染层显式选择"允许 AI 控制的标签"（trusted user context）。 */
  select({ context = {}, userId, appId = "ai", windowId, tabId } = {}) {
    if (String(context.source || "") !== "user" || !userId) return { ok: false, error: "BROWSER_CONTROL_FORBIDDEN" };
    if (this.sessionKey && String(this.sessionKey) !== String(userId)) return { ok: false, error: "BROWSER_CONTROL_FORBIDDEN" };
    // 选择阶段直接对控制器校验（此时该目标还没进注册表，不能走 #verifyTarget）：
    // 标签必须存在、仍存活、分区归属就是当前账号，且是真实 http(s) 网页。
    if (!this.controller) return { ok: false, error: "BROWSER_CONTROL_UNAVAILABLE" };
    const viewId = String(windowId) + "#" + String(tabId);
    const owner = this.controller.ownerOfView(viewId);
    if (!owner || !owner.alive) return { ok: false, error: "BROWSER_CONTROL_TARGET_GONE" };
    if (String(owner.sessionKey || "") !== String(userId)) return { ok: false, error: "BROWSER_CONTROL_FORBIDDEN" };
    if (owner.url && !safeURL(owner.url)) return { ok: false, error: "BROWSER_CONTROL_FORBIDDEN" };
    const target = {
      windowId: String(windowId),
      tabId: String(tabId),
      viewId,
      origin: safeUrlForAudit(owner.url),
      selectedAt: this.clock(),
    };
    this.#targetsOf(userId, appId).set(target.viewId, target);
    this.audit({ actorUserId: userId, appId, toolRef: null, action: "browser.control_selected", decision: target.viewId, reasonCode: null });
    return { ok: true, target: { viewId: target.viewId, origin: target.origin } };
  }

  /** 用户撤销 / 治理撤权：立即失效。 */
  release({ context = {}, userId, appId = "ai", windowId, tabId } = {}) {
    const viewId = String(windowId) + "#" + String(tabId);
    const map = this.#targetsOf(userId, appId);
    const had = map.delete(viewId);
    if (had) this.audit({ actorUserId: userId, appId, toolRef: null, action: "browser.control_released", decision: viewId, reasonCode: null });
    return { ok: true, released: had };
  }

  /** 当前控制目标（安全投影：只有 viewId 与 origin，不含正文）。 */
  list({ userId, appId = "ai" } = {}) {
    return [...this.#targetsOf(userId, appId).values()].map((t) => ({ viewId: t.viewId, origin: t.origin, selectedAt: t.selectedAt }));
  }

  /**
   * 目标校验（**每次操作前都要跑**）：
   * 目标在注册表里、控制器里仍存在、分区归属仍是本人、视图仍存活。
   * 任何一条不成立 → 明确拒绝，**不回落**到活动标签或界面页。
   */
  #verifyTarget({ userId, appId, viewId }) {
    if (!this.controller) return { ok: false, error: "BROWSER_CONTROL_UNAVAILABLE" };
    const target = this.#targetsOf(userId, appId).get(String(viewId));
    if (!target) return { ok: false, error: "BROWSER_CONTROL_NOT_SELECTED" };
    const inv = this.controller.inventory().find((e) => e.viewId === target.viewId);
    if (!inv || !inv.alive) return { ok: false, error: "BROWSER_CONTROL_TARGET_GONE" };
    const owner = this.controller.ownerOfView ? this.controller.ownerOfView(target.viewId) : null;
    if (!owner || String(owner.sessionKey || "") !== String(userId)) return { ok: false, error: "BROWSER_CONTROL_FORBIDDEN" };
    // 只允许控制真实网页（http/https）；界面页永远不可控。
    if (owner.url && !safeURL(owner.url)) return { ok: false, error: "BROWSER_CONTROL_FORBIDDEN" };
    return { ok: true, viewId: target.viewId, url: owner.url || "", windowId: target.windowId, tabId: target.tabId, title: owner.title || "" };
  }

  /**
   * 读取目标标签的页面信息与有界正文（工具执行入口）。
   * 正文**不进审计、不进日志**，只作为不可信参考数据交给调用方。
   */
  async readPage({ userId, appId = "ai", viewId } = {}) {
    const v = this.#verifyTarget({ userId, appId, viewId });
    if (!v.ok) {
      this.audit({ actorUserId: userId, appId, toolRef: "browser.read.page", action: "browser.read_page", decision: "DENY", reasonCode: v.error });
      return { ok: false, error: v.error };
    }
    let raw = "";
    try {
      raw = await this.controller.readText(v.viewId, MAX_TEXT_CHARS * 4);
    } catch (e) {
      this.audit({ actorUserId: userId, appId, toolRef: "browser.read.page", action: "browser.read_page", decision: "DENY", reasonCode: "BROWSER_CONTROL_READ_FAILED" });
      return { ok: false, error: "BROWSER_CONTROL_READ_FAILED" };
    }
    const { text, truncated } = boundedText(raw, MAX_TEXT_CHARS);
    this.audit({ actorUserId: userId, appId, toolRef: "browser.read.page", action: "browser.read_page", decision: "ALLOW", reasonCode: null });
    return {
      ok: true,
      url: safeUrlForAudit(v.url),
      title: String(v.title || "").slice(0, MAX_TITLE_CHARS),
      text,
      truncated,
      /** 页面正文是不可信参考数据 —— 调用方必须按既有信任分层处理，绝不当作指令。 */
      untrusted: true,
      viewId: v.viewId,
    };
  }

  /**
   * 导航目标标签。**只由既有工具门 / 审批路径调用**；本方法自身不做"是否允许"的产品裁决，
   * 但会做目标校验 + URL 安全校验，并把结果落审计（副作用语义由调用方契约决定）。
   */
  async navigate({ userId, appId = "ai", viewId, url } = {}) {
    if (!safeURL(url)) {
      this.audit({ actorUserId: userId, appId, toolRef: "browser.navigate", action: "browser.navigate", decision: "DENY", reasonCode: "BROWSER_CONTROL_URL_REJECTED" });
      return { ok: false, error: "BROWSER_CONTROL_URL_REJECTED" };
    }
    const v = this.#verifyTarget({ userId, appId, viewId });
    if (!v.ok) {
      this.audit({ actorUserId: userId, appId, toolRef: "browser.navigate", action: "browser.navigate", decision: "DENY", reasonCode: v.error });
      return { ok: false, error: v.error };
    }
    const res = this.controller.navigate(v.windowId, String(url), v.tabId);
    if (res && res.error) {
      this.audit({ actorUserId: userId, appId, toolRef: "browser.navigate", action: "browser.navigate", decision: "DENY", reasonCode: "BROWSER_CONTROL_NAVIGATE_FAILED" });
      return { ok: false, error: "BROWSER_CONTROL_NAVIGATE_FAILED" };
    }
    this.audit({ actorUserId: userId, appId, toolRef: "browser.navigate", action: "browser.navigate", decision: "ALLOW", reasonCode: null });
    return { ok: true, viewId: v.viewId, url: safeUrlForAudit(url) };
  }
}

module.exports = { BrowserControlAuthority, safeUrlForAudit, boundedText, MAX_TEXT_CHARS };
