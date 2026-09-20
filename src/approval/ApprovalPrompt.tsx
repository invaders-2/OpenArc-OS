/**
 * D4-03C4 · Trusted Approval UI（真实 production 最小实现）。
 *
 * 它不是安全决策者：**唯一**可做的事是把 OpenArc main process 下发的 safe 快照显示出来，
 * 并把用户的 APPROVE / DENY 交给 Trusted Approval Gateway。
 *
 * 信任边界（§14 / §15 / §45）：
 *   · 只渲染 main process 从 Tool Registry + SideEffectPlan + Resource Domain 推导出的字段；
 *   · 绝不显示 / 相信 Harness 文案（"This is safe" / "already approved" / "read-only"）；
 *   · 绝不显示绝对路径 / store root / provider secret / capability / session token / raw DB id；
 *   · 只上送 { approvalRequestId, decision }，不指定 userId / role / appId / risk。
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "../desktop/Dialog";

export type ApprovalRequest = {
  approvalRequestId: string;
  status: string;
  toolId: string;
  toolDisplayName: string;
  riskClass: string | null;
  effectClass: string;
  targetDisplayName: string | null;
  resourceRef: string | null;
  /** D5-01 Closure-2：受控浏览器目标的稳定身份与**被批准的地址**（都来自主进程）。 */
  targetRef: string | null;
  url: string | null;
  expectedEffects: Array<Record<string, unknown>>;
  expectedVersion: number | null;
  currentVersion: number | null;
  expiresAt: number | null;
  requiresApproval: boolean;
};

type SideEffectBridge = {
  command: (command: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onEvent: (cb: (event: { type?: string; request?: ApprovalRequest }) => void) => () => void;
};

function bridge(): SideEffectBridge | null {
  const w = window as unknown as { openarc?: { sideEffect?: SideEffectBridge } };
  return (w.openarc && w.openarc.sideEffect) || null;
}

const RISK_LABEL: Record<string, string> = {
  READ_ONLY: "只读",
  REVERSIBLE_WRITE: "可逆写入",
  IRREVERSIBLE_WRITE: "不可逆写入",
  EXTERNAL_SIDE_EFFECT: "外部副作用",
  PRIVILEGED: "特权操作",
};

function effectText(request: ApprovalRequest): string {
  if (request.toolId === "resource.trash") return "把该资源移入废纸篓（可通过恢复还原）";
  if (request.toolId === "browser.navigate") return "把该浏览器标签导航到下面这个地址（可通过后退还原）";
  const first = request.expectedEffects && request.expectedEffects[0];
  if (first && typeof first.action === "string") return String(first.action);
  return "执行该工具声明的副作用";
}

/** 迟到（执行已开始 / 已有结果）：面板必须留着把这件事说清楚，绝不静默关闭。AI 面板的撤销路径共用同一句。 */
export const LATE_NOTICE = "操作已进入执行或已有结果，本次拒绝／撤销未生效。";
/** 通用失效文案只用于后端已确认不再 actionable、且不是迟到的情形。 */
const STALE_NOTICE = "该请求已失效（已处理 / 已过期 / 已被取消），未执行任何操作。";

export function ApprovalPrompt({ onOpenChange }: { onOpenChange?: (open: boolean) => void } = {}) {
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // 宿主没有装配 approval IPC（例如仅验证桌面外壳的探针）时静默停用，绝不反复骚扰主进程。
  const [unavailable, setUnavailable] = useState(false);
  // 提示（迟到 / 失效）必须比轮询活得久：否则 2s 后的兜底刷新会把面板连同文案一起关掉。
  const noticeRef = useRef<string | null>(null);
  const showNotice = (text: string | null) => { noticeRef.current = text; setNotice(text); };

  /** 只信后端权威：挂载 / 兜底刷新 / 提示确认后都由它重建可见列表。 */
  const fetchPending = useCallback(async (): Promise<ApprovalRequest[]> => {
    const b = bridge();
    if (!b) return [];
    try {
      const res = await b.command({ type: "sideEffect/listPending" });
      return Array.isArray(res.items) ? (res.items as ApprovalRequest[]) : [];
    } catch {
      // 拉取失败不改变任何 authority 状态
      setUnavailable(true);
      return [];
    }
  }, []);

  const refresh = useCallback(async () => {
    if (unavailable) return;
    if (noticeRef.current) return; // 用户还没确认提示：不抢占、不关闭
    const items = await fetchPending();
    setRequest((cur) => (cur && items.some((i) => i.approvalRequestId === cur.approvalRequestId) ? cur : items[0] || null));
  }, [unavailable, fetchPending]);

  useEffect(() => {
    const b = bridge();
    if (!b) return;
    void refresh();
    const off = b.onEvent((event) => {
      if (noticeRef.current) return; // 同上：提示未确认前不让新请求顶掉面板
      if (event && event.type === "sideEffect/approvalRequested" && event.request) setRequest(event.request);
    });
    // 兜底刷新：推送通道不可用时 UI 仍然可用。
    const timer = window.setInterval(() => { void refresh(); }, 2000);
    return () => { off(); window.clearInterval(timer); };
  }, [refresh]);

  useEffect(() => { onOpenChange?.(!!request); }, [request, onOpenChange]);

  const decide = async (decision: "APPROVE" | "DENY") => {
    const current = request;
    if (!current || busy) return;
    setBusy(true);
    showNotice(null);
    try {
      const b = bridge();
      if (!b) return;
      const res = await b.command({ type: "sideEffect/decideApproval", approvalRequestId: current.approvalRequestId, decision });
      if (res && res.ok) { setRequest(null); return; }
      // 迟到：执行已开始或已有结果 —— 面板留着说清楚，绝不静默关闭，也绝不显示"未执行"。
      if (res && res.error === "SIDE_EFFECT_APPROVAL_TOO_LATE") { showNotice(LATE_NOTICE); return; }
      // 其余失败：只有后端权威确认该请求不再 actionable 才用"已失效"文案；仍待决则留在面板上重试。
      const items = await fetchPending();
      if (items.some((i) => i.approvalRequestId === current.approvalRequestId)) { showNotice(null); return; }
      showNotice(STALE_NOTICE);
    } finally {
      setBusy(false);
    }
  };

  /** 用户确认提示之后：先重读后端权威，只有它说该请求不再 actionable 才关闭。 */
  const dismiss = async () => {
    const current = request;
    if (!current || busy) return;
    setBusy(true);
    try {
      const items = await fetchPending();
      const stillActionable = items.some((i) => i.approvalRequestId === current.approvalRequestId);
      showNotice(null);
      if (!stillActionable) setRequest(null);
    } finally {
      setBusy(false);
    }
  };

  if (!request) return null;

  return (
    <Dialog
      open
      title="OpenArc 需要你的批准"
      ariaLabel="OpenArc 需要你的批准"
      onClose={() => void (notice ? dismiss() : decide("DENY"))}
      footer={
        notice ? (
          <button className="primary" disabled={busy} data-approval-dismiss onClick={() => void dismiss()}>
            知道了
          </button>
        ) : (
          <>
            <button className="ghost" disabled={busy} data-approval-action="deny" onClick={() => void decide("DENY")}>
              拒绝
            </button>
            <button className="primary" disabled={busy} data-approval-action="approve" onClick={() => void decide("APPROVE")}>
              批准
            </button>
          </>
        )
      }
    >
      <div className="approval" data-approval-request-id={request.approvalRequestId} data-approval-tool={request.toolId}>
        <dl className="approval-grid">
          <dt>应用 / Agent</dt>
          <dd data-approval-app>{request.toolId.startsWith("resource.") ? "AI 助手（本机会话）" : "本机 Agent"}</dd>
          <dt>工具</dt>
          <dd data-approval-tool-name>{request.toolDisplayName}（{request.toolId}）</dd>
          <dt>风险</dt>
          <dd>
            <span className="approval-risk" data-approval-risk={request.riskClass || request.effectClass}>
              {RISK_LABEL[request.riskClass || ""] || request.effectClass}
            </span>
          </dd>
          <dt>目标</dt>
          <dd data-approval-target>
            {request.targetDisplayName || "未命名资源"}
            <span className="approval-ref">{request.resourceRef || request.targetRef || ""}</span>
            {/* 批准的就是这个地址：必须让用户**看见**，否则"批准"无从谈起。 */}
            {request.url ? <span className="approval-ref" data-approval-url>{request.url}</span> : null}
          </dd>
          <dt>预期效果</dt>
          <dd data-approval-effect>{effectText(request)}</dd>
          <dt>前置条件</dt>
          <dd data-approval-version>
            {request.currentVersion == null ? "版本未知" : "版本 " + request.currentVersion}
          </dd>
        </dl>
        <p className="approval-note">
          以上信息由 OpenArc Tool Registry 与 Resource Domain 生成，模型无法修改。批准只对这一次调用有效，参数或版本变化会自动失效。
        </p>
        {notice ? <p className="approval-notice" role="status" data-ai-notice>{notice}</p> : null}
      </div>
    </Dialog>
  );
}
