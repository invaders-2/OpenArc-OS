<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { locale } from "../i18n";

/** 锁屏/登录页的时钟（对齐 src/identity/AuthScreens.tsx:105-120 的 LockClock）。 */
const now = ref(new Date());
let timer: number | null = null;

onMounted(() => {
  timer = window.setInterval(() => (now.value = new Date()), 1000);
});
onBeforeUnmount(() => {
  if (timer !== null) window.clearInterval(timer);
});
</script>

<template>
  <div class="lock-clock" aria-hidden="true">
    <div class="lock-date">
      {{ now.toLocaleDateString(locale, { month: "long", day: "numeric" }) }}
      {{ now.toLocaleDateString(locale, { weekday: "long" }) }}
    </div>
    <div class="lock-time">
      {{ now.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false }) }}
    </div>
  </div>
</template>
