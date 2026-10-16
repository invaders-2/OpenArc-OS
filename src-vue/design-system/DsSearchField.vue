<script setup lang="ts">
import { Search } from "lucide-vue-next";
/**
 * SearchField 原语（对齐 src/design-system/primitives.tsx 的 SearchField）。
 * `type="search"` + 内建清除键；Esc 只清除内容并不吞事件（外层面板仍能关自己）。
 * 视觉全部来自既有 .ds-search / .ds-iconbtn 类，不新增一套。
 */
const props = withDefaults(
  defineProps<{
    value: string;
    placeholder?: string;
    /** 屏幕阅读器用的名称（与产品搜索框一致，视觉上不渲染 label） */
    label?: string;
    kbd?: string;
  }>(),
  { placeholder: "搜索", label: "搜索" },
);
const emit = defineEmits<{ "update:value": [value: string]; clear: [] }>();

function onInput(event: Event) {
  emit("update:value", (event.target as HTMLInputElement).value);
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && props.value) {
    event.stopPropagation();
    emit("update:value", "");
    emit("clear");
  }
}
function clear() {
  emit("update:value", "");
  emit("clear");
}
</script>

<template>
  <div class="ds-search" data-ds-comp="search-field">
    <Search class="ds-search__icon" :size="13" aria-hidden="true" />
    <input
      type="search"
      class="ds-search__input"
      :value="props.value"
      :placeholder="props.placeholder"
      :aria-label="props.label"
      @input="onInput"
      @keydown="onKeydown"
    />
    <button
      v-if="props.value"
      type="button"
      class="ds-iconbtn ds-iconbtn--ghost ds-iconbtn--sm"
      data-ds-comp="icon-button"
      data-ds-variant="ghost"
      data-ds-status="idle"
      aria-label="清除搜索"
      @click="clear"
    >
      ×
    </button>
    <kbd v-else-if="props.kbd" class="ds-kbd">{{ props.kbd }}</kbd>
  </div>
</template>
