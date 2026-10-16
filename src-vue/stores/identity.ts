import { defineStore } from "pinia";
import {
  errorText,
  identityEventConvergence,
  type IdentityPhase,
  type IdentitySnapshot,
  type InstallationStatus,
} from "../../src/identity/types";

/**
 * 身份门禁的 Vue 投影 —— 与 `src/identity/useIdentity.ts` **同一套判定**。
 *
 * 三条硬约束照搬（§10 / §11 / §24 / §26）：
 *   1. 不落任何凭据：localStorage 里一个身份字段都不写；重启恢复只走 identity/restore。
 *   2. 只有一份投影：组件读这个 store，不自己解析命令结果。
 *   3. 错误只认 code：一律 errorText(code, detail)，不解析文本。
 *
 * 这里持的不是"身份状态"，而是**主进程权威的投影 + 命令派发**：
 * 没有任何一处 loggedIn 布尔量，门禁四态由 phase 单一表达。
 */
type IdentityResult = {
  ok?: boolean;
  error?: string;
  detail?: string;
  snapshot?: IdentitySnapshot;
  installation?: InstallationStatus;
  initialized?: boolean;
  initStatus?: string;
  userCount?: number;
  [k: string]: unknown;
};

const EMPTY: IdentitySnapshot = {
  userId: null,
  displayName: null,
  identifier: null,
  role: null,
  status: null,
  teamId: null,
  avatarRef: null,
  sessionRef: null,
  sessionId: null,
  createdAt: null,
  lastSeenAt: null,
  expiresAt: null,
  locked: false,
  installationId: null,
  initialized: false,
};

/** 启动询问失败 → 一句人话（与 useIdentity.ts:54-58 逐字一致）。 */
function bootFailureText(result: IdentityResult): string {
  if (result.error === "BOOT_FAILED")
    return result.detail ? String(result.detail) : "身份服务启动失败，本机身份暂时无法使用。";
  return errorText(result.error, result.detail) || "身份服务启动失败，本机身份暂时无法使用。";
}

const bridgeOf = () => (typeof window !== "undefined" ? window.openarc?.identity : undefined);

export const useIdentityStore = defineStore("identity", {
  state: () => ({
    /** 有桥 = 先 "checking"，恢复结果出来之前绝不画桌面（§39 禁止闪现）。 */
    phase: (bridgeOf() ? "checking" : "unavailable") as IdentityPhase,
    snapshot: { ...EMPTY } as IdentitySnapshot,
    installation: null as InstallationStatus | null,
    error: null as { code: string; detail?: string } | null,
    busy: false,
    bootError: null as string | null,
    /** 每次 boot 一个序号：重试打断上一次，旧结果一律丢弃。 */
    bootSeq: 0,
  }),
  getters: {
    available: () => !!bridgeOf(),
  },
  actions: {
    async send(command: Record<string, unknown>): Promise<IdentityResult> {
      const bridge = bridgeOf();
      if (!bridge) return { ok: false, error: "INVALID_INPUT", detail: "no-identity-bridge" };
      const res = (await bridge.command(command)) as IdentityResult;
      return res || { ok: false, error: "INTERNAL_ERROR" };
    },

    /**
     * 把命令结果折进本地投影。**唯一的**写入口。
     * 失败时只允许"降级或不动"：lock/unlock 的 fallback 是 ready，
     * 若失败一律落 fallback，"解锁输错口令"就会回到桌面（useIdentity.ts:98-113 的同一条纪律）。
     */
    absorb(res: IdentityResult, fallback: IdentityPhase): IdentityResult {
      if (res.snapshot) this.snapshot = res.snapshot;
      if (res.installation) this.installation = res.installation;
      if (res.ok === false) {
        this.error = {
          code: String(res.error || "INTERNAL_ERROR"),
          detail: res.detail ? String(res.detail) : undefined,
        };
        if (res.error === "NOT_INITIALIZED") this.phase = "uninitialized";
        else if (res.error === "LOCKED") this.phase = "locked";
        else if (["SESSION_EXPIRED", "SESSION_REVOKED", "USER_DISABLED"].includes(String(res.error)))
          this.phase = "unauthenticated";
        return res;
      }
      this.error = null;
      if (res.snapshot?.sessionRef) this.phase = res.snapshot.locked ? "locked" : "ready";
      else this.phase = fallback;
      return res;
    },

    async run(command: Record<string, unknown>, fallback: IdentityPhase): Promise<IdentityResult> {
      this.busy = true;
      try {
        const res = await this.send(command);
        this.absorb(res, fallback);
        return res;
      } finally {
        this.busy = false;
      }
    },

    /** 启动询问（§39）：status → restore；两步返回之前 phase 恒为 checking。 */
    async boot(): Promise<void> {
      if (!bridgeOf()) return;
      const seq = ++this.bootSeq;
      this.bootError = null;
      const timer = window.setTimeout(() => {
        if (seq === this.bootSeq)
          this.bootError = "本机身份确认超时：系统钥匙串可能在等待你的授权。授权后点「重试」。";
      }, 10000);
      try {
        const st = await this.send({ type: "identity/status" });
        if (seq !== this.bootSeq) return;
        // 身份服务没起来：不能继续落到登录页，更不能停在 BootSurface。
        if (!st.ok) {
          this.bootError = bootFailureText(st);
          return;
        }
        if (st.initialized === false) {
          this.installation = st.installation ?? null;
          this.phase = "uninitialized";
          return;
        }
        this.installation = st.installation ?? null;
        const restore = await this.send({ type: "identity/restore" });
        if (seq !== this.bootSeq) return;
        if (restore.ok && restore.snapshot) {
          this.snapshot = restore.snapshot;
          this.phase = restore.snapshot.locked ? "locked" : "ready";
        } else {
          this.snapshot = { ...EMPTY };
          this.phase = "unauthenticated";
        }
      } catch {
        if (seq === this.bootSeq) this.bootError = "身份服务没有响应，启动没有完成。可以点「重试」再试一次。";
      } finally {
        window.clearTimeout(timer);
      }
    },

    /** 超时后重来一次启动询问（不再停在空白启动态）。 */
    retry(): void {
      this.bootError = null;
      this.phase = "checking";
      void this.boot();
    },

    /**
     * 主进程推来的身份事件（§24）：登出 / 锁定 / 解锁 / 会话变更 / 自然到期。
     * 判定是纯函数 identityEventConvergence（与 React 用同一份），这里只写状态。
     */
    subscribe(): () => void {
      const bridge = bridgeOf();
      if (!bridge?.onEvent) return () => {};
      return bridge.onEvent((event) => {
        const snap = event.snapshot as IdentitySnapshot | undefined;
        if (snap) this.snapshot = snap;
        const intent = identityEventConvergence({ event: event.event, snapshot: snap });
        if (intent.clearSnapshot) this.snapshot = { ...EMPTY };
        if (intent.errorCode) {
          // 事件的 reason 是运维口径，不进用户文案：只发 code。
          this.absorb({ ok: false, error: intent.errorCode }, "unauthenticated");
          return;
        }
        if (intent.phase) this.phase = intent.phase;
      });
    },

    initialize(input: { identifier: string; password: string; displayName: string; avatarRef?: string }) {
      return this.run({ type: "identity/initialize", ...input }, "unauthenticated");
    },
    login(input: { identifier: string; password: string }) {
      return this.run({ type: "identity/login", ...input }, "unauthenticated");
    },
    logout() {
      return this.run({ type: "identity/logout" }, "unauthenticated");
    },
    lock() {
      return this.run({ type: "identity/lock" }, "locked");
    },
    unlock(password: string) {
      return this.run({ type: "identity/unlock", password }, "ready");
    },

    /**
     * 改资料（免密码，入口只在系统设置）：只把"确实改动过的字段"下发，
     * undefined = 不改（与 src/identity/useIdentity.ts:240 同义）。
     */
    updateProfile(input: { displayName?: string; avatarRef?: string }) {
      return this.run(
        { type: "identity/update-profile", ...input },
        this.phase === "locked" ? "locked" : "ready",
      );
    },
    /**
     * 改密码：命令面接好了（identity/change-password），但既有产品的系统设置页
     * 没有这个控件（appearanceBody 只到"个人资料"），因此本迁移不新增 UI，避免自创。
     */
    changePassword(currentPassword: string, newPassword: string) {
      return this.run({ type: "identity/change-password", currentPassword, newPassword }, "unauthenticated");
    },
  },
});
