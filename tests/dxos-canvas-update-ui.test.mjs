/**
 * 应用市场 › 无限画布「在线更新」的离线单测。
 *
 * 只测纯逻辑 + 静态契约，不启动浏览器 / Electron：
 *   · canvasUpdateLogic.ts   状态映射（未检查 / 检查中 / 已是最新 / 有更新 / 失败）、
 *                            错误码 → 中文、确认门、切源请求、无更新时文案
 *   · CanvasUpdatePanel.vue  二次确认弹层真实存在、data-* 取证清单齐全、只用既有 token
 * 另外对着 electron/market-update-domain.cjs 的冻结错误码核对中文表**不多不少**。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  CANVAS_APP_ID,
  CANVAS_UPDATE_SELECTORS,
  SOURCE_KIND_FALLBACK,
  UPDATE_ERROR_TEXT,
  UPDATE_UNKNOWN_ERROR_TEXT,
  canvasUpdateView,
  confirmCopy,
  confirmDecision,
  formatTimestamp,
  installSuccessText,
  isRejectedError,
  isRetryableError,
  normalizeCanvasUpdateSources,
  normalizeCanvasUpdateStatus,
  pendingInstallAction,
  pendingRollbackAction,
  repositoryText,
  rollbackSuccessText,
  runningVersion,
  sourceKindLabel,
  sourceOptions,
  sourceSetRequest,
  sourceText,
  updateErrorText,
} from "../src-vue/apps/canvasUpdateLogic.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const require = createRequire(import.meta.url);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const readCode = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");

const domain = require(path.join(ROOT, "electron", "market-update-domain.cjs"));
const PANEL = readCode("src-vue/apps/CanvasUpdatePanel.vue");
const MARKET = readCode("src-vue/apps/MarketApp.vue");

const SOURCE = { kind: "modelscope-repo", owner: "bllack", repo: "OpenArc-OS" };
const SOURCES = {
  kind: "modelscope-repo",
  owner: "bllack",
  repo: "OpenArc-OS",
  defaultRepository: { owner: "bllack", repo: "OpenArc-OS" },
  defaultSource: { kind: "modelscope-repo" },
  selected: { kind: "modelscope-repo", owner: "bllack", repo: "OpenArc-OS" },
  sources: [
    { kind: "github-releases", label: "GitHub Releases", defaultRepository: { owner: "invaders-2", repo: "OpenArc-OS" }, configurableFields: ["owner", "repo"] },
    { kind: "modelscope-repo", label: "ModelScope 仓库", defaultRepository: { owner: "bllack", repo: "OpenArc-OS" }, configurableFields: ["owner", "repo"] },
  ],
};

function statusOf(over) {
  return {
    appId: "canvas",
    current: null,
    builtinVersion: "0.1.0",
    source: { ...SOURCE },
    checkedAt: null,
    latest: null,
    updateAvailable: false,
    canRollback: false,
    ...over,
  };
}
const view = (over, input) => canvasUpdateView({ status: statusOf(over), busy: null, errorCode: null, ...input });

/* ══════════════════════════════════════════════════════════════════════════
   1. 错误码 → 中文（与后端冻结码逐条对齐）
   ══════════════════════════════════════════════════════════════════════════ */

test("错误码中文表覆盖后端冻结的全部 MARKET_UPDATE_* 错误码，不多不少", () => {
  const frozen = domain.MARKET_UPDATE_ERROR_CODES.slice().concat([domain.DXOS_ERR_INTERNAL]).sort();
  const mapped = Object.keys(UPDATE_ERROR_TEXT).sort();
  assert.deepEqual(mapped, frozen, "UPDATE_ERROR_TEXT 的键必须与 electron/market-update-domain.cjs 的冻结码一一对应");
});

test("每个错误码都有中文说明且不把原始码当文案", () => {
  for (const code of Object.keys(UPDATE_ERROR_TEXT)) {
    const text = updateErrorText(code);
    assert.ok(text.length > 4, code + " 的中文说明太短");
    assert.ok(!/^MARKET_UPDATE|^DXOS_ERR/.test(text), code + " 直接把原始码当成了文案");
    assert.ok(/[\u4e00-\u9fa5]/.test(text), code + " 的文案里没有中文");
  }
});

test("未知 / 空错误码走通用兜底，不编造原因", () => {
  for (const bad of [undefined, null, "", "MARKET_UPDATE_WHAT", "EACCES"]) {
    assert.equal(updateErrorText(bad), UPDATE_UNKNOWN_ERROR_TEXT);
  }
});

test("硬拒绝类错误被标成不可承诺重试，网络类错误可重试", () => {
  const rejected = ["MARKET_UPDATE_SIGNATURE_INVALID", "MARKET_UPDATE_DIGEST_MISMATCH", "MARKET_UPDATE_SOURCE_DIGEST_MISMATCH", "MARKET_UPDATE_HOST_NOT_ALLOWED"];
  for (const code of rejected) {
    assert.equal(isRejectedError(code), true, code + " 应属硬拒绝");
    assert.equal(isRetryableError(code), false, code + " 不该被承诺重试会成功");
  }
  assert.equal(isRetryableError("MARKET_UPDATE_DOWNLOAD_FAILED"), true);
  assert.equal(isRetryableError("MARKET_UPDATE_CONFLICT"), true);
  assert.equal(isRetryableError(""), false);
});

/* ══════════════════════════════════════════════════════════════════════════
   2. 状态映射
   ══════════════════════════════════════════════════════════════════════════ */

test("未检查：没有 status 时是未检查，不是失败", () => {
  const v = canvasUpdateView({ status: null, busy: null, errorCode: null });
  assert.equal(v.phase, "unchecked");
  assert.equal(v.dataState, "unchecked");
  assert.equal(v.badge, "未检查");
  assert.equal(v.tone, "neutral");
  assert.equal(v.canCheck, true);
  assert.equal(v.canInstall, false);
});

test("未检查：status 读过但 checkedAt 为 null 时仍是未检查，并显示当前来源", () => {
  const v = view({ checkedAt: null, latest: null });
  assert.equal(v.phase, "unchecked");
  assert.match(v.detail, /ModelScope 仓库（bllack\/OpenArc-OS）/);
});

test("检查中：busy=status / busy=check 都是进行中且禁止重复检查", () => {
  for (const busy of ["status", "check"]) {
    const v = canvasUpdateView({ status: statusOf({ checkedAt: 1_700_000_000_000, latest: { version: "0.2.0", notesUrl: null, publishedAt: 0 } }), busy, errorCode: null });
    assert.equal(v.phase, "checking", busy);
    assert.equal(v.dataState, "checking");
    assert.equal(v.canCheck, false);
    assert.equal(v.canInstall, false);
  }
});

test("已是最新（无 Release）：latest=null 是正常状态，文案明确不是错误", () => {
  const v = view({ checkedAt: 1_700_000_000_000, latest: null, updateAvailable: false });
  assert.equal(v.phase, "latest");
  assert.equal(v.dataState, "latest");
  assert.equal(v.badge, "已是最新");
  assert.notEqual(v.tone, "danger");
  assert.equal(v.canInstall, false);
  assert.match(v.title, /还没有发布版本/);
  assert.match(v.detail, /这不是错误/);
});

test("已是最新（有 latest 但不比当前新）：成功语义 + 已安装版本", () => {
  const v = view({ checkedAt: 1_700_000_000_000, latest: { version: "0.1.0", notesUrl: "https://example.test/notes", publishedAt: 1_700_000_000_000 }, updateAvailable: false });
  assert.equal(v.phase, "latest");
  assert.equal(v.tone, "success");
  assert.match(v.title, /已是最新版本 0\.1\.0/);
  assert.match(v.detail, /随包内置的 0\.1\.0/);
});

test("有更新：显示版本、发布时间与来源仓库，并放行安装", () => {
  const published = Date.UTC(2026, 9, 16, 12, 0, 0);
  const v = view({ checkedAt: published, latest: { version: "0.2.0", notesUrl: "https://modelscope.cn/x", publishedAt: published }, updateAvailable: true });
  assert.equal(v.phase, "available");
  assert.equal(v.dataState, "available");
  assert.equal(v.tone, "warning");
  assert.equal(v.badge, "有可用更新");
  assert.equal(v.canInstall, true);
  assert.match(v.title, /0\.2\.0/);
  assert.match(v.detail, /发布时间 2026-10-16/);
  assert.match(v.detail, /随包内置的 0\.1\.0/);
  assert.match(v.detail, /可更新到 0\.2\.0/);
});

test("已安装版本 + 可回滚：current 优先于 builtinVersion，回滚沿用状态", () => {
  const v = view({
    current: { version: "0.2.0", digest: "a".repeat(64), installedAt: 1_700_000_000_000 },
    builtinVersion: "0.1.0",
    checkedAt: 1_700_000_000_000,
    latest: { version: "0.2.0", notesUrl: null, publishedAt: 1_700_000_000_000 },
    updateAvailable: false,
    canRollback: true,
  });
  assert.equal(runningVersion(statusOf({ current: { version: "0.2.0", digest: null, installedAt: 1 } })), "0.2.0");
  assert.equal(v.phase, "latest");
  assert.equal(v.canRollback, true);
  assert.match(v.detail, /已安装的 0\.2\.0/);
});

test("失败态：中文错误 + 可重试；有可用更新时保留重试安装入口", () => {
  const plain = canvasUpdateView({ status: null, busy: null, errorCode: "MARKET_UPDATE_DOWNLOAD_FAILED" });
  assert.equal(plain.phase, "failed");
  assert.equal(plain.tone, "danger");
  assert.equal(plain.canCheck, true);
  assert.equal(plain.canInstall, false);
  assert.equal(plain.title, updateErrorText("MARKET_UPDATE_DOWNLOAD_FAILED"));

  const withUpdate = canvasUpdateView({
    status: statusOf({ checkedAt: 1, latest: { version: "0.2.0", notesUrl: null, publishedAt: 1 }, updateAvailable: true }),
    busy: null,
    errorCode: "MARKET_UPDATE_SIGNATURE_INVALID",
  });
  assert.equal(withUpdate.phase, "failed");
  assert.equal(withUpdate.canInstall, true, "坏签名失败后必须仍能重试（重新走二次确认）");
  assert.match(withUpdate.title, /签名校验没通过/);
});

test("安装中 / 回滚中：busy 透传，按钮 busy 标记成立，状态不变成成功", () => {
  const installing = canvasUpdateView({
    status: statusOf({ checkedAt: 1, latest: { version: "0.2.0", notesUrl: null, publishedAt: 1 }, updateAvailable: true }),
    busy: "install",
    errorCode: null,
  });
  assert.equal(installing.installBusy, true);
  assert.equal(installing.rollbackBusy, false);
  assert.equal(installing.phase, "available");
  assert.notEqual(installing.tone, "success");

  const rollingBack = canvasUpdateView({ status: statusOf({ canRollback: true, current: { version: "0.2.0", digest: null, installedAt: 1 } }), busy: "rollback", errorCode: null });
  assert.equal(rollingBack.rollbackBusy, true);
});

test("状态回包形状不合法时 normalize 回 null，绝不半信任", () => {
  for (const bad of [null, undefined, "x", 3, [], {}]) {
    const normalized = normalizeCanvasUpdateStatus(bad);
    if (bad && typeof bad === "object" && !Array.isArray(bad) && Object.keys(bad).length === 0) continue;
    assert.equal(normalized, null, JSON.stringify(bad));
  }
  const ok = normalizeCanvasUpdateStatus({ latest: { version: "0.3.0", notesUrl: 7, publishedAt: "1700000000000" } });
  assert.equal(ok.appId, CANVAS_APP_ID);
  assert.equal(ok.builtinVersion, "—");
  assert.deepEqual(ok.latest, { version: "0.3.0", notesUrl: null, publishedAt: 1_700_000_000_000 });
  assert.equal(ok.checkedAt, null);
});

/* ══════════════════════════════════════════════════════════════════════════
   3. 确认门（不得后台静默安装）
   ══════════════════════════════════════════════════════════════════════════ */

test("安装动作只在有可用更新时生成，回滚动作只在可回滚时生成", () => {
  assert.equal(pendingInstallAction(null), null);
  assert.equal(pendingInstallAction(statusOf({})), null);
  assert.deepEqual(pendingInstallAction(statusOf({ updateAvailable: true, latest: { version: "0.2.0", notesUrl: null, publishedAt: 0 } })), { kind: "install", version: "0.2.0" });
  assert.equal(pendingRollbackAction(statusOf({ canRollback: false })), null);
  assert.deepEqual(pendingRollbackAction(statusOf({ canRollback: true })), { kind: "rollback", toVersion: null });
});

test("取消确认不发出任何命令", () => {
  const install = { kind: "install", version: "0.2.0" };
  assert.deepEqual(confirmDecision(install, "cancel"), { invoke: false, reason: "cancelled" });
  assert.deepEqual(confirmDecision({ kind: "rollback", toVersion: null }, "cancel"), { invoke: false, reason: "cancelled" });
  assert.deepEqual(confirmDecision(null, "confirm"), { invoke: false, reason: "nothing-pending" });
});

test("确认安装才发 install，且必带 confirm:true 与 appId=canvas", () => {
  const decision = confirmDecision({ kind: "install", version: "0.2.0" }, "confirm");
  assert.equal(decision.invoke, true);
  assert.equal(decision.command, "market/update/install");
  assert.deepEqual(decision.payload, { appId: "canvas", version: "0.2.0", confirm: true });
});

test("确认安装但版本缺失时不伪造 version 字段，confirm 仍然为 true", () => {
  const decision = confirmDecision({ kind: "install", version: "" }, "confirm");
  assert.equal(decision.invoke, true);
  assert.deepEqual(decision.payload, { appId: "canvas", confirm: true });
  assert.equal(Object.prototype.hasOwnProperty.call(decision.payload, "version"), false);
});

test("确认回滚发 rollback，不带 install 的确认字段", () => {
  const decision = confirmDecision({ kind: "rollback", toVersion: null }, "confirm");
  assert.equal(decision.invoke, true);
  assert.equal(decision.command, "market/update/rollback");
  assert.deepEqual(decision.payload, { appId: "canvas" });
});

test("二次确认文案讲清来源、目标版本与当前版本", () => {
  const copy = confirmCopy({ kind: "install", version: "0.2.0" }, statusOf({ builtinVersion: "0.1.0" }), SOURCES);
  assert.equal(copy.kind, "install");
  assert.match(copy.title, /更新无限画布/);
  assert.match(copy.body, /ModelScope 仓库（bllack\/OpenArc-OS）/);
  assert.match(copy.body, /0\.2\.0/);
  assert.match(copy.body, /0\.1\.0/);
  assert.match(copy.body, /不会在后台静默安装/);
  assert.equal(copy.primary, "确认更新");

  const rollback = confirmCopy({ kind: "rollback", toVersion: null }, statusOf({ current: { version: "0.2.0", digest: null, installedAt: 1 } }), SOURCES);
  assert.equal(rollback.kind, "rollback");
  assert.equal(rollback.primary, "确认回滚");
  assert.match(rollback.body, /0\.2\.0/);
});

test("静态：组件里没有绕过确认门直接发 install 的字符串；confirm:true 只由逻辑门产出", () => {
  assert.ok(PANEL.indexOf("market/update/install") < 0, "CanvasUpdatePanel.vue 不得出现 install 命令字面量（必须走 confirmDecision）");
  assert.ok(PANEL.indexOf("confirm: true") < 0, "confirm:true 只能由 canvasUpdateLogic.confirmDecision 产出");
  assert.ok(PANEL.indexOf("confirmDecision(") >= 0, "CanvasUpdatePanel.vue 必须通过 confirmDecision 放行");
  assert.ok(PANEL.indexOf("DsDialog") >= 0, "二次确认必须是真实的 Dialog 层");
  assert.ok(PANEL.indexOf("data-canvas-update-confirm") >= 0, "确认弹层缺少取证属性");
  assert.match(readCode("src-vue/apps/appUpdateLogic.ts"), /confirm: true/);
});

/* ══════════════════════════════════════════════════════════════════════════
   4. 源切换（不覆盖用户已保存的选择）
   ══════════════════════════════════════════════════════════════════════════ */

test("切源：换 kind 只带 kind，不把另一源的 owner/repo 带过去", () => {
  const request = sourceSetRequest({ kind: "github-releases", owner: "me", repo: "mine" }, "modelscope-repo");
  assert.equal(request.invoke, true);
  assert.equal(request.reason, "switch-kind");
  assert.equal(request.command, "market/update/source/set");
  assert.deepEqual(request.payload, { kind: "modelscope-repo" });
  assert.equal(Object.prototype.hasOwnProperty.call(request.payload, "owner"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(request.payload, "repo"), false);
});

test("切源：同 kind 不发命令（不会用默认仓库覆盖已保存的选择）", () => {
  const request = sourceSetRequest({ kind: "modelscope-repo", owner: "my-org", repo: "my-repo" }, "modelscope-repo");
  assert.equal(request.invoke, false);
  assert.equal(request.reason, "same-kind");
});

test("切源：没有当前选择时是首次选择", () => {
  const request = sourceSetRequest(null, "github-releases");
  assert.equal(request.invoke, true);
  assert.equal(request.reason, "first-pick");
  assert.deepEqual(request.payload, { kind: "github-releases" });
});

test("源列表：后端返回时用它，返回不了时用注册表兜底且默认源是 ModelScope", () => {
  const real = sourceOptions(normalizeCanvasUpdateSources(SOURCES));
  assert.deepEqual(real.map((s) => s.kind), ["github-releases", "modelscope-repo"]);
  assert.deepEqual(sourceOptions(null).map((s) => s.kind), SOURCE_KIND_FALLBACK.map((s) => s.kind));
  assert.equal(sourceOptions(null)[0].kind, "modelscope-repo", "兜底列表第一项必须是默认源 ModelScope");
  assert.equal(sourceOptions(null)[0].label, "ModelScope 仓库");
  assert.equal(sourceKindLabel("github-releases"), "GitHub Releases");
  assert.equal(sourceKindLabel("unknown-kind"), "unknown-kind");
});

test("来源文案：kind 与 owner/repo 一起出现，缺字段如实回「—」", () => {
  assert.equal(repositoryText(SOURCE), "bllack/OpenArc-OS");
  assert.equal(repositoryText(null), "—");
  assert.equal(repositoryText({ kind: "x", owner: "", repo: "" }), "—");
  assert.equal(sourceText(SOURCE, normalizeCanvasUpdateSources(SOURCES)), "ModelScope 仓库（bllack/OpenArc-OS）");
  assert.equal(sourceText(null), "—");
});

/* ══════════════════════════════════════════════════════════════════════════
   5. 时间与成功文案
   ══════════════════════════════════════════════════════════════════════════ */

test("时间戳：0 / 空 / 非法如实回「—」，合法值按本机时区 zh 格式", () => {
  for (const bad of [0, null, undefined, "", "abc", -5]) assert.equal(formatTimestamp(bad), "—");
  const ms = Date.UTC(2026, 9, 16, 12, 0, 0);
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  const expected = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  assert.equal(formatTimestamp(ms), expected);
});

test("安装 / 回滚成功文案取自后端回包", () => {
  assert.equal(installSuccessText({ installed: { version: "0.2.0", digest: "x" }, previous: { version: "0.1.0" } }), "已更新到 0.2.0。");
  assert.equal(installSuccessText(null), "更新已完成。");
  assert.equal(rollbackSuccessText({ rolledBackTo: "0.1.0", previous: { version: "0.2.0" } }), "已回滚到 0.1.0。");
  assert.equal(rollbackSuccessText({}), "回滚已完成。");
});

/* ══════════════════════════════════════════════════════════════════════════
   6. 静态契约：data-* 取证清单 + 只用既有 token
   ══════════════════════════════════════════════════════════════════════════ */

test("data-* 选择器清单无重复，且每个属性都真实存在于组件源码里", () => {
  assert.equal(new Set(CANVAS_UPDATE_SELECTORS).size, CANVAS_UPDATE_SELECTORS.length, "选择器清单有重复项");
  const haystack = PANEL + "\n" + MARKET;
  for (const selector of CANVAS_UPDATE_SELECTORS) {
    const match = /^\[data-([a-z0-9-]+)/.exec(selector);
    assert.ok(match, "选择器形状不合法：" + selector);
    const attr = "data-" + match[1];
    assert.ok(haystack.indexOf(attr) >= 0, selector + " 在组件源码里找不到对应属性");
  }
  assert.ok(MARKET.indexOf("data-canvas-update-open") >= 0, "应用市场画布卡片缺少更新入口");
  assert.ok(PANEL.indexOf('data-canvas-update="1"') >= 0, "更新面板缺少根取证标记");
});

test("组件只用既有设计 token，不写死颜色/圆角", () => {
  const styleBlock = /<style scoped>([\s\S]*?)<\/style>/.exec(read("src-vue/apps/CanvasUpdatePanel.vue"));
  assert.ok(styleBlock, "CanvasUpdatePanel.vue 缺少 scoped 样式块");
  const css = styleBlock[1];
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(css), false, "scoped 样式不得写死十六进制颜色");
  assert.equal(/\brgba?\(\s*\d/.test(css), false, "scoped 样式不得写死 rgba 数值颜色");
  const tokens = read("src/design-system/tokens.css") + read("src/design-system/primitives.css") + read("src/styles.css");
  const used = new Set();
  for (const m of css.matchAll(/var\((--[a-z0-9-]+)/g)) used.add(m[1]);
  assert.ok(used.size >= 8, "scoped 样式复用的 token 太少，可能自造了一套");
  for (const name of used) {
    assert.ok(tokens.indexOf(name + ":") >= 0 || tokens.indexOf(name + " ") >= 0, "scoped 样式用了未定义的 token：" + name);
  }
});

test("组件复用既有页面类名（不发明新布局体系）", () => {
  for (const cls of ["pane-toolbar", "pane-title", "set-sec", "set-cap", "set-group", "setting-row", "set-lab", "set-val"]) {
    assert.ok(PANEL.indexOf('"' + cls + '"') >= 0 || PANEL.indexOf('class="' + cls) >= 0 || PANEL.indexOf(" " + cls + " ") >= 0 || PANEL.indexOf(cls + '"') >= 0, "没有复用 ." + cls);
  }
  assert.ok(PANEL.indexOf("segmented text") >= 0, "切源应复用既有 .segmented.text 分段控件");
  assert.ok(PANEL.indexOf("DsButton") >= 0 && PANEL.indexOf("DsBadge") >= 0 && PANEL.indexOf("DsDialog") >= 0, "应复用 DsButton / DsBadge / DsDialog 原语");
});

test("安装/回滚按钮永远走二次确认弹层，且完成前按钮保持原名称", () => {
  assert.ok(/@click="askInstall"/.test(PANEL), "更新按钮必须只打开确认弹层");
  assert.ok(/@click="askRollback"/.test(PANEL), "回滚按钮必须只打开确认弹层");
  assert.ok(/@click="acceptPending"/.test(PANEL), "确认后才真正执行");
  assert.equal(/@click="(install|rollback)\(/.test(PANEL), false, "不得存在绕过确认层的直接执行入口");
  assert.ok(PANEL.indexOf("正在下载并校验更新包") >= 0, "安装中必须有进行中的文字状态（不伪造百分比）");
  assert.equal(/\b\d{1,2}%/.test(PANEL), false, "不得伪造百分比进度");
});
