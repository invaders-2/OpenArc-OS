<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Brain, Cpu, Globe, HardDrive, Info, Languages, LayoutGrid, Network, Palette, Search, Shield } from "lucide-vue-next";
import { useIdentityStore } from "../stores/identity";
import AppearancePane from "./AppearancePane.vue";
import ModelSettings from "./ModelSettings.vue";
import DevicePane from "./DevicePane.vue";
import SystemPanes from "./SystemPanes.vue";

/**
 * 系统设置分栏（对齐 src/settings/SettingsContent.tsx）。
 *
 * 外壳与探针钩子逐项照搬：
 *   .split > .split-side(.split-section + .split-nav[data-settings-pane])
 *           + .split-main.settings-content[data-settings-active]
 *   内层 .settings-pane 放 h1 + .subtitle + 正文。
 * 默认停在「外观与交互」：device-ui 探针依赖 data-settings-active="appearance"。
 * 三个 pane = appearance | model | devices；paneRequest（外部请求）切到 model。
 */
type Pane = "account" | "appearance" | "language" | "privacy" | "network" | "devices" | "about" | "apps" | "disk" | "model" | "runtime";

const props = withDefaults(
  defineProps<{
    role?: string | null;
    /** 每次 +1 = 外部请求（画布页的"打开 OpenArc 总 API 设置"）切到「模型与服务商」pane。 */
    paneRequest?: number;
  }>(),
  { role: null, paneRequest: 0 },
);

/** 侧栏分组（10-15 按原型）：系统 / AI 与服务。账户在顶部的账户行里。 */
const PANES: { id: Pane; label: string; icon: unknown; group: string }[] = [
  { id: "appearance", label: "外观", icon: Palette, group: "系统" },
  { id: "language", label: "语言与地区", icon: Languages, group: "系统" },
  { id: "privacy", label: "隐私与安全性", icon: Shield, group: "系统" },
  { id: "network", label: "网络", icon: Globe, group: "系统" },
  { id: "devices", label: "局域网与设备", icon: Network, group: "系统" },
  { id: "about", label: "系统信息", icon: Info, group: "系统" },
  { id: "apps", label: "应用权限", icon: LayoutGrid, group: "管理" },
  { id: "disk", label: "磁盘空间", icon: HardDrive, group: "管理" },
  { id: "model", label: "模型与服务商", icon: Brain, group: "AI 与连接" },
  { id: "runtime", label: "本地运行环境", icon: Cpu, group: "AI 与连接" },
];

const TITLES: Record<Pane, { title: string; subtitle: string }> = {
  account: { title: "账户", subtitle: "头像与显示名。" },
  appearance: { title: "外观", subtitle: "整个工作空间，遵循你的习惯。" },
  language: { title: "语言与地区", subtitle: "界面语言、日期格式与时区。" },
  privacy: { title: "隐私与安全性", subtitle: "确认、联网与本机记录。" },
  network: { title: "网络", subtitle: "联网通道与代理。" },
  devices: { title: "局域网与设备", subtitle: "管理已授权的设备、配对凭据与设备审计。" },
  about: { title: "系统信息", subtitle: "版本与运行环境。" },
  apps: { title: "应用权限", subtitle: "哪些应用可用。" },
  disk: { title: "磁盘空间", subtitle: "磁盘与 OpenArc 数据占用。" },
  model: { title: "模型与服务商", subtitle: "统一配置所有应用使用的模型服务。" },
  runtime: { title: "本地运行环境", subtitle: "本机依赖与运行时。" },
};

const pane = ref<Pane>("appearance");
// 外部请求落在模型 pane；用户之后手动切走不会被再拽回来。
// immediate：外壳先 requestModelSettings() 再 activateApp("settings")，挂载时计数已是新值，
// 要像 React 的 useEffect(…, [paneRequest]) 那样在挂载时跑一次才收得到。
watch(
  () => props.paneRequest,
  (v) => {
    if (v) pane.value = "model";
  },
  { immediate: true },
);
const meta = computed(() => TITLES[pane.value]);

/**
 * 侧栏顶部（10-15 按界面原型补齐，macOS 系统设置口径）：
 *   搜索框（按分类名与副标题过滤侧栏）+ 账户卡（身份快照：显示名 / 账号 / 角色）。
 * 账户卡只读，没有身份桥时不渲染；分类与 data-settings-pane 钩子不变。
 */
const identity = useIdentityStore();
const ROLE_LABEL: Record<string, string> = { owner: "所有者", admin: "管理员", member: "成员", viewer: "访客", OWNER: "所有者", SUPER_ADMIN: "超级管理员", ADMIN: "管理员", MEMBER: "成员", VIEWER: "访客" };
const account = computed(() => {
  const s = identity.snapshot;
  if (!identity.available || !s.displayName) return null;
  return {
    name: s.displayName,
    initial: s.displayName.slice(0, 1).toUpperCase(),
    sub: s.role ? ROLE_LABEL[s.role] || s.role : s.identifier || "",
  };
});
const query = ref("");
const visiblePanes = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return PANES;
  return PANES.filter((p) => (p.label + TITLES[p.id].subtitle).toLowerCase().includes(q));
});
const groups = computed(() => {
  const out: { name: string; panes: typeof PANES }[] = [];
  for (const p of visiblePanes.value) {
    let g = out.find((x) => x.name === p.group);
    if (!g) out.push((g = { name: p.group, panes: [] }));
    g.panes.push(p);
  }
  return out;
});
</script>

<template>
  <div class="split settings-split">
    <nav class="split-side" aria-label="设置分类">
      <label class="ds-search settings-search">
        <Search class="ds-search__icon" :size="13" />
        <input v-model="query" class="ds-search__input" type="search" aria-label="搜索设置" placeholder="搜索设置" />
      </label>
      <button
        type="button"
        class="split-nav settings-account"
        data-settings-pane="account"
        :aria-current="pane === 'account' ? 'true' : undefined"
        @click="pane = 'account'"
      >
        <span class="settings-avatar" aria-hidden="true">{{ account?.initial ?? "我" }}</span>
        <span class="settings-account-text">
          <b>{{ account?.name ?? "账户" }}</b>
          <small>{{ account?.sub || "头像与显示名" }}</small>
        </span>
      </button>
      <p v-if="!visiblePanes.length" class="settings-noresult">没有匹配的设置</p>
      <template v-for="g in groups" :key="g.name">
        <div class="split-section">{{ g.name }}</div>
        <button
          v-for="p in g.panes"
          :key="p.id"
          type="button"
          class="split-nav"
          :data-settings-pane="p.id"
          :aria-current="pane === p.id ? 'true' : undefined"
          @click="pane = p.id"
        >
          <component :is="p.icon" :size="16" /> {{ p.label }}
        </button>
      </template>
    </nav>

    <div class="split-main settings-content" :data-settings-active="pane">
      <div class="pane-toolbar settings-toolbar">
        <h1 class="pane-title">{{ meta.title }}</h1>
      </div>
      <div :key="pane" class="settings-pane settings-body">
        <p v-if="pane === 'devices'" class="subtitle">{{ meta.subtitle }}</p>
        <AppearancePane v-if="pane === 'appearance'" section="appearance" />
        <AppearancePane v-else-if="pane === 'account'" section="account" />
        <ModelSettings v-else-if="pane === 'model'" :role="props.role" />
        <DevicePane v-else-if="pane === 'devices'" :role="props.role" />
        <SystemPanes v-else :key="pane" :pane="pane as any" />
      </div>
    </div>
  </div>
</template>
