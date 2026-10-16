import { createApp } from "vue";
import { createPinia } from "pinia";
// 设计语言只有一份权威，Vue 侧不复制：
//   tokens.css   唯一的 token 层（颜色 / 材质 / 圆角 / 间距 / 时长 / 阴影 / 壳层层序）
//   styles.css   既有产品的组件层，本壳层用的 class 名与它一一对应
import "../src/design-system/tokens.css";
import "../src/design-system/primitives.css";
import "../src/design-system/page-states.css";
import "../src/styles.css";
import App from "./App.vue";
import { installDevLog } from "./devlog";

installDevLog();

createApp(App).use(createPinia()).mount("#app");
