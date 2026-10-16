<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ArrowRight } from "lucide-vue-next";
import AuthErrorLine from "./AuthErrorLine.vue";
import Avatar from "./Avatar.vue";
import LockClock from "./LockClock.vue";
import LockStageWallpaper, { type LockWallpaper } from "./LockStageWallpaper.vue";
import type { IdentitySnapshot } from "../../src/identity/types";

/**
 * 锁屏（对齐 src/identity/AuthScreens.tsx:432-488）。
 *
 * 它是**覆盖层**，不是页面：桌面 DOM 仍在（窗口状态得以保留，§40），但被 inert 挡住。
 * 焦点陷阱与搜索面板用同一套"首尾循环"实现，不引入第三个焦点方案。
 */
const props = defineProps<{
  snapshot: IdentitySnapshot;
  busy: boolean;
  error: { code: string; detail?: string } | null;
  wallpaper?: LockWallpaper;
}>();
const emit = defineEmits<{ unlock: [password: string]; logout: [] }>();

const password = ref("");
const panel = ref<HTMLDivElement | null>(null);
const input = ref<HTMLInputElement | null>(null);

const tone = computed(() => (props.wallpaper?.id === "theme-light" ? "dark" : "light"));

onMounted(() => input.value?.focus());

function submit() {
  const value = password.value;
  password.value = "";
  emit("unlock", value);
}

function onTab(event: KeyboardEvent) {
  if (event.key !== "Tab") return;
  const items = Array.from(panel.value?.querySelectorAll<HTMLElement>("button,input") || []);
  if (!items.length) return;
  const firstEl = items[0];
  const lastEl = items[items.length - 1];
  if (event.shiftKey && document.activeElement === firstEl) {
    event.preventDefault();
    lastEl.focus();
  } else if (!event.shiftKey && document.activeElement === lastEl) {
    event.preventDefault();
    firstEl.focus();
  }
}
</script>

<template>
  <div
    class="lock-shade lock-stage"
    data-d3-id="lock-shade"
    :data-lock-wallpaper="wallpaper?.id ?? 'same'"
    :data-lock-tone="tone"
  >
    <LockStageWallpaper :wallpaper="wallpaper" />
    <LockClock />
    <div ref="panel" class="lock-panel" role="dialog" aria-modal="true" aria-label="屏幕已锁定">
      <span class="lock-avatar" aria-hidden="true">
        <Avatar :avatar-ref="snapshot.avatarRef" :name="snapshot.displayName" />
      </span>
      <strong class="lock-name">{{ snapshot.displayName || "本地用户" }}</strong>
      <span class="lock-identifier">{{ snapshot.identifier }}</span>
      <form class="lock-form" data-d3-id="unlock-form" @submit.prevent="submit">
        <div class="lock-input lock-input--act">
          <input
            ref="input"
            v-model="password"
            type="password"
            autocomplete="current-password"
            placeholder="输入密码以解锁"
            aria-label="密码"
            data-d3-id="unlock-password"
            @keydown="onTab"
          />
          <button
            class="lock-submit"
            type="submit"
            :disabled="busy || !password"
            aria-label="解锁"
            data-d3-id="unlock-submit"
          >
            <ArrowRight :size="16" />
          </button>
        </div>
        <AuthErrorLine :error="error" />
        <button class="lock-alt" type="button" :disabled="busy" data-d3-id="lock-logout" @click="emit('logout')">
          退出登录
        </button>
      </form>
      <p class="lock-footnote">锁定不等于退出登录：会话仍然有效，但受保护的操作会被拒绝，必须重新验证密码。</p>
    </div>
  </div>
</template>
