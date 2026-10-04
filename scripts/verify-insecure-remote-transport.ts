// 安全（R32）回归：跨机明文 HTTP 上不得发送账号与 API Key，回环与 https 照常可用。
//
// 分两层：
//   1) 纯函数判定（不依赖浏览器）——白名单粒度、回环识别、无法解析时的失败闭合；
//   2) 真实 HTTP——在本机起一个 http 服务，分别用「回环地址」与「本机局域网地址」访问，
//      断言明文跨机时 X-Api-Key 根本没出进程（服务端收到的请求数为 0），
//      以及不带凭据的健康探测仍然放行。第 2 层是这条整改的验收要求本身：
//      「跨机明文 HTTP 默认不发送账号/Key；127.0.0.1 本地模式保持可用」。
//
// 源码不退化断言放在 scripts/verify-security-critical.ts（R32 段）。
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import {
  evaluateCredentialTransport,
  hasInsecureTransportAllowance,
  insecureTransportMessage,
  isInsecureRemoteTarget,
  isLoopbackHost,
  parseServerTarget,
} from "../src/apps/answer-card/client/lib/remoteCredentialTransport";

let passed = 0;
const failures: string[] = [];
function check(condition: unknown, label: string): void {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
  }
}

/** 最小 localStorage 替身：被测模块在调用时才读全局，因此先装好再 import。 */
function installStorageShim(): void {
  const store = new Map<string, string>();
  const shim = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
  const target = globalThis as Record<string, unknown>;
  if (typeof target.localStorage === "undefined") target.localStorage = shim;
  if (typeof target.window === "undefined") target.window = { dispatchEvent: () => true };
}

function lanAddress(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

async function main(): Promise<void> {
  installStorageShim();

  console.log("\n[1] 纯函数判定：https / 回环 / 跨机明文 / 无法解析");

  check(parseServerTarget("https://projectx.school.edu.cn")?.protocol === "https:",
    "https 地址解析出 https 协议");
  check(parseServerTarget("ftp://192.168.1.100/x") === null,
    "非 http(s) 协议解析为 null（不给它任何放行理由）");
  check(parseServerTarget("192.168.1.100:5174") === null,
    "缺 scheme 的裸地址本身解析失败——必须先经 normalizeServerUrl 补全再判定");
  check(parseServerTarget("") === null && parseServerTarget(null) === null && parseServerTarget(undefined) === null,
    "空值解析为 null");

  for (const host of ["localhost", "127.0.0.1", "127.0.0.9", "127.255.255.254", "[::1]", "::1"]) {
    check(isLoopbackHost(host), `回环识别：${host}`);
  }
  for (const host of ["192.168.1.100", "10.0.0.7", "projectx.school.edu.cn", "128.127.0.0.1", "127.1", ""]) {
    check(!isLoopbackHost(host), `非回环（失败闭合）：${host || "<空>"}`);
  }
  check(isLoopbackHost("LOCALHOST") && isLoopbackHost("[::1]"),
    "回环识别大小写与 IPv6 方括号都吃下");

  check(evaluateCredentialTransport("https://projectx.school.edu.cn", []).allowed === true
    && evaluateCredentialTransport("https://projectx.school.edu.cn", []).reason === "https",
    "https 跨机：放行，理由 https");
  check(evaluateCredentialTransport("http://127.0.0.1:5174", []).allowed === true
    && evaluateCredentialTransport("http://127.0.0.1:5174", []).reason === "loopback",
    "明文回环：放行，理由 loopback（本地模式必须照旧可用）");
  check(evaluateCredentialTransport("http://localhost:5174", []).allowed === true,
    "明文 localhost：放行");

  const lan = evaluateCredentialTransport("http://192.168.1.100:5174", []);
  check(lan.allowed === false && lan.reason === "blocked-plaintext",
    "跨机明文 http：默认拒绝发送凭据");
  check(lan.host === "192.168.1.100:5174", "拒绝决定带上 host:port，供界面与白名单使用");
  check(lan.message.includes("192.168.1.100:5174") && lan.message.includes("明文") && lan.message.includes("https"),
    "拒绝话术点名目标地址、说清风险、给出 https 出路");
  check(evaluateCredentialTransport("http://192.168.1.100:5174/", []).host === "192.168.1.100:5174"
    && evaluateCredentialTransport("HTTP://192.168.1.100:5174", []).reason === "blocked-plaintext",
    "尾斜杠与大写 scheme 不会绕开判定");

  check(evaluateCredentialTransport("http://192.168.1.100:5174", ["192.168.1.100:5174"]).allowed === true
    && evaluateCredentialTransport("http://192.168.1.100:5174", ["192.168.1.100:5174"]).reason === "explicit-allowance",
    "显式勾选过的 host:port：放行，理由 explicit-allowance");
  check(evaluateCredentialTransport("http://192.168.1.100:5174", ["192.168.1.100:5175"]).allowed === false,
    "端口不同的勾选不算数（无通配）");
  check(evaluateCredentialTransport("http://192.168.1.101:5174", ["192.168.1.100:5174"]).allowed === false,
    "主机不同的勾选不算数（换服务器不继承同意）");
  check(evaluateCredentialTransport("http://192.168.1.100:5174", ["192.168.1.100"]).allowed === false,
    "缺端口的勾选不算数：URL.host 对默认端口会省略，写死 host:port 才对得上");
  check(hasInsecureTransportAllowance("http://10.0.0.7:5174", ["10.0.0.7:5174"]) === true
    && hasInsecureTransportAllowance("not a url", ["not a url"]) === false,
    "白名单比对走同一套解析，无法解析的地址即便字面相同也不算勾选");

  const unparsable = evaluateCredentialTransport("192.168.1.100:5174", ["192.168.1.100:5174"]);
  check(unparsable.allowed === false && unparsable.reason === "unparsable",
    "无法解析的地址：拒绝（宁可不发，也不把 Key 送进看不懂的目标）");
  check(evaluateCredentialTransport("", []).reason === "unparsable"
    && evaluateCredentialTransport("", []).allowed === false,
    "空地址：拒绝");

  check(isInsecureRemoteTarget("http://192.168.1.100:5174") === true
    && isInsecureRemoteTarget("http://127.0.0.1:5174") === false
    && isInsecureRemoteTarget("https://192.168.1.100:5174") === false
    && isInsecureRemoteTarget("") === false,
    "isInsecureRemoteTarget 只在「跨机 + 明文」时为真");
  check(insecureTransportMessage("10.0.0.7:5174").includes("10.0.0.7:5174"),
    "话术生成器把目标地址原样带回，便于老师核对是不是自己填的那台");

  console.log("\n[2] 真实 HTTP：明文凭据不出进程，回环与不带凭据的探测照常");

  const seen: Array<{ url: string; apiKey: string | null; auth: string | null; from: string }> = [];
  const server = http.createServer((req, res) => {
    seen.push({
      url: req.url ?? "",
      apiKey: (req.headers["x-api-key"] as string | undefined) ?? null,
      auth: (req.headers.authorization as string | undefined) ?? null,
      from: (req.socket.remoteAddress ?? "").replace("::ffff:", ""),
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, capabilities: { scannerClientApi: true } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const port = (server.address() as { port: number }).port;

  const { remoteScannerFetch, storeApiKey } = await import("../src/apps/answer-card/client/auth/api");
  const {
    grantInsecureTransportAllowance,
    readInsecureTransportHosts,
    revokeInsecureTransportAllowance,
    INSECURE_TRANSPORT_HOSTS_KEY,
  } = await import("../src/apps/answer-card/client/lib/remoteCredentialTransport");
  const { writeServerUrl } = await import("../src/apps/answer-card/client/lib/scannerMode");

  const lanIp = lanAddress();
  const insecureBase = `http://${lanIp ?? "192.0.2.1"}:${port}`;
  const loopbackBase = `http://127.0.0.1:${port}`;
  const KEY = "sk-verify-r32-do-not-send";

  try {
    // ── 跨机明文：带 Key 的请求必须在发出之前被拦下 ──
    revokeInsecureTransportAllowance();
    writeServerUrl(insecureBase);
    storeApiKey(KEY);
    seen.length = 0;
    const blocked = await remoteScannerFetch("/api/scanner/upload/check").then(
      () => null,
      (error: unknown) => error as Error & { code?: string; noRetry?: boolean },
    );
    check(blocked !== null, "跨机明文 + 已存 API Key：请求被拒绝（没有拿到响应）");
    check((blocked as { code?: string } | null)?.code === "INSECURE_REMOTE_TRANSPORT_BLOCKED",
      "拒绝原因是 INSECURE_REMOTE_TRANSPORT_BLOCKED，而不是网络错误");
    check((blocked as { noRetry?: boolean } | null)?.noRetry === true,
      "拒绝带 noRetry：上传队列按配置错误立即失败，不当网络抖动重试");
    check(String((blocked as Error | null)?.message ?? "").includes("https"),
      "拒绝信息里给了 https 这条出路");
    check(seen.length === 0, `服务端一个请求都没收到（实际 ${seen.length} 个）——Key 根本没出进程`);

    // ── 不带凭据的健康探测仍然放行：界面才能区分「不可达」与「被拦下」 ──
    storeApiKey(null);
    seen.length = 0;
    const probe = await remoteScannerFetch("/api/app/health");
    check(probe.ok === true && seen.length === 1 && seen[0]?.apiKey === null,
      "无 Key 的健康探测照常发出且不带凭据");

    // ── 显式勾选后：同一个明文地址允许发送 Key（内网测试环境的出路） ──
    const grantedHost = grantInsecureTransportAllowance(insecureBase);
    check(readInsecureTransportHosts().includes(grantedHost) && grantedHost.length > 0,
      "勾选按 host:port 落盘");
    storeApiKey(KEY);
    seen.length = 0;
    const allowed = await remoteScannerFetch("/api/scanner/upload/check");
    check(allowed.ok === true && seen.length === 1 && seen[0]?.apiKey === KEY,
      "勾选后同一地址可以发送 Key（出路是显式的，不是偷偷放行）");

    // ── 撤销勾选：立刻回到拒绝态 ──
    revokeInsecureTransportAllowance(insecureBase);
    check(readInsecureTransportHosts().length === 0, "撤销后白名单为空");
    seen.length = 0;
    const blockedAgain = await remoteScannerFetch("/api/scanner/upload/check").then(
      () => null,
      (error: unknown) => error as Error,
    );
    check(blockedAgain !== null && seen.length === 0,
      "撤销勾选后明文跨机重新被拦下（同意不是一次性的永久许可）");

    // ── 回环：本地模式必须完全不受影响 ──
    revokeInsecureTransportAllowance();
    writeServerUrl(loopbackBase);
    storeApiKey(KEY);
    seen.length = 0;
    const local = await remoteScannerFetch("/api/scanner/upload/check");
    check(local.ok === true && seen.length === 1 && seen[0]?.apiKey === KEY,
      "127.0.0.1 明文照常发送 Key（本地模式未被这条整改波及）");
    check(readInsecureTransportHosts().length === 0,
      "回环不需要、也没有产生任何明文白名单记录");

    // ── 归一化后的地址才进判定：v2.5.6「缺 scheme 自动补 http://」的现场修复不能回退 ──
    writeServerUrl(`${lanIp ?? "192.0.2.1"}:${port}`);
    check(readInsecureTransportHosts().length === 0
      && await remoteScannerFetch("/api/scanner/upload/check").then(() => false, () => true),
      "老师只填 IP:端口时会被补成明文 http，因而同样落在拒绝态（不是绕开闸门的后门）");

    // ── 白名单脏值：存进去的垃圾不能变成放行理由 ──
    (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
      INSECURE_TRANSPORT_HOSTS_KEY, JSON.stringify({ not: "an array" }),
    );
    check(readInsecureTransportHosts().length === 0, "白名单脏值（非数组）当作没有勾选");
    (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
      INSECURE_TRANSPORT_HOSTS_KEY, JSON.stringify([123, null, "", "ok:1"]),
    );
    check(JSON.stringify(readInsecureTransportHosts()) === JSON.stringify(["ok:1"]),
      "白名单里的非字符串项被丢掉，只留合法 host:port");
    revokeInsecureTransportAllowance();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  if (!lanIp) {
    console.log("  （提示：本机没有非回环 IPv4 地址，跨机用例用 192.0.2.1 代替——判定仍在发出前完成，结论不变）");
  }

  console.log("\n[3] 文档不再教人填明文跨机地址");
  const docs = [
    "user guide/Project-X用户使用说明.md",
    "readus/SCANNER-SETUP.md",
    "readus/多端使用说明.md",
  ];
  for (const doc of docs) {
    const text = readFileSync(path.resolve(doc), "utf8");
    // 只禁「照抄就能用」的示例：带真实数字八位组的明文内网地址。
    // 讲解口径时写 `http://192.168.x.x:5174`（占位 x）是在说明被拦下的那种地址，不算示例。
    check(!/http:\/\/192\.168\.\d{1,3}\.\d{1,3}/.test(text) && !/http:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(text),
      `${doc} 里没有「照抄就能用」的明文内网地址示例`);
    check(/https:\/\//.test(text), `${doc} 给出的服务器地址示例是 https`);
    check(text.includes("R32") || text.includes("明文"),
      `${doc} 写清了跨机明文 HTTP 的口径（含勾选许可）`);
  }

  console.log(`\n跨机明文 HTTP 凭据闸门（R32）：${passed} 通过，${failures.length} 失败`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
