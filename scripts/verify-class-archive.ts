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
  assert.equal((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM exam_class_memberships WHERE exam_id = ?', e))?.n, 0,
    '归档失败时，班级快照也必须与应考名单一起回滚');
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

  // ── 评审修订（#304/#305/#308 复核）：归档关系必须在「加入班级 / 调班 / v58」之后保留，
  // 且在读多班关联是合法状态（#308 按学生去重排名、保留各班完整成员），
  // 任何路径不得以「一人一个在读班」为由清掉另一条在读关联。──
  await repo.addStudent(current.id, student);
  assert.ok(await db.get('SELECT 1 FROM class_students WHERE class_id = ? AND student_id = ?', old.id, student),
    '加入班级不得删除已归档班级的历史关联');
  assert.ok(await db.get('SELECT 1 FROM class_students WHERE class_id = ? AND student_id = ?', current.id, student));
  console.log('PASS: 加入班级保留归档历史关联');

  // 多班在读合法：已在一个在读班的学生加入第二个在读班，两条在读关联都必须保留。
  const second = await repo.createClass(g.id, '高二8班');
  await repo.addStudent(second.id, student);
  assert.ok(await db.get('SELECT 1 FROM class_students WHERE class_id = ? AND student_id = ?', current.id, student),
    '加入第二个在读班不得清空第一个在读班的关联');
  assert.ok(await db.get('SELECT 1 FROM class_students WHERE class_id = ? AND student_id = ?', second.id, student));
  assert.equal((await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM class_students cs
       JOIN classes c ON c.id = cs.class_id
       JOIN grades gr ON gr.id = c.grade_id
      WHERE cs.student_id = ? AND c.archived_at IS NULL AND gr.archived_at IS NULL`, student))?.n, 2,
    '两条在读关联都保留（多班成员合法）');
  assert.equal((await users.getUserClasses(student)).length, 2, '学生可见班级包含全部在读班');
  console.log('PASS: 加入班级纯增量，在读多班关联不被清空');

  // moveStudent 是显式调班：只移除原班关联，其他在读班与归档班级的历史关联保留。
  const residue = await repo.createClass(g.id, '高二9班');
  await db.run('INSERT INTO class_students(class_id, student_id, joined_at) VALUES (?,?,?)', residue.id, student, '2020-01-01 00:00:00');
  await repo.moveStudent(current.id, residue.id, student);
  assert.ok(await db.get('SELECT 1 FROM class_students WHERE class_id = ? AND student_id = ?', old.id, student),
    'moveStudent 不得删除归档关联');
  assert.ok(await db.get('SELECT 1 FROM class_students WHERE class_id = ? AND student_id = ?', second.id, student),
    'moveStudent 不得删除其他在读关联');
  assert.equal(await db.get('SELECT 1 FROM class_students WHERE class_id = ? AND student_id = ?', current.id, student), null,
    'moveStudent 移除原班关联');
  assert.ok(await db.get('SELECT 1 FROM class_students WHERE class_id = ? AND student_id = ?', residue.id, student));
  console.log('PASS: moveStudent 只移除原班关联，其他在读与归档关联保留');

  // v58 已停用删除（号位保留）：制造「三条在读 + 一条归档」后重跑迁移，必须全部原样保留。
  await db.run('INSERT INTO class_students(class_id, student_id, joined_at) VALUES (?,?,?)', current.id, student, '2021-01-01 00:00:00');
  await db.run('DELETE FROM schema_migrations WHERE version = 58');
  if (maria) await initMariadbSchema();
  else {
    const { runMigrations } = await import('../src/server/db/migrations');
    runMigrations(getDatabase());
  }
  for (const cls of [old, residue, second, current]) {
    assert.ok(await db.get('SELECT 1 FROM class_students WHERE class_id = ? AND student_id = ?', cls.id, student),
      'v58 不得删除任何关联（归档历史与在读多班都保留）');
  }
  console.log('PASS: v58 已停用删除，在读多班与归档历史关联全部保留');

  // 「当前班级」读取口径（评审 P2）：在读优先——归档班 joined_at 同刻、id 更大时也不得选中。
  const { AnalysisRepository } = await import('../src/server/repositories/AnalysisRepository');
  const analysis = new AnalysisRepository();
  const archBig = await repo.createClass(g.id, '高二10班'); // 晚于 second 创建 → id 更大
  await db.run('INSERT INTO class_students(class_id, student_id, joined_at) VALUES (?,?,CURRENT_TIMESTAMP)', archBig.id, student);
  await repo.deleteClass(archBig.id);
  const currentClassId = (await db.get<{ class_id: number | null }>(
    `SELECT (SELECT cs_cur.class_id FROM class_students cs_cur
       JOIN classes c_cur ON c_cur.id = cs_cur.class_id
       JOIN grades g_cur ON g_cur.id = c_cur.grade_id
       WHERE cs_cur.student_id = ?
       ORDER BY (c_cur.archived_at IS NULL AND g_cur.archived_at IS NULL) DESC,
                cs_cur.joined_at DESC, cs_cur.class_id DESC LIMIT 1) as class_id`, student))?.class_id;
  assert.equal(currentClassId, second.id,
    '归档班（id 更大、joined_at 同刻）不得成为当前班级，在读关联优先');
  assert.equal((await analysis.getStudentTrend(student)).length > 0, true,
    '当前班级口径可正常驱动成长曲线查询');
  console.log('PASS: 当前班级在读优先，归档班（id 更大、同刻）不选中');
  await repo.deleteClass(residue.id);

  // 历史曲线按考试时班级，不能在调班后改用新班同学的成绩。
  // 旧考试原班只有本人 90 分；新考试在读班的两人均分为 60。
  await db.run('UPDATE exams SET score_published = 1 WHERE id = ?', e);
  const trendMate = (await db.run("INSERT INTO users(username,password_hash,name,role_id,student_number) VALUES ('trend_mate','disabled','班均分陪跑',3,'ARC003')")).lastInsertRowid;
  await db.run('INSERT INTO class_students(class_id, student_id) VALUES (?,?)', second.id, trendMate);
  await db.run('INSERT INTO student_scores(exam_id, student_id, total_score) VALUES (?,?,30)', e, trendMate);
  const { ScoreRepository } = await import('../src/server/repositories/ScoreRepository');
  const trendRows = await new ScoreRepository().getStudentTrendData(Number(student));
  const trendRow = trendRows.find(p => Number(p.examId) === Number(e));
  assert.ok(trendRow, '已公布考试应进入学生成长曲线');
  assert.equal(Number(trendRow!.classAvg), 90, '历史考试班均分保留原班，不使用调班后的新班');
  const currentExam = await exam('在读新考试');
  await db.run('UPDATE exams SET score_published = 1 WHERE id = ?', currentExam);
  await db.transaction(async tx => {
    const exams = new ExamRepository(tx);
    await exams.saveStudentScore(currentExam, student, 90, 0);
    await exams.saveStudentScore(currentExam, trendMate, 30, 0);
  });
  const currentTrend = (await new ScoreRepository().getStudentTrendData(Number(student))).find(p => Number(p.examId) === Number(currentExam));
  assert.equal(Number(currentTrend?.classAvg), 60, '新考试班均分取在读班，归档班不得污染新考试');
  console.log('PASS: 成长曲线旧考试保留原班，新考试使用在读班');

  // Reusing the name must create a new identity, never revive history.
  const replacement = await repo.createClass(g.id, '高二1班');
  assert.notEqual(replacement.id, old.id);
  await repo.deleteClass(current.id); await repo.deleteClass(second.id); await repo.deleteClass(replacement.id);
  assert.equal((await repo.listClasses(g.id)).length, 0);
  await repo.deleteGrade(g.id);
  assert.equal((await repo.listGrades()).some(x => x.id === g.id), false);
  assert.ok(await db.get('SELECT id FROM grades WHERE id = ?', g.id));
  assert.ok(await db.get('SELECT id FROM exams WHERE id = ?', e));
  await assert.rejects(repo.createClass(g.id,'非法新班'), /已归档/);
  console.log('PASS: last class and parent grade archive without destroying history');
  console.log(`ALL PASS (${db.dialect})`);
} finally { resetAdapter(); if (!maria) closeDatabase(); }
