import type Database from "better-sqlite3";

const SCHEMA_VERSION = 2;

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );

      CREATE TABLE IF NOT EXISTS scan_sessions (
        id          TEXT PRIMARY KEY,
        card_id     TEXT NOT NULL,
        name        TEXT NOT NULL DEFAULT '',
        dpi         INTEGER NOT NULL DEFAULT 300,
        duplex      INTEGER NOT NULL DEFAULT 1,
        color_mode  TEXT NOT NULL DEFAULT 'gray',
        paper_size  TEXT NOT NULL DEFAULT 'A4',
        page_count  INTEGER NOT NULL DEFAULT 0,
        status      TEXT NOT NULL DEFAULT 'pending',
        error_msg   TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS scan_records (
        id              TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL,
        card_id         TEXT NOT NULL,
        student_id      TEXT,
        student_conf    REAL,
        image_path      TEXT NOT NULL,
        page_num        INTEGER NOT NULL DEFAULT 1,
        side            TEXT NOT NULL DEFAULT 'front',
        ocr_status      TEXT NOT NULL DEFAULT 'pending',
        scan_quality    REAL,
        ocr_error       TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        recognized_at   TEXT,
        FOREIGN KEY (session_id) REFERENCES scan_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_scan_records_session ON scan_records(session_id);
      CREATE INDEX IF NOT EXISTS idx_scan_records_card ON scan_records(card_id);
      CREATE INDEX IF NOT EXISTS idx_scan_records_student ON scan_records(student_id);

      CREATE TABLE IF NOT EXISTS recognition_results (
        id              TEXT PRIMARY KEY,
        scan_record_id  TEXT UNIQUE NOT NULL,
        objective_json  TEXT,
        subjective_json TEXT,
        total_score     REAL,
        max_score       REAL,
        grade_status    TEXT NOT NULL DEFAULT 'pending',
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (scan_record_id) REFERENCES scan_records(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_recognition_scan ON recognition_results(scan_record_id);
    `
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS student_grading_results (
        session_id    TEXT NOT NULL,
        student_id    TEXT NOT NULL,
        objective_json  TEXT,
        subjective_json TEXT,
        total_score   REAL,
        max_score     REAL,
        page_count    INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, student_id)
      );

      CREATE INDEX IF NOT EXISTS idx_sgr_session ON student_grading_results(session_id);
      CREATE INDEX IF NOT EXISTS idx_sgr_student ON student_grading_results(student_id);
    `
  }
];

export function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
  `);

  const currentVersion = (() => {
    const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
    return row?.version ?? 0;
  })();

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    db.exec(migration.sql);
    db.prepare("INSERT OR REPLACE INTO schema_version (version) VALUES (?)").run(migration.version);
  }
}

export { SCHEMA_VERSION };
