import type { AgentMsg } from "./state";

export function QueryLocator({ msgs, onJump }: { msgs: AgentMsg[]; onJump: (id: string) => void }) {
  const queries = msgs.filter((m) => m.role === "u").map((m, index) => ({ m, index })); // index = 第几轮提问，不是消息序号
  if (queries.length < 2) return null;
  return <nav className="query-locator" aria-label="对话轮次定位">{queries.map(({ m, index }) => <button key={m.id} className="query-dot" title={`第 ${index + 1} 轮：${m.text}`} aria-label={`跳转到第 ${index + 1} 轮：${m.text}`} onClick={() => onJump(m.id)}><span /></button>)}</nav>;
}
