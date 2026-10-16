<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";
import { useShellStore } from "../stores/shell";

const shell = useShellStore();

/**
 * 快速查看 / 显示简介（既有产品 src/main.tsx:3705 与 3736 的两块 .quicklook，同一套 class）。
 * 内容来自 store：openPreview()（访达里空格 / 双击文件）或 showInfo()（右键「显示简介」）。
 * 点任意处、空格、Esc 关闭（Esc 由 Overlays 统一处理）。
 */
function onKey(e: KeyboardEvent) {
  if (e.key === " " && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
    e.preventDefault();
    shell.closeQuickLook();
  }
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div
    v-if="shell.info"
    class="quicklook"
    role="dialog"
    aria-modal="true"
    aria-label="显示简介"
    @click="shell.closeQuickLook()"
  >
    <div class="quicklook-card info-card" @click.stop>
      <h2 class="info-title">{{ shell.info.title }}</h2>
      <p v-if="shell.info.subtitle" class="muted">{{ shell.info.subtitle }}</p>
      <dl class="info-rows">
        <div v-for="row in shell.info.rows" :key="row.k" class="info-row">
          <dt>{{ row.k }}</dt>
          <dd>{{ row.v }}</dd>
        </div>
      </dl>
      <p class="muted">点击任意处关闭</p>
    </div>
  </div>
  <div v-else class="quicklook" role="dialog" aria-modal="true" aria-label="快速查看" @click="shell.closeQuickLook()">
    <div class="quicklook-card" @click.stop>
      <div class="quicklook-body">
        <template v-if="shell.preview">
          <img v-if="shell.preview.kind === 'image' && shell.preview.src" :src="shell.preview.src" :alt="shell.preview.name" draggable="false" />
          <video v-else-if="shell.preview.kind === 'video' && shell.preview.src" :src="shell.preview.src" controls autoplay />
          <audio v-else-if="shell.preview.kind === 'audio' && shell.preview.src" :src="shell.preview.src" controls autoplay />
          <pre v-else-if="shell.preview.kind === 'text'" class="quicklook-text">{{ shell.preview.text }}</pre>
          <p v-else-if="shell.preview.kind === 'pdf'" class="muted">PDF 预览需要后续接入只读文件协议（当前不开放 data: 框架）。</p>
          <p v-else class="muted">暂不支持预览该格式{{ shell.preview.ext ? "（." + shell.preview.ext + "）" : "" }}。</p>
        </template>
        <p v-else class="muted">在访达里选中一个文件，按空格即可快速查看。</p>
      </div>
      <div class="quicklook-name">
        {{ shell.preview?.name || "快速查看" }}
        <span class="muted">空格 / Esc 关闭</span>
      </div>
    </div>
  </div>
</template>
