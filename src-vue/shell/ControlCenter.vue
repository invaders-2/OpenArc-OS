<script setup lang="ts">
import { computed } from "vue";
import { Activity, BellOff, Lock, LogOut, Monitor } from "lucide-vue-next";
import { useShellStore } from "../stores/shell";
import { useIdentityStore } from "../stores/identity";
import { t } from "../i18n";

const shell = useShellStore();
const identity = useIdentityStore();
const locked = computed(() => identity.phase === "locked");

/**
 * 控制中心（10-15 按界面原型升级为 macOS 控制中心的"磁贴"布局）：
 *   第一行两枚开关磁贴：专注模式（通知静音）/ 减少动态效果
 *   下面两块宽磁贴：外观（跟随系统/浅色/深色）、窗口材质（完整玻璃/降低材质/实色）
 *   底部：cc-status（本机 · D1）与 cc-actions（锁定 / 退出登录，接身份命令）
 * 0.6.1：文案经 i18n t()（zh-CN 为源语言，en-US 词典见 src-vue/i18n/en-US.ts）。
 */
</script>

<template>
  <div class="cc-shade" @click="shell.closeControlCenter()" />
  <div class="control-center" role="dialog" aria-modal="true" :aria-label="t('控制中心')">
    <div class="cc-toggles">
      <button
        type="button"
        role="switch"
        class="cc-toggle"
        :class="{ on: shell.focusMode }"
        :aria-checked="shell.focusMode"
        :aria-label="t('专注模式')"
        @click="shell.setFocusMode(!shell.focusMode)"
      >
        <span class="cc-toggle-icon"><BellOff :size="15" /></span>
        <span class="cc-toggle-text">
          <b>{{ t("专注模式") }}</b>
          <small>{{ shell.focusMode ? t("通知静音") : t("已关闭") }}</small>
        </span>
      </button>
      <button
        type="button"
        role="switch"
        class="cc-toggle"
        :class="{ on: shell.reduced }"
        :aria-checked="shell.reduced"
        :aria-label="t('减少动态效果')"
        @click="shell.setReduced(!shell.reduced)"
      >
        <span class="cc-toggle-icon"><Activity :size="15" /></span>
        <span class="cc-toggle-text">
          <b>{{ t("减少动态") }}</b>
          <small>{{ shell.reduced ? t("已开启") : t("已关闭") }}</small>
        </span>
      </button>
    </div>

    <div class="cc-tile">
      <b>{{ t("外观") }}</b>
      <div class="segmented text" role="group" :aria-label="t('外观')">
        <button :aria-pressed="shell.theme === 'system'" @click="shell.setTheme('system')">{{ t("跟随系统") }}</button>
        <button :aria-pressed="shell.theme === 'light'" @click="shell.setTheme('light')">{{ t("浅色") }}</button>
        <button :aria-pressed="shell.theme === 'dark'" @click="shell.setTheme('dark')">{{ t("深色") }}</button>
      </div>
    </div>

    <div class="cc-tile">
      <b>{{ t("窗口材质") }}</b>
      <div class="segmented text" role="group" :aria-label="t('材质')">
        <button :aria-pressed="shell.glass === 'full'" @click="shell.setGlass('full')">{{ t("完整玻璃") }}</button>
        <button :aria-pressed="shell.glass === 'reduced'" @click="shell.setGlass('reduced')">{{ t("降低材质") }}</button>
        <button :aria-pressed="shell.glass === 'solid'" @click="shell.setGlass('solid')">{{ t("实色") }}</button>
      </div>
    </div>

    <div class="cc-status"><Monitor :size="13" /> {{ t("本机 · D1") }}</div>

    <div v-if="identity.available" class="cc-actions">
      <button :disabled="locked" @click="identity.lock()"><Lock :size="13" /> {{ t("锁定") }}</button>
      <button @click="identity.logout()">
        <LogOut :size="13" /> {{ identity.snapshot.displayName || t("退出登录") }}
      </button>
    </div>
  </div>
</template>
