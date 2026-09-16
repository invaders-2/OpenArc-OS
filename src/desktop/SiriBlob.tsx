import { useEffect, useRef } from "react";
import type { OrbAdapter } from "orb-ui";

/** 主进程白名单里的逻辑名；渲染进程报不出路径。 */
const SRC = "openarc-file://native/siri-blob";
/** 减少动态效果时取的静态帧：0s 是纯黑，不能取。 */
const STATIC_TIME = 8;
/** 本地文件读不出来时的兜底时限（ms）。 */
const LOAD_TIMEOUT = 8000;
/** 视频里球只占画面 ~62% 宽；把画布渲染大这么多再缩回槽位，等于裁掉黑边、球填满槽位。 */
const ZOOM = 1.45;
/** 亮度键控阈值：低于它的黑底完全透明。 */
const KEY = 0.06;

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/** 在 GPU 上按亮度抠黑：a = smoothstep(0, KEY, max(r,g,b))，颜色用未预乘的 rgb/a。 */
const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
void main() {
  vec3 c = texture2D(uTex, vUv).rgb;
  float m = max(c.r, max(c.g, c.b));
  float t = clamp(m / ${KEY}, 0.0, 1.0);
  float a = t * t * (3.0 - 2.0 * t);
  gl_FragColor = vec4(c / max(a, 0.0001), a);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null;
}

/** 装一次 WebGL 程序 + 全屏四边形 + 视频纹理。失败返回 null（交给上层退回 orb-ui）。 */
function createPipeline(gl: WebGLRenderingContext) {
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const pos = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.uniform1i(gl.getUniformLocation(prog, "uTex"), 0);
  gl.disable(gl.BLEND);
  return { prog, tex };
}

/**
 * Apple 原生 Siri Blob 球。素材是黑底视频，逐帧上传成 GPU 纹理后由片元着色器抠黑。
 *
 * 为什么不用 2D canvas + getImageData（实测过）：把硬件解码的视频 drawImage 进 CPU 画布
 * 每帧要 6~11ms 的回读，主线程直接超预算；抠黑本身只有 0.1ms。GPU 纹理上传没有回读。
 *
 * 为什么 <video> 必须留在 DOM 里：Chromium 对 display:none / 脱离文档的视频会挂起解码，
 * 画面就冻住；所以用 1px + 极低不透明度藏在画布下面，而不是拿掉它。
 * 失败（系统没有这个资源 / 解码不了 / 协议 404 / WebGL 起不来）时交给上层退回 orb-ui，绝不让球变空白。
 */
export function SiriBlob({
  size,
  adapter,
  animated = true,
  onError,
}: {
  size: number;
  adapter?: OrbAdapter;
  animated?: boolean;
  onError: () => void;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    video.muted = true;
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false, antialias: false, depth: false, stencil: false });
    if (!gl) {
      onErrorRef.current();
      return;
    }
    const pipeline = createPipeline(gl);
    if (!pipeline) {
      onErrorRef.current();
      return;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = Math.max(2, Math.round(size * ZOOM * dpr));
    canvas.width = px;
    canvas.height = px;
    gl.viewport(0, 0, px, px);
    let raf = 0;
    let alive = true;
    let last = -1;
    let failed = false;

    const fail = () => {
      if (failed) return;
      failed = true;
      onErrorRef.current();
    };

    const draw = () => {
      if (failed || video.readyState < 2 || !video.videoWidth) return;
      gl.bindTexture(gl.TEXTURE_2D, pipeline.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    const tick = () => {
      if (!alive) return;
      // 显示器可能是 120Hz，但视频源只有 60fps：用 currentTime 去重，别把同一帧传两遍。
      if (video.readyState >= 2 && video.currentTime !== last) {
        last = video.currentTime;
        draw();
      }
      raf = requestAnimationFrame(tick);
    };

    const onLoaded = () => window.clearTimeout(timer);
    const timer = window.setTimeout(() => {
      if (video.readyState < 2) fail();
    }, LOAD_TIMEOUT);
    video.addEventListener("error", fail);
    video.addEventListener("loadeddata", onLoaded);
    canvas.addEventListener("webglcontextlost", fail);

    let seek: (() => void) | null = null;
    if (animated) {
      void video.play().catch(fail);
      raf = requestAnimationFrame(tick);
    } else {
      video.pause();
      video.addEventListener("seeked", draw);
      video.addEventListener("loadeddata", draw);
      // 元数据/数据/可播三处都试一次：seekable 可能晚一拍才就绪，早设会被丢掉。
      seek = () => {
        if (video.currentTime < 1) video.currentTime = STATIC_TIME;
      };
      if (video.readyState >= 1) seek();
      video.addEventListener("loadedmetadata", seek);
      video.addEventListener("loadeddata", seek);
      video.addEventListener("canplay", seek);
    }
    if (video.error) fail();

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      video.removeEventListener("error", fail);
      video.removeEventListener("loadeddata", onLoaded);
      video.removeEventListener("seeked", draw);
      video.removeEventListener("loadeddata", draw);
      if (seek) {
        video.removeEventListener("loadedmetadata", seek);
        video.removeEventListener("loadeddata", seek);
        video.removeEventListener("canplay", seek);
      }
      canvas.removeEventListener("webglcontextlost", fail);
      gl.deleteTexture(pipeline.tex);
      gl.deleteProgram(pipeline.prog);
    };
  }, [size, animated]);

  /** 麦克风电平只改 DOM 样式，不进 state —— 每帧 setState 会把 AI 面板整块玻璃重渲染。 */
  useEffect(() => {
    if (!adapter) return;
    return adapter.subscribe((signal) => {
      const level = Math.max(0, Math.min(1, signal.inputVolume ?? 0));
      const el = rootRef.current;
      if (!el) return;
      el.style.transform = `scale(${1 + level * 0.08})`;
      el.style.filter = `brightness(${1 + level * 0.7})`;
    });
  }, [adapter]);

  return (
    <span className="orb-siri" ref={rootRef} style={{ width: size, height: size }} aria-hidden="true">
      <canvas className="orb-siri-canvas" ref={canvasRef} />
      <video
        className="orb-siri-video"
        ref={videoRef}
        src={SRC}
        crossOrigin="anonymous"
        muted
        loop
        playsInline
        preload="auto"
        autoPlay={animated}
        tabIndex={-1}
      />
    </span>
  );
}
