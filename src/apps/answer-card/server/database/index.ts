import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { applyMigrations } from "./schema";
import { dataDir } from "../storage";

let db: Database.Database | null = null;

export function getDbPath(): string {
  return path.join(dataDir, "scanner.db");
}

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = getDbPath();
    mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    applyMigrations(db);
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
