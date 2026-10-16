<script setup lang="ts">
import { onMounted, ref } from "vue";

/**
 * ContextMenu 原语（对齐 src/desktop/components.tsx 的 ContextMenu）。
 * 只保留挂载时按真实高度夹进视口、Esc 关闭两条硬要求（用到的菜单无子菜单）。
 * class 沿用既有 .menu-shade / .context-menu / .menu-separator。
 */
export interface MenuEntry {
  id?: string;
  label?: string;
  danger?: boolean;
  separator?: boolean;
  /** 右侧快捷键提示（只显示，不注册快捷键） */
  shortcut?: string;
  disabled?: boolean;
  /** 前置勾选（"窗口"菜单里标出当前窗口） */
  checked?: boolean;
  /** 不可点的小标题行 */
  header?: string;
}

const props = defineProps<{ x: number; y: number; items: MenuEntry[]; label?: string; extraClass?: string }>();
const emit = defineEmits<{ select: [id: string]; close: [] }>();
const panel = ref<HTMLElement | null>(null);

onMounted(() => {
  const el = panel.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const pad = 8;
  const left = Math.max(pad, Math.min(props.x, innerWidth - r.width - pad));
  const top = Math.max(pad, Math.min(props.y, innerHeight - r.height - pad));
  el.style.left = Math.round(left) + "px";
  el.style.top = Math.round(top) + "px";
  el.focus({ preventScroll: true });
});

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.stopPropagation();
    emit("close");
  }
}
</script>

<template>
  <div class="menu-shade" @pointerdown="emit('close')" @contextmenu.prevent="emit('close')" />
  <div
    ref="panel"
    class="context-menu"
    :class="extraClass"
    role="menu"
    tabindex="-1"
    :aria-label="label || '菜单'"
    :style="{ left: x + 'px', top: y + 'px' }"
    @keydown="onKey"
  >
    <template v-for="(it, i) in items" :key="it.separator ? 'sep-' + i : (it.id || i)">
      <div v-if="it.separator" class="menu-separator" role="separator" />
      <div v-else-if="it.header" class="menu-header">{{ it.header }}</div>
      <button
        v-else
        role="menuitem"
        :class="it.danger ? 'danger' : undefined"
        :disabled="it.disabled || undefined"
        @click="!it.disabled && it.id && emit('select', it.id)"
      >
        <span v-if="items.some((x) => x.checked !== undefined)" class="menu-check">{{ it.checked ? "✓" : "" }}</span>
        <span class="menu-label">{{ it.label }}</span>
        <span v-if="it.shortcut" class="menu-shortcut">{{ it.shortcut }}</span>
      </button>
    </template>
  </div>
</template>
