<script setup lang="ts">
import { computed } from "vue";

/**
 * Button 原语（对齐 src/design-system/primitives.tsx 的 Button）。
 * class / data-* / aria 与 React 版逐项一致：loading 时 aria-busy 且不可点，
 * disabled 时 disabled 与 aria-disabled 同时成立。
 */
type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";
type Status = "idle" | "loading" | "success" | "error";

const props = withDefaults(
  defineProps<{
    variant?: Variant;
    size?: Size;
    status?: Status;
    disabled?: boolean;
    type?: "button" | "submit" | "reset";
  }>(),
  { variant: "secondary", size: "md", status: "idle", type: "button" },
);
const emit = defineEmits<{ click: [event: MouseEvent] }>();
const busy = computed(() => props.status === "loading");
const off = computed(() => Boolean(props.disabled) || busy.value);
</script>

<template>
  <button
    :type="type"
    class="ds-btn"
    :class="['ds-btn--' + variant, 'ds-btn--' + size]"
    data-ds-comp="button"
    :data-ds-variant="variant"
    :data-ds-status="status"
    :disabled="off"
    :aria-disabled="off || undefined"
    :aria-busy="busy || undefined"
    @click="emit('click', $event)"
  >
    <span v-if="busy" class="ds-spinner" aria-hidden="true" />
    <span class="ds-btn__label"><slot /></span>
  </button>
</template>
