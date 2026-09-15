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
import React, { useCallback, useEffect, useState } from "react";
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
  const first = request.expectedEffects && request.expectedEffects[0];
  if (first && typeof first.action === "string") return String(first.action);
  return "执行该工具声明的副作用";
}

export function ApprovalPrompt({ onOpenChange }: { onOpenChange?: (open: boolean) => void } = {}) {
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // 宿主没有装配 approval IPC（例如仅验证桌面外壳的探针）时静默停用，绝不反复骚扰主进程。
  const [unavailable, setUnavailable] = useState(false);

  const refresh = useCallback(async () => {
    if (unavailable) return;
    const b = bridge();
    if (!b) return;
    try {
      const res = await b.command({ type: "sideEffect/listPending" });
      const items = Array.isArray(res.items) ? (res.items as ApprovalRequest[]) : [];
      setRequest((cur) => (cur && items.some((i) => i.approvalRequestId === cur.approvalRequestId) ? cur : items[0] || null));
    } catch {
      // 拉取失败不改变任何 authority 状态
      setUnavailable(true);
    }
  }, [unavailable]);

  useEffect(() => {
    const b = bridge();
    if (!b) return;
    void refresh();
    void 0;
    const off = b.onEvent((event) => {
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
    setNotice(null);
    try {
      const b = bridge();
      if (!b) return;
      const res = await b.command({ type: "sideEffect/decideApproval", approvalRequestId: current.approvalRequestId, decision });
      if (!res.ok) setNotice("该请求已失效（已处理 / 已过期 / 已被取消），未执行任何操作。");
      setRequest(null);
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
      onClose={() => void decide("DENY")}
      footer={
        <>
          <button className="ghost" disabled={busy} data-approval-action="deny" onClick={() => void decide("DENY")}>
            拒绝
          </button>
          <button className="primary" disabled={busy} data-approval-action="approve" onClick={() => void decide("APPROVE")}>
            批准
          </button>
        </>
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
          <dd data-approval-target>{request.targetDisplayName || "未命名资源"}<span className="approval-ref">{request.resourceRef || ""}</span></dd>
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
        {notice ? <p className="approval-notice" role="status">{notice}</p> : null}
      </div>
    </Dialog>
  );
}
