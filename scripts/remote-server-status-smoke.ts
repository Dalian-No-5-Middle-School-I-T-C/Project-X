// v2.5.1 探活状态机冒烟：注入 fetchHealth + 手动时钟，验证四态翻转与快慢轮询节奏。
import { createServerStatusMonitor } from "../src/apps/answer-card/client/lib/remoteServerStatus";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`断言失败: ${msg}`);
}

const tick = () => new Promise<void>((r) => setImmediate(r));

interface PendingTimer {
  fn: () => void;
  at: number;
  cancelled: boolean;
}

function makeClock() {
  let now = 0;
  let pending: PendingTimer[] = [];
  const schedule = (fn: () => void, ms: number) => {
    const item: PendingTimer = { fn, at: now + ms, cancelled: false };
    pending.push(item);
    return () => {
      item.cancelled = true;
    };
  };
  const flush = async (advanceMs: number) => {
    now += advanceMs;
    const due = pending.filter((p) => !p.cancelled && p.at <= now);
    pending = pending.filter((p) => p.cancelled || p.at > now);
    for (const p of due) p.fn();
    await tick();
    await tick();
  };
  const nextDelay = () => {
    const live = pending.filter((p) => !p.cancelled);
    if (live.length === 0) return null;
    return Math.min(...live.map((p) => p.at)) - now;
  };
  const liveCount = () => pending.filter((p) => !p.cancelled).length;
  return { schedule, flush, nextDelay, liveCount, get now() { return now; } };
}

async function main() {
  // ── 场景 A：未配置地址 → unconfigured，不再加速 ──
  {
    const clock = makeClock();
    let probes = 0;
    const mon = createServerStatusMonitor({
      serverUrl: () => "",
      fetchHealth: async () => { probes += 1; return { ok: true, body: { ok: true } }; },
      schedule: clock.schedule,
    });
    mon.subscribe(() => undefined);
    await clock.flush(0);
    assert(mon.getState().kind === "unconfigured", "A: 未配置时应为 unconfigured");
    await clock.flush(20_000);
    await clock.flush(20_000);
    assert(probes === 3, `A: 20s 慢轮询应探活 3 次，实际 ${probes}`);
    mon.stop();
  }

  // ── 场景 B：online → offline → online，节奏 20s/5s 切换 ──
  {
    const clock = makeClock();
    let healthy = true;
    const mon = createServerStatusMonitor({
      serverUrl: () => "http://192.168.1.10:5174",
      fetchHealth: async () =>
        healthy
          ? { ok: true, body: { ok: true, capabilities: { scannerClientApi: true } } }
          : { ok: false, status: 503, body: null },
      schedule: clock.schedule,
    });
    mon.subscribe(() => undefined);
    await clock.flush(0);
    assert(mon.getState().kind === "online", "B: 初始应为 online");
    assert(clock.nextDelay() === 20_000, "B: 成功后应 20s 再探");

    healthy = false;
    await clock.flush(20_000);
    assert(mon.getState().kind === "offline", "B: 探活失败应转 offline");
    assert(clock.nextDelay() === 5_000, "B: 失败后应加速为 5s");

    healthy = true;
    await clock.flush(5_000);
    assert(mon.getState().kind === "online", "B: 恢复后应回 online");
    assert(mon.getState().serverUrl === "http://192.168.1.10:5174", "B: 快照应带服务器地址");
    mon.stop();
  }

  // ── 场景 C：在线但 capability 缺失 → api_disabled ──
  {
    const clock = makeClock();
    const mon = createServerStatusMonitor({
      serverUrl: () => "http://192.168.1.10:5174",
      fetchHealth: async () => ({ ok: true, body: { ok: true, capabilities: {} } }),
      schedule: clock.schedule,
    });
    mon.subscribe(() => undefined);
    await clock.flush(0);
    assert(mon.getState().kind === "api_disabled", "C: capability 缺失应为 api_disabled");
    mon.stop();
  }

  // ── 场景 D：fetchHealth 抛异常 → offline（5s 加速），非 Error 抛出 → 「网络异常」 ──
  {
    const clock = makeClock();
    let rejectNext = true;
    const mon = createServerStatusMonitor({
      serverUrl: () => "http://192.168.1.10:5174",
      fetchHealth: async () => {
        if (rejectNext) {
          rejectNext = false;
          throw "boom"; // 非 Error 抛出
        }
        return { ok: true, body: { ok: true, capabilities: { scannerClientApi: true } } };
      },
      schedule: clock.schedule,
    });
    mon.subscribe(() => undefined);
    await clock.flush(0);
    assert(mon.getState().kind === "offline", "D: 异常应转 offline");
    assert(mon.getState().detail === "网络异常", "D: 非 Error 抛出应为「网络异常」");
    assert(clock.nextDelay() === 5_000, "D: 失败后应加速为 5s");
    await clock.flush(5_000);
    assert(mon.getState().kind === "online", "D: 恢复后应回 online");
    mon.stop();
  }

  // ── 场景 E：探测进行中调用 refresh() 不得分叉轮询链（epoch 防重入）──
  // 用手动放行的 deferred 取代真实定时器，使「旧探测挂起期间 refresh」的交错完全确定。
  {
    const clock = makeClock();
    let probes = 0;
    let releaseFirst: (() => void) | null = null;
    const mon = createServerStatusMonitor({
      serverUrl: () => "http://192.168.1.10:5174",
      fetchHealth: async () => {
        probes += 1;
        if (probes === 1) {
          // 第一次探测挂起，直到测试显式放行
          await new Promise<void>((r) => { releaseFirst = r; });
        }
        return { ok: true, body: { ok: true, capabilities: { scannerClientApi: true } } };
      },
      schedule: clock.schedule,
    });
    mon.subscribe(() => undefined);
    await clock.flush(0);
    assert(probes === 1, "E: 首次探活应已在飞");
    assert(clock.liveCount() <= 1, `E-1: 挂起期至多 1 条定时器，实际 ${clock.liveCount()}`);

    mon.refresh(); // 关键时刻：旧探测仍在飞行中刷新
    assert(probes === 2, "E: refresh 应立即发起新探测");
    await clock.flush(0); // 排空微任务：新链完成并续排定时器
    assert(clock.liveCount() === 1, `E-2: refresh 后恰 1 条待触发定时器，实际 ${clock.liveCount()}`);
    assert(mon.getState().kind === "online", "E: 新探测应判定 online");

    releaseFirst?.(); // 放行被挂起的旧探测：其续排必须被 epoch 作废
    await clock.flush(0);
    assert(clock.liveCount() === 1, `E-3: 过期探测不得再排定时器，实际 ${clock.liveCount()}`);
    assert(probes === 2, "E: 过期探测不应引发额外探活");

    await clock.flush(20_000); // 唯一的存活链按 20s 节奏继续
    assert(probes === 3, `E: 应恰好推进到第 3 次探活，实际 ${probes}`);
    assert(clock.liveCount() === 1, `E-4: 续排后仍恰 1 条定时器，实际 ${clock.liveCount()}`);
    mon.stop();
    assert(clock.liveCount() === 0, `E-5: stop 后应无存活定时器，实际 ${clock.liveCount()}`);
  }

  console.log("remote-server-status-smoke: 全部通过");
}

void main();
