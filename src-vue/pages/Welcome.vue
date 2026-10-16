<script setup lang="ts">
import { AppWindow, Boxes, Settings } from "lucide-vue-next";

const highlights = [
  {
    icon: AppWindow,
    title: "窗口与桌面",
    body: "壳层把桌面、窗口与程序坞分开管理，焦点始终明确。",
  },
  {
    icon: Boxes,
    title: "资源与任务",
    body: "文件、技能与扩展各自成应用，按需打开，不互相打扰。",
  },
  {
    icon: Settings,
    title: "外观与设置",
    body: "浅色与深色、玻璃与实色、常规与减少动态，都在控制中心切换。",
  },
];
</script>

<template>
  <div class="welcome">
    <p class="eyebrow">OpenArc OS</p>
    <h1 class="title">欢迎使用 OpenArc OS</h1>
    <p class="lede">
      一个以窗口、文件与任务为中心的中性色桌面系统。界面正在重新搭建，这一屏是全新壳层的起点。
    </p>

    <ul class="cards">
      <li v-for="item in highlights" :key="item.title" class="card">
        <span class="card-icon"><component :is="item.icon" /></span>
        <h2 class="card-title">{{ item.title }}</h2>
        <p class="card-body">{{ item.body }}</p>
      </li>
    </ul>

    <p class="note">当前为第一阶段：只有本地界面状态，尚未接入系统能力。</p>
  </div>
</template>

<style scoped>
.welcome {
  padding: var(--space-8);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.eyebrow {
  margin: 0;
  font-size: var(--fs-eyebrow);
  font-weight: var(--fw-medium);
  letter-spacing: var(--tracking-wide);
  text-transform: uppercase;
  color: var(--muted);
}

.title {
  margin: 0;
  font-size: var(--fs-display);
  font-weight: var(--fw-medium);
  line-height: var(--lh-tight);
  letter-spacing: var(--tracking-tight);
  color: var(--text);
}

.lede {
  margin: 0;
  max-width: 46ch;
  font-size: var(--fs-body);
  line-height: var(--lh-relaxed);
  color: var(--muted);
}

.cards {
  margin: var(--space-2) 0 0;
  padding: 0;
  list-style: none;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--space-3);
}

.card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  border-radius: var(--radius-lg);
  background: var(--sunken);
  box-shadow: var(--elevation-1);
}

.card-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--shell-control-tile);
  height: var(--shell-control-tile);
  border-radius: var(--radius-md);
  background: rgb(var(--pill-rgb) / var(--pill-alpha));
  color: var(--text);
}

.card-icon :deep(svg) {
  width: var(--shell-icon);
  height: var(--shell-icon);
}

.card-title {
  margin: 0;
  font-size: var(--fs-heading);
  color: var(--text);
}

.card-body {
  margin: 0;
  font-size: var(--fs-caption);
  line-height: var(--lh-normal);
  color: var(--muted);
}

.note {
  margin: var(--space-2) 0 0;
  font-size: var(--fs-micro);
  color: var(--placeholder);
}
</style>
