<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import { iconUrl } from "../apps";

/**
 * AI 球的**原生 Siri Blob**那一级（`src/desktop/SiriBlob.tsx` 的等价移植）。
 *
 * 为什么必须照搬这一级：球是本壳层里唯一"不是纯 CSS 能画出来"的材质。
 * 它只在真实宿主里成立（素材来自主进程白名单里的逻辑名 openarc-file://native/siri-blob），
 * 拿不到时退到静态帧 `./icons/siri.png`（与既有产品"减少动态效果"那一档同一张图）。
 *
 * 这一级不读 window.openarc、不走 IPC：只用**已有宿主资源 URL** 当视频源。
 * 在纯浏览器里它会 404，然后自动退到静态帧，不会白屏。
 */
const SRC = "openarc-file://native/siri-blob";
/** 静态兜底帧：走 iconUrl（动态绑定），避免 SFC 编译器把相对资源改写成组件目录下的路径。 */
const STATIC_FRAME = iconUrl("siri");
/** 减少动态效果时取的静态帧：0s 是纯黑，不能取（与既有实现同值）。 */
const STATIC_TIME = 8;
const LOAD_TIMEOUT = 8000;
const ZOOM = 1.45;
const KEY = 0.06;
const ALPHA_FLOOR = 0.35;
const SPHERE_CENTER_UV = { x: 122.55 / 256, y: (255 - 122.47) / 255 };
const SPHERE_RADIUS = 96;
const DISC_FEATHER = 2;
const DISC_RGB = [1 / 255, 5 / 255, 6 / 255];
const DISC_ALPHA = 0.8;
const KEEP_LO = 0.16;
const KEEP_HI = 0.3;

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
void main() {
  vec3 c = texture2D(uTex, vUv).rgb;
  float m = max(c.r, max(c.g, c.b));
  float t = clamp(m / ${KEY}, 0.0, 1.0);
  float a = t * t * (3.0 - 2.0 * t);
  vec3 keyed = c / max(a, ${ALPHA_FLOOR});
  vec2 p = (vUv - vec2(${SPHERE_CENTER_UV.x}, ${SPHERE_CENTER_UV.y})) * vec2(256.0, 255.0);
  float inside = 1.0 - smoothstep(${SPHERE_RADIUS}.0, ${SPHERE_RADIUS + DISC_FEATHER}.0, length(p));
  float bright = smoothstep(${KEEP_LO}, ${KEEP_HI}, m);
  float ka = a * max(inside, bright);
  float discA = ${DISC_ALPHA} * inside;
  float outA = max(ka, discA);
  vec3 outC = (keyed * ka + vec3(${DISC_RGB[0]}, ${DISC_RGB[1]}, ${DISC_RGB[2]}) * discA * (1.0 - ka)) / max(outA, 0.0001);
  gl_FragColor = vec4(outC, outA);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null;
}

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

const props = withDefaults(
  defineProps<{ size?: number; className?: string; animated?: boolean }>(),
  { size: 47, className: "", animated: true },
);

const video = ref<HTMLVideoElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
/** native → 原生视频球；static → 静态帧兜底。 */
const mode = ref<"native" | "static">("native");

let dispose: (() => void) | null = null;

function teardown() {
  if (dispose) dispose();
  dispose = null;
}

function mount() {
  teardown();
  if (mode.value !== "native") return;
  const v = video.value;
  const c = canvas.value;
  if (!v || !c) return;
  v.muted = true;
  const gl = c.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: false,
    antialias: false,
    depth: false,
    stencil: false,
  });
  if (!gl) {
    mode.value = "static";
    return;
  }
  const pipeline = createPipeline(gl);
  if (!pipeline) {
    mode.value = "static";
    return;
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const px = Math.max(2, Math.round(props.size * ZOOM * dpr));
  c.width = px;
  c.height = px;
  gl.viewport(0, 0, px, px);
  let raf = 0;
  let alive = true;
  let last = -1;
  let failed = false;

  const fail = () => {
    if (failed) return;
    failed = true;
    mode.value = "static";
  };

  const draw = () => {
    if (failed || v.readyState < 2 || !v.videoWidth) return;
    gl.bindTexture(gl.TEXTURE_2D, pipeline.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  const tick = () => {
    if (!alive) return;
    if (v.readyState >= 2 && v.currentTime !== last) {
      last = v.currentTime;
      draw();
    }
    raf = requestAnimationFrame(tick);
  };

  const onLoaded = () => window.clearTimeout(timer);
  const timer = window.setTimeout(() => {
    if (v.readyState < 2) fail();
  }, LOAD_TIMEOUT);
  v.addEventListener("error", fail);
  v.addEventListener("loadeddata", onLoaded);
  c.addEventListener("webglcontextlost", fail);

  let seek: (() => void) | null = null;
  if (props.animated) {
    void v.play().catch(fail);
    raf = requestAnimationFrame(tick);
  } else {
    v.pause();
    v.addEventListener("seeked", draw);
    v.addEventListener("loadeddata", draw);
    seek = () => {
      if (v.currentTime < 1) v.currentTime = STATIC_TIME;
    };
    if (v.readyState >= 1) seek();
    v.addEventListener("loadedmetadata", seek);
    v.addEventListener("loadeddata", seek);
    v.addEventListener("canplay", seek);
  }
  if (v.error) fail();

  dispose = () => {
    alive = false;
    cancelAnimationFrame(raf);
    window.clearTimeout(timer);
    v.removeEventListener("error", fail);
    v.removeEventListener("loadeddata", onLoaded);
    v.removeEventListener("seeked", draw);
    v.removeEventListener("loadeddata", draw);
    if (seek) {
      v.removeEventListener("loadedmetadata", seek);
      v.removeEventListener("loadeddata", seek);
      v.removeEventListener("canplay", seek);
    }
    c.removeEventListener("webglcontextlost", fail);
    gl.deleteTexture(pipeline.tex);
    gl.deleteProgram(pipeline.prog);
  };
}

onMounted(mount);
onBeforeUnmount(teardown);
watch(() => [props.size, props.animated, mode.value], () => mount());
</script>

<template>
  <span
    :class="'orb' + (mode === 'native' ? ' orb-native' : '') + (className ? ' ' + className : '')"
    :style="{ width: size + 'px', height: size + 'px' }"
    aria-hidden="true"
    draggable="false"
  >
    <span
      v-if="mode === 'native'"
      class="orb-siri"
      :style="{ width: size + 'px', height: size + 'px' }"
      aria-hidden="true"
    >
      <canvas ref="canvas" class="orb-siri-canvas"></canvas>
      <video
        ref="video"
        class="orb-siri-video"
        :src="SRC"
        crossorigin="anonymous"
        muted
        loop
        playsinline
        preload="auto"
        :autoplay="animated"
        tabindex="-1"
      ></video>
    </span>
    <img
      v-else
      class="orb-static"
      :src="STATIC_FRAME"
      alt=""
      :width="size"
      :height="size"
      draggable="false"
    />
  </span>
</template>
