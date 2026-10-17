<script setup lang="ts">
import { computed, ref } from "vue";
import DsButton from "../design-system/DsButton.vue";
import { t } from "../i18n";
import {
  CAPABILITY_SHORT,
  REMOTE_CLASSIFY_NOTE,
  groupRemoteModels,
  type ClassifiedRemoteModel,
  type RemoteGroupId,
  type RemoteModelItem,
} from "./modelCategories";

/**
 * 「拉取模型」结果按四类分组展示：文本 / 图像 / 视频 / 音频 + 未识别。
 * 分类只来自纯逻辑 ./modelCategories（可离线单测），不在组件里另造能力。
 */
const props = withDefaults(
  defineProps<{
    providerId: string;
    items?: RemoteModelItem[] | null;
    picked?: Record<string, string[]>;
    pulling?: boolean;
    filter?: string;
  }>(),
  { items: null, picked: () => ({}), pulling: false, filter: "" },
);

const emit = defineEmits<{
  "update:filter": [value: string];
  "toggle-pick": [item: ClassifiedRemoteModel];
  "add-one": [item: ClassifiedRemoteModel];
  register: [entries: { id: string; capabilities: string[] }[]];
}>();

const collapsed = ref<Partial<Record<RemoteGroupId, boolean>>>({});
const grouping = computed(() => groupRemoteModels(props.items || [], { query: props.filter }));
const pickedCount = computed(() => Object.keys(props.picked || {}).length);

function toggleGroup(id: RemoteGroupId) {
  collapsed.value = { ...collapsed.value, [id]: !collapsed.value[id] };
}
function onFilter(event: Event) {
  emit("update:filter", (event.target as HTMLInputElement).value);
}
function isPicked(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(props.picked || {}, id);
}
function registerPicked() {
  const entries = Object.entries(props.picked || {}).map(([id, capabilities]) => ({ id, capabilities: [...capabilities] }));
  if (entries.length) emit("register", entries);
}
</script>

<template>
  <div class="d401-remote rrm" :data-d4-01-remote="providerId" :data-d4-01-remote-groups="providerId">
    <div class="d401-remote-head">
      <label class="ds-search d401-remote-search">
        <input
          class="ds-search__input"
          type="search"
          :placeholder="t('筛选模型')"
          :aria-label="t('筛选模型')"
          :value="filter"
          @input="onFilter"
        />
      </label>
      <span class="set-val">{{ grouping.total }} / {{ (items || []).length }}</span>
      <DsButton variant="primary" size="sm" data-d4-01-remote-register :disabled="!pickedCount" @click="registerPicked">
        {{ t("注册所选") }}{{ pickedCount ? " (" + pickedCount + ")" : "" }}
      </DsButton>
    </div>
    <p class="rrm-lead set-cap" data-d4-01-remote-classify-note>{{ t(REMOTE_CLASSIFY_NOTE) }}</p>
    <section
      v-for="g in grouping.groups"
      :key="g.id"
      class="rrm-group"
      :data-d4-01-remote-group="g.id"
      :data-d4-01-remote-group-count="g.id"
    >
      <button type="button" class="rrm-head" :data-d4-01-remote-group-toggle="g.id" :aria-expanded="!collapsed[g.id]" @click="toggleGroup(g.id)">
        <b>{{ t(g.label) }}</b>
        <span class="badge rrm-count" :data-d4-01-remote-group-n="g.id">{{ g.items.length }}</span>
        <small>{{ collapsed[g.id] ? t("展开") : t("收起") }}</small>
      </button>
      <p class="rrm-note set-cap" :data-d4-01-remote-group-note="g.id">{{ t(g.note) }}</p>
      <ul v-show="!collapsed[g.id]" class="d401-remote-list" :data-d4-01-remote-group-list="g.id">
        <li v-for="m in g.items" :key="m.id">
          <label :class="{ done: m.registered }">
            <input
              type="checkbox"
              :disabled="m.registered"
              :data-d4-01-remote-pick="m.id"
              :checked="m.registered || isPicked(m.id)"
              @change="emit('toggle-pick', m)"
            />
            <span class="mono d401-remote-id" :title="m.id">{{ m.id }}</span>
            <span v-if="m.registered" class="badge" :data-d4-01-remote-registered="m.id">{{ t("已加入") }}</span>
            <span class="d401-remote-caps" :data-d4-01-remote-caps="m.id">{{ m.capabilities.length ? m.capabilities.map((c) => CAPABILITY_SHORT[c] ? t(CAPABILITY_SHORT[c]) : c).join(" · ") : t("未推断出能力") }}</span>
            <button
              v-if="!m.registered"
              type="button"
              class="mp2-link"
              :data-d4-01-remote-add-item="m.id"
              @click.prevent="emit('add-one', m)"
            >
              {{ t("加入") }}
            </button>
          </label>
        </li>
        <li v-if="!g.items.length" class="set-cap" :data-d4-01-remote-group-empty="g.id">{{ t(g.emptyText) }}</li>
      </ul>
    </section>
    <p v-if="!pulling && !(items || []).length" class="set-cap" data-d4-01-remote-hint>{{ t("上游清单是空的：先点上面的「拉取模型」。") }}</p>
  </div>
</template>

<style scoped>
.rrm { display: flex; flex-direction: column; gap: 8px; }
.rrm-lead { margin: 0; }
.rrm-group { display: flex; flex-direction: column; gap: 2px; }
.rrm-head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 4px 0; background: transparent; color: var(--text); text-align: left; border-bottom: 1px solid var(--line); }
.rrm-head b { font-size: var(--fs-secondary); font-weight: var(--fw-medium); }
.rrm-head small { color: var(--muted); font-size: var(--fs-micro); }
.rrm-count { flex: none; }
.rrm-note { margin: 0; }
</style>
