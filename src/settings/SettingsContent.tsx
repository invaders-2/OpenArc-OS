/**
 * 系统设置分栏。
 *
 * 外壳严格沿用已确认的设计基线（fix/ui-window-chrome @ 50a3feb）：
 *   split / split-side / split-section / split-nav / split-main。
 * 「外观与交互」pane 的标题、副标题与控件顺序也按基线：
 *   外观 → 减少动态效果 → 材质 → 程序坞图标大小 → 桌面图标大小 →
 *   使用自绘光标 → 光标大小 → 壁纸 → 锁屏壁纸 → 个人资料。
 *
 * 外观正文（主题 / 动效 / 材质 / 壁纸 / 个人资料，状态都在 main.tsx）由
 * appearanceBody 注入，让这个文件只是一层布局，不持有产品状态。
 * 核心线新增的「模型 / AI」（D4-01）与「设备」（D3-03）是同级 pane，
 * 导航、标题层级与控件样式沿用同一套设计语言。
 *
 * 默认停在「外观与交互」：device-ui 探针依赖 [data-settings-active="appearance"]、
 * .settings-pane 文本与 .material-select 在设置打开时就在 DOM 里。
 * .settings-content / .settings-pane 仅作为探针钩子保留。
 */
import { useEffect, useState, type ReactNode } from "react";
import { Bot, Monitor, Sliders } from "lucide-react";
import { DevicePane } from "../device/DevicePane";
import { ModelSettings } from "./ModelSettings";

type Pane = "appearance" | "model" | "devices";

type SettingsContentProps = {
  /** 身份投影（D3-01）：DevicePane 用它决定是否出现 Super Admin 入口，
      但**它不是权限判据** —— 后端 DeviceService 才是（§51）。 */
  role: string | null;
  /** 「外观与交互」pane 的正文（标题与副标题之下）。由 main.tsx 组合进来。 */
  appearanceBody?: ReactNode;
  /** 每次 +1 = 外部请求（画布页的"打开 OpenArc 总 API 设置"）切到「模型 / AI」pane。 */
  paneRequest?: number;
};

const PANES: { id: Pane; label: string; icon: ReactNode }[] = [
  { id: "appearance", label: "外观与交互", icon: <Sliders size={16} /> },
  { id: "model", label: "模型 / AI", icon: <Bot size={16} /> },
  { id: "devices", label: "设备", icon: <Monitor size={16} /> },
];

const TITLES: Record<Pane, { title: string; subtitle: string }> = {
  appearance: { title: "外观与交互", subtitle: "整个工作空间，遵循你的习惯。" },
  model: { title: "模型 / AI", subtitle: "统一配置所有应用使用的模型服务。" },
  devices: { title: "设备", subtitle: "管理已授权的设备、配对凭据与设备审计。" },
};

export function SettingsContent({ role, appearanceBody, paneRequest = 0 }: SettingsContentProps) {
  const [pane, setPane] = useState<Pane>("appearance");

  // 外部请求（画布页的模型引导）落在模型 pane；用户之后手动切走不会被再拽回来。
  useEffect(() => { if (paneRequest) setPane("model"); }, [paneRequest]);

  return (
    <div className="split">
      <nav className="split-side" aria-label="设置分类">
        <div className="split-section">系统</div>
        {PANES.map((p) => (
          <button
            key={p.id}
            type="button"
            className="split-nav"
            data-settings-pane={p.id}
            aria-current={pane === p.id ? "true" : undefined}
            onClick={() => setPane(p.id)}
          >
            {p.icon} {p.label}
          </button>
        ))}
      </nav>

      <div className="split-main settings-content" data-settings-active={pane}>
        <div className="settings-pane">
          <h1>{TITLES[pane].title}</h1>
          <p className="subtitle">{TITLES[pane].subtitle}</p>
          {pane === "appearance" ? appearanceBody : null}
          {pane === "model" ? <ModelSettings role={role} /> : null}
          {pane === "devices" ? <DevicePane role={role} /> : null}
        </div>
      </div>
    </div>
  );
}
