<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import AuthErrorLine from "./AuthErrorLine.vue";
import AvatarPicker from "./AvatarPicker.vue";

/**
 * First-run 初始化（对齐 src/identity/AuthScreens.tsx:189-350）。
 *
 * · 三步向导的文案/顺序逐条一致；
 * · 步骤指示器是**被动进度**：ol.setup-steps 里一个可点元素都没有
 *   （disableStepIndicators 语义，探针会断言 .setup-steps button 数量为 0）；
 * · 末步才提交；提交前只做"两次密码一致"这一项本地判定。
 */
const SETUP_STEPS = [
  { title: "先起个名字", desc: "这个显示名会出现在顶栏和锁屏上，之后可以改。" },
  { title: "设置登录账号", desc: "登录时使用，形如 name@openarc.local，创建后不可更改。" },
  { title: "设置管理员密码", desc: "至少 8 位，明文不落盘。" },
];

const props = defineProps<{
  busy: boolean;
  error: { code: string; detail?: string } | null;
  defaultIdentifier?: string;
}>();
const emit = defineEmits<{
  submit: [input: { identifier: string; password: string; displayName: string; avatarRef?: string }];
}>();

const identifier = ref(props.defaultIdentifier ?? "");
const displayName = ref("");
const avatarRef = ref<string | null>(null);
const password = ref("");
const confirm = ref("");
const local = ref<string | null>(null);
const step = ref(0);
const direction = ref<1 | -1>(1);
const stepBody = ref<HTMLDivElement | null>(null);

const last = computed(() => step.value === SETUP_STEPS.length - 1);
const nextDisabled = computed(() => (step.value === 0 ? !displayName.value : !identifier.value));
const errorLine = computed(() => (local.value ? { code: local.value, detail: "password-mismatch" } : props.error));

// 切步后把焦点交给新步骤的第一个输入框；只在 step 变化时跑，不抢输入
watch(step, async () => {
  await nextTick();
  stepBody.value?.querySelector<HTMLInputElement>("input")?.focus();
});

function goNext() {
  direction.value = 1;
  step.value += 1;
}
function goBack() {
  direction.value = -1;
  step.value = Math.max(step.value - 1, 0);
}
function submit() {
  local.value = null;
  if (!last.value) {
    goNext();
    return;
  }
  if (password.value !== confirm.value) {
    local.value = "INVALID_INPUT";
    return;
  }
  emit("submit", {
    identifier: identifier.value,
    password: password.value,
    displayName: displayName.value,
    avatarRef: avatarRef.value ?? undefined,
  });
}
</script>

<template>
  <div class="auth-screen" data-d3-id="auth-screen">
    <div class="auth-card" role="main">
      <div class="eyebrow">FIRST RUN</div>
      <h1>初始化这台机器</h1>
      <p class="subtitle">创建本机的第一个管理员。初始化只能成功一次。</p>

      <form data-d3-id="setup-form" @submit.prevent="submit">
        <!-- 被动进度：disableStepIndicators 语义，容器内不放任何可点元素 -->
        <ol class="setup-steps" aria-label="初始化步骤">
          <li
            v-for="(s, i) in SETUP_STEPS"
            :key="s.title"
            :class="[
              'setup-step',
              i < step ? 'setup-step--done' : i === step ? 'setup-step--active' : '',
            ]"
            :aria-current="i === step ? 'step' : undefined"
            :aria-label="'第 ' + (i + 1) + ' 步：' + s.title"
          >
            <span
              v-if="i > 0"
              :class="['setup-step-connector', i <= step ? 'setup-step-connector--done' : '']"
              aria-hidden="true"
            />
            <span class="setup-step-dot" aria-hidden="true">{{ i + 1 }}</span>
          </li>
        </ol>

        <div ref="stepBody" class="setup-step-body">
          <div
            :key="step"
            :class="['setup-step-pane', 'setup-step-pane--' + (direction === 1 ? 'forward' : 'back')]"
          >
            <h2 class="setup-step-title">{{ SETUP_STEPS[step].title }}</h2>
            <p class="setup-step-desc">{{ SETUP_STEPS[step].desc }}</p>
            <template v-if="step === 0">
              <label class="field">
                管理员显示名
                <input
                  v-model="displayName"
                  placeholder="例如：Weping"
                  autocomplete="off"
                  data-d3-id="setup-name"
                />
              </label>
              <div class="field">
                <span>头像</span>
                <AvatarPicker
                  :avatar-ref="avatarRef"
                  id-prefix="setup-avatar"
                  @change="(v) => (avatarRef = v)"
                />
              </div>
            </template>
            <label v-else-if="step === 1" class="field">
              账号
              <input
                v-model="identifier"
                placeholder="name@openarc.local"
                autocomplete="username"
                data-d3-id="setup-identifier"
              />
            </label>
            <template v-else>
              <label class="field">
                密码
                <input
                  v-model="password"
                  type="password"
                  placeholder="至少 8 位"
                  autocomplete="new-password"
                  data-d3-id="setup-password"
                />
              </label>
              <label class="field">
                确认密码
                <input
                  v-model="confirm"
                  type="password"
                  placeholder="再输入一次"
                  autocomplete="new-password"
                  data-d3-id="setup-confirm"
                />
              </label>
            </template>
          </div>
        </div>

        <AuthErrorLine :error="errorLine" />
        <div class="auth-actions">
          <button
            v-if="step > 0"
            class="ghost"
            type="button"
            :disabled="busy"
            data-d3-id="setup-back"
            @click="goBack"
          >
            上一步
          </button>
          <button
            v-if="!last"
            class="primary"
            type="button"
            :disabled="nextDisabled"
            data-d3-id="setup-next"
            @click="goNext"
          >
            下一步
          </button>
          <button
            v-else
            class="primary"
            type="submit"
            :disabled="busy || !password || !confirm"
            data-d3-id="setup-submit"
          >
            {{ busy ? "正在初始化…" : "创建管理员" }}
          </button>
        </div>
        <p class="footnote">
          密码使用 scrypt 派生后存储，明文不落盘、不进入界面状态。初始化成功后需再用该密码登录一次。
        </p>
      </form>
    </div>
  </div>
</template>
