<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { AlertTriangle, Copy, ScanText, Upload } from "lucide-vue-next";
import DsBadge from "../design-system/DsBadge.vue";
import DsButton from "../design-system/DsButton.vue";
import DsPageState from "../design-system/DsPageState.vue";
import { useShellStore } from "../stores/shell";
import {
  detailText,
  domainBridge,
  failureText,
  invokeDomain,
  resultFailure,
  resultValue,
  type FailureView,
} from "../bridge/domain";

/**
 * 文字识别（0.6.1 · 相册 › 文字识别，接既有 ocr:command）。
 *
 * 真实边界：
 *   · 供应商只能来自「系统设置 › 模型与服务商」里配好的 paddleocr-vl；没有就是空态，不放示例。
 *   · 识别是真实云端任务（300s 超时、32MB / 24M 像素上限）；取消与超时都会如实报，不假装完成。
 *   · 区域框、文字与置信度都来自主进程归一化后的 OcrResult。
 */
type OcrProvider = { id: string; name: string };
type OcrProvidersValue = {
  available?: boolean;
  providers?: OcrProvider[];
  local?: boolean;
  maxBytes?: number;
  maxPixels?: number;
  boundingBoxes?: boolean;
  modes?: string[];
  protocol?: string;
  model?: string;
};
type OcrRegion = {
  id: string;
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
  confidence?: number;
};
type OcrResult = { width: number; height: number; regions?: OcrRegion[]; text?: string; engine?: string };

const shell = useShellStore();
const hasBridge = ref(!!domainBridge(typeof window === "undefined" ? null : window, "ocr"));
const loading = ref(false);
const recognizing = ref(false);
const error = ref<FailureView | null>(null);
const providers = ref<OcrProvidersValue | null>(null);
const providerId = ref("");
const imageDataUrl = ref("");
const imageName = ref("");
const result = ref<OcrResult | null>(null);
const copied = ref(false);

const hasProviders = computed(() => (providers.value?.providers?.length ?? 0) > 0);
const regions = computed(() => result.value?.regions ?? []);

async function send(command: string, payload: Record<string, unknown> = {}) {
  if (!hasBridge.value) return { ok: false, error: "BRIDGE_ABSENT" };
  return invokeDomain("ocr", command, payload);
}

async function loadProviders() {
  loading.value = true;
  error.value = null;
  const reply = await send("ocr/providers", {});
  loading.value = false;
  const value = resultValue<OcrProvidersValue>(reply);
  if (value) {
    providers.value = value;
    if (!providerId.value || !(value.providers || []).some((item) => item.id === providerId.value)) {
      providerId.value = value.providers?.[0]?.id ?? "";
    }
  } else {
    providers.value = null;
    error.value = resultFailure(reply);
  }
}

function pickFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (file.size > (providers.value?.maxBytes ?? 32 * 1024 * 1024)) {
    error.value = { code: "OCR_INVALID_INPUT", message: "图片超过 32 MB 上限，OCR 无法上传。" };
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    imageDataUrl.value = typeof reader.result === "string" ? reader.result : "";
    imageName.value = file.name;
    result.value = null;
    error.value = null;
  };
  reader.onerror = () => {
    error.value = { code: "OCR_INVALID_INPUT", message: "本机读取图片失败。" };
  };
  reader.readAsDataURL(file);
}

async function recognize() {
  if (!imageDataUrl.value) {
    error.value = { code: "OCR_INVALID_INPUT", message: "先选择一张图片。" };
    return;
  }
  recognizing.value = true;
  error.value = null;
  result.value = null;
  const reply = await send("ocr/recognize", {
    dataUrl: imageDataUrl.value,
    providerId: providerId.value || undefined,
  });
  recognizing.value = false;
  const value = resultValue<OcrResult>(reply);
  if (value) result.value = value;
  else error.value = resultFailure(reply);
}

async function copyText() {
  const text = result.value?.text || "";
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 1600);
  } catch {
    error.value = { code: "CLIPBOARD", message: "剪贴板写入被系统拒绝，可以手动选择结果文本。" };
  }
}

function openModelSettings() {
  shell.requestModelSettings();
  shell.activateApp("settings");
}

function boxStyle(region: OcrRegion) {
  const width = result.value?.width || 1;
  const height = result.value?.height || 1;
  return {
    left: (region.bbox.x / width) * 100 + "%",
    top: (region.bbox.y / height) * 100 + "%",
    width: Math.max(0.4, (region.bbox.width / width) * 100) + "%",
    height: Math.max(0.4, (region.bbox.height / height) * 100) + "%",
  };
}

const confidenceText = (region: OcrRegion) =>
  typeof region.confidence === "number" ? region.confidence.toFixed(1) + "%" : "未提供";

onMounted(() => {
  void loadProviders();
});
</script>

<template>
  <div class="ocr-panel" data-ocr-panel>
    <DsPageState
      v-if="!hasBridge"
      kind="unavailable"
      title="当前环境没有 OCR 域的桥"
      description="浏览器预览不提供 ocr:command；请在 OpenArc 桌面应用中打开相册。"
    />

    <template v-else>
      <div class="ocr-toolbar">
        <div class="ocr-provider">
          <span class="ocr-label">PaddleOCR 平台</span>
          <select v-if="hasProviders" v-model="providerId" aria-label="OCR 供应商">
            <option v-for="item in providers?.providers || []" :key="item.id" :value="item.id">{{ item.name }}</option>
          </select>
          <DsBadge v-else size="sm" tone="warning">未配置</DsBadge>
        </div>
        <span class="toolbar-spacer" />
        <span v-if="providers" class="ocr-limit">
          单图上限 {{ Math.round((providers.maxBytes || 0) / 1024 / 1024) }} MB · {{ ((providers.maxPixels || 0) / 1024 / 1024).toFixed(0) }} M 像素 · {{ providers.model || "PaddleOCR" }}
        </span>
        <DsButton size="sm" variant="ghost" :status="loading ? 'loading' : 'idle'" @click="loadProviders">重新读取供应商</DsButton>
      </div>

      <template v-if="providers && !hasProviders">
        <DsPageState
          kind="empty"
          title="还没有可用的 PaddleOCR 供应商"
          description="OCR 使用「模型与服务商」里启用的 paddleocr-vl 平台与 AIStudio Access Token；未配置时不会发送任何识别请求。"
        />
        <div class="ocr-empty-action">
          <DsButton variant="secondary" size="sm" @click="openModelSettings">打开模型与服务商</DsButton>
        </div>
      </template>

      <p v-if="error" class="ocr-error" role="alert" :data-ocr-error="error.code">
        {{ failureText(error) }}<span v-if="error.detail" class="ocr-detail"> · {{ detailText(error.detail) }}</span>
      </p>

      <div v-if="!providers || hasProviders" class="ocr-grid">
        <section class="ocr-drop" aria-label="选择图片">
          <div class="ocr-drop-head">
            <span class="ocr-label">识别图片</span>
            <DsBadge v-if="imageName" size="sm">{{ imageName }}</DsBadge>
          </div>
          <div class="ocr-stage" :class="{ empty: !imageDataUrl }">
            <template v-if="imageDataUrl">
              <img class="ocr-image" :src="imageDataUrl" alt="待识别图片预览" />
              <span
                v-for="region in regions"
                :key="region.id"
                class="ocr-box"
                :style="boxStyle(region)"
                :title="region.text + ' · ' + confidenceText(region)"
              />
            </template>
            <p v-else class="ocr-placeholder">选择一张图片后会在本机预览；点击「开始识别」才把图片发给 PaddleOCR。</p>
          </div>
          <div class="ocr-actions">
            <label
              class="ds-btn ds-btn--secondary ds-btn--md ocr-pick"
              :class="{ 'is-busy': recognizing }"
            >
              <Upload :size="14" /> {{ imageDataUrl ? "换一张图片" : "选择图片" }}
              <input type="file" accept="image/*" hidden @change="pickFile" />
            </label>
            <DsButton
              variant="primary"
              size="sm"
              :disabled="!imageDataUrl || !hasProviders"
              :status="recognizing ? 'loading' : 'idle'"
              data-ocr-recognize
              @click="recognize"
            >
              <ScanText :size="14" /> {{ recognizing ? "识别中…" : "开始识别" }}
            </DsButton>
          </div>
          <p class="ocr-note">识别是真实云端任务；超时或取消时结果不会被标成功，也不会给出假进度。</p>
        </section>

        <section class="ocr-result" aria-label="识别结果" data-ocr-result>
          <div class="ocr-result-head">
            <span class="ocr-label">识别结果</span>
            <span v-if="result" class="ocr-meta">{{ regions.length }} 个文本区域 · 引擎 {{ result.engine || "—" }}</span>
            <span class="toolbar-spacer" />
            <DsButton v-if="result?.text" size="sm" variant="ghost" @click="copyText">
              <Copy :size="13" /> {{ copied ? "已复制" : "复制全文" }}
            </DsButton>
          </div>

          <DsPageState v-if="!result && !recognizing" kind="empty" title="还没有识别结果" description="选择图片并开始识别后，这里显示真实返回的文字与区域。" />
          <DsPageState v-else-if="recognizing" kind="loading" title="正在等待 PaddleOCR" description="云端任务可能需要几十秒；超时会明确报错。" />
          <template v-else-if="result">
            <div v-if="!regions.length && !result.text" class="ocr-empty-result">
              <AlertTriangle :size="16" />
              <span>服务返回成功，但没有识别到文字区域。</span>
            </div>
            <pre v-if="result.text" class="ocr-text">{{ result.text }}</pre>
            <ul v-if="regions.length" class="ocr-regions">
              <li v-for="region in regions" :key="region.id" class="ocr-region">
                <span class="ocr-region-text">{{ region.text }}</span>
                <span class="ocr-region-meta">
                  {{ confidenceText(region) }} ·
                  {{ Math.round(region.bbox.x) }},{{ Math.round(region.bbox.y) }} ·
                  {{ Math.round(region.bbox.width) }}×{{ Math.round(region.bbox.height) }}
                </span>
              </li>
            </ul>
          </template>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ocr-panel { display: flex; flex-direction: column; min-height: 0; height: 100%; padding: var(--space-4) var(--space-5); gap: var(--space-3); overflow: auto; }
.ocr-toolbar { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.ocr-provider { display: flex; align-items: center; gap: var(--space-2); }
.ocr-label { font-size: var(--fs-caption); color: var(--muted); }
.ocr-provider select {
  min-height: 28px;
  padding: 2px var(--space-2);
  border: 0;
  border-radius: var(--radius-md);
  background: var(--sunken);
  color: var(--text);
  font-size: var(--fs-caption);
}
.ocr-limit { font-size: var(--fs-micro); color: var(--muted); font-variant-numeric: tabular-nums; }
.ocr-grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: var(--space-4); min-height: 0; flex: 1; }
.ocr-drop, .ocr-result {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 0;
  padding: var(--space-3);
  border-radius: var(--radius-lg);
  background: rgb(var(--text-rgb) / 0.035);
}
.ocr-drop-head, .ocr-result-head { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.ocr-stage {
  position: relative;
  flex: 1;
  min-height: 180px;
  display: grid;
  place-items: center;
  overflow: hidden;
  border-radius: var(--radius-md);
  background: rgb(var(--sunken-rgb) / var(--sunken-alpha));
}
.ocr-image { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
.ocr-box { position: absolute; border: 2px solid rgb(var(--accent-rgb)); border-radius: 2px; pointer-events: none; }
.ocr-placeholder { margin: 0; padding: var(--space-4); font-size: var(--fs-caption); color: var(--muted); text-align: center; line-height: var(--lh-relaxed); }
.ocr-actions { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.ocr-pick { cursor: pointer; }
.ocr-pick.is-busy { opacity: 0.6; pointer-events: none; }
.ocr-note { margin: 0; font-size: var(--fs-micro); color: var(--muted); line-height: var(--lh-relaxed); }
.ocr-meta { font-size: var(--fs-micro); color: var(--muted); }
.ocr-error { margin: 0; color: var(--failed); font-size: var(--fs-caption); line-height: var(--lh-relaxed); }
.ocr-detail { color: var(--muted); }
.ocr-text {
  margin: 0;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: rgb(var(--content-rgb) / 0.55);
  font-family: var(--font-mono);
  font-size: var(--fs-caption);
  line-height: var(--lh-relaxed);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 46%;
  overflow: auto;
}
.ocr-regions { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; overflow: auto; min-height: 0; }
.ocr-region { display: flex; flex-direction: column; gap: 2px; padding: var(--space-2); border-radius: var(--radius-sm); background: rgb(var(--text-rgb) / 0.04); }
.ocr-region-text { font-size: var(--fs-secondary); overflow-wrap: anywhere; }
.ocr-region-meta { font-size: var(--fs-micro); color: var(--muted); font-variant-numeric: tabular-nums; }
.ocr-empty-result { display: flex; align-items: center; gap: var(--space-2); color: var(--muted); font-size: var(--fs-caption); }
.ocr-empty-action { display: flex; justify-content: center; margin-top: calc(var(--space-2) * -1); }
@media (max-width: 820px) {
  .ocr-grid { grid-template-columns: 1fr; }
}
</style>
