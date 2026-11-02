/**
 * 构建元信息与「服务器更新时间」接口回归。
 *
 * 覆盖三件事（都是这条链路上真正会出错的地方）：
 *  1. 归一化：缺构建时间的文件视为不可用，不能退回当前时间；提交短号缺失时从完整号推。
 *  2. 构建侧：`collectBuildInfo` + `writeBuildInfoFile` 产出的文件，读取端要能原样读回。
 *  3. 实际 HTTP 路径：未登录被挡；管理员拿到的版本与构建时间和盘上一致；没有构建信息时
 *     如实返回 null + 原因，且整份响应不外泄目录细节。
 *
 * 运行：npm run verify:build-info
 * 隔离：临时 SQLite 库、临时数据目录、临时 token 目录，不碰仓库 data/ 与 config.yml。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results: string[] = [];
let failures = 0;

function ok(condition: boolean, label: string): void {
  if (condition) {
    results.push(label);
    return;
  }
  failures += 1;
  console.error(`  ✗ ${label}`);
}

function section(title: string): void {
  console.log(`\n── ${title}`);
}

// 隔离目录：先把数据与库落在临时目录，避免读到仓库里指向远端库的 config.yml。
const tmpDir = mkdtempSync(path.join(os.tmpdir(), "projectx-build-info-"));
process.env.PROJECTX_DB_PATH = path.join(tmpDir, "build-info.db");
process.env.PROJECTX_TOKEN_DIR = path.join(tmpDir, "tokens");
process.env.ANSWER_CARD_DATA_DIR = path.join(tmpDir, "data");
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PROJECTX_MARIADB_") || key.startsWith("PROJECTX_MYSQL_")) delete process.env[key];
}

const { normalizeBuildInfo, BUILD_INFO_SCHEMA } = await import("../src/shared/buildInfo");
const { collectBuildInfo, writeBuildInfoFile } = await import("./lib/build-info");
const buildInfoStore = await import("../src/server/lib/buildInfo");

/** 让读取端重新按当前环境变量定位文件（运行期只读一次并缓存，测试里需要显式重来）。 */
function readFromEnv(): { info: ReturnType<typeof normalizeBuildInfo>; path: string | null; reason: string | null } {
  buildInfoStore.resetBuildInfoCache();
  return buildInfoStore.readBuildInfo();
}

/** 第 2 段构建出的那份文件，第 3 段当作「部署包已就位」再读一遍。 */
let builtInfo!: ReturnType<typeof collectBuildInfo>;
let builtFile = "";

// ── 1. 归一化 ────────────────────────────────────────────
section("构建信息归一化");
{
  ok(normalizeBuildInfo(null) === null, "null 输入视为无构建信息");
  ok(normalizeBuildInfo({ version: "2.7.1" }) === null, "缺 builtAt 的字段不完整，判为不可用（不退回当前时间）");
  ok(normalizeBuildInfo({ builtAt: "不是时间" }) === null, "builtAt 不可解析时判为不可用");
  const wrongType = normalizeBuildInfo({ builtAt: "2026-11-02T00:00:00.000Z", version: 3 });
  ok(wrongType !== null && wrongType.version === null, "version 类型不对时归 null，不转成字符串");

  const full = normalizeBuildInfo({
    schema: BUILD_INFO_SCHEMA,
    version: "2.7.1",
    commit: "51faeb4de788c46808151f24c9e38b4cedd1eacc",
    commitDirty: false,
    builtAt: "2026-11-02T00:00:00Z",
    builder: "node v22.23.4 / linux-x64",
    unexpected: "应被丢弃",
  });
  ok(full?.commitShort === "51faeb4", "commitShort 缺失时从完整提交号推出");
  ok(full?.builtAt === "2026-11-02T00:00:00.000Z", "builtAt 归一化为 ISO UTC");
  ok(full !== null && !("unexpected" in full), "未知字段不带进响应");
  ok(normalizeBuildInfo({ builtAt: "2026-11-02T00:00:00Z", commitDirty: true })?.commitDirty === true,
    "commitDirty=true 如实保留（不能当成干净的构建）");
  ok(normalizeBuildInfo({ builtAt: "2026-11-02T00:00:00Z" })?.commitDirty === null,
    "commitDirty 缺失是「未记录」，不是「干净」");
}

// ── 2. 构建侧写盘 → 读取端读回 ───────────────────────────
section("构建侧写盘与读取端读回");
{
  const packageVersion = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version;
  const outDir = path.join(tmpDir, "dist", "server");
  builtInfo = collectBuildInfo(root);
  builtFile = writeBuildInfoFile(root, builtInfo, outDir);
  const info = builtInfo;
  const file = builtFile;
  ok(existsSync(file), "build-info.json 落在 dist/server/ 下（与服务端产物同目录，随部署包带走）");
  ok(info.version === packageVersion, `版本取自 package.json（${info.version}）`);
  ok(info.schema === BUILD_INFO_SCHEMA, "写入的结构版本与共享契约一致");
  ok(!Number.isNaN(new Date(info.builtAt).getTime()), "builtAt 可解析");
  ok(typeof info.commitDirty === "boolean", "在 git 仓库内构建能判定工作区是否干净");

  process.env.PROJECTX_BUILD_INFO_PATH = file;
  const read = readFromEnv();
  ok(read.info !== null && read.info.builtAt === info.builtAt, "读取端原样读回构建时间");
  ok(read.path === file && read.reason === null, "读到的文件路径与「无异常」原因一致");

  const broken = path.join(tmpDir, "broken-info.json");
  writeFileSync(broken, "{ not json", "utf8");
  process.env.PROJECTX_BUILD_INFO_PATH = broken;
  const brokenRead = readFromEnv();
  ok(brokenRead.info === null && typeof brokenRead.reason === "string" && brokenRead.reason !== "",
    "内容损坏时返回 null + 可读原因");
  ok(brokenRead.info === null && !String(brokenRead.reason ?? "").includes(tmpDir),
    "损坏原因只带文件名与错误类别，不回传目录");

  const stale = path.join(tmpDir, "stale-info.json");
  writeFileSync(stale, JSON.stringify({ version: "1.0.0" }), "utf8");
  process.env.PROJECTX_BUILD_INFO_PATH = stale;
  ok(readFromEnv().info === null, "旧版产物缺 builtAt 时判为不可用，不显示半截信息");

  const huge = path.join(tmpDir, "huge-info.json");
  writeFileSync(huge, JSON.stringify({ builtAt: "2026-11-02T00:00:00Z", pad: "x".repeat(70 * 1024) }), "utf8");
  process.env.PROJECTX_BUILD_INFO_PATH = huge;
  ok(readFromEnv().info === null, "超过体积上限的文件按不可信内容忽略");

  process.env.PROJECTX_BUILD_INFO_PATH = path.join(tmpDir, "does-not-exist.json");
  const missing = readFromEnv();
  ok(missing.info === null && missing.path === null, "文件不存在时不猜测构建时间");
  ok(missing.info === null && String(missing.reason).includes("指定的构建信息文件不存在"),
    "显式指定的路径缺失时直说，不静默改用别的候选文件");
  ok(!String(missing.reason ?? "").includes(tmpDir), "缺失原因不回传临时目录路径");
}

// ── 3. 实际 HTTP 路径 ────────────────────────────────────
section("管理员控制台接口的真实行为");
{
  const originalCwd = process.cwd();
  // 服务端按 cwd 解析 config.yml；切到没有该文件的临时目录，保证走本地 SQLite。
  mkdirSync(path.join(tmpDir, "run"), { recursive: true });
  process.chdir(path.join(tmpDir, "run"));
  delete process.env.PROJECTX_BUILD_INFO_PATH;

  const { initializeDatabase, ensureDefaultAdmin, closeDatabase, getMysqlDb } = await import("../src/server/db/index");
  const { authService } = await import("../src/server/services/AuthService");
  const { loadRolePermissions } = await import("../src/server/auth/permissions");
  initializeDatabase();
  const bootstrap = await ensureDefaultAdmin();
  loadRolePermissions(true);
  const adminPassword = readFileSync(bootstrap.passwordFile, "utf8").trim();
  // 一次性初始口令处于强制改密状态，未改密前所有管理接口都是 428，先把口令换掉再取令牌。
  const adminRow = await getMysqlDb().get<{ id: number }>("SELECT id FROM users WHERE username = 'admin'");
  assert.ok(adminRow, "默认管理员应存在");
  const changed = await authService.changePassword(adminRow.id, adminPassword, "BuildInfo-Verify-2026");
  assert.ok(changed.success, "默认管理员应能改掉一次性口令");
  const adminLogin = await authService.login("admin", "BuildInfo-Verify-2026");
  assert.ok(adminLogin.success && adminLogin.token, "管理员改密后应能登录");

  const { createApp } = await import("../src/apps/answer-card/server/index");
  const server = createServer(await createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const adminHeaders = { Authorization: `Bearer ${adminLogin.token}` };

  const anonymous = await fetch(`${base}/api/admin/console/build`);
  ok(anonymous.status === 401 || anonymous.status === 403, `未登录访问被拒（${anonymous.status}）`);

  // 部署包就位：构建信息就是第 2 段写出的那份文件。
  process.env.PROJECTX_BUILD_INFO_PATH = builtFile;
  buildInfoStore.resetBuildInfoCache();
  const adminRes = await fetch(`${base}/api/admin/console/build`, { headers: adminHeaders });
  const body = await adminRes.json() as {
    ok: boolean;
    build: { version: string | null; builtAt: string; commitShort: string | null } | null;
    buildInfoFile: string | null;
    reason: string | null;
    runtime?: { startedAt: string; uptimeSeconds: number; node: string; platform: string };
  };
  ok(adminRes.status === 200 && body.ok === true, "管理员访问返回 200");
  ok(body.build?.version === builtInfo.version, "响应的版本与盘上一致");
  ok(body.build?.builtAt === builtInfo.builtAt, "响应的构建时间就是那次构建，不是请求时间");
  ok(body.buildInfoFile === "build-info.json", "只回文件名，不回绝对路径");
  ok(!String(body.buildInfoFile ?? "").includes(path.sep), "响应不含目录分隔符");
  ok(typeof body.runtime?.startedAt === "string" && new Date(body.runtime.startedAt).getTime() > 0, "返回本次启动时间");
  ok((body.runtime?.uptimeSeconds ?? -1) >= 0, "返回运行时长");
  ok(body.runtime?.node === process.version, "运行环境里的 Node 版本来自进程本身");
  ok(adminRes.headers.get("cache-control") === "no-store", `响应不被缓存（${adminRes.headers.get("cache-control")}）`);

  // 源码直跑 / 旧部署包：200 + null + 原因，界面据此显示「—」而不是编造时间。
  process.env.PROJECTX_BUILD_INFO_PATH = path.join(tmpDir, "absent.json");
  buildInfoStore.resetBuildInfoCache();
  const noBuild = await fetch(`${base}/api/admin/console/build`, { headers: adminHeaders });
  const noBuildBody = await noBuild.json() as { build: unknown; reason: string | null };
  ok(noBuild.status === 200 && noBuildBody.build === null, "无构建信息时返回 200 + null，不报 500");
  ok(typeof noBuildBody.reason === "string" && noBuildBody.reason !== "", "无构建信息时给出原因");
  ok(!JSON.stringify(noBuildBody).includes(tmpDir), "整份响应不含临时目录路径");

  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  closeDatabase();
  process.chdir(originalCwd);
}

rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n通过 ${results.length} 项，失败 ${failures} 项。`);
if (failures > 0) process.exit(1);
