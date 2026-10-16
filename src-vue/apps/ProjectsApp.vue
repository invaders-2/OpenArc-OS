<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import DsButton from "../design-system/DsButton.vue";
import ResourcePicker from "./ResourcePicker.vue";
import { Folder, Plus } from "lucide-vue-next";
import { iconUrl } from "../apps";

/**
 * D3-04D · Projects（对齐 src/governance/ProjectsApp.tsx，逐段迁移）。
 *
 * 只引用 ResourceRef，逐资源重新授权；上行只经 window.openarc.resource.command。
 * class / data-* / DOM 结构与 React 逐项一致。
 */
type ResBridge = { command: (c: Record<string, unknown>) => Promise<any> };

const bridge = (): ResBridge | undefined => (window as any).openarc?.resource;

const projects = ref<any[]>([]);
const projectId = ref<string | null>(null);
const resources = ref<any[]>([]);
const name = ref("");
const picking = ref(false);
const error = ref<string | null>(null);

async function cmd(payload: Record<string, unknown>): Promise<any> {
  const b = bridge();
  if (!b) return { ok: false, error: "NO_BRIDGE" };
  try {
    return await b.command(payload);
  } catch {
    return { ok: false, error: "INTERNAL_ERROR" };
  }
}

async function loadProjects() {
  const res = await cmd({ type: "resource/listProjects" });
  if (res.ok) projects.value = Array.isArray(res.items) ? res.items : [];
  else error.value = res.error;
}

async function loadResources(id: string) {
  const res = await cmd({ type: "resource/listProjectResources", projectId: id });
  if (res.ok) resources.value = Array.isArray(res.items) ? res.items : [];
  else error.value = res.error;
}

onMounted(() => {
  void loadProjects();
});

async function create() {
  const res = await cmd({ type: "resource/createProject", name: name.value || "未命名项目" });
  if (res.ok) {
    name.value = "";
    await loadProjects();
    projectId.value = res.project.id;
    await loadResources(res.project.id);
  } else {
    error.value = res.error;
  }
}

async function selectProject(id: string) {
  projectId.value = id;
  void loadResources(id);
}

const current = computed(() => projects.value.find((p) => p.id === projectId.value) ?? null);
const bridgeReady = !!bridge();
const ERR: Record<string, string> = { NO_BRIDGE: "项目服务只在 OpenArc 桌面应用里可用。", INTERNAL_ERROR: "项目服务暂时不可用。", FORBIDDEN: "没有权限执行这个操作。" };
const errText = (e: string) => ERR[e] ?? `操作被拒绝（${e}）`;

async function addResource(ref: string) {
  picking.value = false;
  if (!projectId.value) return;
  const res = await cmd({ type: "resource/addProjectResource", projectId: projectId.value, resourceRef: ref });
  if (res.ok) await loadResources(projectId.value);
  else error.value = res.error;
}
</script>

<template>
  <div class="split projects-app">
    <nav class="split-side" aria-label="项目">
      <div class="split-section">项目</div>
      <div class="projects" data-d3-04d="projects">
        <ul class="pj-list" data-d3-04d-projects>
          <li v-for="p in projects" :key="p.id">
            <button
              type="button"
              class="split-nav"
              :data-d3-04d-project="p.id"
              :aria-pressed="projectId === p.id"
              :aria-current="projectId === p.id ? 'true' : undefined"
              @click="selectProject(p.id)"
            >
              <Folder :size="16" /> <span class="split-nav-label">{{ p.name }}</span>
            </button>
          </li>
        </ul>
        <form class="pj-new" @submit.prevent="create">
          <Plus :size="15" />
          <input v-model="name" data-d3-04d-project-name placeholder="新建项目" aria-label="新项目名称" />
          <button type="submit" class="pj-new-btn" data-d3-04d-project-new :disabled="!bridgeReady" :data-empty="!name.trim()">新建</button>
        </form>
      </div>
    </nav>

    <div class="split-main pj-main">
      <div class="pane-toolbar">
        <strong class="pane-title">{{ current ? current.name : "项目" }}</strong>
        <span v-if="current" class="badge">{{ resources.length }} 个资源</span>
        <div class="toolbar-spacer" />
        <DsButton v-if="projectId" variant="primary" size="sm" data-d3-04d-project-add @click="picking = true">
          <Plus :size="13" /> 引用资源
        </DsButton>
      </div>
      <p v-if="error" class="gov-error" role="alert" data-d3-04d-project-error>{{ errText(error) }}</p>

      <section v-if="projectId" :data-d3-04d-project-active="projectId">
        <p v-if="!resources.length" class="set-cap">还没有引用任何资源。用「引用资源」从资源库里挑选，项目只保存引用，访问权逐个重新校验。</p>
        <div v-else class="pj-table" data-d3-04d-project-resources>
          <div class="pj-tr pj-th"><span>资源</span><span>访问</span></div>
          <div
            v-for="r in resources"
            :key="r.resourceId"
            class="pj-tr"
            :data-d3-04d-project-resource="r.resourceId"
            :data-d3-04d-project-resource-authorized="r.authorized ? 'true' : 'false'"
          >
            <span class="gov-name">{{ r.authorized ? r.resource.name : r.resourceRef }}</span>
            <span class="badge" :class="{ ok: r.authorized }">{{ r.authorized ? "可访问" : "无访问权限" }}</span>
          </div>
        </div>
      </section>
      <div v-else class="empty-content">
        <img class="large-icon" :src="iconUrl('folder')" alt="" draggable="false" />
        <h2 class="planned-title">{{ projects.length ? "选择一个项目" : "还没有项目" }}</h2>
        <p>项目把相关的资源引用放在一起，成员按各自的权限访问。在左侧新建或选择一个项目。</p>
      </div>

      <ResourcePicker
        v-if="picking"
        picker-app-id="resource-library"
        :requested-actions="['resource.view']"
        title="引用资源"
        @choose="addResource"
        @cancel="picking = false"
      />
    </div>
  </div>
</template>
