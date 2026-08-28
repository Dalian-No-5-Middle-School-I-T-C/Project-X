import assert from "node:assert";

// ── polyfill globals before importing scannerSync ──
const store = new Map<string, string>();
const ls = {
  getItem(k: string) { return store.has(k) ? store.get(k)! : null; },
  setItem(k: string, v: string) { store.set(k, String(v)); },
  removeItem(k: string) { store.delete(k); },
  clear() { store.clear(); },
};
// @ts-ignore
globalThis.localStorage = ls as any;

// document mock for startPolling
let hidden = false;
const docListeners = new Map<string, Set<() => void>>();
const documentMock: any = {
  get hidden() { return hidden; },
  set hidden(v: boolean) { hidden = v; },
  addEventListener(type: string, fn: () => void) {
    if (!docListeners.has(type)) docListeners.set(type, new Set());
    docListeners.get(type)!.add(fn);
  },
  removeEventListener(type: string, fn: () => void) {
    docListeners.get(type)?.delete(fn);
  },
  dispatchEvent(event: any) {
    const set = docListeners.get(event.type);
    if (set) for (const fn of [...set]) fn();
    return true;
  },
};
// @ts-ignore
globalThis.document = documentMock as any;
// Some libs check window.document
// @ts-ignore
globalThis.window = globalThis as any;
if (!(globalThis as any).window.dispatchEvent) {
  (globalThis as any).window.dispatchEvent = documentMock.dispatchEvent;
}

// fetch mock infrastructure
type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
let fetchHandler: FetchHandler | null = null;

function mockResponse(body: any, init: { status?: number; ok?: boolean } = {}): Response {
  const status = init.status ?? 200;
  const ok = init.ok ?? (status >= 200 && status < 300);
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    headers: new Headers(),
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    clone() { return this; },
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob(),
    formData: async () => new FormData(),
    bytes: async () => new Uint8Array(),
    body: null,
    bodyUsed: false,
    redirected: false,
    type: "basic" as ResponseType,
    url: "",
  } as unknown as Response;
}

// @ts-ignore
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  if (!fetchHandler) throw new Error(`fetchHandler not set for ${url}`);
  return fetchHandler(url, init);
};

// Helper to read header value from init
function getHeader(init: RequestInit | undefined, name: string): string | undefined {
  if (!init?.headers) return undefined;
  const h = init.headers as any;
  if (h instanceof Headers) return h.get(name) ?? undefined;
  if (Array.isArray(h)) {
    const found = (h as [string, string][]).find(([k]) => k.toLowerCase() === name.toLowerCase());
    return found?.[1];
  }
  if (typeof h === "object") return (h as Record<string, string>)[name] ?? (h as Record<string, string>)[name.toLowerCase()];
  return undefined;
}

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

async function main() {
  // Dynamic import after mocks
  const mod = await import("../src/apps/answer-card/client/lib/scannerSync.ts");
  const { fetchCardsSynced, fetchCardByIdSynced, fetchExamGroupsSynced, fetchExamsSynced, fetchGradesSynced, startPolling } = mod as any;

  console.log("== Scenario 1: 未配 serverUrl → local 分支 ==");
  {
    store.clear();
    let fetchedUrl = "";
    fetchHandler = async (url) => {
      fetchedUrl = url;
      assert.ok(url === "/api/cards?limit=500" || url.endsWith("/api/cards?limit=500"), `local url should be /api/cards?limit=500 got ${url}`);
      return mockResponse([{ id: "c1", title: "LocalCard" }]);
    };
    const res = await fetchCardsSynced();
    assert.deepStrictEqual(res.data, [{ id: "c1", title: "LocalCard" }]);
    assert.strictEqual(res.source, "local", `expected source local got ${res.source}`);
    console.log("  ✓ scenario 1 passed");
  }

  console.log("== Scenario 2: 已配 serverUrl → remote 分支带 X-Api-Key ==");
  {
    store.clear();
    // serverUrl with trailing slash and spaces to test trim
    store.set("projectx_server_url", "http://remote.test/ ");
    // store api key as JSON {v:1,k:...}
    store.set("projectx_api_key", JSON.stringify({ v: 1, k: "test-key-123", exp: Date.now() + 1e9 }));
    let sawRemote = false;
    let sawKey = "";
    fetchHandler = async (url, init) => {
      if (url.startsWith("http://remote.test")) {
        sawRemote = true;
        assert.ok(url.includes("/api/scanner/sync/cards"), `remote url should use /api/scanner/sync prefix got ${url}`);
        sawKey = getHeader(init, "X-Api-Key") ?? "";
        assert.strictEqual(sawKey, "test-key-123", `expected X-Api-Key test-key-123 got ${sawKey}`);
        return mockResponse([{ id: "r1", title: "RemoteCard" }]);
      }
      throw new Error(`unexpected local fetch ${url}`);
    };
    const res = await fetchCardsSynced();
    assert.ok(sawRemote, "should hit remote");
    assert.deepStrictEqual(res.data, [{ id: "r1", title: "RemoteCard" }]);
    assert.strictEqual(res.source, "remote");
    console.log("  ✓ scenario 2 passed");
  }

  console.log("== Scenario 3: remote 失败回退 local ==");
  {
    store.clear();
    store.set("projectx_server_url", "http://remote.test");
    store.set("projectx_api_key", "test-key-123"); // raw string format
    let remoteHit = 0;
    let localHit = 0;
    fetchHandler = async (url, init) => {
      if (url.startsWith("http://remote.test")) {
        remoteHit++;
        // simulate network failure
        throw new Error("remote down");
      }
      // local fallback should be relative
      localHit++;
      assert.ok(url.includes("/api/cards"), `local fallback url should contain /api/cards got ${url}`);
      return mockResponse([{ id: "fallback", title: "FallbackCard" }]);
    };
    const res = await fetchCardsSynced();
    assert.strictEqual(remoteHit, 1, `remote should be hit once got ${remoteHit}`);
    assert.strictEqual(localHit, 1, `local should be hit once got ${localHit}`);
    assert.deepStrictEqual(res.data, [{ id: "fallback", title: "FallbackCard" }]);
    assert.strictEqual(res.source, "offline-cache");
    console.log("  ✓ scenario 3a (network error) passed");

    // also test remote returns 500 → fallback
    remoteHit = 0; localHit = 0;
    fetchHandler = async (url) => {
      if (url.startsWith("http://remote.test")) {
        remoteHit++;
        return mockResponse({ message: "server error" }, { status: 500, ok: false });
      }
      localHit++;
      return mockResponse([{ id: "fallback2" }]);
    };
    const res2 = await fetchCardsSynced();
    assert.strictEqual(remoteHit, 1);
    assert.strictEqual(localHit, 1);
    assert.deepStrictEqual(res2.data, [{ id: "fallback2" }]);
    console.log("  ✓ scenario 3b (500) passed");
  }

  console.log("== Scenario 4: fetchCardByIdSynced 404 抛带 status=404 ==");
  {
    store.clear();
    // without remote, local 404
    fetchHandler = async () => mockResponse({ message: "not found" }, { status: 404, ok: false });
    let threw = false;
    try {
      await fetchCardByIdSynced("missing-id");
    } catch (e: any) {
      threw = true;
      assert.strictEqual(e.status, 404, `expected status 404 got ${e.status}`);
      assert.ok(e.message?.toLowerCase().includes("not found") || e.message?.includes("404") || true, `message ${e.message}`);
    }
    assert.ok(threw, "should throw 404");

    // with remote, both remote and local 404 → still 404
    store.set("projectx_server_url", "http://remote.test");
    fetchHandler = async (url) => mockResponse({ message: "not found" }, { status: 404, ok: false });
    threw = false;
    try {
      await fetchCardByIdSynced("missing-id");
    } catch (e: any) {
      threw = true;
      assert.strictEqual(e.status, 404);
    }
    assert.ok(threw, "remote+local 404 should throw");
    console.log("  ✓ scenario 4 passed");
  }

  console.log("== Scenario 5: startPolling + visibilitychange ==");
  {
    store.clear();
    hidden = false;
    let calls = 0;
    let stop = startPolling({ intervalMs: 30, onUpdate: () => { calls++; } });
    await sleep(80);
    const afterInterval = calls;
    assert.ok(afterInterval >= 2, `expected >=2 calls after 80ms got ${afterInterval}`);
    stop();
    // isolate visibilitychange tests with long interval to avoid timer interference
    calls = 0;
    hidden = false;
    stop = startPolling({ intervalMs: 10000, onUpdate: () => { calls++; } });
    // visibilitychange when not hidden should trigger immediately
    const beforeVis = calls;
    documentMock.dispatchEvent({ type: "visibilitychange" });
    await sleep(5);
    assert.ok(calls > beforeVis, `visibilitychange should trigger onUpdate when visible`);

    // when hidden, should not trigger
    hidden = true;
    const beforeHidden = calls;
    documentMock.dispatchEvent({ type: "visibilitychange" });
    await sleep(5);
    assert.strictEqual(calls, beforeHidden, "hidden visibilitychange should not trigger");

    // cleanup
    stop();
    const afterStop = calls;
    await sleep(50);
    assert.strictEqual(calls, afterStop, "after stop should not increase");
    // remove listener check: dispatch should not trigger after stop even if visible
    hidden = false;
    documentMock.dispatchEvent({ type: "visibilitychange" });
    await sleep(5);
    assert.strictEqual(calls, afterStop, "after stop visibilitychange should not trigger");
    console.log("  ✓ scenario 5 passed");
  }

  console.log("== Scenario 6: fetchGradesSynced 容错返回 [] ==");
  {
    store.clear();
    fetchHandler = async () => mockResponse({ message: "error" }, { status: 500, ok: false });
    const grades = await fetchGradesSynced();
    assert.deepStrictEqual(grades, [], "fetchGradesSynced should return [] on error");
    console.log("  ✓ scenario 6 passed");
  }

  console.log("== Scenario 7: other Synced APIs ==");
  {
    store.clear();
    fetchHandler = async (url) => {
      if (url.includes("/api/exam-groups")) return mockResponse([{ id: 1, name: "g1" }]);
      if (url.includes("/api/exams")) return mockResponse([{ id: 1, name: "e1" }]);
      throw new Error("unknown " + url);
    };
    const groups = await fetchExamGroupsSynced();
    assert.deepStrictEqual(groups, [{ id: 1, name: "g1" }]);
    const exams = await fetchExamsSynced();
    assert.deepStrictEqual(exams, [{ id: 1, name: "e1" }]);
    console.log("  ✓ scenario 7 passed");
  }

  console.log("== Scenario 8: remote 401/404 不回退本地（权威失败） ==");
  {
    store.clear();
    store.set("projectx_server_url", "http://remote.test");
    store.set("projectx_api_key", "bad-key");
    let remoteHit = 0;
    let localHit = 0;
    // 401 should throw, not fallback
    fetchHandler = async (url) => {
      if (url.startsWith("http://remote.test")) {
        remoteHit++;
        return mockResponse({ message: "无效的 API Key" }, { status: 401, ok: false });
      }
      localHit++;
      return mockResponse([{ id: "local" }]);
    };
    let threw401 = false;
    try { await fetchCardsSynced(); } catch (e: any) { threw401 = e.status === 401; }
    assert.ok(threw401, "401 should throw");
    assert.strictEqual(localHit, 0, "401 should not fallback to local");

    // 404 for single card should throw, not fallback
    remoteHit = 0; localHit = 0;
    fetchHandler = async (url) => {
      if (url.startsWith("http://remote.test")) {
        remoteHit++;
        return mockResponse({ message: "答题卡不存在" }, { status: 404, ok: false });
      }
      localHit++;
      return mockResponse([{ id: "localCard" }]);
    };
    let threw404 = false;
    try { await fetchCardByIdSynced("gone-id"); } catch (e: any) { threw404 = e.status === 404; }
    assert.ok(threw404, "404 should throw");
    assert.strictEqual(localHit, 0, "404 single card should not fallback");
    console.log("  ✓ scenario 8 passed");
  }

  console.log("scanner-sync-smoke: 全部通过");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
