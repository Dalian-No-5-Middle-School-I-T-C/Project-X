/**
 * Project-X SQLite → MariaDB 数据迁移工具（v2：结构自补 + 备份回滚 + 三重验证）
 *
 * 用法:
 *   npx tsx scripts/migrate-to-mariadb.ts [--dry-run] [--verify-only] [--sample=N]
 *        [--skip-tables=table1,table2] [--skip-schema] [--skip-backup]
 *
 * 前提: MariaDB 服务已运行且 database 已创建（结构可由本工具自动补齐）
 * 环境变量: PROJECTX_MARIADB_HOST / PORT / USER / PASSWORD / DATABASE
 *           PROJECTX_DB_PATH (可选, 默认 data/projectx.db)
 *           PROJECTX_MYSQLDUMP (可选, mysqldump 可执行文件路径)
 *
 * 特性:
 * - 按外键拓扑排序，父表先迁移
 * - 默认先调用 runMariadbMigrations 自动补齐目标库结构（--skip-schema 关闭）
 * - 默认迁移前自动 mysqldump 完整备份（--skip-backup 显式关闭；找不到 mysqldump 时拒绝继续）
 * - 逐表三重验证：行数对比 + 列结构对比（PRAGMA vs information_schema）+ 可选抽样逐字段比对
 * - --dry-run 只检查不写入；--verify-only 只验证（不迁移/不备份/不补结构）
 * - 迁移失败或验证不通过时打印回滚命令（mysql 恢复备份），退出码非 0
 */

import Database from "better-sqlite3";
import mariadb from "mysql2/promise";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { runMariadbMigrations } from "../src/server/db/mysql";

// ── 配置 ────────────────────────────────────────────

const SQLITE_PATH = process.env.PROJECTX_DB_PATH
  || path.join(process.cwd(), "data", "projectx.db");

const MARIA_CONFIG = {
  host: process.env.PROJECTX_MARIADB_HOST || process.env.PROJECTX_MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.PROJECTX_MARIADB_PORT || process.env.PROJECTX_MYSQL_PORT || 3306),
  user: process.env.PROJECTX_MARIADB_USER || process.env.PROJECTX_MYSQL_USER || "projectx",
  password: process.env.PROJECTX_MARIADB_PASSWORD || process.env.PROJECTX_MYSQL_PASSWORD || "projectx",
  database: process.env.PROJECTX_MARIADB_DATABASE || process.env.PROJECTX_MYSQL_DATABASE || "projectx",
  charset: "utf8mb4",
  multipleStatements: false,
  connectTimeout: 30000,
};

const DRY_RUN = process.argv.includes("--dry-run");
const VERIFY_ONLY = process.argv.includes("--verify-only");
const SKIP_SCHEMA = process.argv.includes("--skip-schema");
const SKIP_BACKUP = process.argv.includes("--skip-backup");
const sampleArg = process.argv.find(a => a.startsWith("--sample="));
const SAMPLE_N = Math.max(0, Number(sampleArg ? sampleArg.split("=")[1] : 0) || 0);
const skipArg = process.argv.find(a => a.startsWith("--skip-tables="));
const SKIP_TABLES = new Set(skipArg ? skipArg.split("=")[1].split(",").map(s => s.trim()) : []);

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Project-X SQLite → MariaDB 数据迁移工具

用法:
  npx tsx scripts/migrate-to-mariadb.ts [选项]

选项:
  --dry-run              只检查不写入（连库 + 结构对比 + 行数统计）
  --verify-only          只验证（结构/行数/抽样），不迁移、不备份、不补结构
  --sample=N             每表抽样 N 行做逐字段比对（默认 0=关闭）
  --skip-tables=t1,t2    跳过指定表
  --skip-schema          跳过自动结构补齐（默认先跑 runMariadbMigrations）
  --skip-backup          跳过迁移前 mysqldump 备份（默认备份，找不到 mysqldump 时拒绝继续）
  -h, --help             显示本帮助

环境变量:
  PROJECTX_MARIADB_HOST / PORT / USER / PASSWORD / DATABASE (默认 127.0.0.1:3306 projectx/projectx/projectx)
  PROJECTX_DB_PATH       SQLite 路径 (默认 data/projectx.db)
  PROJECTX_MYSQLDUMP     mysqldump 可执行文件路径 (默认取 PATH 中的 mysqldump)

验证与回滚:
  迁移后自动逐表行数对比 + 列结构对比 + 可选抽样比对；
  验证不通过时打印回滚命令（mysql 恢复迁移前备份到 data/backups/）。`);
  process.exit(0);
}

// SQLite → MariaDB 迁移版本号映射
// PR133 合并导致两侧版本号不一致: SQLite v9 = MariaDB v17 (同名 "original-paper-and-knowledge-points")
// 这里在迁移 schema_migrations 记录时做语义对齐,避免 MariaDB 侧重复执行或名称被错误覆盖
const VERSION_MAP: Record<number, number> = {
  9: 17,   // original-paper-and-knowledge-points: SQLite v9 = MariaDB v17
};
// SQLite 专属版本 (MariaDB 由 schema.mariadb.sql 覆盖,无需复制 schema_migrations 记录)
const SQLITE_ONLY_VERSIONS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 10]);

// ── 外键拓扑排序 ──────────────────────────────────
// v2 补全：+teacher_permissions / system_settings / original_paper_pages /
//         review_assignments / review_sessions / review_annotations / block_grading_config /
//         theme_change_events / ai_analysis_runs / ai_provider_calls / entity_lifecycle_events

const MIGRATION_ORDER: Array<{ table: string; primaryKey: string }> = [
  // 独立表（无外键依赖）
  { table: "schema_migrations", primaryKey: "version" },
  { table: "roles", primaryKey: "id" },
  { table: "grades", primaryKey: "id" },
  { table: "data_retention_policies", primaryKey: "id" },
  { table: "system_settings", primaryKey: "key" },

  // 用户与权限层
  { table: "users", primaryKey: "id" },
  { table: "teacher_permissions", primaryKey: "id" },

  // 班级层
  { table: "classes", primaryKey: "id" },
  { table: "class_students", primaryKey: "class_id, student_id" },
  { table: "teacher_classes", primaryKey: "teacher_id, class_id" },

  // 答题卡层
  { table: "answer_cards", primaryKey: "id" },
  { table: "original_paper_pages", primaryKey: "id" },
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

  // 网阅（依赖 exams/users/answer_block_crops）
  { table: "review_assignments", primaryKey: "id" },
  { table: "review_sessions", primaryKey: "id" },
  { table: "review_annotations", primaryKey: "id" },
  { table: "block_grading_config", primaryKey: "id" },

  // 配置与观测（v37 起）
  { table: "export_templates", primaryKey: "id" },
  { table: "ai_providers", primaryKey: "id" },
  { table: "api_keys", primaryKey: "id" },     // v1.6.0
  { table: "theme_change_events", primaryKey: "id" },
  { table: "ai_analysis_runs", primaryKey: "id" },
  { table: "ai_provider_calls", primaryKey: "id" },
  { table: "entity_lifecycle_events", primaryKey: "id" },
];

// ── 备份 ─────────────────────────────────────────────

/** 用 mysqldump 完整备份目标库（不经过本进程连接，含 --single-transaction 不停写）。 */
function backupMariadb(): string | null {
  const bin = process.env.PROJECTX_MYSQLDUMP || "mysqldump";
  const probe = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    console.error(`❌ 未找到 mysqldump（${bin}）。请安装 MariaDB 客户端或设置 PROJECTX_MYSQLDUMP 指向可执行文件；`);
    console.error(`   也可在确认已手工备份后用 --skip-backup 显式跳过本工具备份。`);
    return null;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(process.cwd(), "data", "backups");
  mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `mariadb-pre-migration-${ts}.sql`);

  const args = [
    "-h", MARIA_CONFIG.host,
    "-P", String(MARIA_CONFIG.port),
    "-u", MARIA_CONFIG.user,
    "--single-transaction",
    "--routines",
    "--triggers",
    MARIA_CONFIG.database,
  ];
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
    env: { ...process.env, MYSQL_PWD: MARIA_CONFIG.password },
  });
  if (r.status !== 0) {
    console.error(`❌ 备份失败: ${(r.stderr || "").trim() || "未知错误"}`);
    return null;
  }
  writeFileSync(backupPath, r.stdout, "utf8");
  console.log(`✅ 目标库已备份: ${backupPath}`);
  return backupPath;
}

// ── 验证工具 ─────────────────────────────────────────

/** 列结构对比：返回 SQLite 有而 MariaDB 缺失的列（表不存在时返回全部列）。 */
async function compareColumns(
  sqlite: Database.Database,
  conn: mariadb.Connection,
  table: string
): Promise<string[]> {
  const sqliteCols = (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map(r => r.name);
  const [rows] = await conn.execute(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [MARIA_CONFIG.database, table]
  ) as [Array<{ COLUMN_NAME: string }>, any];
  if (rows.length === 0) return [...sqliteCols]; // 表不存在
  const mariaCols = new Set(rows.map(r => r.COLUMN_NAME));
  return sqliteCols.filter(c => !mariaCols.has(c));
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return (a == null && b == null) || (a == null && b === "") || (a === "" && b == null);
  // 日期类只比较日期部分（SQLite ISO 串 vs MariaDB DATETIME 可能带秒/格式差异）
  const sa = String(a), sb = String(b);
  if (/^\d{4}-\d{2}-\d{2}/.test(sa) && /^\d{4}-\d{2}-\d{2}/.test(sb)) {
    return sa.slice(0, 10) === sb.slice(0, 10);
  }
  // 数值宽容（1 vs 1.0 vs "1"）
  const na = Number(sa), nb = Number(sb);
  if (sa !== "" && sb !== "" && !Number.isNaN(na) && !Number.isNaN(nb) && String(na) === String(nb)) return true;
  return false;
}

/** 抽样逐字段比对（取 SQLite 前 N 行，按主键回查 MariaDB）。 */
async function sampleVerify(
  sqlite: Database.Database,
  conn: mariadb.Connection,
  table: string,
  primaryKey: string,
  n: number
): Promise<{ checked: number; mismatches: string[] }> {
  const rows = sqlite.prepare(`SELECT * FROM ${table} LIMIT ?`).all(n) as Array<Record<string, unknown>>;
  const pkCols = primaryKey.split(",").map(s => s.trim()).filter(Boolean);
  const mismatches: string[] = [];
  let checked = 0;
  for (const row of rows) {
    const conds = pkCols.map(c => `\`${c}\` = ?`).join(" AND ");
    const vals = pkCols.map(c => row[c]) as any[];
    const [mRows] = await conn.execute(`SELECT * FROM \`${table}\` WHERE ${conds}`, vals) as [Array<Record<string, unknown>>, any];
    if (mRows.length === 0) {
      mismatches.push(`主键 ${pkCols.map(c => `${c}=${JSON.stringify(row[c])}`).join(", ")} 在 MariaDB 中不存在`);
      continue;
    }
    checked++;
    const m = mRows[0];
    for (const col of Object.keys(row)) {
      if (!(col in m)) { mismatches.push(`列 ${col} 在 MariaDB 缺失`); continue; }
      if (!looseEqual(row[col], m[col])) {
        mismatches.push(`列 ${col}: SQLite=${JSON.stringify(row[col])} ≠ MariaDB=${JSON.stringify(m[col])}`);
      }
    }
  }
  return { checked, mismatches };
}

// ── 主流程 ─────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("Project-X SQLite → MariaDB 数据迁移");
  console.log("═══════════════════════════════════════════");
  if (VERIFY_ONLY) console.log("[模式] VERIFY ONLY — 仅验证，不迁移/不备份/不补结构");
  else if (DRY_RUN) console.log("[模式] DRY RUN — 仅检查，不写入");
  else console.log("[模式] FULL MIGRATION");
  console.log(`[SQLite]   ${SQLITE_PATH}`);
  console.log(`[MariaDB]  ${MARIA_CONFIG.host}:${MARIA_CONFIG.port}/${MARIA_CONFIG.database}`);
  if (SAMPLE_N > 0) console.log(`[抽样]     每表前 ${SAMPLE_N} 行逐字段比对`);
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

  // 备份（迁移前，非 dry-run / verify-only / skip-backup）
  let backupPath: string | null = null;
  if (!DRY_RUN && !VERIFY_ONLY && !SKIP_BACKUP) {
    backupPath = backupMariadb();
    if (!backupPath) {
      console.error("❌ 备份失败，终止迁移。请先手动备份目标库，或用 --skip-backup 显式跳过（风险自担）。");
      await mysqlConn.end();
      sqlite.close();
      process.exit(1);
    }
  }

  // 自动补齐目标库结构（默认开启）
  if (!DRY_RUN && !VERIFY_ONLY && !SKIP_SCHEMA) {
    console.log("\n[Schema] 调用 runMariadbMigrations 补齐目标库结构（幂等）...");
    try {
      await runMariadbMigrations(mysqlConn);
      console.log("[Schema] 结构就绪");
    } catch (err: any) {
      console.error(`❌ 结构补齐失败: ${err.message}`);
      await mysqlConn.end();
      sqlite.close();
      process.exit(1);
    }
  }

  // 统计
  let totalSqliteRows = 0;
  let totalMariaRows = 0;
  const errors: string[] = [];
  const skipped: string[] = [];
  const schemaWarnings: string[] = [];

  try {
    // 禁用外键检查加速写入
    if (!DRY_RUN && !VERIFY_ONLY) {
      await mysqlConn.execute("SET FOREIGN_KEY_CHECKS = 0");
    }

    for (const { table, primaryKey } of MIGRATION_ORDER) {
      if (SKIP_TABLES.has(table)) {
        console.log(`⏭️  跳过 ${table}`);
        skipped.push(table);
        continue;
      }

      // 1. 列结构对比（始终执行，提前暴露结构缺口）
      const missingCols = await compareColumns(sqlite, mysqlConn, table);
      if (missingCols.length > 0) {
        schemaWarnings.push(`${table}: 缺失列 ${missingCols.join(", ")}`);
        if (!DRY_RUN && !VERIFY_ONLY) {
          console.warn(`   ⚠ 结构缺口: ${missingCols.join(", ")}（已尝试 auto-schema 补齐，仍缺则需检查）`);
        }
      }

      // 2. 行数
      const sqliteCount = sqlite.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get() as { cnt: number };
      console.log(`\n📋 ${table} — SQLite: ${sqliteCount.cnt} 行`);

      if (sqliteCount.cnt === 0) {
        console.log(`   ↳ 空表，跳过`);
        continue;
      }

      totalSqliteRows += sqliteCount.cnt;

      if (DRY_RUN || VERIFY_ONLY) {
        // 检查 MariaDB 是否存在同名表
        const [existRows] = await mysqlConn.execute(
          `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
          [MARIA_CONFIG.database, table]
        ) as [any[], any];
        if ((existRows as any[]).length === 0) {
          console.log(`   ⚠  MariaDB 中表不存在（需先跑迁移/auto-schema）`);
        }
        if (!DRY_RUN && SAMPLE_N > 0) {
          const sr = await sampleVerify(sqlite, mysqlConn, table, primaryKey, SAMPLE_N);
          if (sr.mismatches.length > 0) {
            errors.push(`${table} 抽样比对 ${sr.mismatches.length} 处不一致（检查 ${sr.checked} 行）`);
            sr.mismatches.slice(0, 5).forEach(e => errors.push(`   ${table}: ${e}`));
          } else {
            console.log(`   ↳ 抽样比对 ${sr.checked} 行 ✅`);
          }
        }
        continue;
      }

      // 3. 分批读取 SQLite 数据
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
          const values = Object.values(row) as any[];
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
      if (errors.length > 10) break;

      // 4. 验证 MariaDB 行数
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

      // 5. 抽样逐字段比对
      if (SAMPLE_N > 0) {
        const sr = await sampleVerify(sqlite, mysqlConn, table, primaryKey, SAMPLE_N);
        if (sr.mismatches.length > 0) {
          errors.push(`${table} 抽样比对 ${sr.mismatches.length} 处不一致（检查 ${sr.checked} 行）`);
          sr.mismatches.slice(0, 5).forEach(e => errors.push(`   ${table}: ${e}`));
        } else {
          console.log(`   ↳ 抽样比对 ${sr.checked} 行 ✅`);
        }
      }
    }
  } finally {
    if (!DRY_RUN && !VERIFY_ONLY) {
      await mysqlConn.execute("SET FOREIGN_KEY_CHECKS = 1");
    }
    await mysqlConn.end();
    sqlite.close();
  }

  // ── 报告 ──────────────────────────────────────
  console.log("\n═══════════════════════════════════════════");
  console.log(VERIFY_ONLY ? "验证完成" : "迁移完成");
  console.log("═══════════════════════════════════════════");
  console.log(`总表数: ${MIGRATION_ORDER.length}`);
  console.log(`跳过: ${skipped.length} (${skipped.join(", ") || "无"})`);
  if (schemaWarnings.length > 0) {
    console.log(`结构缺口 (${schemaWarnings.length}):`);
    schemaWarnings.forEach(w => console.log(`   - ${w}`));
  }
  console.log(`SQLite 总行数: ${totalSqliteRows}`);
  if (!DRY_RUN && !VERIFY_ONLY) {
    console.log(`MariaDB 总行数: ${totalMariaRows}`);
    const allMatch = totalSqliteRows === totalMariaRows;
    console.log(`行数校验: ${allMatch ? "✅ 一致" : "❌ 不一致"}`);
  }
  if (errors.length > 0) {
    console.log(`\n⚠ 错误 (${errors.length}):`);
    errors.slice(0, 30).forEach(e => console.log(`   - ${e}`));
  }

  if (!DRY_RUN && !VERIFY_ONLY) {
    if (errors.length > 0) {
      console.log("\n❌ 迁移未完全成功（或验证未通过）。");
      if (backupPath) {
        console.log(`   🔄 回滚：用备份恢复目标库 →`);
        console.log(`      mysql -h ${MARIA_CONFIG.host} -P ${MARIA_CONFIG.port} -u ${MARIA_CONFIG.user} -p ${MARIA_CONFIG.database} < ${backupPath}`);
        console.log(`      （或使用图形工具导入 ${backupPath}）`);
      }
      console.log("   注意：回滚会丢失本次迁移写入的全部数据；请确认无其他并发写入后执行。");
      process.exit(1);
    }
    console.log("\n💡 提示：迁移完成。请重启 Project-X 服务器并确认 PROJECTX_MARIADB_HOST 环境变量已设置。");
  } else if (errors.length > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error("迁移过程异常:", err);
  process.exit(1);
});
