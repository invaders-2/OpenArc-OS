<script setup lang="ts">
/**
 * 文件夹图标：`src/desktop/components.tsx:469` 的 `FolderIcon` 同结构移植。
 * 几何与观感全部由既有 styles.css 的 `.rb-folder*` 规则提供（本组件不写任何样式）。
 */
withDefaults(defineProps<{ size?: number }>(), { size: 58 });
</script>

<template>
  <span class="rb-folder" :style="{ '--folder-w': size + 'px' }" aria-hidden="true">
    <span class="rb-folder-inner">
      <span class="rb-folder-tab" />
      <span class="rb-folder-paper rb-paper-1" />
      <span class="rb-folder-paper rb-paper-2" />
      <span class="rb-folder-paper rb-paper-3" />
      <span class="rb-folder-front rb-front-a" />
      <span class="rb-folder-front rb-front-b" />
    </span>
  </span>
</template>
