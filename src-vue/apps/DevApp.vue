<script setup lang="ts">
import { t } from "../i18n";
import { computed, onMounted, ref } from "vue";
import {
  Boxes,
  Download,
  FlaskConical,
  Power,
  PowerOff,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Sparkles,
  TerminalSquare,
  Trash2,
  Users,
} from "lucide-vue-next";
import DsBadge from "../design-system/DsBadge.vue";
import DsButton from "../design-system/DsButton.vue";
import DsDialog from "../design-system/DsDialog.vue";
import DsPageState from "../design-system/DsPageState.vue";
import CliPanel from "../settings/CliPanel.vue";
import { useIdentityStore } from "../stores/identity";
import { devlog } from "../devlog";
import {
  detailText,
  domainBridge,
  failureText,
  formatBytes,
  formatTime,
  invokeDomain,
  resultFailure,
  resultValue,
  type CommandReply,
  type FailureView,
} from "../bridge/domain";

/**
 * 开发者工作台（0.6.1 · 重做）。
 *
 * 只调既有 developer:command（70 条白名单 + developer:event 下行），不新增 IPC：
 *   · 开发项目：已装载的本地开发应用（developer/list）与实验室草稿（developer/lab/list）
 *   · 实验室：示例模板、从模板建草稿、读草稿文件、打包 ZIP、删除草稿、离线文档缓存状态
 *   · 协作与实时房间：developer/collab/* 与 developer/realtime/*
 *   · 命令与日志：developer/health 的真实装配状态 + 本次窗口命令记录 + 渲染进程运行日志
 *   · CLI：复用系统设置里已经接 cli:command 的 CliPanel
 * 后端没有的能力一律如实标注（未装配 / 未认证 / 依赖缺失），不放示例数据。
 */
const HOST_APP = "ai";
const identity = useIdentityStore();
const hasBridge = ref(!!domainBridge(typeof window === "undefined" ? null : window, "developer"));
const userId = computed(() => identity.snapshot.userId ?? "");
const userName = computed(() => identity.snapshot.displayName ?? userId.value);

type Tab = "projects" | "lab" | "collab" | "commands" | "cli";
const tab = ref<Tab>("projects");
const TABS: { id: Tab; label: string; icon: unknown }[] = [
  { id: "projects", label: "开发项目", icon: Boxes },
  { id: "lab", label: "实验室（沙箱）", icon: FlaskConical },
  { id: "collab", label: "协作与实时房间", icon: Users },
  { id: "commands", label: "命令与日志", icon: ScrollText },
  { id: "cli", label: "CLI 工具", icon: TerminalSquare },
];

type LogEntry = { at: number; command: string; ok: boolean; code?: string; detail?: string };
type HealthValue = {
  ok?: boolean;
  tables?: Record<string, boolean>;
  tablesReady?: boolean;
  missingTables?: string[];
  dataRootReady?: boolean;
  installedApps?: number;
  commands?: number;
  declaredCommands?: number;
  extensions?: Record<string, "ok" | "missing" | "degraded"> | null;
  degraded?: boolean;
  degradedReason?: string | null;
  network?: { httpsOnly?: boolean; dnsPublicCheck?: boolean; rateLimitPerMinute?: number };
};
type Manifest = {
  name?: string;
  subtitle?: string;
  description?: string;
  entry?: string;
  releaseChannel?: string;
  permissions?: string[];
  network?: { domains?: string[]; methods?: string[] } | null;
};
type InstalledApp = {
  appId: string;
  enabled: boolean;
  version: string;
  build?: number;
  releaseChannel?: string;
  installedAt?: number | null;
  updatedAt?: number | null;
  packageSize?: number;
  historyCount?: number;
  manifest?: Manifest | null;
  capabilities?: { tools?: { name: string; title?: string }[]; mcp?: { id: string; name?: string }[]; skills?: { title?: string }[]; warnings?: string[] } | null;
};
type LabCheck = { id: string; label: string; status: "pass" | "warn" | "fail" | string; detail?: string };
type LabDraft = {
  id: string;
  name: string;
  appId: string;
  summary?: string;
  files?: { path: string; bytes: number }[];
  checks?: LabCheck[];
  createdAt?: number;
  previewUrl?: string;
  downloadUrl?: string;
  icon?: unknown;
};
type LabTemplate = { id: string; name: string; subtitle?: string; description?: string; category?: string; entry?: string; fileCount?: number };
type CollabProject = {
  id: string;
  appId?: string | null;
  ownerId: string;
  name: string;
  kind?: string;
  visibility?: string;
  publicAccess?: string;
  version?: number;
  access?: string;
  members?: { userId: string; access: string }[];
  revision?: string;
  invite?: { id: string; codeHint: string; access: string; createdAt: number };
  createdAt?: number;
  updatedAt?: number;
  document?: unknown;
};
type RealtimeRoom = {
  id: string;
  appId: string;
  name: string;
  ownerId: string;
  discoverable: boolean;
  maxMembers: number;
  members: number;
  seq: number;
  createdAt: number;
  updatedAt: number;
};
type RoomDetail = RealtimeRoom & { state?: unknown; memberList?: { clientId: string; userId: string; username: string }[] };

const health = ref<HealthValue | null>(null);
const healthError = ref<FailureView | null>(null);
const apps = ref<InstalledApp[]>([]);
const appsError = ref<FailureView | null>(null);
const drafts = ref<LabDraft[]>([]);
const labError = ref<FailureView | null>(null);
const templates = ref<LabTemplate[]>([]);
const templatesError = ref<FailureView | null>(null);
const docsStatus = ref<Record<string, unknown> | null>(null);
const docsError = ref<FailureView | null>(null);
const selectedDraft = ref<LabDraft | null>(null);
const draftFile = ref<{ path: string; content: string } | null>(null);
const draftFileError = ref<FailureView | null>(null);
const projects = ref<CollabProject[]>([]);
const projectsError = ref<FailureView | null>(null);
const selectedProject = ref<CollabProject | null>(null);
const projectError = ref<FailureView | null>(null);
const projectName = ref("");
const rooms = ref<RealtimeRoom[]>([]);
const roomsError = ref<FailureView | null>(null);
const selectedRoom = ref<RoomDetail | null>(null);
const roomError = ref<FailureView | null>(null);
const roomName = ref("");
const transport = ref<{ configured: boolean; kind?: string } | null>(null);
const transportError = ref<FailureView | null>(null);
const realtimeStats = ref<{ rooms: number; peers: number; detached: number } | null>(null);
const myClientIds = ref<Record<string, string>>({});
const loading = ref(false);
const busy = ref<string | null>(null);
const notice = ref("");
const actionError = ref<FailureView | null>(null);
const commandLog = ref<LogEntry[]>([]);
const confirmState = ref<{ title: string; message: string; run: () => Promise<void> } | null>(null);

/* ── 开发者 App Agent 会话入口（task-35 第二部分）：真实 agent 命令 ──────── */
type DevAgentOutcome = {
  gateway?: string;
  appId?: string;
  projectId?: string;
  sessionId?: string;
  text?: string;
  outcome?: { text?: string; [key: string]: unknown };
  [key: string]: unknown;
};
const agentAvailable = ref(!!window.openarc?.agent);
const agentApp = ref<{ appId: string; name: string } | null>(null);
const agentInstruction = ref("");
const agentMode = ref<"assistant" | "thinking" | "agent">("thinking");
const agentBusy = ref(false);
const agentError = ref<FailureView | null>(null);
const agentResult = ref<DevAgentOutcome | null>(null);
const agentResultText = computed(() => {
  const value = agentResult.value;
  if (!value) return "";
  if (typeof value.text === "string" && value.text) return value.text;
  if (value.outcome && typeof value.outcome.text === "string" && value.outcome.text) return value.outcome.text;
  return "";
});
function openAppAgent(app: InstalledApp) {
  agentApp.value = { appId: app.appId, name: app.manifest?.name || app.appId };
  agentInstruction.value = "";
  agentError.value = null;
  agentResult.value = null;
}
async function runAppAgent() {
  if (!agentApp.value || !agentInstruction.value.trim() || agentBusy.value) return;
  agentBusy.value = true;
  agentError.value = null;
  agentResult.value = null;
  const reply = await invokeDomain("agent", "agent/developer-app/run", {
    appId: agentApp.value.appId,
    instruction: agentInstruction.value.trim(),
    executionProfile: agentMode.value,
  });
  agentBusy.value = false;
  const value = resultValue<DevAgentOutcome>(reply);
  if (!value) {
    agentError.value = resultFailure(reply);
    return;
  }
  agentResult.value = value;
}

const APP_SECTION_TITLE: Record<Tab, string> = {
  projects: "开发项目",
  lab: "实验室（沙箱）",
  collab: "协作与实时房间",
  commands: "命令与日志",
  cli: "CLI 工具",
};

function record(command: string, reply: CommandReply) {
  const failure = resultFailure(reply);
  commandLog.value = [
    { at: Date.now(), command, ok: !failure, code: failure?.code, detail: failure ? detailText(failure.detail) || failure.message : undefined },
    ...commandLog.value,
  ].slice(0, 120);
}

async function send(command: string, payload: Record<string, unknown> = {}): Promise<CommandReply> {
  if (!hasBridge.value) return { ok: false, error: "BRIDGE_ABSENT" };
  const reply = await invokeDomain("developer", command, payload);
  record(command, reply);
  return reply;
}

/**
 * 开发者命令有两种成功信封（都是主进程真值）：
 *   · B7a 基座：{ ok:true, value:<payload> }
 *   · B7b 四切片（lab / collab / migrations / realtime）：{ ok:true, ...payload }
 * 这里只做形状归一，不补任何字段；失败信封原样交给 resultFailure。
 */
function payloadOf<T>(reply: CommandReply): T | null {
  if (resultFailure(reply)) return null;
  const value = (reply as { value?: unknown }).value;
  return (value === undefined ? reply : value) as T;
}

/** 开发者域特有失败码的人话；未登记的码回落到共用文案。 */
const DEV_FAILURE_TEXT: Record<string, string> = {
  DEVELOPER_NOT_READY: "开发者平台尚未装配。",
  DEVELOPER_UNAUTHENTICATED: "当前会话未认证，开发者命令被拒绝；重新登录后再试。",
  DEVELOPER_COMMAND_NOT_ALLOWED: "命令不在 developer:command 白名单内。",
  DEVELOPER_REALTIME_TRANSPORT_UNAVAILABLE: "主进程没有注入实时传输；房间只停留在本机进程内，不会假装连到局域网",
  DEVELOPER_REALTIME_UNAVAILABLE: "实时房间切片没有装配。",
  DEVELOPER_COLLAB_UNAVAILABLE: "协同项目切片没有装配。",
  DEVELOPER_LAB_UNAVAILABLE: "开发者实验室切片没有装配。",
  DEVELOPER_DOCS_UNAVAILABLE: "离线开发文档没有随包提供缓存。",
  DEVELOPER_DOCS_REMOTE_DISABLED: "开发文档的远端刷新已停用（本仓不接云端）。",
  DEVELOPER_MIGRATION_FS_UNAVAILABLE: "迁移切片缺少虚拟文件树，迁移命令结构化不可用。",
};
function devFailure(view: FailureView | null): string {
  if (!view) return "";
  return DEV_FAILURE_TEXT[view.code] || failureText(view);
}

async function loadHealth() {
  const reply = await send("developer/health", {});
  const value = payloadOf<HealthValue>(reply);
  if (value) {
    health.value = value;
    healthError.value = null;
  } else healthError.value = resultFailure(reply);
}

async function loadApps() {
  const reply = await send("developer/list", {});
  const value = payloadOf<{ apps?: InstalledApp[]; count?: number }>(reply);
  if (value) {
    apps.value = Array.isArray(value.apps) ? value.apps : [];
    appsError.value = null;
  } else appsError.value = resultFailure(reply);
}

async function loadLab() {
  const [listReply, templateReply, docsReply] = await Promise.all([
    send("developer/lab/list", {}),
    send("developer/lab/templates", {}),
    send("developer/docs/status", {}),
  ]);
  const listValue = payloadOf<{ drafts?: LabDraft[] }>(listReply);
  if (listValue) {
    drafts.value = Array.isArray(listValue.drafts) ? listValue.drafts : [];
    labError.value = null;
    if (selectedDraft.value && !drafts.value.some((item) => item.id === selectedDraft.value?.id)) selectedDraft.value = null;
  } else labError.value = resultFailure(listReply);

  const templateValue = payloadOf<{ templates?: LabTemplate[] }>(templateReply);
  if (templateValue) {
    templates.value = Array.isArray(templateValue.templates) ? templateValue.templates : [];
    templatesError.value = null;
  } else templatesError.value = resultFailure(templateReply);

  const docsValue = payloadOf<{ status?: Record<string, unknown> }>(docsReply);
  if (docsValue?.status) {
    docsStatus.value = docsValue.status;
    docsError.value = null;
  } else {
    docsStatus.value = null;
    docsError.value = resultFailure(docsReply);
  }
}

async function loadCollab() {
  const reply = await send("developer/collab/list", {});
  const value = payloadOf<{ items?: CollabProject[] }>(reply);
  if (value) {
    projects.value = Array.isArray(value.items) ? value.items : [];
    projectsError.value = null;
  } else projectsError.value = resultFailure(reply);
}

async function loadRealtime() {
  const transportReply = await send("developer/realtime/transportStatus", {});
  const transportValue = payloadOf<{ configured?: boolean; kind?: string }>(transportReply);
  if (transportValue) {
    transport.value = { configured: transportValue.configured === true, kind: transportValue.kind };
    transportError.value = null;
  } else {
    transport.value = null;
    transportError.value = resultFailure(transportReply);
  }
  const statsReply = await send("developer/realtime/stats", {});
  const statsValue = payloadOf<{ stats?: { rooms: number; peers: number; detached: number } }>(statsReply);
  realtimeStats.value = statsValue?.stats ?? null;

  const listReply = await send("developer/realtime/list", { appId: HOST_APP, userId: userId.value });
  const listValue = payloadOf<{ rooms?: RealtimeRoom[] }>(listReply);
  if (listValue) {
    rooms.value = Array.isArray(listValue.rooms) ? listValue.rooms : [];
    roomsError.value = null;
  } else roomsError.value = resultFailure(listReply);
}

async function loadTab() {
  if (!hasBridge.value) return;
  loading.value = true;
  actionError.value = null;
  if (tab.value !== "cli") await loadHealth();
  if (tab.value === "projects") {
    await Promise.all([loadApps(), loadLab()]);
  } else if (tab.value === "lab") {
    await loadLab();
  } else if (tab.value === "collab") {
    await Promise.all([loadCollab(), loadRealtime()]);
  }
  loading.value = false;
}

function switchTab(next: Tab) {
  tab.value = next;
  notice.value = "";
  actionError.value = null;
  void loadTab();
}

async function runAction(key: string, command: string, payload: Record<string, unknown> = {}) {
  busy.value = key;
  actionError.value = null;
  notice.value = "";
  const reply = await send(command, payload);
  busy.value = null;
  const value = payloadOf<Record<string, unknown>>(reply);
  if (!value) {
    actionError.value = resultFailure(reply);
    return null;
  }
  return value;
}

async function createFromTemplate(template: LabTemplate) {
  const value = await runAction("create-draft", "developer/lab/createFromTemplate", { templateId: template.id });
  if (value) {
    notice.value = "已从「" + template.name + "」创建开发草稿；草稿在实验室里可以继续读取文件与打包。";
    await loadLab();
  }
}

async function deleteDraft(draft: LabDraft) {
  confirmState.value = {
    title: "删除开发草稿",
    message: "会删除草稿目录与其中的文件；已装载的开发者应用不受影响。",
    run: async () => {
      const value = await runAction("delete-draft", "developer/lab/delete", { id: draft.id });
      if (value) {
        notice.value = "草稿已删除。";
        selectedDraft.value = null;
        draftFile.value = null;
        await loadLab();
      }
    },
  };
}

async function exportDraft(draft: LabDraft) {
  const value = await runAction("zip-draft", "developer/lab/zip", { id: draft.id });
  if (!value) return;
  const box = value as Record<string, unknown>;
  const base64 = typeof box.base64 === "string" ? box.base64 : "";
  if (!base64) {
    actionError.value = { code: "MALFORMED_REPLY", message: "主进程没有返回可下载的 ZIP 字节。" };
    return;
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = draft.appId + ".zip";
  anchor.click();
  URL.revokeObjectURL(url);
  notice.value = "已导出 " + formatBytes(bytes.byteLength) + " 的 ZIP；sha256 " + String(box.sha256 || "").slice(0, 16) + "…";
}

async function openDraft(draft: LabDraft) {
  selectedDraft.value = draft;
  draftFile.value = null;
  draftFileError.value = null;
}

async function readDraftFile(draft: LabDraft, path: string) {
  const reply = await send("developer/lab/readFile", { id: draft.id, path });
  const value = payloadOf<{ file?: { path: string; content: string } }>(reply);
  if (value?.file) {
    draftFile.value = value.file;
    draftFileError.value = null;
  } else {
    draftFile.value = null;
    draftFileError.value = resultFailure(reply);
  }
}

function toggleApp(app: InstalledApp) {
  confirmState.value = {
    title: app.enabled ? "停用开发者应用" : "启用开发者应用",
    message: app.enabled
      ? "停用只移除用户安装状态，安装文件与回滚点保留，可再次启用。"
      : "启用会把当前版本写回用户安装状态；运行时能力仍受声明的权限约束。",
    run: async () => {
      const value = await runAction("toggle-app", app.enabled ? "developer/disable" : "developer/enable", { appId: app.appId });
      if (value) {
        notice.value = app.enabled ? "已停用「" + (app.manifest?.name || app.appId) + "」。" : "已启用「" + (app.manifest?.name || app.appId) + "」。";
        await Promise.all([loadApps(), loadHealth()]);
      }
    },
  };
}

function rollbackApp(app: InstalledApp) {
  confirmState.value = {
    title: "回滚到上一版本",
    message: "当前版本会被保留为回滚点；启用状态下同步更新安装版本。",
    run: async () => {
      const value = await runAction("rollback-app", "developer/rollback", { appId: app.appId });
      if (value) {
        notice.value = "已回滚「" + (app.manifest?.name || app.appId) + "」。";
        await Promise.all([loadApps(), loadHealth()]);
      }
    },
  };
}

function uninstallApp(app: InstalledApp) {
  confirmState.value = {
    title: "卸载开发者应用",
    message: "会清理安装目录、清单缓存与凭据绑定；运行时事件与网络审计保留。",
    run: async () => {
      const value = await runAction("uninstall-app", "developer/uninstall", { appId: app.appId });
      if (value) {
        notice.value = "已卸载「" + (app.manifest?.name || app.appId) + "」。";
        await Promise.all([loadApps(), loadHealth()]);
      }
    },
  };
}

async function createProject() {
  const name = projectName.value.trim();
  if (!name) {
    actionError.value = { code: "INVALID", message: "先填写协同项目名称。" };
    return;
  }
  if (!userId.value) {
    actionError.value = { code: "UNAUTHENTICATED", message: "当前会话没有身份用户 ID，协同项目按后端拒绝。" };
    return;
  }
  const value = await runAction("create-project", "developer/collab/create", { name });
  if (value) {
    projectName.value = "";
    notice.value = "协同项目已创建（落在既有 projects 表）。";
    await loadCollab();
  }
}

async function openProject(project: CollabProject) {
  projectError.value = null;
  selectedProject.value = null;
  const reply = await send("developer/collab/get", { projectId: project.id });
  const value = payloadOf<{ project?: CollabProject }>(reply);
  if (value?.project) selectedProject.value = value.project;
  else projectError.value = resultFailure(reply);
}

async function createRoom() {
  const name = roomName.value.trim();
  if (!userId.value) {
    actionError.value = { code: "UNAUTHENTICATED", message: "实时房间需要当前会话用户 ID；先在应用里登录。" };
    return;
  }
  const value = await runAction("create-room", "developer/realtime/create", { appId: HOST_APP, ownerId: userId.value, name: name || "协作房间" });
  if (value) {
    roomName.value = "";
    notice.value = "房间已创建在本机进程内；传输未装配时不会假装连到局域网。";
    await loadRealtime();
  }
}

async function openRoom(room: RealtimeRoom) {
  roomError.value = null;
  selectedRoom.value = null;
  const reply = await send("developer/realtime/get", { appId: HOST_APP, roomId: room.id });
  const value = payloadOf<{ room?: RoomDetail }>(reply);
  if (value?.room) selectedRoom.value = value.room;
  else roomError.value = resultFailure(reply);
}

function clientIdOf(roomId: string): string {
  if (!myClientIds.value[roomId]) {
    myClientIds.value = { ...myClientIds.value, [roomId]: crypto.randomUUID() };
  }
  return myClientIds.value[roomId];
}

async function joinRoom(room: RealtimeRoom) {
  const clientId = clientIdOf(room.id);
  const value = await runAction("join-room", "developer/realtime/join", {
    appId: HOST_APP,
    roomId: room.id,
    clientId,
    userId: userId.value,
    username: userName.value,
  });
  if (value) {
    notice.value = "已以本窗口客户端加入房间；成员与序号是主进程权威值。";
    await Promise.all([loadRealtime(), openRoom(room)]);
  }
}

async function leaveRoom(room: RealtimeRoom) {
  const clientId = myClientIds.value[room.id];
  if (!clientId) {
    notice.value = "本窗口不在这个房间里。";
    return;
  }
  await runAction("leave-room", "developer/realtime/leave", { appId: HOST_APP, roomId: room.id, clientId });
  await Promise.all([loadRealtime(), openRoom(room)]);
}

function closeRoom(room: RealtimeRoom) {
  confirmState.value = {
    title: "关闭实时房间",
    message: "仅房主可以关闭；关闭后其余成员会收到 closed 事件，重连记录一并清理。",
    run: async () => {
      const value = await runAction("close-room", "developer/realtime/close", { appId: HOST_APP, roomId: room.id, userId: userId.value });
      if (value) {
        notice.value = "房间已关闭。";
        selectedRoom.value = null;
        await loadRealtime();
      }
    },
  };
}

async function doConfirm() {
  const state = confirmState.value;
  if (!state) return;
  confirmState.value = null;
  await state.run();
}

const extensionRows = computed(() => {
  const extensions = health.value?.extensions;
  if (!extensions) return [];
  return Object.entries(extensions).map(([name, status]) => ({
    name: ({ lab: "实验室", collab: "协同项目", migrations: "数据迁移", realtime: "实时房间" } as Record<string, string>)[name] || name,
    status,
  }));
});
const healthTone = computed<"success" | "warning" | "danger" | "neutral">(() => {
  if (!health.value) return "neutral";
  if (health.value.degraded || !health.value.tablesReady) return "warning";
  return "success";
});
const healthLabel = computed(() => {
  if (!health.value) return "未读取";
  if (!health.value.tablesReady) return "数据库表未就绪";
  if (health.value.degraded) return "部分切片降级";
  return "全部装配";
});
const passCount = (draft: LabDraft) => (draft.checks || []).filter((item) => item.status === "pass").length;
const failCount = (draft: LabDraft) => (draft.checks || []).filter((item) => item.status === "fail").length;
const warnCount = (draft: LabDraft) => (draft.checks || []).filter((item) => item.status === "warn").length;
const draftFileList = computed(() => selectedDraft.value?.files ?? []);

function checkTone(status: string): "success" | "warning" | "danger" | "neutral" {
  if (status === "pass") return "success";
  if (status === "warn") return "warning";
  if (status === "fail") return "danger";
  return "neutral";
}
const CHECK_TEXT: Record<string, string> = { pass: "通过", warn: "建议处理", fail: "不通过" };
const EXT_TEXT: Record<string, string> = { ok: "已装配", degraded: "降级", missing: "未装配" };

/** 本机运行环境（只读 UA / 平台；不在模板里写类型断言）。 */
const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
const electronVersion = (ua.match(/Electron\/([\d.]+)/) || [])[1] || "—";
const chromiumVersion = (ua.match(/Chrome\/([\d.]+)/) || [])[1] || "—";
const platformName =
  (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform ||
  (typeof navigator === "undefined" ? "—" : navigator.platform);

onMounted(() => {
  void loadTab();
});
</script>

<template>
  <div class="split planned-app dev-app">
    <nav class="split-side" :aria-label="t('开发者')">
      <div class="split-section">{{ t("开发者") }}</div>
      <button
        v-for="entry in TABS"
        :key="entry.id"
        type="button"
        class="split-nav"
        :data-dev-tab="entry.id"
        :aria-current="tab === entry.id ? 'true' : undefined"
        @click="switchTab(entry.id)"
      >
        <component :is="entry.icon" :size="16" />
        <span class="split-nav-label">{{ entry.label }}</span>
        <small v-if="entry.id === 'projects'" class="integr-count">{{ apps.length }}</small>
        <small v-if="entry.id === 'lab'" class="integr-count">{{ drafts.length }}</small>
        <small v-if="entry.id === 'collab'" class="integr-count">{{ rooms.length }}</small>
      </button>
      <p class="planned-note">{{ t("本页的所有数据都来自 developer:command；没有桥、没有会话或切片未装配时如实显示，不放演示数据。") }}</p>
    </nav>

    <div class="split-main dev-main">
      <div class="pane-toolbar">
        <strong class="pane-title">{{ APP_SECTION_TITLE[tab] }}</strong>
        <div class="toolbar-spacer" />
        <DsBadge v-if="tab !== 'cli'" size="sm" :tone="healthTone">{{ healthLabel }}</DsBadge>
        <DsBadge v-if="identity.snapshot.sessionRef && userId" size="sm">{{ userName || userId }}</DsBadge>
        <DsButton v-if="tab !== 'cli'" size="sm" variant="ghost" :status="loading ? 'loading' : 'idle'" data-dev-refresh @click="loadTab">
          <RefreshCw :size="13" /> {{ t("刷新") }}
        </DsButton>
      </div>

      <DsPageState
        v-if="!hasBridge"
        kind="unavailable"
        :title="t('当前环境没有开发者域的桥')"
        description="浏览器预览不提供 developer:command；请在 OpenArc 桌面应用中打开开发者。"
      />

      <div v-else class="dev-scroll">
        <p v-if="actionError" class="integr-error" role="alert" :data-dev-error="actionError.code">{{ devFailure(actionError) }}<span v-if="actionError.detail" class="integr-detail"> · {{ detailText(actionError.detail) }}</span></p>
        <p v-if="notice" class="integr-ok" role="status">{{ notice }}</p>

        <!-- ═══════════ 开发项目 ═══════════ -->
        <template v-if="tab === 'projects'">
          <section class="integr-sec">
            <h3>{{ t("已装载的本地开发应用") }}</h3>
            <DsPageState v-if="appsError" kind="error" :title="t('读不到本地开发应用')" :description="devFailure(appsError)" :on-action="loadApps" />
            <DsPageState
              v-else-if="!apps.length"
              kind="empty"
              :title="t('还没有装载本地开发应用')"
              description="在「实验室」用模板创建草稿，打包 ZIP 后再走 developer/install 才能装载；当前没有可显示的已装应用。"
            />
            <ul v-else class="integr-rows">
              <li v-for="app in apps" :key="app.appId" class="integr-row dev-app-row" :data-dev-app="app.appId">
                <div class="dev-app-main">
                  <div class="dev-app-title">
                    <b>{{ app.manifest?.name || app.appId }}</b>
                    <span class="mono">{{ app.appId }} · v{{ app.version }}{{ app.build ? "+" + app.build : "" }}</span>
                    <DsBadge size="sm" :tone="app.enabled ? 'success' : 'neutral'">{{ app.enabled ? t("已启用") : t("已停用") }}</DsBadge>
                    <DsBadge v-if="app.releaseChannel" size="sm">{{ app.releaseChannel }}</DsBadge>
                  </div>
                  <p v-if="app.manifest?.description" class="dev-app-desc">{{ app.manifest.description }}</p>
                  <p class="dev-app-meta">
                    包大小 {{ formatBytes(app.packageSize) }} · 历史版本 {{ app.historyCount ?? 0 }} · 安装于 {{ formatTime(app.installedAt) }}
                    <template v-if="app.manifest?.network?.domains?.length"> · 出网声明 {{ app.manifest.network.domains.join(", ") }}</template>
                  </p>
                  <p v-if="app.capabilities?.warnings?.length" class="dev-app-warn">{{ app.capabilities.warnings.join("；") }}</p>
                </div>
                <div class="dev-app-actions">
                  <DsButton size="sm" variant="secondary" data-dev-app-agent :disabled="!agentAvailable" :title="agentAvailable ? t('打开 App Agent 会话') : t('当前环境没有 Agent 桥')" @click="openAppAgent(app)">
                    <Sparkles :size="13" /> {{ t("Agent 会话") }}
                  </DsButton>
                  <DsButton size="sm" variant="secondary" :status="busy === 'toggle-app' ? 'loading' : 'idle'" @click="toggleApp(app)">
                    <PowerOff v-if="app.enabled" :size="13" /><Power v-else :size="13" />
                    {{ app.enabled ? t("停用") : t("启用") }}
                  </DsButton>
                  <DsButton size="sm" variant="ghost" :disabled="(app.historyCount ?? 0) === 0" :title="(app.historyCount ?? 0) === 0 ? t('没有可回滚的历史版本') : t('回滚到上一版本')" @click="rollbackApp(app)">
                    <RotateCcw :size="13" /> {{ t("回滚") }}
                  </DsButton>
                  <DsButton size="sm" variant="danger" @click="uninstallApp(app)"><Trash2 :size="13" /> {{ t("卸载") }}</DsButton>
                </div>
              </li>
            </ul>
          </section>

          <section class="integr-sec">
            <h3>{{ t("开发草稿") }}</h3>
            <DsPageState v-if="labError" kind="error" :title="t('读不到开发草稿')" :description="devFailure(labError)" :on-action="loadLab" />
            <DsPageState
              v-else-if="!drafts.length"
              kind="empty"
              :title="t('实验室里还没有草稿')"
              description="切到「实验室（沙箱）」用示例模板创建第一份草稿；草稿保存在本机 userData 的 developer-lab 目录。"
            />
            <ul v-else class="integr-rows">
              <li v-for="draft in drafts" :key="draft.id" class="integr-row dev-draft-row" :data-dev-draft="draft.id">
                <button type="button" class="dev-draft-open" @click="openDraft(draft)">
                  <b>{{ draft.name }}</b>
                  <span class="mono">{{ draft.appId }}</span>
                  <span class="dev-draft-meta">{{ formatTime(draft.createdAt) }} · {{ draft.files?.length ?? 0 }} 个文件 · 检查 {{ passCount(draft) }} 通过 / {{ warnCount(draft) }} 建议 / {{ failCount(draft) }} 不通过</span>
                </button>
                <div class="dev-app-actions">
                  <DsButton size="sm" variant="ghost" :status="busy === 'zip-draft' ? 'loading' : 'idle'" @click="exportDraft(draft)"><Download :size="13" /> {{ t("导出 ZIP") }}</DsButton>
                  <DsButton size="sm" variant="danger" @click="deleteDraft(draft)"><Trash2 :size="13" /> {{ t("删除") }}</DsButton>
                </div>
              </li>
            </ul>

            <div v-if="selectedDraft" class="dev-draft-detail" :data-dev-draft-detail="selectedDraft.id">
              <div class="dev-draft-head">
                <b>{{ selectedDraft.name }}</b>
                <span class="mono">{{ selectedDraft.appId }}</span>
                <span class="toolbar-spacer" />
                <DsButton size="sm" variant="ghost" @click="selectedDraft = null; draftFile = null">{{ t("收起") }}</DsButton>
              </div>
              <div class="dev-draft-cols">
                <div>
                  <h4>{{ t("检查项") }}</h4>
                  <ul class="integr-rows">
                    <li v-for="check in selectedDraft.checks || []" :key="check.id" class="integr-row">
                      <span class="integr-dep-label">{{ check.label }}</span>
                      <DsBadge size="sm" :tone="checkTone(check.status)">{{ CHECK_TEXT[check.status] || check.status }}</DsBadge>
                      <span class="integr-row-desc">{{ check.detail || "" }}</span>
                    </li>
                  </ul>
                </div>
                <div>
                  <h4>{{ t("文件") }}</h4>
                  <ul class="integr-rows">
                    <li v-for="file in draftFileList" :key="file.path" class="integr-row">
                      <button type="button" class="dev-file-open mono" @click="readDraftFile(selectedDraft, file.path)">{{ file.path }}</button>
                      <span class="integr-row-desc">{{ formatBytes(file.bytes) }}</span>
                    </li>
                  </ul>
                </div>
              </div>
              <p v-if="draftFileError" class="integr-error" role="alert">{{ devFailure(draftFileError) }}</p>
              <pre v-if="draftFile" class="dev-file-content mono" :data-dev-file="draftFile.path">{{ draftFile.content }}</pre>
            </div>
          </section>
        </template>

        <!-- ═══════════ 实验室 ═══════════ -->
        <template v-else-if="tab === 'lab'">
          <section class="integr-sec">
            <h3>{{ t("示例工程模板") }}</h3>
            <DsPageState v-if="templatesError" kind="error" :title="t('读不到示例模板')" :description="devFailure(templatesError)" />
            <DsPageState v-else-if="!templates.length" kind="empty" :title="t('没有提供的示例模板')" description="实验室的模板目录由主进程随包提供；空目录时不会编造模板。" />
            <ul v-else class="integr-rows">
              <li v-for="template in templates" :key="template.id" class="integr-row" :data-dev-template="template.id">
                <div class="dev-app-main">
                  <div class="dev-app-title"><b>{{ template.name }}</b><span class="dev-app-meta">{{ template.subtitle || "" }}</span><DsBadge size="sm">{{ template.category || t("示例") }}</DsBadge><span class="mono">{{ template.fileCount ?? 0 }} 个文件</span></div>
                  <p class="dev-app-desc">{{ template.description || "" }}</p>
                </div>
                <DsButton size="sm" variant="primary" :status="busy === 'create-draft' ? 'loading' : 'idle'" @click="createFromTemplate(template)">{{ t("用模板新建草稿") }}</DsButton>
              </li>
            </ul>
          </section>

          <section class="integr-sec">
            <h3>{{ t("草稿与沙箱边界") }}</h3>
            <p class="integr-note">
              {{ t("草稿只允许 .html/.css/.js/.mjs/.json/.txt/.md/.svg，单份不超过 8 MB；入口文件必须在草稿内。 沙箱预览只回原始字节与 MIME，不注入运行时桥；跨域父窗口属性访问会被检查项标为不通过。") }}
            </p>
            <DsPageState v-if="labError" kind="error" :title="t('读不到开发草稿')" :description="devFailure(labError)" :on-action="loadLab" />
            <DsPageState v-else-if="!drafts.length" kind="empty" :title="t('还没有草稿')" description="用上方模板创建第一份草稿。" />
            <ul v-else class="integr-rows">
              <li v-for="draft in drafts" :key="draft.id" class="integr-row">
                <button type="button" class="dev-draft-open" @click="openDraft(draft)">
                  <b>{{ draft.name }}</b><span class="mono">{{ draft.appId }}</span>
                  <span class="dev-draft-meta">{{ formatTime(draft.createdAt) }} · {{ draft.files?.length ?? 0 }} 个文件</span>
                </button>
                <DsButton size="sm" variant="ghost" @click="openDraft(draft)">{{ t("查看检查项与文件") }}</DsButton>
              </li>
            </ul>
            <div v-if="selectedDraft" class="dev-draft-detail">
              <div class="dev-draft-head">
                <b>{{ selectedDraft.name }}</b><span class="mono">{{ selectedDraft.appId }}</span><span class="toolbar-spacer" /><DsButton size="sm" variant="ghost" @click="selectedDraft = null; draftFile = null">{{ t("收起") }}</DsButton>
              </div>
              <div class="dev-draft-cols">
                <div>
                  <h4>{{ t("检查项") }}</h4>
                  <ul class="integr-rows">
                    <li v-for="check in selectedDraft.checks || []" :key="check.id" class="integr-row">
                      <span class="integr-dep-label">{{ check.label }}</span>
                      <DsBadge size="sm" :tone="checkTone(check.status)">{{ CHECK_TEXT[check.status] || check.status }}</DsBadge>
                      <span class="integr-row-desc">{{ check.detail || "" }}</span>
                    </li>
                  </ul>
                </div>
                <div>
                  <h4>{{ t("文件") }}</h4>
                  <ul class="integr-rows">
                    <li v-for="file in draftFileList" :key="file.path" class="integr-row">
                      <button type="button" class="dev-file-open mono" @click="readDraftFile(selectedDraft, file.path)">{{ file.path }}</button>
                      <span class="integr-row-desc">{{ formatBytes(file.bytes) }}</span>
                    </li>
                  </ul>
                </div>
              </div>
              <p v-if="draftFileError" class="integr-error" role="alert">{{ devFailure(draftFileError) }}</p>
              <pre v-if="draftFile" class="dev-file-content mono">{{ draftFile.content }}</pre>
            </div>
          </section>

          <section class="integr-sec">
            <h3>{{ t("离线开发文档") }}</h3>
            <DsPageState v-if="docsError" kind="unavailable" :title="t('离线开发文档不可用')" :description="devFailure(docsError)" />
            <dl v-else-if="docsStatus" class="integr-kv">
              <dt>{{ t("缓存可用") }}</dt><dd>{{ docsStatus.available ? t("是") : t("否") }}</dd>
              <dt>{{ t("最近刷新") }}</dt><dd>{{ formatTime(docsStatus.refreshedAt) }}</dd>
            </dl>
            <p class="integr-note">{{ t("文档刷新走远端已停用；这里只报告本机缓存事实。") }}</p>
          </section>
        </template>

        <!-- ═══════════ 协作与实时房间 ═══════════ -->
        <template v-else-if="tab === 'collab'">
          <section class="integr-sec">
            <h3>{{ t("协同项目") }}</h3>
            <form class="integr-form" @submit.prevent="createProject">
              <label class="integr-field"><span>{{ t("新协同项目名称") }}</span><input v-model="projectName" :placeholder="t('例如：商品详情页改版')" /></label>
              <DsButton type="submit" size="sm" variant="primary" :status="busy === 'create-project' ? 'loading' : 'idle'" :disabled="!projectName.trim()">{{ t("创建项目") }}</DsButton>
            </form>
            <DsPageState v-if="projectsError" kind="error" :title="t('读不到协同项目')" :description="devFailure(projectsError)" :on-action="loadCollab" />
            <DsPageState v-else-if="!projects.length" kind="empty" :title="t('还没有协同项目')" description="创建后项目落在既有 projects 表，owner 是当前会话用户；没有成员时只对自己可见。" />
            <ul v-else class="integr-rows">
              <li v-for="project in projects" :key="project.id" class="integr-row" :data-dev-project="project.id">
                <button type="button" class="dev-draft-open" @click="openProject(project)">
                  <b>{{ project.name }}</b>
                  <span class="mono">{{ project.id }}</span>
                  <span class="dev-draft-meta">v{{ project.version ?? 1 }} · {{ project.access }} · {{ project.members?.length ?? 0 }} 名成员 · 更新 {{ formatTime(project.updatedAt) }}</span>
                </button>
                <DsBadge size="sm">{{ project.visibility === "public" ? t("公开") : project.visibility === "restricted" ? t("受限") : t("私有") }}</DsBadge>
              </li>
            </ul>
            <p v-if="projectError" class="integr-error" role="alert">{{ devFailure(projectError) }}</p>
            <div v-if="selectedProject" class="dev-draft-detail" :data-dev-project-detail="selectedProject.id">
              <div class="dev-draft-head">
                <b>{{ selectedProject.name }}</b>
                <span class="mono">{{ selectedProject.id }}</span>
                <span class="toolbar-spacer" />
                <DsButton size="sm" variant="ghost" @click="selectedProject = null">{{ t("收起") }}</DsButton>
              </div>
              <dl class="integr-kv">
                <dt>{{ t("版本") }}</dt><dd>{{ selectedProject.version ?? 1 }}</dd>
                <dt>{{ t("可见性") }}</dt><dd>{{ selectedProject.visibility || "—" }}（公开访问：{{ selectedProject.publicAccess || "—" }}）</dd>
                <dt>{{ t("我的权限") }}</dt><dd>{{ selectedProject.access || "—" }}</dd>
                <dt>{{ t("成员版本") }}</dt><dd class="mono">{{ selectedProject.revision || "—" }}</dd>
                <dt>{{ t("邀请") }}</dt><dd>{{ selectedProject.invite ? t("口令末位 ") + selectedProject.invite.codeHint : t("当前没有有效邀请") }}</dd>
              </dl>
              <h4>{{ t("成员") }}</h4>
              <ul class="integr-rows">
                <li v-for="member in selectedProject.members || []" :key="member.userId" class="integr-row">
                  <span class="mono">{{ member.userId }}</span><DsBadge size="sm">{{ member.access }}</DsBadge>
                </li>
              </ul>
              <p v-if="!selectedProject.members?.length" class="integr-note">{{ t("没有成员；这份项目目前只对 owner 可见。") }}</p>
            </div>
          </section>

          <section class="integr-sec">
            <h3>{{ t("实时房间") }}</h3>
            <p class="integr-note">
              {{ t("传输：") }}<template v-if="transport?.configured">已装配（{{ transport.kind || t("注入传输") }}）</template><template v-else-if="transportError">未装配 —— {{ devFailure(transportError) }}</template><template v-else>{{ t("未读取") }}</template>{{ t("。 传输未装配时房间只存在于本机进程内，界面不会声称已经连到局域网。") }}
            </p>
            <dl v-if="realtimeStats" class="integr-kv">
              <dt>{{ t("进程内房间") }}</dt><dd>{{ realtimeStats.rooms }}</dd>
              <dt>{{ t("在线成员") }}</dt><dd>{{ realtimeStats.peers }}</dd>
              <dt>{{ t("断线待重连") }}</dt><dd>{{ realtimeStats.detached }}</dd>
            </dl>
            <form class="integr-form" @submit.prevent="createRoom">
              <label class="integr-field"><span>{{ t("新房间名称") }}</span><input v-model="roomName" :placeholder="t('例如：设计评审')" /></label>
              <DsButton type="submit" size="sm" variant="primary" :status="busy === 'create-room' ? 'loading' : 'idle'">{{ t("创建本机房间") }}</DsButton>
            </form>
            <DsPageState v-if="roomsError" kind="error" :title="t('读不到实时房间')" :description="devFailure(roomsError)" :on-action="loadRealtime" />
            <DsPageState v-else-if="!rooms.length" kind="empty" :title="t('还没有可见的实时房间')" description="房间按当前会话用户过滤；没有身份用户 ID 时只能看到 discoverable 房间。" />
            <ul v-else class="integr-rows">
              <li v-for="room in rooms" :key="room.id" class="integr-row" :data-dev-room="room.id">
                <button type="button" class="dev-draft-open" @click="openRoom(room)">
                  <b>{{ room.name }}</b>
                  <span class="mono">{{ room.id }}</span>
                  <span class="dev-draft-meta">成员 {{ room.members }}/{{ room.maxMembers }} · 序号 {{ room.seq }} · {{ room.discoverable ? t("可发现") : t("仅受邀请者可见") }}</span>
                </button>
                <div class="dev-app-actions">
                  <DsButton size="sm" variant="secondary" :status="busy === 'join-room' ? 'loading' : 'idle'" @click="joinRoom(room)">{{ t("加入") }}</DsButton>
                  <DsButton size="sm" variant="ghost" :disabled="!myClientIds[room.id]" @click="leaveRoom(room)">{{ t("离开") }}</DsButton>
                  <DsButton size="sm" variant="danger" :disabled="room.ownerId !== userId" :title="room.ownerId !== userId ? t('只有房主可以关闭') : t('关闭房间')" @click="closeRoom(room)">{{ t("关闭") }}</DsButton>
                </div>
              </li>
            </ul>
            <p v-if="roomError" class="integr-error" role="alert">{{ devFailure(roomError) }}</p>
            <div v-if="selectedRoom" class="dev-draft-detail" :data-dev-room-detail="selectedRoom.id">
              <div class="dev-draft-head">
                <b>{{ selectedRoom.name }}</b>
                <span class="mono">{{ selectedRoom.id }}</span>
                <span class="toolbar-spacer" />
                <DsButton size="sm" variant="ghost" @click="selectedRoom = null">{{ t("收起") }}</DsButton>
              </div>
              <dl class="integr-kv">
                <dt>{{ t("房主") }}</dt><dd class="mono">{{ selectedRoom.ownerId }}</dd>
                <dt>{{ t("序号") }}</dt><dd>{{ selectedRoom.seq }}</dd>
                <dt>{{ t("成员") }}</dt><dd>{{ selectedRoom.memberList?.length ?? 0 }} 人</dd>
              </dl>
              <ul class="integr-rows">
                <li v-for="member in selectedRoom.memberList || []" :key="member.clientId" class="integr-row">
                  <span class="mono">{{ member.username || member.userId }}</span>
                  <span class="integr-row-desc mono">{{ member.clientId }}</span>
                </li>
              </ul>
              <p v-if="!selectedRoom.memberList?.length" class="integr-note">{{ t("房间里还没有成员。") }}</p>
            </div>
          </section>
        </template>

        <!-- ═══════════ 命令与日志 ═══════════ -->
        <template v-else-if="tab === 'commands'">
          <section class="integr-sec">
            <h3>{{ t("开发者平台健康") }}</h3>
            <DsPageState v-if="healthError" kind="error" :title="t('读不到开发者平台健康')" :description="devFailure(healthError)" :on-action="loadHealth" />
            <template v-else-if="health">
              <dl class="integr-kv">
                <dt>{{ t("六张 v22 表") }}</dt><dd>{{ health.tablesReady ? t("全部就绪") : t("缺少 ") + (health.missingTables || []).join(", ") }}</dd>
                <dt>{{ t("数据根目录") }}</dt><dd>{{ health.dataRootReady ? t("可用") : t("不可用") }}</dd>
                <dt>{{ t("实际可达命令") }}</dt><dd>{{ health.commands ?? 0 }} / 白名单 {{ health.declaredCommands ?? 0 }}</dd>
                <dt>{{ t("已装载应用") }}</dt><dd>{{ health.installedApps ?? 0 }}</dd>
                <dt>{{ t("出网策略") }}</dt><dd>HTTPS {{ health.network?.httpsOnly ? t("强制") : "—" }} · DNS 公网校验 {{ health.network?.dnsPublicCheck ? t("开启") : "—" }} · 限流 {{ health.network?.rateLimitPerMinute ?? "—" }}/分钟</dd>
                <dt>{{ t("降级原因") }}</dt><dd>{{ health.degradedReason || (health.degraded ? t("装配期间有切片失败，详见下列状态") : t("无")) }}</dd>
              </dl>
              <h4>{{ t("扩展切片") }}</h4>
              <ul class="integr-rows">
                <li v-for="row in extensionRows" :key="row.name" class="integr-row">
                  <span class="integr-dep-label">{{ row.name }}</span>
                  <DsBadge size="sm" :tone="row.status === 'ok' ? 'success' : row.status === 'degraded' ? 'warning' : 'neutral'">{{ EXT_TEXT[row.status] || row.status }}</DsBadge>
                </li>
              </ul>
              <p v-if="!extensionRows.length" class="integr-note">{{ t("健康投影没有返回切片状态；这通常意味着只有 B7a 基座装配。") }}</p>
            </template>
          </section>

          <section class="integr-sec">
            <h3>{{ t("本机运行环境") }}</h3>
            <dl class="integr-kv">
              <dt>{{ t("原生桥") }}</dt><dd>{{ hasBridge ? t("已连接（preload）") : t("未连接") }}</dd>
              <dt>{{ t("会话") }}</dt><dd>{{ identity.snapshot.sessionRef ? (userName || userId) : t("没有已认证会话") }}</dd>
              <dt>Electron / Chromium</dt><dd class="mono">{{ electronVersion }} / {{ chromiumVersion }}</dd>
              <dt>{{ t("平台") }}</dt><dd>{{ platformName }}</dd>
            </dl>
          </section>

          <section class="integr-sec">
            <h3>{{ t("本次窗口的命令记录") }}</h3>
            <DsPageState v-if="!commandLog.length" kind="empty" :title="t('还没有调用过开发者命令')" description="刷新页面上的数据或执行任何动作后，这里会出现真实的成功 / 失败结果。" />
            <ul v-else class="integr-rows">
              <li v-for="(entry, index) in commandLog" :key="entry.at + '-' + index" class="integr-row" :data-dev-log="entry.command">
                <span class="mono integr-log-time">{{ formatTime(entry.at) }}</span>
                <DsBadge size="sm" :tone="entry.ok ? 'success' : 'danger'">{{ entry.ok ? t("成功") : t("失败") }}</DsBadge>
                <span class="mono integr-command-name">{{ entry.command }}</span>
                <span class="integr-row-desc">{{ entry.ok ? "" : entry.code + (entry.detail ? " · " + entry.detail : "") }}</span>
              </li>
            </ul>
          </section>

          <section class="integr-sec">
            <h3>{{ t("渲染进程运行日志") }}</h3>
            <DsPageState v-if="!devlog.items.length" kind="empty" :title="t('启动以来没有错误或警告')" description="只收集真实发生的未捕获错误、未处理拒绝与 console.error / console.warn。" />
            <ul v-else class="integr-rows">
              <li v-for="(entry, index) in [...devlog.items].reverse().slice(0, 60)" :key="entry.t + '-' + index" class="integr-row" :data-dev-runtime-log="entry.level">
                <span class="mono integr-log-time">{{ formatTime(entry.t) }}</span>
                <DsBadge size="sm" :tone="entry.level === 'warn' ? 'warning' : 'danger'">{{ entry.level === "warn" ? t("警告") : entry.level === "reject" ? t("拒绝") : t("错误") }}</DsBadge>
                <pre class="dev-runtime-msg mono">{{ entry.msg }}</pre>
              </li>
            </ul>
          </section>
        </template>

        <!-- ═══════════ CLI ═══════════ -->
        <template v-else>
          <CliPanel />
        </template>
      </div>
    </div>

    <DsDialog :open="confirmState !== null" :title="confirmState?.title || ''" @close="confirmState = null">
      <p class="dev-confirm-text">{{ confirmState?.message }}</p>
      <template #footer>
        <button class="ghost" @click="confirmState = null">{{ t("取消") }}</button>
        <button class="primary" data-dev-confirm @click="doConfirm">{{ t("确认执行") }}</button>
      </template>
    </DsDialog>

    <DsDialog :open="agentApp !== null" :title="t('App Agent 会话')" @close="agentApp = null">
      <p class="dev-confirm-text">{{ agentApp?.name }} · <span class="mono">{{ agentApp?.appId }}</span></p>
      <p class="integr-detail">{{ t("Agent 只在当前开发者 App 的会话隔离与能力边界内运行；缺依赖时后端会如实返回结构化错误。") }}</p>
      <label class="integr-field">{{ t("模式") }}
        <select v-model="agentMode" data-dev-agent-mode>
          <option value="assistant">assistant</option>
          <option value="thinking">thinking</option>
          <option value="agent">agent</option>
        </select>
      </label>
      <textarea v-model="agentInstruction" class="integr-input dev-agent-input" rows="4" data-dev-agent-instruction :placeholder="t('描述要让这个 App Agent 完成的动作…')"></textarea>
      <p v-if="!agentAvailable" class="integr-error" data-dev-agent-unavailable>{{ t("当前环境没有 Agent 桥；请在 OpenArc 桌面应用中打开。") }}</p>
      <p v-if="agentError" class="integr-error" role="alert" :data-dev-agent-error="agentError.code">{{ failureText(agentError) }}<span v-if="agentError.detail" class="integr-detail"> · {{ detailText(agentError.detail) }}</span></p>
      <div v-if="agentResult" class="dev-agent-result" data-dev-agent-result>
        <p>{{ t("项目：{project} · 会话：{session}", { project: agentResult.projectId || "—", session: agentResult.sessionId || "—" }) }}</p>
        <p v-if="agentResult.gateway">{{ t("入口：{gateway}", { gateway: agentResult.gateway }) }}</p>
        <pre v-if="agentResultText" class="dev-agent-output">{{ agentResultText }}</pre>
      </div>
      <template #footer>
        <button class="ghost" @click="agentApp = null">{{ t("取消") }}</button>
        <button class="primary" :disabled="agentBusy || !agentInstruction.trim()" data-dev-agent-run @click="runAppAgent">{{ agentBusy ? t("运行中…") : t("开始会话") }}</button>
      </template>
    </DsDialog>
  </div>
</template>

<style scoped>
.dev-app .integr-count { margin-left: auto; font-size: var(--fs-micro); color: var(--muted); font-variant-numeric: tabular-nums; }
.dev-main { display: flex; flex-direction: column; min-height: 0; }
.dev-scroll { flex: 1; min-height: 0; overflow: auto; padding-bottom: var(--space-6); }
.dev-app-row, .dev-draft-row { align-items: flex-start; }
.dev-app-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: var(--space-1); }
.dev-app-title { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; font-size: var(--fs-secondary); }
.dev-app-title .mono { color: var(--muted); }
.dev-app-desc { margin: 0; font-size: var(--fs-caption); color: var(--muted); line-height: var(--lh-relaxed); }
.dev-app-meta { margin: 0; font-size: var(--fs-micro); color: var(--muted); font-variant-numeric: tabular-nums; }
.dev-app-warn { margin: 0; font-size: var(--fs-micro); color: var(--warning-text, #8a4b00); }
.dev-app-actions { display: flex; align-items: center; gap: var(--space-1); flex-wrap: wrap; }
.dev-draft-open {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: flex-start;
  text-align: left;
  background: transparent;
  border: 0;
  color: var(--text);
  padding: 0;
  cursor: pointer;
  font: inherit;
}
.dev-draft-open:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: var(--radius-sm); }
.dev-draft-open .mono { color: var(--muted); font-size: var(--fs-micro); }
.dev-draft-meta { font-size: var(--fs-micro); color: var(--muted); }
.dev-draft-detail {
  margin-top: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-lg);
  background: rgb(var(--text-rgb) / 0.035);
}
.dev-draft-head { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.dev-draft-head .mono { color: var(--muted); font-size: var(--fs-micro); }
.dev-draft-cols { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); margin-top: var(--space-2); }
.dev-draft-cols h4, .dev-draft-detail h4 { margin: var(--space-2) 0; font-size: var(--fs-caption); font-weight: var(--fw-medium); }
.dev-file-open {
  background: transparent;
  border: 0;
  color: var(--text);
  padding: 0;
  cursor: pointer;
  text-align: left;
  font-size: var(--fs-caption);
}
.dev-file-open:hover { text-decoration: underline; }
.dev-file-open:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.dev-file-content {
  max-height: 280px;
  overflow: auto;
  margin: var(--space-2) 0 0;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: rgb(var(--text-rgb) / 0.05);
  font-size: var(--fs-micro);
  line-height: var(--lh-normal);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dev-runtime-msg { margin: 0; flex: 1 1 240px; font-size: var(--fs-micro); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--muted); }
.dev-confirm-text { margin: 0; font-size: var(--fs-secondary); line-height: var(--lh-relaxed); color: var(--muted); }
@media (max-width: 900px) {
  .dev-draft-cols { grid-template-columns: 1fr; }
}
.dev-agent-input { width: 100%; box-sizing: border-box; resize: vertical; min-height: 72px; margin: 6px 0; padding: 6px 8px; border: 1px solid var(--line); border-radius: var(--radius-md); background: rgb(var(--content-rgb) / 0.5); color: var(--text); font-size: var(--fs-caption); }
.dev-agent-result { display: flex; flex-direction: column; gap: 4px; padding: 8px; border-radius: var(--radius-md); background: rgb(var(--text-rgb) / 0.05); }
.dev-agent-result p { margin: 0; font-size: var(--fs-micro); color: var(--muted); }
.dev-agent-output { margin: 0; max-height: 180px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--font-mono); font-size: var(--fs-micro); color: var(--text); }
</style>
