/**
 * 照片应用 · 外壳（对应 main.tsx 的 apps 数组项 id:"photos"）。
 *
 * 采用与「项目」应用同一个双视图 split 模式（.split / .split-side / .split-nav / .split-main，
 * 样式与窗口红绿灯让位规则都来自 src/styles.css，本应用不复制一套）：
 *   左栏 = 图库 / 图像工坊 两个子视图；右栏 = 对应视图内容。
 *
 * 为什么 tab 状态留在本组件而不是 main.tsx：main.tsx 的写入范围被限定为
 * 「apps 数组一项 + renderWindowContent 一个分支」，所以这里用组件内状态承载切换，
 * 渲染出的 DOM 与 aria-current 语义与 projects 应用的双视图完全一致。
 *
 * 三个桥都从 window 上按域取（window.openarc.<domain>.command）：
 *   · photos       —— 图库视图
 *   · photocraft   —— 图像工坊视图
 *   · appExchange  —— 两个视图的「发送 / 导入到画布」共用的目标与画布列表
 * 取桥用结构检查（domainBridge），不依赖 openarc-ipc.d.ts 的声明是否已合并。
 */
import { useState } from "react";
import { Image as ImageIcon, Wand2 } from "lucide-react";
import { ToastProvider } from "../design-system/primitives";
import type { PageStateKind } from "../design-system/page-states";
import { LibraryView } from "./LibraryView";
import { StudioView } from "./StudioView";
import { domainBridge } from "./photosLogic";
import type { PhotosPageStateKind } from "./photosLogic";
import "./photos.css";

/* 编译期断言：逻辑层返回的页面状态必须落在 PageState 已登记的 kind 集合内
   （logic 文件不能 import .tsx，否则 node:test 会被 JSX 卡住）。 */
type AssertAssignable<A extends B, B> = true;
type PhotosKindWithinPageState = AssertAssignable<PhotosPageStateKind, PageStateKind>;

export function PhotosApp() {
  return (
    <ToastProvider>
      <PhotosAppBody />
    </ToastProvider>
  );
}

function PhotosAppBody() {
  const [tab, setTab] = useState<"library" | "studio">("library");
  const host: unknown = typeof window === "undefined" ? null : window;
  const photos = domainBridge(host, "photos");
  const photocraft = domainBridge(host, "photocraft");
  const exchange = domainBridge(host, "appExchange");

  return (
    <div className="split" data-photos-app="1">
      <nav className="split-side" aria-label="照片子视图">
        <div className="split-section">照片</div>
        <button className="split-nav" aria-current={tab === "library"} onClick={() => setTab("library")}>
          <ImageIcon size={16} strokeWidth={1.25} /> 图库
        </button>
        <button className="split-nav" aria-current={tab === "studio"} onClick={() => setTab("studio")}>
          <Wand2 size={16} strokeWidth={1.25} /> 图像工坊
        </button>
      </nav>
      <div className="split-main" data-photos-tab={tab}>
        <div className="photos-view">
          {tab === "library" ? <LibraryView photos={photos} exchange={exchange} /> : <StudioView photocraft={photocraft} exchange={exchange} />}
        </div>
      </div>
    </div>
  );
}
