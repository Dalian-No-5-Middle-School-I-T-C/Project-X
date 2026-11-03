/**
 * 构建元信息与「服务器更新时间」接口回归。
 *
 * 覆盖四件事（都是这条链路上真正会出错的地方）：
 *  1. 归一化：缺构建时间的文件视为不可用，不能退回当前时间；提交短号缺失时从完整号推。
 *  2. 构建侧：`collectBuildInfo` + `writeBuildInfoFile` 产出的文件，读取端要能原样读回。
 *  3. 工作区状态：干净 / 有改动 / 取不到 git 三种结论要能区分（CI 检出永远干净）。
 *  4. 实际 HTTP 路径：未登录与教师被挡；管理员拿到的版本与构建时间和盘上一致；没有构建信息时
 *     如实返回 null + 原因，且整份响应不外泄目录细节。
 *
 * 运行：npm run verify:build-info
 * 隔离：临时 SQLite 库、临时数据目录、临时 token 目录，不碰仓库 data/ 与 config.yml。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  // 结构版本按白名单判定：不认识的一律不读，避免按字段猜旧/新语义。
  ok(normalizeBuildInfo({ builtAt: "2026-11-02T00:00:00Z" }) === null, "缺 schema 的构建信息判为不可用");
  ok(normalizeBuildInfo({ schema: 2, builtAt: "2026-11-02T00:00:00Z" }) === null, "结构版本比当前代码新时不猜着读");
  ok(normalizeBuildInfo({ schema: "1", builtAt: "2026-11-02T00:00:00Z" }) === null, "schema 类型不对（字符串）同样不接受");
  const wrongType = normalizeBuildInfo({ schema: BUILD_INFO_SCHEMA, builtAt: "2026-11-02T00:00:00.000Z", version: 3 });
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
  ok(normalizeBuildInfo({ schema: BUILD_INFO_SCHEMA, builtAt: "2026-11-02T00:00:00Z", commitDirty: true })?.commitDirty === true,
    "commitDirty=true 如实保留（不能当成干净的构建）");
  ok(normalizeBuildInfo({ schema: BUILD_INFO_SCHEMA, builtAt: "2026-11-02T00:00:00Z" })?.commitDirty === null,
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
  // 没有 git 元数据时（源码压缩包构建）要记成「未判定」，不能报成干净或脏。
  const gitPresent = existsSync(path.join(root, ".git"));
  ok(gitPresent ? typeof info.commitDirty === "boolean" : info.commitDirty === null,
    gitPresent ? "在 git 仓库内构建能判定工作区是否干净" : "无 git 元数据时 commitDirty 记为未判定，不谎报干净");
  ok(gitPresent ? typeof info.commit === "string" : info.commit === null,
    gitPresent ? "在 git 仓库内构建能取到提交号" : "无 git 元数据时提交号为 null");

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

// ── 3. 干净 / 脏 / 取不到 git ────────────────────────────
section("工作区状态三种结论都要能区分");
{
  // CI 的检出永远是干净的，正式版本的构建信息就走这条分支；本机工作区常年是脏的，
  // 所以这一支只有用临时 git 仓库才钉得住（曾经把「干净」的空串折叠成 null，CI 才炸出来）。
  let gitAvailable = true;
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    gitAvailable = false;
  }
  if (!gitAvailable) {
    console.log("  跳过：本机没有 git，脏/干净分支未验证（CI 会跑）");
  } else {
    const repoDir = path.join(tmpDir, "git-fixture");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ version: "3.2.1" }), "utf8");
    const gitInit = ["init", "-q", repoDir];
    execFileSync("git", gitInit, { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "verify@example.invalid"], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "verify"], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "add", "package.json"], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "fixture"], { stdio: "ignore" });

    const clean = collectBuildInfo(repoDir);
    ok(clean.commitDirty === false, "干净工作区判为 false，不是 null「未记录」");
    ok(clean.version === "3.2.1", "版本号取自该目录的 package.json");
    ok(typeof clean.commit === "string" && typeof clean.commitShort === "string", "干净工作区也能取到提交号与短号");

    writeFileSync(path.join(repoDir, "loose.txt"), "untracked", "utf8");
    ok(collectBuildInfo(repoDir).commitDirty === true, "多出未跟踪文件后判为 true");

    const outside = collectBuildInfo(path.join(tmpDir, "no-such-directory"));
    ok(outside.commitDirty === null && outside.commit === null, "取不到 git 时才记为未判定");
    ok(outside.version === null && outside.builtAt.length > 0, "目录不存在时版本为 null，但构建时间仍然如实写入");

    // 落在别的 git 工作树里构建（例如源码压缩包解到某个仓库目录下）不能把父仓库的提交
    // 当成 Project-X 的来源：只有 rootDir 自己就是工作树根时才采集 git 信息。
    const inside = collectBuildInfo(path.join(root, "src", "server"));
    ok(inside.commit === null && inside.commitShort === null && inside.commitDirty === null,
      "在仓库的子目录里构建时不采集父级 git 信息（宁可 null，不记错来源）");
    ok(inside.version === null, "该目录没有自己的 package.json 时版本也是 null，不往上猜一个版本号");
    ok(inside.builtAt.length > 0 && inside.schema === BUILD_INFO_SCHEMA, "构建时间与结构版本仍然如实写入");
  }
}

// ── 4. 实际 HTTP 路径 ────────────────────────────────────
section("管理员控制台接口的真实行为");
{
  const originalCwd = process.cwd();
  // 服务端按 cwd 解析 config.yml；切到没有该文件的临时目录，保证走本地 SQLite。
  mkdirSync(path.join(tmpDir, "run"), { recursive: true });
  process.chdir(path.join(tmpDir, "run"));
  delete process.env.PROJECTX_BUILD_INFO_PATH;

  const { initializeDatabase, ensureDefaultAdmin, closeDatabase, getMysqlDb } = await import("../src/server/db/index");
  const { authService } = await import("../src/server/services/AuthService");
  const { UserRepository } = await import("../src/server/repositories/UserRepository");
  const { loadRolePermissions, ROLE_IDS } = await import("../src/server/auth/permissions");
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

  // 权限门是后端属性：只测「未登录被拒」的话，把 requirePermission 摘掉也照样绿。
  const userRepo = new UserRepository();
  await userRepo.createUser({ username: "bi_teacher", password: "bi-teacher-pw", name: "构建信息教师", role_id: ROLE_IDS.TEACHER });
  const teacherLogin = await authService.login("bi_teacher", "bi-teacher-pw");
  assert.ok(teacherLogin.success && teacherLogin.token, "教师应能登录");

  const { createApp } = await import("../src/apps/answer-card/server/index");
  const server = createServer(await createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const adminHeaders = { Authorization: `Bearer ${adminLogin.token}` };

  const anonymous = await fetch(`${base}/api/admin/console/build`);
  ok(anonymous.status === 401 || anonymous.status === 403, `未登录访问被拒（${anonymous.status}）`);
  const teacherRes = await fetch(`${base}/api/admin/console/build`, {
    headers: { Authorization: `Bearer ${teacherLogin.token}` },
  });
  ok(teacherRes.status === 403, `教师登录也没有权限（${teacherRes.status}）`);

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
  ok(/^(win32|linux|darwin)-[a-z0-9_]+$/.test(String(body.runtime?.platform ?? "")), "运行环境回的是平台与架构");
  // 「本次启动」必须跟着进程走，不是请求时刻：隔一秒多再要一次，启动时间不该动、运行时长该涨。
  const firstStartedAt = String(body.runtime?.startedAt);
  const firstUptime = Number(body.runtime?.uptimeSeconds ?? -1);
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const again = await fetch(`${base}/api/admin/console/build`, { headers: adminHeaders });
  const againBody = await again.json() as { runtime?: { startedAt: string; uptimeSeconds: number } };
  const secondUptime = Number(againBody.runtime?.uptimeSeconds ?? -1);
  ok(againBody.runtime?.startedAt === firstStartedAt, "两次请求的本次启动时间一致（不是每次请求重算）");
  ok(secondUptime >= firstUptime + 1, `运行时长随请求间隔增长（${firstUptime} → ${secondUptime}）`);
  ok(adminRes.headers.get("cache-control") === "no-store", `响应不被缓存（${adminRes.headers.get("cache-control")}）`);

  // 源码直跑 / 旧部署包：200 + null + 原因，界面据此显示「—」而不是编造时间。
  process.env.PROJECTX_BUILD_INFO_PATH = path.join(tmpDir, "absent.json");
  buildInfoStore.resetBuildInfoCache();
  const noBuild = await fetch(`${base}/api/admin/console/build`, { headers: adminHeaders });
  const noBuildBody = await noBuild.json() as { build: unknown; reason: string | null };
  ok(noBuild.status === 200 && noBuildBody.build === null, "无构建信息时返回 200 + null，不报 500");
  ok(typeof noBuildBody.reason === "string" && noBuildBody.reason !== "", "无构建信息时给出原因");
  ok(!JSON.stringify(noBuildBody).includes(tmpDir), "整份响应不含临时目录路径");

  // 部署替换实验（评审 P2）：管理员可能先打开过控制台，再把新包拷进来。
  // 不换文件指针、不清缓存，只改盘上的内容，第二次请求必须读到新的构建时间——
  // 永久缓存会让「新包已就位但服务没重启」这个承诺在最该看见的场景里失效。
  process.env.PROJECTX_BUILD_INFO_PATH = builtFile;
  buildInfoStore.resetBuildInfoCache();
  const warm = await fetch(`${base}/api/admin/console/build`, { headers: adminHeaders });
  const warmBody = await warm.json() as { build?: { builtAt?: string } };
  ok(warmBody.build?.builtAt === builtInfo.builtAt, "替换前读到的是当前这份构建信息");

  const newer = { ...builtInfo, builtAt: new Date(Date.parse(builtInfo.builtAt) + 3_600_000).toISOString(), builder: `${builtInfo.builder} + redeployed-with-longer-suffix` };
  assert.notEqual(newer.builtAt, builtInfo.builtAt, "夹具要保证换了时间");
  assert.notEqual(JSON.stringify(newer).length, JSON.stringify(builtInfo).length, "夹具要保证换了字节数（指纹至少有一处变）");
  writeFileSync(builtFile, `${JSON.stringify(newer, null, 2)}\n`, "utf8");
  const afterSwap = await fetch(`${base}/api/admin/console/build`, { headers: adminHeaders });
  const afterBody = await afterSwap.json() as { build?: { builtAt?: string } };
  ok(afterBody.build?.builtAt === newer.builtAt,
    `部署替换后不重启也能读到新的构建时间（${builtInfo.builtAt.slice(11, 19)} → ${newer.builtAt.slice(11, 19)}）`);

  // 文件被删掉（回滚、清理）：不能继续报上一次读到的构建时间。
  rmSync(builtFile, { force: true });
  const afterDelete = await fetch(`${base}/api/admin/console/build`, { headers: adminHeaders });
  const deleteBody = await afterDelete.json() as { build: unknown; reason: string | null };
  ok(deleteBody.build === null && typeof deleteBody.reason === "string" && deleteBody.reason !== "",
    "构建信息文件消失后不再返回上一次的结果");
  ok(String(deleteBody.reason).includes("指定的构建信息文件不存在"), "文件消失时如实说明是指定的路径不在");

  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  closeDatabase();
  process.chdir(originalCwd);
}

rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n通过 ${results.length} 项，失败 ${failures} 项。`);
if (failures > 0) process.exit(1);
