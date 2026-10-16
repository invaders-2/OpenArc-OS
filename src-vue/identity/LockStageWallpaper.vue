<script setup lang="ts">
import type { CSSProperties } from "vue";

/**
 * 锁屏/登录壁纸层（对齐 src/identity/AuthScreens.tsx:76-94）。
 * 清晰显示、不磨砂；文字可读性交给 .lock-stage::before 的 scrim。
 */
export type LockWallpaper = {
  id: string;
  src?: string;
  kind?: "image" | "video";
  style?: CSSProperties;
} | null;

defineProps<{ wallpaper?: LockWallpaper }>();
</script>

<template>
  <div class="lock-wallpaper" aria-hidden="true">
    <video
      v-if="wallpaper?.src && wallpaper.kind === 'video'"
      class="wallpaper-media"
      :src="wallpaper.src"
      :style="wallpaper.style"
      autoplay
      muted
      loop
      playsinline
    />
    <img v-else-if="wallpaper?.src" class="wallpaper-media" :src="wallpaper.src" :style="wallpaper.style" alt="" />
  </div>
</template>
