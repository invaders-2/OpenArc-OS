<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { Download, Package, Pencil, Play, Plus, Store, Trash2, User, X } from "lucide-vue-next";
import { iconUrl } from "../apps";
import { useShellStore } from "../stores/shell";
import DsDialog from "../design-system/DsDialog.vue";

/**
 * Skill 中心（10-15，按原型 + PLAN §12）：
 *   · 我的技能 —— 真实的 SKILL.md 文件，存在桌面「Skill」文件夹（访达里可见、可拖走、可删除），
 *     格式遵循 Agent Skills（YAML frontmatter name / description + 正文步骤），保持技能包兼容；
 *   · 已安装 —— 同一批技能的启停（停用只影响新任务；状态存本机 oa-skill-disabled）；
 *   · 试运行 —— 以技能内容发起一个普通任务（task/run），模型 / 权限 / 写操作确认仍由主进程决定；
 *   · 导入 —— 把访达里其它位置带 frontmatter 的 .md 复制进「Skill」文件夹；
 *   · 市场 —— 受管理目录与团队发布需要市场后台，尚未接入，如实显示空态。
 */
type Skill = { key: string; folderId: string; id: string; file: string; name: string; desc: string; steps: string[]; mtime: number };
const shell = useShellStore();
const files = window.openarc?.files;
const task = window.openarc?.task;
const tab = ref<"market" | "mine" | "installed">("mine");
const skills = ref<Skill[]>([]);
const loading = ref(false);
const message = ref("");
const DIS = "oa-skill-disabled";
const disabled = ref<Set<string>>(
  new Set(
    (() => {
      try {
        const v = JSON.parse(localStorage.getItem(DIS) || "[]");
        return Array.isArray(v) ? v : [];
      } catch {
        return [];
      }
    })(),
  ),
);
function saveDisabled() {
  try {
    localStorage.setItem(DIS, JSON.stringify([...disabled.value]));
  } catch {
    /* 存储不可用 */
  }
}

/* ── SKILL.md 读写 ── */
function parse(text: string): { name: string; desc: string; steps: string[] } | null {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) return null;
  const fm = Object.fromEntries(
    m[1].split("\n").map((l) => {
      const i = l.indexOf(":");
      return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")] : ["", ""];
    }),
  );
  if (!fm.name) return null;
  const steps = [...m[2].matchAll(/^\s*\d+[.、)]\s+(.+)$/gm)].map((x) => x[1].trim());
  return { name: fm.name, desc: fm.description || "", steps };
}
function serialize(name: string, desc: string, steps: string[]) {
  const q = (v: string) => (/[:#"'\n]/.test(v) ? JSON.stringify(v) : v);
  return [
    "---",
    `name: ${q(name)}`,
    `description: ${q(desc || name)}`,
    "---",
    "",
    `# ${name}`,
    "",
    desc,
    "",
    "## 步骤",
    "",
    ...steps.filter((s) => s.trim()).map((s, i) => `${i + 1}. ${s.trim()}`),
    "",
  ].join("\n");
}

const skillFolder = () => shell.folders.find((f) => !f.parentId && f.name === "Skill") ?? null;
async function load() {
  if (!files) return;
  loading.value = true;
  const out: Skill[] = [];
  const folder = skillFolder();
  if (folder) {
    const res = await files.list(folder.id).catch(() => null);
    for (const e of res?.entries ?? []) {
      if (!/^md$/i.test(e.ext)) continue;
      const r = await files.read?.(folder.id, e.id).catch(() => null);
      const p = r?.text ? parse(r.text) : null;
      if (p) out.push({ key: folder.id + "/" + e.id, folderId: folder.id, id: e.id, file: e.name, ...p, mtime: e.mtime ?? 0 });
    }
  }
  skills.value = out.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  loading.value = false;
}
const enabled = (s: Skill) => !disabled.value.has(s.key);
function toggle(s: Skill) {
  if (enabled(s)) disabled.value.add(s.key);
  else disabled.value.delete(s.key);
  disabled.value = new Set(disabled.value);
  saveDisabled();
}

/* ── 新建 / 编辑 ── */
const editor = ref(false);
const editing = ref<Skill | null>(null);
const form = reactive({ name: "", desc: "", steps: [] as { k: number; t: string }[] });
let k = 0;
function openEditor(s: Skill | null) {
  editing.value = s;
  form.name = s?.name ?? "";
  form.desc = s?.desc ?? "";
  form.steps = (s?.steps.length ? s.steps : ["读取输入与参考", "按要求处理", "检查结果是否符合要求"]).map((t) => ({ k: ++k, t }));
  editor.value = true;
}
async function save() {
  if (!files?.writeText || !form.name.trim()) return;
  const text = serialize(form.name.trim(), form.desc.trim(), form.steps.map((s) => s.t));
  const folder = editing.value ? null : shell.ensureFolder("Skill");
  const r = editing.value
    ? await files.writeText(editing.value.folderId, editing.value.id, "", text).catch(() => null)
    : await files.writeText(folder!.id, null, form.name.trim() + ".md", text).catch(() => null);
  if (!r?.ok) {
    message.value = "保存失败：" + (r?.error ?? "写入出错");
    return;
  }
  editor.value = false;
  message.value = editing.value ? `已保存「${form.name}」` : `已新建「${form.name}」，文件在桌面「Skill」文件夹`;
  await load();
}
async function remove(s: Skill) {
  const r = await files?.trash?.(s.folderId, s.id).catch(() => null);
  if (r?.ok) {
    message.value = `「${s.name}」已移到回收站，可以恢复`;
    void shell.refreshTrashState?.();
    await load();
  }
}

/* ── 试运行：以技能内容发起普通任务 ── */
async function trial(s: Skill) {
  if (!task || !enabled(s)) return;
  const goal = [`请按照 Skill「${s.name}」执行。`, s.desc ? `用途：${s.desc}` : "", "步骤：", ...s.steps.map((t, i) => `${i + 1}. ${t}`)]
    .filter(Boolean)
    .join("\n");
  const r = await task.command({ command: "task/run", payload: { goal } }).catch(() => null);
  if (r?.ok) {
    shell.notify({ appId: "skills", title: `已试运行：${s.name}`, body: "已作为任务交给助理，结果可在「对话」里查看。" });
    shell.activateApp("chat");
  } else {
    message.value =
      r?.error === "MODEL_CONFIG_UNAVAILABLE" ? "没有可用的文本模型：请先在「系统设置 › 模型 / AI」里配置。" : `试运行被拒绝（${r?.error ?? "任务运行时不可用"}）`;
  }
}

/* ── 导入：访达里其它位置的 SKILL.md ── */
const importing = ref(false);
const candidates = ref<{ key: string; folderId: string; id: string; name: string; skill: string; folder: string }[]>([]);
async function openImport() {
  if (!files) return;
  importing.value = true;
  const out: typeof candidates.value = [];
  const skillId = skillFolder()?.id;
  for (const fid of ["desktop", ...shell.folders.map((f) => f.id)]) {
    if (fid === skillId) continue;
    const res = await files.list(fid).catch(() => null);
    for (const e of res?.entries ?? []) {
      if (!/^md$/i.test(e.ext)) continue;
      const r = await files.read?.(fid, e.id).catch(() => null);
      const p = r?.text ? parse(r.text) : null;
      if (p) out.push({ key: fid + "/" + e.id, folderId: fid, id: e.id, name: e.name, skill: p.name, folder: fid === "desktop" ? "桌面" : shell.folders.find((f) => f.id === fid)?.name ?? "文件夹" });
    }
  }
  candidates.value = out;
}
async function importOne(c: (typeof candidates.value)[number]) {
  const folder = shell.ensureFolder("Skill");
  const r = await files?.copy?.(c.folderId, [c.id], folder.id).catch(() => null);
  if (r?.ok) {
    candidates.value = candidates.value.filter((x) => x.key !== c.key);
    message.value = `已导入「${c.skill}」`;
    await load();
  }
}

const title = computed(() => ({ market: "Skill 市场", mine: "我的技能", installed: "已安装" })[tab.value]);
onMounted(load);
</script>

<template>
  <div class="split skills-app">
    <nav class="split-side" aria-label="Skill 分类">
      <div class="split-section">Skill</div>
      <button class="split-nav" :aria-current="tab === 'market' ? 'true' : undefined" @click="tab = 'market'">
        <Store :size="16" /> <span class="split-nav-label">市场</span>
      </button>
      <button class="split-nav" :aria-current="tab === 'mine' ? 'true' : undefined" @click="tab = 'mine'">
        <User :size="16" /> <span class="split-nav-label">我的技能</span><small class="planned-count">{{ skills.length }}</small>
      </button>
      <div class="split-section">本机</div>
      <button class="split-nav" :aria-current="tab === 'installed' ? 'true' : undefined" @click="tab = 'installed'">
        <Package :size="16" /> <span class="split-nav-label">已安装</span>
        <small class="planned-count">{{ skills.filter(enabled).length }}</small>
      </button>
      <p class="planned-note">Skill 描述做事的方法与步骤；安装或启用不会自动获得应用、设备或文件权限。</p>
    </nav>
    <div class="split-main sk-main">
      <div class="pane-toolbar">
        <strong class="pane-title">{{ title }}</strong>
        <div class="toolbar-spacer" />
        <button class="planned-today sk-btn" @click="openImport"><Download :size="13" /> 导入</button>
        <button class="planned-cta sk-btn" :disabled="!files" @click="openEditor(null)"><Plus :size="13" /> 新建 Skill</button>
      </div>
      <p v-if="message" class="vd-msg sk-msg">{{ message }}</p>

      <div v-if="tab === 'market'" class="empty-content">
        <img class="large-icon" :src="iconUrl('shortcuts')" alt="" draggable="false" />
        <h2 class="planned-title">Skill 市场尚未接入</h2>
        <p>受管理的技能目录、团队发布、版本与更新需要市场后台。现在可以新建自己的 Skill，或从访达导入 SKILL.md。</p>
      </div>

      <div v-else class="sk-body">
        <p v-if="!skills.length && !loading" class="set-cap">
          还没有 Skill。把常做的事写成步骤，助理就能照着做；文件会存为桌面「Skill」文件夹里的 SKILL.md。
        </p>
        <div v-if="skills.length" class="set-group">
          <div v-for="s in skills" :key="s.key" class="setting-row sk-row" :class="{ off: !enabled(s) }">
            <span class="sk-ico"><Pencil :size="15" /></span>
            <span class="set-lab">
              {{ s.name }}
              <small>{{ s.desc || "—" }} · {{ s.steps.length }} 个步骤 · {{ s.file }}</small>
            </span>
            <template v-if="tab === 'mine'">
              <button class="planned-today" :disabled="!enabled(s)" :title="enabled(s) ? '以这个 Skill 发起一个任务' : '已停用'" @click="trial(s)">
                <Play :size="12" /> 试运行
              </button>
              <button class="planned-today" @click="openEditor(s)">编辑</button>
              <button class="icon-button" :aria-label="'删除 ' + s.name" title="移到回收站" @click="remove(s)"><Trash2 :size="14" /></button>
            </template>
            <span v-else class="au-switch" role="switch" :aria-checked="enabled(s)" :aria-label="(enabled(s) ? '停用 ' : '启用 ') + s.name" tabindex="0" @click="toggle(s)" @keydown.enter="toggle(s)" />
          </div>
        </div>
        <p v-if="tab === 'installed' && skills.length" class="set-cap">停用只影响之后发起的任务；已经在运行的任务继续使用原来的版本。</p>
      </div>
    </div>

    <DsDialog :open="editor" :title="editing ? '编辑 Skill' : '新建 Skill'" @close="editor = false">
      <div class="sk-form">
        <label>名称<input v-model="form.name" placeholder="例如：门店海报批量生成" /></label>
        <label>用途说明<input v-model="form.desc" placeholder="一句话说明它做什么" /></label>
        <div class="sk-steps">
          <span>步骤</span>
          <div v-for="(st, i) in form.steps" :key="st.k" class="sk-step">
            <span class="badge">{{ i + 1 }}</span>
            <input v-model="st.t" :aria-label="'步骤 ' + (i + 1)" />
            <button class="icon-button" :aria-label="'删除步骤 ' + (i + 1)" @click="form.steps.splice(i, 1)"><X :size="13" /></button>
          </div>
          <button class="planned-today sk-add" @click="form.steps.push({ k: Date.now(), t: '' })"><Plus :size="12" /> 添加步骤</button>
        </div>
      </div>
      <template #footer>
        <button @click="editor = false">取消</button>
        <button class="primary" :disabled="!form.name.trim()" @click="save">保存</button>
      </template>
    </DsDialog>

    <DsDialog :open="importing" title="从访达导入 Skill" @close="importing = false">
      <p v-if="!candidates.length" class="set-cap">访达里没有找到带 frontmatter（name / description）的 SKILL.md。</p>
      <div v-for="c in candidates" :key="c.key" class="sk-cand">
        <span class="set-lab">{{ c.skill }}<small>{{ c.name }} · {{ c.folder }}</small></span>
        <button class="planned-today" @click="importOne(c)">导入</button>
      </div>
    </DsDialog>
  </div>
</template>
