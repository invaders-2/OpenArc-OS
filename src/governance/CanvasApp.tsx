import React, { useCallback, useEffect, useState } from "react";
import { Button } from "../design-system/primitives";
import { ResourcePicker } from "./ResourcePicker";

/** D3-04D · Canvas：节点保存 ResourceRef + PIN_VERSION / FOLLOW_LATEST，不保存绝对路径。 */
type ResBridge = { command: (c: Record<string, unknown>) => Promise<any> };
const bridge = (): ResBridge | undefined => (window as any).openarc?.resource;

const STATE_LABEL: Record<string, string> = {
  AVAILABLE: "可用",
  UNAUTHORIZED: "无访问权限",
  DELETED: "已删除",
  UNAVAILABLE: "内容不可用",
  VERSION_AVAILABLE: "有新版本",
};

export function CanvasApp() {
  const [boards, setBoards] = useState<any[]>([]);
  const [boardId, setBoardId] = useState<string | null>(null);
  const [nodes, setNodes] = useState<any[]>([]);
  const [name, setName] = useState("");
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cmd = useCallback(async (payload: Record<string, unknown>): Promise<any> => {
    const b = bridge();
    if (!b) return { ok: false, error: "NO_BRIDGE" };
    try { return await b.command(payload); } catch { return { ok: false, error: "INTERNAL_ERROR" }; }
  }, []);

  const loadBoards = useCallback(async () => {
    const res = await cmd({ type: "resource/listBoards" });
    if (res.ok) setBoards(res.items); else setError(res.error);
  }, [cmd]);
  const loadBoard = useCallback(async (id: string) => {
    const res = await cmd({ type: "resource/getBoard", boardId: id });
    if (res.ok) setNodes(res.nodes); else setError(res.error);
  }, [cmd]);
  useEffect(() => { void loadBoards(); }, [loadBoards]);

  const createBoard = async () => {
    const res = await cmd({ type: "resource/createBoard", name: name || "未命名画布" });
    if (res.ok) { setName(""); await loadBoards(); setBoardId(res.board.id); await loadBoard(res.board.id); } else setError(res.error);
  };
  const insert = async (ref: string) => {
    setPicking(false);
    if (!boardId) return;
    const res = await cmd({ type: "resource/addCanvasResource", boardId, resourceRef: ref });
    if (res.ok) await loadBoard(boardId); else setError(res.error);
  };
  const updateLatest = async (nodeId: string) => {
    const res = await cmd({ type: "resource/updateCanvasNode", nodeId });
    if (res.ok && boardId) await loadBoard(boardId); else if (!res.ok) setError(res.error);
  };

  return (
    <div className="canvas-app" data-d3-04d="canvas">
      <header className="gov-head"><h2>无限画布</h2></header>
      <div className="gov-form">
        <input data-d3-04d-canvas-name placeholder="画布名" value={name} onChange={(e) => setName(e.target.value)} />
        <Button variant="primary" size="sm" data-d3-04d-canvas-new onClick={() => void createBoard()}>新建画布</Button>
      </div>
      {error ? <p className="gov-error" role="alert" data-d3-04d-canvas-error>{error}</p> : null}
      <ul className="gov-list" data-d3-04d-canvas-boards>
        {boards.map((b) => (
          <li key={b.id} className="gov-row">
            <button type="button" data-d3-04d-canvas-board={b.id} aria-pressed={boardId === b.id} onClick={() => { setBoardId(b.id); void loadBoard(b.id); }}>{b.name}</button>
          </li>
        ))}
      </ul>
      {boardId ? (
        <section data-d3-04d-canvas-active={boardId}>
          <div className="gov-form">
            <Button variant="secondary" size="sm" data-d3-04d-canvas-insert onClick={() => setPicking(true)}>插入资源</Button>
          </div>
          <ul className="gov-list" data-d3-04d-canvas-nodes>
            {nodes.map((n) => (
              <li key={n.nodeId} data-d3-04d-canvas-node={n.nodeId} data-d3-04d-canvas-node-state={n.state} className="gov-row">
                <span className="gov-name">{n.resource ? n.resource.name : n.resourceRef}</span>
                <span className="gov-meta">{STATE_LABEL[n.state] || n.state} · {n.versionMode} · v{n.resourceVersion}{n.latestVersion && n.latestVersion !== n.resourceVersion ? " → v" + n.latestVersion : ""}</span>
                {n.state === "VERSION_AVAILABLE" ? <Button variant="secondary" size="sm" data-d3-04d-canvas-update={n.nodeId} onClick={() => void updateLatest(n.nodeId)}>更新到最新</Button> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {picking ? <ResourcePicker pickerAppId="canvas" requestedActions={["resource.read"]} title="插入资源" onChoose={(ref) => void insert(ref)} onCancel={() => setPicking(false)} /> : null}
    </div>
  );
}
