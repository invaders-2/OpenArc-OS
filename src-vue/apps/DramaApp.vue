<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { Clapperboard, Film, Image as ImageIcon, LoaderCircle, Palette, Plus, ScrollText, Sparkles } from "lucide-vue-next";
import { iconUrl } from "../apps";
import DsDialog from "../design-system/DsDialog.vue";

/**
 * 短剧工坊（10-16，对齐 DX OS「视频工坊 ShortDrama」）：剧本 → 视觉设定 → 分镜 → 出图 → 成片。
 *
 * 全部走 window.openarc.media.command 的 media/short-drama/*（electron/media-short-drama.cjs，逐函数移植自 DX OS）：
 *   · AI 步骤（集纲 / 视觉设定 / 分镜 / 出图 / 参考图）用「系统设置 › 模型与服务商」里的默认模型，没有就如实报错；
 *   · 每一步的结果都可以手动改（update / shot/update），手改的标为「手动编辑」；
 *   · 画面经 media/short-drama/image 按项目读取（只读、只限本项目引用的画面）；
 *   · 项目数据用 media/short-drama/get 的拍平视图（IPC 返回值有深度上限，嵌套的画面列表会被裁掉）；
 *   · 成片 = 把已有画面的分镜按时长拼成竖屏视频，交给本机 FFmpeg 渲染队列（media/render/*）。
 */
const bridge = window.openarc?.media;
type Res = { ok?: boolean; value?: any; error?: string; message?: string; detail?: unknown };
async function send(command: string, payload: Record<string, unknown> = {}): Promise<Res> {
  if (!bridge?.command) return { ok: false, error: "NO_BRIDGE" };
  try {
    return (await bridge.command({ command, payload })) || { ok: false, error: "MEDIA_INTERNAL" };
  } catch {
    return { ok: false, error: "MEDIA_INTERNAL" };
  }
}
const val = (r: Res) => (r.value && typeof r.value === "object" ? r.value : (r as any));
const ERR: Record<string, string> = {
  NO_BRIDGE: "媒体服务没有接入",
  MEDIA_INVALID_INPUT: "内容不完整或不正确",
  MEDIA_NOT_FOUND: "找不到这个项目或画面",
  MEDIA_DEPENDENCY_UNAVAILABLE: "需要的能力还没接入",
  MEDIA_INTERNAL: "媒体服务出错",
};
function errText(r: Res) {
  const code = String(r.error || "MEDIA_INTERNAL");
  // 后端沿用 DX OS 的入口名「API 设置」：换成 OpenArc 的位置
  let msg = typeof r.message === "string" ? r.message.replace(/「API 设置」/g, "「系统设置 › 模型与服务商」") : "";
  if (/模型|provider|Provider|model/i.test(msg) && /未|没有|缺少|missing|unavailable/i.test(msg))
    msg = "没有可用的模型：先到「系统设置 › 模型与服务商」添加服务商并设好默认的文本 / 生图模型";
  return (msg || ERR[code] || "操作失败") + "（" + code + "）";
}

type Episode = { id: string; number: number; title: string; summary: string; hook: string; characterNames: string; locationNames: string };
type Character = { id: string; name: string; role: string; appearance: string; costume: string; signature: string; imageCount: number; selectedImageId?: string };
type Location = { id: string; name: string; atmosphere: string; visual: string; props: string; imageCount: number; selectedImageId?: string };
type Shot = { id: string; episodeId?: string; title: string; scene: string; script: string; prompt: string; duration: number; imageStatus: string; imageCount: number; selectedImageId?: string; characterIds: string };
type View = {
  id: string; name: string; stage: string; sourceText: string; updatedAt: number;
  blueprint: { logline: string; tone: string; episodes: Episode[]; provider?: string; model?: string } | null;
  visualDesign: { style: string; characters: Character[]; locations: Location[]; provider?: string; model?: string } | null;
  shots: Shot[];
};
type Img = { owner: "shot" | "character" | "location"; ownerId: string; id: string; nodeId: string; kind: string | null };

const projects = ref<{ id: string; name: string; stage: string; updatedAt: number }[]>([]);
const currentId = ref<string | null>(null);
const view = ref<View | null>(null);
const images = ref<Img[]>([]);
const loading = ref(true);
const busy = ref<string | null>(null);
const message = ref("");
const failure = ref("");

const STAGES = [
  { id: "script", label: "剧本", icon: ScrollText },
  { id: "design", label: "视觉设定", icon: Palette },
  { id: "storyboard", label: "分镜", icon: Clapperboard },
  { id: "generate", label: "出图", icon: ImageIcon },
  { id: "timeline", label: "成片", icon: Film },
] as const;
type StageId = (typeof STAGES)[number]["id"];
const stage = ref<StageId>("script");

async function loadList() {
  const r = await send("media/short-drama/list");
  loading.value = false;
  if (!r.ok) return void (failure.value = errText(r));
  projects.value = (val(r).projects || []).map((p: any) => ({ id: p.id, name: p.name, stage: p.stage, updatedAt: p.updatedAt }));
}
async function loadView(id = currentId.value) {
  if (!id) return;
  const r = await send("media/short-drama/get", { projectId: id });
  if (!r.ok) return void (failure.value = errText(r));
  if (id !== currentId.value) return;
  view.value = val(r).project as View;
  images.value = (val(r).images || []) as Img[];
  draft.sourceText = view.value.sourceText;
}
async function open(id: string) {
  currentId.value = id;
  view.value = null;
  failure.value = "";
  message.value = "";
  await loadView(id);
  const v = view.value as View | null;
  if (v) stage.value = (STAGES.some((s) => s.id === v.stage) ? v.stage : "script") as StageId;
}

/* ── 新建 ── */
const creating = ref(false);
const newName = ref("");
async function create() {
  const name = newName.value.trim();
  if (!name) return;
  busy.value = "create";
  const r = await send("media/short-drama/create", { name });
  busy.value = null;
  if (!r.ok) return void (failure.value = errText(r));
  creating.value = false;
  newName.value = "";
  await loadList();
  await open(val(r).project.id);
}

/* ── 通用：执行一步并刷新 ── */
async function step(key: string, command: string, payload: Record<string, unknown>, done: string, next?: StageId) {
  if (!currentId.value || busy.value) return;
  busy.value = key;
  failure.value = "";
  message.value = "";
  const r = await send(command, { projectId: currentId.value, ...payload });
  busy.value = null;
  if (!r.ok) return void (failure.value = errText(r));
  message.value = done;
  await Promise.all([loadView(), loadList()]);
  if (next) stage.value = next;
}

/* ── 1 剧本 ── */
const draft = reactive({ sourceText: "", episodes: 6 });
async function saveSource() {
  if (!view.value || draft.sourceText === view.value.sourceText) return;
  await step("save-source", "media/short-drama/update", { patch: { sourceText: draft.sourceText } }, "剧情素材已保存");
}
async function outline() {
  await saveSource();
  await step("outline", "media/short-drama/outline", { episodeCount: Math.max(1, Math.min(30, Number(draft.episodes) || 6)) }, "已拆解出分集集纲", "script");
}
async function saveEpisode(e: Episode, patch: Partial<Episode>) {
  const bp = view.value?.blueprint;
  if (!bp) return;
  const episodes = bp.episodes.map((x) => {
    const merged = x.id === e.id ? { ...x, ...patch } : x;
    return { ...merged, characterNames: String(merged.characterNames || "").split(/[、,，]/).map((s) => s.trim()).filter(Boolean), locationNames: String(merged.locationNames || "").split(/[、,，]/).map((s) => s.trim()).filter(Boolean) };
  });
  await step("save-ep", "media/short-drama/update", { patch: { blueprint: { logline: bp.logline, tone: bp.tone, episodes } } }, "集纲已保存");
}

/* ── 2 视觉设定 ── */
async function design() {
  await step("design", "media/short-drama/visual-design", {}, "已生成角色与场景设定", "design");
}
async function refImage(kind: "character" | "location", itemId: string) {
  await step("ref:" + itemId, "media/short-drama/visual-image", { kind, itemId }, kind === "character" ? "已生成角色参考图" : "已生成场景参考图");
}

/* ── 3 分镜 ── */
async function storyboards(episodeId?: string) {
  await step("storyboards", "media/short-drama/storyboards", episodeId ? { episodeId } : {}, "已生成分镜", "storyboard");
}
async function addShot() {
  await step("add-shot", "media/short-drama/shot/add", { shot: { title: "镜头 " + ((view.value?.shots.length || 0) + 1), duration: 5 } }, "已添加镜头");
}
async function saveShot(s: Shot, patch: Partial<Shot>) {
  if (!currentId.value) return;
  const r = await send("media/short-drama/shot/update", { projectId: currentId.value, shotId: s.id, patch });
  if (!r.ok) failure.value = errText(r);
  else await loadView();
}

/* ── 4 出图 ── */
async function shotImage(s: Shot) {
  await step("img:" + s.id, "media/short-drama/shot/image", { shotId: s.id }, `「${s.title}」已出图`);
}
async function allImages() {
  for (const s of (view.value?.shots || []).filter((x) => !x.imageCount)) {
    await shotImage(s);
    if (failure.value) break;
  }
}

/* ── 画面预览缓存 ── */
const thumbs = reactive<Record<string, string>>({});
const imageOf = (owner: Img["owner"], ownerId: string, selectedId?: string) => {
  const list = images.value.filter((im) => im.owner === owner && im.ownerId === ownerId);
  return list.find((im) => im.id === selectedId) || list[list.length - 1] || null;
};
async function ensureThumb(im: Img | null) {
  if (!im || thumbs[im.nodeId] || !currentId.value) return;
  thumbs[im.nodeId] = "loading";
  const r = await send("media/short-drama/image", { projectId: currentId.value, nodeId: im.nodeId });
  thumbs[im.nodeId] = r.ok ? String(val(r).dataUrl || "") : "";
}
watch(images, (list) => {
  for (const im of list.slice(-60)) void ensureThumb(im);
});
const thumbOf = (im: Img | null) => (im && thumbs[im.nodeId] && thumbs[im.nodeId] !== "loading" ? thumbs[im.nodeId] : "");

/* ── 5 成片 ── */
const job = ref<{ id: string; status: string; progress: number | null; error: string | null; hasOutput: boolean; outputRelativePath: string | null } | null>(null);
let poll = 0;
async function render() {
  if (!currentId.value || busy.value) return;
  busy.value = "render";
  failure.value = "";
  const r = await send("media/short-drama/render", { projectId: currentId.value });
  busy.value = null;
  if (!r.ok) return void (failure.value = errText(r));
  job.value = val(r).job;
  message.value = `已提交渲染：${val(r).plan?.shotCount ?? "?"} 个镜头，约 ${Math.round((val(r).plan?.durationMs ?? 0) / 1000)} 秒`;
  window.clearInterval(poll);
  poll = window.setInterval(async () => {
    if (!job.value) return;
    const g = await send("media/render/get", { jobId: job.value.id });
    if (g.ok) job.value = val(g).job;
    if (!job.value || ["completed", "failed", "cancelled"].includes(job.value.status)) window.clearInterval(poll);
  }, 1500);
}
const JOB: Record<string, string> = { queued: "排队中", running: "渲染中", completed: "已完成", failed: "失败", cancelled: "已取消" };
const readyShots = computed(() => (view.value?.shots || []).filter((s) => s.imageCount > 0));

const stageDone = (id: StageId) => {
  const v = view.value;
  if (!v) return false;
  if (id === "script") return !!v.blueprint?.episodes.length;
  if (id === "design") return !!v.visualDesign;
  if (id === "storyboard") return v.shots.length > 0;
  if (id === "generate") return v.shots.length > 0 && readyShots.value.length === v.shots.length;
  return !!job.value?.hasOutput;
};
const epTitle = (id?: string) => view.value?.blueprint?.episodes.find((e) => e.id === id)?.title || "";

onMounted(loadList);
onBeforeUnmount(() => window.clearInterval(poll));
</script>

<template>
  <div class="split drama-app" data-drama-app>
    <nav class="split-side" aria-label="短剧项目">
      <div class="split-section dr-side-head">
        <span>项目</span>
        <button class="icon-button" aria-label="新建项目" title="新建项目" data-drama-new @click="creating = true"><Plus :size="14" /></button>
      </div>
      <button
        v-for="p in projects"
        :key="p.id"
        class="split-nav"
        :aria-current="currentId === p.id ? 'true' : undefined"
        :data-drama-project="p.id"
        @click="open(p.id)"
      >
        <Film :size="16" /> <span class="split-nav-label">{{ p.name }}</span>
      </button>
      <p v-if="!projects.length && !loading" class="planned-note">还没有项目。</p>
      <template v-if="view">
        <div class="split-section">流程</div>
        <button
          v-for="(s, i) in STAGES"
          :key="s.id"
          class="split-nav"
          :aria-current="stage === s.id ? 'true' : undefined"
          :data-drama-stage="s.id"
          @click="stage = s.id"
        >
          <component :is="s.icon" :size="16" /> <span class="split-nav-label">{{ i + 1 }}. {{ s.label }}</span>
          <small v-if="stageDone(s.id)" class="planned-count">✓</small>
        </button>
      </template>
      <p class="planned-note">AI 步骤使用「系统设置 › 模型与服务商」里的默认模型；每一步的结果都可以手动修改。</p>
    </nav>

    <div class="split-main dr-main">
      <div class="pane-toolbar">
        <strong class="pane-title">{{ view ? view.name : "短剧工坊" }}</strong>
        <small v-if="view" class="dr-crumb">{{ STAGES.find((s) => s.id === stage)?.label }}</small>
        <div class="toolbar-spacer" />
      </div>
      <p v-if="message" class="vd-msg sk-msg" role="status">{{ message }}</p>
      <p v-if="failure" class="vd-msg sk-msg err" role="alert" data-drama-error>{{ failure }}</p>

      <div v-if="!bridge" class="empty-content">
        <h2 class="planned-title">媒体服务未接入</h2>
      </div>
      <div v-else-if="!view" class="empty-content">
        <img class="large-icon" :src="iconUrl('drama')" alt="" draggable="false" />
        <h2 class="planned-title">短剧工坊</h2>
        <p>从一段剧情素材开始：AI 拆解分集集纲，设计角色与场景，生成分镜和画面，最后拼成竖屏短片。</p>
        <button class="planned-cta" @click="creating = true"><Plus :size="14" /> 新建项目</button>
      </div>

      <!-- 1 剧本 -->
      <section v-else-if="stage === 'script'" class="dr-body" data-drama-panel="script">
        <label class="dr-field">
          <span>剧情素材（小说片段、故事梗概或已有剧本，至少 30 字）</span>
          <textarea v-model="draft.sourceText" rows="9" placeholder="把故事贴在这里…" @blur="saveSource" />
        </label>
        <div class="dr-bar">
          <label class="dr-inline">分成<input v-model.number="draft.episodes" type="number" min="1" max="30" />集</label>
          <button class="planned-cta sk-btn" :disabled="!!busy || draft.sourceText.trim().length < 30" data-drama-outline @click="outline">
            <component :is="busy === 'outline' ? LoaderCircle : Sparkles" :size="13" :class="{ spin: busy === 'outline' }" /> AI 拆解集纲
          </button>
          <span class="set-cap">{{ draft.sourceText.trim().length }} 字</span>
        </div>
        <template v-if="view.blueprint">
          <div class="dr-card">
            <h3>{{ view.blueprint.logline || "（没有卖点）" }}</h3>
            <p class="set-cap">基调：{{ view.blueprint.tone || "—" }} · 来源：{{ view.blueprint.model || "—" }}</p>
          </div>
          <div v-for="e in view.blueprint.episodes" :key="e.id" class="dr-card dr-ep">
            <input class="dr-title" :value="e.title" aria-label="集名" @change="saveEpisode(e, { title: ($event.target as HTMLInputElement).value })" />
            <textarea :value="e.summary" rows="3" aria-label="本集剧情" @change="saveEpisode(e, { summary: ($event.target as HTMLTextAreaElement).value })" />
            <p class="set-cap">结尾钩子：{{ e.hook || "—" }}　出场：{{ e.characterNames || "—" }}　场景：{{ e.locationNames || "—" }}</p>
          </div>
          <div class="dr-next"><button class="planned-today" @click="stage = 'design'">下一步：视觉设定 →</button></div>
        </template>
      </section>

      <!-- 2 视觉设定 -->
      <section v-else-if="stage === 'design'" class="dr-body" data-drama-panel="design">
        <div class="dr-bar">
          <button class="planned-cta sk-btn" :disabled="!!busy || !view.blueprint?.episodes.length" data-drama-design @click="design">
            <component :is="busy === 'design' ? LoaderCircle : Sparkles" :size="13" :class="{ spin: busy === 'design' }" /> {{ view.visualDesign ? "重新生成设定" : "AI 生成角色与场景" }}
          </button>
          <span v-if="!view.blueprint?.episodes.length" class="set-cap">先在「剧本」里拆出集纲。</span>
        </div>
        <template v-if="view.visualDesign">
          <p class="set-cap">整体风格：{{ view.visualDesign.style || "—" }}</p>
          <div class="split-section">角色</div>
          <div class="dr-grid">
            <div v-for="c in view.visualDesign.characters" :key="c.id" class="dr-card dr-item">
              <div class="dr-thumb">
                <img v-if="thumbOf(imageOf('character', c.id, c.selectedImageId))" :src="thumbOf(imageOf('character', c.id, c.selectedImageId))" alt="" />
                <span v-else>{{ c.imageCount ? "加载中…" : "暂无参考图" }}</span>
              </div>
              <h3>{{ c.name }}</h3>
              <p class="set-cap">{{ c.role }}</p>
              <p class="dr-desc">{{ c.appearance }}<br />服装：{{ c.costume }}</p>
              <button class="planned-today" :disabled="!!busy" @click="refImage('character', c.id)">
                <component :is="busy === 'ref:' + c.id ? LoaderCircle : ImageIcon" :size="12" :class="{ spin: busy === 'ref:' + c.id }" /> 生成参考图
              </button>
            </div>
          </div>
          <div class="split-section">场景</div>
          <div class="dr-grid">
            <div v-for="l in view.visualDesign.locations" :key="l.id" class="dr-card dr-item">
              <div class="dr-thumb">
                <img v-if="thumbOf(imageOf('location', l.id, l.selectedImageId))" :src="thumbOf(imageOf('location', l.id, l.selectedImageId))" alt="" />
                <span v-else>{{ l.imageCount ? "加载中…" : "暂无参考图" }}</span>
              </div>
              <h3>{{ l.name }}</h3>
              <p class="dr-desc">{{ l.atmosphere }}<br />{{ l.visual }}</p>
              <button class="planned-today" :disabled="!!busy" @click="refImage('location', l.id)">
                <component :is="busy === 'ref:' + l.id ? LoaderCircle : ImageIcon" :size="12" :class="{ spin: busy === 'ref:' + l.id }" /> 生成参考图
              </button>
            </div>
          </div>
          <div class="dr-next"><button class="planned-today" @click="stage = 'storyboard'">下一步：分镜 →</button></div>
        </template>
      </section>

      <!-- 3 分镜 -->
      <section v-else-if="stage === 'storyboard'" class="dr-body" data-drama-panel="storyboard">
        <div class="dr-bar">
          <button class="planned-cta sk-btn" :disabled="!!busy || !view.visualDesign" data-drama-storyboards @click="storyboards()">
            <component :is="busy === 'storyboards' ? LoaderCircle : Sparkles" :size="13" :class="{ spin: busy === 'storyboards' }" /> AI 生成全部分镜
          </button>
          <button class="planned-today" :disabled="!!busy" data-drama-add-shot @click="addShot"><Plus :size="12" /> 手动添加镜头</button>
          <span v-if="!view.visualDesign" class="set-cap">AI 分镜需要先完成视觉设定；也可以手动添加。</span>
        </div>
        <p v-if="!view.shots.length" class="set-cap">还没有分镜。</p>
        <div v-for="(s, i) in view.shots" :key="s.id" class="dr-card dr-shot" :data-drama-shot="s.id">
          <div class="dr-shot-head">
            <span class="badge">{{ i + 1 }}</span>
            <input class="dr-title" :value="s.title" aria-label="镜头标题" @change="saveShot(s, { title: ($event.target as HTMLInputElement).value })" />
            <small v-if="epTitle(s.episodeId)" class="set-cap">{{ epTitle(s.episodeId) }}</small>
            <label class="dr-inline">时长<input type="number" min="1" max="30" :value="s.duration" @change="saveShot(s, { duration: Number(($event.target as HTMLInputElement).value) })" />秒</label>
          </div>
          <input :value="s.scene" placeholder="场景" aria-label="场景" @change="saveShot(s, { scene: ($event.target as HTMLInputElement).value })" />
          <textarea :value="s.script" rows="2" placeholder="台词 / 动作" aria-label="台词与动作" @change="saveShot(s, { script: ($event.target as HTMLTextAreaElement).value })" />
          <textarea :value="s.prompt" rows="2" placeholder="画面提示词（出图用）" aria-label="画面提示词" @change="saveShot(s, { prompt: ($event.target as HTMLTextAreaElement).value })" />
        </div>
        <div v-if="view.shots.length" class="dr-next"><button class="planned-today" @click="stage = 'generate'">下一步：出图 →</button></div>
      </section>

      <!-- 4 出图 -->
      <section v-else-if="stage === 'generate'" class="dr-body" data-drama-panel="generate">
        <div class="dr-bar">
          <button class="planned-cta sk-btn" :disabled="!!busy || !view.shots.length" data-drama-all-images @click="allImages">
            <Sparkles :size="13" /> 为没有画面的镜头出图（{{ view.shots.filter((s) => !s.imageCount).length }}）
          </button>
          <span class="set-cap">{{ readyShots.length }} / {{ view.shots.length }} 个镜头已有画面</span>
        </div>
        <div class="dr-grid dr-frames">
          <div v-for="(s, i) in view.shots" :key="s.id" class="dr-card dr-item">
            <div class="dr-thumb tall">
              <img v-if="thumbOf(imageOf('shot', s.id, s.selectedImageId))" :src="thumbOf(imageOf('shot', s.id, s.selectedImageId))" alt="" />
              <span v-else>{{ s.imageCount ? "加载中…" : "还没有画面" }}</span>
            </div>
            <h3>{{ i + 1 }}. {{ s.title }}</h3>
            <p class="set-cap">{{ s.duration }} 秒 · {{ s.imageCount }} 张</p>
            <button class="planned-today" :disabled="!!busy" @click="shotImage(s)">
              <component :is="busy === 'img:' + s.id ? LoaderCircle : ImageIcon" :size="12" :class="{ spin: busy === 'img:' + s.id }" /> {{ s.imageCount ? "重新出图" : "出图" }}
            </button>
          </div>
        </div>
        <div v-if="readyShots.length" class="dr-next"><button class="planned-today" @click="stage = 'timeline'">下一步：成片 →</button></div>
      </section>

      <!-- 5 成片 -->
      <section v-else class="dr-body" data-drama-panel="timeline">
        <p class="set-cap">按分镜顺序把已有画面的镜头拼成竖屏短片，用本机 FFmpeg 渲染。没有画面的镜头会被跳过。</p>
        <div class="dr-strip">
          <div v-for="s in readyShots" :key="s.id" class="dr-strip-item" :style="{ flexGrow: s.duration }">
            <img v-if="thumbOf(imageOf('shot', s.id, s.selectedImageId))" :src="thumbOf(imageOf('shot', s.id, s.selectedImageId))" alt="" />
            <small>{{ s.duration }}s</small>
          </div>
          <p v-if="!readyShots.length" class="set-cap">还没有出过图的镜头。</p>
        </div>
        <div class="dr-bar">
          <button class="planned-cta sk-btn" :disabled="!!busy || !readyShots.length || (!!job && ['queued', 'running'].includes(job.status))" data-drama-render @click="render">
            <component :is="busy === 'render' ? LoaderCircle : Film" :size="13" :class="{ spin: busy === 'render' }" /> 渲染成片
          </button>
          <span v-if="job" class="sk-run-state" :data-tone="job.status === 'completed' ? 'success' : job.status === 'failed' ? 'danger' : 'neutral'" data-drama-job>
            {{ JOB[job.status] || job.status }}{{ job.progress != null && job.status === "running" ? " " + Math.round(job.progress * (job.progress <= 1 ? 100 : 1)) + "%" : "" }}
          </span>
          <span v-if="job?.error" class="vd-msg sk-msg err">{{ job.error }}</span>
          <span v-if="job?.hasOutput" class="set-cap">已生成 {{ job.outputRelativePath }}（保存在 OpenArc 媒体目录）</span>
        </div>
      </section>
    </div>

    <DsDialog :open="creating" title="新建短剧项目" @close="creating = false">
      <div class="sk-form">
        <label>项目名称<input v-model="newName" maxlength="50" placeholder="例如：重生之我在横店当群演" data-drama-name @keydown.enter.prevent="create" /></label>
      </div>
      <template #footer>
        <button @click="creating = false">取消</button>
        <button class="primary" :disabled="!newName.trim() || busy === 'create'" data-drama-create @click="create">创建</button>
      </template>
    </DsDialog>
  </div>
</template>
