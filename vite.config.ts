import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import vue from "@vitejs/plugin-vue";
import { build as esbuild } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * 开发期 CSP：产品 index.html 的 CSP 很紧（script-src 'self' / connect-src 'none'），
 * 而 Vite dev 需要 React Refresh 的内联脚本 + HMR 的 WebSocket，两者都会被它拦掉。
 * 这里只在 `vite dev`（apply: "serve"）时替换那一条 meta；`vite build` 根本不执行本插件，
 * 所以 dist/index.html 的 CSP 逐字节不变。
 */
const DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: openarc-file:; media-src 'self' data: openarc-file:; " +
  "connect-src 'self' ws://127.0.0.1:*";

function devCsp(): Plugin {
  return {
    name: "openarc-dev-csp",
    apply: "serve",
    transformIndexHtml(html) {
      return html.replace(/content="default-src[^"]*"/, `content="${DEV_CSP}"`);
    },
  };
}

/**
 * 开发期 CJS：窗口领域已迁到原生 TS；目前只剩 CanvasHost 的 image-params.cjs。
 * `vite build` 走 Rollup commonjs；dev 只把这一个既有模块打成 ESM，不扩大特殊路径。
 */
function devCjs(): Plugin {
  return {
    name: "openarc-dev-cjs",
    apply: "serve",
    enforce: "pre",
    async load(id) {
      const file = id.replace(/\?.*$/, "");
      if (!file.endsWith("/electron/image-params.cjs")) return null;
      const result = await esbuild({
        entryPoints: [file],
        bundle: true,
        format: "esm",
        platform: "browser",
        target: "es2022",
        write: false,
        logLevel: "silent",
      });
      return result.outputFiles[0].text;
    },
  };
}

export default defineConfig(({ command }) => ({
  server: { watch: { ignored: ["**/artifacts/**", "**/.oa-browser/**"] } },
  base: "./",
  // React Refresh 只在 dev 需要（build 走 esbuild 的 JSX），因此 build 路径不挂 react()。
  // Vue 插件 build 路径也必须挂：vue.html 是一个真实入口，.vue SFC 只有它能编译。
  // 它只认 .vue，React 产物一个字节都不碰；其余只在 dev 需要的插件仍不参与 build。
  plugins: command === "serve" ? [devCsp(), devCjs(), vue(), react()] : [vue()],
  build: {
    rollupOptions: {
      // 三个入口：
      //   index.html            React 产品入口（OA_UI=react）
      //   design-system.html    设计系统回归面（内部验证用，打包时可排除）
      //   vue.html              默认 Vue 产品入口
      // 回归面必须是**真实构建产物**，探针才与 D1-04 的性能口径一致；
      // 复制一份 class 名出来测等于没测。
      input: {
        main: `${root}index.html`,
        "design-system": `${root}design-system.html`,
        vue: `${root}vue.html`,
      },
    },
  },
}));
