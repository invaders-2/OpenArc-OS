import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  base: "./",
  build: {
    rollupOptions: {
      // 两个入口：
      //   index.html            产品主界面
      //   design-system.html    设计系统回归面（内部验证用，打包时可排除）
      // 回归面必须是**真实构建产物**，探针才与 D1-04 的性能口径一致；
      // 复制一份 class 名出来测等于没测。
      input: {
        main: `${root}index.html`,
        "design-system": `${root}design-system.html`,
      },
    },
  },
});
