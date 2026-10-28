import { useEffect, useState } from "react";
import { useCtl } from "./ctx";

/** openarc-asset:<ref> → 可显示的地址（读一次缓存）；普通地址原样返回 */
const cache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();
export function useAssetUrl(src: string): string {
  const ctl = useCtl();
  // 桌面版里外链（服务商结果）不能直接显示：先由主进程下载进资源库再显示
  const be = ctl.store.backend;
  const isRef = src.startsWith("openarc-asset:") || (be.kind === "bridge" && !!be.importRemote && /^https?:\/\//i.test(src));
  const [url, setUrl] = useState<string>(isRef ? cache.get(src) || "" : src);
  useEffect(() => {
    if (!isRef) { setUrl(src); return; }
    if (cache.has(src)) { setUrl(cache.get(src) || ""); return; }
    let p = pending.get(src);
    if (!p) { p = src.startsWith("openarc-asset:") ? be.resolveAsset(src) : be.importRemote!(ctl.store.state.canvasId, src, "远程结果").then((ref) => (ref.startsWith("openarc-asset:") ? be.resolveAsset(ref) : null)); pending.set(src, p); }
    let alive = true;
    p.then((u) => { cache.set(src, u); pending.delete(src); if (alive) setUrl(u || ""); });
    return () => { alive = false; };
  }, [src, isRef, ctl]);
  return url;
}
