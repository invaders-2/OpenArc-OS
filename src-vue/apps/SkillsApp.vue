<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { Download, FileUp, Globe, Package, Play, Plus, Search, ShoppingBag, Sparkles, Square, Tag, Trash2, User } from "lucide-vue-next";
import { useShellStore } from "../stores/shell";
import DsBadge from "../design-system/DsBadge.vue";
import DsDialog from "../design-system/DsDialog.vue";
import SkillCreatorDialog from "./SkillCreatorDialog.vue";
import { launchCanvasSkill } from "./canvasSkillLaunch";
import {
  analyzeResultOf,
  buildSkillRunArguments,
  canSaveAnalyzedSkill,
  classifyImportError,
  collectSkillArtifacts,
  filterSkills,
  isAllowedSkillCommand,
  isValidSkillId,
  skillEntryAvailability,
  skillFailureText,
  skillRunFeedback,
  skillRunInputs,
  skillsForTab,
  SKILL_ARTIFACT_KIND_LABEL,
  type SkillArtifact,
  type SkillDependencyFlags,
  type SkillPack,
  type SkillRecord,
  type SkillRunStatus,
  type SkillV2,
} from "../../src/skills/skillCenterLogic";

/**
 * Skill 中心（10-16 接后端 skill 域，取代 10-15 的「桌面 Skill 文件夹里的 SKILL.md」简化版）。
 *
 * 数据全部来自 window.openarc.skill.command（skill-bootstrap.cjs 的冻结白名单命令；数量以 skill/health 为准），
 * 错误文案 / 依赖判定 / 运行参数 / 产物投影复用 src/skills/skillCenterLogic.ts（与旧 React 页同一份逻辑、同一组单测）。
 *   · 我的技能 = 非内置（自建 / 导入）；全部技能 = 内置 + 自建；技能包 = skill/pack/list。
 *   · 运行 = skill/run（真实执行，模型由主进程按默认模型解析）；结果与产物如实展示，失败给原因。
 *   · 导入：.md → skill/analyze（解析成 v2 工作流）→ 确认后 skill/save；.zip → skill/pack/import。
 *     10-15 版存在桌面「Skill」文件夹里的 SKILL.md 也列在导入对话框里，一键走同一条分析路径。
 */
const shell = useShellStore();
const bridge = window.openarc?.skill;
const files = window.openarc?.files;

type Tab = "market" | "installed" | "mine" | "packs" | "official";
type Res = { ok?: boolean; value?: any; error?: string; message?: string; detail?: unknown };
const tab = ref<Tab>("market");
const category = ref<string | null>(null);
const query = ref("");
const skills = ref<SkillRecord[]>([]);
const packs = ref<SkillPack[]>([]);
const deps = ref<SkillDependencyFlags | null>(null);
const loading = ref(true);
const listError = ref("");
const message = ref("");
const failure = ref("");
const busy = ref<string | null>(null);

const skillCommandCount = ref<number | null>(null);
const onlineOpen = ref(false);
const onlineSource = ref({ enabled: false, source: "", updatedAt: 0 });
const onlineInput = ref("");
const onlineError = ref("");
function openOnlineSource() {
  onlineInput.value = onlineSource.value.source;
  onlineError.value = "";
  onlineOpen.value = true;
}
async function saveOnlineSource(enabled: boolean) {
  busy.value = "online-save";
  onlineError.value = "";
  const r = await send("skill/pack/install", { onlineSourceAction: "set", enabled, source: onlineInput.value.trim() });
  busy.value = null;
  if (!r.ok) { onlineError.value = errOf(r); return; }
  onlineSource.value = val(r).onlineSource;
  message.value = enabled ? "已保存并启用 ModelScope 来源" : "已停用在线来源";
}
async function installOnlineSkill() {
  busy.value = "online-install";
  onlineError.value = "";
  const r = await send("skill/pack/install", { onlineSource: onlineSource.value.source });
  busy.value = null;
  if (!r.ok) { onlineError.value = errOf(r); return; }
  message.value = "已从配置的 ModelScope 来源安装技能包";
  onlineOpen.value = false;
  await loadAll();
  tab.value = "packs";
}

async function send(command: string, payload: Record<string, unknown> = {}): Promise<Res> {
  if (!isAllowedSkillCommand(command)) return { ok: false, error: "SKILL_COMMAND_NOT_ALLOWED" };
  if (!bridge?.command) return { ok: false, error: "NO_BRIDGE" };
  try {
    const r = await bridge.command({ command, payload });
    return r && typeof r === "object" ? r : { ok: false, error: "RESPONSE_INCOMPLETE" };
  } catch {
    return { ok: false, error: "SKILL_INTERNAL" };
  }
}
const val = (r: Res) => (r.value && typeof r.value === "object" ? r.value : (r as any));
const errOf = (r: Res) => skillFailureText(String(r.error || "SKILL_INTERNAL"), r.detail) + "（" + String(r.error || "SKILL_INTERNAL") + "）";

async function loadAll() {
  loading.value = true;
  const [h, l, p] = await Promise.all([send("skill/health"), send("skill/list"), send("skill/pack/list", { onlineSourceAction: "get" })]);
  deps.value = h.ok ? (val(h).dependencies as SkillDependencyFlags) || {} : null;
  skillCommandCount.value = h.ok && Number.isFinite(Number(val(h).commands)) ? Number(val(h).commands) : null;
  if (l.ok) {
    const v = val(l);
    skills.value = (Array.isArray(v.items) ? v.items : Array.isArray(v.skills) ? v.skills : []) as SkillRecord[];
    listError.value = "";
  } else listError.value = errOf(l);
  if (p.ok) {
    const v = val(p);
    packs.value = (Array.isArray(v.items) ? v.items : Array.isArray(v.packs) ? v.packs : []) as SkillPack[];
    if (v.onlineSource) onlineSource.value = { enabled: v.onlineSource.enabled === true, source: String(v.onlineSource.source || ""), updatedAt: Number(v.onlineSource.updatedAt || 0) };
  }
  loading.value = false;
}

const officialSkills = computed(() => skills.value.filter((s) => s.origin === "official"));
const CATEGORIES = ["图像", "视频", "音频", "写作", "设计", "效率"] as const;
function skillCategory(s: SkillRecord): string {
  const kind = String(s.kind || "");
  const text = `${s.id} ${s.name || ""} ${s.description || ""}`;
  if (/image|photo|midjourney/.test(kind)) return "图像";
  if (/video/.test(kind)) return "视频";
  if (/audio|music|speech/.test(kind)) return "音频";
  if (/design|poster|封面|设计/.test(text)) return "设计";
  if (["chat", "code", "analysis"].includes(s.id) || /batch/.test(kind)) return "效率";
  return "写作";
}
function matchesCategory(s: SkillRecord): boolean {
  return !category.value || skillCategory(s) === category.value;
}
const visible = computed(() => {
  const base = tab.value === "official" ? officialSkills.value : tab.value === "mine" ? skillsForTab("mine", skills.value) : skillsForTab("installed", skills.value);
  return filterSkills(base, query.value).filter(matchesCategory);
});
const filteredPacks = computed(() => {
  const q = query.value.trim().toLowerCase();
  return packs.value.filter((p) => !q || (String(p.name || p.id) + " " + String(p.sourceName || "")).toLowerCase().includes(q));
});
const mineCount = computed(() => skillsForTab("mine", skills.value).length);

/* ── 详情 ── */
const selectedId = ref<string | null>(null);
const detail = ref<SkillRecord | null>(null);
const detailError = ref("");
async function select(id: string) {
  selectedId.value = id;
  detail.value = skills.value.find((s) => s.id === id) || null;
  detailError.value = "";
  run.value = null;
  for (const k of Object.keys(runValues)) delete runValues[k];
  const r = await send("skill/get", { skillId: id });
  if (selectedId.value !== id) return;
  if (r.ok && val(r).skill) detail.value = val(r).skill as SkillRecord;
  else if (!r.ok) detailError.value = errOf(r);
}
const instructions = (s: SkillRecord | null) => (s ? (s.source && s.source.instructions) || s.systemPrompt || "" : "");

/* ── 官方技能：复制提示词 / 在画布 Agent 中试用（TapNow appStore 的两个核心动作） ──
   提示词只来自本地技能定义（systemPrompt 或 SKILL.md 的 source.instructions 或 v2 分步说明），
   没有就明确说没有，不用示例文案凑。 */
const officialNotice = ref("");
function skillPrompt(s: SkillRecord | null): string {
  const direct = String(instructions(s) || "").trim();
  if (direct) return direct;
  const steps = Array.isArray(s?.v2?.steps) ? s!.v2!.steps! : [];
  return steps.map((st) => [st.title, st.detail].filter(Boolean).join("：")).filter(Boolean).join("\n").trim();
}
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "true");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
async function copySkillPrompt(s: SkillRecord) {
  const prompt = skillPrompt(s);
  if (!prompt) { officialNotice.value = "这个技能在本地定义里没有提示词，无法复制。"; return; }
  officialNotice.value = (await copyToClipboard(prompt)) ? "已复制「" + (s.name || s.id) + "」的提示词" : "复制失败：剪贴板不可用";
}
async function trySkillInChat(s: SkillRecord) {
  if (!skillPrompt(s)) { officialNotice.value = "这个技能在本地定义里没有提示词，无法带进画布 Agent。"; return; }
  const launched = await launchCanvasSkill({ name: s.name || s.id }, shell);
  officialNotice.value = launched.ok ? "已创建画布并把技能带入 Agent；请确认后发送" : launched.error || "无法打开画布 Agent";
}

const KIND: Record<string, string> = { text: "文本", image: "图片", video: "视频", audio: "音频", "image-edit": "改图", procedure: "流程" };
const LAYER: Record<string, string> = { preset: "内置", user: "自建", pack: "技能包", workspace: "工作区" };
const kindText = (s: SkillRecord) => KIND[String(s.kind || "")] || String(s.kind || "技能");
const originText = (s: SkillRecord) =>
  s.builtin ? "内置" : s.source?.metadata?.packName ? "技能包 · " + s.source.metadata.packName : LAYER[String(s.layer || "")] || "自建";

async function toggle(s: SkillRecord) {
  busy.value = "toggle:" + s.id;
  failure.value = "";
  const r = await send(s.enabled === false ? "skill/enable" : "skill/disable", { skillId: s.id });
  busy.value = null;
  if (!r.ok) {
    failure.value = errOf(r);
    return;
  }
  await loadAll();
  if (selectedId.value === s.id) await select(s.id);
}

/* ── 运行 ── */
const runValues = reactive<Record<string, string>>({});
const run = ref<{ status: SkillRunStatus; text?: string; artifacts?: SkillArtifact[]; error?: string; requestId: string } | null>(null);
const fields = computed(() => skillRunInputs(detail.value));
const runAvail = computed(() => skillEntryAvailability("run", detail.value, deps.value));
const runFb = computed(() => skillRunFeedback(run.value ? run.value.status : "idle"));
async function doRun() {
  const s = detail.value;
  if (!s || busy.value) return;
  if (!runAvail.value.available) {
    run.value = { status: "unavailable", error: skillFailureText(runAvail.value.code || "SKILL_DEPENDENCY_UNAVAILABLE", { dependency: runAvail.value.missing[0]?.key }), requestId: "" };
    return;
  }
  const built = buildSkillRunArguments(fields.value, runValues);
  if (!built.ok) {
    run.value = { status: "failed", error: "请先填写：" + built.missing.join("、"), requestId: "" };
    return;
  }
  const requestId = "skr_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  run.value = { status: "running", requestId };
  busy.value = "run";
  const r = await send("skill/run", { skillId: s.id, arguments: built.args, requestId });
  busy.value = null;
  if (r.ok) {
    const v = val(r);
    run.value = { status: "success", text: typeof v.text === "string" ? v.text : "", artifacts: collectSkillArtifacts(v), requestId };
  } else {
    run.value = { status: r.error === "SKILL_DEPENDENCY_UNAVAILABLE" ? "unavailable" : "failed", error: errOf(r), requestId };
  }
}
let offEvent: (() => void) | null = null;

/* ── 新建 / 编辑 / 分析结果保存 ── */
const creatorOpen = ref(false);
const creatorSkill = ref<SkillRecord | null>(null);
function openCreator(s: SkillRecord | null = null) {
  creatorSkill.value = s;
  creatorOpen.value = true;
}
async function onCreatorSaved(id: string) {
  creatorOpen.value = false;
  query.value = "";
  category.value = null;
  await loadAll();
  tab.value = "mine";
  await select(id);
}
const editor = ref(false);
const form = reactive({ id: "", name: "", description: "", systemPrompt: "", editing: false });
const analyzedV2 = ref<SkillV2 | null>(null);
const analyzeWarnings = ref<string[]>([]);
function openEditor(s: SkillRecord | null, v2: SkillV2 | null = null) {
  form.id = s?.id ?? "";
  form.name = s?.name ?? "";
  form.description = s?.description ?? "";
  form.systemPrompt = instructions(s);
  form.editing = !!s && !v2 && !!skills.value.find((x) => x.id === s.id);
  analyzedV2.value = v2;
  editorError.value = "";
  editor.value = true;
}
const editorError = ref("");
const suggestId = () => {
  if (form.editing || form.id) return;
  const ascii = form.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  form.id = /^[a-z]/.test(ascii) ? ascii.slice(0, 40) : "skill_" + Date.now().toString(36);
};
async function save() {
  editorError.value = "";
  if (!isValidSkillId(form.id)) return void (editorError.value = "ID 需以小写字母开头，只能包含小写字母、数字和下划线。");
  if (!form.name.trim()) return void (editorError.value = "名称不能为空。");
  if (!form.systemPrompt.trim()) return void (editorError.value = "执行说明不能为空：写清楚这个技能要怎么做。");
  if (analyzedV2.value) {
    const chk = canSaveAnalyzedSkill({ id: form.id, name: form.name, systemPrompt: form.systemPrompt, v2: analyzedV2.value } as SkillRecord);
    if (!chk.ok) return void (editorError.value = chk.reason || "分析结果不完整，不能保存。");
  }
  busy.value = "save";
  const r = await send("skill/save", {
    skill: {
      id: form.id.trim().toLowerCase(),
      name: form.name.trim(),
      description: form.description.trim(),
      systemPrompt: form.systemPrompt.trim(),
      ...(analyzedV2.value ? { v2: analyzedV2.value } : {}),
    },
  });
  busy.value = null;
  if (!r.ok) return void (editorError.value = errOf(r));
  editor.value = false;
  message.value = `已保存「${form.name.trim()}」`;
  await loadAll();
  tab.value = "mine";
  await select(form.id.trim().toLowerCase());
}

/* ── 删除 / 卸载 ── */
const confirmItem = ref<{ kind: "skill" | "pack"; id: string; name: string } | null>(null);
async function confirmDelete() {
  const c = confirmItem.value;
  if (!c) return;
  busy.value = "delete";
  const r = c.kind === "pack" ? await send("skill/pack/uninstall", { packId: c.id }) : await send("skill/delete", { skillId: c.id });
  busy.value = null;
  confirmItem.value = null;
  if (!r.ok) return void (failure.value = errOf(r));
  message.value = c.kind === "pack" ? `已卸载技能包「${c.name}」` : `已删除「${c.name}」`;
  if (c.kind === "skill" && selectedId.value === c.id) {
    selectedId.value = null;
    detail.value = null;
  }
  await loadAll();
}

/* ── 导出 ── */
async function exportSkill(s: SkillRecord) {
  busy.value = "export";
  const r = await send("skill/pack/export", { skillId: s.id });
  busy.value = null;
  if (!r.ok) return void (failure.value = errOf(r));
  const v = val(r);
  const name = typeof v.fileName === "string" ? v.fileName : s.id + ".zip";
  if (typeof v.base64 === "string" && v.base64) {
    const bin = atob(v.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  message.value = `已导出 ${name}`;
}

/* ── 导入 ── */
const importing = ref(false);
const importError = ref("");
const picker = ref<HTMLInputElement | null>(null);
type Candidate = { key: string; folderId: string; id: string; name: string; folder: string };
const candidates = ref<Candidate[]>([]);
async function openImport() {
  importing.value = true;
  importError.value = "";
  candidates.value = [];
  if (!files) return;
  // 10-15 版 Skill 中心把技能存成桌面「Skill」文件夹里的 SKILL.md：列出来方便迁移（只读访达，不改原文件）
  const out: Candidate[] = [];
  for (const fid of ["desktop", ...shell.folders.map((f) => f.id)]) {
    const res = await files.list(fid).catch(() => null);
    for (const e of res?.entries ?? []) {
      if (!/^md$/i.test(String(e.ext))) continue;
      out.push({ key: fid + "/" + e.id, folderId: fid, id: e.id, name: e.name, folder: fid === "desktop" ? "桌面" : shell.folders.find((f) => f.id === fid)?.name ?? "文件夹" });
    }
  }
  candidates.value = out.slice(0, 40);
}
async function analyzeMarkdown(markdown: string, sourceName: string) {
  if (!markdown.trim()) return void (importError.value = "文件是空的。");
  const avail = skillEntryAvailability("analyze", null, deps.value);
  if (!avail.available) return void (importError.value = skillFailureText(avail.code || "SKILL_DEPENDENCY_UNAVAILABLE", { dependency: avail.missing[0]?.key }));
  busy.value = "analyze";
  const r = await send("skill/analyze", { markdown, sourceName });
  busy.value = null;
  if (!r.ok) return void (importError.value = errOf(r));
  const parsed = analyzeResultOf(val(r));
  if (!parsed.skill) return void (importError.value = "没能从这个文档里识别出技能。");
  analyzeWarnings.value = parsed.warnings;
  importing.value = false;
  openEditor(parsed.skill, parsed.skill.v2 || null);
}
async function importCandidate(c: Candidate) {
  const r = await files?.read?.(c.folderId, c.id).catch(() => null);
  if (!r?.text) return void (importError.value = "读取失败：" + c.name);
  await analyzeMarkdown(r.text, c.name);
}
async function onPick(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  importError.value = "";
  if (/\.zip$/i.test(file.name)) {
    if (file.size > 32 * 1024 * 1024) return void (importError.value = "技能包超过 32 MB 上限。");
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    busy.value = "import";
    const r = await send("skill/pack/import", { archiveBase64: btoa(bin), sourceName: file.name, requestId: "ski_" + Date.now().toString(36) });
    busy.value = null;
    if (!r.ok) {
      const c = classifyImportError({ code: String(r.error || ""), message: String(r.message || "") });
      return void (importError.value = c.label + (c.detail && c.detail !== c.label ? "：" + c.detail : ""));
    }
    const n = Array.isArray(val(r).skills) ? val(r).skills.length : 0;
    importing.value = false;
    message.value = `已导入技能包「${file.name}」` + (n ? `，注册了 ${n} 个技能` : "");
    await loadAll();
    tab.value = "packs";
    return;
  }
  await analyzeMarkdown(await file.text(), file.name);
}

const title = computed(() => ({ market: "全部 Skill", installed: "已安装", mine: "我的技能", packs: "技能包", official: "官方技能" })[tab.value]);
onMounted(() => {
  void loadAll();
  offEvent =
    bridge?.onEvent?.((ev: any) => {
      const p = ev && ev.payload;
      if (!p || p.command !== "skill/run" || !run.value || (p.requestId && p.requestId !== run.value.requestId)) return;
      if (p.phase === "failed" || p.phase === "rejected") run.value = { ...run.value, status: "failed" };
    }) ?? null;
});
onBeforeUnmount(() => offEvent?.());
</script>

<template>
  <div class="split skills-app" data-skill-center>
    <nav class="split-side sk-side" aria-label="Skill 分类">
      <div class="split-section">Skill</div>
      <button type="button" class="split-nav" data-skill-tab="market" :aria-current="tab === 'market' ? 'true' : undefined" @click="tab = 'market'"><ShoppingBag :size="16" /> <span class="split-nav-label">市场</span></button>
      <button type="button" class="split-nav" data-skill-tab="mine" :aria-current="tab === 'mine' ? 'true' : undefined" @click="tab = 'mine'"><User :size="16" /> <span class="split-nav-label">我的技能</span><small class="planned-count">{{ mineCount }}</small></button>
      <button type="button" class="split-nav" data-skill-tab="installed" :aria-current="tab === 'installed' ? 'true' : undefined" @click="tab = 'installed'"><Package :size="16" /> <span class="split-nav-label">已安装</span><small class="planned-count">{{ skillsForTab("installed", skills).length }}</small></button>
      <button type="button" class="split-nav" data-skill-tab="official" :aria-current="tab === 'official' ? 'true' : undefined" @click="tab = 'official'"><Sparkles :size="16" /> <span class="split-nav-label">官方技能</span><small class="planned-count">{{ officialSkills.length }}</small></button>
      <button type="button" class="split-nav" data-skill-tab="packs" :aria-current="tab === 'packs' ? 'true' : undefined" @click="tab = 'packs'"><Package :size="16" /> <span class="split-nav-label">技能包</span><small class="planned-count">{{ packs.length }}</small></button>
      <div class="split-section">分类</div>
      <button v-for="c in CATEGORIES" :key="c" type="button" class="split-nav" :aria-current="category === c ? 'true' : undefined" :data-skill-category="c" @click="category = category === c ? null : c"><Tag :size="14" /> <span class="split-nav-label">{{ c }}</span></button>
      <p class="planned-note">技能描述做事的方法和步骤；启用技能不会自动获得应用、设备或文件权限。</p>
    </nav>

    <div class="split-main sk-main">
      <div class="pane-toolbar sk-toolbar">
        <strong class="pane-title">{{ title }}</strong>
        <label class="ds-search sk-search"><Search :size="14" /><input v-model="query" data-skill-search aria-label="搜索 Skill" placeholder="搜索 Skill…" /></label>
        <div class="toolbar-spacer" />
        <button class="planned-today sk-btn" data-skill-online-open @click="openOnlineSource"><Globe :size="13" /> 在线来源</button>
        <button class="planned-today sk-btn" data-skill-import @click="openImport"><FileUp :size="13" /> 导入</button>
        <button class="planned-today sk-btn" data-skill-new :disabled="!bridge" @click="openEditor(null)"><Plus :size="13" /> 手动新建</button>
        <button class="planned-cta sk-btn" data-skill-creator-open :disabled="!bridge" @click="openCreator()"><Sparkles :size="13" /> 助手创建</button>
      </div>
      <p v-if="message" class="vd-msg sk-msg" role="status">{{ message }}</p>
      <p v-if="failure" class="vd-msg sk-msg err" role="alert">{{ failure }}</p>
      <p v-if="officialNotice" class="vd-msg sk-msg" role="status" data-skill-official-notice>{{ officialNotice }}</p>

      <section v-if="bridge && onlineOpen" class="set-group sk-online" data-skill-online-source :data-skill-online-commands="skillCommandCount === null ? '' : String(skillCommandCount)">
        <div class="setting-row">
          <span class="set-lab">在线来源 · ModelScope<small>按指定技能或合集地址安装，不伪造在线列表</small></span>
          <DsBadge size="sm" :tone="deps?.onlineInstaller ? 'success' : 'warning'">{{ deps?.onlineInstaller ? "安装器已就绪" : "安装器未装配" }}</DsBadge>
          <button type="button" class="icon-button" aria-label="关闭在线来源" data-skill-online-close @click="onlineOpen = false">×</button>
        </div>
        <label class="sk-online-field">技能或合集地址 / npx skills add 命令<textarea v-model="onlineInput" data-skill-online-input rows="3" placeholder="https://modelscope.cn/skills/作者/技能或合集" /></label>
        <p class="set-cap" data-skill-online-state>{{ onlineSource.enabled ? "已启用配置的来源。" : "尚未启用在线来源。" }}{{ deps?.onlineInstaller ? " 安装由主进程执行并校验包内容。" : " 当前主进程未注入安装器，配置可以保存，但不能安装。" }}</p>
        <p v-if="onlineError" class="vd-msg sk-msg err" role="alert" data-skill-online-error>{{ onlineError }}</p>
        <div class="sk-online-actions">
          <button class="planned-today sk-btn" :disabled="!!busy || !onlineInput.trim()" data-skill-online-save @click="saveOnlineSource(true)">保存并启用</button>
          <button v-if="onlineSource.enabled" class="planned-today sk-btn" :disabled="!!busy" @click="saveOnlineSource(false)">停用</button>
          <button class="planned-cta sk-btn" :disabled="!!busy || !deps?.onlineInstaller || !onlineSource.enabled" data-skill-online-install-button @click="installOnlineSkill">{{ busy === "online-install" ? "安装中…" : "从已保存来源安装" }}</button>
        </div>
      </section>

      <div v-if="!bridge" class="empty-content">
        <h2 class="planned-title">技能服务未接入</h2>
        <p>主进程没有装配技能域，这台设备上暂时不能使用 Skill。</p>
      </div>
      <div v-else-if="listError && !skills.length" class="empty-content">
        <h2 class="planned-title">读取技能失败</h2>
        <p>{{ listError }}</p>
        <button class="planned-today" @click="loadAll">重试</button>
      </div>

      <!-- 技能包 -->
      <div v-else-if="tab === 'packs'" class="sk-body">
        <p v-if="!filteredPacks.length && !loading" class="set-cap">还没有导入技能包。点右上角「导入」选择一个 .zip 技能包（≤ 32 MB）。</p>
        <div v-if="filteredPacks.length" class="set-group">
          <div v-for="p in filteredPacks" :key="p.id" class="setting-row sk-row" :data-skill-pack="p.id">
            <span class="sk-ico"><Package :size="15" /></span>
            <span class="set-lab">
              {{ p.name || p.id }}
              <small>{{ p.skillCount ?? "—" }} 个技能 · {{ p.sourceName || "本机导入" }}{{ p.importedAt ? " · " + new Date(p.importedAt).toLocaleDateString("zh-CN") : "" }}</small>
            </span>
            <button class="icon-button" :aria-label="'卸载 ' + (p.name || p.id)" title="卸载" @click="confirmItem = { kind: 'pack', id: p.id, name: p.name || p.id }"><Trash2 :size="14" /></button>
          </div>
        </div>
      </div>

      <!-- 技能列表 + 详情 -->
      <div v-else class="sk-split">
        <div class="sk-list">
          <p v-if="loading && !skills.length" class="set-cap">正在读取…</p>
          <p v-else-if="!visible.length" class="set-cap">
            <template v-if="tab === 'official'">本地技能清单里没有 origin=official 的官方技能（来源：skill/list，本地技能定义）。</template>
            <template v-else>{{ tab === "mine" ? "还没有自建技能。点「新建技能」，或从访达导入一份 Markdown 文档。" : "没有匹配的技能。" }}</template>
          </p>
          <article
            v-for="s in visible"
            :key="s.id"
            class="sk-item"
            :class="{ on: selectedId === s.id, off: s.enabled === false }"
            :data-skill-id="s.id"
            tabindex="0"
            @click="select(s.id)"
            @keydown.enter="select(s.id)"
          >
            <span class="sk-ico-lg"><Sparkles :size="26" :stroke-width="1.4" /></span>
            <span class="sk-card-body">
              <b class="sk-item-name">{{ s.name || s.id }}</b>
              <small class="sk-desc">{{ s.description || "—" }}</small>
              <small>{{ originText(s) }} · v{{ s.v2?.version || "—" }}{{ s.enabled === false ? " · 已停用" : "" }}</small>
              <small v-if="tab === 'mine'">{{ s.v2?.steps?.length || "—" }} 个步骤 · 仅自己可见</small>
            </span>
            <span v-if="tab === 'official'" class="sk-inline-actions" data-skill-official-actions>
              <button data-skill-copy @click.stop="copySkillPrompt(s)">复制提示词</button>
              <button data-skill-chat @click.stop="trySkillInChat(s)">在画布 Agent 中试用</button>
            </span>
            <span v-else-if="tab !== 'mine'" class="sk-install" :class="{ on: s.enabled !== false }" @click.stop="toggle(s)">{{ s.enabled === false ? "安装" : "已安装" }}</span>
            <span v-else class="sk-inline-actions"><button @click.stop="select(s.id)">试运行</button><button @click.stop="openEditor(s)">编辑</button></span>
          </article>
        </div>

        <section v-if="detail" class="sk-detail" :data-skill-detail="detail.id">
          <header class="sk-detail-head">
            <div>
              <h2>{{ detail.name || detail.id }}</h2>
              <p class="set-cap">{{ detail.description || "—" }}</p>
              <p class="sk-meta"><code>{{ detail.id }}</code> · {{ originText(detail) }} · {{ kindText(detail) }}</p>
            </div>
            <span
              class="au-switch"
              role="switch"
              tabindex="0"
              :aria-checked="detail.enabled !== false"
              :aria-label="(detail.enabled === false ? '启用 ' : '停用 ') + (detail.name || detail.id)"
              data-skill-toggle
              @click="toggle(detail)"
              @keydown.enter="toggle(detail)"
            />
          </header>
          <p v-if="detailError" class="vd-msg sk-msg err">{{ detailError }}</p>

          <div v-if="detail.origin === 'official'" class="sk-block" data-skill-official-detail>
            <h3>快速使用</h3>
            <p class="set-cap">
              提示词来源：<template v-if="skillPrompt(detail)">{{ instructions(detail) ? "本地技能定义（systemPrompt / SKILL.md）" : "本地技能定义的分步说明" }}</template>
              <template v-else>暂无（本地技能定义没有提示词或分步说明），不能复制或带进对话</template>
            </p>
            <div class="sk-official-actions">
              <button class="planned-today sk-btn" data-skill-detail-copy :disabled="!skillPrompt(detail)" @click="copySkillPrompt(detail)">复制提示词</button>
              <button class="planned-cta sk-btn" data-skill-detail-chat :disabled="!skillPrompt(detail)" @click="trySkillInChat(detail)">在画布 Agent 中试用</button>
            </div>
          </div>

          <div v-if="detail.v2 && detail.v2.steps && detail.v2.steps.length" class="sk-block">
            <h3>步骤</h3>
            <ol class="sk-steps-ro">
              <li v-for="(st, i) in detail.v2.steps" :key="i">{{ st.title || st.detail }}<small v-if="st.title && st.detail">{{ st.detail }}</small></li>
            </ol>
          </div>
          <div v-if="instructions(detail)" class="sk-block">
            <h3>执行说明</h3>
            <pre class="sk-pre">{{ instructions(detail) }}</pre>
          </div>

          <div class="sk-block sk-run" data-skill-run>
            <h3>运行</h3>
            <label v-for="f in fields" :key="f.key" class="sk-field">
              <span>{{ f.label }}<em v-if="!f.required">（可选）</em></span>
              <textarea v-if="f.multiline" v-model="runValues[f.key]" rows="3" :placeholder="f.hint" />
              <input v-else v-model="runValues[f.key]" :placeholder="f.hint" />
            </label>
            <div class="sk-run-bar">
              <button class="planned-cta sk-btn" :disabled="detail.enabled === false || busy === 'run'" data-skill-run-go @click="doRun">
                <component :is="busy === 'run' ? Square : Play" :size="12" /> {{ busy === "run" ? "运行中…" : "运行" }}
              </button>
              <span class="sk-run-state" :data-tone="runFb.tone">{{ runFb.label }}</span>
              <span v-if="!runAvail.available" class="set-cap">{{ skillFailureText(runAvail.code || "SKILL_DEPENDENCY_UNAVAILABLE", { dependency: runAvail.missing[0]?.key }) }}</span>
            </div>
            <p v-if="run?.error" class="vd-msg sk-msg err" role="alert">{{ run.error }}</p>
            <pre v-if="run?.text" class="sk-pre sk-out" data-skill-result>{{ run.text }}</pre>
            <ul v-if="run?.artifacts?.length" class="sk-arts">
              <li v-for="(a, i) in run.artifacts" :key="i">{{ SKILL_ARTIFACT_KIND_LABEL[a.kind] }} · {{ a.name || a.nodeId }}</li>
            </ul>
          </div>

          <footer class="sk-detail-foot">
            <button v-if="!detail.builtin" class="planned-today" data-skill-iterate @click="openCreator(detail)">继续迭代</button>
            <button v-if="!detail.builtin" class="planned-today" @click="openEditor(detail)">编辑</button>
            <button class="planned-today" :disabled="busy === 'export'" @click="exportSkill(detail)"><Download :size="12" /> 导出技能包</button>
            <div class="toolbar-spacer" />
            <button v-if="!detail.builtin" class="planned-today danger" @click="confirmItem = { kind: 'skill', id: detail.id, name: detail.name || detail.id }">
              <Trash2 :size="12" /> 删除
            </button>
            <span v-else class="set-cap">内置技能不能修改或删除，可以停用。</span>
          </footer>
        </section>
        <section v-else style="display:none" class="sk-detail sk-detail-empty">
          <Sparkles :size="28" />
          <p>选择一个技能查看说明、运行或导出。</p>
        </section>
      </div>
    </div>

    <SkillCreatorDialog :open="creatorOpen" :skill="creatorSkill" :dependencies="deps" @close="creatorOpen = false" @saved="onCreatorSaved" />

    <DsDialog :open="editor" :title="analyzedV2 ? '保存分析出的技能' : form.editing ? '编辑技能' : '新建技能'" @close="editor = false">
      <div class="sk-form">
        <label>名称<input v-model="form.name" placeholder="例如：门店海报文案" @blur="suggestId" /></label>
        <label>ID<input v-model="form.id" :disabled="form.editing" placeholder="小写字母开头，如 poster_copy" /></label>
        <label>用途说明<input v-model="form.description" placeholder="一句话说明它做什么" /></label>
        <label>执行说明<textarea v-model="form.systemPrompt" rows="7" placeholder="写清楚这个技能怎么做：输入是什么、步骤、输出要求、注意事项" /></label>
        <p v-if="analyzedV2?.steps?.length" class="set-cap">已识别出 {{ analyzedV2.steps.length }} 个步骤，会一起保存。</p>
        <p v-for="w in analyzeWarnings" v-show="analyzedV2" :key="w" class="set-cap">提示：{{ w }}</p>
        <p v-if="editorError" class="vd-msg sk-msg err" role="alert">{{ editorError }}</p>
      </div>
      <template #footer>
        <button @click="editor = false">取消</button>
        <button class="primary" :disabled="busy === 'save'" data-skill-save @click="save">保存</button>
      </template>
    </DsDialog>

    <DsDialog :open="importing" title="导入技能" @close="importing = false">
      <div class="sk-import">
        <p class="set-cap">Markdown 文档（.md）会先分析成技能步骤，确认后保存；技能包（.zip）直接安装。</p>
        <button class="planned-cta sk-btn" :disabled="!!busy" @click="picker?.click()"><FileUp :size="13" /> 从本机选择文件…</button>
        <input ref="picker" type="file" accept=".md,.markdown,.zip" hidden @change="onPick" />
        <p v-if="busy === 'analyze' || busy === 'import'" class="set-cap">{{ busy === "analyze" ? "正在分析文档…" : "正在导入技能包…" }}</p>
        <p v-if="importError" class="vd-msg sk-msg err" role="alert">{{ importError }}</p>
        <template v-if="candidates.length">
          <div class="split-section">访达里的 Markdown</div>
          <div v-for="c in candidates" :key="c.key" class="sk-cand">
            <span class="set-lab">{{ c.name }}<small>{{ c.folder }}</small></span>
            <button class="planned-today" :disabled="!!busy" @click="importCandidate(c)">分析并导入</button>
          </div>
        </template>
      </div>
    </DsDialog>

    <DsDialog :open="!!confirmItem" :title="confirmItem?.kind === 'pack' ? '卸载技能包' : '删除技能'" @close="confirmItem = null">
      <p>{{ confirmItem?.kind === "pack" ? `卸载「${confirmItem?.name}」及其包含的技能？` : `删除「${confirmItem?.name}」？删除后不能恢复，可以先导出备份。` }}</p>
      <template #footer>
        <button @click="confirmItem = null">取消</button>
        <button class="primary danger" :disabled="busy === 'delete'" data-skill-confirm @click="confirmDelete">{{ confirmItem?.kind === "pack" ? "卸载" : "删除" }}</button>
      </template>
    </DsDialog>
  </div>
</template>
<style scoped>

.sk-side { flex: 0 0 210px; width: 210px; }
.sk-side .split-nav { height: 32px; min-height: 32px; }
.sk-main { padding: 0 !important; margin-left: -8px !important; }
.sk-toolbar { height: 52px; min-height: 52px; margin: 0; padding: 0 20px; border-bottom: 0.5px solid var(--line); }
.sk-sub { color: var(--muted); font-size: var(--fs-micro); margin-left: 10px; }
.sk-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; padding: 16px 20px; align-content: start; }
.sk-item { display: grid; grid-template-columns: 52px minmax(0, 1fr) auto; align-items: center; gap: 10px; height: 96px; padding: 12px; border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / 0.035); }
.sk-ico-lg { width: 52px; height: 52px; border-radius: 14px; display: grid; place-items: center; background: rgb(var(--text-rgb) / 0.07); color: var(--muted); }
.sk-card-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.sk-card-body b { font-size: var(--fs-secondary); font-weight: var(--fw-medium); }
.sk-card-body small { color: var(--muted); font-size: var(--fs-micro); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sk-desc { color: var(--muted); }
.sk-install { height: 26px; padding: 0 10px; border-radius: var(--radius-pill); background: rgb(var(--text-rgb) / 0.08); font-size: var(--fs-micro); white-space: nowrap; }
.sk-install.on { background: transparent; color: var(--muted); }

.sk-side { flex: 0 0 210px !important; width: 210px !important; margin-right: 0 !important; }
.sk-side .split-nav { height: 32px; min-height: 32px; }
.sk-side .split-section:first-child { padding-top: 18px; }
.sk-main, .skills-app .split-main { padding: 0 !important; margin-left: -8px !important; }
.sk-toolbar { height: 52px !important; min-height: 52px !important; margin: 0 !important; padding: 0 20px !important; display: flex; align-items: center; border-bottom: 0.5px solid var(--line); }
.sk-list { display: grid !important; grid-template-columns: repeat(2, minmax(0, 1fr)) !important; gap: 10px !important; padding: 8px 24px !important; align-content: start; }
.sk-item { display: grid !important; grid-template-columns: 52px minmax(0, 1fr) auto !important; align-items: center !important; gap: 10px !important; min-height: 112px !important; padding: 12px !important; border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / 0.035); }
.sk-ico-lg { width: 52px !important; height: 52px !important; flex: none; border-radius: 14px; display: grid; place-items: center; background: rgb(var(--text-rgb) / 0.07); color: var(--muted); }
.sk-install { height: 26px; padding: 0 10px; border-radius: var(--radius-pill); background: rgb(var(--text-rgb) / 0.08); font-size: var(--fs-micro); white-space: nowrap; justify-self: end; }



.sk-main, .skills-app .split-main { margin-left: 0 !important; }
.sk-split { display: block !important; }
.sk-list { width: 100% !important; box-sizing: border-box; }
.sk-item { align-items: start !important; padding-top: 14px !important; }
.sk-install { align-self: start; margin-top: 0; }
.sk-toolbar [data-skill-import] { height: 30px !important; padding: 0 12px !important; }

.sk-item { padding: 14px !important; }
.sk-install { width: 64px; justify-self: end; text-align: center; }
.sk-toolbar [data-skill-import] { width: 72px !important; }
.sk-toolbar { gap: 8px; }

.sk-detail { position: absolute; top: 52px; right: 0; bottom: 0; width: 380px; z-index: 20; background: rgb(var(--content-rgb) / 0.98); box-shadow: var(--elevation-2); overflow: auto; }
.sk-inline-actions { display: flex; flex-direction: column; gap: 4px; }
.sk-inline-actions button { height: 24px; padding: 0 8px; border-radius: var(--radius-pill); background: rgb(var(--text-rgb) / 0.07); font-size: var(--fs-micro); }

.sk-detail { top: 52px !important; right: 8px !important; bottom: 8px !important; width: 380px; padding: 16px !important; gap: 14px; border-radius: var(--radius-lg); animation: sk-detail-in 220ms cubic-bezier(0.2,0,0,1); }
.sk-item { cursor: pointer; transition: background-color 100ms, transform 100ms; }
.sk-item:hover, .sk-item:focus-visible { background: rgb(var(--text-rgb) / 0.07); }
.sk-item:active { transform: scale(.995); }
@keyframes sk-detail-in { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: translateX(0); } }
@media (prefers-reduced-motion: reduce) { .sk-detail { animation: none; } .sk-item { transition: none; } }
.sk-official-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.sk-detail-head { align-items: flex-start; gap: 12px; }
.sk-detail-head h2 { margin: 0 0 6px; line-height: 1.25; }
.sk-detail-head > div { min-width: 0; flex: 1; }
.sk-detail-head .au-switch { flex: none; margin-left: auto; }
.sk-detail .au-switch { width: 36px; height: 21px; border-radius: 999px; background: rgb(var(--text-rgb) / 0.2); position: relative; display: inline-block; }
.sk-detail .au-switch::after { content: ""; position: absolute; width: 17px; height: 17px; border-radius: 50%; background: #fff; top: 2px; left: 2px; }
.sk-detail .au-switch[aria-checked="true"] { background: rgb(var(--text-rgb) / 0.85); }
.sk-detail .au-switch[aria-checked="true"]::after { left: 17px; transition: left 160ms cubic-bezier(0.2,0,0,1); }
.sk-search { width: 180px; height: 30px; flex: none; }
.sk-online { margin: 12px 20px 0; padding: 12px 16px; border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / 0.035); animation: sk-panel-in 220ms cubic-bezier(0.2,0,0,1); }
.sk-online-field { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; font-size: var(--fs-secondary); }
.sk-online-field textarea { padding: 8px 10px; border-radius: var(--radius-md); resize: vertical; }
.sk-online-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
@keyframes sk-panel-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
@media (prefers-reduced-motion: reduce) { .sk-online { animation: none; } }
</style>
