/**
 * UI-1 · Skill 中心契约单测（纯逻辑，不启动浏览器、不依赖 DOM 渲染库）。
 *
 * 测的是 src/skills/skillCenterLogic.ts 这一份**界面真正在用**的规则：
 *   · 命令白名单逐条等于 electron/skill-domain.cjs 的后端白名单（不是复制一份自说自话）
 *   · 错误码 → 文案 / PageState 映射覆盖后端全部 SKILL_* 码
 *   · 状态映射优先级（依赖缺失 > 错误 > 加载 > 空 > 就绪）
 *   · 导入失败分类命中 skill-import.cjs / skill-pack.cjs 的真实失败文本
 *   · 界面源码边界（不 fetch、不写 localStorage、不直连端口）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
  SKILL_COMMANDS,
  SKILL_DEPENDENCY_TEXT,
  SKILL_ERROR_TEXT,
  SKILL_PAGE_STATE_KINDS,
  SKILL_TABS,
  SKILL_TAB_LABEL,
  classifyImportError,
  filterSkills,
  isAllowedSkillCommand,
  skillErrorState,
  skillErrorText,
  skillListState,
  skillProgressPhase,
  skillRunDisabledReason,
  skillRunFeedback,
  skillRunStatusFromPhase,
  skillsForTab,
} from "../src/skills/skillCenterLogic.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const require = createRequire(import.meta.url);
const domain = require(path.join(ROOT, "electron", "skill-domain.cjs"));

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** 去掉块注释与行注释后再扫边界，避免把"禁止联网"这类说明文字误判成实现。 */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");

/* ══════════════════════════════════════════════════════════════════════════
   1 命令白名单：界面白名单 == 后端白名单
   ══════════════════════════════════════════════════════════════════════════ */
test("命令白名单逐条等于后端 skill-domain.cjs 的 SKILL_COMMANDS（含顺序与条数）", () => {
  const backend = Object.keys(domain.SKILL_COMMANDS);
  assert.equal(backend.length, 15, "后端应有 15 条 skill 命令");
  assert.deepEqual([...SKILL_COMMANDS], backend, "界面白名单必须与后端完全一致，不能多也不能少");
});

test("白名单命令都是 skill/ 前缀且不重复", () => {
  const set = new Set(SKILL_COMMANDS);
  assert.equal(set.size, SKILL_COMMANDS.length, "白名单不能有重复项");
  for (const c of SKILL_COMMANDS) {
    assert.match(c, /^skill\/[a-z/]+$/, c + " 必须是 skill/ 前缀命令");
    assert.equal(domain.isSkillCommand(c), true, c + " 必须是后端承认的命令");
  }
});

test("isAllowedSkillCommand 拒绝非白名单输入（含原型污染与非法类型）", () => {
  for (const bad of [
    "",
    "skill/unknown",
    "skill/list ",
    "SKILL/LIST",
    "__proto__",
    "constructor",
    "toString",
    undefined,
    null,
    42,
    {},
    [],
  ]) {
    assert.equal(isAllowedSkillCommand(bad), false, String(bad) + " 不应被放行");
  }
  assert.equal(isAllowedSkillCommand("skill/list"), true);
  assert.equal(isAllowedSkillCommand("skill/pack/import"), true);
});

/* ══════════════════════════════════════════════════════════════════════════
   2 错误码 → 文案 / PageState
   ══════════════════════════════════════════════════════════════════════════ */
test("SKILL_ERROR_TEXT 覆盖后端全部 SKILL_ERROR_CODES，且每条文案非空", () => {
  for (const code of domain.SKILL_ERROR_CODES) {
    assert.equal(typeof SKILL_ERROR_TEXT[code], "string", code + " 必须有文案");
    assert.ok(SKILL_ERROR_TEXT[code].length >= 8, code + " 文案过短，无法说明原因");
  }
});

test("依赖缺失（SKILL_DEPENDENCY_UNAVAILABLE）有明确文案：说明没执行、没产物", () => {
  const text = SKILL_DEPENDENCY_TEXT;
  assert.equal(typeof text, "string");
  assert.ok(text.includes("依赖"), "必须点明是依赖问题");
  assert.ok(text.includes("没有执行"), "必须说明技能没有执行");
  assert.ok(text.includes("产物"), "必须说明没有产物（DESIGN_SYSTEM §9 结果未知与失败分开）");
  assert.equal(skillErrorText("SKILL_DEPENDENCY_UNAVAILABLE"), text);
});

test("未登记错误码也给出可读兜底，不塌缩成空文案", () => {
  const text = skillErrorText("SOMETHING_NEW_FROM_BACKEND");
  assert.equal(typeof text, "string");
  assert.ok(text.length > 0);
  assert.equal(skillErrorText(""), text);
});

test("错误码 → PageState kind 映射：无权 / 依赖缺失 / 其他可重试错误分开", () => {
  assert.equal(skillErrorState("SKILL_UNAUTHENTICATED"), "unauthorized");
  assert.equal(skillErrorState("SKILL_FORBIDDEN"), "unauthorized");
  assert.equal(skillErrorState("SESSION_EXPIRED"), "unauthorized");
  assert.equal(skillErrorState("SKILL_DEPENDENCY_UNAVAILABLE"), "unavailable");
  assert.equal(skillErrorState("SKILL_NOT_READY"), "unavailable");
  assert.equal(skillErrorState("NO_BRIDGE"), "unavailable");
  assert.equal(skillErrorState("SKILL_COMMAND_NOT_ALLOWED"), "error");
  assert.equal(skillErrorState("SKILL_CONFLICT"), "error");
  assert.equal(skillErrorState("DXOS_ERR_INVALID_INPUT"), "error");
  for (const code of domain.SKILL_ERROR_CODES) {
    assert.ok(SKILL_PAGE_STATE_KINDS.includes(skillErrorState(code)), code + " 必须映射到已登记状态");
  }
});

test("界面用到的 PageState kind 都已在 page-states.tsx 的 PAGE_STATE_SPEC 登记（不新增第八种）", () => {
  const source = read("src/design-system/page-states.tsx");
  for (const kind of SKILL_PAGE_STATE_KINDS) {
    const key = new RegExp('["\']?' + kind + '["\']?\\s*:');
    assert.ok(key.test(source), "PAGE_STATE_SPEC 缺少 " + kind);
  }
  /* UI-1 用到的四类必须都在 */
  for (const kind of ["empty", "loading", "error", "unavailable", "unauthorized"]) {
    assert.ok(SKILL_PAGE_STATE_KINDS.includes(kind), "SKILL_PAGE_STATE_KINDS 缺少 " + kind);
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   3 状态映射优先级
   ══════════════════════════════════════════════════════════════════════════ */
test("skillListState 优先级：依赖缺失 > 错误 > 加载 > 空 > 就绪", () => {
  const base = { loading: false, errorCode: null, dependencyUnavailable: false, count: 0 };
  assert.equal(skillListState({ ...base, dependencyUnavailable: true }), "unavailable");
  assert.equal(skillListState({ ...base, errorCode: "SKILL_FORBIDDEN" }), "error");
  assert.equal(skillListState({ ...base, loading: true }), "loading");
  assert.equal(skillListState(base), "empty");
  assert.equal(skillListState({ ...base, count: 3 }), "ready");
});

test("依赖缺失压过错误与加载（环境事实先于数据态）", () => {
  assert.equal(
    skillListState({ loading: true, errorCode: "SKILL_INTERNAL", dependencyUnavailable: true, count: 0 }),
    "unavailable",
  );
});

test("有数据时错误不整页盖住列表（局部刷新，保留可用数据）", () => {
  assert.equal(
    skillListState({ loading: false, errorCode: "SKILL_CONFLICT", dependencyUnavailable: false, count: 4 }),
    "ready",
  );
  assert.equal(
    skillListState({ loading: true, errorCode: null, dependencyUnavailable: false, count: 4 }),
    "ready",
  );
});

/* ══════════════════════════════════════════════════════════════════════════
   4 导入失败分类（对齐 skill-import.cjs / skill-pack.cjs 的真实失败文本）
   ══════════════════════════════════════════════════════════════════════════ */
test("导入失败分类命中真实后端文本", () => {
  const cases = [
    [{ code: "DXOS_ERR_INVALID_INPUT", message: "Skill 导入失败：不是有效的 ZIP 文件" }, "zip"],
    [{ code: "DXOS_ERR_INVALID_INPUT", message: "Skill 导入失败：压缩包目录损坏" }, "zip"],
    [{ code: "DXOS_ERR_INVALID_INPUT", message: "Skill 导入失败：压缩包不能超过 32 MB" }, "size"],
    [{ code: "DXOS_ERR_INVALID_INPUT", message: "Skill 包错误：解压总内容超出限制" }, "size"],
    [{ code: "DXOS_ERR_INVALID_INPUT", message: "Skill 包错误：存在不安全路径：<path>" }, "path"],
    [{ code: "DXOS_ERR_INVALID_INPUT", message: "Skill 导入失败：不支持的 Skill 包格式" }, "format"],
    [{ code: "DXOS_ERR_INVALID_INPUT", message: "Skill 导入失败：skill.json 不是有效 JSON" }, "format"],
    [
      { code: "DXOS_ERR_INVALID_INPUT", message: "Skill 导入失败：未找到可导入的 SKILL.md；标准包需包含 skill.json 和 SKILL.md" },
      "content",
    ],
    [{ code: "DXOS_ERR_INVALID_INPUT", message: "Skill 导入失败：多个 Skill 生成了相同 ID：x" }, "content"],
    [{ code: "SKILL_UNAUTHENTICATED", message: "当前会话未认证" }, "permission"],
    [{ code: "SKILL_DEPENDENCY_UNAVAILABLE", message: "技能依赖不可用" }, "dependency"],
    [{ code: "DXOS_ERR_INTERNAL", message: "在线导入（ModelScope）属 OUT 能力，未注入本机安装器" }, "offline"],
    [{ code: "DXOS_ERR_INTERNAL", message: "完全没见过的失败" }, "unknown"],
  ];
  for (const [input, expected] of cases) {
    const out = classifyImportError(input);
    assert.equal(out.category, expected, JSON.stringify(input) + " → " + out.category);
    assert.ok(out.label.length > 0);
  }
});

test("导入分类对空输入与缺字段稳健（不抛异常）", () => {
  for (const input of [{}, { code: null }, { message: null }, { code: undefined, message: undefined }]) {
    const out = classifyImportError(input);
    assert.equal(out.category, "unknown");
    assert.ok(out.label.length > 0);
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   5 运行状态反馈（MOTION_SYSTEM §7）
   ══════════════════════════════════════════════════════════════════════════ */
test("运行反馈：只有 running 是活动指示，成功/失败/依赖缺失各自有标签与说明", () => {
  assert.equal(skillRunFeedback("running").active, true);
  assert.equal(skillRunFeedback("running").tone, "neutral");
  assert.equal(skillRunFeedback("queued").active, false, "排队不显示运行转圈冒充执行");
  assert.equal(skillRunFeedback("success").tone, "success");
  assert.equal(skillRunFeedback("failed").tone, "danger");
  assert.equal(skillRunFeedback("unavailable").tone, "warning");
  for (const s of ["idle", "queued", "running", "success", "failed", "unavailable"]) {
    const f = skillRunFeedback(s);
    assert.ok(f.label.length > 0, s + " 必须有文字标签（不能只靠颜色传意）");
    assert.ok(f.detail.length > 0, s + " 必须有说明");
  }
});

test("progress 事件：begin→running，rejected→依赖缺失，failed→失败，completed 不直接判成功", () => {
  assert.equal(skillProgressPhase({ kind: "progress", payload: { phase: "begin" } }), "begin");
  assert.equal(skillProgressPhase({ kind: "log", payload: { phase: "begin" } }), null, "非 progress 事件不驱动运行态");
  assert.equal(skillProgressPhase(null), null);
  assert.equal(skillRunStatusFromPhase("begin"), "running");
  assert.equal(skillRunStatusFromPhase("rejected"), "unavailable");
  assert.equal(skillRunStatusFromPhase("failed"), "failed");
  assert.equal(skillRunStatusFromPhase("completed"), null, "命令返回不等于成功（成功只由结果决定）");
  assert.equal(skillRunStatusFromPhase(null), null);
});

/* ══════════════════════════════════════════════════════════════════════════
   6 分类过滤 / 运行禁用原因
   ══════════════════════════════════════════════════════════════════════════ */
const sample = [
  { id: "writing", name: "写作生成", builtin: true, layer: "preset", kind: "text", enabled: true },
  { id: "code", name: "代码助手", builtin: true, layer: "preset", kind: "text", enabled: false },
  { id: "generate_image", name: "生成图片", builtin: true, layer: "capability", kind: "image", enabled: true },
  { id: "team_report", name: "团队周报", builtin: false, layer: "workflow", kind: "procedure", enabled: true },
  { id: "hidden_one", name: "隐藏技能", builtin: false, visibleInApp: false, kind: "text", enabled: true },
];

test("skillsForTab：我的技能只含非内置；已安装 = 全部可见技能；市场不返回技能", () => {
  assert.deepEqual(skillsForTab("mine", sample).map((s) => s.id), ["team_report", "hidden_one"]);
  assert.equal(skillsForTab("installed", sample).some((s) => s.id === "hidden_one"), false, "visibleInApp=false 不进已安装");
  assert.deepEqual(skillsForTab("market", sample), []);
});

test("filterSkills 匹配 id / 名称 / 说明，空搜索返回原列表", () => {
  assert.equal(filterSkills(sample, "").length, sample.length);
  assert.deepEqual(filterSkills(sample, "周报").map((s) => s.id), ["team_report"]);
  assert.deepEqual(filterSkills(sample, "TEAM_REPORT").map((s) => s.id), ["team_report"]);
  assert.equal(filterSkills(sample, "不存在的技能").length, 0);
});

test("skillRunDisabledReason：停用 / 系统能力 / 媒体技能 / 可运行", () => {
  assert.equal(skillRunDisabledReason(null), "先选择一个技能");
  assert.ok(skillRunDisabledReason(sample[1]).includes("已停用"));
  assert.ok(skillRunDisabledReason(sample[2]).includes("系统能力"));
  assert.ok(
    skillRunDisabledReason({ id: "x", kind: "image", enabled: true, layer: "preset" }).includes("媒体技能"),
  );
  assert.equal(skillRunDisabledReason(sample[3]), null);
  assert.equal(skillRunDisabledReason(sample[0]), null);
});

test("三分类元数据完整且与 main.tsx 的导航标签一致（市场 / 我的技能 / 已安装）", () => {
  assert.deepEqual([...SKILL_TABS], ["market", "mine", "installed"]);
  const main = read("src/main.tsx");
  for (const label of ["市场", "我的技能", "已安装"]) {
    assert.ok(main.includes(label), "main.tsx 导航缺少分类：" + label);
  }
  for (const tab of SKILL_TABS) assert.ok(SKILL_TAB_LABEL[tab].length > 0);
  assert.equal(SKILL_TAB_LABEL.market.includes("本机导入"), true, "市场分类必须声明只支持本机导入（联网市场 OUT）");
});

/* ══════════════════════════════════════════════════════════════════════════
   7 源码边界（渲染层不发身份 / 不联网 / 不落 localStorage）
   ══════════════════════════════════════════════════════════════════════════ */
test("SkillCenter.tsx 不含 fetch / XHR / WebSocket / localStorage / 直连 URL", () => {
  const src = stripComments(read("src/skills/SkillCenter.tsx"));
  for (const banned of ["fetch(", "XMLHttpRequest", "new WebSocket", "localStorage.", "window.localStorage", "sessionStorage.", "http://", "https://", "127.0.0.1", "api.dx-os.com"]) {
    assert.equal(src.includes(banned), false, "渲染层不允许出现：" + banned);
  }
});

test("SkillCenter.tsx 发送的命令全部在界面白名单内", () => {
  const src = read("src/skills/SkillCenter.tsx");
  const sent = [...src.matchAll(/send\(\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(sent.length >= 6, "至少应覆盖 list / get / enable|disable / run / import / export 等命令");
  for (const cmd of sent) {
    assert.ok(SKILL_COMMANDS.includes(cmd), "发送了未登记命令：" + cmd);
    assert.equal(domain.isSkillCommand(cmd), true, "后端不承认的命令：" + cmd);
  }
  for (const required of ["skill/list", "skill/get", "skill/run", "skill/pack/list", "skill/pack/import"]) {
    assert.ok(sent.includes(required), "应实际调用：" + required);
  }
});

test("SkillCenter.tsx 不发送 userId / role / sessionRef / appId（身份由主进程注入）", () => {
  const src = stripComments(read("src/skills/SkillCenter.tsx"));
  /* 整个实现里不允许出现身份字段名（role 是组件入参，单独只查命令载荷）。 */
  for (const field of ["userId", "sessionRef", "appId"]) {
    assert.equal(src.includes(field), false, "界面不允许出现自报身份字段：" + field);
  }
  /* 命令载荷里不允许带 userId / role / sessionRef / appId。 */
  const payloads = [...src.matchAll(/send\("([^"]+)",([\s\S]*?)\);/g)].map((m) => m[2]);
  assert.ok(payloads.length >= 4, "应能识别到 send 的载荷对象");
  for (const payload of payloads) {
    for (const field of ["userId", "role", "sessionRef", "appId"]) {
      assert.equal(payload.includes(field), false, "命令载荷不允许带身份字段：" + field);
    }
  }
});

test("main.tsx 的 skills 分支只替换占位，导航仍在且唯一渲染一个 SkillCenter", () => {
  const main = read("src/main.tsx");
  assert.equal(main.includes('import { SkillCenter } from "./skills/SkillCenter";'), true);
  assert.equal(main.includes("尚未实现</span>") && /appId === "skills"[\s\S]{0,1200}尚未实现/.test(main), false, "skills 分支不应再是占位");
  const branch = main.slice(main.indexOf('w?.appId === "skills"'));
  assert.ok(branch.includes("<SkillCenter tab={skillTab} role={identity.snapshot.role} />"));
  assert.ok(branch.includes('className="split-side"'), "左侧三分类导航必须保留");
  assert.equal((main.match(/<SkillCenter /g) || []).length, 1, "只应渲染一个 SkillCenter");
});

test("styles.css 只新增 .skill-* 类，不覆盖既有 mcp/ds 类与 token", () => {
  const css = read("src/styles.css");
  const start = css.indexOf(".skill-center {");
  assert.ok(start > 0, "应追加 Skill 中心样式块");
  const block = css.slice(start);
  /* 允许引用 token（var(--fs-*)），但不允许在追加块里定义新 token 或改写既有类。 */
  assert.equal(/\.mcp-[a-z-]+\s*\{/.test(block), false, "不得改写既有 .mcp-* 类");
  assert.equal(/:root\s*\{/.test(block), false, "不得新增 :root token");
  assert.equal(/\.dark\s*\{/.test(block), false, "不得改写 .dark 主题块");
  assert.equal(/--fs-[a-z-]+\s*:/.test(block), false, "不得定义新的字阶 token");
  assert.equal(/--radius-[a-z-]+\s*:/.test(block), false, "不得定义新的圆角 token");
});
