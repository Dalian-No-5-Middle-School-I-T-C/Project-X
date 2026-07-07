/** 脱敏 API Key：仅保留末 4 位，避免明文泄露给前端 */
export function maskApiKey(key: string | null | undefined): string {
  if (!key) return "";
  if (key.length <= 4) return "••••";
  return `••••••••${key.slice(-4)}`;
}
