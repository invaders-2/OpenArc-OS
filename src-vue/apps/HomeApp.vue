<script setup lang="ts">
import { ref } from "vue";
import { Clock, LayoutGrid, Wand2 } from "lucide-vue-next";
import { APPS, appById, iconUrl } from "../apps";
import { useShellStore } from "../stores/shell";

/**
 * 应用中心（10-15 迁到新壳层，对齐 src/main.tsx 里 appId === "home" 的分栏页）：
 *   全部应用：应用卡片网格（回收站有内容时显示满桶）
 *   最近使用：当前打开的窗口，点一下切过去
 *   专业应用：本机专业软件（Adobe 等）的检测与启动尚未接入 —— 如实显示空态，不放假的已安装版本
 */
const shell = useShellStore();
const tab = ref<"all" | "recent" | "pro">("all");

const DESC: Record<string, string> = {
  browser: "真实网页 · 隔离运行",
  settings: "外观与全局模型",
  files: "本地文件 · 真实存储",
  trash: "已删除的文件 · 可恢复",
  "resource-library": "素材与产物 · 统一管理",
  "mcp-center": "连接外部工具与服务",
  skills: "可复用的工作流程",
  projects: "项目与成员",
  organization: "组织治理、部门与权限",
  canvas: "无限画布 · AI 创作",
  chat: "与助理对话 · 交代任务",
  automation: "定时让助理完成任务",
  market: "本机应用目录 · 程序坞管理",
  calendar: "月视图 · 本机日程",
  notes: "Markdown 文稿 · 自动保存",
  photos: "访达里的图片",
  music: "播放访达里的音频",
  weather: "实时天气 · 7 日预报",
  video: "拼接裁剪 · FFmpeg 导出",
  dev: "运行环境 · 窗口 · 日志",
  declare: "AI 图片来源声明",
};
const cardIcon = (id: string, icon: string) => iconUrl(id === "trash" && shell.trashFull ? "trash-full" : icon);
</script>

<template>
  <div class="split">
    <nav class="split-side" aria-label="应用分类">
      <div class="split-section">应用</div>
      <button type="button" class="split-nav" :aria-current="tab === 'all' ? 'true' : undefined" @click="tab = 'all'">
        <LayoutGrid :size="16" /> 全部应用
      </button>
      <button type="button" class="split-nav" :aria-current="tab === 'recent' ? 'true' : undefined" @click="tab = 'recent'">
        <Clock :size="16" /> 最近使用
      </button>
      <div class="split-section">专业</div>
      <button type="button" class="split-nav" :aria-current="tab === 'pro' ? 'true' : undefined" @click="tab = 'pro'">
        <Wand2 :size="16" /> 专业应用
      </button>
    </nav>
    <div class="split-main">
      <template v-if="tab === 'all'">
        <h1>应用中心</h1>
        <p class="subtitle">一个桌面，连接你的应用、创意与 AI。</p>
        <div class="app-grid">
          <button
            v-for="a in APPS.filter((x) => x.id !== 'home')"
            :key="a.id"
            class="app-card"
            :data-app-card="a.id"
            @click="shell.activateApp(a.id)"
          >
            <img class="app-icon" :src="cardIcon(a.id, a.icon)" alt="" draggable="false" />
            <strong>{{ a.name }}</strong>
            <small>{{ DESC[a.id] || "" }}</small>
          </button>
        </div>
      </template>
      <template v-else-if="tab === 'recent'">
        <h1>最近使用</h1>
        <p class="subtitle">当前打开的窗口。</p>
        <p v-if="!shell.windows.length" class="muted">还没有打开任何应用窗口。</p>
        <div v-else class="list">
          <button v-for="w in shell.windows" :key="w.id" class="list-row" @click="shell.focusWindow(w.id)">
            <img class="list-icon" :src="iconUrl(appById(w.appId)?.icon || 'apps')" alt="" draggable="false" />
            <span>{{ w.title }}</span>
          </button>
        </div>
      </template>
      <template v-else>
        <h1>专业应用</h1>
        <p class="subtitle">本机安装的专业软件（如 Adobe 系列）。</p>
        <div class="empty-content">
          <span class="badge">尚未接入</span>
          <p>本机专业软件的检测、启动与 MCP 连接还没有接入新壳层，接入后会在这里列出。</p>
        </div>
      </template>
    </div>
  </div>
</template>
