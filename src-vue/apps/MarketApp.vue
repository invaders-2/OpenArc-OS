<script setup lang="ts">
import { computed, ref } from "vue";
import { Search } from "lucide-vue-next";
import { APPS, iconUrl, type AppEntry } from "../apps";
import { useShellStore } from "../stores/shell";

/**
 * 应用市场（10-15）：先做「本机应用目录」—— 只列 OpenArc 注册表里真实存在的应用，
 * 可打开、可添加到 / 移出程序坞。第三方上架、购买与安装流程需要市场后台，尚未接入，
 * 不放任何虚构的商品。
 */
const shell = useShellStore();
const query = ref("");
const cat = ref("全部");

const META: Record<string, { cat: string; desc: string; planned?: boolean }> = {
  home: { cat: "系统", desc: "浏览与打开全部应用" },
  files: { cat: "系统", desc: "管理桌面与文件夹里的文件" },
  trash: { cat: "系统", desc: "恢复或彻底删除已移除的文件" },
  settings: { cat: "系统", desc: "外观、账户、模型与隐私设置" },
  dev: { cat: "系统", desc: "运行环境、窗口状态与运行日志" },
  declare: { cat: "创作", desc: "为 AI 生成图片写入标准来源声明" },
  canvas: { cat: "创作", desc: "无限画布：图像、视频与工作流" },
  photos: { cat: "创作", desc: "汇总访达里的全部图片" },
  music: { cat: "创作", desc: "播放访达里的音频文件" },
  notes: { cat: "创作", desc: "Markdown / 纯文本文稿，自动保存" },
  video: { cat: "创作", desc: "拼接、裁剪视频并用本机 FFmpeg 导出" },
  chat: { cat: "效率", desc: "和助理对话、交代任务" },
  automation: { cat: "效率", desc: "按时间自动让助理完成任务" },
  calendar: { cat: "效率", desc: "月视图与本机日程" },
  weather: { cat: "效率", desc: "当前天气与 7 日预报（Open-Meteo）" },
  browser: { cat: "效率", desc: "受控的网页浏览与下载" },
  projects: { cat: "团队与资源", desc: "项目与成员协作" },
  organization: { cat: "团队与资源", desc: "成员、角色与权限治理" },
  "resource-library": { cat: "团队与资源", desc: "可被助理引用的资源" },
  skills: { cat: "团队与资源", desc: "技能的安装与管理" },
  "mcp-center": { cat: "团队与资源", desc: "连接外部工具与数据源（MCP）" },
};
const CATS = ["全部", "系统", "创作", "效率", "团队与资源"];
const meta = (a: AppEntry) => META[a.id] ?? { cat: "其他", desc: "" };

const apps = computed(() => {
  const q = query.value.trim().toLowerCase();
  return APPS.filter((a) => a.id !== "market")
    .filter((a) => cat.value === "全部" || meta(a).cat === cat.value)
    .filter((a) => !q || a.name.toLowerCase().includes(q) || meta(a).desc.toLowerCase().includes(q));
});
const inDock = (id: string) => shell.dockIds.includes(id);
</script>

<template>
  <div class="split market-app">
    <nav class="split-side" aria-label="应用市场">
      <label class="ds-search notes-search">
        <Search class="ds-search__icon" :size="13" />
        <input v-model="query" class="ds-search__input" type="search" placeholder="搜索应用" aria-label="搜索应用" />
      </label>
      <div class="split-section">分类</div>
      <button v-for="c in CATS" :key="c" type="button" class="split-nav" :aria-current="cat === c ? 'true' : undefined" @click="cat = c">
        <span class="split-nav-label">{{ c }}</span>
      </button>
      <p class="planned-note">目前列出本机已有的应用。第三方应用上架与安装尚未接入。</p>
    </nav>
    <div class="split-main market-main">
      <div class="pane-toolbar">
        <strong class="pane-title">{{ cat === "全部" ? "全部应用" : cat }}</strong>
        <span class="badge">{{ apps.length }} 个</span>
      </div>
      <div class="market-grid">
        <div v-for="a in apps" :key="a.id" class="market-card">
          <img class="market-icon" :src="iconUrl(a.icon)" alt="" draggable="false" />
          <div class="market-info">
            <div class="market-name">{{ a.name }} <small v-if="meta(a).planned" class="market-tag">待接入</small></div>
            <div class="market-desc">{{ meta(a).desc }}</div>
          </div>
          <div class="market-btns">
            <button class="market-open" @click="shell.activateApp(a.id)">打开</button>
            <button
              v-if="a.id !== 'trash'"
              class="market-pin"
              :aria-pressed="inDock(a.id)"
              :title="inDock(a.id) ? '从程序坞移除' : '添加到程序坞'"
              @click="shell.toggleDock(a.id)"
            >{{ inDock(a.id) ? "已在程序坞" : "加到程序坞" }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
