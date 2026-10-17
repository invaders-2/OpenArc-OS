<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import DsButton from "../design-system/DsButton.vue";
import DsDialog from "../design-system/DsDialog.vue";
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
  NOT_SUPER_ADMIN: "需要超级管理员权限。",
  NOT_FOUND_OR_FORBIDDEN: "目标不存在，或你没有访问权限。",
  CROSS_DEPARTMENT_DENIED: "不能操作其他部门的成员。",
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
/* App 级 grant（resource.* namespace）：getAppAccess / grantAppAccess / revokeAppAccess。 */
const APP_GRANT_ACTIONS = ["resource.view", "resource.search", "resource.preview", "resource.read", "resource.create", "resource.edit", "resource.delete", "resource.restore", "resource.download", "resource.export", "resource.share", "resource.tag", "resource.move", "resource.useByAgent"];
const appAccess = ref<Record<string, any>>({});
const appPick = ref<Record<string, string[]>>({});
const appAccessOpenId = ref<string | null>(null);
const confirmState = ref<{ title: string; message: string; run: () => Promise<void> } | null>(null);

/* task-48 · 成员编辑弹窗。只调用 governance 白名单里真实存在的命令；
   后端没有 updateUser，显示名输入框保持只读并明确写出缺失，不伪造“已保存”。 */
type EditUser = any;
const editUser = ref<EditUser | null>(null);
const editRole = ref("MEMBER");
const editStatus = ref("ACTIVE");
const editDeptId = ref("");
const editDisplayName = ref("");
const editSaving = ref(false);
const editError = ref("");
const editPassword = ref<string | null>(null);
const editResourceRef = ref("");
const editAccess = ref<any>(null);
const editAccessLoading = ref(false);
const editAccessError = ref("");
const editGrantPick = ref<string[]>([]);
const EDIT_RESOURCE_ACTIONS = ["resource.view", "resource.search", "resource.preview", "resource.read", "resource.create", "resource.edit", "resource.delete", "resource.restore", "resource.download", "resource.export", "resource.share", "resource.tag", "resource.move", "resource.useByAgent"];
const editDeptCurrent = computed(() => (Array.isArray(editUser.value?.departments) ? editUser.value.departments[0] : null));
const editUserGrants = computed(() => {
  const rows = Array.isArray(editAccess.value?.grants) ? editAccess.value.grants : [];
  return rows.filter((g: any) => String(g.principalType || "").toUpperCase() === "USER" && String(g.principalId || "") === String(editUser.value?.userId || ""));
});

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

async function loadDepartmentsIfNeeded() {
  if (departments.value.length) return;
  const res = await cmd({ type: "governance/listDepartments" });
  if (res.ok) departments.value = Array.isArray(res.items) ? res.items : [];
}

async function openEdit(u: any) {
  editUser.value = u;
  editRole.value = u.role || "MEMBER";
  editStatus.value = u.status || "ACTIVE";
  editDisplayName.value = u.displayName || "";
  editDeptId.value = Array.isArray(u.departments) && u.departments[0]?.departmentId ? u.departments[0].departmentId : "";
  editSaving.value = false;
  editError.value = "";
  editPassword.value = null;
  editResourceRef.value = "";
  editAccess.value = null;
  editAccessError.value = "";
  editGrantPick.value = [];
  await loadDepartmentsIfNeeded();
}

function closeEdit() {
  editUser.value = null;
  editPassword.value = null;
  editError.value = "";
  editAccess.value = null;
  editAccessError.value = "";
}

async function saveMemberFields() {
  const user = editUser.value;
  if (!user) return;
  const displayName = editDisplayName.value.trim();
  if (!displayName) { editError.value = "显示名不能为空。"; return; }
  editSaving.value = true;
  editError.value = "";
  try {
    const current = user.departments?.[0];
    const targetDept = editDeptId.value;
    // 后端 updateUser 一次更新显示名/角色/状态/部门；departmentId 为空表示“不传”，
    // 所以“移出部门”仍需在后端不支持 null 的情况下单独走 removeDepartmentMember。
    const payload: Record<string, unknown> = { type: "governance/updateUser", userId: user.userId };
    if (displayName !== user.displayName) payload.displayName = displayName;
    if (editRole.value !== user.role) payload.role = editRole.value;
    if (editStatus.value !== user.status) payload.status = editStatus.value;
    if (targetDept && targetDept !== (current?.departmentId || "")) payload.departmentId = targetDept;
    const hasUpdate = ["displayName", "role", "status", "departmentId"].some((key) => payload[key] !== undefined);
    if (hasUpdate) {
      const res = await cmd(payload);
      if (!res.ok) { editError.value = errText(res.error); return; }
    }
    if (!targetDept && current?.departmentId) {
      const removed = await cmd({ type: "governance/removeDepartmentMember", departmentId: current.departmentId, userId: user.userId });
      if (!removed.ok) { editError.value = errText(removed.error); return; }
    }
    notice.value = "成员信息已保存（显示名 / 角色 / 状态 / 部门取后端真实结果）";
    await load();
    const refreshed = users.value.find((x) => x.userId === user.userId);
    if (refreshed) editUser.value = refreshed;
  } finally {
    editSaving.value = false;
  }
}

async function resetMemberPassword() {
  const user = editUser.value;
  if (!user) return;
  editError.value = "";
  const res = await cmd({ type: "governance/resetPassword", userId: user.userId });
  if (!res.ok) { editError.value = errText(res.error); return; }
  editPassword.value = String(res.temporaryPassword || "");
  notice.value = "临时口令已生成；关闭弹窗后不再显示";
}

async function loadMemberResourceAccess() {
  const user = editUser.value;
  const ref = editResourceRef.value.trim();
  if (!user || !ref) return;
  editAccessLoading.value = true;
  editAccessError.value = "";
  editAccess.value = null;
  try {
    const res = await cmd({ type: "governance/listResourceAccess", resourceRef: ref });
    if (res.ok) {
      editAccess.value = res;
      editGrantPick.value = [];
    } else editAccessError.value = errText(res.error);
  } finally {
    editAccessLoading.value = false;
  }
}

async function grantMemberResource() {
  const user = editUser.value;
  const resourceId = editAccess.value?.resource?.resourceId;
  const actions = [...editGrantPick.value];
  if (!user || !resourceId || !actions.length) return;
  editAccessError.value = "";
  const res = await cmd({ type: "governance/grantResourceAccess", principalType: "USER", principalId: user.userId, resourceId, actions });
  if (!res.ok) { editAccessError.value = errText(res.error); return; }
  notice.value = "已给该成员授予资源权限";
  await loadMemberResourceAccess();
}

async function revokeMemberResource(grantId: string) {
  editAccessError.value = "";
  const res = await cmd({ type: "governance/revokeResourceAccess", grantId });
  if (!res.ok) { editAccessError.value = errText(res.error); return; }
  notice.value = "已撤销该成员的资源授权";
  await loadMemberResourceAccess();
}

function toggleGrantAction(action: string) {
  editGrantPick.value = editGrantPick.value.includes(action)
    ? editGrantPick.value.filter((a) => a !== action)
    : [...editGrantPick.value, action];
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

/* ── App 级授权（resource.* namespace）────────────────────────────────── */
async function loadAppAccess(appId: string) {
  appAccessOpenId.value = appId;
  const res = await cmd({ type: "governance/getAppAccess", appId });
  if (res.ok) {
    appAccess.value = { ...appAccess.value, [appId]: res };
    appPick.value = { ...appPick.value, [appId]: [] };
  } else {
    error.value = res.error;
  }
}

function toggleAppPick(appId: string, action: string) {
  const cur = appPick.value[appId] || [];
  appPick.value = {
    ...appPick.value,
    [appId]: cur.includes(action) ? cur.filter((a) => a !== action) : [...cur, action],
  };
}

async function grantApp(appId: string) {
  const actions = [...(appPick.value[appId] || [])];
  if (!actions.length) {
    error.value = "请先选择要授予的 App 级动作。";
    return;
  }
  confirmState.value = {
    title: "授予 App 级权限",
    message: "将给应用 " + appId + " 授予 App 级动作：" + actions.join(", ") + "。授予后该应用按这些动作访问资源；可随时在这里撤销。",
    run: async () => {
      const res = await cmd({ type: "governance/grantAppAccess", appId, actions });
      if (res.ok) {
        notice.value = "App 级权限已授予";
        await loadAppAccess(appId);
        await load();
      } else {
        error.value = res.error;
      }
    },
  };
}

async function revokeApp(appId: string, grantId: string) {
  confirmState.value = {
    title: "撤销 App 级权限",
    message: "将撤销这条 App 级授权（" + grantId + "）。已建立的连接会按后端规则失效；撤销后不可恢复，只能重新授予。",
    run: async () => {
      const res = await cmd({ type: "governance/revokeAppAccess", grantId });
      if (res.ok) {
        notice.value = res.changed === false ? "这条授权已不存在（无需撤销）" : "App 级权限已撤销";
        await loadAppAccess(appId);
        await load();
      } else {
        error.value = res.error;
      }
    },
  };
}

async function doConfirm() {
  const current = confirmState.value;
  if (!current) return;
  confirmState.value = null;
  await current.run();
}

function appGrantsOf(appId: string): any[] {
  return Array.isArray(appAccess.value[appId]?.grants) ? appAccess.value[appId].grants : [];
}
function appPickChecked(appId: string, action: string): boolean {
  return (appPick.value[appId] || []).includes(action);
}

/* ── 投影（与 React 逐项同义）───────────────────────────────────────────── */
const toolEntries = computed<[string, any][]>(() => Object.entries(toolAccess.value));

function deptNames(u: any): string {
  const list = Array.isArray(u?.departments) ? u.departments.map((d: any) => d.name).filter(Boolean) : [];
  return list.join(", ") || "无部门";
}
/** 工具权限的中文名（设计语言 D6：界面只用中文，原值留在 code 小字与 data-* 里）。 */
const TOOL_LABEL: Record<string, string> = {
  "tool.test.echo": "测试回显",
  "tool.resource.readMetadata": "读取资源信息",
  "tool.resource.search": "搜索资源库",
  "tool.resource.readContent": "读取资源正文",
  "tool.resource.saveText": "把生成的文本存回资源库（需审批）",
  "tool.resource.trash": "把资源移到回收站（需审批）",
  "tool.browser.read": "读取网页内容",
  "tool.browser.navigate": "打开网址（需审批）",
  "tool.canvas.read": "读取画布",
  "tool.canvas.edit": "编辑画布（需审批）",
};
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
    <nav class="split-side" role="tablist" aria-label="组织分区">
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
                <DsButton variant="secondary" size="sm" :data-d3-04d-user-edit="u.userId" @click="openEdit(u)">编辑</DsButton>
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
              <DsButton variant="secondary" size="sm" :data-gov-app-access="a.appId" @click="loadAppAccess(a.appId)">应用授权</DsButton>
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
                  <span><input type="checkbox" :checked="isChecked(appId, ta, action)" :disabled="isGranted(ta, action)" @change="toggleToolPick(appId, action)" /> {{ TOOL_LABEL[action] || action }} <small class="gov-code"><code>{{ action }}</code></small></span>
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

          <section v-if="appAccessOpenId" class="set-sec gov-app-access" :data-gov-app-access-pane="appAccessOpenId">
            <h3>App 级权限 · {{ appAccess[appAccessOpenId]?.app?.name || appAccessOpenId }}</h3>
            <p class="set-cap">这是 App 级 resource.* 授权（governance/getAppAccess）；与上面的「工具权限」是同一张 App Grant 表的两个 namespace。授予/撤销都需要管理员权限，并会二次确认。</p>
            <p v-if="appAccess[appAccessOpenId]?.memoryGrants" class="set-cap">记忆访问授权：{{ appAccess[appAccessOpenId].memoryGrants }}</p>
            <div class="gov-grants" data-gov-app-grants>
              <div v-for="g in appGrantsOf(appAccessOpenId)" :key="g.grantId" :data-gov-app-grant-id="g.grantId" class="gov-grant">
                <span class="gov-meta">{{ grantText(g) }}</span>
                <DsButton variant="ghost" size="sm" :data-gov-app-revoke="g.grantId" @click="revokeApp(appAccessOpenId, g.grantId)">撤销这条 App 级授权</DsButton>
              </div>
              <p v-if="!appGrantsOf(appAccessOpenId).length" class="set-cap gov-empty">该应用还没有 App 级授权。</p>
            </div>
            <div class="set-group" data-gov-app-actions>
              <div v-for="action in APP_GRANT_ACTIONS" :key="action" class="setting-row">
                <label class="gov-tool-pick set-lab">
                  <span><input type="checkbox" :checked="appPickChecked(appAccessOpenId, action)" data-gov-app-action :data-action="action" @change="toggleAppPick(appAccessOpenId, action)" /> <code>{{ action }}</code></span>
                </label>
              </div>
              <div class="setting-row set-actions">
                <DsButton variant="primary" size="sm" :data-gov-app-grant="appAccessOpenId" @click="grantApp(appAccessOpenId)">授予所选 App 级权限</DsButton>
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

    <DsDialog :open="editUser !== null" :title="'编辑成员 · ' + (editUser?.displayName || editUser?.identifier || '')" @close="closeEdit">
      <div v-if="editUser" class="gov-edit" data-gov-edit-dialog :data-gov-edit-user="editUser.userId">
        <div class="gov-edit-who">
          <span class="gov-av">{{ initial(editUser) }}</span>
          <span class="gov-name">{{ editUser.displayName || editUser.identifier }}<small>{{ editUser.identifier }} · {{ editUser.userId }}</small></span>
        </div>

        <div class="set-group gov-edit-group">
          <label class="setting-row">
            <span class="set-lab">显示名<small>与角色/状态/部门一次提交 governance/updateUser</small></span>
            <input class="set-input" data-gov-edit-display v-model="editDisplayName" placeholder="显示名" maxlength="120" />
          </label>
          <label class="setting-row">
            <span class="set-lab">角色</span>
            <select class="set-select" data-gov-edit-role v-model="editRole">
              <option value="MEMBER">成员</option>
              <option value="ADMIN">管理员</option>
            </select>
          </label>
          <label class="setting-row">
            <span class="set-lab">状态</span>
            <select class="set-select" data-gov-edit-status v-model="editStatus">
              <option value="ACTIVE">在线可用</option>
              <option value="DISABLED">已停用</option>
            </select>
          </label>
          <label class="setting-row">
            <span class="set-lab">部门<small>当前 {{ editDeptCurrent?.name || "无部门" }}</small></span>
            <select class="set-select" data-gov-edit-dept v-model="editDeptId">
              <option value="">无部门</option>
              <option v-for="d in departments" :key="d.departmentId" :value="d.departmentId">{{ d.name }}</option>
            </select>
          </label>
          <div class="setting-row set-actions">
            <DsButton variant="primary" size="sm" data-gov-edit-save :status="editSaving ? 'loading' : 'idle'" @click="saveMemberFields">保存成员信息</DsButton>
            <DsButton variant="secondary" size="sm" data-gov-edit-reset :disabled="editSaving" @click="resetMemberPassword">重置密码</DsButton>
          </div>
        </div>

        <p v-if="editPassword" class="gov-edit-secret" data-gov-edit-temp-password>临时口令（只显示这一次，关闭后失效）：<code>{{ editPassword }}</code></p>
        <p v-if="editError" class="gov-error" role="alert" data-gov-edit-error>{{ editError }}</p>

        <section class="set-sec gov-edit-access">
          <h3>资源权限</h3>
          <p class="set-cap">输入资源引用后读取真实授权表；只展示 principal=USER 且是该成员的授权。授予 / 撤销都走 governance 写命令。</p>
          <div class="gov-edit-ref">
            <input class="set-input" data-gov-edit-resource-ref placeholder="resource://..." v-model="editResourceRef" />
            <DsButton variant="secondary" size="sm" data-gov-edit-load-access :status="editAccessLoading ? 'loading' : 'idle'" @click="loadMemberResourceAccess">读取该成员的资源授权</DsButton>
          </div>
          <p v-if="editAccessError" class="gov-error" role="alert" data-gov-edit-access-error>{{ editAccessError }}</p>
          <div v-if="editAccess" class="gov-edit-grant-block" data-gov-edit-access>
            <p class="gov-meta">资源 {{ editAccess.resource?.name || editAccess.resource?.resourceRef }} · 所有者 {{ editAccess.resource?.ownerUserId || "—" }}</p>
            <div v-if="editUserGrants.length" class="gov-grants" data-gov-edit-grants>
              <div v-for="g in editUserGrants" :key="g.grantId" class="gov-grant" :data-gov-edit-grant-id="g.grantId">
                <span class="gov-meta">{{ grantText(g) }}</span>
                <DsButton variant="ghost" size="sm" :data-gov-edit-revoke="g.grantId" @click="revokeMemberResource(g.grantId)">撤销该成员这条授权</DsButton>
              </div>
            </div>
            <p v-else class="set-cap gov-empty" data-gov-edit-grants-empty>该成员没有这个资源的直接授权。</p>
            <div class="gov-edit-actions" data-gov-edit-access-actions>
              <label v-for="action in EDIT_RESOURCE_ACTIONS" :key="action" class="gov-edit-action">
                <input type="checkbox" :checked="editGrantPick.includes(action)" :data-gov-edit-action="action" @change="toggleGrantAction(action)" />
                <code>{{ action }}</code>
              </label>
              <DsButton variant="primary" size="sm" data-gov-edit-grant :disabled="!editGrantPick.length" @click="grantMemberResource">授予所选动作</DsButton>
            </div>
          </div>
        </section>

        <section class="set-sec gov-edit-apps">
          <h3>App 权限</h3>
          <p class="set-cap" data-gov-edit-app-unavailable>后端没有「按成员查询/编辑 App 授权」的 governance 命令：getAppAccess 只按 App 聚合，无法定位到某个成员。这里如实标为不可用，不伪造分配；资源级权限可在上方真实编辑。</p>
        </section>
      </div>
      <template #footer>
        <button class="ghost" type="button" @click="closeEdit">关闭</button>
      </template>
    </DsDialog>

    <DsDialog :open="confirmState !== null" :title="confirmState?.title || ''" @close="confirmState = null">
      <p class="set-cap">{{ confirmState?.message }}</p>
      <template #footer>
        <button class="ghost" type="button" @click="confirmState = null">取消</button>
        <button class="primary" type="button" data-gov-app-confirm @click="doConfirm">确认执行</button>
      </template>
    </DsDialog>
  </div>
</template>

<style scoped>
/* 编辑弹窗是表单型对话框：复用 DsDialog，但按内容宽度/可读性局部收紧（不新增颜色）。 */
:deep(.dialog:has(.gov-edit)) {
  width: min(720px, calc(100% - 64px));
  background: rgb(var(--content-rgb) / 0.96);
  backdrop-filter: blur(28px) saturate(1.5);
  -webkit-backdrop-filter: blur(28px) saturate(1.5);
}
.gov-edit { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.gov-edit-who { display: flex; align-items: center; gap: 10px; }
.gov-edit-who .gov-name { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.gov-edit-who small { color: var(--muted); font-size: var(--fs-micro); overflow-wrap: anywhere; }
.gov-edit-group { margin: 0; }
.gov-edit-group .setting-row { padding-left: 0; padding-right: 0; }
.gov-edit-secret { margin: 0; padding: 10px 12px; border-radius: var(--radius-md); background: rgb(var(--text-rgb) / 0.06); font-size: var(--fs-caption); line-height: var(--lh-normal); }
.gov-edit-secret code { display: inline-block; margin-left: 6px; padding: 2px 7px; border-radius: 6px; background: rgb(var(--text-rgb) / 0.08); font-family: var(--font-mono); user-select: text; overflow-wrap: anywhere; }
.gov-edit-ref { display: flex; align-items: center; gap: 8px; }
.gov-edit-ref .set-input { flex: 1; min-width: 0; }
.gov-edit-grant-block { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.gov-edit-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-top: 8px; }
.gov-edit-action { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-micro); color: var(--muted); }
.gov-edit-action code { font-family: var(--font-mono); color: var(--text); }
.gov-edit-apps { margin-top: 2px; }
@container (max-width: 760px) {
  .gov-edit { min-width: 0; max-width: none; }
  .gov-edit-ref { flex-wrap: wrap; }
}
</style>
