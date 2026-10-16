/**
 * 照片应用 · 图像工坊视图（photocraft:command + appExchange:command）。
 *
 * 方案 B：这里不做像素级图片编辑器，只做项目容器与文件能力的界面 ——
 * 新建 / 改名 / 分组 / 三态可见性 / 成员 / 下载源文件 / 写入导出目录 /
 * 回收站（恢复与彻底删除）/ 发送到画布。
 *
 * 命令对应（逐条落点）：
 *   photocraft/projects/list      左侧与中间的项目列表（按分组）
 *   photocraft/projects/create    新建项目（可带一个本地文件作源文件，base64 内联）
 *   photocraft/projects/update    改名 / 换分组 / 可见性 / 成员（仅 owner 可改）
 *   photocraft/projects/readSource 下载源文件到本机
 *   photocraft/projects/export    把本机文件写进项目的「导出/」目录
 *   photocraft/projects/trash|restore|purge 回收站的移入 / 恢复 / 彻底删除
 *   photocraft/trash/list         回收站列表
 *   photocraft/groups/create|remove 分组的新建 / 删除（项目回退默认分组）
 *   appExchange/targets           发送目标列表（后端按 canOpen 过滤，界面不硬编码）
 *   appExchange/exchange          只传引用的发送
 *
 * 不呈现的命令：photocraft/projects/saveBundle 与 save-bundle（后端结构化 PHOTOCRAFT_UNSUPPORTED，
 * 由 file-transfer 域承接）、saveClipboardTemp（方案 B 没有剪贴板编辑面，没有写入的时机）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  FolderPlus,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Trash2,
  Upload,
} from "lucide-react";
import { Badge, Button, IconButton, ScrollArea, TextField, useToast } from "../design-system/primitives";
import { PageState } from "../design-system/page-states";
import { Dialog } from "../desktop/Dialog";
import {
  appExchangeErrorText,
  buildExchangeRequest,
  canEditProject,
  canPurge,
  defaultTargetKey,
  exchangeResultText,
  exportArtifactName,
  groupOptions,
  groupProjects,
  isAllowedAppExchangeCommand,
  isAllowedPhotocraftCommand,
  membersInputValue,
  newRequestId,
  parseMembersInput,
  photocraftErrorState,
  photocraftErrorText,
  photocraftFailureLine,
  sourceDownloadName,
  targetOptionLabel,
  targetNeedsCanvas,
  targetsPageState,
  targetsUnavailableNotice,
  targetsView,
  TRASH_PURGE_HINT,
  visibilityControl,
  visibilityLabel,
  visibilityUpdatePayload,
} from "./studioLogic";
import type { Visibility } from "./studioLogic";
import { formatBytes, formatTimestamp, localFailure, resultFailure, resultValue } from "./photosLogic";
import type { FailureView } from "./photosLogic";
import type {
  AppExchangeTargetsValue,
  DomainBridge,
  ExchangeResult,
  PhotoCraftGroup,
  PhotoCraftProject,
  PhotocraftGroupRemoveValue,
  PhotocraftProjectsListValue,
  PhotocraftReadSourceValue,
  PhotocraftTrashListValue,
} from "./types";

type StudioDialog =
  | { kind: "create" }
  | { kind: "new-group" }
  | { kind: "remove-group"; group: PhotoCraftGroup }
  | { kind: "trash"; project: PhotoCraftProject }
  | { kind: "purge"; project: PhotoCraftProject }
  | { kind: "send" }
  | null;

/** base64（标准，后端 readSource 的出口）到字节；只用浏览器 atob，不引入依赖。 */
function decodeBase64Bytes(data: string): Uint8Array {
  const binary = atob(String(data == null ? "" : data));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function saveBytes(name: string, bytes: Uint8Array, mime: string) {
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name || "download.bin";
  anchor.click();
  URL.revokeObjectURL(url);
}

/** FileReader 读成标准 base64（后端 decodeContentBytes 只认带填充的标准 base64）。 */
function readFileBase64(file: File): Promise<{ name: string; mime: string; contentBase64: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取本地文件失败"));
    reader.onload = () => {
      const text = String(reader.result || "");
      const comma = text.indexOf(",");
      resolve({
        name: file.name,
        mime: file.type || "application/octet-stream",
        contentBase64: comma >= 0 ? text.slice(comma + 1) : text,
      });
    };
    reader.readAsDataURL(file);
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   图像工坊视图主体
   ══════════════════════════════════════════════════════════════════════════ */
export function StudioView({ photocraft, exchange }: { photocraft: DomainBridge | null; exchange: DomainBridge | null }) {
  const { toast } = useToast();

  const call = useCallback(
    async (command: string, payload: Record<string, unknown> = {}): Promise<unknown> => {
      if (!photocraft) return { ok: false, error: "NO_BRIDGE", message: "桌面桥未接入（当前环境没有图像工坊域）" };
      if (!isAllowedPhotocraftCommand(command)) return { ok: false, error: "PHOTOCRAFT_COMMAND_NOT_ALLOWED", message: "" };
      try {
        return await photocraft.command({ command, payload });
      } catch (error) {
        return { ok: false, error: "DXOS_ERR_INTERNAL", message: String((error as Error)?.message || error) };
      }
    },
    [photocraft],
  );

  const callExchange = useCallback(
    async (command: string, payload: Record<string, unknown> = {}): Promise<unknown> => {
      if (!exchange) return { ok: false, error: "NO_BRIDGE", message: "桌面桥未接入（当前环境没有应用互传域）" };
      if (!isAllowedAppExchangeCommand(command)) return { ok: false, error: "APP_EXCHANGE_COMMAND_NOT_ALLOWED", message: "" };
      try {
        return await exchange.command({ command, payload });
      } catch (error) {
        return { ok: false, error: "DXOS_ERR_INTERNAL", message: String((error as Error)?.message || error) };
      }
    },
    [exchange],
  );

  const [view, setView] = useState<"projects" | "trash">("projects");
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<FailureView | null>(null);
  const [projects, setProjects] = useState<PhotoCraftProject[]>([]);
  const [trashed, setTrashed] = useState<PhotoCraftProject[]>([]);
  const [groups, setGroups] = useState<PhotoCraftGroup[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [groupDraft, setGroupDraft] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [membersText, setMembersText] = useState("");

  const [dialog, setDialog] = useState<StudioDialog>(null);
  const [createTitle, setCreateTitle] = useState("");
  const [createGroup, setCreateGroup] = useState("");
  const [createFileName, setCreateFileName] = useState("");
  const [groupName, setGroupName] = useState("");
  const [exportFileName, setExportFileName] = useState("");

  const [targets, setTargets] = useState<AppExchangeTargetsValue | null>(null);
  const [targetsLoading, setTargetsLoading] = useState(false);
  const [targetsErrorCode, setTargetsErrorCode] = useState<string | null>(null);
  const [targetKey, setTargetKey] = useState("");
  const [canvasId, setCanvasId] = useState("");
  const [sendError, setSendError] = useState("");
  const [sendResult, setSendResult] = useState<ExchangeResult | null>(null);

  const createFileRef = useRef<HTMLInputElement | null>(null);
  const exportFileRef = useRef<HTMLInputElement | null>(null);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    const res = await call("photocraft/projects/list", {});
    const value = resultValue<PhotocraftProjectsListValue>(res);
    if (value) {
      setProjects(Array.isArray(value.projects) ? value.projects : []);
      setGroups(Array.isArray(value.groups) ? value.groups : []);
      setFailure(null);
    } else {
      setFailure(resultFailure(res) || localFailure("RESPONSE_INCOMPLETE", "projects/list 没有返回记录"));
    }
    setLoading(false);
  }, [call]);

  const loadTrash = useCallback(async () => {
    setLoading(true);
    const res = await call("photocraft/trash/list", {});
    const value = resultValue<PhotocraftTrashListValue>(res);
    if (value) {
      setTrashed(Array.isArray(value.projects) ? value.projects : []);
      setFailure(null);
    } else {
      setFailure(resultFailure(res) || localFailure("RESPONSE_INCOMPLETE", "trash/list 没有返回记录"));
    }
    setLoading(false);
  }, [call]);

  useEffect(() => {
    void loadProjects();
    void loadTrash();
  }, [loadProjects, loadTrash]);

  const pool = view === "trash" ? trashed : projects;
  const selected = useMemo(() => pool.find((project) => project.id === selectedId) || null, [pool, selectedId]);

  useEffect(() => {
    if (!selected) return;
    setTitle(selected.title);
    setGroupDraft(selected.groupId);
    setVisibility(selected.visibility);
    setMembersText(membersInputValue(selected.members));
    setSendError("");
    setSendResult(null);
  }, [selected?.id, selected?.updatedAt]);

  const owners = canEditProject(selected);
  const memberDraft = parseMembersInput(membersText);
  const control = visibilityControl({ visibility, mine: selected ? selected.mine : false, members: memberDraft });

  const failToast = useCallback(
    (context: string, res: unknown) => {
      const fail = resultFailure(res) || localFailure("RESPONSE_INCOMPLETE", "");
      toast({ kind: "error", title: context + "失败", description: photocraftFailureLine(context, fail.code) });
    },
    [toast],
  );

  const exchangeFailToast = useCallback(
    (context: string, res: unknown) => {
      const fail = resultFailure(res) || localFailure("RESPONSE_INCOMPLETE", "");
      toast({ kind: "error", title: context + "未完成", description: targetsUnavailableNotice(fail.code, fail.detail) + "（" + fail.code + "）" });
    },
    [toast],
  );

  const isOk = useCallback((res: unknown) => !!res && typeof res === "object" && (res as { ok?: unknown }).ok === true, []);

  const saveProject = useCallback(async () => {
    if (!selected || !owners) return;
    const payload: Record<string, unknown> = { id: selected.id };
    const nextTitle = title.trim();
    if (nextTitle && nextTitle !== selected.title) payload.title = nextTitle;
    if (groupDraft && groupDraft !== selected.groupId) payload.groupId = groupDraft;
    if (visibility !== selected.visibility) {
      const next = visibilityUpdatePayload(visibility, memberDraft);
      payload.visibility = next.visibility;
      payload.members = next.members;
    } else if (visibility === "restricted" && membersInputValue(memberDraft) !== membersInputValue(selected.members)) {
      payload.members = memberDraft;
    }
    if (Object.keys(payload).length === 1) {
      toast({ kind: "info", title: "没有需要保存的改动" });
      return;
    }
    setBusy("save");
    const res = await call("photocraft/projects/update", payload);
    const value = resultValue<{ project: PhotoCraftProject }>(res);
    setBusy(null);
    if (!value) {
      failToast("保存项目", res);
      return;
    }
    toast({ kind: "success", title: "已保存", description: value.project?.title || nextTitle });
    await loadProjects();
  }, [call, failToast, groupDraft, loadProjects, memberDraft, owners, selected, title, toast, visibility]);

  const submitCreate = useCallback(async () => {
    const nextTitle = createTitle.trim();
    if (!nextTitle) {
      toast({ kind: "warning", title: "请填写项目名称" });
      return;
    }
    setBusy("create");
    let payload: Record<string, unknown> = { title: nextTitle };
    if (createGroup) payload.groupId = createGroup;
    const file = createFileRef.current?.files?.[0];
    if (file) {
      try {
        const read = await readFileBase64(file);
        payload = { ...payload, name: read.name, mime: read.mime, contentBase64: read.contentBase64 };
      } catch (error) {
        setBusy(null);
        toast({ kind: "error", title: "读取本地文件失败", description: String((error as Error)?.message || error) });
        return;
      }
    }
    const res = await call("photocraft/projects/create", payload);
    const value = resultValue<{ project: PhotoCraftProject }>(res);
    setBusy(null);
    if (!value) {
      failToast("新建项目", res);
      return;
    }
    setDialog(null);
    setCreateTitle("");
    setCreateGroup("");
    setCreateFileName("");
    setSelectedId(value.project?.id || null);
    toast({ kind: "success", title: "已新建项目", description: value.project?.title || nextTitle });
    await loadProjects();
  }, [call, createGroup, createTitle, failToast, loadProjects, toast]);

  const submitCreateGroup = useCallback(async () => {
    setBusy("group");
    const res = await call("photocraft/groups/create", groupName.trim() ? { name: groupName.trim() } : {});
    const value = resultValue<{ group: PhotoCraftGroup }>(res);
    setBusy(null);
    if (!value) {
      failToast("新建分组", res);
      return;
    }
    setDialog(null);
    setGroupName("");
    toast({ kind: "success", title: "已新建分组", description: value.group?.name || "默认分组" });
    await loadProjects();
  }, [call, failToast, groupName, loadProjects, toast]);

  const submitRemoveGroup = useCallback(
    async (group: PhotoCraftGroup) => {
      setBusy("remove-group");
      const res = await call("photocraft/groups/remove", { id: group.id });
      const value = resultValue<PhotocraftGroupRemoveValue>(res);
      setBusy(null);
      if (!value) {
        failToast("删除分组", res);
        return;
      }
      setDialog(null);
      toast({ kind: "success", title: "已删除分组", description: "已把 " + Number(value.moved || 0) + " 个项目移回默认分组" });
      await loadProjects();
    },
    [call, failToast, loadProjects, toast],
  );

  const runTrash = useCallback(async () => {
    if (dialog?.kind !== "trash") return;
    setBusy("trash");
    const res = await call("photocraft/projects/trash", { id: dialog.project.id });
    setBusy(null);
    if (!isOk(res)) {
      failToast("移入回收站", res);
      return;
    }
    setDialog(null);
    setSelectedId(null);
    toast({ kind: "success", title: "已移入回收站", description: dialog.project.title });
    await loadProjects();
    await loadTrash();
  }, [call, dialog, failToast, isOk, loadProjects, loadTrash, toast]);

  const runRestore = useCallback(
    async (project: PhotoCraftProject) => {
      setBusy("restore:" + project.id);
      const res = await call("photocraft/projects/restore", { id: project.id });
      setBusy(null);
      if (!isOk(res)) {
        failToast("恢复项目", res);
        return;
      }
      toast({ kind: "success", title: "已恢复", description: project.title });
      await loadProjects();
      await loadTrash();
    },
    [call, failToast, isOk, loadProjects, loadTrash, toast],
  );

  const runPurge = useCallback(async () => {
    if (dialog?.kind !== "purge") return;
    setBusy("purge");
    const res = await call("photocraft/projects/purge", { id: dialog.project.id });
    setBusy(null);
    if (!isOk(res)) {
      failToast("彻底删除", res);
      return;
    }
    setDialog(null);
    setSelectedId(null);
    toast({ kind: "success", title: "已彻底删除", description: dialog.project.title });
    await loadTrash();
  }, [call, dialog, failToast, isOk, loadTrash, toast]);

  const downloadSource = useCallback(async () => {
    if (!selected) return;
    setBusy("download");
    const res = await call("photocraft/projects/readSource", { id: selected.id });
    const value = resultValue<PhotocraftReadSourceValue>(res);
    setBusy(null);
    if (!value || typeof value.base64 !== "string") {
      failToast("下载源文件", res);
      return;
    }
    const name = sourceDownloadName(value.name, value.mime);
    try {
      saveBytes(name, decodeBase64Bytes(value.base64), value.mime);
      toast({ kind: "success", title: "已开始下载", description: name });
    } catch (error) {
      toast({ kind: "error", title: "解码源文件失败", description: String((error as Error)?.message || error) });
    }
  }, [call, failToast, selected, toast]);

  const submitExport = useCallback(async () => {
    if (!selected || !owners) return;
    const input = exportFileRef.current;
    const file = input?.files?.[0];
    if (!file) return;
    setBusy("export");
    try {
      const read = await readFileBase64(file);
      const name = exportArtifactName(selected, read.name);
      const res = await call("photocraft/projects/export", {
        id: selected.id,
        name,
        mime: read.mime,
        contentBase64: read.contentBase64,
      });
      setBusy(null);
      if (input) input.value = "";
      if (!resultValue(res)) {
        failToast("写入导出目录", res);
        return;
      }
      toast({ kind: "success", title: "已写入导出目录", description: name });
      await loadProjects();
      setSelectedId(selected.id);
    } catch (error) {
      setBusy(null);
      toast({ kind: "error", title: "读取本地文件失败", description: String((error as Error)?.message || error) });
    }
  }, [call, failToast, loadProjects, owners, selected, toast]);

  const openSend = useCallback(async () => {
    if (!selected) return;
    setDialog({ kind: "send" });
    setSendError("");
    setSendResult(null);
    setCanvasId("");
    setTargets(null);
    setTargetsErrorCode(null);
    setTargetsLoading(true);
    const res = await callExchange("appExchange/targets", {});
    const value = resultValue<AppExchangeTargetsValue>(res);
    if (value) {
      setTargets(value);
      setTargetKey(defaultTargetKey(targetsView(value, selected.sourceMime).targets, selected.sourceMime) || "");
    } else {
      setTargetsErrorCode(resultFailure(res)?.code || "RESPONSE_INCOMPLETE");
    }
    setTargetsLoading(false);
  }, [callExchange, selected]);

  const submitSend = useCallback(async () => {
    if (!selected) return;
    const projected = targetsView(targets, selected.sourceMime);
    const picked = projected.targets.find((item) => item.key === targetKey);
    if (!picked) {
      setSendError("请选择一个目标");
      return;
    }
    const built = buildExchangeRequest({
      requestId: newRequestId(selected.id, Date.now()),
      target: { appId: picked.target.appId, action: picked.target.action, projectId: picked.needsCanvas ? canvasId : undefined },
      asset: {
        nodeId: selected.sourceNodeId || "",
        photoCraftProjectId: selected.id,
        revision: selected.sourceSha256 || undefined,
      },
      needsCanvas: picked.needsCanvas,
    });
    if (!built.ok) {
      setSendError(built.message);
      return;
    }
    setBusy("send");
    const res = await callExchange("appExchange/exchange", built.request as unknown as Record<string, unknown>);
    const value = resultValue<ExchangeResult>(res);
    setBusy(null);
    if (!value) {
      const fail = resultFailure(res) || localFailure("DXOS_ERR_INTERNAL", "");
      setSendError(targetsUnavailableNotice(fail.code, fail.detail) + "（" + fail.code + "）");
      return;
    }
    setSendResult(value);
    setSendError("");
    toast({ kind: "success", title: "已发送", description: exchangeResultText(value) });
  }, [callExchange, canvasId, selected, setSendResult, targetKey, targets, toast]);

  const projectedTargets = useMemo(() => targetsView(targets, selected ? selected.sourceMime : ""), [targets, selected]);
  const pickedTarget = projectedTargets.targets.find((item) => item.key === targetKey) || null;
  const sendPanelState = targetsPageState({
    value: targets,
    errorCode: targetsErrorCode,
    loading: targetsLoading,
    mime: selected ? selected.sourceMime : "",
  });

  const buckets = useMemo(() => groupProjects(projects, groups), [projects, groups]);
  const listState: "loading" | "empty" | "error" | "unavailable" | "unauthorized" | "ready" =
    loading && pool.length === 0
      ? "loading"
      : failure && pool.length === 0
        ? (photocraftErrorState(failure.code) as "error" | "unavailable" | "unauthorized")
        : pool.length === 0
          ? "empty"
          : "ready";
  const reload = useCallback(() => {
    void (view === "trash" ? loadTrash() : loadProjects());
  }, [loadProjects, loadTrash, view]);

  return (
    <div className="photos-studio" data-photos-studio="1" data-photos-state={listState}>
      <aside className="photos-pane photos-studio-side" aria-label="图像工坊视图">
        <div className="photos-pane-head">
          <h3>图像工坊</h3>
        </div>
        <ul className="photos-list">
          <li className="photos-row">
            <button
              type="button"
              className="photos-row__main"
              aria-pressed={view === "projects"}
              onClick={() => {
                setView("projects");
                setSelectedId(null);
              }}
            >
              <span className="photos-row__name">项目</span>
              <span className="photos-row__facts">{projects.length}</span>
            </button>
          </li>
          <li className="photos-row">
            <button
              type="button"
              className="photos-row__main"
              aria-pressed={view === "trash"}
              onClick={() => {
                setView("trash");
                setSelectedId(null);
              }}
            >
              <span className="photos-row__name">回收站</span>
              <span className="photos-row__facts">{trashed.length}</span>
            </button>
          </li>
        </ul>

        <div className="photos-sub-head">
          <span>分组</span>
          <IconButton
            label="新建分组"
            size="sm"
            onClick={() => {
              setGroupName("");
              setDialog({ kind: "new-group" });
            }}
          >
            <FolderPlus size={14} strokeWidth={1.5} />
          </IconButton>
        </div>
        <ul className="photos-list">
          {groupOptions(groups).map((group) => (
            <li key={group.id} className="photos-row">
              <span className="photos-row__main">
                <span className="photos-row__name" title={group.label}>
                  {group.label}
                  {group.isDefault ? "（默认）" : ""}
                </span>
                <span className="photos-row__facts">{projects.filter((project) => project.groupId === group.id).length}</span>
              </span>
              {group.isDefault || !group.mine ? null : (
                <IconButton
                  label={"删除分组 " + group.label}
                  size="sm"
                  onClick={() => setDialog({ kind: "remove-group", group: { id: group.id, name: group.label, mine: group.mine, isDefault: group.isDefault } })}
                >
                  <Trash2 size={13} strokeWidth={1.5} />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
        <p className="photos-hint">
          可见性是三态：私有 / 公开 / 指定成员。后端按 owner 与成员表过滤列表；共享项目对你是只读的。
        </p>
      </aside>

      <section className="photos-pane photos-pane--flat" aria-label="项目列表">
        <div className="photos-toolbar">
          <Button
            size="sm"
            iconStart={<Plus size={14} strokeWidth={1.5} />}
            onClick={() => {
              setCreateTitle("");
              setCreateGroup(groups.find((group) => group.isDefault)?.id || groups[0]?.id || "");
              setCreateFileName("");
              setDialog({ kind: "create" });
            }}
          >
            新建项目
          </Button>
          <Button size="sm" variant="secondary" status={loading ? "loading" : "idle"} iconStart={<RefreshCw size={14} strokeWidth={1.5} />} onClick={reload}>
            刷新
          </Button>
          <span className="photos-count">
            {view === "trash" ? "回收站 " + trashed.length + " 个项目" : "共 " + projects.length + " 个项目 / " + groups.length + " 个分组"}
          </span>
        </div>

        {failure && pool.length ? (
          <p className="photos-error" role="alert" data-photos-error-code={failure.code}>
            {photocraftFailureLine("刷新项目", failure.code)}
          </p>
        ) : null}

        {listState === "loading" ? (
          <PageState kind="loading" title="正在读取项目…" />
        ) : listState === "error" || listState === "unavailable" || listState === "unauthorized" ? (
          <PageState
            kind={listState}
            title="读取项目失败"
            description={failure ? photocraftErrorText(failure.code) + "（" + failure.code + "）" : ""}
            onAction={reload}
          />
        ) : listState === "empty" ? (
          <PageState
            kind="empty"
            title={view === "trash" ? "回收站是空的" : "还没有项目"}
            description={
              view === "trash"
                ? "移入回收站的项目会出现在这里，可以恢复或彻底删除。"
                : "新建一个项目开始：可以只建空项目，也可以带上一个本地文件作为源文件。"
            }
          />
        ) : view === "trash" ? (
          <ScrollArea label="回收站项目" className="photos-scroll">
            <ul className="photos-list">
              {trashed.map((project) => (
                <li key={project.id} className="photos-trash-row">
                  <span className="photos-trash-row__name" title={project.title}>
                    {project.title}
                  </span>
                  <span className="photos-trash-row__facts">
                    {formatBytes(project.sourceSize)} · 删除于 {formatTimestamp(Number(project.deletedAt || 0) / 1000)}
                  </span>
                  <div className="photos-actions">
                    <Button
                      size="sm"
                      variant="secondary"
                      status={busy === "restore:" + project.id ? "loading" : "idle"}
                      iconStart={<RotateCcw size={14} strokeWidth={1.5} />}
                      onClick={() => void runRestore(project)}
                    >
                      恢复
                    </Button>
                    <Button size="sm" variant="danger" disabled={!canPurge(project)} onClick={() => setDialog({ kind: "purge", project })}>
                      彻底删除
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </ScrollArea>
        ) : (
          <ScrollArea label="项目列表" className="photos-scroll">
            <div className="photos-groups">
              {buckets.map((bucket) => (
                <section key={bucket.group.id} className="photos-group" aria-label={"分组 " + bucket.group.name}>
                  <div className="photos-group__head">
                    <strong>{bucket.group.name}</strong>
                    {bucket.isDefault ? (
                      <Badge tone="neutral" size="sm">
                        默认
                      </Badge>
                    ) : null}
                    {bucket.mine ? null : (
                      <Badge tone="neutral" size="sm">
                        共享
                      </Badge>
                    )}
                    <span>{bucket.projects.length} 个项目</span>
                  </div>
                  {bucket.projects.length ? (
                    <ul className="photos-list">
                      {bucket.projects.map((project) => (
                        <li key={project.id}>
                          <button
                            type="button"
                            className={"photos-project" + (selectedId === project.id ? " is-active" : "")}
                            aria-pressed={selectedId === project.id}
                            onClick={() => setSelectedId(project.id)}
                          >
                            <span className="photos-project__title" title={project.title}>
                              {project.title}
                            </span>
                            <span className="photos-project__facts">
                              <Badge
                                tone={project.visibility === "public" ? "success" : project.visibility === "restricted" ? "warning" : "neutral"}
                                size="sm"
                              >
                                {visibilityLabel(project.visibility)}
                              </Badge>
                              <span>{project.mine ? "我的" : "共享"}</span>
                              <span>{formatBytes(project.sourceSize)}</span>
                              <span>{formatTimestamp(Number(project.updatedAt || 0) / 1000)}</span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="photos-hint">这个分组还没有项目。</p>
                  )}
                </section>
              ))}
            </div>
          </ScrollArea>
        )}
      </section>

      <aside className="photos-pane photos-studio-detail" aria-label="项目详情">
        <div className="photos-pane-head">
          <h3>项目详情</h3>
          {selected ? (
            <Badge tone={selected.access === "owner" ? "neutral" : "warning"} size="sm">
              {selected.access === "owner" ? "所有者" : "只读共享"}
            </Badge>
          ) : null}
        </div>
        <ScrollArea label="项目详情" className="photos-scroll">
          {!selected ? (
            <p className="photos-hint">从中间选择一个项目，可以改信息、下载源文件、写入导出目录、发送到画布，或移入回收站。</p>
          ) : (
            <div className="photos-detail" data-photos-project-detail={selected.id}>
              <dl className="photos-kv">
                <dt>所有者</dt>
                <dd>{selected.ownerName || "—"}</dd>
                <dt>分组</dt>
                <dd>{groups.find((group) => group.id === selected.groupId)?.name || "未命名分组"}</dd>
                <dt>可见性</dt>
                <dd>
                  {visibilityLabel(selected.visibility)}（{selected.visibility}）
                </dd>
                <dt>成员</dt>
                <dd>{selected.members.length ? selected.members.join("、") : "—"}</dd>
                <dt>源文件</dt>
                <dd>{selected.sourceName || "（无源文件）"}</dd>
                <dt>大小</dt>
                <dd>{formatBytes(selected.sourceSize)}</dd>
                <dt>SHA-256</dt>
                <dd className="is-mono" title={selected.sourceSha256}>
                  {selected.sourceSha256 || "—"}
                </dd>
                <dt>更新时间</dt>
                <dd>{formatTimestamp(Number(selected.updatedAt || 0) / 1000)}</dd>
              </dl>

              {owners ? null : (
                <p className="photos-hint-box" data-photos-readonly>
                  你不是这个项目的所有者，只能查看与下载；改名、可见性、成员、导出与移入回收站都不可用。
                </p>
              )}

              <section className="photos-group" aria-label="项目设置">
                <div className="photos-pane-head">
                  <h3>设置</h3>
                </div>
                <TextField
                  label="项目名称"
                  value={title}
                  disabled={!owners}
                  onChange={(event) => setTitle(event.target.value)}
                  hint="最多 120 个字；后端会清掉文件名里的非法字符。"
                />
                <div className="photos-form__row">
                  <label htmlFor="photos-project-group">分组</label>
                  <select
                    id="photos-project-group"
                    className="photos-select"
                    value={groupDraft}
                    disabled={!owners}
                    onChange={(event) => setGroupDraft(event.target.value)}
                  >
                    {groupOptions(groups).map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.label}
                        {group.isDefault ? "（默认）" : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="photos-form__row">
                  <span>可见性</span>
                  <div className="segmented text" role="group" aria-label="可见性">
                    {control.options.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        aria-pressed={option.selected}
                        disabled={option.disabled}
                        title={option.hint}
                        onClick={() => setVisibility(option.id)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <p className="photos-hint" data-photos-visibility-note>
                    {control.note}
                  </p>
                </div>
                {control.requiresMembers ? (
                  <div className="photos-form__row">
                    <label htmlFor="photos-members">成员账号 ID（一行一个，也接受空格或逗号分隔）</label>
                    <textarea
                      id="photos-members"
                      className="photos-textarea"
                      value={membersText}
                      disabled={!owners}
                      placeholder="usr_xxx"
                      onChange={(event) => setMembersText(event.target.value)}
                    />
                  </div>
                ) : null}
                <div className="photos-actions">
                  <Button size="sm" status={busy === "save" ? "loading" : "idle"} disabled={!owners} onClick={() => void saveProject()}>
                    保存设置
                  </Button>
                </div>
              </section>

              <section className="photos-group" aria-label="文件与发送">
                <div className="photos-pane-head">
                  <h3>文件与发送</h3>
                </div>
                <div className="photos-actions">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!selected.sourceNodeId || busy === "download"}
                    status={busy === "download" ? "loading" : "idle"}
                    iconStart={<Download size={14} strokeWidth={1.5} />}
                    onClick={() => void downloadSource()}
                  >
                    下载源文件
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!owners}
                    status={busy === "export" ? "loading" : "idle"}
                    iconStart={<Upload size={14} strokeWidth={1.5} />}
                    onClick={() => exportFileRef.current?.click()}
                  >
                    写入导出目录
                  </Button>
                  <Button
                    size="sm"
                    iconStart={<Send size={14} strokeWidth={1.5} />}
                    disabled={!selected.sourceNodeId}
                    onClick={() => void openSend()}
                  >
                    发送到画布
                  </Button>
                  {view === "projects" ? (
                    <Button size="sm" variant="danger" disabled={!owners} onClick={() => setDialog({ kind: "trash", project: selected })}>
                      移入回收站
                    </Button>
                  ) : null}
                </div>
                <input
                  ref={exportFileRef}
                  type="file"
                  hidden
                  aria-hidden="true"
                  tabIndex={-1}
                  onChange={() => void submitExport()}
                />
                <p className="photos-hint">
                  「写入导出目录」把本机选中的文件写进项目的「导出/」目录并刷新预览（后端 photocraft/projects/export）。
                </p>
              </section>
            </div>
          )}
        </ScrollArea>
      </aside>

      <Dialog
        open={dialog?.kind === "create"}
        title="新建图像工坊项目"
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              取消
            </Button>
            <Button status={busy === "create" ? "loading" : "idle"} onClick={() => void submitCreate()}>
              新建
            </Button>
          </>
        }
      >
        <div className="photos-form">
          <TextField label="项目名称" required value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} hint="最多 120 个字；留空时后端会用「未命名项目」。" />
          <div className="photos-form__row">
            <label htmlFor="photos-create-group">分组</label>
            <select id="photos-create-group" className="photos-select" value={createGroup} onChange={(event) => setCreateGroup(event.target.value)}>
              <option value="">默认分组</option>
              {groupOptions(groups).map((group) => (
                <option key={group.id} value={group.id}>
                  {group.label}
                </option>
              ))}
            </select>
          </div>
          <div className="photos-form__row">
            <label htmlFor="photos-create-file">源文件（可选，最大 24 MB）</label>
            <input
              id="photos-create-file"
              ref={createFileRef}
              type="file"
              accept="image/*"
              onChange={(event) => setCreateFileName(event.target.files?.[0]?.name || "")}
            />
            <p className="photos-hint">
              {createFileName ? "将写入：" + createFileName : "不选文件则创建一个空项目。"}
              　文件以 base64 内联过桥（后端上限 24 MB），超过会回 PHOTOCRAFT_TOO_LARGE。
            </p>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={dialog?.kind === "new-group"}
        title="新建分组"
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              取消
            </Button>
            <Button status={busy === "group" ? "loading" : "idle"} onClick={() => void submitCreateGroup()}>
              新建
            </Button>
          </>
        }
      >
        <div className="photos-form">
          <TextField label="分组名称" value={groupName} onChange={(event) => setGroupName(event.target.value)} hint="同名分组会直接复用，不会重复创建。" />
        </div>
      </Dialog>

      <Dialog
        open={dialog?.kind === "remove-group"}
        title="删除分组"
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              status={busy === "remove-group" ? "loading" : "idle"}
              onClick={() => dialog?.kind === "remove-group" && void submitRemoveGroup(dialog.group)}
            >
              删除
            </Button>
          </>
        }
      >
        <p className="photos-hint">
          删除「{dialog?.kind === "remove-group" ? dialog.group.name : ""}」后，里面的项目会被移回默认分组，项目本身不会被删除。
        </p>
      </Dialog>

      <Dialog
        open={dialog?.kind === "trash"}
        title="移入回收站"
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              取消
            </Button>
            <Button variant="danger" status={busy === "trash" ? "loading" : "idle"} onClick={() => void runTrash()}>
              移入回收站
            </Button>
          </>
        }
      >
        <p className="photos-hint">
          「{dialog?.kind === "trash" ? dialog.project.title : ""}」会连同缓存目录进入回收站，之后可以恢复。
        </p>
      </Dialog>

      <Dialog
        open={dialog?.kind === "purge"}
        title="彻底删除项目"
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              取消
            </Button>
            <Button variant="danger" status={busy === "purge" ? "loading" : "idle"} onClick={() => void runPurge()}>
              彻底删除
            </Button>
          </>
        }
      >
        <p className="photos-hint">
          {TRASH_PURGE_HINT}
          <br />
          目标：「{dialog?.kind === "purge" ? dialog.project.title : ""}」
        </p>
      </Dialog>

      <Dialog
        open={dialog?.kind === "send"}
        title="发送到应用"
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              关闭
            </Button>
            <Button
              status={busy === "send" ? "loading" : "idle"}
              disabled={!pickedTarget || pickedTarget.disabled || (pickedTarget.needsCanvas && !canvasId)}
              onClick={() => void submitSend()}
            >
              发送
            </Button>
          </>
        }
      >
        <div className="photos-form">
          {!selected ? (
            <p className="photos-hint">没有选中的项目。</p>
          ) : (
            <>
              <p className="photos-hint">
                发送只传引用（nodeId + 项目 ID + revision），不传图片字节；目标列表由后端按打开权限过滤，界面不硬编码。
              </p>
              {sendPanelState.kind === "ready" ? (
                <>
                  <div className="photos-form__row">
                    <label htmlFor="photos-target">目标应用</label>
                    <select
                      id="photos-target"
                      className="photos-select"
                      value={targetKey}
                      onChange={(event) => {
                        setTargetKey(event.target.value);
                        setSendError("");
                      }}
                    >
                      {projectedTargets.targets.map((item) => (
                        <option key={item.key} value={item.key} disabled={item.disabled}>
                          {targetOptionLabel(item.target)}
                          {item.disabled ? "（不支持当前格式）" : ""}
                        </option>
                      ))}
                    </select>
                    {pickedTarget && pickedTarget.disabled ? <p className="photos-hint">{pickedTarget.disabledReason}</p> : null}
                    {pickedTarget && pickedTarget.note ? <p className="photos-hint">{pickedTarget.note}</p> : null}
                  </div>
                  {pickedTarget && pickedTarget.needsCanvas ? (
                    <div className="photos-form__row">
                      <label htmlFor="photos-target-canvas">目标画布</label>
                      <select
                        id="photos-target-canvas"
                        className="photos-select"
                        value={canvasId}
                        onChange={(event) => setCanvasId(event.target.value)}
                      >
                        <option value="">请选择画布</option>
                        {(targets?.canvases || []).map((canvas) => (
                          <option key={canvas.id} value={canvas.id}>
                            {canvas.title}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="photos-hint-box" data-photos-targets-state={sendPanelState.kind}>
                  <span>{sendPanelState.title}</span>
                  <span>{sendPanelState.description}</span>
                  <div className="photos-actions">
                    <Button size="sm" variant="secondary" onClick={() => void openSend()}>
                      重新读取目标
                    </Button>
                  </div>
                </div>
              )}
              {sendError ? (
                <p className="photos-error" role="alert" data-photos-send-error>
                  {sendError}
                </p>
              ) : null}
              {sendResult ? (
                <p className="photos-prompt" data-photos-send-result>
                  {exchangeResultText(sendResult)}
                </p>
              ) : null}
            </>
          )}
        </div>
      </Dialog>
    </div>
  );
}
