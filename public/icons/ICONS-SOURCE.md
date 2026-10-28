# 应用图标来源

除 `siri.png` 外，本目录图标均取自 **WhiteSur icon theme**（作者 Vince Liuice，GPL-3.0）：https://github.com/vinceliuice/WhiteSur-icon-theme
版本：提交 `73d8040`（2026-09-10）。SVG 原图按 256×256 渲染为 PNG，渲染命令统一为：

```
rsvg-convert -w 256 -h 256 <源 SVG> -o public/icons/<name>.png
```

许可证全文见 `LICENSE-WhiteSur.txt`。

`siri.png` 仍是从 macOS 提取的原图（WhiteSur 中没有对应图标），只用作 AI 圆球在“减少动态效果”下的静态帧，发布前需替换。

应用身份图标与 `src-vue/apps.ts` 的 APPS 注册表一一对应：**每个应用一个图标文件，任意两个应用不共用同一图标**（`tests/dxos-app-icons.test.mjs` 强制）。

| 文件 | WhiteSur 源文件 | 用于 |
|---|---|---|
| `apps.png` | `src/apps/scalable/view-app-grid.svg` | 应用中心、启动台 |
| `safari.png` | `src/apps/scalable/web-browser.svg` | 浏览器 |
| `finder.png` | `src/apps/scalable/file-manager.svg` | 访达 |
| `library.png` | `src/apps/scalable/gnome-books.svg` | 资源库（task-2 新增，与访达区分） |
| `folder.png` | `src/places/scalable/folder.svg` | 项目、桌面文件夹 |
| `freeform.png` | `src/apps/scalable/gnome-paint.svg` | AI Studio |
| `contacts.png` | `src/apps/scalable/addressbook.svg` | 组织（task-2 启用，与系统设置区分） |
| `settings.png` | `src/apps/scalable/preferences-system.svg` | 系统设置 |
| `shortcuts.png` | `src/apps/scalable/preferences-desktop-keyboard.svg` | Skill 中心 |
| `mcp.png` | `src/apps/scalable/gnome-connections.svg` | MCP 中心（task-2 新增，与第三方集成区分） |
| `sharing.png` | `src/apps/scalable/preferences-system-sharing.svg` | 第三方集成 |
| `protocols.png` | `src/apps/scalable/preferences-system-network-remote.svg` | 协议中心（task-2 换源：原 `gnome-connections` 与 MCP 中心同图） |
| `spotlight.png` | `src/apps/scalable/preferences-system-search.svg` | 全局搜索 |
| `trash.png` | `src/places/scalable/user-trash.svg` | 回收站（空） |
| `trash-full.png` | `src/places/scalable/user-trash-full.svg` | 回收站（有内容） |
| `messages.png` | `src/apps/scalable/polari.svg` | 对话 |
| `app-store.png` | `src/apps/scalable/softwarecenter.svg` | 应用市场 |
| `calendar.png` | `src/apps/scalable/calendar.svg` | 日历 |
| `weather.png` | `src/apps/scalable/indicator-weather.svg` | 天气 |
| `music.png` | `src/apps/scalable/gnome-music.svg` | 音乐 |
| `photos.png` | `src/apps/scalable/shotwell.svg` | 相册 |
| `text-editor.png` | `src/apps/scalable/text-editor.svg` | 文稿 |
| `terminal.png` | `src/apps/scalable/terminal.svg` | 开发者 |
| `clock.png` | `src/apps/scalable/preferences-system-time.svg` | 自动化 |
| `video.png` | `src/apps/scalable/pitivi.svg` | 视频剪辑 |
| `image-tag.png` | `src/apps/scalable/eog.svg` | 图片声明 |
| `drama.png` | `src/apps/scalable/flowblade.svg` | 短剧工坊 |
