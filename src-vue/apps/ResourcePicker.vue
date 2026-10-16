<script setup lang="ts">
import { onMounted, ref } from "vue";
import DsButton from "../design-system/DsButton.vue";

/**
 * D3-04D · 系统级 Resource Picker（对齐 src/governance/ResourcePicker.tsx，逐段迁移）。
 *
 * 只展示 User ∩ App ∩ 类型 ∩ 动作 的交集；上行只经 window.openarc.resource.command，
 * 授权 / 过滤全部由主进程 ResourcePickerService 决定，本组件只做展示与 UX。
 * class / data-* / DOM 结构与 React 逐项一致。
 */
type ResBridge = { command: (c: Record<string, unknown>) => Promise<any> };

const props = withDefaults(
  defineProps<{
    pickerAppId: string;
    resourceTypes?: string[];
    requestedActions?: string[];
    title?: string;
  }>(),
  { title: "选择资源" },
);
const emit = defineEmits<{ choose: [ref: string]; cancel: [] }>();

const bridge = (): ResBridge | undefined => (window as any).openarc?.resource;

const query = ref("");
const items = ref<any[]>([]);
const selected = ref<string | null>(null);
const error = ref<string | null>(null);

async function run() {
  const b = bridge();
  if (!b) {
    error.value = "NO_BRIDGE";
    return;
  }
  const res = await b.command({
    type: "resource/pickerQuery",
    pickerAppId: props.pickerAppId,
    query: query.value,
    /* 展开成普通数组：props 数组可能是响应式 Proxy，Proxy 无法结构化克隆过 IPC。 */
    resourceTypes: props.resourceTypes ? [...props.resourceTypes] : undefined,
    requestedActions: props.requestedActions ? [...props.requestedActions] : undefined,
    limit: 50,
  });
  if (res && res.ok) {
    items.value = Array.isArray(res.items) ? res.items : [];
    error.value = null;
  } else {
    error.value = String((res && res.error) || "INTERNAL_ERROR");
  }
}

onMounted(() => {
  void run();
});

async function choose() {
  if (!selected.value) return;
  const b = bridge();
  if (!b) return;
  const res = await b.command({
    type: "resource/pickerChoose",
    pickerAppId: props.pickerAppId,
    resourceRef: selected.value,
    requestedActions: props.requestedActions ? [...props.requestedActions] : undefined,
  });
  if (res && res.ok) emit("choose", res.resourceRef);
  else error.value = String((res && res.error) || "INTERNAL_ERROR");
}
</script>

<template>
  <div
    class="picker"
    role="dialog"
    aria-modal="true"
    :aria-label="title"
    data-d3-04d-picker
    :data-d3-04d-picker-app="pickerAppId"
  >
    <header class="picker-head">
      <h3>{{ title }}</h3>
      <span class="gov-meta">{{ pickerAppId }}</span>
    </header>
    <div class="picker-search">
      <input data-d3-04d-picker-query placeholder="搜索资源" v-model="query" @keydown.enter="run" />
      <DsButton variant="secondary" size="sm" data-d3-04d-picker-search @click="run">搜索</DsButton>
    </div>
    <p v-if="error" class="gov-error" data-d3-04d-picker-error>{{ error }}</p>
    <ul class="picker-list" data-d3-04d-picker-items>
      <li v-for="it in items" :key="it.resourceId">
        <button
          type="button"
          :data-d3-04d-picker-item="it.resourceId"
          :aria-pressed="selected === it.resourceId"
          :class="selected === it.resourceId ? 'is-selected' : ''"
          @click="selected = it.resourceId"
        >
          <span class="gov-name">{{ it.name }}</span>
          <span class="gov-meta">{{ it.resourceType }} · {{ it.departmentId || "personal" }}</span>
        </button>
      </li>
    </ul>
    <footer class="picker-foot">
      <DsButton variant="ghost" size="sm" data-d3-04d-picker-cancel @click="emit('cancel')">取消</DsButton>
      <DsButton variant="primary" size="sm" data-d3-04d-picker-choose :disabled="!selected" @click="choose">选择</DsButton>
    </footer>
  </div>
</template>
