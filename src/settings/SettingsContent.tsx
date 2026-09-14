/**
 * D3-03 · 系统设置分栏。
 *
 * 现有两栏（外观与交互 / 全局模型服务）的**控件与行为原样保留**，
 * 只是从"单页顺序排列"改成"左栏选择 + 右侧 pane"。
 * 新增「设备」pane 与它们同级，内容见 ../device/DevicePane.tsx。
 *
 * 默认停在「外观与交互」：experiments/d1-04 的材质路径依赖 .material-select
 * 在设置窗口打开时就在 DOM 里，不能把它藏到需要额外点击的 tab 后面。
 */
import { useState } from "react";
import { DevicePane } from "../device/DevicePane";
import { ModelSettings } from "./ModelSettings";

type GlassMode = "full" | "reduced" | "solid";
type Pane = "appearance" | "model" | "devices";

type SettingsContentProps = {
  dark: boolean;
  setDark: (v: boolean) => void;
  reduced: boolean;
  setReduced: (v: boolean) => void;
  glass: GlassMode;
  setGlass: (v: GlassMode) => void;
  endpoint: string;
  setEndpoint: (v: string) => void;
  model: string;
  setModel: (v: string) => void;
  /** 身份投影（D3-01）。渲染层用它决定是否出现 Super Admin 入口，
      但**它不是权限判据** —— 后端 DeviceService 才是（§51）。 */
  role: string | null;
};

export function SettingsContent({
  dark,
  setDark,
  reduced,
  setReduced,
  glass,
  setGlass,
  role,
}: SettingsContentProps) {
  const [pane, setPane] = useState<Pane>("appearance");

  const panes: { id: Pane; label: string }[] = [
    { id: "appearance", label: "外观与交互" },
    { id: "model", label: "模型 / AI" },
    { id: "devices", label: "设备" },
  ];

  return (
    <div className="settings-content">
      <div className="eyebrow">SYSTEM PREFERENCES</div>
      <h1>系统设置</h1>
      <p className="subtitle">整个工作空间，遵循你的习惯。</p>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分栏">
          {panes.map((p) => (
            <button
              key={p.id}
              type="button"
              data-settings-pane={p.id}
              aria-current={pane === p.id ? "true" : undefined}
              onClick={() => setPane(p.id)}
            >
              {p.label}
            </button>
          ))}
        </nav>

        <div className="settings-pane" data-settings-active={pane}>
          {pane === "appearance" ? (
            <>
              <h3>外观与交互</h3>
              {([
                ["深色外观", dark, setDark],
                ["减少动态效果", reduced, setReduced],
              ] as const).map(([label, value, set]) => (
                <label className="setting-row" key={label}>
                  <span>{label}</span>
                  <input type="checkbox" checked={value} onChange={(e) => (set as (v: boolean) => void)(e.target.checked)} />
                </label>
              ))}
              <label className="setting-row">
                <span>
                  材质
                  <span className="footnote"> 玻璃合成成本，与动效互不影响</span>
                </span>
                <select className="material-select" value={glass} onChange={(e) => setGlass(e.target.value as GlassMode)}>
                  <option value="full">完整玻璃</option>
                  <option value="reduced">降低材质</option>
                  <option value="solid">实色</option>
                </select>
              </label>
            </>
          ) : null}

          {pane === "model" ? <ModelSettings role={role} /> : null}

          {pane === "devices" ? <DevicePane role={role} /> : null}
        </div>
      </div>
    </div>
  );
}
