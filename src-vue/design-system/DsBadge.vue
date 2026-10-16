<script setup lang="ts">
/**
 * Badge 原语（对齐 src/design-system/primitives.tsx 的 Badge）：
 * tone 只允许系统语义色，class / data-* 与 React 版一致。
 */
type Tone = "neutral" | "success" | "warning" | "danger";
withDefaults(defineProps<{ tone?: Tone; size?: "sm" | "md" }>(), { tone: "neutral", size: "md" });
</script>

<template>
  <span
    class="ds-badge"
    :class="['ds-badge--' + tone, 'ds-badge--' + size]"
    data-ds-comp="badge"
    :data-ds-tone="tone"
  >
    <slot />
  </span>
</template>
