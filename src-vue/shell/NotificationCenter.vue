<script setup lang="ts">
import { appById, iconUrl } from "../apps";
import { useShellStore, type ShellNotice } from "../stores/shell";

const shell = useShellStore();

/**
 * 通知中心 + 浮动通知（10-15 按界面原型新增）。
 *   - 点顶栏日期时间打开 / 关闭通知中心（右上角浮层，点外部或 Esc 关闭）
 *   - 浮动通知：notify() 入队后右上角滑入，4.5 秒自动收起；专注模式下不弹
 *   - 点一条通知 = 打开来源应用
 * 本阶段通知来源只有壳层自身（快捷键说明等）；后端任务事件接入后走同一个 notify()。
 */
const icon = (n: ShellNotice) => iconUrl(appById(n.appId)?.icon || "apps");
const time = (n: ShellNotice) =>
  new Date(n.time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

function openFrom(n: ShellNotice) {
  shell.dismissToast(n.id);
  if (appById(n.appId)) shell.activateApp(n.appId);
}
</script>

<template>
  <template v-if="shell.notificationsOpen">
    <div class="cc-shade" @click="shell.closeNotifications()" />
    <aside class="notification-center" role="dialog" aria-label="通知中心">
      <header class="nc-head">
        <b>通知</b>
        <button v-if="shell.notices.length" class="nc-clear" @click="shell.clearNotices()">全部清除</button>
      </header>
      <TransitionGroup name="nc-list" tag="div" class="nc-list">
        <button v-for="n in shell.notices" :key="n.id" class="notice" @click="openFrom(n)">
          <img class="notice-icon" :src="icon(n)" alt="" />
          <span class="notice-main">
            <span class="notice-row"><b>{{ n.title }}</b><small>{{ time(n) }}</small></span>
            <span v-if="n.body" class="notice-body">{{ n.body }}</span>
          </span>
        </button>
      </TransitionGroup>
      <div v-if="!shell.notices.length" class="notice notice-empty">没有新通知</div>
    </aside>
  </template>

  <!-- 浮动通知与控制中心 / 通知中心同在右上角：任一浮层打开时让位，避免叠在一起 -->
  <TransitionGroup
    v-show="!shell.controlCenterOpen && !shell.notificationsOpen"
    name="toast"
    tag="div"
    class="toast-stack"
    aria-live="polite"
  >
    <button v-for="n in shell.toasts" :key="n.id" class="notice" @click="openFrom(n)">
      <img class="notice-icon" :src="icon(n)" alt="" />
      <span class="notice-main">
        <span class="notice-row"><b>{{ n.title }}</b><small>现在</small></span>
        <span v-if="n.body" class="notice-body">{{ n.body }}</span>
      </span>
    </button>
  </TransitionGroup>
</template>
