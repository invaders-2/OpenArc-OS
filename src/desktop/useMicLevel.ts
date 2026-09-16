import { useEffect, useRef, useState } from "react";

/**
 * 麦克风电平（给 AI 球"跟着声音动"用）。
 *
 * 三条纪律，缺一不可：
 *   1. **只在本机算一个 RMS 电平** —— 不录音、不缓存、不发送：音频帧出了这个函数就没了；
 *   2. **停下来必须把 track 停掉**（`track.stop()`），否则 macOS 的麦克风指示灯会一直亮；
 *   3. 采样走 rAF、约 30fps，平滑一点点（指数衰减），否则球会抖得像频谱而不是"呼吸"。
 *
 * 返回的 level 是 0..1（已经过平滑），error 是"为什么没开成"的人话原因。
 */
export function useMicLevel(active: boolean, smoothing = 0.25) {
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) {
      setLevel(0);
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
      if (!analyser || !buf) return;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 1) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      // 用 dB 而不是线性 RMS：麦克风读数天然很小（说话 ~0.02-0.15），线性乘以系数要么几乎不动、
      // 要么一下就顶满；按 -60dB..0dB 映射到 0..1，说话/喊/静音三档才分得开（与真实调音表一致）。
      const db = 20 * Math.log10(Math.max(rms, 1e-6));
      const target = Math.min(1, Math.max(0, (db + 60) / 60));
      smoothed = smoothed + (target - smoothed) * smoothing;
      setLevel(smoothed);
      raf = requestAnimationFrame(tick);
    };

    const start = async () => {
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
    };
    void start();

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
      setLevel(0);
    };
  }, [active, smoothing]);

  return { level, error };
}
