import React, { useCallback, useEffect, useState } from "react";
import { Button } from "../design-system/primitives";
import { ResourcePicker } from "./ResourcePicker";

/** D3-04D · Projects：只引用 ResourceRef，逐资源重新授权。 */
type ResBridge = { command: (c: Record<string, unknown>) => Promise<any> };
const bridge = (): ResBridge | undefined => (window as any).openarc?.resource;

export function ProjectsApp() {
  const [projects, setProjects] = useState<any[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [resources, setResources] = useState<any[]>([]);
  const [name, setName] = useState("");
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cmd = useCallback(async (payload: Record<string, unknown>): Promise<any> => {
    const b = bridge();
    if (!b) return { ok: false, error: "NO_BRIDGE" };
    try { return await b.command(payload); } catch { return { ok: false, error: "INTERNAL_ERROR" }; }
  }, []);

  const loadProjects = useCallback(async () => {
    const res = await cmd({ type: "resource/listProjects" });
    if (res.ok) setProjects(res.items); else setError(res.error);
  }, [cmd]);
  const loadResources = useCallback(async (id: string) => {
    const res = await cmd({ type: "resource/listProjectResources", projectId: id });
    if (res.ok) setResources(res.items); else setError(res.error);
  }, [cmd]);
  useEffect(() => { void loadProjects(); }, [loadProjects]);

  const create = async () => {
    const res = await cmd({ type: "resource/createProject", name: name || "未命名项目" });
    if (res.ok) { setName(""); await loadProjects(); setProjectId(res.project.id); await loadResources(res.project.id); } else setError(res.error);
  };
  const addResource = async (ref: string) => {
    setPicking(false);
    if (!projectId) return;
    const res = await cmd({ type: "resource/addProjectResource", projectId, resourceRef: ref });
    if (res.ok) await loadResources(projectId); else setError(res.error);
  };

  return (
    <div className="projects" data-d3-04d="projects">
      <header className="gov-head"><h2>项目</h2></header>
      <div className="gov-form">
        <input data-d3-04d-project-name placeholder="项目名" value={name} onChange={(e) => setName(e.target.value)} />
        <Button variant="primary" size="sm" data-d3-04d-project-new onClick={() => void create()}>新建项目</Button>
      </div>
      {error ? <p className="gov-error" role="alert" data-d3-04d-project-error>{error}</p> : null}
      <ul className="gov-list" data-d3-04d-projects>
        {projects.map((p) => (
          <li key={p.id} className="gov-row">
            <button type="button" data-d3-04d-project={p.id} aria-pressed={projectId === p.id} onClick={() => { setProjectId(p.id); void loadResources(p.id); }}>{p.name}</button>
          </li>
        ))}
      </ul>
      {projectId ? (
        <section data-d3-04d-project-active={projectId}>
          <div className="gov-form">
            <Button variant="secondary" size="sm" data-d3-04d-project-add onClick={() => setPicking(true)}>引用资源</Button>
          </div>
          <ul className="gov-list" data-d3-04d-project-resources>
            {resources.map((r) => (
              <li key={r.resourceId} data-d3-04d-project-resource={r.resourceId} data-d3-04d-project-resource-authorized={r.authorized ? "true" : "false"} className="gov-row">
                <span className="gov-name">{r.authorized ? r.resource.name : r.resourceRef}</span>
                <span className="gov-meta">{r.authorized ? "可访问" : "无访问权限"}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {picking ? <ResourcePicker pickerAppId="resource-library" requestedActions={["resource.view"]} title="引用资源" onChoose={(ref) => void addResource(ref)} onCancel={() => setPicking(false)} /> : null}
    </div>
  );
}
