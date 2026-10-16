<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * React 岛（10-15）：在 Vue 壳层里原样挂载一个**既有的 React 组件**。
 *
 * 用途：AI 画布宿主（CanvasHost）与全局 AI 面板（AIPanel）这类安全边界很重的组件
 * （iframe 消息闸门、实例 token、任务桥），逐行改写成 Vue 风险大、又没有回归探针兜底；
 * 先原样复用 React 实现，行为与既有产品完全同一份代码。壳层只负责何时挂载 / 卸载与传参。
 * 根节点 display: contents，不额外产生盒子（被挂组件自己的定位类照常生效）。
 */
const props = defineProps<{ component: ComponentType<any>; props?: Record<string, unknown> }>();
const host = ref<HTMLElement | null>(null);
let root: Root | null = null;

function render() {
  root?.render(createElement(props.component, props.props ?? {}));
}
onMounted(() => {
  if (!host.value) return;
  root = createRoot(host.value);
  render();
});
watch(() => props.props, render);
onBeforeUnmount(() => {
  const r = root;
  root = null;
  // React 18+ 不允许在渲染中同步卸载：推到微任务里
  queueMicrotask(() => r?.unmount());
});
</script>

<template>
  <div ref="host" class="react-island" />
</template>
