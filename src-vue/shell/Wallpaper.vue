<script setup lang="ts">
import { computed } from "vue";
import { useShellStore } from "../stores/shell";
import { WALLPAPER_ID, WALLPAPER_STYLE, fileUrl, kindOfExt } from "../wallpapers";

/**
 * 壁纸层（既有产品 src/main.tsx:3336 的 .desktop-wallpaper）。
 * 内置"浅色 / 深色主题色"由 .desktop[data-wallpaper=…] 提供，所以这里通常是个空盒子；
 * 自定义壁纸（custom:<id>）来自真实存储（wallpapers 目录），按条目的显示方式画出来。
 */
const shell = useShellStore();

const customEntry = computed(() => {
  if (!shell.wallpaper.startsWith("custom:")) return null;
  const id = shell.wallpaper.slice("custom:".length);
  return shell.customWallpapers.find((e) => e.id === id) ?? null;
});
const src = computed(() => (customEntry.value ? fileUrl(WALLPAPER_ID, customEntry.value.id) : ""));
const isVideo = computed(() => (customEntry.value ? kindOfExt(customEntry.value.ext) === "video" : false));
const mediaStyle = computed(() => {
  const st = customEntry.value ? shell.wallpaperStyle[customEntry.value.id] ?? WALLPAPER_STYLE : WALLPAPER_STYLE;
  return { objectFit: st.fit, transform: `scale(${st.zoom}) translate(${st.x}%, ${st.y}%)` };
});
</script>

<template>
  <div class="desktop-wallpaper" aria-hidden="true">
    <video
      v-if="customEntry && isVideo"
      class="wallpaper-media"
      :src="src"
      :style="mediaStyle"
      autoplay
      muted
      loop
      playsinline
    />
    <img v-else-if="customEntry" class="wallpaper-media" :src="src" :style="mediaStyle" alt="" />
  </div>
</template>
