<script setup lang="ts">
import { computed } from "vue";
import DsButton from "./DsButton.vue";
import { Inbox, LoaderCircle, CircleAlert, Lock, WifiOff, CircleSlash, CircleDashed } from "lucide-vue-next";

/**
 * PageState 原语（对齐 src/design-system/page-states.tsx）。
 * GLYPH 与语义 role/live 照搬；error/unauthorized 等带默认动作时，
 * 有 onAction 才渲染 secondary 重试按钮（与 React 版 showAction 同一判定）。
 */
export type PageStateKind =
  | "empty"
  | "loading"
  | "error"
  | "unauthorized"
  | "offline"
  | "unavailable"
  | "partial-result";

/** 每种状态的默认动作语义（PAGE_STATE_SPEC[kind].action），none 不渲染按钮。 */
const PAGE_STATE_ACTION: Record<PageStateKind, "none" | "retry" | "reconnect" | "signin" | "dismiss"> = {
  empty: "none",
  loading: "none",
  error: "retry",
  unauthorized: "signin",
  offline: "reconnect",
  unavailable: "none",
  "partial-result": "retry",
};
const ACTION_LABEL: Record<string, string> = {
  retry: "重试",
  reconnect: "重新连接",
  signin: "去登录",
  dismiss: "知道了",
};

const props = defineProps<{
  kind: PageStateKind;
  title: string;
  description?: string;
  missing?: string[];
  /** 覆盖默认动作文案；语义由 kind 决定 */
  actionLabel?: string;
  /** 传入才渲染动作按钮（与 React 版 Boolean(onAction) 同一判定） */
  onAction?: () => void;
}>();

/** 线性图标 48px（设计语言 1.0 §4-B 空状态）；不用字符 glyph，小字号下看不出是什么。 */
const GLYPH: Record<PageStateKind, unknown> = {
  empty: Inbox,
  loading: LoaderCircle,
  error: CircleAlert,
  unauthorized: Lock,
  offline: WifiOff,
  unavailable: CircleSlash,
  "partial-result": CircleDashed,
};

const role = computed(() => (props.kind === "error" || props.kind === "unauthorized" ? "alert" : "status"));
const live = computed(() => (role.value === "alert" ? "assertive" : "polite"));
const glyph = computed(() => GLYPH[props.kind]);
const defaultLabel = computed(() => ACTION_LABEL[PAGE_STATE_ACTION[props.kind]]);
const showAction = computed(
  () => PAGE_STATE_ACTION[props.kind] !== "none" && typeof props.onAction === "function",
);
</script>

<template>
  <div class="ds-page-state" :class="['ds-page-state--' + kind]" :role="role" :aria-live="live" data-ds-comp="page-state" :data-ds-kind="kind">
    <span v-if="kind !== 'loading'" class="ds-page-state__glyph" aria-hidden="true"><component :is="glyph" :size="48" :stroke-width="1.25" /></span>
    <p class="ds-page-state__title">{{ title }}</p>
    <p v-if="description" class="ds-page-state__desc">{{ description }}</p>
    <span v-if="kind === 'loading'" class="ds-spinner" aria-hidden="true" />
    <ul v-if="missing?.length" class="ds-page-state__missing">
      <li v-for="m in missing" :key="m">{{ m }}</li>
    </ul>
    <DsButton v-if="showAction" variant="secondary" @click="props.onAction && props.onAction()">
      {{ props.actionLabel ?? defaultLabel }}
    </DsButton>
  </div>
</template>
