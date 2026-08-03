import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runMigrations } from '../src/server/db/migrations';

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string, extra?: unknown) {
  if (cond) {
    pass++;
    console.log('PASS:', msg);
  } else {
    fail++;
    console.log('FAIL:', msg, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

// 构造「已升级到 v30（main 已合 #211 的 annotation），但无 track 列」的旧库
function makeOldDb(): { db: Database.Database; file: string } {
  const file = path.join(os.tmpdir(), `px-track-v31-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
  const db = new Database(file);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE exam_group_members (id INTEGER PRIMARY KEY, group_id INTEGER, student_id INTEGER);
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT);
  `);
  const ins = db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)');
  for (let v = 1; v <= 30; v++) ins.run(v, `migration-${v}`); // 预置 1..30 已应用，模拟 main 现状
  return { db, file };
}

// 场景1：旧库升级跑 v31 —— 应加上 users.track + exam_group_members.track_type
{
  const { db, file } = makeOldDb();
  let threw = false;
  try {
    runMigrations(db);
  } catch (e) {
    threw = true;
    console.log('  runMigrations 抛异常:', (e as Error).message);
  }
  ok(!threw, '旧库升级 runMigrations 不抛异常');
  const egm = db.prepare('PRAGMA table_info(exam_group_members)').all() as Array<{ name: string; dflt_value: unknown }>;
  const users = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  ok(egm.some((c) => c.name === 'track_type'), '升级后 exam_group_members.track_type 已加上');
  ok(users.some((c) => c.name === 'track'), '升级后 users.track 已加上');
  const tt = egm.find((c) => c.name === 'track_type');
  const ttDflt = tt?.dflt_value ? String(tt.dflt_value).replace(/^'|'$/g, '') : null;
  ok(ttDflt === 'common', 'track_type 默认值为 common', tt?.dflt_value);
  db.close();
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

// 场景2：幂等 —— 二次 runMigrations 不报错且不丢列
{
  const { db, file } = makeOldDb();
  runMigrations(db);
  let threw2 = false;
  try {
    runMigrations(db);
  } catch (e) {
    threw2 = true;
    console.log('  二次 runMigrations 抛异常:', (e as Error).message);
  }
  ok(!threw2, '幂等：二次 runMigrations 不抛异常');
  const egm = db.prepare('PRAGMA table_info(exam_group_members)').all() as Array<{ name: string }>;
  ok(egm.some((c) => c.name === 'track_type'), '幂等：二次后 track_type 仍在');
  db.close();
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
