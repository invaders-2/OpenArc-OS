/** 执行计划卡：手动确认模式下，Agent 先列出将要做的改动，用户确认后才开始执行（逻辑见 ./plan.ts） */
import { Icon } from "../ui/Icon";
import type { PlanCard } from "./plan";

export function PlanCardView({ card, busy, onRun, onRevise }: { card: PlanCard; busy: boolean; onRun: () => void; onRevise: () => void }) {
  const open = card.status === "open";
  return <div className={"qa plan" + (open ? "" : " done")} data-plan={card.status}>
    <div className="qa-h"><Icon name="layers" size="s" /><b>{open ? "执行计划 · 等你确认" : card.status === "approved" ? "已确认，开始执行" : "已退回修改"}</b><span className="sp" /><span className="tag tnum">{card.steps.length} 步</span></div>
    <ol className="plan-steps">{card.steps.map((s, i) => <li key={i}><span className="tnum">{i + 1}</span><span>{s}</span></li>)}</ol>
    {open ? <div className="plan-note">每一步写入画布时仍会请你批准</div> : null}
    {open ? <div className="qa-f">
      <span className="sp" />
      <button className="btn ghost" data-plan-revise disabled={busy} onClick={onRevise}>修改</button>
      <button className="btn solid" data-plan-run disabled={busy} onClick={onRun}><Icon name="send" size="s" />按此计划执行</button>
    </div> : null}
  </div>;
}
