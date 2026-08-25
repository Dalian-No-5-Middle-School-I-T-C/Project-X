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
  return { schedule, flush, nextDelay, get now() { return now; } };
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

  console.log("remote-server-status-smoke: 全部通过");
}

void main();
