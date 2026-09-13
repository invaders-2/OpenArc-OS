/**
 * D3-02 · 最小 Protected Resource Fixture。
 *
 * 这是 Unauthorized Page State 第一次接真实授权：内容是否可见、能否编辑，
 * 全部来自主进程 authorization/capabilities 的结果，**渲染进程不判断 role，
 * 也不自己拼权限**。
 *
 * 设计约束：
 *   · 未设置 resourceRef 时组件返回 null —— 不污染产品 DOM、不影响 D2/D3 视觉回归。
 *   · 探针通过 window.__openarcProtectedResourceRef 或自定义事件
 *     "openarc:protected-resource" 注入 resourceRef。
 *   · 这里只画 capability 投影；真正的 command 必须回到主进程重新 authorize（§61）。
 */
import { useEffect, useState } from "react";
import { PageState } from "../design-system/page-states";

declare global {
  interface Window {
    __openarcProtectedResourceRef?: string | null;
  }
}

type Caps = Record<string, boolean> & { canRead?: boolean; canEdit?: boolean };
type Meta = { name?: string; resourceType?: string; resourceRef?: string };
type AuthzResult = { ok?: boolean; error?: string; resource?: Meta; capabilities?: Caps };

export function ProtectedResourceFixture() {
  const bridge = typeof window !== "undefined" ? window.openarc?.authorization : undefined;
  const [resourceRef, setResourceRef] = useState<string | null>(() =>
    typeof window !== "undefined" ? window.__openarcProtectedResourceRef ?? null : null,
  );
  // 每次注入都 +1，强制重新 authorize（会话/权限变化后同一 ref 也必须重算）。
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<{ status: "idle" | "loading" | "ready" | "unauthorized"; result?: AuthzResult }>({
    status: "idle",
  });

  useEffect(() => {
    const onEvent = (e: Event) => {
      const detail = (e as CustomEvent).detail as { resourceRef?: string } | undefined;
      if (detail && typeof detail.resourceRef === "string") {
        setResourceRef(detail.resourceRef);
        setNonce((n) => n + 1);
      }
    };
    window.addEventListener("openarc:protected-resource", onEvent);
    return () => window.removeEventListener("openarc:protected-resource", onEvent);
  }, []);

  useEffect(() => {
    if (!bridge || !resourceRef) {
      setState({ status: "idle" });
      return;
    }
    let alive = true;
    setState({ status: "loading" });
    bridge
      .command({ type: "authorization/capabilities", resourceRef })
      .then((raw) => {
        if (!alive) return;
        const res = raw as AuthzResult;
        if (res && res.ok) setState({ status: "ready", result: res });
        else setState({ status: "unauthorized", result: res || { ok: false, error: "NOT_FOUND_OR_FORBIDDEN" } });
      })
      .catch(() => {
        if (alive) setState({ status: "unauthorized", result: { ok: false, error: "INTERNAL_ERROR" } });
      });
    return () => {
      alive = false;
    };
  }, [bridge, resourceRef, nonce]);

  if (!bridge || !resourceRef || state.status === "idle" || state.status === "loading") return null;

  const panelStyle: React.CSSProperties = {
    position: "fixed",
    left: 16,
    bottom: 96,
    width: 300,
    padding: 16,
    borderRadius: 12,
    background: "rgba(20,20,24,0.82)",
    color: "#fff",
    zIndex: 40,
    boxShadow: "0 12px 32px rgba(0,0,0,0.35)",
  };

  if (state.status === "unauthorized") {
    return (
      <section className="d3-02-protected" data-d3-02-protected="unauthorized" data-d3-02-error={state.result?.error || "NOT_FOUND_OR_FORBIDDEN"} style={panelStyle}>
        <PageState kind="unauthorized" title="没有访问权限" description="当前用户与 App Context 无权访问该资源，或它已不存在。" />
      </section>
    );
  }

  const caps = state.result?.capabilities || {};
  const meta = state.result?.resource;
  return (
    <section
      className="d3-02-protected"
      data-d3-02-protected="ready"
      data-d3-02-can-edit={String(!!caps.canEdit)}
      data-d3-02-can-read={String(!!caps.canRead)}
      style={panelStyle}
    >
      <strong data-d3-02-name>{meta?.name}</strong>
      <div style={{ opacity: 0.7, fontSize: 12, marginTop: 4 }}>{meta?.resourceType}</div>
      <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
        <button type="button" disabled={!caps.canEdit} data-d3-02-action="edit">
          编辑
        </button>
      </div>
    </section>
  );
}
