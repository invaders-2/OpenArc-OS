<script setup lang="ts">
import { t } from "../i18n";
/** 启动态（对齐 src/identity/AuthScreens.tsx:140-150）：恢复结果出来之前不画任何桌面内容。 */
</script>

<template>
  <div class="auth-screen" data-d3-id="boot-surface" aria-busy="true">
    <div class="auth-boot">
      <span class="brand-mark" role="img" aria-label="OpenArc" />
      <span class="muted">{{ t("正在确认本机身份…") }}</span>
    </div>
  </div>
</template>
