<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import DsButton from "../design-system/DsButton.vue";
import { History, KeyRound, Network, Plus, ShieldCheck, Users } from "lucide-vue-next";

/**
 * D3-04D · Organization 治理 App（对齐 src/governance/GovernanceApp.tsx，逐段迁移）。
 *
 * 治理 UI 不是授权权威：每个 mutation 都在主进程 GovernanceService / AuthorizationService
 * 内重新校验；本组件只负责呈现与派发受控命令（window.openarc.governance.command）。
 * class / data-* / DOM 结构与 React 逐项一致。命令全部取自 governance-bootstrap 白名单。
 */
type GovBridge = { command: (c: Record<string, unknown>) => Promise<any> };
type Tab = "users" | "departments" | "apps" | "audit" | "access";

const bridge = (): GovBridge | undefined => (window as any).openarc?.governance;

const TABS: { id: Tab; label: string; icon: unknown }[] = [
  { id: "users", label: "成员", icon: Users },
  { id: "departments", label: "部门", icon: Network },
  { id: "apps", label: "应用权限", icon: ShieldCheck },
  { id: "access", label: "资源权限", icon: KeyRound },
  { id: "audit", label: "审计日志", icon: History },
];
/* 10-15 按原型：工具条标题、新增表单开合、中文错误与角色 / 状态文案 */
const adding = ref(false);
const tabLabel = computed(() => TABS.find((t) => t.id === tab.value)?.label ?? "");
const ROLE: Record<string, string> = { ADMIN: "管理员", MEMBER: "成员", OWNER: "所有者", SUPER_ADMIN: "超级管理员" };
const STATUS: Record<string, string> = { ACTIVE: "在线可用", DISABLED: "已停用", enabled: "已启用", disabled: "已停用" };
const GERR: Record<string, string> = {
  NO_BRIDGE: "组织服务只在 OpenArc 桌面应用里可用。",
  INTERNAL_ERROR: "组织服务暂时不可用。",
  FORBIDDEN: "需要管理员权限。",
  AUTH_REQUIRED: "请先登录。",
};
const errText = (e: string) => GERR[e] ?? `操作被拒绝（${e}）`;
const initial = (u: any) => String(u.displayName || u.identifier || "?").slice(0, 1).toUpperCase();

const tab = ref<Tab>("users");
const users = ref<any[]>([]);
const departments = ref<any[]>([]);
const apps = ref<any[]>([]);
const audit = ref<any[]>([]);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref(false);
const form = ref({ identifier: "", password: "", displayName: "", role: "MEMBER" });
const deptForm = ref({ name: "", description: "" });
const accessRef = ref("");
const access = ref<any>(null);
const toolAccess = ref<Record<string, any>>({});
const toolPick = ref<Record<string, string[]>>({});

async function cmd(payload: Record<string, unknown>): Promise<any> {
  const b = bridge();
  if (!b) return { ok: false, error: "NO_BRIDGE" };
  try {
    return await b.command(payload);
  } catch {
    return { ok: false, error: "INTERNAL_ERROR" };
  }
}

async function load() {
  busy.value = true;
  error.value = null;
  if (tab.value === "users") {
    const res = await cmd({ type: "governance/listUsers" });
    if (res.ok) users.value = Array.isArray(res.items) ? res.items : [];
    else error.value = res.error;
  } else if (tab.value === "departments") {
    const res = await cmd({ type: "governance/listDepartments" });
    if (res.ok) departments.value = Array.isArray(res.items) ? res.items : [];
    else error.value = res.error;
  } else if (tab.value === "apps") {
    const res = await cmd({ type: "governance/listApps" });
    if (res.ok) apps.value = Array.isArray(res.items) ? res.items : [];
    else error.value = res.error;
  } else if (tab.value === "audit") {
    const res = await cmd({ type: "governance/listAudit", limit: 100 });
    if (res.ok) audit.value = Array.isArray(res.items) ? res.items : [];
    else error.value = res.error;
  }
  busy.value = false;
}

onMounted(() => {
  void load();
});
watch(tab, () => {
  void load();
});

async function createUser() {
  const res = await cmd({ type: "governance/createUser", ...form.value });
  if (res.ok) {
    notice.value = "用户已创建";
    form.value = { identifier: "", password: "", displayName: "", role: "MEMBER" };
    await load();
  } else {
    error.value = res.error;
  }
}

async function createDept() {
  const res = await cmd({ type: "governance/createDepartment", ...deptForm.value });
  if (res.ok) {
    notice.value = "部门已创建";
    deptForm.value = { name: "", description: "" };
    await load();
  } else {
    error.value = res.error;
  }
}

async function setStatus(userId: string, status: string) {
  const res = await cmd({ type: "governance/setUserStatus", userId, status });
  if (!res.ok) error.value = res.error;
  else await load();
}

async function toggleApp(appId: string, status: string) {
  const res = await cmd({ type: "governance/setAppStatus", appId, status });
  if (!res.ok) error.value = res.error;
  else await load();
}

async function loadAccess() {
  access.value = null;
  const res = await cmd({ type: "governance/listResourceAccess", resourceRef: accessRef.value.trim() });
  if (res.ok) access.value = res;
  else error.value = res.error;
}

async function loadToolAccess(appId: string) {
  const res = await cmd({ type: "governance/getAppToolAccess", appId });
  if (res.ok) {
    toolAccess.value = { ...toolAccess.value, [appId]: res };
    toolPick.value = { ...toolPick.value, [appId]: [] };
  } else {
    error.value = res.error;
  }
}

function toggleToolPick(appId: string, action: string) {
  const cur = toolPick.value[appId] || [];
  toolPick.value = {
    ...toolPick.value,
    [appId]: cur.includes(action) ? cur.filter((a) => a !== action) : [...cur, action],
  };
}

async function grantTools(appId: string) {
  /* 展开成普通数组：Vue 深层响应式会给嵌套数组套 Proxy，Proxy 无法结构化克隆过 IPC。 */
  const actions = [...(toolPick.value[appId] || [])];
  const res = await cmd({ type: "governance/grantAppToolAccess", appId, actions });
  if (res.ok) {
    notice.value = "工具权限已授予";
    await loadToolAccess(appId);
  } else {
    error.value = res.error;
  }
}

async function revokeTool(appId: string, grantId: string) {
  const res = await cmd({ type: "governance/revokeAppToolAccess", grantId });
  if (res.ok) {
    notice.value = "工具权限已撤销";
    await loadToolAccess(appId);
  } else {
    error.value = res.error;
  }
}

/* ── 投影（与 React 逐项同义）───────────────────────────────────────────── */
const toolEntries = computed<[string, any][]>(() => Object.entries(toolAccess.value));

function deptNames(u: any): string {
  const list = Array.isArray(u?.departments) ? u.departments.map((d: any) => d.name).filter(Boolean) : [];
  return list.join(", ") || "无部门";
}
function availableActions(ta: any): string[] {
  return Array.isArray(ta?.availableActions) ? ta.availableActions : [];
}
function grantsOf(ta: any): any[] {
  return Array.isArray(ta?.grants) ? ta.grants : [];
}
function isGranted(ta: any, action: string): boolean {
  return (Array.isArray(ta?.grantedActions) ? ta.grantedActions : []).includes(action);
}
function isChecked(appId: string, ta: any, action: string): boolean {
  return isGranted(ta, action) || (toolPick.value[appId] || []).includes(action);
}
function sourceActions(s: any): string {
  return (Array.isArray(s?.actions) ? s.actions : []).slice(0, 4).join(",");
}
function grantText(g: any): string {
  return (Array.isArray(g?.actions) ? g.actions : []).join(", ") + (g?.expiresAt ? " · " + g.expiresAt : "");
}
</script>

<template>
  <div class="split gov-app">
    <nav class="split-side" role="tablist" aria-label="治理分区">
      <div class="split-section">组织</div>
      <button
        v-for="t in TABS"
        :key="t.id"
        type="button"
        class="split-nav"
        role="tab"
        :aria-selected="tab === t.id"
        :aria-current="tab === t.id ? 'true' : undefined"
        :data-d3-04d-tab="t.id"
        @click="tab = t.id; adding = false"
      >
        <component :is="t.icon" :size="16" /> <span class="split-nav-label">{{ t.label }}</span>
        <small v-if="t.id === 'users' && users.length" class="planned-count">{{ users.length }}</small>
        <small v-if="t.id === 'departments' && departments.length" class="planned-count">{{ departments.length }}</small>
      </button>
    </nav>
    <div class="split-main gov-main">
      <div class="pane-toolbar">
        <strong class="pane-title">{{ tabLabel }}</strong>
        <div class="toolbar-spacer" />
        <DsButton v-if="tab === 'users'" variant="primary" size="sm" @click="adding = !adding"><Plus :size="13" /> 添加成员</DsButton>
        <DsButton v-if="tab === 'departments'" variant="primary" size="sm" @click="adding = !adding"><Plus :size="13" /> 新建部门</DsButton>
      </div>
      <div class="gov gov-body" data-d3-04d="app">
        <p v-if="error" class="gov-error" role="alert" data-d3-04d-error>{{ errText(error) }}</p>
        <p v-if="notice" class="gov-notice" role="status">{{ notice }}</p>

        <section v-if="tab === 'users'" class="gov-pane" data-d3-04d-pane="users">
          <div v-show="adding" class="set-group gov-form">
            <label class="setting-row"><span class="set-lab">账号</span><input class="set-input" data-d3-04d-user-identifier placeholder="登录名" v-model="form.identifier" /></label>
            <label class="setting-row"><span class="set-lab">显示名</span><input class="set-input" data-d3-04d-user-display placeholder="显示名" v-model="form.displayName" /></label>
            <label class="setting-row"><span class="set-lab">初始口令<small>成员首次登录后自行修改</small></span><input class="set-input" data-d3-04d-user-password type="password" placeholder="初始口令" v-model="form.password" /></label>
            <label class="setting-row">
              <span class="set-lab">角色</span>
              <select class="set-select" data-d3-04d-user-role v-model="form.role">
                <option value="MEMBER">成员</option>
                <option value="ADMIN">管理员</option>
              </select>
            </label>
            <div class="setting-row set-actions"><DsButton variant="primary" size="sm" data-d3-04d-create-user @click="createUser">创建成员</DsButton></div>
          </div>
          <div class="gov-table" data-d3-04d-users>
            <div class="gov-tr gov-th"><span>成员</span><span>角色</span><span>部门</span><span>状态</span><span /></div>
            <div v-for="u in users" :key="u.userId" :data-d3-04d-user="u.userId" class="gov-tr">
              <span class="gov-who"><span class="gov-av">{{ initial(u) }}</span><span class="gov-name">{{ u.displayName || u.identifier }}<small>{{ u.identifier }}</small></span></span>
              <span><span class="badge" :class="{ 'gov-admin': u.role === 'ADMIN' }">{{ ROLE[u.role] || u.role }}</span></span>
              <span class="gov-meta">{{ deptNames(u) || "—" }}</span>
              <span class="gov-status"><i :data-on="u.status === 'ACTIVE'" />{{ STATUS[u.status] || u.status }}</span>
              <span class="gov-act">
                <DsButton v-if="u.status === 'ACTIVE'" variant="ghost" size="sm" :data-d3-04d-user-disable="u.userId" @click="setStatus(u.userId, 'DISABLED')">停用</DsButton>
                <DsButton v-else variant="secondary" size="sm" :data-d3-04d-user-enable="u.userId" @click="setStatus(u.userId, 'ACTIVE')">启用</DsButton>
              </span>
            </div>
            <p v-if="!users.length" class="set-cap gov-empty">还没有成员。</p>
          </div>
        </section>

        <section v-if="tab === 'departments'" class="gov-pane" data-d3-04d-pane="departments">
          <div v-show="adding" class="set-group gov-form">
            <label class="setting-row"><span class="set-lab">部门名</span><input class="set-input" data-d3-04d-dept-name placeholder="例如 设计部" v-model="deptForm.name" /></label>
            <label class="setting-row"><span class="set-lab">描述</span><input class="set-input" data-d3-04d-dept-desc placeholder="可选" v-model="deptForm.description" /></label>
            <div class="setting-row set-actions"><DsButton variant="primary" size="sm" data-d3-04d-create-dept @click="createDept">创建部门</DsButton></div>
          </div>
          <div class="gov-table" data-d3-04d-departments>
            <div class="gov-tr gov-th gov-tr-dept"><span>部门</span><span>成员</span><span>资源</span><span>收藏集</span><span>状态</span></div>
            <div v-for="d in departments" :key="d.departmentId" :data-d3-04d-dept="d.departmentId" class="gov-tr gov-tr-dept">
              <span class="gov-name">{{ d.name }}<small v-if="d.description">{{ d.description }}</small></span>
              <span>{{ d.memberCount }}</span>
              <span>{{ d.resourceCount }}</span>
              <span>{{ d.collectionCount }}</span>
              <span class="gov-status"><i :data-on="d.status === 'ACTIVE' || d.status === 'active'" />{{ STATUS[d.status] || d.status }}</span>
            </div>
            <p v-if="!departments.length" class="set-cap gov-empty">还没有部门。</p>
          </div>
        </section>

        <section v-if="tab === 'apps'" class="gov-pane" data-d3-04d-pane="apps">
          <p class="set-cap gov-lead">决定哪些应用可用、可以使用哪些工具。应用声明的能力只对有权打开它的人生效。</p>
          <div class="set-group" data-d3-04d-apps>
            <div v-for="a in apps" :key="a.appId" :data-d3-04d-app="a.appId" class="setting-row">
              <span class="set-lab">{{ a.name }}<small><code>{{ a.appId }}</code> · 授权 {{ a.grantCount }} · 记忆访问 {{ a.memoryAccess ? "允许" : "不允许" }}</small></span>
              <span class="badge" :class="{ ok: a.status === 'enabled' }">{{ STATUS[a.status] || a.status }}</span>
              <DsButton variant="secondary" size="sm" :data-gov-tool-toggle="a.appId" @click="loadToolAccess(a.appId)">工具权限</DsButton>
              <DsButton v-if="a.status === 'enabled'" variant="ghost" size="sm" :data-d3-04d-app-disable="a.appId" @click="toggleApp(a.appId, 'disabled')">停用</DsButton>
              <DsButton v-else variant="secondary" size="sm" :data-d3-04d-app-enable="a.appId" @click="toggleApp(a.appId, 'enabled')">启用</DsButton>
            </div>
            <p v-if="!apps.length" class="set-cap gov-empty">没有可管理的应用。</p>
          </div>
          <section v-for="[appId, ta] in toolEntries" :key="appId" class="set-sec gov-tool" :data-gov-tool-access="appId">
            <h3>工具权限 · {{ ta.app?.name || appId }}</h3>
            <p class="set-cap">默认不授予；勾选后显式授予。已授予的动作只能整体撤销。</p>
            <div class="set-group" data-gov-tool-actions>
              <div v-for="action in availableActions(ta)" :key="action" :data-gov-tool-action="action" class="setting-row">
                <label class="gov-tool-pick set-lab">
                  <span><input type="checkbox" :checked="isChecked(appId, ta, action)" :disabled="isGranted(ta, action)" @change="toggleToolPick(appId, action)" /> <code>{{ action }}</code></span>
                </label>
                <span class="badge" :class="{ ok: isGranted(ta, action) }">{{ isGranted(ta, action) ? "已授予" : "未授予" }}</span>
              </div>
              <div class="setting-row set-actions">
                <DsButton variant="primary" size="sm" :data-gov-tool-grant="appId" @click="grantTools(appId)">授予所选工具权限</DsButton>
              </div>
            </div>
            <div class="gov-grants" data-gov-tool-grants>
              <div v-for="g in grantsOf(ta)" :key="g.grantId" :data-gov-tool-grant-id="g.grantId" class="gov-grant">
                <span class="gov-meta">{{ grantText(g) }}</span>
                <DsButton variant="ghost" size="sm" :data-gov-tool-revoke="g.grantId" @click="revokeTool(appId, g.grantId)">撤销全部工具权限</DsButton>
              </div>
            </div>
          </section>
        </section>

        <section v-if="tab === 'access'" class="gov-pane" data-d3-04d-pane="access">
          <p class="set-cap gov-lead">输入资源引用，查看谁能访问它、权限从哪里来。</p>
          <div class="set-group gov-form">
            <div class="setting-row">
              <input class="set-input gov-ref" data-d3-04d-access-ref placeholder="resource://..." v-model="accessRef" />
              <DsButton variant="secondary" size="sm" data-d3-04d-access-load @click="loadAccess">查看权限来源</DsButton>
            </div>
          </div>
          <div v-if="access" class="set-sec" data-d3-04d-access>
            <div class="set-group">
              <div class="setting-row" data-d3-04d-access-owner>
                <span class="set-lab">所有者 {{ access.resource.ownerUserId || "—" }}<small>范围 {{ access.resource.scope }} · 助理访问 {{ access.agentAccess ? "允许" : "不允许" }}</small></span>
              </div>
            </div>
            <h3>权限来源</h3>
            <div class="set-group" data-d3-04d-access-sources>
              <div v-for="(s, i) in access.sources" :key="i" class="setting-row" :data-d3-04d-access-source="s.source">
                <span class="set-lab">{{ s.source }}<small>{{ s.subjectType }}:{{ s.subjectId }}</small></span>
                <span class="gov-meta">{{ sourceActions(s) }}</span>
              </div>
            </div>
          </div>
        </section>

        <section v-if="tab === 'audit'" class="gov-pane" data-d3-04d-pane="audit">
          <div class="gov-table" data-d3-04d-audit>
            <div class="gov-tr gov-th gov-tr-audit"><span>动作</span><span>结果</span><span>原因</span><span>操作者</span><span>对象</span></div>
            <div v-for="(a, i) in audit" :key="i" data-d3-04d-audit-item class="gov-tr gov-tr-audit">
              <span class="gov-name">{{ a.action }}</span>
              <span><span class="badge" :class="{ ok: a.decision === 'ALLOW' || a.decision === 'allow' }">{{ a.decision }}</span></span>
              <span class="gov-meta">{{ a.reasonCode }}</span>
              <span class="gov-meta">{{ a.actorUserId || "—" }}</span>
              <span class="gov-meta gov-ellip">{{ a.resourceRef || a.departmentId || "—" }}</span>
            </div>
            <p v-if="!audit.length" class="set-cap gov-empty">暂无审计记录。</p>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
