<script setup lang="ts">
import { computed } from "vue";
import { hueOf, iconOf } from "./web";

/** 网站图标：取到 favicon 就显示，取不到用域名首字母（底色按域名固定）。 */
const props = withDefaults(defineProps<{ host: string; size?: number }>(), { size: 16 });
const src = computed(() => iconOf(props.host));
</script>

<template>
  <span class="site-ic" :style="{ width: size + 'px', height: size + 'px', '--h': hueOf(host) }" aria-hidden="true">
    <img v-if="src" :src="src" alt="" />
    <span v-else class="site-ic-letter" :style="{ fontSize: Math.round(size * 0.58) + 'px' }">{{ (host || "?")[0].toUpperCase() }}</span>
  </span>
</template>

<style scoped>
.site-ic { display: inline-flex; flex: none; align-items: center; justify-content: center; overflow: hidden; border-radius: 50%; background: var(--surface, #fff); box-shadow: 0 0 0 1px rgb(var(--text-rgb) / 0.1); }
.site-ic img { width: 100%; height: 100%; object-fit: contain; }
.site-ic-letter { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; background: hsl(var(--h) 45% 46%); color: #fff; font-weight: 600; line-height: 1; }
</style>
