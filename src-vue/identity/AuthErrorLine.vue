<script setup lang="ts">
import { computed } from "vue";
import { t } from "../i18n";
import { errorText } from "../../src/identity/types";

/**
 * 错误行（对齐 src/identity/AuthScreens.tsx:96-103 的 AuthErrorLine）。
 * 文案只从 code 出：errorText 里 detail 必须命中白名单才会出现，表外的一律丢弃。
 */
const props = defineProps<{ error: { code: string; detail?: string } | null }>();
const text = computed(() => (props.error ? errorText(props.error.code, props.error.detail) : ""));
</script>

<template>
  <p v-if="error" class="auth-error" role="alert" data-d3-id="auth-error">{{ t(text) }}</p>
</template>
