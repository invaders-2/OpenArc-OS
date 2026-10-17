<script setup lang="ts">
/**
 * 访达 · 共享盘 / 部门盘浏览（platform/fs/* 安全节点投影）。
 *
 * 只调用 platform:command 的只读/受控命令：
 *   shared/list、search、stats、snapshot/create、snapshot/restore。
 * 不做的事情（缺命令就如实说明，不伪造）：
 *   · 不读取节点内容 / 不下载（后端只回安全投影，没有 readBlob 类命令）；
 *   · 不列出历史快照（后端没有 list 命令，列表只记录本次会话创建的）；
 *   · 不预测权限：恢复失败时原样展示 PLATFORM_FORBIDDEN 等结构化拒绝。
 */
import { computed, onMounted, ref } from "vue";
import { ArrowLeft, Camera, ChevronRight, File as FileIcon, Folder, RefreshCw, RotateCcw, Search, X } from "lucide-vue-next";
import DsBadge from "../design-system/DsBadge.vue";
import DsButton from "../design-system/DsButton.vue";
import DsDialog from "../design-system/DsDialog.vue";
import DsPageState from "../design-system/DsPageState.vue";
import {
  formatSharedBytes,
  formatSharedTime,
  platformCommand,
  platformErrorCode,
  platformErrorText,
  shareLabel,
  sharedNodeOf,
  sharedNodesOf,
  sharedSearchHitsOf,
} from "./sharedDrive";
import type { PlatformResult, SharedNode, SharedSearchHit } from "./sharedDrive";

const props = defineProps<{ root: SharedNode }>();

type SnapshotRow = { snapshotId: string; nodeId: string; nodeName: string; nodeCount: number; bytes: number; createdAt: number };

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

const stack = ref<SharedNode[]>([props.root]);
const current = computed<SharedNode>(() => stack.value[stack.value.length - 1] || props.root);
const children = ref<SharedNode[]>([]);
const loading = ref(false);
const failure = ref<PlatformResult | null>(null);
const selected = ref<SharedNode | null>(null);
const selectedPath = ref("");
const selectedSnippet = ref("");

const query = ref("");
const searchQuery = ref("");
const searching = ref(false);
const results = ref<SharedSearchHit[] | null>(null);
const searchFailure = ref<PlatformResult | null>(null);

const stats = ref<{ bytes: number; entries: number } | null>(null);
const statsBusy = ref(false);
const statsFailure = ref<PlatformResult | null>(null);

const snapshots = ref<SnapshotRow[]>([]);
const snapshotDialog = ref(false);
const snapshotReason = ref("");
const restoreTarget = ref<SnapshotRow | null>(null);
const busy = ref<string | null>(null);
const notice = ref("");
const actionFailure = ref<PlatformResult | null>(null);

const failureKind = computed<"error" | "unauthorized" | "unavailable">(() => {
  const code = platformErrorCode(failure.value);
  if (code === "PLATFORM_UNAUTHENTICATED" || code === "PLATFORM_FORBIDDEN") return "unauthorized";
  if (code === "PLATFORM_DEPENDENCY_UNAVAILABLE" || code === "NO_BRIDGE") return "unavailable";
  return "error";
});
const restoreHint = computed(() => (platformErrorCode(actionFailure.value) === "PLATFORM_FORBIDDEN" ? "恢复只允许超管 / 节点所有者 / 该部门管理员；渲染层不会绕过这个判定。" : ""));
const statsLabel = computed(() => {
  if (statsBusy.value) return "统计中…";
  if (statsFailure.value) return "统计不可用";
  if (!stats.value) return "未统计";
  return "条目 " + stats.value.entries + " · " + formatSharedBytes(stats.value.bytes);
});

async function load(node: SharedNode = current.value) {
  loading.value = true;
  failure.value = null;
  selected.value = null;
  selectedPath.value = "";
  selectedSnippet.value = "";
  const res = await platformCommand("platform/fs/shared/list", { nodeId: node.id });
  loading.value = false;
  if (!res.ok) {
    failure.value = res;
    children.value = [];
    return;
  }
  const value = recordOf(res.value);
  const nodeView = sharedNodeOf(value.node);
  if (nodeView) {
    const next = stack.value.slice();
    next[next.length - 1] = nodeView;
    stack.value = next;
  }
  children.value = sharedNodesOf(value.children);
  void loadStats();
}

async function loadStats() {
  statsBusy.value = true;
  statsFailure.value = null;
  const res = await platformCommand("platform/fs/stats", { nodeId: current.value.id });
  statsBusy.value = false;
  if (!res.ok) {
    statsFailure.value = res;
    stats.value = null;
    return;
  }
  const value = recordOf(res.value);
  stats.value = { bytes: Number(value.bytes) || 0, entries: Number(value.entries) || 0 };
}

function openNode(node: SharedNode) {
  if (node.type === "folder") {
    stack.value = [...stack.value, node];
    clearSearch();
    void load(node);
    return;
  }
  selected.value = node;
  selectedPath.value = "";
  selectedSnippet.value = "";
}

function goCrumb(index: number) {
  if (index < 0 || index >= stack.value.length) return;
  stack.value = stack.value.slice(0, index + 1);
  clearSearch();
  void load();
}
function goUp() {
  if (stack.value.length > 1) goCrumb(stack.value.length - 2);
}

async function runSearch() {
  const q = query.value.trim();
  if (!q) {
    clearSearch();
    return;
  }
  searching.value = true;
  searchFailure.value = null;
  const res = await platformCommand("platform/fs/search", { nodeId: current.value.id, query: q, limit: 50 });
  searching.value = false;
  if (!res.ok) {
    searchFailure.value = res;
    results.value = [];
    return;
  }
  const value = recordOf(res.value);
  results.value = sharedSearchHitsOf(value.results);
  searchQuery.value = q;
  selected.value = null;
}

function clearSearch() {
  query.value = "";
  searchQuery.value = "";
  results.value = null;
  searchFailure.value = null;
}

function openHit(hit: SharedSearchHit) {
  if (hit.type === "folder") {
    const node: SharedNode = {
      id: hit.id,
      name: hit.name,
      type: "folder",
      mime: null,
      size: null,
      parentId: null,
      share: null,
      ownerId: null,
      system: false,
      createdAt: null,
      updatedAt: null,
    };
    stack.value = [...stack.value, node];
    clearSearch();
    void load(node);
    return;
  }
  selected.value = {
    id: hit.id,
    name: hit.name,
    type: hit.type || "file",
    mime: null,
    size: null,
    parentId: null,
    share: null,
    ownerId: null,
    system: false,
    createdAt: null,
    updatedAt: null,
  };
  selectedPath.value = hit.path || "";
  selectedSnippet.value = hit.snippet || "";
}

function openSnapshotDialog() {
  snapshotReason.value = "";
  actionFailure.value = null;
  snapshotDialog.value = true;
}

async function createSnapshot() {
  busy.value = "snapshot";
  actionFailure.value = null;
  const res = await platformCommand("platform/fs/snapshot/create", {
    nodeId: current.value.id,
    reason: snapshotReason.value.trim(),
  });
  busy.value = null;
  if (!res.ok) {
    actionFailure.value = res;
    return;
  }
  const value = recordOf(res.value);
  const snapshotId = String(value.snapshotId || "");
  snapshots.value = [
    {
      snapshotId,
      nodeId: String(value.nodeId || current.value.id),
      nodeName: current.value.name,
      nodeCount: Number(value.nodeCount) || 0,
      bytes: Number(value.bytes) || 0,
      createdAt: Number(value.createdAt) || Date.now(),
    },
    ...snapshots.value,
  ];
  snapshotDialog.value = false;
  notice.value = "已创建快照 " + snapshotId + "：节点 " + (Number(value.nodeCount) || 0) + " 个。快照只保存在主进程内存，后端没有列出快照的命令，刷新或重启后这个列表会消失。";
}

function askRestore(row: SnapshotRow) {
  actionFailure.value = null;
  restoreTarget.value = row;
}

async function restoreSnapshot() {
  const row = restoreTarget.value;
  if (!row) return;
  busy.value = "restore:" + row.snapshotId;
  actionFailure.value = null;
  const res = await platformCommand("platform/fs/snapshot/restore", { snapshotId: row.snapshotId });
  busy.value = null;
  if (!res.ok) {
    actionFailure.value = res;
    return;
  }
  const value = recordOf(res.value);
  notice.value = "快照已恢复：恢复 " + (Number(value.restored) || 0) + " 个节点（恢复会覆盖当前子树，操作由后端执行）。";
  snapshots.value = snapshots.value.filter((item) => item.snapshotId !== row.snapshotId);
  restoreTarget.value = null;
  await load();
}

onMounted(() => void load());
</script>

<template>
  <div
    class="shared-drive"
    data-shared-drive="1"
    :data-shared-root-id="root.id"
    :data-shared-node-id="current.id"
    :data-shared-children="children.length"
    :data-shared-view="results !== null ? 'search' : 'list'"
  >
    <div class="pane-toolbar shared-toolbar">
      <button class="icon-button" aria-label="返回上一级共享盘目录" :disabled="stack.length < 2" @click="goUp">
        <ArrowLeft :size="15" />
      </button>
      <strong class="pane-title">{{ current.name }}</strong>
      <DsBadge tone="neutral" size="sm">{{ shareLabel(current.share) }}</DsBadge>
      <div class="toolbar-spacer" />
      <span class="shared-stat" data-shared-stats>{{ statsLabel }}</span>
      <DsButton size="sm" variant="secondary" :status="statsBusy ? 'loading' : 'idle'" @click="loadStats">统计</DsButton>
      <DsButton size="sm" variant="secondary" :disabled="current.type !== 'folder' || busy !== null" @click="openSnapshotDialog">
        <Camera :size="13" :stroke-width="1.5" /> 创建快照
      </DsButton>
      <DsButton size="sm" variant="secondary" :status="loading ? 'loading' : 'idle'" @click="load()">
        <RefreshCw :size="13" :stroke-width="1.5" /> 刷新
      </DsButton>
      <label class="shared-search">
        <Search :size="13" aria-hidden="true" />
        <input v-model="query" type="search" aria-label="搜索共享盘" placeholder="搜索这个共享盘" @keydown.enter.prevent="runSearch" />
        <button v-if="query" type="button" class="shared-search__clear" aria-label="清除搜索" @click="clearSearch"><X :size="12" /></button>
      </label>
      <DsButton size="sm" :status="searching ? 'loading' : 'idle'" @click="runSearch">搜索</DsButton>
    </div>

    <p v-if="notice" class="shared-notice" role="status" data-shared-notice>{{ notice }}</p>

    <DsPageState v-if="loading" kind="loading" title="正在读取共享盘…" />
    <DsPageState v-else-if="failure" :kind="failureKind" title="读取共享盘失败" :description="platformErrorText(failure)" :on-action="() => load()" />
    <template v-else>
      <nav class="shared-crumbs" aria-label="共享盘路径" data-shared-crumbs>
        <template v-for="(node, index) in stack" :key="node.id + '-' + index">
          <ChevronRight v-if="index > 0" :size="12" aria-hidden="true" />
          <button type="button" class="shared-crumb" :aria-current="index === stack.length - 1 ? 'page' : undefined" @click="goCrumb(index)">{{ node.name }}</button>
        </template>
      </nav>

      <section v-if="results !== null" class="shared-search-results" aria-label="搜索结果">
        <div class="shared-section-head">
          <strong>搜索「{{ searchQuery }}」 · {{ results.length }} 条</strong>
          <DsButton size="sm" variant="ghost" @click="clearSearch">清除</DsButton>
        </div>
        <p v-if="searchFailure" class="shared-error" role="alert" data-shared-search-error>{{ platformErrorText(searchFailure) }}</p>
        <p v-else-if="!results.length" class="shared-hint" data-shared-search-empty>没有匹配的节点；搜索只覆盖这个可见子树，不访问不可见节点。</p>
        <ul v-else class="shared-hits">
          <li v-for="hit in results" :key="hit.id">
            <button type="button" class="shared-hit" :data-shared-hit="hit.id" @click="openHit(hit)">
              <Folder v-if="hit.type === 'folder'" :size="15" :stroke-width="1.5" />
              <FileIcon v-else :size="15" :stroke-width="1.5" />
              <span class="shared-hit__main">
                <span class="shared-hit__name">{{ hit.name }}</span>
                <span v-if="hit.path" class="shared-hit__path">{{ hit.path }}</span>
                <span v-if="hit.snippet" class="shared-hit__snippet">{{ hit.snippet }}</span>
              </span>
              <span class="shared-hit__type">{{ hit.type === "folder" ? "文件夹" : "文件" }}</span>
            </button>
          </li>
        </ul>
      </section>

      <template v-else>
        <div v-if="selected" class="shared-detail" data-shared-detail>
          <div class="shared-section-head">
            <strong>节点详情</strong>
            <DsButton size="sm" variant="ghost" @click="selected = null">关闭</DsButton>
          </div>
          <dl class="shared-kv">
            <dt>名称</dt><dd>{{ selected.name }}</dd>
            <dt>类型</dt><dd>{{ selected.type === "folder" ? "文件夹" : "文件" }}</dd>
            <dt v-if="selected.mime">MIME</dt><dd v-if="selected.mime">{{ selected.mime }}</dd>
            <dt v-if="selected.size !== null">大小</dt><dd v-if="selected.size !== null">{{ formatSharedBytes(selected.size) }}</dd>
            <dt v-if="selectedPath">路径</dt><dd v-if="selectedPath">{{ selectedPath }}</dd>
            <dt v-if="selectedSnippet">命中片段</dt><dd v-if="selectedSnippet">{{ selectedSnippet }}</dd>
            <dt>更新时间</dt><dd>{{ formatSharedTime(selected.updatedAt) }}</dd>
          </dl>
          <p class="shared-hint">共享盘只返回安全节点投影，没有读取内容或下载的命令；这里只展示元数据，不展示假内容。</p>
        </div>

        <div class="shared-list-head" aria-hidden="true">
          <span>名称</span><span>类型</span><span>大小</span><span>更新时间</span>
        </div>
        <div v-if="!children.length" class="shared-empty">
          <Folder :size="42" :stroke-width="1.25" />
          <p>这个目录是空的。共享盘没有创建文件 / 上传命令，界面不会伪造条目。</p>
        </div>
        <ul v-else class="shared-list" role="list" data-shared-list>
          <li v-for="node in children" :key="node.id">
            <button type="button" class="shared-row" :data-shared-node="node.id" @click="openNode(node)">
              <Folder v-if="node.type === 'folder'" :size="18" :stroke-width="1.4" />
              <FileIcon v-else :size="18" :stroke-width="1.4" />
              <span class="shared-row__name" :title="node.name">{{ node.name }}</span>
              <span class="shared-row__meta">{{ node.type === "folder" ? "文件夹" : node.mime || "文件" }}</span>
              <span class="shared-row__meta">{{ node.type === "folder" ? "—" : formatSharedBytes(node.size) }}</span>
              <span class="shared-row__meta">{{ formatSharedTime(node.updatedAt) }}</span>
            </button>
          </li>
        </ul>
      </template>

      <section class="shared-snapshots" aria-label="快照">
        <div class="shared-section-head">
          <strong>快照</strong>
          <span class="shared-hint">恢复由后端按超管 / 节点所有者 / 部门管理员校验；越权会原样返回拒绝。</span>
        </div>
        <p class="shared-error" v-if="actionFailure && !restoreTarget" role="alert" :data-shared-action-error="platformErrorCode(actionFailure)">
          {{ platformErrorText(actionFailure) }}
        </p>
        <p v-if="!snapshots.length" class="shared-hint" data-shared-snapshots-empty>
          本次会话还没有创建快照。快照只存在主进程内存（每用户最多 10 个），后端没有列出快照的命令，所以这里不展示历史快照。
        </p>
        <ul v-else class="shared-snapshot-list" data-shared-snapshot-list>
          <li v-for="row in snapshots" :key="row.snapshotId" class="shared-snapshot-row" :data-shared-snapshot="row.snapshotId">
            <span class="shared-snapshot__id" :title="row.snapshotId">{{ row.snapshotId }}</span>
            <span class="shared-snapshot__meta">{{ row.nodeName }} · 节点 {{ row.nodeCount }} · {{ formatSharedBytes(row.bytes) }} · {{ formatSharedTime(row.createdAt) }}</span>
            <DsButton size="sm" variant="danger" :status="busy === 'restore:' + row.snapshotId ? 'loading' : 'idle'" @click="askRestore(row)">
              <RotateCcw :size="13" :stroke-width="1.5" /> 恢复
            </DsButton>
          </li>
        </ul>
      </section>
    </template>

    <DsDialog :open="snapshotDialog" title="为当前目录创建快照" @close="snapshotDialog = false">
      <div class="shared-dialog">
        <p class="shared-hint">
          快照包含「{{ current.name }}」子树的安全副本，只保存在主进程内存（不落盘、不过 IPC）。创建后可以在本窗口恢复；
          刷新窗口或重启应用后列表会消失，这是后端没有快照列表命令导致的，界面不伪造历史记录。
        </p>
        <label class="shared-field">
          <span>原因（可选，最多 200 字）</span>
          <input v-model="snapshotReason" type="text" maxlength="200" aria-label="创建快照原因" placeholder="例如：批量调整前的备份" />
        </label>
        <p v-if="actionFailure" class="shared-error" role="alert" :data-shared-snapshot-error="platformErrorCode(actionFailure)">{{ platformErrorText(actionFailure) }}</p>
      </div>
      <template #footer>
        <DsButton variant="ghost" @click="snapshotDialog = false">取消</DsButton>
        <DsButton :status="busy === 'snapshot' ? 'loading' : 'idle'" @click="createSnapshot">创建快照</DsButton>
      </template>
    </DsDialog>

    <DsDialog :open="!!restoreTarget" title="恢复快照" @close="restoreTarget = null">
      <div class="shared-dialog">
        <p class="shared-hint">
          会用快照「{{ restoreTarget ? restoreTarget.snapshotId : "" }}」覆盖「{{ restoreTarget ? restoreTarget.nodeName : "" }}」子树，
          节点数 {{ restoreTarget ? restoreTarget.nodeCount : 0 }}。这是受控写操作，后端会重新校验权限；恢复成功后快照会被消费。
        </p>
        <p class="shared-hint" data-shared-restore-perm>恢复只允许超管 / 节点所有者 / 该部门管理员；界面不会绕过权限。</p>
        <p v-if="actionFailure" class="shared-error" role="alert" :data-shared-restore-error="platformErrorCode(actionFailure)">
          {{ platformErrorText(actionFailure) }}<template v-if="restoreHint">。{{ restoreHint }}</template>
        </p>
      </div>
      <template #footer>
        <DsButton variant="ghost" @click="restoreTarget = null">取消</DsButton>
        <DsButton variant="danger" :status="restoreTarget && busy === 'restore:' + restoreTarget.snapshotId ? 'loading' : 'idle'" @click="restoreSnapshot">恢复</DsButton>
      </template>
    </DsDialog>
  </div>
</template>

<style scoped>
.shared-drive {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  gap: var(--space-2);
  padding: 0 var(--space-1) var(--space-2);
}
.shared-toolbar {
  flex-wrap: wrap;
  row-gap: var(--space-1);
}
.shared-stat {
  font-size: var(--fs-micro);
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.shared-search {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex: 1 1 180px;
  min-width: 140px;
  max-width: 300px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-md);
  background: rgb(var(--text-rgb) / 0.06);
  color: var(--muted);
}
.shared-search input {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: var(--fs-caption);
  padding: 5px 0;
}
.shared-search__clear {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-sm);
  color: var(--muted);
}
.shared-search__clear:hover {
  background: var(--row-hover);
  color: var(--text);
}
.shared-notice {
  margin: 0;
  font-size: var(--fs-caption);
  line-height: var(--lh-relaxed);
  color: var(--muted);
  overflow-wrap: anywhere;
}
.shared-crumbs {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
  font-size: var(--fs-caption);
  color: var(--muted);
}
.shared-crumb {
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: var(--fs-caption);
}
.shared-crumb:hover {
  background: var(--row-hover);
  color: var(--text);
}
.shared-crumb[aria-current="page"] {
  color: var(--text);
  font-weight: var(--fw-medium);
}
.shared-hint {
  margin: 0;
  font-size: var(--fs-caption);
  line-height: var(--lh-relaxed);
  color: var(--muted);
  overflow-wrap: anywhere;
}
.shared-error {
  margin: 0;
  font-size: var(--fs-caption);
  line-height: var(--lh-relaxed);
  color: var(--failed);
  overflow-wrap: anywhere;
}
.shared-section-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  flex-wrap: wrap;
  font-size: var(--fs-caption);
  color: var(--muted);
}
.shared-section-head strong {
  color: var(--text);
  font-size: var(--fs-secondary);
  font-weight: var(--fw-medium);
}
.shared-list-head,
.shared-row {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) 150px 90px 150px;
  align-items: center;
  gap: var(--space-2);
}
.shared-list-head {
  padding: 0 var(--space-2);
  font-size: var(--fs-micro);
  color: var(--muted);
}
.shared-list-head span:first-child {
  grid-column: 1 / 3;
}
.shared-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow: auto;
  min-height: 0;
  flex: 1 1 auto;
}
.shared-row {
  width: 100%;
  padding: 7px var(--space-2);
  border-radius: var(--radius-md);
  text-align: left;
  color: var(--text);
  font-size: var(--fs-secondary);
}
.shared-row:hover {
  background: var(--row-hover);
}
.shared-row svg,
.shared-row__meta {
  color: var(--muted);
}
.shared-row__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.shared-row__meta {
  font-size: var(--fs-caption);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.shared-empty {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--muted);
  font-size: var(--fs-caption);
  text-align: center;
  padding: var(--space-6);
}
.shared-empty p {
  max-width: 420px;
  margin: 0;
}
.shared-search-results {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  flex: 1 1 auto;
  min-height: 0;
}
.shared-hits {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow: auto;
  min-height: 0;
}
.shared-hit {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  width: 100%;
  padding: 7px var(--space-2);
  border-radius: var(--radius-md);
  text-align: left;
  color: var(--text);
  font-size: var(--fs-secondary);
}
.shared-hit:hover {
  background: var(--row-hover);
}
.shared-hit svg {
  color: var(--muted);
  margin-top: 2px;
  flex: none;
}
.shared-hit__main {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1 1 auto;
}
.shared-hit__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.shared-hit__path,
.shared-hit__snippet {
  font-size: var(--fs-micro);
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.shared-hit__type {
  flex: none;
  font-size: var(--fs-micro);
  color: var(--muted);
}
.shared-detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--sunken);
}
.shared-kv {
  margin: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--space-1) var(--space-3);
  font-size: var(--fs-caption);
}
.shared-kv dt {
  color: var(--muted);
}
.shared-kv dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.shared-snapshots {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  flex: none;
  padding-top: var(--space-2);
  margin-top: auto;
}
.shared-snapshot-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  max-height: 160px;
  overflow: auto;
}
.shared-snapshot-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-md);
  background: var(--sunken);
}
.shared-snapshot__id {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.shared-snapshot__meta {
  grid-column: 1;
  font-size: var(--fs-micro);
  color: var(--muted);
  overflow-wrap: anywhere;
}
.shared-snapshot-row :deep(.ds-btn) {
  grid-column: 2;
  grid-row: 1 / span 2;
}
.shared-dialog {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.shared-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--fs-caption);
  color: var(--muted);
}
.shared-field input {
  padding: 6px var(--space-2);
  border-radius: var(--radius-md);
  border: 1px solid var(--line);
  background: rgb(var(--content-rgb) / var(--content-alpha));
  color: var(--text);
  font: inherit;
  font-size: var(--fs-secondary);
}
@container (max-width: 900px) {
  .shared-list-head,
  .shared-row {
    grid-template-columns: 24px minmax(0, 1fr) 90px 120px;
  }
  .shared-list-head span:nth-child(2),
  .shared-row .shared-row__meta:nth-child(3) {
    display: none;
  }
}
</style>
