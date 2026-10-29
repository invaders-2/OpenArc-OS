/**
 * 音频节点卡片。
 *   · 没在播：显示整段真实波形，已播部分高亮，竖线是播放指针；节点选中或播过之后，点 / 拖波形可跳转。
 *   · 播放中：波形变成实时频谱（左低频 → 右高频），跟着当前播放位置的低音 / 中音 / 高音起伏。
 *   · 底部：播放 / 暂停、可拖动的进度条（带指针）、当前时间 / 总时长。
 * 波形和频谱都从解码后的音频数据算（见 audioAnalysis.ts），不依赖播放地址能不能接 Web Audio。
 */
import { useEffect, useRef, useState } from "react";
import { formatClock, type GenOutput } from "../model";
import { decodeAudio, fakeSpectrum, peaks, spectrum, type Decoded } from "../audioAnalysis";
import { Icon } from "./Icon";
import { useAssetUrl } from "./useAsset";

const BAR_PX = 6; // 每根条（含间隔）大约占的宽度

/** 旧数据里的 bars（生成时给的粗略波形）重采样到 count 根 */
function resample(src: number[], count: number): number[] {
  if (!src.length) return Array.from({ length: count }, (_, i) => 0.2 + Math.abs(Math.sin(i * 0.5)) * 0.6);
  return Array.from({ length: count }, (_, i) => src[Math.min(src.length - 1, Math.floor((i / count) * src.length))]);
}

export function AudioBody({ out, sel }: { out: GenOutput; sel?: boolean }) {
  const url = useAssetUrl(out.url || "");
  const aref = useRef<HTMLAudioElement>(null);
  const cvs = useRef<HTMLCanvasElement>(null);
  const [dec, setDec] = useState<Decoded | null>(null);
  const [on, setOn] = useState(false);
  const [t, setT] = useState(0);
  const [mediaDur, setMediaDur] = useState(0);
  const dur = dec?.duration || mediaDur || Number(out.dur) || 0;
  const frac = dur ? Math.max(0, Math.min(1, t / dur)) : 0;

  useEffect(() => {
    let alive = true; setDec(null);
    decodeAudio(url).then((d) => { if (alive && d) setDec(d); });
    return () => { alive = false; };
  }, [url]);

  // 动画状态放在 ref 里，每帧直接画 canvas，不走 React 渲染
  const anim = useRef({ disp: [] as number[], overview: { count: 0, bars: [] as number[] }, fake0: 0, raf: 0, ink: "255,255,255", hi: "#fff", styleAt: 0 });
  const live = useRef({ on, t, frac, dec, dur, bars: out.bars || [] });
  live.current = { on, t, frac, dec, dur, bars: out.bars || [] };

  /** 当前播放时间：有 <audio> 读它，没有（演示数据）按开始时刻推算 */
  const now = () => {
    const a = aref.current; const L = live.current;
    if (a && url) return a.currentTime;
    return L.on ? (performance.now() - anim.current.fake0) / 1000 : L.t;
  };

  const draw = (): boolean => {
    const c = cvs.current; if (!c) return false;
    const A = anim.current; const L = live.current;
    const w = c.clientWidth, h = c.clientHeight; if (!w || !h) return false;
    const dpr = Math.min(3, (globalThis.devicePixelRatio || 1) * 1.5);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext("2d"); if (!g) return false;
    const stamp = performance.now();
    if (stamp - A.styleAt > 500) {
      const cs = getComputedStyle(c); A.ink = cs.getPropertyValue("--ink").trim() || A.ink; A.hi = cs.getPropertyValue("--hi").trim() || A.hi; A.styleAt = stamp;
    }
    const count = Math.max(16, Math.min(96, Math.floor(w / BAR_PX)));
    if (A.overview.count !== count || A.overview.bars.length !== count) {
      A.overview = { count, bars: L.dec ? peaks(L.dec, count) : resample(L.bars, count) };
    }
    const time = now();
    const target = L.on ? (L.dec ? spectrum(L.dec, time, count).bars : fakeSpectrum(time, count)) : A.overview.bars;
    if (A.disp.length !== count) A.disp = target.slice();
    let moving = false;
    for (let i = 0; i < count; i++) {
      const d = target[i] - A.disp[i];
      // 起得快、落得慢，像电平表；切换播放 / 暂停时平滑过渡
      A.disp[i] += d * (L.on ? (d > 0 ? 0.6 : 0.2) : 0.22);
      if (Math.abs(d) > 0.003) moving = true;
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const gap = 2; const bw = Math.max(1, (w - gap * (count - 1)) / count); const mid = h / 2;
    const playedFrac = L.dur ? Math.max(0, Math.min(1, time / L.dur)) : 0;
    for (let i = 0; i < count; i++) {
      const v = Math.max(0.03, Math.min(1, A.disp[i]));
      const bh = Math.max(2, v * h * 0.94);
      const x = i * (bw + gap);
      if (L.on) g.fillStyle = `rgba(${A.ink},${(0.45 + 0.55 * v).toFixed(3)})`;
      else g.fillStyle = (i + 0.5) / count <= playedFrac && (time > 0) ? A.hi : `rgba(${A.ink},.38)`;
      g.beginPath();
      if (g.roundRect) g.roundRect(x, mid - bh / 2, bw, bh, Math.min(2, bw / 2)); else g.rect(x, mid - bh / 2, bw, bh);
      g.fill();
    }
    // 暂停 / 停在中途：波形上画播放指针
    if (!L.on && time > 0 && L.dur) {
      const x = Math.round(playedFrac * w);
      g.fillStyle = A.hi; g.fillRect(Math.min(w - 1.5, Math.max(0, x - 0.75)), 0, 1.5, h);
    }
    return L.on || moving;
  };

  const loop = () => {
    const A = anim.current; cancelAnimationFrame(A.raf);
    const step = () => {
      const L = live.current;
      if (L.on) {
        const tm = now();
        if (!aref.current || !url) { if (L.dur && tm >= L.dur) { setOn(false); setT(0); } else setT(tm); }
        else setT(tm);
      }
      A.raf = draw() ? requestAnimationFrame(step) : 0;
    };
    A.raf = requestAnimationFrame(step);
  };

  // 状态变化（播放 / 暂停 / 解码完成 / 跳转）后重画；尺寸变化也重画
  useEffect(() => { anim.current.overview.count = 0; loop(); }, [dec, out.bars]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loop(); }, [on]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!on) loop(); }, [t]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const c = cvs.current; if (!c || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { anim.current.overview.count = 0; loop(); }); ro.observe(c);
    return () => { ro.disconnect(); cancelAnimationFrame(anim.current.raf); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = () => {
    const a = aref.current;
    if (!a || !url) {
      if (on) { setT(now()); setOn(false); }
      else { const start = t > 0 && t < dur ? t : 0; anim.current.fake0 = performance.now() - start * 1000; setOn(true); }
      return;
    }
    if (a.paused) { if (dur && a.currentTime >= dur - 0.05) a.currentTime = 0; void a.play().then(() => setOn(true)).catch(() => setOn(false)); }
    else { a.pause(); setT(a.currentTime); setOn(false); }
  };

  const seekTo = (f: number) => {
    if (!dur) return;
    const tm = Math.max(0, Math.min(dur, f * dur));
    const a = aref.current;
    if (a && url) a.currentTime = tm; else anim.current.fake0 = performance.now() - tm * 1000;
    setT(tm);
  };
  /** 按下 → 拖动跳转；el 是用来算位置的那条（波形或进度条） */
  const scrub = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !dur) return;
    e.stopPropagation(); e.preventDefault();
    const el = e.currentTarget; el.setPointerCapture?.(e.pointerId);
    const at = (x: number) => { const r = el.getBoundingClientRect(); seekTo((x - r.left) / Math.max(1, r.width)); };
    at(e.clientX);
    const move = (ev: PointerEvent) => at(ev.clientX);
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  };
  // 没选中、也没播过时，波形区按下仍是拖节点；选中或播过之后才拿来跳转
  const vizSeek = sel || on || t > 0;
  const top = dec ? Math.min(16000, dec.sampleRate / 2) : 16000;
  const lab = (hz: number) => Math.max(4, Math.min(96, (Math.log(hz / 40) / Math.log(top / 40)) * 100));

  return <div className="abody" data-audio-state={on ? "playing" : t > 0 ? "paused" : "idle"} data-audio-decoded={dec ? "1" : "0"}>
    {url ? <audio ref={aref} src={url} preload="metadata"
      onLoadedMetadata={(e) => { const d = e.currentTarget.duration; if (Number.isFinite(d)) setMediaDur(d); }}
      onPause={() => setOn(false)} onSeeked={(e) => { if (e.currentTarget.paused) setT(e.currentTarget.currentTime); }} onEnded={() => { setOn(false); setT(0); }} /> : null}
    <canvas ref={cvs} className={"aviz" + (vizSeek ? " seek" : "")} data-aviz onPointerDown={vizSeek ? scrub : undefined} />
    <div className={"aband" + (on ? " on" : "")} aria-hidden>
      <span style={{ left: lab(100) + "%" }}>低</span><span style={{ left: lab(1000) + "%" }}>中</span><span style={{ left: lab(8000) + "%" }}>高</span>
    </div>
    <div className="actl" onPointerDown={(e) => e.stopPropagation()}>
      <button className="p" data-act="play" title={on ? "暂停" : "播放"} onPointerDown={(e) => { e.stopPropagation(); toggle(); }}>
        {on ? <svg viewBox="0 0 24 24" className="i apause" aria-hidden><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg> : <Icon name="play" />}
      </button>
      <div className="atrack" data-atrack role="slider" aria-label="播放进度" aria-valuemin={0} aria-valuemax={Math.round(dur)} aria-valuenow={Math.round(t)} onPointerDown={scrub}>
        <span className="atrack-rail" /><span className="atrack-fill" style={{ width: frac * 100 + "%" }} /><span className="atrack-head" data-atrack-head style={{ left: frac * 100 + "%" }} />
      </div>
      <span className="atime tnum" data-atime>{formatClock(t)} / {formatClock(dur)}</span>
    </div>
  </div>;
}

