import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const maria = process.argv.includes('--mariadb');
if (maria) {
  assert.equal(process.env.PROJECTX_MARIADB_DATABASE, 'projectx_class_archive_test');
  assert.equal(process.env.PROJECTX_MARIADB_HOST, '127.0.0.1');
} else {
  delete process.env.PROJECTX_MARIADB_HOST;
  delete process.env.PROJECTX_MYSQL_HOST;
  process.env.PROJECTX_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'class-archive-')), 'test.db');
}
const { initializeDatabase, getDatabase, closeDatabase } = await import('../src/server/db/index');
const { getMysqlDb, initMariadbSchema, resetAdapter } = await import('../src/server/db/mysql');
if (!maria) initializeDatabase();
const db = getMysqlDb();
if (maria) {
  assert.equal((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()'))?.n, 0, 'Use a new disposable database');
  await initMariadbSchema();
}
const { ClassRepository } = await import('../src/server/repositories/ClassRepository');
const { UserRepository } = await import('../src/server/repositories/UserRepository');
const { ExamRepository } = await import('../src/server/repositories/ExamRepository');
const { ensureExamParticipants, setExplicitParticipants } = await import('../src/server/services/examParticipants');
const { assertActiveClassScope } = await import('../src/server/services/activeClassScope');
const repo = new ClassRepository(db), users = new UserRepository();
try {
  const g = await repo.createGrade('高二');
  const old = await repo.createClass(g.id, '高二1班');
  const current = await repo.createClass(g.id, '高二2班');
  const student = (await db.run("INSERT INTO users(username,password_hash,name,role_id,student_number) VALUES ('archive_student','disabled','旧班学生',3,'ARC001')")).lastInsertRowid;
  const other = (await db.run("INSERT INTO users(username,password_hash,name,role_id,student_number) VALUES ('current_student','disabled','在读学生',3,'ARC002')")).lastInsertRowid;
  const teacher = (await db.run("INSERT INTO users(username,password_hash,name,role_id) VALUES ('archive_teacher','disabled','教师',2)")).lastInsertRowid;
  await repo.addStudent(old.id, student); await repo.addStudent(current.id, other);
  await repo.addTeacherToClass(teacher, old.id, '数学');
  async function exam(name: string, classId: number | null = null) {
    return (await db.run('INSERT INTO exams(name,grade_id,class_id) VALUES (?,?,?)', name, g.id, classId)).lastInsertRowid;
  }
  const e = await exam('旧班考试', old.id), gradeExam = await exam('原年级考试'), explicit = await exam('显式名单', old.id);
  await setExplicitParticipants(db, explicit, [other]);
  await db.run('INSERT INTO student_scores(exam_id,student_id,total_score) VALUES (?,?,90)', e, student);
  // The old implementation is exactly this physical DELETE.
  await assert.rejects(db.run('DELETE FROM classes WHERE id = ?', old.id), /foreign key|FOREIGN KEY/i);
  console.log('REPRODUCED: original class DELETE fails with exam foreign key');

  // Upgrade a populated pre-v50 database and verify repeat initialization.
  await db.run('ALTER TABLE classes DROP COLUMN archived_at');
  await db.run('ALTER TABLE grades DROP COLUMN archived_at');
  await db.run('DELETE FROM schema_migrations WHERE version = 50');
  if (maria) { await initMariadbSchema(); await initMariadbSchema(); }
  else { const { runMigrations } = await import('../src/server/db/migrations'); runMigrations(getDatabase()); runMigrations(getDatabase()); }
  assert.equal((await repo.findClassById(old.id))?.name, '高二1班');
  assert.ok(await db.get('SELECT version FROM schema_migrations WHERE version = 50'));
  console.log('PASS: populated database migration and idempotence');

  // A failure after freezing participants must roll back the entire archive.
  const proxy = new Proxy(db, { get(target, prop) {
    if (prop === 'transaction') return (fn: any) => target.transaction(async tx => fn(new Proxy(tx, { get(t, key) {
      if (key === 'run') return (sql: string, ...args: any[]) => {
        if (sql.startsWith('UPDATE classes SET archived_at')) throw new Error('injected archive failure');
        return t.run(sql, ...args);
      };
      const value = Reflect.get(t, key); return typeof value === 'function' ? value.bind(t) : value;
    } })));
    const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
  } });
  await assert.rejects(new ClassRepository(proxy).deleteClass(old.id), /injected archive failure/);
  assert.ok(await repo.findClassById(old.id));
  assert.equal((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM exam_participants WHERE exam_id = ?', e))?.n, 0);
  await repo.deleteClass(old.id);
  assert.equal(await repo.findClassById(old.id), null);
  assert.deepEqual((await repo.listClasses(g.id)).map(c => c.id), [current.id]);
  assert.equal((await db.get<{ class_id: number }>('SELECT class_id FROM exams WHERE id = ?', e))?.class_id, old.id);
  assert.equal((await db.get<{ total_score: number }>('SELECT total_score FROM student_scores WHERE exam_id = ?', e))?.total_score, 90);
  assert.equal((await ensureExamParticipants(db, e)).participantCount, 1);
  assert.equal((await ensureExamParticipants(db, gradeExam)).participantCount, 2);
  assert.equal((await ensureExamParticipants(db, explicit)).source, 'explicit');
  assert.equal((await users.findTeacherById(teacher))?.classes?.length, 0);
  assert.equal((await repo.listTeacherClasses(teacher)).length, 0);
  assert.equal((await users.getUserClasses(student)).length, 0);
  assert.equal((await users.listAllStudentsForExport()).some(r => r.student_id === student), false);
  assert.ok(await db.get('SELECT 1 FROM class_students WHERE class_id = ? AND student_id = ?', old.id, student));
  assert.ok(await db.get('SELECT 1 FROM teacher_classes WHERE class_id = ? AND teacher_id = ?', old.id, teacher));
  await assert.rejects(new ExamRepository(db).createExam({name:'不能新建到旧班',card_id:'unused',class_id:old.id}), /已归档/);
  await assert.rejects(assertActiveClassScope(db, undefined, old.id), /已归档/);
  const next = await exam('新年级考试');
  assert.equal((await ensureExamParticipants(db, next)).participantCount, 1);
  console.log('PASS: archive hides active entries, retains exams/scores/relations and frozen rosters; new rosters exclude archived classes');

  // ── 评审 P1(4)：归档关系必须在「转班 / 复用重新导入 / v58 去重」之后仍然保留 ──
  // 原实现（replaceStudentClassLink / moveStudent / 导入复用 / v58 迁移）无条件执行
  // `DELETE FROM class_students WHERE student_id = ?`，会把上面刚断言保留的归档关联当场抹掉，
  // 两条测试互为矛盾。修复后删除只作用于「当前归属」（班级与年级均未归档）。
  await repo.addStudent(current.id, student);
  assert.ok(await db.get('SELECT 1 FROM class_students WHERE class_id = ? AND student_id = ?', old.id, student),
    '转班不得删除已归档班级的历史关联');
  assert.ok(await db.get('SELECT 1 FROM class_students WHERE class_id = ? AND student_id = ?', current.id, student));
  assert.equal((await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM class_students cs
       JOIN classes c ON c.id = cs.class_id
       JOIN grades g ON g.id = c.grade_id
      WHERE cs.student_id = ? AND c.archived_at IS NULL AND g.archived_at IS NULL`, student))?.n, 1,
    '当前归属仍须严格一人一行');
  assert.equal((await users.getUserClasses(student)).length, 1, '学生可见班级只算未归档的当前归属');
  console.log('PASS: 转班保留归档历史关联，同时维持当前归属一人一行');

  // moveStudent 与导入复用共用 clearActiveStudentClassLinks，同样只清当前归属。
  const residue = await repo.createClass(g.id, '高二9班');
  await db.run('INSERT INTO class_students(class_id, student_id, joined_at) VALUES (?,?,?)', residue.id, student, '2020-01-01 00:00:00');
  await repo.moveStudent(current.id, residue.id, student);
  assert.ok(await db.get('SELECT 1 FROM class_students WHERE class_id = ? AND student_id = ?', old.id, student),
    'moveStudent 不得删除归档关联');
  assert.equal((await db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM class_students WHERE student_id = ? AND class_id <> ?', student, old.id))?.n, 1,
    'moveStudent 后当前关联只剩目标班一条');
  assert.equal(await db.get('SELECT 1 FROM class_students WHERE class_id = ? AND student_id = ?', current.id, student), null);

  // v58 去重迁移：制造「两条当前归属 + 一条归档历史」，重跑迁移后只应留下最新的当前归属。
  await db.run('INSERT INTO class_students(class_id, student_id, joined_at) VALUES (?,?,?)', current.id, student, '2021-01-01 00:00:00');
  await db.run('DELETE FROM schema_migrations WHERE version = 58');
  if (maria) await initMariadbSchema();
  else {
    const { runMigrations } = await import('../src/server/db/migrations');
    runMigrations(getDatabase());
  }
  assert.ok(await db.get('SELECT 1 FROM class_students WHERE class_id = ? AND student_id = ?', old.id, student),
    'v58 不得删除归档关联');
  assert.ok(await db.get('SELECT 1 FROM class_students WHERE class_id = ? AND student_id = ?', residue.id, student),
    'v58 应保留 joined_at 最新的当前归属');
  assert.equal(await db.get('SELECT 1 FROM class_students WHERE class_id = ? AND student_id = ?', current.id, student), null,
    'v58 应清除较旧的当前归属残留');
  console.log('PASS: v58 去重只作用于当前归属，归档历史关联保留');
  await repo.deleteClass(residue.id);

  // Reusing the name must create a new identity, never revive history.
  const replacement = await repo.createClass(g.id, '高二1班');
  assert.notEqual(replacement.id, old.id);
  await repo.deleteClass(current.id); await repo.deleteClass(replacement.id);
  assert.equal((await repo.listClasses(g.id)).length, 0);
  await repo.deleteGrade(g.id);
  assert.equal((await repo.listGrades()).some(x => x.id === g.id), false);
  assert.ok(await db.get('SELECT id FROM grades WHERE id = ?', g.id));
  assert.ok(await db.get('SELECT id FROM exams WHERE id = ?', e));
  await assert.rejects(repo.createClass(g.id,'非法新班'), /已归档/);
  console.log('PASS: last class and parent grade archive without destroying history');
  console.log(`ALL PASS (${db.dialect})`);
} finally { resetAdapter(); if (!maria) closeDatabase(); }
