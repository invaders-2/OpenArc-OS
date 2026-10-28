<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Check, ImagePlus, X } from "lucide-vue-next";
import { useShellStore } from "../stores/shell";

/**
 * 图片声明（10-15）：给 AI 生成 / AI 参与编辑的图片写入 IPTC「数字来源类型」（XMP），
 * 写入在主进程（electron/xmp-service.cjs），原图不改动，带声明的副本存回同一文件夹。
 * 支持 PNG / JPEG；其它格式如实标为不支持。
 */
type Img = { key: string; folderId: string; id: string; name: string; ext: string; folder: string; thumb: string };
type Item = Img & { st: "wait" | "run" | "done" | "fail"; note?: string };
const shell = useShellStore();
const bridge = window.openarc?.image;
const all = ref<Img[]>([]);
const picking = ref(false);
const items = ref<Item[]>([]);
const kind = ref<"ai" | "mix">("ai");
const running = ref(false);
const SUPPORTED = ["png", "jpg", "jpeg"];

async function load() {
  const b = window.openarc?.files;
  if (!b) return;
  const out: Img[] = [];
  for (const fid of ["desktop", ...shell.folders.map((f) => f.id)]) {
    const res = await b.list(fid).catch(() => null);
    const folder = fid === "desktop" ? "桌面" : shell.folders.find((f) => f.id === fid)?.name ?? "文件夹";
    for (const e of res?.entries ?? []) {
      if (!SUPPORTED.includes(String(e.ext).toLowerCase())) continue;
      out.push({ key: fid + "/" + e.id, folderId: fid, id: e.id, name: e.name, ext: e.ext, folder, thumb: "" });
    }
  }
  all.value = out;
  for (const im of all.value) {
    const t = await b.thumb?.(im.folderId, im.id).catch(() => null);
    if (t?.ok && t.dataUrl) im.thumb = t.dataUrl;
  }
}
const chosen = computed(() => new Set(items.value.map((i) => i.key)));
function toggle(im: Img) {
  if (chosen.value.has(im.key)) items.value = items.value.filter((i) => i.key !== im.key);
  else items.value.push({ ...im, st: "wait" });
}
const pending = computed(() => items.value.filter((i) => i.st !== "done"));
const SOURCE = { ai: "trainedAlgorithmicMedia", mix: "compositeWithTrainedAlgorithmicMedia" };
const ERR: Record<string, string> = { UNSUPPORTED: "不支持的格式", CORRUPT: "文件已损坏", NOT_FOUND: "文件已不在访达里", IMPORT_FAILED: "副本保存失败" };

async function run() {
  if (!bridge || !pending.value.length) return;
  running.value = true;
  const batch = pending.value;
  batch.forEach((i) => (i.st = "run"));
  const r = await bridge.declare(batch.map((i) => ({ folderId: i.folderId, id: i.id })), kind.value).catch(() => null);
  let done = 0;
  for (const i of batch) {
    const res = r?.results?.find((x) => x.id === i.id);
    if (res?.ok) {
      i.st = "done";
      i.note = `已另存「${res.entry?.name}」` + (res.replaced ? "（原有 XMP 已替换）" : "");
      done += 1;
    } else {
      i.st = "fail";
      i.note = ERR[res?.error ?? ""] ?? "写入失败";
    }
  }
  running.value = false;
  if (done) {
    shell.notify({ appId: "declare", title: "声明写入完成", body: `${done} 张图片已另存带声明的副本` });
    void load();
  }
}
onMounted(load);
</script>

<template>
  <div class="declare-app">
    <div class="pane-toolbar dc-toolbar">
      <strong class="pane-title dc-title">图片声明</strong>
      <span class="dc-sub">为 AI 生成图片写入标准元数据（IPTC 数字来源类型）</span>
    </div>
    <div class="dc-body">
      <div class="dc-drop" style="height: 140px; overflow: hidden" role="button" tabindex="0" :aria-expanded="picking" @click="picking = !picking">
        <ImagePlus :size="26" />
        <b>{{ picking ? "收起图片列表" : "添加图片" }}</b>
        <span>支持 PNG / JPG，原图不改动，另存带声明的副本到同一文件夹</span>
        <div class="dc-entries">
          <button type="button" disabled title="资源库图片没有可直接写入 XMP 的文件句柄（NOT VERIFIED）">从资源库选择</button>
          <button type="button" @click.stop="picking = !picking">从访达选择</button>
        </div>
      </div>
      <div v-if="picking" class="dc-picker">
        <p v-if="!all.length" class="planned-note">访达里还没有 PNG / JPG 图片。</p>
        <button
          v-for="im in all"
          :key="im.key"
          type="button"
          class="dc-pick"
          :aria-pressed="chosen.has(im.key)"
          :title="im.name + ' · ' + im.folder"
          @click="toggle(im)"
        >
          <img v-if="im.thumb" :src="im.thumb" alt="" draggable="false" />
          <span v-else class="photo-ph">{{ im.ext }}</span>
          <span v-if="chosen.has(im.key)" class="dc-check"><Check :size="12" /></span>
        </button>
      </div>

      <section class="set-sec">
        <div class="set-sh">
          <h3>待处理 · {{ pending.length }}</h3>
          <div class="segmented text" role="group" aria-label="声明类型">
            <button :aria-pressed="kind === 'ai'" @click="kind = 'ai'">完全由 AI 生成</button>
            <button :aria-pressed="kind === 'mix'" @click="kind = 'mix'">AI 参与编辑</button>
          </div>
          <button class="planned-cta dc-run" :disabled="!pending.length || running || !bridge" @click="run">
            {{ running ? "正在写入…" : "写入声明" }}
          </button>
        </div>
        <p v-if="!items.length" class="set-cap">还没有选择图片。</p>
        <div v-else class="set-group">
          <div v-for="i in items" :key="i.key" class="setting-row dc-row">
            <span class="dc-thumb"><img v-if="i.thumb" :src="i.thumb" alt="" /></span>
            <span class="set-lab">
              {{ i.name }}
              <small>{{ i.note || (i.st === "wait" ? "等待处理 · 将写入 " + SOURCE[kind] : i.st === "run" ? "正在写入…" : "") }}</small>
            </span>
            <span v-if="i.st === 'run'" class="dc-ring" aria-label="正在写入" />
            <span v-else-if="i.st === 'done'" class="badge ok">已完成</span>
            <span v-else-if="i.st === 'fail'" class="badge">失败</span>
            <button v-else-if="i.st === 'wait'" class="icon-button" :aria-label="'移除 ' + i.name" @click="items.splice(items.indexOf(i), 1)">
              <X :size="13" />
            </button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
<style scoped>
.dc-toolbar { height: 52px; min-height: 52px; margin: 0; padding: 0 24px 0 92px; border-bottom: 0.5px solid var(--line); }
.dc-body { padding: 20px 24px 24px; }
.dc-drop { padding: 26px; }
.declare-app .set-sh { display: flex; align-items: center; gap: 12px; margin: 16px 0 6px; }
.declare-app .set-sh h3 { margin: 0; font-size: var(--fs-secondary); }
.dc-ring { width: 16px; height: 16px; border-radius: 50%; border: 2px solid rgb(var(--text-rgb) / 0.2); border-top-color: var(--text); animation: dc-spin 0.8s linear infinite; }
@keyframes dc-spin { to { transform: rotate(360deg); } }

.dc-body { padding: 8px 24px 24px; }
.dc-drop { min-height: 140px; box-sizing: border-box; }
.declare-app .set-sh { margin: 22px 0 6px; }
.dc-row { min-height: 66px; }
.set-group { margin-top: 9px; }

.dc-entries { display: flex; gap: 8px; margin-top: 4px; }
.dc-entries button { height: 28px; padding: 0 12px; border-radius: var(--radius-pill); background: rgb(var(--text-rgb) / 0.08); font-size: var(--fs-caption); }
.dc-entries button:disabled { opacity: 0.45; }

.dc-drop { position: relative; padding-bottom: 26px; }
.dc-entries { position: absolute; left: 0; right: 0; bottom: 12px; justify-content: center; margin: 0; }
</style>
