<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { Search } from "lucide-vue-next";
import { APPS, appById, iconUrl, type AppEntry } from "../apps";
import { useShellStore } from "../stores/shell";
import DsBadge from "../design-system/DsBadge.vue";
import CanvasUpdatePanel from "./CanvasUpdatePanel.vue";
import { UPDATE_STATUS_COMMAND, appCardUpdate, normalizeAppUpdateStatus } from "./appUpdateLogic";
import type { AppUpdateStatus } from "./appUpdateLogic";

/**
 * 应用市场（10-15）：本机应用目录 —— 只列 OpenArc 注册表里真实存在的应用。
 * 每个应用都显示随包内置版本与更新状态；点「版本与更新」进入通用更新面板（按 appId 驱动）。
 *
 * 诚实边界：没有发布包 → 无可用更新（正常状态）；有包但渲染层没有加载路径的应用
 * （本期只有无限画布已接入）→ 如实显示「暂不支持安装包加载」，不给可点的升级。
 * 第三方上架、购买与安装流程需要市场后台，尚未接入，不放任何虚构的商品。
 */
const shell = useShellStore();
const query = ref("");
const cat = ref("全部");
/** 通用更新详情：留在同一个应用窗口里换主区内容，不新增应用也不新增窗口。 */
const detail = ref<string | null>(null);
/** 从卡片「升级」直接进来时，面板状态就绪后自动打开二次确认层（仍不是静默安装）。 */
const autoInstall = ref(false);
/** 每个应用的本机更新状态（只读本机记录，不发网络；进面板后各应用自己再检查）。 */
const statuses = reactive<Record<string, AppUpdateStatus | null>>({});

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
const card = (a: AppEntry) => appCardUpdate(statuses[a.id] ?? null);
/* 探针取证：卡片上直接暴露这一轮读到的原始状态，便于定位「后端新数据 ↔ 界面显示」的差异。 */
const statusCurrent = (id: string): string => {
  const s = statuses[id];
  if (!s) return "none";
  return s.current ? s.current.version : "builtin:" + s.builtinVersion;
};
const statusLatest = (id: string): string => {
  const s = statuses[id];
  return s && s.latest ? s.latest.version : "";
};
const statusChecked = (id: string): string => {
  const s = statuses[id];
  return s && s.checkedAt != null ? String(s.checkedAt) : "";
};
/**
 * 更新面板里显示的应用名。画布沿用更新界面既有称呼「无限画布」（程序坞/卡片上的产品名是 AI Studio），
 * 其它应用用注册表名。只影响文案，不影响命令。
 */
const UPDATE_APP_NAME: Record<string, string> = { canvas: "无限画布" };
const detailName = computed(() => {
  const id = detail.value;
  if (!id) return "";
  return UPDATE_APP_NAME[id] || appById(id)?.name || id;
});

function openDetail(id: string, upgrade = false) {
  detail.value = id;
  autoInstall.value = upgrade;
}

function closeDetail() {
  detail.value = null;
  autoInstall.value = false;
  // 回到列表时刷新每个应用的更新状态（面板里可能刚检查/安装过）。
  void loadStatuses();
}

/** 只读本机记录（status 不联网）；读不到就如实留空，不编造更新状态。 */
async function loadStatuses() {
  const api = window.openarc?.marketUpdate;
  if (!api || typeof api.command !== "function") return;
  await Promise.all(APPS.filter((a) => a.id !== "market").map(async (a) => {
    try {
      const raw = await api.command({ command: UPDATE_STATUS_COMMAND, payload: { appId: a.id } });
      const box = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      statuses[a.id] = box.ok === true ? normalizeAppUpdateStatus(box.value) : null;
    } catch {
      statuses[a.id] = null;
    }
  }));
}

onMounted(() => { void loadStatuses(); });
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
      <p class="planned-note">目前列出本机已有的应用，并显示各自的内置版本与更新状态。第三方应用上架与安装尚未接入；本期只有无限画布的更新包会在安装后真正生效。</p>
    </nav>
    <div class="split-main market-main">
      <CanvasUpdatePanel
        v-if="detail"
        :key="detail"
        :app-id="detail"
        :app-name="detailName"
        :auto-install="autoInstall"
        @back="closeDetail"
      />
      <template v-else>
        <div class="pane-toolbar">
          <strong class="pane-title">{{ cat === "全部" ? "全部应用" : cat }}</strong>
          <span class="badge">{{ apps.length }} 个</span>
        </div>
        <div class="market-grid">
          <div
            v-for="a in apps"
            :key="a.id"
            class="market-card"
            :data-app-card="a.id"
            :data-app-version="a.version"
            :data-app-update-current="statusCurrent(a.id)"
            :data-app-update-latest="statusLatest(a.id)"
            :data-app-update-checked="statusChecked(a.id)"
          >
            <img class="market-icon" :src="iconUrl(a.icon)" alt="" draggable="false" />
            <div class="market-info">
              <div class="market-name">
                {{ a.name }}
                <small class="market-tag">v{{ a.version }}</small>
                <small v-if="meta(a).planned" class="market-tag">待接入</small>
              </div>
              <div class="market-desc">{{ meta(a).desc }}</div>
              <div class="market-desc" :data-app-update-detail="a.id">
                <DsBadge size="sm" :tone="card(a).tone">{{ card(a).badge }}</DsBadge>
                {{ card(a).detail }}
              </div>
            </div>
            <div class="market-btns">
              <button class="market-open" :data-app-open="a.id" @click="shell.activateApp(a.id)">打开</button>
              <button
                v-if="a.id === 'canvas'"
                class="market-pin"
                data-canvas-update-open
                :aria-pressed="detail === 'canvas'"
                @click="openDetail('canvas')"
              >在线更新</button>
              <button
                v-else
                class="market-pin"
                :data-app-update-open="a.id"
                :data-app-update-upgrade="card(a).canUpgrade ? 'true' : 'false'"
                @click="openDetail(a.id, card(a).canUpgrade)"
              >{{ card(a).canUpgrade ? "升级" : "版本与更新" }}</button>
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
      </template>
    </div>
  </div>
</template>
