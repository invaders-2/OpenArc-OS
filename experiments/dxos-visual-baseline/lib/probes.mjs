/** 五套 UI 探针清单 + --probe 选择（纯函数，便于单测）。 */

/** 顺序即运行顺序；dir 是既有探针目录，name 是 CLI 短名。 */
export const PROBES = Object.freeze([
  { name: "skills", label: "Skill 中心", dir: "dxos-ui-skills" },
  { name: "tasks", label: "任务 / Agent 控制台", dir: "dxos-ui-tasks" },
  { name: "org", label: "组织治理控制台", dir: "dxos-ui-org" },
  { name: "model", label: "模型接入控制台", dir: "dxos-ui-model" },
  { name: "mcp", label: "MCP 中心", dir: "dxos-ui-mcp" },
]);

/**
 * --probe=<name> 选择：短名（skills）或目录名（dxos-ui-skills）都认。
 * 未知名字返回结构化错误，绝不"什么都不跑还报绿"。
 */
export function resolveProbeSelection(probes, selector) {
  if (!selector) return { selected: probes.slice(), error: null };
  const selected = probes.filter((p) => p.name === selector || p.dir === selector);
  if (selected.length === 0) {
    return {
      selected: [],
      error: {
        code: "PROBE_UNKNOWN",
        message: "未知探针：" + selector,
        hint: "可选：" + probes.map((p) => p.name).join(" / ") + "（或目录名 " + probes.map((p) => p.dir).join(" / ") + "）",
      },
    };
  }
  return { selected, error: null };
}
