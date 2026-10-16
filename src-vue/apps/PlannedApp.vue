<script setup lang="ts">
import { computed, ref } from "vue";
import { Sparkles } from "lucide-vue-next";
import { appById, iconUrl } from "../apps";
import { useShellStore } from "../stores/shell";

/**
 * 原型里有、后台还没接的应用（10-15）：外壳按原型（侧栏分组 + 内容区），内容如实显示空态。
 * 不放任何演示数据。例外情况用的是真实数据 / 纯本地计算：
 *   · 日历：月视图是纯日期计算；日程来源未接入 → 每天都没有日程
 */
const props = defineProps<{ appId: string }>();
const shell = useShellStore();
const app = computed(() => appById(props.appId));

type Spec = { side: [string, string[]][]; title: string; body: string; action?: "ai" };
const SPECS: Record<string, Spec> = {








  browser: {
    side: [],
    title: "浏览器正在迁移到新壳层",
    body: "浏览器使用原生网页视图，需要与窗口几何、遮挡与下载协同，迁移进行中。当前请在旧版界面中使用浏览器。",
  },
};
const spec = computed<Spec>(
  () => SPECS[props.appId] ?? { side: [], title: "该应用尚未接入", body: "内容接入后会在这里显示。" },
);
const active = ref("");
</script>

<template>
  <!-- 原型外壳 + 真实空态 -->
  <div :class="spec.side.length ? 'split planned-app' : 'planned-app planned-solo'">
    <nav v-if="spec.side.length" class="split-side" :aria-label="app?.name">
      <template v-for="[group, items] in spec.side" :key="group">
        <div class="split-section">{{ group }}</div>
        <button
          v-for="(it, i) in items"
          :key="it"
          type="button"
          class="split-nav"
          :aria-current="(active || spec.side[0][1][0]) === it ? 'true' : undefined"
          @click="active = it"
        >
          <span class="split-nav-label">{{ it }}</span>
          <small v-if="i === 0 && group === spec.side[0][0]" class="planned-count">0</small>
        </button>
      </template>
    </nav>
    <div class="split-main">
      <div class="empty-content">
        <img class="large-icon" :src="iconUrl(app?.icon || 'apps')" alt="" draggable="false" />
        <h2 class="planned-title">{{ spec.title }}</h2>
        <p>{{ spec.body }}</p>
        <button v-if="spec.action === 'ai'" class="planned-cta" @click="shell.toggleAI()">
          <Sparkles :size="14" /> 让全局 AI 开始一项任务
        </button>
      </div>
    </div>
  </div>
</template>
