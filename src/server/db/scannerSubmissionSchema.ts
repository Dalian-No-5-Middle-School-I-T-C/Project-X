/** Receipts are separate from score rows: withdrawing a conflict must retain its evidence. */
export function scannerSubmissionSchema(dialect: "sqlite" | "mariadb"): string {
  const key = dialect === "sqlite" ? "TEXT" : "VARCHAR(128)";
  return `CREATE TABLE IF NOT EXISTS scanner_submissions (
    exam_id INTEGER NOT NULL,
    session_id ${key} NOT NULL,
    group_id ${key} NOT NULL,
    student_number ${key} NOT NULL,
    state VARCHAR(16) NOT NULL DEFAULT 'pending',
    previously_saved INTEGER NOT NULL DEFAULT 0,
    pages_json TEXT NOT NULL,
    result_json ${dialect === "sqlite" ? "TEXT" : "LONGTEXT"},
    score_snapshot ${dialect === "sqlite" ? "TEXT" : "LONGTEXT"},
    PRIMARY KEY (exam_id, session_id, group_id),
    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE
  )`;
}
