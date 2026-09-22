// v2.5.1 上传管理器冒烟：mock remoteFetch 驱动三条核心路径
// ①全成功 ②断线暂停→恢复续传 ③重试耗尽→error→手动 retryFailed 补发 complete
import { createScannerUploadManager } from "../src/apps/answer-card/client/lib/scannerUploadManager";
import type { StartUploadInput } from "../src/apps/answer-card/client/lib/scannerUploadManager";
import { mapImportedScanPages, mapScanPageToLayout } from "../src/shared/scanPages";

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
    const failures = [{ groupId: "0", studentId: "91001", stage: "recognition", pages: [], message: "重复学号",
      conflicts: [{ sessionId: "s1", groupId: "0", studentId: "91001", previouslySaved: true, pages: [] },
        { sessionId: "s2", groupId: "0", studentId: "91001", previouslySaved: false, pages: [] }] }];
    const mgr = createScannerUploadManager(deps({ remoteFetch: async url => {
      if (url.endsWith("/sessions")) return jsonRes({ sessionId: `s${++sessionCount}`, uploadTokens: ["token"] });
      if (url.endsWith("s2/complete")) return jsonRes({ message: "重复学号", failures }, 409);
      return jsonRes({ ok: true });
    } }));
    const old = mgr.startUpload(baseInput(1));
    assert((await waitTerminal(mgr, old)).status === "done", "旧卷先正常完成");
    const duplicate = mgr.startUpload(baseInput(1));
    assert((await waitTerminal(mgr, duplicate)).status === "error", "新卷重复时应显示失败");
    assert(mgr.getState().jobs.find(j => j.id === old)?.status === "error", "旧卷不能继续显示正常完成");
    assert(mgr.getState().jobs.every(j => j.failures?.[0].conflicts?.length === 2), "新旧任务均保留所有冲突原卷");
  }
  console.log("scanner-upload-manager-smoke: 全部通过");
}

void main();
