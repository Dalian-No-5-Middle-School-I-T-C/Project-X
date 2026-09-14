import { detectDialect } from "./mysql";

/** Match mysql2's default local DATETIME encoding; keep SQLite's ISO contract. */
export function databaseTimestamp(value: Date | string = new Date(), dialect = detectDialect()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (dialect === "sqlite") return date.toISOString();
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().replace("T", " ").replace("Z", "");
}
