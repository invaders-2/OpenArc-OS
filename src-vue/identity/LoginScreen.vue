<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ArrowRight } from "lucide-vue-next";
import AuthErrorLine from "./AuthErrorLine.vue";
import LockClock from "./LockClock.vue";
import LockStageWallpaper, { type LockWallpaper } from "./LockStageWallpaper.vue";

/**
 * 登录页（对齐 src/identity/AuthScreens.tsx:364-410）。
 * 登录页没有 session：头像位放品牌 mark，不硬塞一个字母占位圆。
 */
const props = defineProps<{
  busy: boolean;
  error: { code: string; detail?: string } | null;
  defaultIdentifier?: string;
  wallpaper?: LockWallpaper;
}>();
const emit = defineEmits<{ submit: [input: { identifier: string; password: string }] }>();

const identifier = ref(props.defaultIdentifier ?? "");
const password = ref("");
const first = ref<HTMLInputElement | null>(null);

/** 主题色壁纸明暗已知；本阶段没有自定义图片壁纸，因此不做画布采样。 */
const tone = computed(() => (props.wallpaper?.id === "theme-light" ? "dark" : "light"));

onMounted(() => first.value?.focus());

function submit() {
  emit("submit", { identifier: identifier.value, password: password.value });
}
</script>

<template>
  <div
    class="auth-screen lock-stage"
    data-d3-id="auth-screen"
    :data-lock-wallpaper="wallpaper?.id ?? 'same'"
    :data-lock-tone="tone"
  >
    <LockStageWallpaper :wallpaper="wallpaper" />
    <LockClock />
    <div class="lock-panel" role="main">
      <span class="lock-avatar" aria-hidden="true">
        <span class="brand-mark" />
      </span>
      <strong class="lock-name">OpenArc</strong>
      <span class="lock-identifier">使用初始化时创建的管理员凭据</span>
      <form class="lock-form" data-d3-id="login-form" @submit.prevent="submit">
        <div class="lock-input">
          <input
            ref="first"
            v-model="identifier"
            placeholder="账号"
            aria-label="账号"
            autocomplete="username"
            data-d3-id="login-identifier"
          />
        </div>
        <div class="lock-input lock-input--act">
          <input
            v-model="password"
            type="password"
            placeholder="密码"
            aria-label="密码"
            autocomplete="current-password"
            data-d3-id="login-password"
          />
          <button
            class="lock-submit"
            type="submit"
            :disabled="busy || !identifier || !password"
            aria-label="登录"
            data-d3-id="login-submit"
          >
            <ArrowRight :size="16" />
          </button>
        </div>
        <AuthErrorLine :error="error" />
      </form>
      <p class="lock-footnote">账号不存在与密码错误返回同一个错误，不透露账号是否存在。</p>
    </div>
  </div>
</template>
