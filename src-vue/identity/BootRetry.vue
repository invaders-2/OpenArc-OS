<script setup lang="ts">
import { t } from "../i18n";
/** 启动超时兜底（对齐 src/identity/AuthScreens.tsx:156-169）：绝不让界面空白。 */
defineProps<{ message: string }>();
const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <div class="auth-screen" data-d3-id="boot-retry">
    <div class="auth-boot">
      <span class="brand-mark" role="img" aria-label="OpenArc" />
      <span class="muted">{{ t(message) }}</span>
      <button class="control-button" @click="emit('retry')">{{ t("重试") }}</button>
    </div>
  </div>
</template>
