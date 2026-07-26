/**
 * 高二一班 英语月考 测试数据种子脚本
 * ───────────────────────────────────────────────────────────
 * 运行前提：
 *   - 数据库后端为 MariaDB，且连接参数已就绪
 *     （环境变量 PROJECTX_MARIADB_* / PROJECTX_MYSQL_* 或 config.yml 的 remote 段）
 *   - 高二一班学生已存在，并归属于某个班级记录（students 通过 class_students 关联）
 *
 * 运行方式：
 *   npx tsx testdata/gaoer-yiban/scripts/seed-english.ts
 *
 * 行为：
 *   1. 自动检索名称含「高二」且含「1/一」且含「班」的班级（唯一命中则采用；
 *      命中 0 个或多个时打印全部班级列表并退出，便于确认确切班级名）
 *   2. 取该班级全部学生
 *   3. 清理同名前缀（高二1班-）的旧考试/成绩/答题卡，保证可重复运行且不破坏演示数据
 *   4. 新建 answer_cards + exams（英语 / 满分 150 / 2026-07-15 / closed）
 *   5. 为每名学生按「基于学号的确定性伪随机」生成总分（均值≈112，钟形分布，裁剪 [0,150]）
 *   6. 重算该场考试排名与百分位
 *
 * 命名策略：考试名固定前缀「高二1班-」与班级名检索解耦，仅用于定位学生；
 *          不删除任何「演示-」前缀数据。
 */

import { getMysqlDb } from "../../../src/server/db/mysql";
import { recomputeExamRankings } from "../../../src/server/services/rankingUpdate";
import type { DbAdapter } from "../../../src/server/db/mysql";

// ── 可调整常量 ───────────────────────────────────────────
const EXAM_NAME_PREFIX = "高二1班-";          // 考试名前缀（清理/匹配用）
const EXAM_NAME = `${EXAM_NAME_PREFIX}月考`;  // 考试显示名
const SUBJECT = "英语";
const FULL_SCORE = 150;
const EXAM_DATE = "2026-07-15";
const START_TIME = `${EXAM_DATE} 09:00:00`;
const CARD_ID = "GYB-EN-001";                // answer_cards.id（VARCHAR 主键，需唯一）
const MEAN = 112;                            // 成绩均值 ≈ 75% 满分
const STD = 18;                              // 标准差，控制离散度

// ── 确定性伪随机（保证重跑结果一致） ──────────────────────
function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  const u = Math.max(1e-9, rng());
  const v = Math.max(1e-9, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ── 班级匹配规则 ───────────────────────────────────────────
// 命中「高二」+ 「1/一」+ 「班」。若学校实际命名为「2024级1班」等不含「高二」二字的格式，
// 本规则会匹配失败并打印全部班级，请在输出中确认确切名称后调整下方正则。
function matchClass(name: string): boolean {
  return /高二/.test(name) && /[1一]/.test(name) && /班/.test(name);
}

interface ClassRow {
  id: number;
  name: string;
  grade_id: number | null;
  grade_name: string | null;
}
interface StudentRow {
  id: number;
  username: string;
  name: string;
  student_number: string | null;
}

async function main(): Promise<void> {
  const db: DbAdapter = getMysqlDb();

  // 1. 检索班级
  const classes = await db.all<ClassRow>(
    `SELECT c.id, c.name, c.grade_id, g.name AS grade_name
       FROM classes c
       LEFT JOIN grades g ON g.id = c.grade_id
      ORDER BY c.id`
  );
  const matched = classes.filter((c) => matchClass(c.name));

  if (matched.length === 0) {
    console.error("✗ 未匹配到高二一班班级。现有班级列表如下，请确认确切名称：");
    for (const c of classes) {
      console.error(`   id=${c.id}  name="${c.name}"  grade=${c.grade_name ?? c.grade_id}`);
    }
    console.error("→ 若是「2024级1班」等不含「高二」的命名，请修改脚本 matchClass() 正则后重跑。");
    process.exit(1);
  }
  if (matched.length > 1) {
    console.error("✗ 匹配到多个候选班级，无法自动选定，请明确其一：");
    for (const c of matched) {
      console.error(`   id=${c.id}  name="${c.name}"  grade=${c.grade_name ?? c.grade_id}`);
    }
    process.exit(1);
  }
  const targetClass = matched[0];
  console.log(`[定位] 班级「${targetClass.name}」 id=${targetClass.id} grade_id=${targetClass.grade_id}`);

  // 2. 取该班学生
  const students = await db.all<StudentRow>(
    `SELECT u.id, u.username, u.name, u.student_number
       FROM class_students cs
       JOIN users u ON u.id = cs.student_id
      WHERE cs.class_id = ?
      ORDER BY u.id`,
    targetClass.id
  );
  if (students.length === 0) {
    console.error(`✗ 班级「${targetClass.name}」未关联任何学生（class_students 为空）。`);
    process.exit(1);
  }
  console.log(`[学生] 共 ${students.length} 人`);

  // 3. 清理旧数据（仅本前缀，不影响演示数据）
  await db.run(
    "DELETE FROM student_scores WHERE exam_id IN (SELECT id FROM exams WHERE name LIKE ?)",
    `${EXAM_NAME_PREFIX}%`
  );
  await db.run("DELETE FROM exams WHERE name LIKE ?", `${EXAM_NAME_PREFIX}%`);
  await db.run("DELETE FROM answer_cards WHERE id = ?", CARD_ID);
  console.log(`[清理] 已删除「${EXAM_NAME_PREFIX}」前缀的旧考试/成绩/答题卡`);

  // 4. 创建答题卡
  const adminRow = await db.get<{ id: number }>("SELECT id FROM users WHERE username = 'admin'");
  const adminId = adminRow?.id ?? 1;
  await db.run(
    "INSERT INTO answer_cards (id, title, subject, subject_label, exam_date, created_by) VALUES (?, ?, ?, ?, ?, ?)",
    CARD_ID,
    EXAM_NAME,
    SUBJECT,
    SUBJECT,
    EXAM_DATE,
    adminId
  );

  // 5. 创建考试
  const examRes = await db.run(
    `INSERT INTO exams (name, card_id, grade_id, class_id, subject, start_time, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 'closed', ?)`,
    EXAM_NAME,
    CARD_ID,
    targetClass.grade_id,
    targetClass.id,
    SUBJECT,
    START_TIME,
    adminId
  );
  const examId = examRes.lastInsertRowid;
  console.log(`[考试] id=${examId} name="${EXAM_NAME}" subject=${SUBJECT} date=${EXAM_DATE}`);

  // 6. 生成成绩（确定性伪随机，钟形分布）
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const s of students) {
    const seedKey = String(s.student_number ?? s.username ?? s.id);
    const rng = mulberry32(hashStr(seedKey));
    const raw = MEAN + gaussian(rng) * STD;
    const score = Math.round(Math.min(FULL_SCORE, Math.max(0, raw)));
    await db.run(
      `INSERT INTO student_scores (exam_id, student_id, objective_score, subjective_score, total_score)
       VALUES (?, ?, ?, 0, ?)`,
      examId,
      s.id,
      score,
      score
    );
    min = Math.min(min, score);
    max = Math.max(max, score);
    sum += score;
  }
  const avg = sum / students.length;
  console.log(`[成绩] 人数=${students.length} 均值=${avg.toFixed(1)} 最低=${min} 最高=${max} 满分=${FULL_SCORE}`);

  // 7. 重算排名与百分位
  await recomputeExamRankings(db, examId);
  console.log("[完成] 排名/百分位已重算，脚本结束。");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[失败]", err);
    process.exit(1);
  });
