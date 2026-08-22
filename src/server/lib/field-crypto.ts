/**
 * 敏感字段加密助手（安全审计 F-2 / F-7）。
 *
 * 用途：
 *  - users.initial_password：明文初始口令改为 AES-256-GCM 加密存储，防数据库/备份泄漏即口令全量暴露；
 *  - ai_providers.api_key：LLM 服务商密钥加密存储（运行时解密后使用）。
 *
 * 设计要点：
 *  - 密钥来源：环境变量 PROJECTX_SECRET_KEY；未设置时自动生成 32 字节随机密钥并持久化到
 *    data/secret.key（POSIX 0600），保证重启后仍可解密。data/ 目录已在 .gitignore 排除。
 *  - 密文格式 "enc:v1:<base64(iv|ciphertext|authTag)>"，带版本前缀便于未来轮换。
 *  - 兼容旧数据：encryptField 只对新写入生效；decryptField 遇到非 "enc:v1:" 前缀的旧明文
 *    直接原样返回（平滑过渡，无需数据迁移脚本）。
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function secretKeyPath(): string {
  const base = process.env.ANSWER_CARD_DATA_DIR || join(process.cwd(), "data");
  return join(base, "secret.key");
}

let cachedKey: Buffer | null = null;

/** 获取 32 字节密钥：env 优先，否则从 data/secret.key 读取或生成。 */
export function getSecretKey(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.PROJECTX_SECRET_KEY;
  if (fromEnv && fromEnv.length >= 16) {
    cachedKey = createHash("sha256").update(fromEnv).digest();
    return cachedKey;
  }
  const path = secretKeyPath();
  if (existsSync(path)) {
    const raw = readFileSync(path);
    cachedKey = raw.length === 32 ? raw : createHash("sha256").update(raw).digest();
    return cachedKey;
  }
  const generated = randomBytes(32);
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, generated, { mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* Windows 下 chmod 不适用则忽略 */ }
  } catch (err) {
    // 无法持久化密钥时（如只读文件系统），仍在本进程内可用；重启后旧密文将无法解密，
    // 这种情况日志告警即可（优先使用环境变量 PROJECTX_SECRET_KEY 规避）。
    console.warn("[secrets] 无法持久化密钥文件，请设置环境变量 PROJECTX_SECRET_KEY 保证密文可跨重启解密:", err);
  }
  cachedKey = generated;
  return cachedKey;
}

/** 加密字符串字段；空值原样返回 null/空串。 */
export function encryptField(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return value ?? null;
  const key = getSecretKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, ciphertext, tag]).toString("base64");
}

/** 解密字段；旧明文（无 "enc:v1:" 前缀）或无法解密时安全回退。 */
export function decryptField(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return value ?? null;
  if (!value.startsWith(PREFIX)) return value; // 旧明文兼容
  try {
    const key = getSecretKey();
    const blob = Buffer.from(value.slice(PREFIX.length), "base64");
    if (blob.length < IV_LEN + TAG_LEN) return null;
    const iv = blob.subarray(0, IV_LEN);
    const tag = blob.subarray(blob.length - TAG_LEN);
    const ciphertext = blob.subarray(IV_LEN, blob.length - TAG_LEN);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (err) {
    console.warn("[secrets] 解密失败（可能是密钥不匹配），返回空值:", err);
    return null;
  }
}

/** SHA-256 哈希（用于 api_keys 表存储，校验型密钥无需可逆）。 */
export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
