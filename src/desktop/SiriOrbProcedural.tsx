/**
 * SiriOrbProcedural —— 程序化 Siri 球（WebGL 片元着色器）。
 *
 * ## 为什么有这颗球
 *
 * 系统原生的 Siri Blob 素材（见 SiriBlob.tsx）只在装了 SiriUI.framework 的 macOS 版本里存在。
 * 老系统上 `openarc-file://native/siri-blob` 直接 404，那条线路只能退到 orb-ui 那颗球 ——
 * 也就是用户说「不好看」的那颗。这颗程序化球就是那些机器上的**第二级**兜底：
 *
 *     native(SiriBlob) --失败--> procedural(本文件) --失败--> orb-ui(OrbUiFallback)
 *
 * ## 它只是近似，不是复刻
 *
 * 色系（青/蓝/绿/紫 + 红只作点缀）、暗玻璃球、白核与尖星芒、柔度、亮度分布都是对着 Apple 自己
 * 那 8 帧抠出来调的（球内近黑 0.3615 / 苹果 0.3264，径向亮度剖面 RMSE 0.0338）。但对不上的地方
 * 是**花瓣落在哪**：平均像素误差 13.8/255 与上一版打平，而且比原生明显更对称、更图形化。
 * 那是逐帧拟合 / 手写关键帧那一类工作，对兜底不值当 —— 所以它就是一颗像样的兜底球。
 *
 * ## 版权
 *
 * 本文件是原创实现。仓库里**不放** .frag / demo.html / 任何 Apple 参考帧或它们的 base64，
 * 着色器内联在下面，是仓库里唯一一份。绝不从主进程读任何 Apple 素材。
 *
 * ## 两个坑（都踩过，别再踩）
 *
 * 1. **`pow(负底, y)` 是 UB，ANGLE/Metal 上直接返回 NaN。** 一帧里只要有一个像素算出 NaN，
 *    整个球会变黑（只剩核心那一小块）。凡是有符号的量进 pow 之前必须 abs()；
 *    `pow(d * d, k)` 看着安全只是因为平方之后非负，换个写法就中招。
 * 2. **`exp(-max(r, 1.0) ...)` 这类写法要小心。** `exp(-max(rr - 1.0, 0.0) / k)` 在 rr < 1 时
 *    恒等于 1 —— 想写「球外那点溢出光」这么写，等于给整颗球加了一层底光，
 *    球内近黑比例会被它从 0.36 拉回 0.07（做球体那一版就是这么坏的）。球外的项必须
 *    显式夹到球外（这里用 smoothstep(0.995, 1.010, rr)）。
 *
 * 另外：动效全部在着色器里，逐帧只上传 5 个 uniform、发一次 drawArrays，没有逐帧分配、
 * 不做 CPU 侧逐像素运算、动画循环里不读布局；麦克风电平走 ref + 订阅，**不经过 React state**。
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, type CSSProperties } from "react";

/** 球半径占半帧的比例，和 Apple 那条素材一致（视频里球半径 = 半帧的 0.675）。 */
const BALL_FRACTION = 0.675;
/**
 * 超采样倍数，取 SiriBlob 的 ZOOM（1.45）同一个数。**注意它是 backing 倍数，不是放大倍数**：
 * SiriBlob 画布 backing = size × 1.45 × dpr，但 CSS 把画布缩回 size（`.orb-siri > canvas { width: 100% }`），
 * 所以 1.45 只是多出来的分辨率，球在槽位里的**显示**大小仍然是槽位半宽的 0.675。
 * 实测：原生那条 canvasBacking = 136×136 @47px/dsf2，球直径 ≈ 槽位的 0.675。
 * 这里照做（backing 136×136 也一样），球在槽位里的大小就和原生完全对齐了。
 */
const SUPERSAMPLE = 1.45;
/** 球半径倍数（相对槽位半宽的 0.675 基准）。1 = 和原生一样大。 */
const ZOOM = 1;
/** 减少动态效果时画的静态帧。取 8 是因为 0s 那帧太黑。 */
const STATIC_TIME = 8;
/** devicePixelRatio 上限：再高只是白烧填充率。 */
const MAX_DPR = 2;

/** 着色器源码。仓库里唯一一份，改这里。 */
const ORB_FRAG = `
precision highp float;

// ---------------------------------------------------------------------------
// SiriOrbProcedural - procedural Siri-orb fragment shader. Original work.
//
// Structure read off Apple's own frames (Siri Blob.mov):
//   * a dark glass sphere whose interior stays near black between the ribbons;
//   * 6 petal ribbons + 4 filament ribbons, the whole field normalised to unit
//     angular mean so the fitted radial law below is exactly the annulus-mean
//     light and acc/norm is the local contrast;
//   * a 5-armed star layer with a much slower radial decay: the pointed spikes
//     that are still clearly visible at dock size;
//   * a compact hot white core;
//   * a faint rim arc and almost no light outside the limb.
//
// Anti-aliasing is analytic, not derivative based: the angular footprint of one
// device pixel is (1/uBall)/r radians, so every ribbon width is clamped to at
// least AA_PX device pixels and every blob has its squared distance softened by
// the pixel footprint. That is what lets the petals stay pointed at 47 px.
// ---------------------------------------------------------------------------

uniform vec2  uRes;
uniform float uTime;
uniform float uLevel;
uniform float uBall;
uniform float uGain;

const float PI  = 3.141592653589793;
const float TAU = 6.283185307179586;
const float SQRT_PI = 1.772453850905516;

// --- tuning -----------------------------------------------------------------
const float AA_PX     = 1.35;   // minimum feature width, device pixels

// Radial law, fitted numerically (display-space RMSE) to the annulus-mean
// luminance of Apple's frames with the ribbon field normalised to unit angular
// mean: a dominant exponential decay plus a soft shoulder at the mid radius.
// r is in ball radii.
const float RAD_A1   = 150.0;
const float RAD_K1   = 12.00;
const float RAD_A2   = 12.0;
const float RAD_R2   = 0.300;
const float RAD_S2   = 0.080;
const float RAD_CUT0 = 0.790;
const float RAD_CUT1 = 0.862;

const float STAR_GAIN = 26.0;   // pointed star arms (per-arm decay lives in the loop)
const float STAR_K    = 6.20;
const float HOT       = 52.0;   // compact white core
const float HOT_SIG   = 0.100;
const float BLOB_GAIN = 1.60;   // detached coloured territories
const float EXPOSURE  = 0.88;
const float VIBRANCE  = 0.85;

const float FLOOR_AMB = 0.0075; // display-space interior sheen
const float LIMB_AMB  = 0.018;  // display-space soft limb sheen
const float RIM_AMP   = 0.078;  // display-space rim arc peak
const float RIM_SIG   = 0.042;
const float BLEED     = 0.020;

mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float hash11(float n){ return fract(sin(n * 127.1) * 43758.5453123); }

// Apple's ribbon family: red, magenta, violet, blue, cyan, spring, green.
vec3 ribbonColor(float h){
  vec3 c0 = vec3(1.00, 0.05, 0.08);
  vec3 c1 = vec3(1.00, 0.10, 0.55);
  vec3 c2 = vec3(0.55, 0.14, 1.00);
  vec3 c3 = vec3(0.06, 0.30, 1.00);
  vec3 c4 = vec3(0.04, 0.80, 1.00);
  vec3 c5 = vec3(0.10, 1.00, 0.55);
  vec3 c6 = vec3(0.22, 1.00, 0.18);
  float x = clamp(h, 0.0, 1.0) * 6.0;
  if (x < 1.0) return mix(c0, c1, x);
  if (x < 2.0) return mix(c1, c2, x - 1.0);
  if (x < 3.0) return mix(c2, c3, x - 2.0);
  if (x < 4.0) return mix(c3, c4, x - 3.0);
  if (x < 5.0) return mix(c4, c5, x - 4.0);
  return mix(c5, c6, x - 5.0);
}

vec3 toLinear(vec3 c){ return c * c; }

// Per-ribbon hue. Warm colours are deliberately scarce - Apple's orb is
// cyan/blue/green heavy with red only as an accent, never a rainbow.
float ribbonHue(float i){
  if (i < 1.0)  return 0.00;   // red
  if (i < 2.0)  return 0.16;   // magenta
  if (i < 3.0)  return 0.42;   // blue
  if (i < 4.0)  return 0.58;   // cyan
  if (i < 5.0)  return 0.74;   // spring
  if (i < 6.0)  return 0.90;   // green
  if (i < 7.0)  return 0.50;   // blue-cyan
  if (i < 8.0)  return 0.66;   // cyan
  if (i < 9.0)  return 0.82;   // spring-green
  return 0.36;                 // violet
}

// Soft flat-topped elliptical mass: axis along +dir, centre pushed out to dist.
// aa2 is the squared pixel footprint, so the edge never gets thinner than a pixel.
float blob(vec2 p, float dir, float dist, float hl, float hw, float sharp, float aa2){
  vec2 q = rot(-dir) * p;
  q.x -= dist;
  float d2 = (q.x * q.x) / (hl * hl) + (q.y * q.y) / (hw * hw) + aa2;
  return exp(-pow(d2, sharp));
}

float angDelta(float a, float b){ float d = a - b; return atan(sin(d), cos(d)); }

void main(){
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uBall;
  p.y = -p.y;

  // wall-clock is scaled so the orb visibly evolves within ~30 s; the
  // underlying periods stay incommensurate so it never visibly loops.
  float t     = uTime * 2.6;
  float level = clamp(uLevel, 0.0, 1.0);
  float rr    = length(p);
  float th    = atan(p.y, p.x);

  // angular size of one device pixel at this radius, in radians
  float pxA = AA_PX / (uBall * max(rr, 0.035));

  // ------------------------------------------------------ petals + filaments
  vec3  acc3 = vec3(0.0);
  float acc  = 0.0;
  float acc0 = 0.0;

  for (int i = 0; i < 10; i++){
    float fi = float(i);
    float broad = step(fi, 5.5);            // 6 petals, then 4 filaments
    float r1 = hash11(fi + 1.0);
    float r2 = hash11(fi + 7.3);
    float r3 = hash11(fi + 17.9);

    float base  = (broad > 0.5 ? fi * (TAU / 6.0) : 0.9 + (fi - 6.0) * (TAU / 4.0))
                + 1.30 * (r1 - 0.5);
    float twist = 2.30 * (r2 - 0.5) + 0.55 * sin(t * 0.057 + r3 * TAU);
    float rate  = 0.17 * sin(t * 0.041 + r1 * TAU) + 0.08 * sin(t * 0.083 + r2 * TAU);
    float wob   = 0.05 + 0.14 * r3;

    float dir = base + twist * rr + rate
              + wob * sin(2.4 * rr + t * 0.19 + r1 * TAU);

    float w    = mix(0.065 + 0.075 * r2,        // filament
                     0.200 + 0.260 * r2,        // petal
                     broad) * (0.62 + 0.38 * (1.0 - rr));
    w = max(w, pxA);                            // never thinner than a pixel

    float gain = mix(2.30 + 2.30 * r1, 0.55 + 0.75 * r1, broad)
               * (0.55 + 0.75 * pow(0.5 + 0.5 * sin(t * 0.069 + r3 * TAU), 1.6));

    float d  = angDelta(th, dir) / w;
    float g  = exp(-pow(d * d, mix(3.2, 2.5, broad))) * gain;
    if (i == 0) g *= 1.7;                       // red is an accent, not a wash

    acc  += g;
    acc0 += gain * w / (2.0 * SQRT_PI);         // angular mean of one gaussian
    acc3 += toLinear(ribbonColor(fract(ribbonHue(fi) + 0.035 * (r3 - 0.5) + 0.02 * sin(t * 0.023 + fi)))) * g;
  }

  // ------------------------------------------------------------------ star
  // A separate, brighter set of arms with a much slower radial decay: this is
  // what stays legible as a star at 47 px instead of dissolving into a marble.
  vec3  star3 = vec3(0.0);
  float starA = 0.0;
  for (int i = 0; i < 5; i++){
    float fi = float(i);
    float r1 = hash11(fi + 131.3);
    float r2 = hash11(fi + 151.7);
    float r3 = hash11(fi + 173.9);

    float dir = fi * (TAU / 5.0) + 0.70 + 0.95 * (r1 - 0.5)
              + 0.80 * sin(t * 0.083 + r1 * TAU)
              + 0.30 * sin(t * 0.037 + r2 * TAU);

    // a wedge rather than a stick: wide at the base, tapering outwards.
    // abs() before pow: pow() with a negative base is undefined in GLSL and
    // returns NaN on ANGLE/Metal, which poisons the entire frame.
    float w = max((0.045 + 0.055 * r2) * (2.20 - 1.40 * rr), pxA);
    float arm = exp(-(3.6 + 4.6 * r3) * rr);          // each arm its own length
    float g = exp(-pow(abs(angDelta(th, dir)) / w, 3.0))
            * (0.60 + 0.70 * r1) * arm
            * (0.45 + 0.90 * pow(0.5 + 0.5 * sin(t * 0.071 + r2 * TAU), 1.5));

    star3 += toLinear(ribbonColor(fract(ribbonHue(fi + 2.0) + 0.02 * (r2 - 0.5)))) * g;
    starA += g;
  }

  // ------------------------------------------- broad offset coloured masses
  // Radial spokes alone always read as a pinwheel; these detached, slowly
  // drifting patches are what give the orb its uneven coloured territories.
  vec3  blobC = vec3(0.0);
  float blobL = 0.0;
  for (int i = 0; i < 5; i++){
    float fi = float(i);
    float r1 = hash11(fi + 61.7);
    float r2 = hash11(fi + 83.3);
    float r3 = hash11(fi + 97.1);

    float dir  = fi * (TAU / 5.0) + 0.90 + 1.20 * (r1 - 0.5)
               + 0.70 * sin(t * 0.073 + r2 * TAU)
               + 0.30 * sin(t * 0.031 + r3 * TAU);
    float dist = 0.30 + 0.20 * r2 + 0.07 * sin(t * 0.097 + r1 * TAU);
    float hl   = 0.12 + 0.15 * r3 + 0.04 * sin(t * 0.131 + r2 * TAU);
    float hw   = hl * (0.70 + 0.50 * r1);
    float env  = 0.35 + 0.95 * pow(0.5 + 0.5 * sin(t * 0.059 + r3 * TAU), 1.8);

    float aa2 = 0.0625 * (1.0 / (uBall * uBall)) * (1.0 / (hl * hl) + 1.0 / (hw * hw));
    float a   = blob(p, dir, dist, hl, hw, 2.8, aa2) * env;
    vec3  c   = toLinear(ribbonColor(fract(ribbonHue(fi + 3.0) + 0.05 * (r2 - 0.5))));
    blobC += c * a;
    blobL += dot(c, vec3(0.2126, 0.7152, 0.0722)) * a;
  }

  // Normalise so the field's angular mean is exactly 1: the fitted radial law
  // is then the annulus-mean light and acc/norm is the local contrast.
  float angMask = smoothstep(0.010, 0.085, rr);
  float norm    = max(acc0, 1e-5);
  float field   = mix(1.0, acc / norm, angMask);
  vec3  fieldC  = mix(toLinear(vec3(0.88, 0.93, 1.00)), acc3 / norm, angMask);

  // ------------------------------------------------------- radial envelope
  float rad = (RAD_A1 * exp(-RAD_K1 * rr)
            + RAD_A2 * exp(-pow((rr - RAD_R2) / RAD_S2, 2.0)))
            * smoothstep(RAD_CUT1, RAD_CUT0, rr);

  // the arms live inside the glass too - they must not shoot past the limb
  float starRad = STAR_GAIN * smoothstep(0.90, 0.78, rr);
  float hot     = HOT * exp(-pow(rr / HOT_SIG, 2.0));

  vec3  light = fieldC * rad + blobC * BLOB_GAIN + star3 * starRad
              + toLinear(vec3(1.00, 0.985, 0.960)) * hot;
  float den   = field * rad + blobL * BLOB_GAIN + starA * starRad + hot * 0.8;

  // ------------------------------------------------------ light -> display
  vec3 col = light * EXPOSURE * uGain * (0.88 + 0.28 * level);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = max(mix(vec3(l), col, VIBRANCE), 0.0);
  col = col / (1.0 + col);
  col = pow(col, vec3(1.0 / 2.2));

  // ------------------------------------------------------------ glass ball
  float ball     = smoothstep(1.045, 0.90, rr);
  float limbBand = exp(-pow((rr - 0.950) / 0.075, 2.0));
  float rimMask  = exp(-pow((rr - 1.005) / RIM_SIG, 2.0));
  float rimArc   = 0.10 + 0.90 * pow(0.5 + 0.5 * cos(th - 2.15 + 0.55 * sin(t * 0.107)), 4.0);
  float dark     = smoothstep(1.6, 0.05, den);

  vec3 glass = vec3(0.92, 0.98, 1.20) * FLOOR_AMB * ball * dark
             + vec3(0.86, 0.94, 1.20) * LIMB_AMB * limbBand * dark
             + vec3(0.78, 0.86, 1.10) * rimMask * rimArc * RIM_AMP
             + vec3(0.80, 0.88, 1.10) * BLEED * smoothstep(0.995, 1.010, rr)
               * exp(-max(rr - 1.0, 0.0) / 0.022)
             - vec3(0.020, 0.024, 0.034) * exp(-pow((rr - 0.950) / 0.055, 2.0));

  col = max(col + glass, 0.0);

  float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col += (dither - 0.5) * (1.0 / 255.0);

  // 和原生素材一样按亮度抠黑：canvas 是方的，不抠的话浅色壁纸 / 浅色 dock 上会露出一个黑方块。
  // context 用 premultipliedAlpha: false，所以这里把颜色除回未预乘。
  float key = max(col.r, max(col.g, col.b));
  float alpha = clamp(key / 0.06, 0.0, 1.0);
  alpha = alpha * alpha * (3.0 - 2.0 * alpha);
  gl_FragColor = vec4(col / max(alpha, 0.0001), alpha);
}
`;

const ORB_VERT = "attribute vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }";

export interface SiriOrbHandle {
  /** 0..1 的语音电平。下一帧生效，**不触发任何 React 渲染**。 */
  setLevel(level: number): void;
  getLevel(): number;
  /** 立刻重画一帧；静态模式下改完电平用它。 */
  redraw(): void;
  readonly canvas: HTMLCanvasElement | null;
}

export interface SiriOrbProceduralProps {
  /** 槽位边长（CSS px）。dock 32~80，面板 ~82。 */
  size?: number;
  /** 初始语音电平 0..1；之后请走 ref 或 adapter，别用 prop 每帧刷。 */
  level?: number;
  /** false 只画一张静态帧（减少动态效果）。由调用方决定，和 SiriBlob 一致。 */
  animated?: boolean;
  /** 球半径倍数，默认 1（= 和原生那条一样大，占槽位半宽的 0.675）。 */
  zoom?: number;
  /** 曝光微调，1 = 对着参考帧调好的亮度。 */
  gain?: number;
  className?: string;
  style?: CSSProperties;
  /** WebGL 起不来 / 着色器编译失败时调用，交给上层退到 orb-ui。 */
  onError?: (error: unknown) => void;
}

interface GLState {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  buffer: WebGLBuffer;
  uRes: WebGLUniformLocation | null;
  uTime: WebGLUniformLocation | null;
  uLevel: WebGLUniformLocation | null;
  uBall: WebGLUniformLocation | null;
  uGain: WebGLUniformLocation | null;
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("SiriOrbProcedural: createShader failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error("SiriOrbProcedural: shader compile failed: " + log);
  }
  return shader;
}

function createGL(canvas: HTMLCanvasElement): GLState {
  // alpha + premultipliedAlpha: false —— 和 SiriBlob 一样，片元里抠黑、输出未预乘。
  const gl = (canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "high-performance",
  }) || canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
  if (!gl) throw new Error("SiriOrbProcedural: WebGL unavailable");

  const program = gl.createProgram();
  const buffer = gl.createBuffer();
  if (!program || !buffer) throw new Error("SiriOrbProcedural: could not allocate GL objects");

  const vert = compile(gl, gl.VERTEX_SHADER, ORB_VERT);
  const frag = compile(gl, gl.FRAGMENT_SHADER, ORB_FRAG);
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    gl.deleteBuffer(buffer);
    throw new Error("SiriOrbProcedural: program link failed: " + log);
  }
  gl.useProgram(program);

  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  // 一个盖住视口的三角形，不需要索引缓冲
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  return {
    gl,
    program,
    buffer,
    uRes: gl.getUniformLocation(program, "uRes"),
    uTime: gl.getUniformLocation(program, "uTime"),
    uLevel: gl.getUniformLocation(program, "uLevel"),
    uBall: gl.getUniformLocation(program, "uBall"),
    uGain: gl.getUniformLocation(program, "uGain"),
  };
}

function disposeGL(state: GLState): void {
  const { gl, program, buffer } = state;
  gl.deleteBuffer(buffer);
  gl.deleteProgram(program);
  const lose = gl.getExtension("WEBGL_lose_context");
  if (lose) lose.loseContext();
}

export const SiriOrbProcedural = forwardRef<SiriOrbHandle, SiriOrbProceduralProps>(
  function SiriOrbProcedural(
    { size = 47, level = 0, animated = true, zoom = ZOOM, gain = 1, className, style, onError },
    ref
  ) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const glRef = useRef<GLState | null>(null);
    const rafRef = useRef(0);
    const startRef = useRef(0);
    const timeRef = useRef(STATIC_TIME);

    /** 逐帧要用的可变输入。改电平只是写一个属性，不惊动 React。 */
    const inputRef = useRef({ level, zoom, gain, size });
    /**
     * level 是「初始值 + 命令式覆盖」：只有 prop 真的变了才回写。
     * 否则挂载时那次 effect 会把订阅刚推给 setLevel 的值盖回 prop 的旧值。
     */
    const propLevelRef = useRef(level);
    const onErrorRef = useRef(onError);
    onErrorRef.current = onError;

    const draw = useCallback(() => {
      const state = glRef.current;
      const canvas = canvasRef.current;
      if (!state || !canvas) return;
      const { gl } = state;
      const input = inputRef.current;
      const px = canvas.width;
      const ball = 0.5 * px * BALL_FRACTION * input.zoom;
      gl.viewport(0, 0, px, px);
      gl.uniform2f(state.uRes, px, px);
      gl.uniform1f(state.uTime, timeRef.current);
      gl.uniform1f(state.uLevel, input.level);
      gl.uniform1f(state.uBall, ball);
      gl.uniform1f(state.uGain, input.gain);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }, []);

    const resize = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const px = Math.max(2, Math.round(inputRef.current.size * SUPERSAMPLE * dpr));
      if (canvas.width !== px || canvas.height !== px) {
        canvas.width = px;
        canvas.height = px;
      }
    }, []);

    // GL 生命周期只跟挂载走：改尺寸不重建 context，和 SiriBlob 一致。
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      let state: GLState;
      try {
        state = createGL(canvas);
      } catch (error) {
        onErrorRef.current?.(error);
        return;
      }
      glRef.current = state;
      resize();

      const onLost = (event: Event) => {
        event.preventDefault();
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      };
      const onRestored = () => {
        try {
          disposeGL(state);
          state = createGL(canvas);
          glRef.current = state;
          resize();
          draw();
        } catch (error) {
          onErrorRef.current?.(error);
        }
      };
      canvas.addEventListener("webglcontextlost", onLost);
      canvas.addEventListener("webglcontextrestored", onRestored);
      return () => {
        canvas.removeEventListener("webglcontextlost", onLost);
        canvas.removeEventListener("webglcontextrestored", onRestored);
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
        disposeGL(state);
        glRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // prop 变化只折进那个可变袋子，不重启 GL。
    useEffect(() => {
      const input = inputRef.current;
      if (propLevelRef.current !== level) {
        propLevelRef.current = level;
        input.level = level;
      }
      input.zoom = zoom;
      input.gain = gain;
      if (input.size !== size) {
        input.size = size;
        resize();
      }
      if (!rafRef.current) draw();
    }, [level, zoom, gain, size, resize, draw]);

    useEffect(() => {
      if (!animated) {
        draw();
        return undefined;
      }
      if (!startRef.current) startRef.current = performance.now();
      const tick = () => {
        rafRef.current = requestAnimationFrame(tick);
        timeRef.current = (performance.now() - startRef.current) / 1000;
        draw();
      };
      rafRef.current = requestAnimationFrame(tick);
      return () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      };
    }, [animated, draw]);

    // 只有这里读 devicePixelRatio，动画循环里不碰布局。
    useEffect(() => {
      const onResize = () => {
        resize();
        if (!rafRef.current) draw();
      };
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }, [resize, draw]);

    /** 语音电平入口：命令式，不经过 state。 */
    const applyLevel = useCallback(
      (next: number) => {
        const clamped = next < 0 ? 0 : next > 1 ? 1 : next;
        inputRef.current.level = clamped;
        if (!rafRef.current) draw();
      },
      [draw]
    );

    useImperativeHandle(
      ref,
      () => ({
        setLevel: applyLevel,
        getLevel() {
          return inputRef.current.level;
        },
        redraw() {
          draw();
        },
        get canvas() {
          return canvasRef.current;
        },
      }),
      [applyLevel, draw]
    );

    return (
      <canvas
        ref={canvasRef}
        className={className}
        style={{ display: "block", width: size + "px", height: size + "px", ...style }}
        aria-hidden="true"
      />
    );
  }
);