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
  const { fetchCardsSynced, fetchCardDetailSynced, fetchExamGroupsSynced, fetchExamsSynced, fetchGradesSynced, startPolling, importCardLocally } = mod as any;
  // 安全 R35 之后卡详情只暴露 fetchCardDetailSynced（必须交回 source/stale），旧名已删除
  assert.strictEqual(typeof fetchCardDetailSynced, "function", "fetchCardDetailSynced 应存在（R35 之后不再有 fetchCardByIdSynced）");
  assert.strictEqual(mod.fetchCardByIdSynced, undefined, "旧的 fetchCardByIdSynced 不应复活（它会丢掉来源信息）");

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
    store.set("projectx_server_url", "https://remote.test/ ");
    // store api key as JSON {v:1,k:...}
    store.set("projectx_api_key", JSON.stringify({ v: 1, k: "test-key-123", exp: Date.now() + 1e9 }));
    let sawRemote = false;
    let sawKey = "";
    fetchHandler = async (url, init) => {
      if (url.startsWith("https://remote.test")) {
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
    store.set("projectx_server_url", "https://remote.test");
    store.set("projectx_api_key", "test-key-123"); // raw string format
    let remoteHit = 0;
    let localHit = 0;
    fetchHandler = async (url, init) => {
      if (url.startsWith("https://remote.test")) {
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
      if (url.startsWith("https://remote.test")) {
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

  console.log("== Scenario 4: fetchCardDetailSynced 404 抛带 status=404，且必须交出来源（R35） ==");
  {
    store.clear();
    // 未配远端：本机 404 直接抛
    fetchHandler = async () => mockResponse({ message: "not found" }, { status: 404, ok: false });
    let threw = false;
    try {
      await fetchCardDetailSynced("missing-id");
    } catch (e: any) {
      threw = true;
      assert.strictEqual(e.status, 404, `expected status 404 got ${e.status}`);
    }
    assert.ok(threw, "本机 404 应抛出");

    // 已配远端：远端 404 是「权威说这卡没了」，不能拿本机旧卡顶上
    store.set("projectx_server_url", "https://remote.test");
    let localHit = 0;
    fetchHandler = async (url) => {
      if (url.startsWith("https://remote.test")) {
        return mockResponse({ message: "not found" }, { status: 404, ok: false });
      }
      localHit++;
      return mockResponse({ id: "stale-local-card" });
    };
    threw = false;
    try {
      await fetchCardDetailSynced("missing-id");
    } catch (e: any) {
      threw = true;
      assert.strictEqual(e.status, 404, `远端 404 应带 status=404 got ${e.status}`);
      assert.strictEqual(e.remoteNotFound, true, "远端 404 应带 remoteNotFound，供调用方区分「没同步」与「卡被删」");
    }
    assert.ok(threw, "remote 404 should throw");
    assert.strictEqual(localHit, 0, "远端 404 不应回退本机");

    // 远端网络故障：允许回退本机缓存，但 source/stale 必须说实话
    localHit = 0;
    fetchHandler = async (url) => {
      if (url.startsWith("https://remote.test")) throw new Error("remote down");
      localHit++;
      return mockResponse({ id: "cached-card" });
    };
    const detail = await fetchCardDetailSynced("cached-id");
    assert.strictEqual(localHit, 1, "远端网络故障应回退本机");
    assert.strictEqual(detail.source, "offline-cache", `来源应为 offline-cache got ${detail.source}`);
    assert.strictEqual(detail.stale, true, "回退到缓存时 stale 必须为 true（选择页据此拦截）");
    assert.strictEqual(detail.card?.id, "cached-card");

    // 远端正常：source=remote，不得把新鲜数据标成 stale
    fetchHandler = async (url) => {
      if (url.startsWith("https://remote.test")) return mockResponse({ id: "fresh-card" });
      throw new Error(`unexpected local fetch ${url}`);
    };
    const fresh = await fetchCardDetailSynced("fresh-id");
    assert.strictEqual(fresh.source, "remote");
    assert.strictEqual(fresh.stale, false, "远端返回的数据 stale 必须为 false");
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
    store.set("projectx_server_url", "https://remote.test");
    store.set("projectx_api_key", "bad-key");
    let remoteHit = 0;
    let localHit = 0;
    // 401 should throw, not fallback
    fetchHandler = async (url) => {
      if (url.startsWith("https://remote.test")) {
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
      if (url.startsWith("https://remote.test")) {
        remoteHit++;
        return mockResponse({ message: "答题卡不存在" }, { status: 404, ok: false });
      }
      localHit++;
      return mockResponse([{ id: "localCard" }]);
    };
    let threw404 = false;
    try { await fetchCardDetailSynced("gone-id"); } catch (e: any) { threw404 = e.status === 404; }
    assert.ok(threw404, "404 should throw");
    assert.strictEqual(localHit, 0, "404 single card should not fallback");
    console.log("  ✓ scenario 8 passed");
  }

  console.log("== Scenario 9: importCardLocally 把(远端)卡 upsert 进本机库 ==");
  {
    // 成功：PUT /api/cards/:id 携带完整卡 JSON（幂等 upsert，保留原 id）
    let putUrl = "";
    let putMethod = "";
    let putBody: any = null;
    fetchHandler = async (url, init) => {
      putUrl = url;
      putMethod = init?.method ?? "GET";
      putBody = init?.body ? JSON.parse(String(init.body)) : null;
      return mockResponse({ id: "CARD-A" });
    };
    const card = { id: "CARD-A", title: "远端新建卡", subject: "math" };
    await importCardLocally(card as any);
    assert.ok(putUrl.startsWith("/api/cards/CARD-A"), `PUT url 应为本机卡路径, got ${putUrl}`);
    assert.strictEqual(putMethod, "PUT");
    assert.strictEqual(putBody?.id, "CARD-A");
    assert.strictEqual(putBody?.title, "远端新建卡");

    // 失败：500 → 抛 status=500（调用方留在选择页提示，避免进工作台后阅卷 404）
    fetchHandler = async () => mockResponse({ message: "导入失败" }, { status: 500, ok: false });
    let threw500 = false;
    try { await importCardLocally(card as any); } catch (e: any) { threw500 = e.status === 500; }
    assert.ok(threw500, "导入失败应抛 status=500");
    console.log("  ✓ scenario 9 passed");
  }

  console.log("== Scenario 10: 跨机明文 HTTP（安全 R32）→ 不发 Key、不静默回退本地 ==");
  {
    store.clear();
    store.set("projectx_server_url", "http://192.0.2.10:5174");
    store.set("projectx_api_key", JSON.stringify({ v: 1, k: "test-key-123", exp: Date.now() + 1e9 }));
    let remoteHit = 0;
    let localHit = 0;
    fetchHandler = async (url) => {
      if (url.startsWith("http://192.0.2.10")) { remoteHit++; return mockResponse([{ id: "r1" }]); }
      localHit++;
      return mockResponse([{ id: "local" }]);
    };
    let blocked: any = null;
    try { await fetchCardsSynced(); } catch (e: any) { blocked = e; }
    assert.ok(blocked, "跨机明文应抛错，而不是静默回退本机缓存（回退会让老师误以为同步正常）");
    assert.strictEqual(blocked.code, "INSECURE_REMOTE_TRANSPORT_BLOCKED", `expected gate code got ${blocked.code}`);
    assert.strictEqual(blocked.noRetry, true, "闸门错误应标记 noRetry，让上传队列按配置错误处理");
    assert.ok(String(blocked.message).includes("https"), `错误信息应给出 https 出路: ${blocked.message}`);
    assert.strictEqual(remoteHit, 0, "API Key 不应出进程：远端一个请求都不该收到");
    assert.strictEqual(localHit, 0, "也不该悄悄回退本地");
    console.log("  ✓ scenario 10a (blocked, no credential left the process) passed");

    // 显式勾选该 host:port 后：同一地址恢复远端同步（出路是显式的，不是偷偷放行）
    store.set("projectx_insecure_http_hosts", JSON.stringify(["192.0.2.10:5174"]));
    remoteHit = 0; localHit = 0;
    const granted = await fetchCardsSynced();
    assert.strictEqual(remoteHit, 1, "勾选后应真的发出远端请求");
    assert.strictEqual(granted.source, "remote");
    console.log("  ✓ scenario 10b (explicit allowance restores sync) passed");

    // 回环明文不受限：单机模式必须照旧可用
    store.clear();
    store.set("projectx_server_url", "http://127.0.0.1:5174");
    store.set("projectx_api_key", "test-key-123");
    let loopbackKey = "";
    fetchHandler = async (url, init) => {
      if (url.startsWith("http://127.0.0.1")) {
        loopbackKey = getHeader(init, "X-Api-Key") ?? "";
        return mockResponse([{ id: "loop" }]);
      }
      throw new Error(`unexpected local fetch ${url}`);
    };
    const loopRes = await fetchCardsSynced();
    assert.strictEqual(loopRes.source, "remote");
    assert.strictEqual(loopbackKey, "test-key-123", "回环明文照常带 Key（本地模式未被 R32 波及）");
    console.log("  ✓ scenario 10c (loopback plaintext unaffected) passed");
  }

  console.log("scanner-sync-smoke: 全部通过");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
