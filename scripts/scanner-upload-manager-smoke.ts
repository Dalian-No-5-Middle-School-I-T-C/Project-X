// v2.5.1 上传管理器冒烟：mock remoteFetch 驱动三条核心路径
// ①全成功 ②断线暂停→恢复续传 ③重试耗尽→error→手动 retryFailed 补发 complete
import { createScannerUploadManager } from "../src/apps/answer-card/client/lib/scannerUploadManager";
import type { StartUploadInput } from "../src/apps/answer-card/client/lib/scannerUploadManager";
import { mapImportedScanPages, mapScanPageToLayout, uniqueScanConflictCards } from "../src/shared/scanPages";
import { createDefaultCard } from "../src/shared/defaultCard";
import { gradeCombinedRecognition } from "../src/shared/grading";

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

const TEST_CARD_VERSION = "0123456789abcdef01234567";

function baseInput(pages: number): StartUploadInput {
  return {
    kind: "import",
    cardId: "card_1",
    cardVersion: TEST_CARD_VERSION,
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

  // R35：不知道本机在用哪一版卡就不要上传；建会话与提交完成都要把指纹交给服务器核验
  {
    const bodies: Array<{ url: string; body: string }> = [];
    const mgr = createScannerUploadManager(deps({
      remoteFetch: async (url, init) => {
        bodies.push({ url: String(url), body: typeof init?.body === "string" ? init.body : "" });
        if (String(url).endsWith(SESSIONS)) return jsonRes({ sessionId: "r35", uploadTokens: ["t1"] });
        return jsonRes({ ok: true });
      },
    }));
    const versionless = await waitTerminal(mgr, mgr.startUpload({ ...baseInput(1), cardVersion: "" }));
    assert(versionless.status === "error" && versionless.message.includes("未能确定本机答题卡版本"),
      `缺少卡版本指纹时任务立即失败并提示重新同步（实际 ${versionless.status}/${versionless.message}）`);
    assert(!bodies.some((b) => b.url.endsWith(SESSIONS)), "版本未知的任务不会发出建会话请求");

    bodies.length = 0;
    assert((await waitTerminal(mgr, mgr.startUpload(baseInput(1)))).status === "done", "带指纹的上传正常完成");

    {
      // 整卡改分要按「任务是否还在途」禁用：逐页上传时每页现读本机订正，
      // 在途保存会让服务器收到半旧半新的一份识别快照。
      const scanJob = mgr.startUpload({
        kind: "scan", cardId: "card_1", cardVersion: TEST_CARD_VERSION, name: "扫描_82048",
        localSessionId: "scan-smoke-1", identityMode: "strict",
        pages: [{ pageNum: 1, side: "front", groupId: "0", getBlob: async () => blob() }],
      });
      assert(mgr.isGroupUploading("card_1", "0", "scan-smoke-1"), "任务未终态时视为正在上传");
      assert(!mgr.isGroupUploading("card_1", "9", "scan-smoke-1"), "别的组不被误判为在途");
      const scanResult = await waitTerminal(mgr, scanJob);
      assert(scanResult.status === "done" || scanResult.status === "error", `扫描任务应进入终态，实际 ${scanResult.status}`);
      // 完成即解锁；失败但已建远端会话的续传场景由下面一段专门覆盖。
      if (scanResult.status === "done") assert(!mgr.isGroupUploading("card_1", "0", "scan-smoke-1"), "完整上传后不再阻止改分");
    }

    {
      // 失败但已建远端会话的任务仍会「重试失败页」，此时改分依旧会撕裂快照（评审 P1）。
      // 关闭进度卡只摘掉内存任务，恢复记录还在：重新入队会接回同一个远端会话，
      // 所以锁必须跟着记录走，并给出明确的「放弃续传」出口（评审 P1 复核）。
      const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
      const values = new Map<string, string>([["projectx_server_url", "https://torn.test"]]);
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
        key: (index: number) => [...values.keys()][index] ?? null,
        get length() { return values.size; },
      } });
      try {
        const { readScanUploadRecovery } = await import("../src/apps/answer-card/client/lib/scannerUploadLedger");
        const torn = createScannerUploadManager(deps({
          localFetch: async (_url, init) => {
            const file = (init!.body as FormData).get("file") as Blob;
            const size = file.size;
            return jsonRes({ status: "ok", studentId: { status: "ok", value: "82048" }, questions: [], subjectiveQuestions: [], widthPx: size, heightPx: size });
          },
          remoteFetch: async url => {
            if (url.endsWith(SESSIONS)) return jsonRes({ sessionId: "torn-session", uploadTokens: ["t1", "t2"] });
            return jsonRes({ ok: true });
          },
        }));
        const tornId = torn.startUpload({
          kind: "scan", cardId: "card_1", cardVersion: TEST_CARD_VERSION, name: "扫描_82048",
          localSessionId: "scan-torn", identityMode: "strict",
          pages: [
            { pageNum: 1, side: "front", groupId: "0", getBlob: async () => blob() },
            { pageNum: 2, side: "front", groupId: "0", getBlob: async () => { throw new Error("读取第 2 页失败"); } },
          ],
        });
        const tornResult = await waitTerminal(torn, tornId);
        assert(tornResult.status === "error", `坏页任务应 error，实际 ${tornResult.status}/${tornResult.message}`);
        const liveTorn = torn.getState().jobs.find(job => job.id === tornId)!;
        assert(liveTorn.status === "error" && Boolean(liveTorn.remoteSessionId), "失败任务应已建立远端会话，可继续重试失败页");
        assert(torn.isGroupUploading("card_1", "0", "scan-torn"), "可续传的失败任务仍锁住整卡改分");
        assert(torn.isGroupUploadResumable("card_1", "0", "scan-torn"), "这一卷的锁应能被「放弃续传」解开");
        assert(readScanUploadRecovery("card_1", "scan-torn", "0")?.completed === false, "半成品进度要写入恢复记录供重启后续传");
        assert(torn.dismissJob(tornId), "教师可以关闭这张进度卡");
        assert(torn.isGroupUploading("card_1", "0", "scan-torn"), "关闭进度卡后恢复记录仍锁住整卡改分");
        assert(torn.isGroupUploadResumable("card_1", "0", "scan-torn"), "关闭进度卡后这一卷仍可放弃续传");
        const reloaded = createScannerUploadManager(deps());
        assert(reloaded.isGroupUploading("card_1", "0", "scan-torn"), "重启后仍按未完成的恢复记录锁住改分");
        assert(reloaded.localGroupDeleteBlock("card_1", "0", "scan-torn") !== null, "半成品仍要保住本机原图");
        const abandoned = reloaded.abandonGroupUpload("card_1", "0", "scan-torn");
        assert(abandoned.ok === true && reloaded.isGroupUploading("card_1", "0", "scan-torn") === false,
          "放弃续传后整卡改分恢复可用");
        assert(readScanUploadRecovery("card_1", "scan-torn", "0") === null, "放弃续传要删掉恢复记录");
        assert(reloaded.localGroupDeleteBlock("card_1", "0", "scan-torn") === null, "放弃后本机原图不再为续传保留");

        // 还没关卡就直接放弃：整条失败任务要从队列里摘掉，页面资源随之释放。
        const holder = createScannerUploadManager(deps({
          localFetch: async (_url, init) => {
            const file = (init!.body as FormData).get("file") as Blob;
            return jsonRes({ status: "ok", studentId: { status: "ok", value: "82048" }, questions: [], subjectiveQuestions: [], widthPx: file.size, heightPx: file.size });
          },
          remoteFetch: async url => {
            if (url.endsWith(SESSIONS)) return jsonRes({ sessionId: "held-session", uploadTokens: ["t1", "t2"] });
            return jsonRes({ ok: true });
          },
        }));
        const heldId = holder.startUpload({
          kind: "scan", cardId: "card_1", cardVersion: TEST_CARD_VERSION, name: "扫描_82048",
          localSessionId: "scan-held", identityMode: "strict",
          pages: [
            { pageNum: 1, side: "front", groupId: "0", getBlob: async () => blob() },
            { pageNum: 2, side: "front", groupId: "0", getBlob: async () => { throw new Error("读取第 2 页失败"); } },
          ],
        });
        assert((await waitTerminal(holder, heldId)).status === "error", "未关闭的坏页任务停在 error");
        assert(holder.isGroupUploading("card_1", "0", "scan-held"), "未关闭的半成品任务同样锁住改分");
        assert(holder.abandonGroupUpload("card_1", "0", "scan-held").ok === true, "放弃续传不要求先关闭进度卡");
        assert(holder.getState().jobs.some(job => job.id === heldId) === false, "放弃后这条任务从队列里摘掉");
        assert(!holder.isGroupUploading("card_1", "0", "scan-held"), "放弃后改分恢复可用");
        assert(readScanUploadRecovery("card_1", "scan-held", "0") === null, "放弃要删掉这一组的恢复记录");

        // 一条任务里混着别组的页时不能整条摘掉，否则那组的半成品锁会被连带解开。
        const mixed = createScannerUploadManager(deps({
          remoteFetch: async url => {
            if (url.endsWith(SESSIONS)) return jsonRes({ sessionId: "mixed-session", uploadTokens: ["t1", "t2"] });
            return jsonRes({ ok: true });
          },
        }));
        const mixedId = mixed.startUpload({
          kind: "scan", cardId: "card_1", cardVersion: TEST_CARD_VERSION, name: "扫描_混组",
          localSessionId: "scan-mixed", identityMode: "strict",
          pages: [
            { pageNum: 1, side: "front", groupId: "0", getBlob: async () => blob() },
            { pageNum: 2, side: "front", groupId: "1", getBlob: async () => { throw new Error("读取第 2 页失败"); } },
          ],
        });
        assert((await waitTerminal(mixed, mixedId)).status === "error", "混组任务应停在 error");
        assert(mixed.isGroupUploading("card_1", "1", "scan-mixed"), "混组任务的另一组同样锁住改分");
        const refused = mixed.abandonGroupUpload("card_1", "0", "scan-mixed");
        assert(refused.ok === false && refused.message.includes("其他试卷"), "跨组任务不得整条放弃");
        assert(mixed.isGroupUploading("card_1", "0", "scan-mixed"), "放弃被拒后这一组仍然锁着");

        // 正在传输的任务不能被「放弃续传」顶掉：页面资源还握在任务里。
        let releaseGate!: () => void;
        const gate = new Promise<void>(resolve => { releaseGate = resolve; });
        const live = createScannerUploadManager(deps({
          remoteFetch: async url => {
            if (url.endsWith(SESSIONS)) return jsonRes({ sessionId: "gate-session", uploadTokens: ["t1"] });
            if (url.endsWith(PAGES)) { await gate; return jsonRes({ ok: true }); }
            return jsonRes({ ok: true });
          },
        }));
        const gateId = live.startUpload({
          kind: "scan", cardId: "card_1", cardVersion: TEST_CARD_VERSION, name: "扫描_82048",
          localSessionId: "scan-gate", identityMode: "strict",
          pages: [{ pageNum: 1, side: "front", groupId: "0", getBlob: async () => blob() }],
        });
        const gateDeadline = Date.now() + 3_000;
        while (live.getState().jobs.find(job => job.id === gateId)?.status !== "uploading") {
          if (Date.now() > gateDeadline) throw new Error("等待上传中超时");
          await sleepReal(5);
        }
        const busy = live.abandonGroupUpload("card_1", "0", "scan-gate");
        assert(busy.ok === false && busy.message.includes("正在上传"), "在途任务不能放弃续传");
        releaseGate();
        assert((await waitTerminal(live, gateId)).status === "done", "放行后任务正常完成");
      } finally {
        if (previous) Object.defineProperty(globalThis, "localStorage", previous);
        else Reflect.deleteProperty(globalThis, "localStorage");
      }
    }
    const sessionBody = JSON.parse(bodies.find((b) => b.url.endsWith(SESSIONS))!.body);
    const completeBody = JSON.parse(bodies.find((b) => b.url.endsWith(COMPLETE))!.body);
    assert(sessionBody.cardVersion === TEST_CARD_VERSION && sessionBody.cardId === "card_1",
      `建会话时上报本机卡版本指纹（实际 ${sessionBody.cardVersion}）`);
    assert(completeBody.cardVersion === TEST_CARD_VERSION,
      `提交完成时再报一次指纹，扫描途中服务器改卡即可被 409 拦下（实际 ${JSON.stringify(completeBody)}）`);
  }

  // A local 413 must retain its status: retrying the same oversized image cannot
  // help. Other pages still finish, and manual retry may use a corrected image.
  for (const htmlError of [false, true]) {
    let rejected = true;
    const attempts = [0, 0];
    let completions = 0;
    const mgr = createScannerUploadManager(deps({
      localFetch: async (_url, init) => {
        const file = (init!.body as FormData).get("file") as File;
        const index = file.name === "page_1.jpg" ? 0 : 1;
        attempts[index]++;
        if (index === 0 && rejected) {
          return htmlError ? new Response("<html>Payload Too Large</html>", { status: 413 })
            : jsonRes({ message: "上传文件超过大小限制" }, 413);
        }
        return jsonRes({ status: "ok", studentId: { status: "ok", value: `8204${index}` }, questions: [], subjectiveQuestions: [] });
      },
      remoteFetch: async url => {
        if (url.endsWith(SESSIONS)) return jsonRes({ sessionId: "size-limit", uploadTokens: ["a", "b"] });
        if (url.endsWith(COMPLETE)) completions++;
        return jsonRes({ ok: true });
      },
    }));
    const id = mgr.startUpload(baseInput(2));
    const failed = await waitTerminal(mgr, id);
    assert(failed.status === "error" && failed.failedPages.join(",") === "1", "413 只标记超限页");
    assert(attempts.join(",") === "1,1" && completions === 0, "413 不自动重传，正常页继续上传但不提交残缺会话");
    assert(failed.message.includes("单张图片") && failed.message.includes("413"), "超限提示应区分单张大小与批次数量");
    rejected = false;
    mgr.retryFailed(id);
    assert((await waitTerminal(mgr, id)).status === "done", "修正图片后允许手动续传");
    assert(attempts.join(",") === "2,1" && Number(completions) === 1, "续传不重复已成功页");
  }

  // Use the actual snapshot fetch path: changing a mistyped key before session
  // creation must allow manual retry, without leaking a different server's key.
  {
    const originalFetch = globalThis.fetch;
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const values = new Map<string, string>([
      ["projectx_server_url", "https://scanner-test.invalid"], ["projectx_api_key", "wrong-key"],
    ]);
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    } });
    const sentKeys: string[] = [];
    globalThis.fetch = async (_url, init) => {
      const key = new Headers(init?.headers).get("X-Api-Key") ?? "";
      sentKeys.push(key);
      return key !== "correct-key" ? jsonRes({ message: "无效的 API Key" }, 401)
        : String(_url).endsWith(SESSIONS) ? jsonRes({ sessionId: "recovered", uploadTokens: ["t"] })
        : jsonRes({ ok: true });
    };
    try {
      const mgr = createScannerUploadManager(deps());
      const id = mgr.startUpload(baseInput(1));
      assert((await waitTerminal(mgr, id)).status === "error", "错误 Key 必须失败");
      assert(sentKeys.length === 1, "401 不应自动重试");
      values.set("projectx_api_key", "correct-key");
      mgr.retryFailed(id);
      assert((await waitTerminal(mgr, id)).status === "done", "改正 Key 后可重试未创建的会话");
      values.set("projectx_api_key", "wrong-key");
      const other = mgr.startUpload(baseInput(1));
      await waitTerminal(mgr, other);
      values.set("projectx_server_url", "https://other-server.invalid");
      values.set("projectx_api_key", "other-server-key");
      mgr.retryFailed(other);
      assert(!sentKeys.includes("other-server-key"), "切服后不得向旧服务器泄露新 Key");
      mgr.cancelJob(other);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  }

  // Exercise the same metadata builder as file import, through recognition and upload.
  for (const sided of ["single", "double"] as const) {
    for (const count of [1, 2, 3, 4]) {
      const mapping = mapImportedScanPages(count * 2, count, sided);
      const recognizedPages: number[] = [];
      const received: string[] = [];
      const mgr = createScannerUploadManager(deps({
        localFetch: async (_url, init) => {
          const page = Number((init!.body as FormData).get("page"));
          const index = recognizedPages.length;
          recognizedPages.push(page);
          return jsonRes({ status: "ok", studentId: page === 1 ? { value: `student_${Math.floor(index / count)}` } : {}, questions: [], subjectiveQuestions: [] });
        },
        remoteFetch: async (url, init) => {
          if (url.endsWith(SESSIONS)) return jsonRes({ sessionId: "import", uploadTokens: mapping.map((_, i) => `t${i}`) });
          if (url.endsWith(PAGES)) {
            const form = init!.body as FormData;
            const actual = mapScanPageToLayout(Number(form.get("pageNum")), form.get("side") as "front" | "back", count, sided);
            const recognition = JSON.parse(String(form.get("recognition")));
            received.push(`${actual.groupIndex}:${actual.layoutPage}:${recognition.studentId.value}`);
          }
          return jsonRes({ ok: true });
        },
      }));
      const input = baseInput(count * 2);
      input.pages = mapping.map(page => ({ ...page, getBlob: async () => blob() }));
      assert((await waitTerminal(mgr, mgr.startUpload(input))).status === "done", `${sided}/${count} imported pages finish`);
      assert(recognizedPages.join() === mapping.map(p => p.layoutPage).join(), "Recognize actual layout pages");
      assert(received.join() === mapping.map(p => `${p.groupId}:${p.layoutPage}:student_${p.groupId}`).join(), "Server regrouping and inherited IDs agree for both students");
    }
  }
  let rejectedIncomplete = false;
  try { mapImportedScanPages(5, 3, "double"); } catch { rejectedIncomplete = true; }
  assert(rejectedIncomplete, "Reject incomplete imports before creating remote sessions");

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
    input.pages[1].pageNum = 1;
    input.pages.reverse(); // Real database ORDER BY side can return the back first.
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
  // Correcting a failed back must first update the released, uploaded front.
  // A rejected correction keeps the failed blob and can retry with another ID.
  {
    let backFails = true;
    let correctionFails = true;
    let frontReads = 0;
    const events: string[] = [];
    const input = baseInput(2);
    input.pages[0].getBlob = async () => { frontReads++; return blob(); };
    input.pages[1].pageNum = 1; input.pages[1].side = "back";
    const mgr = createScannerUploadManager(deps({ remoteFetch: async (url, init) => {
      if (url.endsWith(SESSIONS)) return jsonRes({ sessionId: "correction-pair", uploadTokens: ["front", "back"] });
      if (url.endsWith(PAGES)) {
        const form = init!.body as FormData;
        if (form.get("token") === "back" && backFails) throw new Error("back network failure");
        events.push(`upload:${form.get("token")}:${JSON.parse(String(form.get("recognition"))).studentId.value}`);
      }
      if (url.endsWith("/results")) return jsonRes({ results: [], failures: [{ groupId: "server-group", pages: [{ recordId: "front" }] }], reviewCards: [] });
      if (url.endsWith("/correct")) {
        const body = JSON.parse(String(init!.body));
        assert(body.groupId === "server-group", "订正必须使用服务器原卷分组");
        events.push(`correct:${body.studentId}`);
        if (correctionFails) return jsonRes({ message: "student outside roster" }, 409);
      }
      if (url.endsWith(COMPLETE)) events.push("complete");
      return jsonRes({ ok: true });
    } }));
    const id = mgr.startUpload(input);
    assert((await waitTerminal(mgr, id)).status === "error", "背面上传失败应保留任务");
    backFails = false;
    mgr.correctStudentId(id, "91002");
    assert((await waitTerminal(mgr, id)).status === "error", "远端订正被拒应保持可重试");
    assert(events.join(",") === "upload:front:82048,correct:91002", "订正失败不得续传背面或保存成绩");
    assert((await mgr.getFailedPageBlobs(id)).length === 1, "订正失败后背面原图必须保留");
    correctionFails = false;
    mgr.correctStudentId(id, "91003");
    assert((await waitTerminal(mgr, id)).status === "done", "同步成功后应续传背面并完成");
    assert(events.join(",") === "upload:front:82048,correct:91002,correct:91003,upload:back:91003,complete", "服务器订正必须先于背面续传");
    assert(frontReads === 1, "已上传正面释放的原图无需重新读取");
  }
  // Slow front upload exceeds the old 1s+3s retry window. A second pump request
  // must not start its back or another job; no dependency retry budget is spent.
  {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const recognized: string[] = [];
    const uploaded: string[] = [];
    let blocked = false;
    const input = baseInput(2);
    input.pages[1].pageNum = 1;
    input.pages[1].side = "back";
    input.pages.reverse();
    const mgr = createScannerUploadManager(deps({
      localFetch: async (_url, init) => {
        const side = String((init?.body as FormData).get("page"));
        recognized.push(side);
        return jsonRes({ status: "ok", studentId: { status: "ok", value: side === "1" ? "81001" : null }, questions: [], subjectiveQuestions: [] });
      },
      remoteFetch: async (url, init) => {
        if (url.endsWith(SESSIONS)) return jsonRes({ sessionId: "slow", uploadTokens: ["s1", "s2"] });
        if (url.endsWith(PAGES)) {
          const form = init!.body as FormData;
          if (form.get("side") === "front" && !blocked) { blocked = true; await gate; }
          uploaded.push(JSON.parse(String(form.get("recognition"))).studentId.value);
        }
        return jsonRes({ ok: true });
      },
    }));
    const id = mgr.startUpload(input);
    const other = mgr.startUpload(baseInput(1));
    await sleepReal(4_200);
    assert(recognized.join(",") === "1", "慢首页未完成时，背面与其他任务必须等待");
    assert(mgr.getState().jobs[0].failedPages.length === 0, "等待首页不得耗尽重试预算");
    release();
    assert((await waitTerminal(mgr, id)).status === "done", "慢网络恢复后双面应完成");
    assert((await waitTerminal(mgr, other)).status === "done", "全局队列应继续");
    assert(uploaded.join(",") === "81001,81001,81001", "慢网络继承学号应稳定");
  }

  // A failed front blocks only its own back. Manual retry repairs the dependency
  // before retrying the back, reuses tokens, and leaves other successful cards alone.
  {
    let frontFails = true;
    let backRecognitions = 0;
    let thirdRecognitions = 0;
    const uploaded: string[] = [];
    const input = baseInput(3);
    input.pages[1].pageNum = 1; input.pages[1].side = "back";
    input.pages[2].pageNum = 2;
    const mgr = createScannerUploadManager(deps({
      localFetch: async (_url, init) => {
        const form = init!.body as FormData;
        const file = form.get("file") as File;
        const back = form.get("page") === "2";
        if (back) backRecognitions++;
        if (file.name === "page_2.jpg") thirdRecognitions++;
        return jsonRes({ status: "ok", studentId: { status: "ok", value: back ? null : file.name === "page_1.jpg" ? "81001" : "81002" }, questions: [], subjectiveQuestions: [] });
      },
      remoteFetch: async (url, init) => {
        if (url.endsWith(SESSIONS)) return jsonRes({ sessionId: "retry-pair", uploadTokens: ["f", "b", "third"] });
        if (url.endsWith(PAGES)) {
          const form = init!.body as FormData;
          if (form.get("token") === "f" && frontFails) throw new Error("network unavailable for first card");
          uploaded.push(`${form.get("token")}:${JSON.parse(String(form.get("recognition"))).studentId.value}`);
        }
        return jsonRes({ ok: true });
      },
    }));
    const id = mgr.startUpload(input);
    assert((await waitTerminal(mgr, id)).status === "error", "失败首页应记录错误");
    assert(backRecognitions === 0 && thirdRecognitions === 1, "只阻断依赖背面，其他卡继续");
    frontFails = false;
    mgr.retryFailed(id);
    assert((await waitTerminal(mgr, id)).status === "done", "首页修复后依赖页应自动恢复");
    assert(uploaded.join(",") === "third:81002,f:81001,b:81001", "重试应维持卡片和 token 配对");
    assert(thirdRecognitions === 1, "已成功卡不得重新识别上传");
  }

  // Saved corrections loaded after queueing override the captured student ID,
  // including retries and dependent pages without their own student area.
  {
    const input = baseInput(2);
    let correctedId = "91001", failUpload = true;
    input.pages = input.pages.map((page, i) => ({ ...page, pageNum: 1,
      side: i === 0 ? "front" : "back", groupId: "corrected-card", layoutPage: i + 1,
      studentId: "91001", getCorrection: async () => ({ status: "ok",
        studentId: { status: "ok", value: i === 0 ? correctedId : null },
        questions: [], subjectiveQuestions: [] }) }));
    const sent: string[] = [];
    const mgr = createScannerUploadManager(deps({
      remoteFetch: async (url, init) => {
        if (url.endsWith(SESSIONS)) return jsonRes({ sessionId: "corrected", uploadTokens: ["a", "b"] });
        if (url.endsWith(PAGES)) {
          if (failUpload) return jsonRes({ message: "retry later" }, 409);
          sent.push(JSON.parse(String((init!.body as FormData).get("recognition"))).studentId.value);
        }
        return jsonRes({ ok: true });
      },
    }));
    const id = mgr.startUpload(input);
    assert((await waitTerminal(mgr, id)).status === "error", "queued upload can be retried after correction");
    correctedId = "91002"; failUpload = false;
    mgr.retryFailed(id);
    assert((await waitTerminal(mgr, id)).status === "done", "corrected queued upload succeeds");
    assert(sent.join(",") === "91002,91002", "saved ID overrides stale captured ID and propagates to back page");
  }

  // A page-number gap is not a pair, even if array elements are adjacent.
  {
    const input = baseInput(2); input.pages[1].pageNum = 9; input.pages[1].side = "back";
    const mock = makeRemoteMock({
      [SESSIONS]: [() => jsonRes({ sessionId: "gap", uploadTokens: ["a", "b"] })],
      [PAGES]: [() => jsonRes({ ok: true })], [COMPLETE]: [() => jsonRes({ ok: true })],
    });
    const mgr = createScannerUploadManager(deps({ remoteFetch: mock.fn }));
    const r = await waitTerminal(mgr, mgr.startUpload(input));
    assert(r.status === "error" && r.failedPages.includes(9), "不连续纸张不得配对");
    assert(mock.counters[PAGES] === 1 && !mock.counters[COMPLETE], "孤立背面不得上传或触发 complete");
  }
  // Three-page cards keep one anchor across physical sheets and send the actual
  // layout page to native OMR; a teacher-confirmed ID survives re-recognition.
  {
    const input = baseInput(3);
    input.pages = [
      { pageNum: 1, side: "front", layoutPage: 1, groupId: "card-a", studentId: "91002", getBlob: async () => blob() },
      { pageNum: 1, side: "back", layoutPage: 2, groupId: "card-a", studentId: "91002", getBlob: async () => blob() },
      { pageNum: 2, side: "front", layoutPage: 3, groupId: "card-a", studentId: "91002", getBlob: async () => blob() },
    ];
    const localPages: string[] = [];
    const uploadedIds: string[] = [];
    const mgr = createScannerUploadManager(deps({
      localFetch: async (_url, init) => {
        localPages.push(String((init!.body as FormData).get("page")));
        return jsonRes({ status: "failed", message: "Student ID recognition failed.", quality: { matchCount: 6, missingRoles: [] },
          studentId: { status: "failed", value: null }, questions: [], subjectiveQuestions: [] });
      },
      remoteFetch: async (url, init) => {
        if (url.endsWith(SESSIONS)) return jsonRes({ sessionId: "multi", uploadTokens: ["a", "b", "c"] });
        if (url.endsWith(PAGES)) {
          const recognition = JSON.parse(String((init!.body as FormData).get("recognition")));
          assert(recognition.status === "ok", "订正的学号应仅修复 ID 错误");
          uploadedIds.push(recognition.studentId.value);
        }
        return jsonRes({ ok: true });
      },
    }));
    assert((await waitTerminal(mgr, mgr.startUpload(input))).status === "done", "跨纸张多页卡应完成");
    assert(localPages.join(",") === "1,2,3", "必须使用真实布局页码");
    assert(uploadedIds.join(",") === "91002,91002,91002", "订正后的学号必须贯穿上传链路");
  }
  {
    let sessionCount = 0;
    let resolved = false;
    const saves: Array<{ session: string; version: string }> = [];
    const failures = [0, 1].map(groupId => ({ groupId: String(groupId), studentId: "91001", stage: "recognition", pages: [], message: "重复学号",
      conflicts: [{ sessionId: "s1", groupId: "0", studentId: "91001", previouslySaved: true, pages: [] },
        { sessionId: "s2", groupId: "0", studentId: "91001", previouslySaved: false, pages: [] },
        { sessionId: "s2", groupId: "1", studentId: "91001", previouslySaved: false, pages: [] }] }));
    const versions = [TEST_CARD_VERSION, "abcdef0123456789abcdef01"];
    const mgr = createScannerUploadManager(deps({ remoteFetch: async (url, init) => {
      if (url.endsWith("/sessions")) return jsonRes({ sessionId: `s${++sessionCount}`, uploadTokens: ["token"] });
      if (url.endsWith("/complete")) {
        const session = url.includes("s1/") ? "s1" : "s2";
        saves.push({ session, version: JSON.parse(String(init?.body)).cardVersion });
        if (session === "s2" && !resolved) return jsonRes({ message: "重复学号", failures }, 409);
        return jsonRes({ ok: true });
      }
      if (url.endsWith("/results")) return jsonRes({ results: [{ groupId: "0", studentId: "91001", pages: [], saved: resolved }], failures: resolved ? [] : failures });
      return jsonRes({ ok: true });
    } }));
    const old = mgr.startUpload(baseInput(1));
    assert((await waitTerminal(mgr, old)).status === "done", "旧卷先正常完成");
    const duplicate = mgr.startUpload({ ...baseInput(1), cardVersion: versions[1] });
    assert((await waitTerminal(mgr, duplicate)).status === "error", "新卷重复时应显示失败");
    const oldJob = mgr.getState().jobs.find(j => j.id === old)!;
    const newJob = mgr.getState().jobs.find(j => j.id === duplicate)!;
    assert(oldJob.status === "error", "旧卷不能继续显示正常完成");
    assert(oldJob.failures?.length === 1 && oldJob.failures[0].groupId === "0", "旧任务只保留自己的失败分组");
    assert(newJob.failures?.length === 2, "新任务保留两个真实失败分组");
    const cards = uniqueScanConflictCards(mgr.getState().jobs.flatMap(j => j.failures?.flatMap(f => f.conflicts ?? []) ?? []));
    assert(cards.length === 3, "多个任务和多个失败分组共同展示三份真实原卷");
    const before = saves.length;
    const partial = await mgr.saveSession(duplicate, "s2");
    assert(partial.status === 409, "仍有重复卷时保存返回冲突");
    await mgr.refreshResults(duplicate);
    assert(saves.length === before + 1, "刷新状态不会再次提交保存或创建会话");
    assert(mgr.getState().jobs.find(j => j.id === duplicate)?.reviewCards?.length === 1,
      "订正后的新卷未保存时保留原卷查看和保存入口");
    resolved = true;
    assert((await mgr.saveSession(duplicate, "s1")).ok, "可从新任务保存旧会话");
    assert(saves.at(-1)?.version === versions[0], "旧会话使用原扫描版本，不借用新任务版本");
    assert((await mgr.saveSession(duplicate, "s2")).ok, "订正后新会话可以保存");
    assert(saves.at(-1)?.version === versions[1], "新会话使用自己的扫描版本");
    await mgr.refreshResults(duplicate);
    assert(mgr.getState().jobs.every(j => j.status === "done" && !j.failures?.length), "相关任务刷新为服务器实际保存状态");
    assert(sessionCount === 2, "整个手动处理过程复用会话");
    mgr.dismissJob(old);
    assert((await mgr.saveSession(duplicate, "s1")).ok && saves.at(-1)?.version === versions[0], "关闭旧任务仍保留原版本回执");
  }
  {
    let corrected = false;
    const mgr = createScannerUploadManager(deps({ remoteFetch: async (url, init) => {
      if (url.endsWith("/sessions")) return jsonRes({ sessionId: "saving-error", uploadTokens: ["token"] });
      if (url.endsWith("/correct")) { corrected = true; return jsonRes({ ok: true }); }
      const batch = { results: corrected ? [{ groupId: "0", studentId: "91002", pages: [], saved: true }] : [],
        failures: corrected ? [] : [{ groupId: "0", studentId: "typo", stage: "saving", pages: [], message: "学号不在名单" }] };
      if (url.endsWith("/results")) return jsonRes(batch);
      if (url.endsWith("/complete")) return jsonRes({ ...batch, ok: corrected }, corrected ? 200 : 409);
      return jsonRes({ ok: true });
    } }));
    const id = mgr.startUpload(baseInput(1));
    assert((await waitTerminal(mgr, id)).status === "error", "无重复卷的保存失败仍显示问题卷");
    assert(mgr.getState().jobs[0].reviewCards?.[0].sessionId === "saving-error", "普通保存失败保留订正与保存入口");
    await mgr.requestJob(id, "/api/scanner/upload/sessions/saving-error/correct", { method: "POST", body: JSON.stringify({ groupId: "0", studentId: "91002" }) });
    assert((await mgr.saveSession(id, "saving-error")).ok, "普通问题卷订正后复用原会话保存");
    await mgr.refreshResults(id);
    assert(mgr.getState().jobs[0].status === "done", "普通问题卷订正后清理失败状态");
  }
  {
    // Completed cards stay in the manager after their UI disappears. Reviewing
    // a duplicate must not query 397 unrelated cards or stop at a stale owner.
    let sessions = 0;
    const refreshed: string[] = [];
    const conflicts = ["batch-1", "batch-2", "batch-400"].map(sessionId => ({
      sessionId, groupId: "0", studentId: "91001", pages: [], previouslySaved: sessionId !== "batch-400",
    }));
    const mgr = createScannerUploadManager(deps({ remoteFetch: async (url) => {
      if (url.endsWith("/sessions")) return jsonRes({ sessionId: `batch-${++sessions}`, uploadTokens: ["token"] });
      if (url.endsWith("batch-400/complete")) return jsonRes({ failures: [{ groupId: "0", studentId: "91001",
        stage: "recognition", pages: [], message: "duplicate", conflicts }] }, 409);
      if (url.endsWith("/results")) {
        const session = url.split("/").at(-2)!;
        refreshed.push(session);
        if (session === "batch-1") return jsonRes({ message: "stale session" }, 404);
        return jsonRes({ results: [{ groupId: "0", studentId: "91001", pages: [], saved: true }], failures: [] });
      }
      return jsonRes({ ok: true });
    } }));
    const ids: string[] = [];
    for (let index = 0; index < 400; index++) {
      const id = mgr.startUpload(baseInput(1)); ids.push(id);
      await waitTerminal(mgr, id);
    }
    let rejected = false;
    try { await mgr.refreshResults(ids[399]); } catch { rejected = true; }
    assert(rejected, "失效的关联会话仍明确报告错误");
    assert(refreshed.sort().join(",") === ["batch-1", "batch-2", "batch-400"].sort().join(","),
      "400 份保留任务仅刷新三个冲突相关会话");
    assert(mgr.getState().jobs.find(j => j.id === ids[1])?.status === "done", "失效会话不能阻止其它关联任务刷新");
    assert(mgr.getState().jobs.find(j => j.id === ids[399])?.status === "done", "源任务也刷新成功");
    refreshed.length = 0;
    await mgr.refreshResults(ids[399], ["batch-2"]);
    assert(refreshed.sort().join(",") === ["batch-2", "batch-400"].sort().join(","),
      "冲突清单消失后仍刷新本次人工处理的目标会话");
  }
  {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } });
    try {
      let sessions = 0;
      const submitted: Array<{ url: string; version: string }> = [];
      const remoteFetch = async (url: string, init?: RequestInit) => {
        if (url.endsWith("/sessions")) return jsonRes({ sessionId: `persist-${++sessions}`, uploadTokens: ["token"] });
        if (url.endsWith("/complete")) submitted.push({ url, version: JSON.parse(String(init?.body)).cardVersion });
        return jsonRes({ ok: true });
      };
      const original = createScannerUploadManager(deps({ remoteFetch }));
      await waitTerminal(original, original.startUpload(baseInput(1)));
      const restarted = createScannerUploadManager(deps({ remoteFetch }));
      const source = restarted.startUpload({ ...baseInput(1), cardVersion: "abcdef0123456789abcdef01" });
      await waitTerminal(restarted, source);
      assert((await restarted.saveSession(source, "persist-1")).ok, "重建队列后仍可恢复有版本记录的原会话");
      assert(submitted.at(-1)?.version === TEST_CARD_VERSION, "重建队列仍使用持久化的原版本");
      assert((await restarted.saveSession(source, "unknown-history")).ok, "版本未知的历史卷由服务端恢复");
      assert(submitted.at(-1)?.version === undefined, "历史卷不套用新任务的版本");
      values.set("projectx_server_url", "https://different-server.example");
      const otherServer = createScannerUploadManager(deps({ remoteFetch }));
      const other = otherServer.startUpload(baseInput(1));
      await waitTerminal(otherServer, other);
      assert((await otherServer.saveSession(other, "persist-1")).ok, "另一服务器由自身校验会话");
      assert(submitted.at(-1)?.version === undefined, "版本回执按服务器与答题卡隔离");
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  }
  // A manual retry already in the queue must survive another task's duplicate response.
  {
    let sessions = 0;
    let oldCompletions = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let duplicateCompleting = false;
    const mgr = createScannerUploadManager(deps({ remoteFetch: async url => {
      if (url.endsWith(SESSIONS)) return jsonRes({ sessionId: `isolation-${++sessions}`, uploadTokens: ["token"] });
      if (url.endsWith("isolation-1/complete")) return ++oldCompletions === 1
        ? jsonRes({ message: "待人工处理", failures: [] }, 409) : jsonRes({ ok: true });
      if (url.endsWith("isolation-2/complete")) {
        duplicateCompleting = true; await gate;
        return jsonRes({ failures: [{ groupId: "0", studentId: "91001", pages: [], message: "重复学号", conflicts: [
          { sessionId: "isolation-1", groupId: "0", studentId: "91001", pages: [], previouslySaved: false },
          { sessionId: "isolation-2", groupId: "0", studentId: "91001", pages: [], previouslySaved: false },
        ] }] }, 409);
      }
      return jsonRes({ ok: true });
    } }));
    const old = mgr.startUpload(baseInput(1)); await waitTerminal(mgr, old);
    const duplicate = mgr.startUpload(baseInput(1));
    while (!duplicateCompleting) await sleepReal(5);
    mgr.retryFailed(old);
    const normal = mgr.startUpload(baseInput(1));
    release();
    assert((await waitTerminal(mgr, duplicate)).status === "error", "重复卷单独待处理");
    assert((await waitTerminal(mgr, old)).status === "done" && oldCompletions === 2, "关联的排队重试不会被置错跳过");
    assert((await waitTerminal(mgr, normal)).status === "done", "后续正常卷继续上传");
  }
  {
    const card = createDefaultCard("refresh-results");
    card.bodyBlocks = [{ id: "refresh-choice", type: "objective", title: "选择题", questionStart: 1,
      questionCount: 1, optionCount: 4, mode: "single", scorePerQuestion: 5, density: "normal", answerKey: { 1: ["D"] } }];
    let corrected = false;
    let saves = 0;
    let holdNext = false;
    let release: (() => void) | undefined;
    const page = { recordId: "remote-page", pageNum: 1, side: "front", layoutPage: 1 };
    const mgr = createScannerUploadManager(deps({ remoteFetch: async url => {
      if (url.endsWith("/sessions")) return jsonRes({ sessionId: "refresh", uploadTokens: ["token"] });
      if (url.endsWith("/complete")) { saves++; return jsonRes({ ok: true }); }
      if (url.endsWith("/results")) {
        const grading = gradeCombinedRecognition(card, page.recordId, {
        status: "ok", studentId: { status: "ok", value: corrected ? "10002" : "10001" },
        questions: [{ questionNumber: 1, selectedOptions: [corrected ? "D" : "A"], confidence: 1, status: "ok" }], subjectiveQuestions: [],
        });
        const response = jsonRes({ results: [{ groupId: "0", studentId: grading.studentId, saved: true, pages: [{ ...page, grading }] }], failures: [] });
        if (holdNext) { holdNext = false; await new Promise<void>(resolve => { release = resolve; }); }
        return response;
      }
      assert(!url.includes("/correction"), "刷新不得占用整卡订正接口的配额");
      return jsonRes({ ok: true });
    } }));
    const id = mgr.startUpload({ ...baseInput(1), trackResults: true });
    await waitTerminal(mgr, id);
    await mgr.refreshResults(id);
    assert(mgr.getState().jobs[0].resultRows?.[0].row.totalScore === 0, "初始远端填涂生成最新成绩行");
    holdNext = true;
    const olderRefresh = mgr.refreshResults(id);
    assert(release, "旧刷新已发出但暂未返回");
    corrected = true;
    await mgr.refreshResults(id);
    release();
    await olderRefresh;
    const latest = mgr.getState().jobs[0].resultRows?.[0];
    assert(latest?.row.studentId === "10002" && latest.row.totalScore === 5
      && latest.row.questions[0].selectedOptions[0] === "D", "刷新后学号、分数和选项明细一起更新");
    assert(latest.pageNum === 1 && latest.side === "front", "刷新结果按物理页与正反面对应原行");
    assert(saves === 1, "成绩刷新只读，不重新保存已公布成绩");
  }
  {
    const values = new Map<string, string>();
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } });
    try {
      const { isGroupQueued } = await import("../src/apps/answer-card/client/lib/scannerUploadLedger");
      let releaseBlocker: () => void = () => {};
      const blockerGate = new Promise<void>(resolve => { releaseBlocker = resolve; });
      let sessions = 0;
      const mgr = createScannerUploadManager(deps({
        remoteFetch: async (url) => {
          if (url.endsWith("/sessions")) {
            sessions += 1;
            if (sessions === 1) await blockerGate;
            return jsonRes({ sessionId: `remote-${sessions}`, uploadTokens: ["t"] });
          }
          return jsonRes({ ok: true });
        },
      }));
      const page = { pageNum: 1, side: "front" as const, groupId: "0", getBlob: async () => blob() };
      const imported = mgr.startUpload({ ...baseInput(1), kind: "import", pages: [page] });
      await sleepReal(15);
      assert(mgr.hasGroupUpload("card_1", "0", "scan-new") === false, "导入任务不能挡住另一场扫描的同组编号");
      const scan = mgr.startUpload({
        kind: "scan", cardId: "card_1", cardVersion: TEST_CARD_VERSION, name: "扫描_91001",
        localSessionId: "scan-new", pages: [{ ...page }],
      });
      assert(mgr.getState().jobs.find(job => job.id === scan)?.status === "queued", "新扫描停在排队，还没请求远端");
      assert(mgr.hasGroupUpload("card_1", "0", "scan-other") === false, "不同扫描会话的同组编号不是同一份原卷");
      const released = mgr.releaseGroupForLocalDelete("card_1", "0", "scan-new");
      if (!released.ok) throw new Error(released.message);
      assert(released.forgetLedger === true, "尚未建远端会话的排队任务删除后应释放入队资格");
      assert(mgr.getState().jobs.some(job => job.id === scan) === false, "删除前取消尚未开始的上传");
      assert(mgr.hasGroupUpload("card_1", "0", "scan-new") === false, "取消后不再占住新扫描");
      assert(isGroupQueued("card_1", "scan-new", "0") === false, "取消排队任务不得留下持久入队标记");
      const again = mgr.startUpload({
        kind: "scan", cardId: "card_1", cardVersion: TEST_CARD_VERSION, name: "扫描_91001",
        localSessionId: "scan-new", pages: [{ ...page, getBlob: async () => blob() }],
      });
      releaseBlocker();
      assert((await waitTerminal(mgr, imported)).status === "done");
      assert((await waitTerminal(mgr, again)).status === "done");
      assert(isGroupQueued("card_1", "scan-new", "0") === true, "远端会话提交完成后记下完成标记");

      let releasePages: () => void = () => {};
      const pagesGate = new Promise<void>(resolve => { releasePages = resolve; });
      const live = createScannerUploadManager(deps({
        remoteFetch: async (url) => {
          if (url.endsWith("/sessions")) return jsonRes({ sessionId: "live", uploadTokens: ["t"] });
          if (url.endsWith("/pages")) { await pagesGate; return jsonRes({ ok: true }); }
          return jsonRes({ ok: true });
        },
      }));
      const uploading = live.startUpload({
        kind: "scan", cardId: "card_1", cardVersion: TEST_CARD_VERSION, name: "扫描_91002",
        localSessionId: "scan-live", pages: [{ ...page, getBlob: async () => blob() }],
      });
      const deadline = Date.now() + 3_000;
      while (live.getState().jobs.find(job => job.id === uploading)?.status !== "uploading") {
        if (Date.now() > deadline) throw new Error("等待上传中超时");
        await sleepReal(5);
      }
      const blocked = live.releaseGroupForLocalDelete("card_1", "0", "scan-live");
      assert(blocked.ok === false, "正在读取原图的上传不能被删除打断");
      releasePages();
      assert((await waitTerminal(live, uploading)).status === "done");

      // Closing an error card or restarting the manager must keep the same remote session and page tokens.
      for (const successfulPrefix of [0, 1, 2]) {
        let recover = false;
        let creates = 0, completes = 0;
        const sent: string[] = [];
        const localSessionId = `restart-${successfulPrefix}`;
        const remoteFetch = async (url: string, init?: RequestInit) => {
          if (url.endsWith("/sessions")) {
            creates++;
            return jsonRes({ sessionId: localSessionId, uploadTokens: ["front-token", "back-token"] });
          }
          assert(url.includes(`/sessions/${localSessionId}/`), "恢复请求必须复用原会话");
          if (url.endsWith("/pages")) {
            const token = String((init!.body as FormData).get("token"));sent.push(token);
            if (!recover && (successfulPrefix === 0 || (successfulPrefix === 1 && token === "back-token"))) {
              return jsonRes({ message: "controlled page failure" },400);
            }
          }
          if (url.endsWith("/complete")) {
            completes++;
            if (!recover && successfulPrefix === 2) return jsonRes({ message: "lost complete response" },500);
          }
          return jsonRes({ ok: true });
        };
        const makeInput = (): StartUploadInput => ({
          kind: "scan", cardId: "card_1", cardVersion: TEST_CARD_VERSION, name: "recovery", localSessionId,
          pages: ["front", "back"].map((side, i) => ({ pageNum:1,side:side as "front"|"back",layoutPage:i+1,
            recordId:`source-${i}`,groupId:"0",getBlob:async()=>blob() })),
        });
        const original = createScannerUploadManager(deps({remoteFetch}));
        const id = original.startUpload(makeInput());
        const error = await waitTerminal(original,id);
        assert(error.status === "error" && error.uploaded === successfulPrefix,"初次失败保留实际逐页进度");
        assert(!isGroupQueued("card_1",localSessionId,"0"),"未完成任务不写永久完成标记");
        assert(original.dismissJob(id),"失败卡可以关闭");
        assert(original.localGroupDeleteBlock("card_1","0",localSessionId) !== null,"关闭卡后仍保护续传需要的原图");
        const restored = createScannerUploadManager(deps({remoteFetch}));
        let rejected = false;
        try { restored.startUpload({...makeInput(),cardVersion:"ffffffffffffffffffffffff"}); } catch { rejected = true; }
        assert(rejected,"变更版式不能复用原上传会话");
        values.set("projectx_server_url","https://other.test");rejected = false;
        try { restored.startUpload(makeInput()); } catch { rejected = true; }
        assert(rejected,"切换服务器不得向新服务器发送旧会话");values.delete("projectx_server_url");
        const before = sent.length;
        recover = true;
        const recoveredId = restored.startUpload(makeInput());
        assert((await waitTerminal(restored,recoveredId)).status === "done","重建 manager 后可完成续传");
        assert(creates === 1,"续传不新建第二份远端回执");
        assert(sent.length - before === 2 - successfulPrefix,"已成功的页不重传");
        if (successfulPrefix === 1) assert(sent.at(-1) === "back-token","续传失败背面复用原 token");
        assert(completes >= 1 && isGroupQueued("card_1",localSessionId,"0"),"完成后保留去重凭据");
        assert(restored.localGroupDeleteBlock("card_1","0",localSessionId) === null,"完成后可以删除本机原图");
      }
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  }
  console.log("scanner-upload-manager-smoke: 全部通过");
}

void main();
