import path from "node:path";

export function resolveProjectDbPath(): string {
  const envPath = process.env.PROJECTX_DB_PATH;
  if (envPath) return path.resolve(envPath);
  return path.join(process.cwd(), "data", "projectx.db");
}

export function resolveAnswerCardDataDir(): string {
  const envDir = process.env.ANSWER_CARD_DATA_DIR;
  if (envDir) return path.resolve(envDir);
  return path.join(process.cwd(), "data", "answer-card");
}

export function resolveScannerDbPath(): string {
  return path.join(resolveAnswerCardDataDir(), "scanner.db");
}
