<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { X } from "lucide-vue-next";

/**
 * Dialog 原语（对齐 src/desktop/Dialog.tsx）：
 * Esc 关闭（捕获阶段，抢在背景前面）+ 焦点陷阱 + 关闭后焦点返回打开它的元素。
 * class 名沿用既有 .dialog-shade / .dialog / .dialog-heading / .dialog-body / .dialog-footer。
 */
const props = defineProps<{ open: boolean; title: string; ariaLabel?: string }>();
const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLElement | null>(null);
let returnTo: HTMLElement | null = null;

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function focusables(): HTMLElement[] {
  return Array.from(panel.value?.querySelectorAll<HTMLElement>(FOCUSABLE) || []);
}

/* 多个弹窗叠在一起时（详情里再开「拉取模型」）只让最上面那个响应 Esc / Tab */
const STACK_KEY = "__oaDsDialogStack";
const token = Symbol("ds-dialog");
function stack(): symbol[] {
  const w = window as unknown as Record<string, symbol[]>;
  return (w[STACK_KEY] ||= []);
}
function isTop(): boolean {
  const s = stack();
  return s[s.length - 1] === token;
}

function onKey(e: KeyboardEvent) {
  if (!isTop()) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    emit("close");
    return;
  }
  if (e.key !== "Tab") return;
  const nodes = focusables();
  if (!nodes.length) {
    e.preventDefault();
    return;
  }
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const at = document.activeElement as HTMLElement | null;
  if (!at || !nodes.includes(at)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
    return;
  }
  if (e.shiftKey && at === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && at === last) {
    e.preventDefault();
    first.focus();
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      returnTo = document.activeElement as HTMLElement;
      stack().push(token);
      document.addEventListener("keydown", onKey, true);
      // 先聚焦第一个输入框；没有输入框就聚焦面板本身——不把焦点（和焦点环）放到关闭按钮上（设计语言 §3.4）
      requestAnimationFrame(() => {
        const field = panel.value?.querySelector<HTMLElement>(
          ".dialog-body input:not([disabled]):not([type=hidden]),.dialog-body textarea:not([disabled])",
        );
        (field || panel.value)?.focus({ preventScroll: true });
      });
    } else {
      document.removeEventListener("keydown", onKey, true);
      const s = stack();
      const at = s.indexOf(token);
      if (at >= 0) s.splice(at, 1);
      if (returnTo && document.contains(returnTo)) returnTo.focus();
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKey, true);
  const s = stack();
  const at = s.indexOf(token);
  if (at >= 0) s.splice(at, 1);
});
</script>

<template>
  <div v-if="open" class="dialog-shade" @pointerdown.self="emit('close')">
    <div ref="panel" class="dialog" role="dialog" tabindex="-1" aria-modal="true" :aria-label="ariaLabel || title">
      <div class="dialog-heading">
        <strong>{{ title }}</strong>
        <button :aria-label="'关闭' + title" @click="emit('close')"><X :size="17" /></button>
      </div>
      <div class="dialog-body"><slot /></div>
      <div v-if="$slots.footer" class="dialog-footer"><slot name="footer" /></div>
    </div>
  </div>
</template>
