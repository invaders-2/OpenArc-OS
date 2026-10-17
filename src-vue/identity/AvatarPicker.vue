<script setup lang="ts">
import { ref } from "vue";
import { t } from "../i18n";
import Avatar from "./Avatar.vue";

/**
 * 头像选择器（对齐 src/identity/AvatarPicker.tsx）。
 * 受控组件：只把选中的 avatarRef 交回调用方，自己不持有"当前头像"。
 * 内置 6 个预设 + 从本机选图（居中裁 256×256、导 JPEG data URL）。
 */
const AVATAR_PRESET_IDS = ["arc", "orbit", "wave", "grid", "sun", "moon"] as const;
const AVATAR_SIZE = 256;
const JPEG_QUALITY = 0.85;
/** 与主进程 identity-domain.cjs 的 MAX_AVATAR_REF_LENGTH 同一个上限。 */
const MAX_AVATAR_REF_LENGTH = 400000;

const props = defineProps<{
  avatarRef: string | null;
  disabled?: boolean;
  idPrefix?: string;
}>();
const emit = defineEmits<{ change: [avatarRef: string] }>();

const localError = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

function fileToAvatarDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        if (!img.naturalWidth || !img.naturalHeight) throw new Error("empty-image");
        const canvas = document.createElement("canvas");
        canvas.width = AVATAR_SIZE;
        canvas.height = AVATAR_SIZE;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no-2d-context");
        const scale = Math.max(AVATAR_SIZE / img.naturalWidth, AVATAR_SIZE / img.naturalHeight);
        const w = img.naturalWidth * scale;
        const h = img.naturalHeight * scale;
        ctx.drawImage(img, (AVATAR_SIZE - w) / 2, (AVATAR_SIZE - h) / 2, w, h);
        resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("decode-failed"));
    };
    img.src = url;
  });
}

async function pickFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  localError.value = null;
  if (!file.type.startsWith("image/")) {
    localError.value = t("请选择图片文件（PNG / JPEG / WebP）。");
    return;
  }
  try {
    const dataUrl = await fileToAvatarDataUrl(file);
    if (dataUrl.length > MAX_AVATAR_REF_LENGTH) {
      localError.value = t("图片处理后仍然过大，换一张更小的试试。");
      return;
    }
    emit("change", dataUrl);
  } catch {
    localError.value = t("这张图片读取失败，换一张试试。");
  }
}
</script>

<template>
  <div class="profile-presets" role="group" :aria-label="t('预设头像')">
    <button
      v-for="id in AVATAR_PRESET_IDS"
      :key="id"
      type="button"
      class="profile-preset"
      :aria-pressed="avatarRef === 'preset:' + id"
      :aria-label="t('预设头像 {id}', { id })"
      :disabled="disabled"
      :data-d3-id="(idPrefix ?? 'avatar') + '-' + id"
      @click="localError = null; emit('change', 'preset:' + id)"
    >
      <Avatar :avatar-ref="'preset:' + id" :name="null" />
    </button>
  </div>
  <button type="button" class="profile-upload" :disabled="disabled" @click="fileInput?.click()">
    {{ t("从本机选择图片…") }}
  </button>
  <input
    ref="fileInput"
    type="file"
    accept="image/*"
    hidden
    :data-d3-id="(idPrefix ?? 'avatar') + '-file'"
    @change="pickFile"
  />
  <p v-if="localError" class="auth-error" role="alert">{{ localError }}</p>
</template>
