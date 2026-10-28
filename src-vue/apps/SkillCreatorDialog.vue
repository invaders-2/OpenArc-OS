<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ArrowUp, Check, Pencil, Sparkles } from "lucide-vue-next";
import DsBadge from "../design-system/DsBadge.vue";
import DsDialog from "../design-system/DsDialog.vue";
import { analyzeResultOf, canSaveAnalyzedSkill, isAllowedSkillCommand, isValidSkillId, skillEntryAvailability, skillFailureText, type SkillDependencyFlags, type SkillRecord, type SkillV2 } from "../../src/skills/skillCenterLogic";
import { creatorDocument, creatorDraftOf, creatorVersionText, type CreatorDraft, type CreatorMessage } from "../../src/skills/skillCreatorLogic";

const props = defineProps<{ open: boolean; skill: SkillRecord | null; dependencies: SkillDependencyFlags | null }>();
const emit = defineEmits<{ close: []; saved: [id: string] }>();
const bridge = window.openarc?.skill;
const input = ref("");
const busy = ref<"analyze" | "save" | null>(null);
const error = ref("");
const messages = ref<CreatorMessage[]>([]);
const draft = ref<CreatorDraft | null>(null);
const messageSeq = ref(0);
const instructions = computed(() => props.skill ? props.skill.source?.instructions || props.skill.systemPrompt || "" : "");
const versionText = computed(() => creatorVersionText(draft.value));

watch(() => props.open, (open) => {
  if (!open) return;
  input.value = "";
  busy.value = null;
  error.value = "";
  messages.value = [];
  draft.value = null;
  messageSeq.value = 0;
});

async function send(command: string, payload: Record<string, unknown>) {
  if (!isAllowedSkillCommand(command)) return { ok: false, error: "SKILL_COMMAND_NOT_ALLOWED" };
  if (!bridge?.command) return { ok: false, error: "NO_BRIDGE" };
  try {
    const result = await bridge.command({ command, payload });
    return result && typeof result === "object" ? result : { ok: false, error: "RESPONSE_INCOMPLETE" };
  } catch {
    return { ok: false, error: "SKILL_INTERNAL" };
  }
}
function errorText(result: { error?: string; message?: string; detail?: unknown }): string {
  const code = String(result.error || "SKILL_INTERNAL");
  const detail = result.message && result.message !== code ? "：" + result.message : result.detail ? "：" + JSON.stringify(result.detail) : "";
  return skillFailureText(code, result.detail) + "（" + code + "）" + detail;
}
async function analyze() {
  const text = input.value.trim();
  if (!text || busy.value) return;
  error.value = "";
  const available = skillEntryAvailability("analyze", props.skill, props.dependencies);
  if (!available.available) { error.value = available.reason || "当前没有可用的模型分析能力"; return; }
  messages.value.push({ id: "creator-u-" + ++messageSeq.value, role: "user", text, at: Date.now() });
  input.value = "";
  busy.value = "analyze";
  const sourceName = props.skill?.name || draft.value?.name || "Skill 创建助手";
  const result = await send("skill/analyze", { markdown: creatorDocument(messages.value, draft.value?.systemPrompt || instructions.value), sourceName });
  busy.value = null;
  if (!result.ok) { error.value = errorText(result); return; }
  const parsed = analyzeResultOf(result.value && typeof result.value === "object" ? result.value : result);
  if (!parsed.skill) { error.value = "模型没有返回可编辑的工作流，请补充输入、步骤和输出要求后重试。"; return; }
  try {
    const next = creatorDraftOf(parsed.skill, props.skill?.v2, parsed.warnings);
    if (props.skill) next.id = props.skill.id;
    if (!next.id) next.id = "skill_" + Date.now().toString(36);
    draft.value = next;
    messages.value.push({ id: "creator-a-" + ++messageSeq.value, role: "assistant", text: `已生成${versionText.value}。可以修改步骤、继续补充要求，或确认保存。`, at: Date.now() });
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : "分析结果不完整";
  }
}
async function save() {
  const value = draft.value;
  if (!value || busy.value) return;
  error.value = "";
  if (!isValidSkillId(value.id)) { error.value = "ID 需以小写字母开头，只能包含小写字母、数字和下划线。"; return; }
  if (!value.name.trim()) { error.value = "名称不能为空。"; return; }
  if (!value.systemPrompt.trim()) { error.value = "执行说明不能为空。"; return; }
  const checked = canSaveAnalyzedSkill({ id: value.id, name: value.name, systemPrompt: value.systemPrompt, v2: value.v2 } as SkillRecord);
  if (!checked.ok) { error.value = checked.reason || "工作流不完整，不能保存。"; return; }
  busy.value = "save";
  const skill = JSON.parse(JSON.stringify({ id: value.id, name: value.name.trim(), description: value.description.trim(), systemPrompt: value.systemPrompt.trim(), kind: "procedure", v2: value.v2 }));
  const result = await send("skill/save", { skill });
  busy.value = null;
  if (!result.ok) { error.value = errorText(result); return; }
  emit("saved", value.id);
}
</script>

<template>
  <DsDialog class="sk-creator-dialog" :open="open" title="Skill 创建助手" @close="busy ? undefined : emit('close')">
    <div class="sk-creator" data-skill-creator>
      <header class="sk-creator-intro">
        <div><Sparkles :size="18" /><strong>把重复工作整理成可复用的 Skill</strong></div>
        <DsBadge size="sm" :tone="draft ? 'success' : 'neutral'">{{ versionText }}</DsBadge>
      </header>
      <p class="sk-creator-hint">说明什么任务会重复、需要提供什么、按什么步骤完成，以及哪些动作必须先确认。分析由真实模型完成，保存前可以修改和继续迭代。</p>
      <div v-if="messages.length" class="sk-creator-messages" aria-live="polite">
        <article v-for="message in messages" :key="message.id" :class="['sk-creator-message', message.role]">
          <small>{{ message.role === 'user' ? '你' : '分析结果' }} · {{ new Date(message.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</small>
          <p>{{ message.text }}</p>
        </article>
      </div>
      <div v-if="busy === 'analyze'" class="sk-creator-progress" role="status">正在等待模型返回结构化工作流，不会自动保存。</div>
      <p v-if="error" class="vd-msg sk-msg err" role="alert" data-skill-creator-error>{{ error }}</p>

      <section v-if="draft" class="sk-creator-draft" data-skill-creator-draft>
        <div class="sk-creator-fields">
          <label>名称<input v-model="draft.name" data-skill-creator-name /></label>
          <label>ID<input v-model="draft.id" :disabled="!!skill" data-skill-creator-id /></label>
        </div>
        <label>用途说明<input v-model="draft.description" data-skill-creator-description /></label>
        <div class="sk-creator-facts">
          <span v-if="draft.v2.triggers?.length">触发：{{ draft.v2.triggers.join('；') }}</span>
          <span v-if="draft.v2.inputs?.length">输入：{{ draft.v2.inputs.join('；') }}</span>
          <span v-if="draft.v2.output">输出：{{ draft.v2.output }}</span>
          <span v-if="draft.v2.allowedTools?.length">能力白名单：{{ draft.v2.allowedTools.join('、') }}</span>
          <span v-if="draft.v2.permissions?.sensitive?.length">敏感动作仍需确认：{{ draft.v2.permissions.sensitive.join('、') }}</span>
        </div>
        <ol class="sk-creator-steps">
          <li v-for="(step, index) in draft.v2.steps" :key="index">
            <span class="sk-creator-step-number">{{ String(index + 1).padStart(2, '0') }}</span>
            <div><input v-model="step.title" :aria-label="`步骤 ${index + 1} 标题`" /><textarea v-model="step.detail" rows="2" :aria-label="`步骤 ${index + 1} 说明`" /><small v-if="step.uses">基础能力：{{ step.uses }}</small></div>
          </li>
        </ol>
        <label>执行说明<textarea v-model="draft.systemPrompt" rows="6" data-skill-creator-prompt /></label>
        <p v-for="warning in draft.warnings" :key="warning" class="sk-creator-warning">{{ warning }}</p>
      </section>

      <form class="sk-creator-compose" @submit.prevent="analyze">
        <textarea v-model="input" rows="3" data-skill-creator-input :disabled="!!busy" :placeholder="draft ? '继续补充要修改或收窄的要求…' : '例如：把每周门店销售表整理成周报，先检查缺失字段，再输出结论、异常和下周动作；不得自行修改原表'" @keydown.meta.enter.prevent="analyze" @keydown.ctrl.enter.prevent="analyze" />
        <button class="planned-cta sk-btn" type="submit" :disabled="!!busy || !input.trim()" data-skill-creator-analyze><ArrowUp :size="14" />{{ draft ? '继续迭代' : '生成工作流' }}</button>
      </form>
      <footer class="sk-creator-footer">
        <span>{{ skill ? '保存会更新当前自建 Skill，权限不变。' : '只有点击保存后才会写入技能目录。' }}</span>
        <button class="planned-today sk-btn" :disabled="!draft || !!busy" @click="emit('close')"><Pencil :size="12" />关闭</button>
        <button class="planned-cta sk-btn" :disabled="!draft || !!busy" data-skill-creator-save @click="save"><Check :size="13" />{{ busy === 'save' ? '保存中…' : skill ? '保存新版本' : '保存 Skill' }}</button>
      </footer>
    </div>
  </DsDialog>
</template>

<style scoped>
.sk-creator { display: flex; flex-direction: column; gap: 12px; max-height: min(72vh, 680px); overflow: auto; }
.sk-creator-intro, .sk-creator-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.sk-creator-intro > div { display: flex; align-items: center; gap: 8px; }
.sk-creator-intro strong { font-weight: var(--fw-medium); }
.sk-creator-hint { margin: 0; color: var(--muted); font-size: var(--fs-secondary); line-height: var(--lh-relaxed); }
.sk-creator-messages { display: flex; flex-direction: column; gap: 8px; }
.sk-creator-message { padding: 10px 12px; border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / .045); }
.sk-creator-message.user { margin-left: 32px; background: rgb(var(--text-rgb) / .075); }
.sk-creator-message small { color: var(--muted); }
.sk-creator-message p { margin: 4px 0 0; white-space: pre-wrap; }
.sk-creator-progress { padding: 10px 12px; border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / .045); color: var(--muted); }
.sk-creator-draft { display: flex; flex-direction: column; gap: 12px; padding: 14px; border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / .035); }
.sk-creator-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.sk-creator-draft label { display: flex; flex-direction: column; gap: 5px; font-size: var(--fs-secondary); }
.sk-creator-draft input, .sk-creator-draft textarea, .sk-creator-compose textarea { padding: 8px 10px; border-radius: var(--radius-md); background: var(--field); }
.sk-creator-facts { display: flex; flex-direction: column; gap: 4px; color: var(--muted); font-size: var(--fs-micro); }
.sk-creator-steps { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
.sk-creator-steps li { display: flex; gap: 10px; }
.sk-creator-steps li > div { flex: 1; display: flex; flex-direction: column; gap: 5px; }
.sk-creator-step-number { color: var(--muted); font-size: var(--fs-micro); padding-top: 9px; }
.sk-creator-steps small { color: var(--muted); }
.sk-creator-warning { margin: 0; color: var(--warning); font-size: var(--fs-micro); }
.sk-creator-compose { display: flex; align-items: flex-end; gap: 8px; }
.sk-creator-compose textarea { flex: 1; resize: vertical; }
.sk-creator-compose button { flex: none; }
.sk-creator-footer { border-top: .5px solid var(--line); padding-top: 12px; }
.sk-creator-footer > span { flex: 1; color: var(--muted); font-size: var(--fs-micro); }
@media (max-width: 640px) { .sk-creator-fields { grid-template-columns: 1fr; } .sk-creator-compose { flex-direction: column; align-items: stretch; } }
</style>
<style>
.sk-creator-dialog .dialog { width: min(900px, calc(100vw - 40px)); }
</style>
