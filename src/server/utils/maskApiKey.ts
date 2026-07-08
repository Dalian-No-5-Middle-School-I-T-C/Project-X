const MASK_PREFIX = "••••••••";

/** 脱敏 API Key：仅保留末 4 位，避免明文泄露给前端 */
export function maskApiKey(key: string | null | undefined): string {
  if (!key) return "";
  if (key.length <= 4) return "••••";
  return `${MASK_PREFIX}${key.slice(-4)}`;
}

/** 判断是否为脱敏后的 API Key（前端回传时不应写回数据库） */
export function isMaskedApiKey(key: string | null | undefined): boolean {
  if (!key) return false;
  if (key === "••••") return true;
  return key.startsWith(MASK_PREFIX) && key.length === MASK_PREFIX.length + 4;
}
