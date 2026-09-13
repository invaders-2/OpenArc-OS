/**
 * D3-03 · 设备管理 Pane（§49 §50 §51 §6 §48）。
 *
 * 三条本文件必须自己守住的口径：
 *
 *   §6  **状态不塌缩**。DEVICE_STATUS（PENDING / ACTIVE / DISABLED / REVOKED）与
 *       CONNECTIVITY（ONLINE / OFFLINE / UNKNOWN）是**两根轴**，必须分别显示：
 *       一台 ACTIVE 但 OFFLINE 的设备，展示为「已授权 ACTIVE」+「离线 OFFLINE」，
 *       绝不允许合并成一个 "Unavailable"。恢复路径不同，UI 就不能抹平。
 *
 *   §48 只画 bridge 返回的 publicDevice 字段。这里没有也不读取任何
 *       privateKey / certificate / pairing secret —— 唯一的例外是
 *       device/pairing.create 的**单次** secret，它只活在组件 state 里，
 *       关闭面板即丢弃，不落 localStorage、不写日志、不进审计。
 *
 *   §49/§51 管理动作（配对 / 禁用 / 启用 / 撤销 / 重命名）只在 Super Admin
 *       会话下出现；但**不靠隐藏按钮当安全边界** —— 任何命令的 ok:false
 *       都会在 data-device-error 里显示 reasonCode（后端才是权威）。
 *
 * 能力检测：浏览器预览里 window.openarc 不存在，此时显示
 * 「当前环境无法访问设备域」，**不伪造任何数据**。
 */
import { useCallback, useEffect, useState } from "react";
import { Badge, Button } from "../design-system/primitives";
import type { Tone } from "../design-system/primitives";
import { PageState } from "../design-system/page-states";

type DeviceBridge = {
  command: (cmd: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

/** §48 renderer 能拿到的全部字段（与 device-service #publicDevice 一一对应）。 */
export type PublicDevice = {
  deviceId: string;
  displayName: string;
  platform: string;
  architecture: string;
  status: string;
  connectivity: string;
  organizationId?: string;
  departmentId?: string | null;
  credentialVersion?: number;
  agentVersion?: string | null;
  registeredAt?: number | null;
  lastSeenAt?: number | null;
  certificateIdentity?: string | null;
};

type Pairing = {
  id: string;
  status: string;
  issuedAt?: number | null;
  expiresAt?: number | null;
  consumedAt?: number | null;
  issuedBy?: string | null;
};

type AuditItem = {
  at?: number | null;
  actor_user_id?: string | null;
  device_id?: string | null;
  event?: string | null;
  reason_code?: string | null;
};

type DeviceResult = {
  ok?: boolean;
  error?: string;
  items?: unknown;
  device?: unknown;
  pairing?: unknown;
  secret?: unknown;
  expiresAt?: unknown;
};

type ActionError = { code: string; context: string };

/**
 * 状态 → 文案 + 语义色。未知状态**照原样显示**，不映射到任何"统一不可用"，
 * 也不假装它是已知状态。
 */
const STATUS_META: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: "待激活 PENDING", tone: "neutral" },
  ACTIVE: { label: "已授权 ACTIVE", tone: "success" },
  DISABLED: { label: "已禁用 DISABLED", tone: "warning" },
  REVOKED: { label: "已撤销 REVOKED", tone: "danger" },
};

/** 连接状态独立成轴，永远与 DEVICE_STATUS 同时出现（§6）。 */
const CONNECTIVITY_META: Record<string, { label: string; tone: Tone }> = {
  ONLINE: { label: "在线 ONLINE", tone: "success" },
  OFFLINE: { label: "离线 OFFLINE", tone: "neutral" },
  UNKNOWN: { label: "连接未知 UNKNOWN", tone: "neutral" },
};

const PAIRING_STATUS_LABEL: Record<string, string> = {
  ISSUED: "未使用（单次有效）",
  CONSUMED: "已使用",
  EXPIRED: "已过期",
  REVOKED: "已撤销",
};

/**
 * reasonCode → 人话。**不是** UI 自己判定权限：这些只是后端拒绝后的解释文案。
 * 未登记的 code 走 fallback，把原始 code 原样显示出来（"未知 reasonCode 有提示"）。
 */
const REASON_LABEL: Record<string, string> = {
  NOT_SUPER_ADMIN: "当前账号不是 Super Admin",
  DEVICE_REVOKED: "设备已撤销，需要重新配对并换发新凭据",
  DEVICE_DISABLED: "设备已被禁用，管理员启用后可恢复",
  DEVICE_PENDING: "设备尚未激活",
  DEVICE_OFFLINE: "设备当前离线，等待网络恢复",
  INVALID_STATUS_TRANSITION: "当前状态下不允许该操作",
  PAIRING_TOKEN_EXPIRED: "配对码已过期",
  PAIRING_TOKEN_REVOKED: "配对码已撤销",
  PAIRING_TOKEN_ALREADY_USED: "配对码已被使用（单次有效）",
  PAIRING_TOKEN_UNKNOWN: "配对码不存在",
  NOT_FOUND_OR_FORBIDDEN: "设备不存在，或当前账号无权操作",
  SESSION_EXPIRED: "会话已过期，请重新登录",
  SESSION_REVOKED: "会话已失效，请重新登录",
};

const asArray = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

const timeText = (ts: number | null | undefined): string => {
  if (ts == null || !Number.isFinite(Number(ts))) return "—";
  return new Date(Number(ts)).toLocaleString("zh-CN", { hour12: false });
};

const countdownText = (expiresAt: number | null | undefined, now: number): string => {
  if (expiresAt == null || !Number.isFinite(Number(expiresAt))) return "—";
  const total = Math.max(0, Math.floor((Number(expiresAt) - now) / 1000));
  const s = total % 60;
  return Math.floor(total / 60) + ":" + String(s).padStart(2, "0");
};

export function DevicePane({ role }: { role: string | null }) {
  const bridge = typeof window !== "undefined" ? (window.openarc?.device as DeviceBridge | undefined) : undefined;
  const available = typeof bridge?.command === "function";
  const isSuperAdmin = role === "ADMIN";

  const [loading, setLoading] = useState(false);
  const [devices, setDevices] = useState<PublicDevice[]>([]);
  const [pairings, setPairings] = useState<Pairing[]>([]);
  const [audit, setAudit] = useState<AuditItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ActionError | null>(null);
  /** 单次 secret 的唯一落点：组件 state。关闭面板即消失（§47 §48）。 */
  const [secret, setSecret] = useState<{ pairingId: string; value: string; expiresAt: number | null } | null>(null);
  const [renaming, setRenaming] = useState<{ deviceId: string; value: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const h = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(h);
  }, []);

  const send = useCallback(
    async (command: Record<string, unknown>): Promise<DeviceResult> => {
      if (!bridge?.command) return { ok: false, error: "INTERNAL_ERROR" };
      try {
        const res = (await bridge.command(command)) as DeviceResult | null;
        return res && typeof res === "object" ? res : { ok: false, error: "INTERNAL_ERROR" };
      } catch {
        // 桥异常与后端异常一样，收敛成可见的 reasonCode，不允许"点了没反应"。
        return { ok: false, error: "INTERNAL_ERROR" };
      }
    },
    [bridge],
  );

  const loadDevices = useCallback(async () => {
    const res = await send({ type: "device/list" });
    if (res.ok) {
      setDevices(asArray<PublicDevice>(res.items));
      return true;
    }
    setError({ code: String(res.error || "INTERNAL_ERROR"), context: "读取设备列表" });
    return false;
  }, [send]);

  const loadPairings = useCallback(async () => {
    const res = await send({ type: "device/pairing.list" });
    if (res.ok) {
      setPairings(asArray<Pairing>(res.items));
      return true;
    }
    setError({ code: String(res.error || "INTERNAL_ERROR"), context: "读取配对凭据" });
    return false;
  }, [send]);

  const loadAudit = useCallback(async () => {
    const res = await send({ type: "device/audit" });
    if (res.ok) {
      setAudit(asArray<AuditItem>(res.items));
      return true;
    }
    setError({ code: String(res.error || "INTERNAL_ERROR"), context: "读取设备审计" });
    return false;
  }, [send]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    await loadDevices();
    await loadPairings();
    if (isSuperAdmin) await loadAudit();
    setLoading(false);
  }, [loadDevices, loadPairings, loadAudit, isSuperAdmin]);

  useEffect(() => {
    if (!available) return;
    void refresh();
    // 只在挂载时拉一次；后续由动作成功后显式 refresh。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available]);

  if (!available) {
    return (
      <div className="device-pane" data-device-pane="devices" data-device-available="false">
        <PageState
          kind="unavailable"
          title="当前环境无法访问设备域"
          description="只有在 OpenArc 桌面应用（Electron）里才会加载设备桥。这里不展示任何模拟设备。"
        />
      </div>
    );
  }

  const runAction = async (key: string, command: Record<string, unknown>, context: string) => {
    setBusy(key);
    setError(null);
    const res = await send(command);
    setBusy(null);
    if (!res.ok) {
      setError({ code: String(res.error || "INTERNAL_ERROR"), context });
      return null;
    }
    await refresh();
    return res;
  };

  const startPairing = async () => {
    setBusy("pair");
    setError(null);
    const res = await send({ type: "device/pairing.create" });
    setBusy(null);
    const pairing = (res.pairing as Pairing | undefined) || undefined;
    if (!res.ok || !pairing || typeof res.secret !== "string" || !res.secret) {
      setError({ code: String(res.error || "INTERNAL_ERROR"), context: "开始配对" });
      return;
    }
    setSecret({ pairingId: pairing.id, value: res.secret, expiresAt: pairing.expiresAt ?? null });
    await refresh();
  };

  const revokePairing = async (pairingId: string) => {
    const res = await runAction("pairing:" + pairingId, { type: "device/pairing.revoke", pairingId }, "撤销配对");
    if (res && secret?.pairingId === pairingId) setSecret(null);
  };

  const submitRename = async () => {
    if (!renaming) return;
    // 刻意把用户输入**原样**下发：空名称由后端以 INVALID_INPUT 拒绝，
    // 前端不自己当权威，也正好让未知 reasonCode 走到可见回退分支（§51）。
    const res = await runAction(
      "rename:" + renaming.deviceId,
      { type: "device/rename", deviceId: renaming.deviceId, displayName: renaming.value },
      "重命名设备",
    );
    if (res) setRenaming(null);
  };

  const pairingStatusOf = (p: Pairing): string => {
    if (p.status === "ISSUED" && p.expiresAt != null && now >= Number(p.expiresAt)) return "EXPIRED";
    return p.status;
  };

  const failureText = error ? REASON_LABEL[error.code] || "设备操作失败" : "";

  return (
    <div className="device-pane" data-device-pane="devices" data-device-available="true" data-device-role={isSuperAdmin ? "ADMIN" : "MEMBER"}>
      {error ? (
        <p className="device-error" role="alert" data-device-error data-device-reason={error.code}>
          {error.context}未完成：{failureText}（{error.code}）
        </p>
      ) : null}

      {!isSuperAdmin ? (
        <p className="device-note" data-device-role-note>
          当前账号不是 Super Admin：设备管理入口不可用，后端也会拒绝这些操作。
        </p>
      ) : null}

      {/* ── 配对（§15–§19、§49）────────────────────────────────────────── */}
      <section className="device-section" aria-label="设备配对">
        <div className="device-section-head">
          <h3>配对</h3>
          {isSuperAdmin ? (
            <Button
              variant="secondary"
              size="sm"
              data-device-action="pair"
              status={busy === "pair" ? "loading" : "idle"}
              onClick={() => void startPairing()}
            >
              开始配对
            </Button>
          ) : null}
        </div>

        {secret ? (
          <div className="device-pairing-secret" data-device-pairing-panel>
            <p className="device-note">加入码只显示这一次，关闭后无法再查看。</p>
            <code className="device-secret" data-device-pairing-secret>
              {secret.value}
            </code>
            <p className="device-meta" data-device-pairing-expires>
              剩余 {countdownText(secret.expiresAt, now)} · 到期 {timeText(secret.expiresAt)}
            </p>
          </div>
        ) : null}

        <div className="device-pairing-list" data-device-pairings>
          {pairings.length ? (
            pairings.map((p) => {
              const status = pairingStatusOf(p);
              return (
                <div className="device-pairing-row" key={p.id} data-device-pairing={p.id} data-device-pairing-status={status} data-device-pairing-single="true">
                  <span className="device-meta">配对 {p.id.slice(0, 12)}…</span>
                  <Badge tone={status === "ISSUED" ? "neutral" : status === "REVOKED" || status === "EXPIRED" ? "warning" : "neutral"}>
                    {PAIRING_STATUS_LABEL[status] || status}
                  </Badge>
                  <span className="device-meta" data-device-pairing-expiry>
                    到期 {timeText(p.expiresAt)}
                    {status === "ISSUED" ? " · 剩余 " + countdownText(p.expiresAt, now) : ""}
                  </span>
                  {isSuperAdmin && status === "ISSUED" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      data-device-pairing-revoke={p.id}
                      disabled={busy === "pairing:" + p.id}
                      onClick={() => void revokePairing(p.id)}
                    >
                      撤销
                    </Button>
                  ) : null}
                </div>
              );
            })
          ) : (
            <p className="device-meta">没有待使用的配对凭据。</p>
          )}
        </div>
      </section>

      {/* ── 设备列表（§6、§48）──────────────────────────────────────────── */}
      <section className="device-section" aria-label="设备列表">
        <div className="device-section-head">
          <h3>设备</h3>
          <Button variant="ghost" size="sm" data-device-action="refresh" status={loading ? "loading" : "idle"} onClick={() => void refresh()}>
            刷新
          </Button>
        </div>

        {loading && !devices.length ? <p className="device-meta">正在读取设备…</p> : null}
        {!loading && !devices.length && !error ? (
          <PageState kind="empty" title="还没有设备" description="使用「开始配对」生成加入码，在目标设备上注册。" />
        ) : null}

        <div className="device-list" data-device-list>
          {devices.map((d) => {
            const statusMeta = STATUS_META[d.status] || { label: d.status + "（未知状态）", tone: "neutral" as Tone };
            const connMeta = CONNECTIVITY_META[d.connectivity] || { label: d.connectivity + "（未知连接）", tone: "neutral" as Tone };
            return (
              <article className="device-row" key={d.deviceId} data-device-id={d.deviceId} data-device-name={d.displayName} data-device-status={d.status} data-device-connectivity={d.connectivity}>
                <div className="device-row__main">
                  <strong data-device-display-name>{d.displayName}</strong>
                  <span className="device-meta" data-device-platform>
                    {d.platform} · {d.architecture}
                  </span>
                  <span className="device-meta" data-device-last-seen>
                    最近在线 {timeText(d.lastSeenAt)}
                  </span>
                  <span className="device-meta" data-device-credential-version>
                    凭据 v{Number.isFinite(Number(d.credentialVersion)) ? d.credentialVersion : 0}
                  </span>
                </div>
                <div className="device-row__badges">
                  <span data-device-status-badge>
                    <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
                  </span>
                  <span data-device-connectivity-badge>
                    <Badge tone={connMeta.tone}>{connMeta.label}</Badge>
                  </span>
                </div>
                {isSuperAdmin ? (
                  <div className="device-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      data-device-action="rename"
                      data-device-id={d.deviceId}
                      onClick={() => setRenaming({ deviceId: d.deviceId, value: d.displayName })}
                    >
                      重命名
                    </Button>
                    {d.status === "ACTIVE" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        data-device-action="disable"
                        data-device-id={d.deviceId}
                        disabled={busy === "disable:" + d.deviceId}
                        onClick={() => void runAction("disable:" + d.deviceId, { type: "device/disable", deviceId: d.deviceId }, "禁用设备")}
                      >
                        禁用
                      </Button>
                    ) : null}
                    {d.status === "DISABLED" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        data-device-action="enable"
                        data-device-id={d.deviceId}
                        disabled={busy === "enable:" + d.deviceId}
                        onClick={() => void runAction("enable:" + d.deviceId, { type: "device/enable", deviceId: d.deviceId }, "启用设备")}
                      >
                        启用
                      </Button>
                    ) : null}
                    {d.status !== "REVOKED" ? (
                      <Button
                        variant="danger"
                        size="sm"
                        data-device-action="revoke"
                        data-device-id={d.deviceId}
                        disabled={busy === "revoke:" + d.deviceId}
                        onClick={() => void runAction("revoke:" + d.deviceId, { type: "device/revoke", deviceId: d.deviceId }, "撤销设备")}
                      >
                        撤销
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {renaming?.deviceId === d.deviceId ? (
                  <form
                    className="device-rename"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void submitRename();
                    }}
                  >
                    <input
                      className="device-rename-input"
                      data-device-rename-input
                      aria-label="设备名称"
                      value={renaming.value}
                      onChange={(e) => setRenaming({ deviceId: d.deviceId, value: e.target.value })}
                    />
                    <Button variant="secondary" size="sm" type="submit" data-device-rename-confirm>
                      保存
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setRenaming(null)}>
                      取消
                    </Button>
                  </form>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>

      {/* ── 审计（§46；只读展示 actor / event / reason / time）──────────── */}
      {isSuperAdmin ? (
        <section className="device-section" aria-label="设备审计">
          <div className="device-section-head">
            <h3>审计</h3>
          </div>
          <div className="device-audit" data-device-audit>
            {audit.length ? (
              audit.slice(-20).reverse().map((a, i) => (
                <div className="device-audit-row" key={String(a.at) + ":" + (a.event || "") + ":" + i}>
                  <span className="device-meta">{timeText(a.at)}</span>
                  <span data-device-audit-event>{a.event || "—"}</span>
                  <span className="device-meta">{a.reason_code || ""}</span>
                  <span className="device-meta">{a.actor_user_id || "—"}</span>
                </div>
              ))
            ) : (
              <p className="device-meta">暂无设备审计事件。</p>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
