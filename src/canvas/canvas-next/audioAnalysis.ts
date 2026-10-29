/**
 * 音频节点的波形 / 频谱数据。
 *
 * 把音频整段解码成单声道采样（只做一次，按地址缓存），之后：
 *   · peaks()：整段波形的峰值，用来画静态波形和进度条；
 *   · spectrum()：任意时间点附近 2048 个采样做 FFT，按对数频率分组，得到低 → 高的能量条。
 * 频谱直接从解码数据算，不经过 <audio> 的 Web Audio 管线：播放地址换成流式（openarc-resource，
 * 不开 CORS）时 createMediaElementSource 只会拿到静音，而这里不受影响。
 */

export type Decoded = { samples: Float32Array; sampleRate: number; duration: number };

const MAX_CACHE = 8;
const cache = new Map<string, Promise<Decoded | null>>();

let ctxRef: BaseAudioContext | null = null;
function decoderCtx(): BaseAudioContext | null {
  if (ctxRef) return ctxRef;
  const W = globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext; AudioContext?: typeof AudioContext };
  try {
    // OfflineAudioContext 不占用音频设备，也不需要用户手势
    if (W.OfflineAudioContext) ctxRef = new W.OfflineAudioContext(1, 1, 44100);
    else if (W.AudioContext) ctxRef = new W.AudioContext();
  } catch { ctxRef = null; }
  return ctxRef;
}

/**
 * 读出音频字节。桌面版页面的 CSP 是 connect-src 'none'，fetch 连 data: 都读不了，
 * 所以资源库给的 data URL 直接在本地解 base64；其它地址（开发页的 http / blob）才用 fetch。
 */
async function readBytes(url: string): Promise<ArrayBuffer> {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(","); const meta = url.slice(5, comma); const body = url.slice(comma + 1);
    if (/;base64$/i.test(meta)) {
      const bin = atob(body); const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return u.buffer;
    }
    return new TextEncoder().encode(decodeURIComponent(body)).buffer as ArrayBuffer;
  }
  const res = await fetch(url); if (!res.ok) throw new Error("HTTP " + res.status);
  return res.arrayBuffer();
}

/** 解码一段音频；失败（地址读不到、格式不支持）返回 null，界面退回占位波形。 */
export function decodeAudio(url: string): Promise<Decoded | null> {
  if (!url) return Promise.resolve(null);
  const hit = cache.get(url);
  if (hit) { cache.delete(url); cache.set(url, hit); return hit; }
  const p = (async () => {
    const ctx = decoderCtx(); if (!ctx) return null;
    const buf = await ctx.decodeAudioData(await readBytes(url));
    const n = buf.length; const ch = buf.numberOfChannels;
    const samples = new Float32Array(n);
    for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) samples[i] += d[i] / ch; }
    return { samples, sampleRate: buf.sampleRate, duration: buf.duration } as Decoded;
  })().catch(() => null);
  p.then((r) => { if (!r) cache.delete(url); });
  cache.set(url, p);
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
  return p;
}

/** 整段波形峰值（0~1，按最大值归一），count 根柱 */
export function peaks(d: Decoded, count: number): number[] {
  const out: number[] = []; const n = d.samples.length; const step = n / count;
  let max = 0;
  for (let b = 0; b < count; b++) {
    const s = Math.floor(b * step), e = Math.min(n, Math.floor((b + 1) * step));
    // 长音频每段最多抽 4000 个采样，避免节点一多就卡
    const stride = Math.max(1, Math.floor((e - s) / 4000));
    let sum = 0, k = 0;
    for (let i = s; i < e; i += stride) { const v = d.samples[i]; sum += v * v; k++; }
    const rms = k ? Math.sqrt(sum / k) : 0;
    out.push(rms); if (rms > max) max = rms;
  }
  return out.map((v) => (max > 0 ? Math.max(0.04, v / max) : 0.04));
}

/* ---------- FFT ---------- */
const N = 2048;
const hann = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
const rev = new Uint32Array(N).map((_, i) => { let r = 0, x = i; for (let b = 1; b < N; b <<= 1) { r = (r << 1) | (x & 1); x >>= 1; } return r; });
const re = new Float32Array(N), im = new Float32Array(N);

function fft() {
  for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { const t = re[i]; re[i] = re[j]; re[j] = t; const u = im[i]; im[i] = im[j]; im[j] = u; } }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1; const ang = (-2 * Math.PI) / size;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let s = 0; s < N; s += size) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = s + k, b = a + half;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

export const SPEC_MIN_HZ = 40;
export const SPEC_MAX_HZ = 16000;

/**
 * time 秒附近的频谱：count 根条，从低频到高频（对数分组），每根 0~1。
 * 同时返回低（<250Hz）/ 中（250Hz~4kHz）/ 高（>4kHz）三段的平均能量。
 */
export function spectrum(d: Decoded, time: number, count: number): { bars: number[]; low: number; mid: number; high: number } {
  const c = Math.floor(time * d.sampleRate) - N / 2;
  for (let i = 0; i < N; i++) { const k = c + i; re[i] = k >= 0 && k < d.samples.length ? d.samples[k] * hann[i] : 0; im[i] = 0; }
  fft();
  const binHz = d.sampleRate / N; const top = Math.min(SPEC_MAX_HZ, d.sampleRate / 2);
  const ratio = top / SPEC_MIN_HZ;
  const bars: number[] = [];
  const band = { low: [0, 0], mid: [0, 0], high: [0, 0] };
  for (let b = 0; b < count; b++) {
    const f0 = SPEC_MIN_HZ * Math.pow(ratio, b / count), f1 = SPEC_MIN_HZ * Math.pow(ratio, (b + 1) / count);
    let i0 = Math.floor(f0 / binHz), i1 = Math.max(i0 + 1, Math.ceil(f1 / binHz));
    i0 = Math.max(1, i0); i1 = Math.min(N / 2, i1);
    let m = 0; for (let i = i0; i < i1; i++) { const v = Math.hypot(re[i], im[i]); if (v > m) m = v; }
    // 幅度 → dB（满幅正弦约 0dB），-72dB ~ -6dB 映射到 0~1
    // 再按每倍频程 +3dB 补偿：真实音乐高频能量天然偏弱，不补的话高音区总是一条平线
    const db = 20 * Math.log10(m / (N / 4) + 1e-9) + 3 * Math.log2(Math.sqrt(f0 * f1) / 1000);
    const v = Math.max(0, Math.min(1, (db + 72) / 66));
    bars.push(v);
    const mid = (f0 + f1) / 2; const k = mid < 250 ? band.low : mid < 4000 ? band.mid : band.high;
    k[0] += v; k[1]++;
  }
  const avg = (x: number[]) => (x[1] ? x[0] / x[1] : 0);
  return { bars, low: avg(band.low), mid: avg(band.mid), high: avg(band.high) };
}

/** 没有真实音频（演示数据 / 解码失败）时的假频谱：低频强、高频弱，随时间起伏 */
export function fakeSpectrum(time: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => {
    const x = i / count;
    const env = 0.85 - x * 0.55;
    const wob = 0.5 + 0.5 * Math.sin(time * (3 + x * 9) + i * 1.7) * Math.sin(time * 1.3 + i * 0.4);
    return Math.max(0.03, env * (0.35 + 0.65 * wob));
  });
}
