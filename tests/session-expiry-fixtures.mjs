/**
 * D5-03 第四批 · 到期调度测试用的可控定时器接缝。
 *
 * 只替换 IdentityService 的 setTimeout / clearTimeout（产品走全局那一对），
 * 于是同一份调度代码可以在"手动到点"下被精确断言：
 *   · 任何时刻在途定时器 ≤ 1；
 *   · 已经出队、clearTimeout 拦不住的旧回调不得动新会话；
 *   · 从不使用 setInterval。
 */
export function fakeTimers() {
  let seq = 0;
  const inFlight = new Map();
  const history = [];
  const state = { setCalls: 0, clearCalls: 0, fired: 0, intervalCalls: 0, unrefCalls: 0, lastDelayMs: null };

  const api = {
    state,
    history,
    pending: () => inFlight.size,
    delays: () => [...inFlight.values()].map((j) => j.ms),
    /** 让挂起的 promise 链（事务队列 → emit）跑完。 */
    settle: async () => {
      for (let i = 0; i < 3; i += 1) await new Promise((r) => setImmediate(r));
    },
    /** 到点：按排程顺序触发当前在途的全部定时器，并等 promise 链收敛。 */
    async fire() {
      for (const [id, job] of [...inFlight.entries()]) {
        if (!inFlight.has(id)) continue;
        inFlight.delete(id);
        job.fired = true;
        state.fired += 1;
        await job.fn();
        await api.settle();
      }
      return state.fired;
    },
    /** 排程时被 clear 掉、但"已经出队"的旧回调 —— 真实竞态里 clearTimeout 拦不住它。 */
    cleared: () => history.filter((j) => j.cleared && !j.fired),
    setTimeout(fn, ms) {
      state.setCalls += 1;
      state.lastDelayMs = ms;
      const id = ++seq;
      const handle = { id, unref() { state.unrefCalls += 1; return handle; } };
      const job = { id, fn, ms, handle, fired: false, cleared: false };
      inFlight.set(id, job);
      history.push(job);
      return handle;
    },
    clearTimeout(handle) {
      state.clearCalls += 1;
      const id = handle && handle.id != null ? handle.id : handle;
      const job = inFlight.get(id);
      if (job) job.cleared = true;
      inFlight.delete(id);
    },
    setInterval() {
      state.intervalCalls += 1;
      throw new Error("到期调度禁止 setInterval");
    },
  };
  return api;
}
