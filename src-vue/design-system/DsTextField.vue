<script setup lang="ts">
import { computed, useId } from "vue";

/**
 * TextField 原语（对齐 src/design-system/primitives.tsx 的 TextField）。
 *
 * 关键契约：React 版把 ...rest 透传到 input，所以 data-* 落在 input 上而不是外层 wrapper；
 * 这里用 inheritAttrs:false + v-bind="$attrs" 保持同一落点，否则探针按 [data-mcp-field] 定位会落空。
 * class / data-ds-* / aria 与 React 版逐项一致，视觉全部来自既有 .ds-field 类。
 */
type Status = "idle" | "loading" | "success" | "error";

const props = withDefaults(
  defineProps<{
    label: string;
    modelValue?: string;
    type?: string;
    placeholder?: string;
    hint?: string;
    error?: string;
    status?: Status;
    readOnly?: boolean;
    disabled?: boolean;
    required?: boolean;
    labelHidden?: boolean;
    id?: string;
  }>(),
  { modelValue: "", type: "text", status: "idle" },
);
defineOptions({ inheritAttrs: false });
const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const auto = useId();
const inputId = computed(() => props.id ?? "ds-tf-" + auto);
const hintId = computed(() => (props.hint ? inputId.value + "-hint" : undefined));
const errId = computed(() => (props.error ? inputId.value + "-err" : undefined));
const describedBy = computed(() => [hintId.value, errId.value].filter(Boolean).join(" ") || undefined);
const invalid = computed(() => Boolean(props.error) || props.status === "error");

function onInput(event: Event) {
  emit("update:modelValue", (event.target as HTMLInputElement).value);
}
</script>

<template>
  <div
    class="ds-field"
    data-ds-comp="text-field"
    :data-ds-status="invalid ? 'error' : status"
    :data-ds-readonly="readOnly ? 'true' : undefined"
  >
    <label class="ds-field__label" :class="{ 'ds-field__label--sr': labelHidden }" :for="inputId">
      {{ label }}<span v-if="required" aria-hidden="true"> *</span>
    </label>
    <div class="ds-field__box">
      <input
        v-bind="$attrs"
        :id="inputId"
        class="ds-field__input"
        :type="type"
        :value="modelValue"
        :placeholder="placeholder"
        :readonly="readOnly"
        :disabled="disabled"
        :required="required"
        :aria-invalid="invalid || undefined"
        :aria-describedby="describedBy"
        :aria-busy="status === 'loading' || undefined"
        @input="onInput"
      />
      <span v-if="status === 'loading'" class="ds-spinner" aria-hidden="true" />
    </div>
    <p v-if="hint" class="ds-field__hint" :id="hintId">{{ hint }}</p>
    <p v-if="error" class="ds-field__error" :id="errId" role="alert">{{ error }}</p>
  </div>
</template>
