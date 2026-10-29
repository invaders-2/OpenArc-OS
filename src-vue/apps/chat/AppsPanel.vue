<script setup lang="ts">
import { computed, ref } from "vue";
import { Brain, ExternalLink, Globe, Search, ShieldCheck } from "lucide-vue-next";
import { useShellStore } from "../../stores/shell";
import { appById, iconUrl } from "../../apps";

/**
 * 对话里的「应用」（对标 ChatGPT Apps / Claude 连接的应用）：列出全局 AI 能直接操作的 OpenArc 应用，
 * 写清楚 AI 能做什么、哪些动作要你批准（与 dsh-tool-profile 的读 / 写工具分组一致），
 * 「在对话中试试」= 新开对话并填好一句示例，「打开应用」= 切到那个应用。
 */
const emit = defineEmits<{ try: [prompt: string] }>();
const shell = useShellStore();

/** [显示名, 工具 id]：工具 id 与 electron/dsh-tool-profile.cjs 的读 / 写分组一一对应（测试会核对）。 */
type Cap = [label: string, toolId: string];
type AppCard = { key: string; appId?: string; name: string; icon?: "globe" | "brain"; blurb: string; reads: Cap[]; writes: Cap[]; example: string };
const CARDS: AppCard[] = [
  { key: "resource-library", appId: "resource-library", name: "资源库", blurb: "找资料、读文件内容，把对话结果存成文稿。", reads: [["搜索资源", "resource.search"], ["读取元数据和内容", "resource.read.content"]], writes: [["保存文本", "resource.save.text"], ["移到回收站", "resource.trash"]], example: "在资源库里找一下最近关于产品发布的资料，帮我总结要点。" },
  { key: "browser", appId: "browser", name: "浏览器", blurb: "读你正在看的网页，帮你总结或者跳到别的页面。", reads: [["读取当前页面", "browser.read.page"]], writes: [["打开网址", "browser.navigate"]], example: "总结一下浏览器里当前页面的主要内容。" },
  { key: "canvas", appId: "canvas", name: "AI Studio 画布", blurb: "看画布上有什么，改节点，或者直接生成图片。", reads: [["读取画布", "canvas.read"], ["列出画布", "canvas.list"]], writes: [["编辑画布", "canvas.edit"], ["生成图片", "canvas.generate.image"]], example: "看看我的 AI Studio 画布上现在有哪些节点。" },
  { key: "workspace", appId: "files", name: "工作文件夹", blurb: "在你选的文件夹里查找、阅读文件，写文件和跑命令前会先问你。", reads: [["列出文件", "workspace.list"], ["读取文件", "workspace.read"], ["搜索内容", "workspace.search"]], writes: [["写入文件", "workspace.write"], ["执行命令", "workspace.exec"]], example: "列出工作文件夹里的文件，告诉我这个项目大概是做什么的。" },
  { key: "web", name: "联网", icon: "globe", blurb: "搜索网页、读取链接内容，回答时附上来源。", reads: [["网页搜索", "web.search"], ["读取网页", "web.fetch"]], writes: [], example: "搜一下今天的科技新闻，挑三条最重要的讲给我听。" },
  { key: "memory", name: "记忆", icon: "brain", blurb: "记住你交代的偏好和事实，以后的对话会用到。", reads: [["保存记忆", "memory.save"], ["查找记忆", "memory.search"]], writes: [], example: "记住：我写周报喜欢用三段式，先结论后细节。" },
];

const query = ref("");
const shown = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return CARDS;
  return CARDS.filter((c) => [c.name, c.blurb, ...c.reads.map((x) => x[0]), ...c.writes.map((x) => x[0])].join(" ").toLowerCase().includes(q));
});
const iconOf = (c: AppCard) => (c.appId ? iconUrl(appById(c.appId)?.icon || "apps") : "");
</script>

<template>
  <div class="capp" data-chat-apps>
    <div class="pane-toolbar capp-toolbar">
      <strong class="pane-title capp-title">应用</strong>
      <div class="toolbar-spacer" />
      <label class="capp-search"><Search :size="14" /><input v-model="query" type="search" placeholder="搜索" aria-label="搜索应用" data-capp-search /></label>
    </div>
    <div class="capp-scroll">
      <div class="capp-col">
        <div class="capp-head">
          <h2>AI 能帮你操作这些应用</h2>
          <p>在对话里直接说要做什么就行，AI 会自己挑合适的应用。读取类的动作直接做；会改动内容的动作，每次都会先停下来等你批准。</p>
        </div>
        <div class="capp-grid">
          <article v-for="c in shown" :key="c.key" class="capp-card" :data-capp-card="c.key">
            <header>
              <img v-if="c.appId" class="capp-ic" :src="iconOf(c)" alt="" draggable="false" />
              <span v-else class="capp-ic capp-ic-glyph"><Globe v-if="c.icon === 'globe'" :size="20" /><Brain v-else :size="20" /></span>
              <span class="capp-name"><b>{{ c.name }}</b><small>{{ c.blurb }}</small></span>
            </header>
            <div class="capp-caps">
              <span v-for="r in c.reads" :key="r[1]" class="capp-cap" :data-capp-tool="r[1]">{{ r[0] }}</span>
              <span v-for="w in c.writes" :key="w[1]" class="capp-cap capp-cap-ask" :data-capp-tool="w[1]" :title="w[0] + '：每次都要你批准'"><ShieldCheck :size="11" />{{ w[0] }}</span>
            </div>
            <footer>
              <button type="button" class="capp-btn primary" :data-capp-try="c.key" @click="emit('try', c.example)">在对话中试试</button>
              <button v-if="c.appId" type="button" class="capp-btn" :data-capp-open="c.key" @click="shell.activateApp(c.appId)"><ExternalLink :size="12" />打开应用</button>
            </footer>
          </article>
        </div>
        <p v-if="!shown.length" class="capp-empty">没有匹配的应用。</p>
        <p class="capp-note"><ShieldCheck :size="12" />带盾牌标记的动作会改动内容，AI 提出后要你点「批准」才会执行。</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.capp { position: relative; flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.capp-toolbar { gap: 8px; height: 52px; margin: 0; padding: 0 12px 0 20px; flex: none; }
.capp-title { font-size: var(--fs-headline); }
.capp-search { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px; border-radius: var(--radius-pill); background: rgb(var(--text-rgb) / 0.05); color: var(--muted); }
.capp-search input { width: 160px; border: 0; outline: 0; background: none; color: var(--text); font: inherit; font-size: var(--fs-caption); }
.capp-scroll { flex: 1; min-height: 0; overflow: auto; padding: 20px 24px 32px; }
.capp-col { max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; gap: 10px; }
.capp-head h2 { margin: 6px 0 4px; font-size: var(--fs-title); font-weight: var(--fw-medium); }
.capp-head p { margin: 0 0 8px; color: var(--muted); font-size: var(--fs-secondary); line-height: var(--lh-relaxed); }
.capp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
.capp-card { display: flex; flex-direction: column; gap: 12px; padding: 14px; border-radius: var(--radius-lg); background: rgb(var(--content-rgb)); box-shadow: inset 0 0 0 0.5px var(--line), 0 1px 2px rgb(0 0 0 / 0.04); }
.capp-card header { display: flex; align-items: flex-start; gap: 12px; }
.capp-ic { flex: none; width: 40px; height: 40px; border-radius: 10px; }
.capp-ic-glyph { display: grid; place-items: center; background: rgb(var(--text-rgb) / 0.06); color: var(--text); }
.capp-name { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.capp-name b { font-size: var(--fs-secondary); font-weight: var(--fw-medium); }
.capp-name small { color: var(--muted); font-size: var(--fs-caption); line-height: 1.5; }
.capp-caps { display: flex; flex-wrap: wrap; gap: 5px; }
.capp-cap { display: inline-flex; align-items: center; gap: 3px; padding: 2px 8px; border-radius: var(--radius-pill); background: rgb(var(--text-rgb) / 0.05); color: var(--muted); font-size: var(--fs-micro, 11px); }
.capp-cap-ask { background: rgb(255 149 0 / 0.1); color: rgb(176 96 0); }
.capp-card footer { display: flex; gap: 6px; margin-top: auto; }
.capp-btn { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 11px; border-radius: var(--radius-pill); font-size: var(--fs-caption); color: var(--text); box-shadow: inset 0 0 0 0.5px var(--line); }
.capp-btn:hover { background: rgb(var(--text-rgb) / 0.05); }
.capp-btn.primary { background: var(--text); color: rgb(var(--content-rgb)); box-shadow: none; }
.capp-btn.primary:hover { opacity: 0.88; background: var(--text); }
.capp-empty { margin: 6px 2px; color: var(--muted); font-size: var(--fs-caption); }
.capp-note { display: flex; align-items: center; gap: 5px; margin: 6px 2px 0; color: var(--muted); font-size: var(--fs-caption); }
</style>
