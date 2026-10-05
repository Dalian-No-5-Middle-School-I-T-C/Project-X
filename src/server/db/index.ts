import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "./migrations";
import { diagnoseProjectDbPath, resolveProjectDbPath } from "./paths";
import { seedDefaultData } from "./seeds";
import { detectDialect, getMysqlDb, initMariadbSchema, buildInsertIgnore } from "./mysql";
import type { DbAdapter } from "./mysql";
import { encryptField, hashSecret } from "../lib/field-crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let dbInstance: Database.Database | null = null;

function schemaPath(): string {
  return path.join(__dirname, "schema.sql");
}

export function getDatabase(): Database.Database {
  if (!dbInstance) {
    const dbPath = resolveProjectDbPath();
    // 安全 R31：先说清「即将用哪个库、它是否已存在」，再创建文件——新建空库在事后是看不出原因的。
    const diagnosis = diagnoseProjectDbPath();
    for (const warning of diagnosis.warnings) console.warn(`[db-path] ${warning}`);
    mkdirSync(path.dirname(dbPath), { recursive: true });
    dbInstance = new Database(dbPath);
    dbInstance.pragma("journal_mode = WAL");
    dbInstance.pragma("foreign_keys = ON");
    dbInstance.pragma("synchronous = NORMAL");
    dbInstance.pragma("busy_timeout = 5000");
    console.log(`[DB] Connected to: ${dbPath}`);
  }
  return dbInstance;
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    console.log("[DB] Connection closed");
  }
}

export function initializeDatabase(): void {
  const dialect = detectDialect();

  if (dialect === "mariadb") {
    // v1.6.0: MariaDB 增量迁移机制 — 检测并执行缺失的 schema_migrations
    console.log("[DB] MariaDB mode: schema seeded via schema.mariadb.sql");
    // initMariadbSchema() 在 getMysqlDb() 首次调用时自动执行
    // ensureDefaultAdmin() 在外部调用，自动生成 API Key
    return;
  }

  // SQLite 模式
  const db = getDatabase();
  const schema = readFileSync(schemaPath(), "utf8");

  // Always run the idempotent base schema so partially initialized deployments
  // recover missing core tables before cleanup jobs and migrations touch them.
  db.exec(schema);
  console.log("[DB] Schema checked successfully");

  runMigrations(db);
  seedDefaultData(db);
}

/**
 * 安全审计（F-2）：把库中历史遗留的明文 initial_password 一次性加密为 enc:v1: 密文。
 * 幂等（仅处理无 enc:v1: 前缀的旧数据）；SQLite / MariaDB 双模兼容。
 */
export async function encryptLegacyInitialPasswords(db: DbAdapter): Promise<void> {
  try {
    const rows = await db.all<{ id: number; initial_password: string }>(
      "SELECT id, initial_password FROM users WHERE initial_password IS NOT NULL AND initial_password != '' AND initial_password NOT LIKE 'enc:v1:%'"
    );
    let count = 0;
    for (const row of rows) {
      await db.run("UPDATE users SET initial_password = ? WHERE id = ?", encryptField(row.initial_password), row.id);
      count++;
    }
    if (count > 0) {
      console.log(`[secrets] 已加密 ${count} 条历史明文 initial_password`);
    }
  } catch (err) {
    console.warn("[secrets] 历史明文加密迁移失败（不影响启动，可稍后重试）:", err);
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!hash || hash === "") {
    return false;
  }
  return bcrypt.compare(password, hash);
}

const BOOTSTRAP_ADMIN_FILE = "bootstrap-admin.txt";

// R01 安全整改：管理员初始/恢复口令改为**一次性随机口令**，且引导文件是引导态口令的事实源。
// 旧实现把口令固定为 admin123 并在每次启动重置哈希，等于向公开渠道永久提供可用凭据；
// 同时任何停留在引导态的存量库都会被「重启恢复到公开口令」，可被自助改密永久接管。
//
// 历史公开口令清单：出现在任何公开文档/旧版本代码里的引导口令一律视为**无效**。
// 升级到本修复后，仍停留在引导态（未改密）的库会在首次启动时被换发新的随机口令，
// 这些历史口令当场失效 —— 这是本次整改的目的，不是回归。
const LEGACY_PUBLIC_BOOTSTRAP_PASSWORDS = new Set(["admin123"]);

export function getBootstrapAdminPath(): string {
  return path.join(path.dirname(resolveProjectDbPath()), BOOTSTRAP_ADMIN_FILE);
}

// 口令字母表剔除易混淆字符（i/l/o/I/O/0/1）与 shell/引号敏感字符，便于运维抄录。
const PWD_LOWER = "abcdefghjkmnpqrstuvwxyz";
const PWD_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const PWD_DIGITS = "23456789";
const PWD_SYMBOLS = "!#$%&*+-=?@^~";
const PWD_ALL = PWD_LOWER + PWD_UPPER + PWD_DIGITS + PWD_SYMBOLS;
const BOOTSTRAP_ADMIN_PASSWORD_LENGTH = 16;

function randomInt(bound: number): number {
  // 拒绝采样消除取模偏置（bounded integers 的标准做法）。
  const max = Math.floor(0x100000000 / bound) * bound;
  let value = Number.MAX_SAFE_INTEGER;
  while (value >= max) {
    value = randomBytes(4).readUInt32BE(0);
  }
  return value % bound;
}

function pickFrom(alphabet: string): string {
  return alphabet[randomInt(alphabet.length)];
}

/**
 * 生成管理员一次性引导口令：长度 16，四类字符至少各一，随机排布。
 * 纯本地函数（不依赖数据库），便于脚本化回归。
 */
export function generateBootstrapAdminPassword(): string {
  const chars = [pickFrom(PWD_LOWER), pickFrom(PWD_UPPER), pickFrom(PWD_DIGITS), pickFrom(PWD_SYMBOLS)];
  while (chars.length < BOOTSTRAP_ADMIN_PASSWORD_LENGTH) {
    chars.push(pickFrom(PWD_ALL));
  }
  // Fisher-Yates 洗牌，保证四类字符的位置随机。
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/** 读取引导文件中的口令；文件缺失或内容为空返回 null。 */
function readBootstrapAdminPassword(): string | null {
  try {
    const value = readFileSync(getBootstrapAdminPath(), "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * 部署逃生阀：显式设置 `PROJECTX_ADMIN_PASSWORD` 时，引导态口令由该环境变量决定，
 * 不再写 `bootstrap-admin.txt`（用于容器/一键部署等「读不到数据目录文件」的场景）。
 * 仅在账号仍处于引导态时生效；完成首次改密后该变量再改也不会覆盖在用口令。
 */
const ADMIN_PASSWORD_ENV = "PROJECTX_ADMIN_PASSWORD";

function readEnvAdminPassword(): string | null {
  const value = (process.env[ADMIN_PASSWORD_ENV] ?? "").trim();
  return value || null;
}

/** 换发口令后落地事实源：环境变量态删除引导文件，随机态写入引导文件。 */
function publishBootstrapPassword(password: string, fromEnv: boolean): void {
  if (fromEnv) {
    removeBootstrapAdminFile();
    console.warn(`[DB] 管理员引导口令由环境变量 ${ADMIN_PASSWORD_ENV} 指定（不写引导文件）`);
    return;
  }
  writeBootstrapAdminPassword(password);
}

function writeBootstrapAdminPassword(password: string): void {
  const target = getBootstrapAdminPath();
  const dir = path.dirname(target);
  const temp = path.join(dir, `.${BOOTSTRAP_ADMIN_FILE}.${process.pid}.${Date.now()}.tmp`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(temp, `${password}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    renameSync(temp, target);
  } catch {
    rmSync(target, { force: true });
    renameSync(temp, target);
  }
  try { chmodSync(target, 0o600); } catch { /* Windows ACLs may ignore POSIX modes. */ }
  console.warn(`[DB] 管理员一次性初始口令已写入引导文件（请读取后尽快修改）: ${target}`);
}

export function removeBootstrapAdminFile(): void {
  try { rmSync(getBootstrapAdminPath(), { force: true }); } catch (error) {
    console.warn("[SECURITY] 清理管理员一次性密码文件失败:", error);
  }
}

export interface DefaultAdminBootstrapResult {
  adminId: number;
  rotated: boolean;
  passwordFile: string;
}

/**
 * 确保存在管理员账号，并维护「引导态口令」的唯一事实源 = `bootstrap-admin.txt`。
 *
 * 四种情形：
 * 1. 库中没有 admin（新库）：生成随机口令、写哈希、写引导文件，`rotated: true`。
 * 2. admin 已完成首次改密（`password_change_required = 0`）：完全不做任何变更。
 * 3. admin 停留在引导态且引导文件里的口令与库中哈希对得上：不做任何变更（`rotated: false`）。
 *    这一条是整改的核心 —— 重启不再把口令恢复到任何固定值，也不再吊销既有会话。
 * 4. admin 停留在引导态，但口令事实源不可信（文件缺失/为空、内容是历史公开口令，
 *    或与库中哈希对不上）：换发新的随机口令并重写文件（`rotated: true`）。覆盖三类场景：
 *    升级到本修复时的存量 `admin123` 库（旧口令当场失效）、备份还原/误删文件后的自愈，
 *    以及「换了库但文件没换」导致的锁死。
 *
 * 设置了 `PROJECTX_ADMIN_PASSWORD` 时，引导态口令改由该环境变量决定（见逃生阀说明），
 * 引导文件被删除，且口令与库中哈希一致时不轮换、不吊销会话。
 */
export async function ensureDefaultAdmin(): Promise<DefaultAdminBootstrapResult> {
  const dialect = detectDialect();
  const db = getMysqlDb();
  const existing = await db.get<{ id: number; password_hash: string; password_change_required: number }>(
    "SELECT id, password_hash, password_change_required FROM users WHERE username = ?",
    "admin"
  );
  const passwordFile = getBootstrapAdminPath();
  const envPassword = readEnvAdminPassword();
  const ensureApiKey = async () => {
    await (dialect === "mariadb" ? ensureDefaultApiKey(db) : ensureDefaultApiKeySqlite(getDatabase()));
  };

  if (existing) {
    if (!existing.password_change_required) {
      // 已完成首次改密（或显式沿用初始密码）的在用账号：不做任何变更
      await ensureApiKey();
      return { adminId: existing.id, rotated: false, passwordFile };
    }
    if (envPassword) {
      // 逃生阀态：环境变量是口令事实源，引导文件让位。
      const alreadyMatches = await verifyPassword(envPassword, existing.password_hash);
      if (!alreadyMatches) {
        await db.run(
          "UPDATE users SET password_hash = ?, password_change_required = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          await hashPassword(envPassword), existing.id
        );
      }
      publishBootstrapPassword(envPassword, true);
      await ensureApiKey();
      return { adminId: existing.id, rotated: !alreadyMatches, passwordFile };
    }
    const filePassword = readBootstrapAdminPassword();
    if (
      filePassword
      && !LEGACY_PUBLIC_BOOTSTRAP_PASSWORDS.has(filePassword)
      && await verifyPassword(filePassword, existing.password_hash)
    ) {
      // 引导文件与库中哈希对得上：它仍是可信的口令事实源，保持现状，
      // 不重置哈希、不重写文件（重启既不恢复到固定值，也不吊销既有会话）。
      await ensureApiKey();
      return { adminId: existing.id, rotated: false, passwordFile };
    }
    // 口令事实源不可信：文件缺失/为空、内容是历史公开口令，或与库中哈希对不上
    // （例如手工导入了另一台机器的备份、文件被单独改动）——换发一次性随机口令，
    // 否则会出现「文件里的口令登录不进去」这种无人能自愈的锁死状态。
    const password = generateBootstrapAdminPassword();
    await db.run(
      "UPDATE users SET password_hash = ?, password_change_required = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      await hashPassword(password), existing.id
    );
    writeBootstrapAdminPassword(password);
    await ensureApiKey();
    return { adminId: existing.id, rotated: true, passwordFile };
  }

  const newPassword = envPassword ?? generateBootstrapAdminPassword();
  if (dialect === "mariadb") {
    const insertAdminSql = buildInsertIgnore("mariadb", "users", [
      "username", "password_hash", "name", "role_id", "is_active", "password_change_required",
    ]);
    const result = await db.run(insertAdminSql, "admin", await hashPassword(newPassword), "系统管理员", 1, 1, 1);
    publishBootstrapPassword(newPassword, Boolean(envPassword));
    await ensureDefaultApiKey(db);
    return { adminId: result.lastInsertRowid, rotated: true, passwordFile };
  }

  // SQLite 模式
  const sqlite = getDatabase();
  const result = sqlite.prepare(
    `INSERT INTO users (username, password_hash, name, role_id, is_active, password_change_required)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run("admin", await hashPassword(newPassword), "系统管理员", 1, 1, 1);
  publishBootstrapPassword(newPassword, Boolean(envPassword));
  await ensureDefaultApiKeySqlite(sqlite);
  return { adminId: Number(result.lastInsertRowid), rotated: true, passwordFile };
}

// v1.6.0: 确保至少有一条扫描用的 API Key
// 安全审计（P1）：库内只存 SHA-256 哈希（与管理员签发接口一致），不打印完整明文；
// 明文一次性写入受保护文件（0600，随 data/ 目录一起 gitignore），供运维配置扫描端。
const SCANNER_API_KEY_FILE = "scanner-api-key.txt";

export function getScannerApiKeyPath(): string {
  return path.join(path.dirname(resolveProjectDbPath()), SCANNER_API_KEY_FILE);
}

function writeScannerApiKeyFile(key: string): void {
  const target = getScannerApiKeyPath();
  const dir = path.dirname(target);
  const temp = path.join(dir, `.${SCANNER_API_KEY_FILE}.${process.pid}.${Date.now()}.tmp`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(temp, `${key}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    renameSync(temp, target);
  } catch {
    rmSync(target, { force: true });
    renameSync(temp, target);
  }
  try { chmodSync(target, 0o600); } catch { /* Windows ACLs may ignore POSIX modes. */ }
  console.warn(`[SECURITY] 默认扫描端密钥已写入受保护文件: ${target}`);
}

function maskKey(key: string): string {
  if (key.length <= 12) return "****";
  return `${key.slice(0, 7)}****${key.slice(-4)}`;
}

async function ensureDefaultApiKey(db: any): Promise<void> {
  const existing = await db.get("SELECT id FROM api_keys WHERE scope = 'scanner' AND is_active = 1 LIMIT 1");
  if (existing) return;
  const key = `sk-${randomBytes(16).toString("hex")}`;
  await db.run("INSERT INTO api_keys (name, api_key, scope) VALUES (?, ?, ?)", "默认扫描端密钥", hashSecret(key), "scanner");
  writeScannerApiKeyFile(key);
  console.log(`[DB] Default scanner API key created (masked): ${maskKey(key)}`);
}

function ensureDefaultApiKeySqlite(db: any): Promise<void> {
  const existing = db.prepare("SELECT id FROM api_keys WHERE scope = 'scanner' AND is_active = 1 LIMIT 1").get();
  if (existing) return Promise.resolve();
  const key = `sk-${randomBytes(16).toString("hex")}`;
  db.prepare("INSERT INTO api_keys (name, api_key, scope) VALUES (?, ?, ?)").run("默认扫描端密钥", hashSecret(key), "scanner");
  writeScannerApiKeyFile(key);
  console.log(`[DB] Default scanner API key created (masked): ${maskKey(key)}`);
  return Promise.resolve();
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * 安全审计（P1）：把历史遗留的明文 api_keys 一次性哈希化，使明文兼容回退不再兜底生效。
 * 幂等：仅处理 64 位十六进制（sha256 hex）以外的旧值；SQLite / MariaDB 双模兼容。
 * 全表扫描后按正则过滤（避免 SQLite GLOB 字符类差异导致的兼容问题）。
 */
export async function migrateLegacyPlaintextApiKeys(db: DbAdapter): Promise<void> {
  try {
    const rows = await db.all<{ id: number; api_key: string }>(
      "SELECT id, api_key FROM api_keys WHERE api_key IS NOT NULL AND api_key != ''"
    );
    let count = 0;
    for (const row of rows) {
      if (!row.api_key || SHA256_HEX_RE.test(row.api_key)) continue;
      await db.run("UPDATE api_keys SET api_key = ? WHERE id = ?", hashSecret(row.api_key), row.id);
      count++;
    }
    if (count > 0) {
      console.log(`[secrets] 已哈希化 ${count} 条历史明文 api_keys`);
    }
  } catch (err) {
    console.warn("[secrets] 历史明文 api_keys 哈希化迁移失败（不影响启动，可稍后重试）:", err);
  }
}

export { runMigrations };
export { resolveAnswerCardDataDir, resolveProjectDbPath, resolveScannerDbPath, diagnoseProjectDbPath, candidateProjectDbPaths } from "./paths";

// ── 跨方言 DB 适配器 ──────────────────────────────────
export {
  getMysqlDb,
  getMariadbConfig,
  runMariadbMigrations,
  initMariadbSchema,
  initMariadbSchema as initMysqlSchema,
  detectDialect,
  buildUpsertSQL,
  buildInsertIgnore,
  healthCheck,
  resetAdapter,
} from "./mysql";
export type { DbAdapter } from "./mysql";
