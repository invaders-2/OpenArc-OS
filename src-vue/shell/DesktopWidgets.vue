<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Sparkles } from "lucide-vue-next";
import { useShellStore } from "../stores/shell";

const shell = useShellStore();

/**
 * 桌面小组件（10-15 按界面原型新增），左上角两枚：
 *   - 日期：月 / 日 / 星期，跟随真实时间
 *   - 进行中的任务：任务引擎接入前如实显示空态，并给一个交给全局 AI 的入口
 * 原型里还有天气卡，但产品没有天气数据源，不做假数据，先不放。
 * 桌面右键「隐藏小组件 / 显示小组件」控制显隐（oa-widgets）。
 */
const now = ref(new Date());
let timer = 0;
onMounted(() => (timer = window.setInterval(() => (now.value = new Date()), 60000)));
onBeforeUnmount(() => window.clearInterval(timer));

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const month = computed(() => `${now.value.getMonth() + 1}月`);
const day = computed(() => now.value.getDate());
const week = computed(() => `星期${WEEK[now.value.getDay()]}`);
</script>

<template>
  <div class="desk-widgets" aria-label="桌面小组件">
    <section class="widget widget-date" aria-label="日期">
      <small>{{ month }}</small>
      <strong>{{ day }}</strong>
      <span>{{ week }}</span>
    </section>
    <section class="widget widget-tasks" aria-label="进行中的任务">
      <header><b>进行中的任务</b><small>0</small></header>
      <p>没有进行中的任务。</p>
      <button class="widget-action" @click="shell.toggleAI()">
        <Sparkles :size="13" /> 交给全局 AI
      </button>
    </section>
  </div>
</template>
