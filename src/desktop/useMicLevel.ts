import { useEffect, useMemo, useRef, useState } from "react";

/** 推给 AI 球的一帧信号：要么在听（带真实音量），要么只是待机的装饰动效。 */
export type OrbLevel = { state: "listening" | "thinking"; level: number };

/**
 * 麦克风电平（给 AI 球"跟着声音动"用）。
 *
 * 设计要点：**逐帧的东西一律不进 React state**。
 * 30fps 的 setState 会让 AI 面板（还是玻璃层）每帧重渲染一遍 —— 实测在真机上会**闪屏**，
 * 而且完全是白烧。所以这里只暴露一个订阅：电平在 rAF 里算好，直接推给订阅者（球、电平条），
 * React 只在"开/关麦克风""出错"这种真状态变化时重渲染。
 *
 * 三条纪律：
 *   1. 只在本机算一个 dB 电平 —— 不录音、不缓存、不发送；
 *   2. 停下来必须把 track 停掉（`track.stop()`），否则 macOS 的麦克风指示灯会一直亮；
 *   3. 约 30fps、指数平滑；dB 映射（−60..0dB → 0..1）而不是线性 RMS —— 麦克风读数天然很小，
 *      线性要么几乎不动、要么一下顶满（实测线性版两档音量都读到 1.0）。
 */
export function useMicSignal(active: boolean, smoothing = 0.3) {
  const [error, setError] = useState<string | null>(null);
  const listeners = useRef(new Set<(v: OrbLevel) => void>());
  const current = useRef<OrbLevel>({ state: "thinking", level: 0 });

  const emit = (v: OrbLevel) => {
    current.current = v;
    listeners.current.forEach((fn) => fn(v));
  };

  useEffect(() => {
    if (!active) {
      emit({ state: "thinking", level: 0 });
      return;
    }
    let raf = 0;
    let ctx: AudioContext | null = null;
    let stream: MediaStream | null = null;
    let analyser: AnalyserNode | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let smoothed = 0;
    let buf: Uint8Array<ArrayBuffer> | null = null;

    const tick = () => {
      if (analyser && buf) {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i += 1) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        const db = 20 * Math.log10(Math.max(rms, 1e-6));
        const target = Math.min(1, Math.max(0, (db + 60) / 60));
        smoothed = smoothed + (target - smoothed) * smoothing;
        emit({ state: "listening", level: smoothed });
      }
      raf = requestAnimationFrame(tick);
    };

    void (async () => {
      try {
        const md = navigator.mediaDevices;
        if (!md?.getUserMedia) throw new Error("no-media-devices");
        stream = await md.getUserMedia({ audio: true, video: false });
        ctx = new AudioContext();
        source = ctx.createMediaStreamSource(stream);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        buf = new Uint8Array(new ArrayBuffer(analyser.fftSize));
        setError(null);
        raf = requestAnimationFrame(tick);
      } catch (e) {
        const name = e instanceof Error ? e.name : "";
        setError(
          name === "NotAllowedError"
            ? "麦克风权限被拒绝（系统设置 → 隐私与安全性 → 麦克风）"
            : name === "NotFoundError"
              ? "没有找到可用的麦克风"
              : "麦克风打不开：" + (e instanceof Error ? e.message : String(e)),
        );
      }
    })();

    return () => {
      cancelAnimationFrame(raf);
      try {
        source?.disconnect();
        analyser?.disconnect();
      } catch {
        /* 断开失败无所谓 */
      }
      void ctx?.close().catch(() => {});
      stream?.getTracks().forEach((t) => t.stop());
      emit({ state: "thinking", level: 0 });
    };
  }, [active, smoothing]);

  /** 订阅电平（返回退订函数）。订阅时立刻收到当前值，订阅者不用自己初始化。 */
  const subscribe = useMemo(
    () => (fn: (v: OrbLevel) => void) => {
      listeners.current.add(fn);
      fn(current.current);
      return () => {
        listeners.current.delete(fn);
      };
    },
    [],
  );

  return { error, subscribe };
}
