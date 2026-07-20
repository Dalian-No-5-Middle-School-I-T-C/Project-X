/**
 * Project-X SQLite → MariaDB 数据迁移工具
 *
 * 用法: npx tsx scripts/migrate-to-mariadb.ts [--dry-run] [--skip-tables=table1,table2]
 *
 * 前提: MariaDB 服务已运行且 database 已创建
 * 环境变量: PROJECTX_MARIADB_HOST / PORT / USER / PASSWORD / DATABASE
 *           PROJECTX_DB_PATH (可选, 默认 data/projectx.db)
 *
 * 特性:
 * - 按外键拓扑排序，父表先迁移
 * - 逐表验证行数一致性
 * - --dry-run 模式只检查不写入
 * - --skip-tables 跳过指定表
 */

import Database from "better-sqlite3";
import mariadb from "mysql2/promise";
import { existsSync } from "node:fs";
import path from "node:path";

// ── 配置 ────────────────────────────────────────────

const SQLITE_PATH = process.env.PROJECTX_DB_PATH
  || path.join(process.cwd(), "data", "projectx.db");

const MARIA_CONFIG = {
  host: process.env.PROJECTX_MARIADB_HOST || "127.0.0.1",
  port: Number(process.env.PROJECTX_MARIADB_PORT || 3306),
  user: process.env.PROJECTX_MARIADB_USER || "projectx",
  password: process.env.PROJECTX_MARIADB_PASSWORD || "projectx",
  database: process.env.PROJECTX_MARIADB_DATABASE || "projectx",
  charset: "utf8mb4",
  multipleStatements: false,
  connectTimeout: 30000,
};

const DRY_RUN = process.argv.includes("--dry-run");
const skipArg = process.argv.find(a => a.startsWith("--skip-tables="));
const SKIP_TABLES = new Set(skipArg ? skipArg.split("=")[1].split(",").map(s => s.trim()) : []);

// SQLite → MariaDB 迁移版本号映射
// PR133 合并导致两侧版本号不一致: SQLite v9 = MariaDB v17 (同名 "original-paper-and-knowledge-points")
// 这里在迁移 schema_migrations 记录时做语义对齐,避免 MariaDB 侧重复执行或名称被错误覆盖
const VERSION_MAP: Record<number, number> = {
  9: 17,   // original-paper-and-knowledge-points: SQLite v9 = MariaDB v17
};
// SQLite 专属版本 (MariaDB 由 schema.mariadb.sql 覆盖,无需复制 schema_migrations 记录)
const SQLITE_ONLY_VERSIONS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 10]);

// ── 外键拓扑排序 ──────────────────────────────────

const MIGRATION_ORDER: Array<{ table: string; primaryKey: string }> = [
  // 独立表（无外键依赖）
  { table: "schema_migrations", primaryKey: "version" },
  { table: "roles", primaryKey: "id" },
  { table: "grades", primaryKey: "id" },
  { table: "data_retention_policies", primaryKey: "id" },

  // 用户与权限层
  { table: "users", primaryKey: "id" },

  // 班级层
  { table: "classes", primaryKey: "id" },
  { table: "class_students", primaryKey: "class_id, student_id" },
  { table: "teacher_classes", primaryKey: "teacher_id, class_id" },

  // 答题卡层
  { table: "answer_cards", primaryKey: "id" },
  { table: "objective_blocks", primaryKey: "id" },
  { table: "objective_answer_keys", primaryKey: "block_id, question_number" },
  { table: "objective_questions", primaryKey: "block_id, question_number" },
  { table: "objective_multiple_scoring", primaryKey: "block_id, correct_count" },
  { table: "subjective_blocks", primaryKey: "id" },
  { table: "subjective_questions", primaryKey: "id" },
  { table: "subjective_question_images", primaryKey: "id" },
  { table: "card_assets", primaryKey: "id" },
  { table: "knowledge_points", primaryKey: "id" },

  // 考试与分组
  { table: "exams", primaryKey: "id" },
  { table: "exam_groups", primaryKey: "id" },
  { table: "exam_group_members", primaryKey: "id" },
  { table: "exam_archives", primaryKey: "id" },

  // 扫描工作流
  { table: "scan_batches", primaryKey: "id" },
  { table: "scan_records", primaryKey: "id" },
  { table: "objective_recognitions", primaryKey: "id" },
  { table: "objective_grades", primaryKey: "id" },
  { table: "subjective_grades", primaryKey: "id" },

  // TWAIN 扫描仪
  { table: "twain_scan_sessions", primaryKey: "id" },
  { table: "twain_scan_records", primaryKey: "id" },
  { table: "twain_recognition_results", primaryKey: "id" },
  { table: "twain_student_grading_results", primaryKey: "session_id, student_id" },

  // 成绩
  { table: "student_scores", primaryKey: "id" },
  { table: "question_scores", primaryKey: "id" },
  { table: "answer_overrides", primaryKey: "id" },

  // 配置
  { table: "export_templates", primaryKey: "id" },
  { table: "ai_providers", primaryKey: "id" },
  { table: "api_keys", primaryKey: "id" },     // v1.6.0
];

// ── 主流程 ─────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("Project-X SQLite → MariaDB 数据迁移");
  console.log("═══════════════════════════════════════════");
  if (DRY_RUN) console.log("[模式] DRY RUN — 仅检查，不写入");
  console.log(`[SQLite] ${SQLITE_PATH}`);
  console.log(`[MariaDB] ${MARIA_CONFIG.host}:${MARIA_CONFIG.port}/${MARIA_CONFIG.database}`);
  console.log("");

  // 检查 SQLite 文件
  if (!existsSync(SQLITE_PATH)) {
    console.error(`❌ SQLite 文件不存在: ${SQLITE_PATH}`);
    process.exit(1);
  }

  // 打开 SQLite
  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  console.log("✅ SQLite 已连接");

  // 连接 MariaDB
  let mysqlConn: mariadb.Connection;
  try {
    mysqlConn = await mariadb.createConnection(MARIA_CONFIG);
    console.log("✅ MariaDB 已连接");
  } catch (err: any) {
    console.error(`❌ MariaDB 连接失败: ${err.message}`);
    sqlite.close();
    process.exit(1);
  }

  // 统计
  let totalSqliteRows = 0;
  let totalMariaRows = 0;
  const errors: string[] = [];
  const skipped: string[] = [];

  try {
    // 禁用外键检查加速写入
    if (!DRY_RUN) {
      await mysqlConn.execute("SET FOREIGN_KEY_CHECKS = 0");
    }

    for (const { table, primaryKey } of MIGRATION_ORDER) {
      if (SKIP_TABLES.has(table)) {
        console.log(`⏭️  跳过 ${table}`);
        skipped.push(table);
        continue;
      }

      // 读取 SQLite 行数
      const sqliteCount = sqlite.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get() as { cnt: number };
      console.log(`\n📋 ${table} — SQLite: ${sqliteCount.cnt} 行`);

      if (sqliteCount.cnt === 0) {
        console.log(`   ↳ 空表，跳过`);
        continue;
      }

      totalSqliteRows += sqliteCount.cnt;

      if (DRY_RUN) {
        // 检查 MariaDB 是否存在同名表
        const [existRows] = await mysqlConn.execute(
          `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
          [MARIA_CONFIG.database, table]
        ) as [any[], any];
        if ((existRows as any[]).length === 0) {
          console.log(`   ⚠  MariaDB 中表不存在（需先运行 schema）`);
        }
        continue;
      }

      // 分批读取 SQLite 数据
      const BATCH_SIZE = 500;
      let offset = 0;
      let inserted = 0;

      while (offset < sqliteCount.cnt) {
        const rows = sqlite.prepare(`SELECT * FROM ${table} LIMIT ? OFFSET ?`).all(BATCH_SIZE, offset) as any[];
        if (rows.length === 0) break;

        for (const row of rows) {
          // schema_migrations 表做版本号映射,对齐 PR133 导致的 SQLite/MariaDB 版本号不一致
          if (table === "schema_migrations") {
            const ver = row.version as number;
            if (SQLITE_ONLY_VERSIONS.has(ver)) continue;        // SQLite 专属版本跳过
            row.version = VERSION_MAP[ver] ?? ver;              // 映射到 MariaDB 等价版本
          }
          const columns = Object.keys(row);
          const values = Object.values(row);
          const placeholders = columns.map(() => "?").join(", ");
          const colNames = columns.map(c => `\`${c}\``).join(", ");

          try {
            await mysqlConn.execute(
              `REPLACE INTO ${table} (${colNames}) VALUES (${placeholders})`,
              values
            );
            inserted++;
          } catch (err: any) {
            errors.push(`${table} 行 ${offset + inserted + 1}: ${err.message}`);
            if (errors.length > 10) {
              console.error(`   ❌ 错误过多，中止`);
              break;
            }
          }
        }

        offset += rows.length;
        if (offset % (BATCH_SIZE * 5) === 0 || offset >= sqliteCount.cnt) {
          process.stdout.write(`\r   ↳ ${offset}/${sqliteCount.cnt}`);
        }
      }

      // 验证 MariaDB 行数
      const [countResult] = await mysqlConn.execute(
        `SELECT COUNT(*) as cnt FROM \`${table}\``
      ) as [any[], any];
      const mariaCount = (countResult as any[])[0].cnt;
      totalMariaRows += mariaCount;

      const match = mariaCount === sqliteCount.cnt;
      console.log(`   ↳ MariaDB: ${mariaCount} 行 ${match ? "✅" : "❌ 不匹配!"}`);
      if (!match) {
        errors.push(`${table}: SQLite=${sqliteCount.cnt} ≠ MariaDB=${mariaCount}`);
      }
    }
  } finally {
    if (!DRY_RUN) {
      await mysqlConn.execute("SET FOREIGN_KEY_CHECKS = 1");
    }
    await mysqlConn.end();
    sqlite.close();
  }

  // ── 报告 ──────────────────────────────────────
  console.log("\n═══════════════════════════════════════════");
  console.log("迁移完成");
  console.log("═══════════════════════════════════════════");
  console.log(`总表数: ${MIGRATION_ORDER.length}`);
  console.log(`跳过: ${skipped.length} (${skipped.join(", ") || "无"})`);
  console.log(`SQLite 总行数: ${totalSqliteRows}`);
  if (!DRY_RUN) {
    console.log(`MariaDB 总行数: ${totalMariaRows}`);
    const allMatch = totalSqliteRows === totalMariaRows;
    console.log(`行数校验: ${allMatch ? "✅ 一致" : "❌ 不一致"}`);
  }
  if (errors.length > 0) {
    console.log(`\n⚠ 错误 (${errors.length}):`);
    errors.forEach(e => console.log(`   - ${e}`));
  }

  if (!DRY_RUN) {
    console.log("\n💡 提示：迁移完成。请重启 Project-X 服务器并确认 PROJECTX_MARIADB_HOST 环境变量已设置。");
  }
}

main().catch(err => {
  console.error("迁移过程异常:", err);
  process.exit(1);
});
