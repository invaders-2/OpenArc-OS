<script setup lang="ts">
import { computed, ref } from "vue";
import DsButton from "../design-system/DsButton.vue";
import { t } from "../i18n";
import {
  CAPABILITY_SHORT,
  groupRemoteModels,
  type ClassifiedRemoteModel,
  type RemoteGroupId,
  type RemoteModelItem,
} from "./modelCategories";
import { buildBulkPick, buildCuratePlan, curateRowChecked, type BulkPickAction, type CuratePicks } from "./remoteModelsLogic";

/**
 * 「拉取模型」弹窗：分段标签 全部 / 文本 / 图像 / 视频 / 搜索 / 其他，挑选后一次提交。
 * 分类与「勾选 → 增删计划」都来自纯逻辑（可离线单测），不在组件里另造能力。
 * 口径：拉取到的模型默认一个都不加入；勾选才加入，已加入的取消勾选＝移除。
 */
const props = withDefaults(
  defineProps<{
    providerId: string;
    items?: RemoteModelItem[] | null;
    picked?: Record<string, string[]>;
    dropped?: Record<string, boolean>;
    pulling?: boolean;
    filter?: string;
  }>(),
  { items: null, picked: () => ({}), dropped: () => ({}), pulling: false, filter: "" },
);

const emit = defineEmits<{
  "update:filter": [value: string];
  "toggle-pick": [item: ClassifiedRemoteModel];
  "toggle-drop": [item: ClassifiedRemoteModel];
  "add-one": [item: ClassifiedRemoteModel];
  "remove-one": [item: ClassifiedRemoteModel];
  save: [plan: { adds: { id: string; capabilities: string[] }[]; removals: string[] }];
  "set-picks": [state: { picked: Record<string, string[]>; dropped: Record<string, true> }];
}>();

type TabId = "all" | "text" | "image" | "video" | "search" | "other";
const TABS: { id: TabId; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "text", label: "文本模型" },
  { id: "image", label: "图像模型" },
  { id: "video", label: "视频模型" },
  { id: "search", label: "搜索" },
  { id: "other", label: "其他" },
];
/** 搜索类模型：模型域没有单独的「搜索」能力，按名字识别（search / sonar / online），注册时仍是文本对话能力。 */
const SEARCH_RE = /search|sonar|online|web-?browse/i;
const tab = ref<TabId>("all");
const grouping = computed(() => groupRemoteModels(props.items || [], { query: props.filter }));
const curatePicks = computed<CuratePicks>(() => ({ picked: props.picked || {}, dropped: props.dropped || {} }));
const plan = computed(() => buildCuratePlan(props.items || [], curatePicks.value));
const addCount = computed(() => plan.value.adds.length);
const removeCount = computed(() => plan.value.removals.length);
const changed = computed(() => addCount.value + removeCount.value > 0);
const planLabel = computed(() => {
  if (!changed.value) return t("拉取到的模型默认都不加入：勾选才加入，已加入的取消勾选＝移除");
  return t("将添加 {a} 个 / 将移除 {r} 个", { a: addCount.value, r: removeCount.value });
});
const saveLabel = computed(() => {
  if (addCount.value && removeCount.value) return t("保存（添加 {a} / 移除 {r}）", { a: addCount.value, r: removeCount.value });
  if (addCount.value) return t("添加 {a} 个", { a: addCount.value });
  if (removeCount.value) return t("移除 {r} 个", { r: removeCount.value });
  return t("保存");
});

/** 把纯逻辑给出的 文本/图像/视频/音频/未识别 五组映射成界面的六个分类标签。 */
const sections = computed(() => {
  const out: { id: TabId; groupId: RemoteGroupId; label: string; items: ClassifiedRemoteModel[] }[] = [];
  for (const g of grouping.value.groups) {
    if (g.id === "text") {
      const search = g.items.filter((m) => SEARCH_RE.test(m.id));
      const text = g.items.filter((m) => !SEARCH_RE.test(m.id));
      out.push({ id: "text", groupId: g.id, label: "文本模型", items: text });
      out.push({ id: "search", groupId: g.id, label: "搜索", items: search });
    } else if (g.id === "image" || g.id === "video") {
      out.push({ id: g.id, groupId: g.id, label: g.label, items: g.items });
    } else {
      const prev = out.find((x) => x.id === "other");
      if (prev) prev.items = prev.items.concat(g.items);
      else out.push({ id: "other", groupId: g.id, label: "其他", items: [...g.items] });
    }
  }
  return out;
});
function countOf(id: TabId): number {
  if (id === "all") return sections.value.reduce((n, s) => n + s.items.length, 0);
  return sections.value.filter((s) => s.id === id).reduce((n, s) => n + s.items.length, 0);
}
const shown = computed(() => sections.value.filter((s) => (tab.value === "all" ? s.items.length > 0 : s.id === tab.value)));

function onFilter(event: Event) {
  emit("update:filter", (event.target as HTMLInputElement).value);
}
/** 已加入的行勾选框含义是「保留」：取消勾选＝本次移除；未加入的行勾选＝本次加入。 */
function isChecked(m: ClassifiedRemoteModel): boolean {
  return curateRowChecked(m, curatePicks.value);
}
function onToggle(m: ClassifiedRemoteModel) {
  if (m.registered) emit("toggle-drop", m);
  else emit("toggle-pick", m);
}
function savePlan() {
  if (changed.value) emit("save", { adds: plan.value.adds.map((a) => ({ id: a.id, capabilities: [...a.capabilities] })), removals: [...plan.value.removals] });
}
/**
 * 批量勾选：一次算出新的 picked / dropped 整体交给父组件，不逐行触发勾选事件
 * （320 行时逐个点勾选框会整表重渲染，真机上会丢点击）。
 */
function bulkSection(items: ClassifiedRemoteModel[], action: BulkPickAction) {
  emit("set-picks", buildBulkPick(props.items || [], curatePicks.value, action, items.map((m) => m.id)));
}
function bulkReset() {
  emit("set-picks", buildBulkPick(props.items || [], curatePicks.value, "reset"));
}
</script>

<template>
  <div class="rrm" :data-d4-01-remote="providerId" :data-d4-01-remote-groups="providerId">
    <div class="rrm-bar">
      <div class="rrm-tabs" role="tablist">
        <button
          v-for="tb in TABS"
          :key="tb.id"
          type="button"
          role="tab"
          class="rrm-tab"
          :class="{ on: tab === tb.id }"
          :aria-selected="tab === tb.id"
          :data-d4-01-remote-tab="tb.id"
          @click="tab = tb.id"
        >{{ t(tb.label) }} <small>{{ countOf(tb.id) }}</small></button>
      </div>
      <label class="ds-search rrm-search">
        <input class="ds-search__input" type="search" :placeholder="t('筛选模型')" :aria-label="t('筛选模型')" :value="filter" @input="onFilter" />
      </label>
      <button type="button" class="mp2-link rrm-clearpick" data-d4-01-remote-clear-all :disabled="!changed" @click="bulkReset">{{ t("清空已选") }}</button>
    </div>

    <section
      v-for="sec in shown"
      :key="sec.id"
      class="rrm-group"
      :data-d4-01-remote-group="sec.groupId"
      :data-d4-01-remote-group-count="sec.id"
    >
      <h5 v-if="tab === 'all'" class="rrm-head">{{ t(sec.label) }} <small :data-d4-01-remote-group-n="sec.id">{{ sec.items.length }}</small></h5>
      <div v-if="sec.items.length" class="rrm-bulk" :data-d4-01-remote-bulk="sec.id">
        <button type="button" class="mp2-link" :data-d4-01-remote-select-section="sec.id" @click="bulkSection(sec.items, 'select')">{{ t("全选本类") }}</button>
        <button type="button" class="mp2-link" :data-d4-01-remote-clear-section="sec.id" @click="bulkSection(sec.items, 'clear')">{{ t("清空本类") }}</button>
      </div>
      <ul class="rrm-list" :data-d4-01-remote-group-list="sec.id">
        <li v-for="m in sec.items" :key="m.id" class="rrm-row" :class="{ done: m.registered, drop: m.registered && !isChecked(m) }">
          <label class="rrm-pick">
            <input
              type="checkbox"
              :data-d4-01-remote-pick="m.id"
              :checked="isChecked(m)"
              @change="onToggle(m)"
            />
            <span class="rrm-id" :title="m.id">{{ m.id }}</span>
          </label>
          <span class="rrm-caps" :data-d4-01-remote-caps="m.id">{{ m.capabilities.length ? m.capabilities.map((c) => CAPABILITY_SHORT[c] ? t(CAPABILITY_SHORT[c]) : c).join(" · ") : t("未识别能力") }}</span>
          <template v-if="m.registered">
            <span class="rrm-done" :class="{ keep: isChecked(m) }" :data-d4-01-remote-registered="m.id">{{ isChecked(m) ? t("已加入") : t("将移除") }}</span>
            <button type="button" class="mp2-link" :data-d4-01-remote-remove-item="m.id" @click.prevent="emit('remove-one', m)">{{ t("移除") }}</button>
          </template>
          <button v-else type="button" class="mp2-link" :data-d4-01-remote-add-item="m.id" @click.prevent="emit('add-one', m)">{{ t("加入") }}</button>
        </li>
        <li v-if="!sec.items.length" class="rrm-empty" :data-d4-01-remote-group-empty="sec.id">{{ t("这一类没有模型") }}</li>
      </ul>
    </section>
    <p v-if="!pulling && !(items || []).length" class="set-cap" data-d4-01-remote-hint>{{ t("服务商没有返回模型清单。") }}</p>

    <div class="rrm-foot">
      <span class="set-cap" data-d4-01-remote-plan :data-d4-01-remote-plan-add="addCount" :data-d4-01-remote-plan-remove="removeCount">{{ planLabel }}</span>
      <DsButton variant="primary" size="sm" data-d4-01-remote-register :disabled="!changed" @click="savePlan">{{ saveLabel }}</DsButton>
    </div>
  </div>
</template>

<style scoped>
.rrm { display: flex; flex-direction: column; gap: 12px; }
.rrm-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.rrm-tabs { display: inline-flex; gap: 2px; padding: 2px; border-radius: var(--radius-md); background: var(--sunken); }
.rrm-tab { height: 26px; padding: 0 12px; border: 0; border-radius: 6px; background: transparent; color: var(--muted); font-size: var(--fs-secondary); cursor: pointer; }
.rrm-tab small { font-size: var(--fs-micro); margin-left: 2px; }
.rrm-tab:hover { color: var(--text); }
.rrm-tab.on { background: rgb(var(--content-rgb) / 1); color: var(--text); font-weight: var(--fw-medium); box-shadow: 0 0.5px 2px rgb(0 0 0 / 0.12); }
.rrm-search { flex: 1; min-width: 160px; }
.rrm-clearpick { flex: none; }
.rrm-clearpick:disabled { opacity: 0.45; cursor: default; }
.rrm-bulk { display: flex; align-items: center; justify-content: flex-end; gap: 12px; padding: 0 4px; }
.rrm-group { display: flex; flex-direction: column; gap: 6px; }
.rrm-head { margin: 4px 0 0; font-size: var(--fs-caption); font-weight: var(--fw-medium); color: var(--muted); }
.rrm-head small { font-weight: var(--fw-regular); margin-left: 4px; }
.rrm-list { list-style: none; margin: 0; padding: 0; border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / 0.035); }
.rrm-row { display: flex; align-items: center; gap: 12px; min-height: 42px; padding: 0 16px; }
.rrm-row + .rrm-row { box-shadow: inset 0 0.5px 0 var(--line); }
.rrm-row.done { opacity: 0.6; }
.rrm-row.drop { opacity: 0.8; }
.rrm-pick { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; cursor: pointer; }
.rrm-pick input { margin: 0; flex: none; }
.rrm-id { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-secondary); color: var(--text); }
.rrm-caps { flex: none; font-size: var(--fs-caption); color: var(--muted); }
.rrm-done { flex: none; font-size: var(--fs-caption); color: var(--muted); }
.rrm-done.keep { color: var(--muted); }
.rrm-done:not(.keep) { color: var(--failed); }
.rrm-empty { padding: 12px 16px; font-size: var(--fs-caption); color: var(--muted); }
.rrm-foot { position: sticky; bottom: -20px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0 0; background: rgb(var(--surface-rgb) / var(--surface-alpha)); }
.rrm-foot .set-cap { margin: 0; }
</style>
