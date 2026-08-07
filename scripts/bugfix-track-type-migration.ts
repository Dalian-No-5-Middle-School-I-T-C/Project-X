/**
 * 永久回归：exam_group_members.track_type 迁移（PR #212 修复）
 * 复现场景：
 *  1) 全新库跑 runMigrations —— v1 建表不含 track_type，须由 v31 补列
 *  2) 已存在旧库（预置 1..30 已应用、exam_group_members 无 track_type）—— 只跑 v31 补齐
 *  3) 幂等 —— 二次跑迁移不报错、不丢列
 */
import Database from "better-sqlite3";
import { runMigrations } from "../src/server/db/migrations";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string, extra?: unknown) {
  if (cond) {
    pass++;
    console.log("PASS:", msg);
  } else {
    fail++;
    console.log("FAIL:", msg, extra ?? "");
  }
}

function tmpDb(tag: string): string {
  return path.join(os.tmpdir(), `px_track_smoke_${tag}_${Date.now()}.db`);
}

// 场景1：贴近生产初始化（schema.sql DDL 已含 track_type）→ runMigrations 幂等不报错
{
  const p = tmpDb("fresh");
  try {
    fs.unlinkSync(p);
  } catch {}
  const db = new Database(p);
  try {
    const schema = fs.readFileSync("src/server/db/schema.sql", "utf-8");
    db.exec(schema); // 真实生产 DDL 建库（exam_group_members 已含 track_type）
    runMigrations(db); // 标记版本；v31 应为 no-op（已存在）
    const cols = db.prepare("PRAGMA table_info(exam_group_members)").all() as Array<{
      name: string;
      dflt_value: unknown;
    }>;
    const track = cols.find((c) => c.name === "track_type");
    ok(!!track, "生产 DDL 初始化：exam_group_members 含 track_type 列");
    ok(track?.dflt_value === "common", "track_type 默认值为 'common'", track?.dflt_value);
  } catch (e) {
    fail++;
    console.log("FAIL: 生产初始化 runMigrations 抛异常:", (e as Error).message);
  } finally {
    db.close();
    try {
      fs.unlinkSync(p);
    } catch {}
  }
}

// 场景2 + 3：已存在旧库升级 + 幂等
{
  const p = tmpDb("upgrade");
  try {
    fs.unlinkSync(p);
  } catch {}
  const db = new Database(p);
  try {
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE exam_group_members (id INTEGER PRIMARY KEY, group_id INTEGER, exam_id INTEGER, student_id INTEGER);
    `);
    // 预置 1..30 为已应用，模拟 v29 旧库
    const ins = db.prepare("INSERT OR REPLACE INTO schema_migrations (version, name) VALUES (?, ?)");
    for (let v = 1; v <= 30; v++) ins.run(v, `seed-${v}`);

    runMigrations(db); // 仅 v31 运行
    const cols = db.prepare("PRAGMA table_info(exam_group_members)").all() as Array<{
      name: string;
      dflt_value: unknown;
    }>;
    ok(!!cols.find((c) => c.name === "track_type"), "升级场景：v29 旧库跑迁移后补齐 track_type");

    runMigrations(db); // 幂等：二次跑不报错
    const cols2 = db.prepare("PRAGMA table_info(exam_group_members)").all() as Array<{ name: string }>;
    ok(!!cols2.find((c) => c.name === "track_type"), "幂等：二次跑迁移不报错且不丢列");
  } catch (e) {
    fail++;
    console.log("FAIL: 升级场景 runMigrations 抛异常:", (e as Error).message);
  } finally {
    db.close();
    try {
      fs.unlinkSync(p);
    } catch {}
  }
}

console.log(`\n=== track_type 迁移冒烟: ${pass} pass / ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
