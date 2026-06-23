import type Database from "better-sqlite3";

export function seedDefaultData(db: Database.Database): void {
  const roleCount = db.prepare("SELECT COUNT(*) as cnt FROM roles").get() as { cnt: number };
  if (roleCount.cnt === 0) {
    const insertRole = db.prepare(
      "INSERT OR IGNORE INTO roles (id, name, display_name, permissions) VALUES (?, ?, ?, ?)"
    );
    insertRole.run(1, "admin", "管理员", JSON.stringify(["*"]));
    insertRole.run(2, "teacher", "教师", JSON.stringify([
      "card:read",
      "card:write",
      "exam:read",
      "exam:write",
      "grade:read",
      "grade:write"
    ]));
    insertRole.run(3, "student", "学生", JSON.stringify(["score:read"]));
    console.log("[DB] Default roles inserted");
  }

  const policyCount = db.prepare("SELECT COUNT(*) as cnt FROM data_retention_policies").get() as { cnt: number };
  if (policyCount.cnt === 0) {
    const insertPolicy = db.prepare(
      "INSERT OR IGNORE INTO data_retention_policies (id, name, retain_days, auto_archive, auto_delete) VALUES (?, ?, ?, ?, ?)"
    );
    insertPolicy.run(1, "周测", 30, 1, 0);
    insertPolicy.run(2, "月考", 90, 1, 0);
    insertPolicy.run(3, "期中期末", 0, 1, 0);
    console.log("[DB] Default retention policies inserted");
  }
}
