import { watch } from "vue";
import * as manager from "../../electron/window-manager.ts";
import { useShellStore } from "../stores/shell";
import { useIdentityStore } from "../stores/identity";
import { browserRuntime, type NativeResult } from "./browser-runtime";

/**
 * 原生层上行通路（`src/desktop/useDesktop.ts:332-375` 同一条线）：
 * 用 **electron/window-manager.ts 的 nativeIntents()** 从窗口域结算原生意图，
 * 再经 `window.openarc.sync()` 交给主进程。没有第二套"意图"算法。
 *
 * 指纹稳定才下发：拖动/重排每帧都会改 model，无差别 IPC 会把主进程刷满。
 */
export function installNativeSync(): () => void {
  const shell = useShellStore();
  const identity = useIdentityStore();
  const bridge = window.openarc;
  if (!bridge?.sync) return () => {};

  let lastFingerprint = "";
  const stop = watch(
    () =>
      [shell.model, shell.hostSize, shell.anyOverlay, browserRuntime.reserves, browserRuntime.panelOpen, identity.phase] as const,
    () => {
      // 锁屏 / 下载面板也必须让原生视图整块让位（与 useDesktop.ts 的 overlayOpen 同一口径）
      const overlayOpen = shell.anyOverlay || browserRuntime.panelOpen || identity.phase === "locked";
      // host 必须是**普通对象**：Pinia 的 state 是 reactive Proxy，Proxy 过不了
      // contextBridge / 结构化克隆，invoke 会在渲染进程就抛 DataCloneError
      // （探针 V1 抓到的真实缺陷：sync 一次都没到主进程）。
      const host = { width: shell.hostSize.width, height: shell.hostSize.height };
      const intents = manager.nativeIntents(shell.model, host, { ...browserRuntime.reserves });
      const fingerprint = JSON.stringify(intents) + `|${overlayOpen ? 1 : 0}`;
      if (fingerprint === lastFingerprint) return;
      lastFingerprint = fingerprint;
      void bridge.sync({ intents, overlayOpen, interactive: true, host }).then(
        (res) => {
          if (res?.results) browserRuntime.native = res.results as NativeResult[];
        },
        () => {
          /* 主进程不可用时桌面仍应可操作 */
        },
      );
    },
    { immediate: true },
  );
  return stop;
}
