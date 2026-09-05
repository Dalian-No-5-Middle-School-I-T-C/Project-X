// v2.5.1 上传管理器冒烟：mock remoteFetch 驱动三条核心路径
// ①全成功 ②断线暂停→恢复续传 ③重试耗尽→error→手动 retryFailed 补发 complete
import { createScannerUploadManager } from "../src/apps/answer-card/client/lib/scannerUploadManager";
import type { StartUploadInput } from "../src/apps/answer-card/client/lib/scannerUploadManager";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`断言失败: ${msg}`);
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const blob = () => new Blob(["fake-image-bytes"], { type: "image/jpeg" });

type Step = (url: string) => Response;
const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** 按 URL 后缀路由（/pages、/complete 是 /sessions 的子路径，前缀包含会产生歧义）+ 按调用次序出栈的脚本化 mock */
function makeRemoteMock(routes: Record<string, Step[]>) {
  const calls: string[] = [];
  const counters: Record<string, number> = {};
  const fn = async (url: string): Promise<Response> => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    if (!key) throw new Error("mock 未覆盖的 URL: " + url);
    const steps = routes[key];
    const i = counters[key] ?? 0;
    counters[key] = i + 1;
    const step = steps[Math.min(i, steps.length - 1)];
    return step(url);
  };
  return { fn: fn as unknown as (url: string, init?: RequestInit) => Promise<Response>, calls, counters, routes };
}

function baseInput(pages: number): StartUploadInput {
  return {
    kind: "import",
    cardId: "card_1",
    name: "冒烟",
    pages: Array.from({ length: pages }, (_, i) => ({
      pageNum: i + 1,
      side: "front" as const,
      getBlob: async () => blob(),
    })),
  };
}

function deps(overrides: Partial<Parameters<typeof createScannerUploadManager>[0]> = {}) {
  return {
    localFetch: async () => jsonRes({ status: "ok", studentId: { status: "ok", value: "82048" }, questions: [], subjectiveQuestions: [] }),
    isOnline: () => true,
    getServerKind: () => "online" as const,
    sleep: () => Promise.resolve(),
    timeoutSignal: () => new AbortController().signal,
    genId: (() => { let n = 0; return () => `job_${++n}`; })(),
    ...overrides,
  };
}

async function waitTerminal(
  mgr: ReturnType<typeof createScannerUploadManager>,
  id: string,
): Promise<{ status: string; uploaded: number; failedPages: number[]; message: string }> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const j = mgr.getState().jobs.find((x) => x.id === id);
    if (j && (j.status === "done" || j.status === "error")) {
      return { status: j.status, uploaded: j.uploaded, failedPages: j.failedPages, message: j.message };
    }
    if (Date.now() > deadline) throw new Error("等待任务终态超时");
    await sleepReal(5);
  }
}

async function main() {
  const SESSIONS = "/api/scanner/upload/sessions";
  const PAGES = "/pages";
  const COMPLETE = "/complete";

  // ── 场景 1：全成功（2 页）──
  {
    const mock = makeRemoteMock({
      [SESSIONS]: [() => jsonRes({ sessionId: "scan_a", uploadTokens: ["t1", "t2"] }, 201)],
      [PAGES]: [() => jsonRes({ ok: true }), () => jsonRes({ ok: true })],
      [COMPLETE]: [() => jsonRes({ ok: true })],
    });
    const mgr = createScannerUploadManager(deps({ remoteFetch: mock.fn }));
    const id = mgr.startUpload(baseInput(2));
    const r = await waitTerminal(mgr, id);
    assert(r.status === "done", `场景1: 应 done，实际 ${r.status} ${r.message}`);
    assert(r.uploaded === 2, "场景1: uploaded 应为 2");
    assert(mock.calls.some((u) => u.endsWith(COMPLETE)), "场景1: 应调 complete");
  }

  // ── 场景 2：断线暂停 → 恢复自动续传 ──
  {
    let online = true;
    let netFailNext = true;
    const mock = makeRemoteMock({
      [SESSIONS]: [() => jsonRes({ sessionId: "scan_b", uploadTokens: ["t1"] }, 201)],
      [PAGES]: [
        (url) => {
          if (netFailNext) {
            netFailNext = false;
            online = false;
            throw new TypeError("fetch failed");
          }
          return jsonRes({ ok: true });
        },
      ],
      [COMPLETE]: [() => jsonRes({ ok: true })],
    });
    const mgr = createScannerUploadManager(deps({
      remoteFetch: mock.fn,
      isOnline: () => online,
      getServerKind: () => online ? "online" : "offline",
    }));
    const id = mgr.startUpload(baseInput(1));
    const deadline = Date.now() + 3_000;
    for (;;) {
      const j = mgr.getState().jobs.find((x) => x.id === id);
      if (j?.status === "paused") break;
      if (Date.now() > deadline) throw new Error("场景2: 未进入 paused，当前=" + JSON.stringify(mgr.getState()));
      await sleepReal(5);
    }
    online = true;
    mgr.notifyNetworkChanged();
    const r = await waitTerminal(mgr, id);
    assert(r.status === "done", `场景2: 恢复后应 done，实际 ${r.status} ${r.message}`);
    assert(r.uploaded === 1, "场景2: uploaded 应为 1");
  }

  // ── 场景 3：配置类错误重试耗尽 → error（不发 complete）→ retryFailed 补发 ──
  {
    const mock = makeRemoteMock({
      [SESSIONS]: [() => jsonRes({ sessionId: "scan_c", uploadTokens: ["t1", "t2"] }, 201)],
      [PAGES]: [
        () => jsonRes({ ok: true }),
        () => jsonRes({ message: "无效的 upload token" }, 400),
      ],
      [COMPLETE]: [() => jsonRes({ ok: true })],
    });
    const mgr = createScannerUploadManager(deps({ remoteFetch: mock.fn }));
    const id = mgr.startUpload(baseInput(2));
    const r = await waitTerminal(mgr, id);
    assert(r.status === "error", `场景3: 应 error，实际 ${r.status}`);
    assert(r.failedPages.includes(2), "场景3: 失败页应含第 2 页");
    assert(!mock.calls.some((u) => u.endsWith(COMPLETE)), "场景3: 有失败页时不得调 complete");

    const callsBefore = mock.calls.length;
    mock.routes[PAGES].push(() => jsonRes({ ok: true }));
    mgr.retryFailed(id);
    const r2 = await waitTerminal(mgr, id);
    assert(r2.status === "done", `场景3: 重试后应 done，实际 ${r2.status} ${r2.message}`);
    const pageCalls = mock.calls.slice(callsBefore).filter((u) => u.includes(PAGES)).length;
    assert(pageCalls === 1, `场景3: 重试应只传失败 1 页，实际 ${pageCalls} 次`);
    assert(mock.calls.some((u) => u.endsWith(COMPLETE)), "场景3: 重试成功后应补发 complete");
  }

  // Duplex backs inherit only their paired successfully uploaded front.
  {
    const input = baseInput(2);
    input.pages[1].side = "back";
    const students: string[] = [];
    const mgr = createScannerUploadManager(deps({
      localFetch: async (_url, init) => jsonRes({ status: "partial",
        studentId: (init?.body as FormData).get("page") === "1"
          ? { status: "ok", value: "82048" } : { status: "missing", value: null },
        questions: [], subjectiveQuestions: [] }),
      remoteFetch: async (url, init) => {
        if (url.endsWith(SESSIONS)) return jsonRes({ sessionId: "duplex", uploadTokens: ["a", "b"] });
        if (url.endsWith(PAGES)) students.push(JSON.parse(String((init?.body as FormData).get("recognition"))).studentId.value);
        return jsonRes({ ok: true });
      },
    }));
    const result = await waitTerminal(mgr, mgr.startUpload(input));
    assert(result.status === "done" && students.join(",") === "82048,82048", "双面学号继承失败");
    const orphan = baseInput(1);
    orphan.pages[0].side = "back";
    const failed = await waitTerminal(mgr, mgr.startUpload(orphan));
    assert(failed.status === "error", "孤立背面不得继承上个任务的学号");
  }
  console.log("scanner-upload-manager-smoke: 全部通过");
}

void main();
