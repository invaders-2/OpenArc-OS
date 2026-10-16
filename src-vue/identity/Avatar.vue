<script setup lang="ts">
import { computed } from "vue";

/**
 * 头像（对齐 src/identity/Avatar.tsx）。
 * 三种形态判定顺序与主进程一致：data: → 位图；preset:<白名单 id> → 内联单色图形；其余 → 显示名首字母。
 * 外层 `.avatar` 只负责填满调用方并居中，不设背景、不设固定尺寸。
 */
const AVATAR_PRESET_IDS = ["arc", "orbit", "wave", "grid", "sun", "moon"] as const;

const props = defineProps<{ avatarRef: string | null; name: string | null }>();

const preset = computed(() => {
  const ref = props.avatarRef ?? "";
  if (!ref.startsWith("preset:")) return "";
  const id = ref.slice("preset:".length);
  return (AVATAR_PRESET_IDS as readonly string[]).includes(id) ? id : "";
});

const initial = computed(() => (props.name ?? "").trim().slice(0, 1).toUpperCase() || "?");
</script>

<template>
  <span class="avatar">
    <img
      v-if="avatarRef && avatarRef.startsWith('data:')"
      class="avatar-img"
      :src="avatarRef"
      alt=""
      draggable="false"
    />
    <svg v-else-if="preset" class="avatar-preset" viewBox="0 0 24 24" aria-hidden="true">
      <path
        v-if="preset === 'arc'"
        d="M4.5 16.5a7.5 7.5 0 0 1 15 0"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
      />
      <template v-else-if="preset === 'orbit'">
        <circle cx="12" cy="12" r="3.1" fill="currentColor" />
        <ellipse
          cx="12"
          cy="12"
          rx="9"
          ry="4.4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          transform="rotate(-28 12 12)"
        />
      </template>
      <path
        v-else-if="preset === 'wave'"
        d="M3 13.5c2.4 0 2.4-4.5 4.8-4.5s2.4 4.5 4.8 4.5 2.4-4.5 4.8-4.5 2.4 4.5 4.8 4.5"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <template v-else-if="preset === 'grid'">
        <rect x="4.4" y="4.4" width="6.4" height="6.4" rx="1.6" fill="currentColor" />
        <rect x="13.2" y="4.4" width="6.4" height="6.4" rx="1.6" fill="currentColor" opacity="0.55" />
        <rect x="4.4" y="13.2" width="6.4" height="6.4" rx="1.6" fill="currentColor" opacity="0.55" />
        <rect x="13.2" y="13.2" width="6.4" height="6.4" rx="1.6" fill="currentColor" />
      </template>
      <template v-else-if="preset === 'sun'">
        <circle cx="12" cy="12" r="4.2" fill="currentColor" />
        <circle
          cx="12"
          cy="12"
          r="8"
          fill="none"
          stroke="currentColor"
          stroke-width="1.9"
          stroke-linecap="round"
          stroke-dasharray="1.5 4.7"
        />
      </template>
      <path
        v-else-if="preset === 'moon'"
        d="M20.2 14.6A8.6 8.6 0 0 1 9.4 3.8a8.6 8.6 0 1 0 10.8 10.8Z"
        fill="currentColor"
      />
    </svg>
    <template v-else>{{ initial }}</template>
  </span>
</template>
