export function scanCorrectionSchema(dialect: "sqlite" | "mariadb"): string {
  return `CREATE TABLE IF NOT EXISTS scan_correction_pages (
    source_type VARCHAR(32) NOT NULL,
    source_id VARCHAR(128) NOT NULL,
    card_version VARCHAR(24) NOT NULL,
    layout_json ${dialect === "sqlite" ? "TEXT" : "LONGTEXT"} NOT NULL,
    recognition_json ${dialect === "sqlite" ? "TEXT" : "LONGTEXT"} NOT NULL,
    revision BIGINT NOT NULL DEFAULT 0,
    modified_by INTEGER,
    modified_at VARCHAR(32),
    PRIMARY KEY (source_type, source_id)
  )`;
}
