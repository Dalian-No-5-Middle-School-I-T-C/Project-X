/**
 * 随机分配算法 — Fisher-Yates shuffle + djb2 hash seed
 * 保证相同种子产生相同分配，可重现、可审计
 */

export function hashSeed(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) + hash + input.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash);
}

export function seededShuffle<T>(arr: T[], seed: number): T[] {
  const result = [...arr];
  let s = seed;
  for (let i = result.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * 将学生列表按顺序分配给多位教师
 * @param studentIds 学生 ID 列表（已打乱）
 * @param teacherIds 教师 ID 列表
 * @param countsPerTeacher 每位教师分配的学生数
 * @returns Map<teacherId, studentId[]>
 */
export function distributeStudents(
  studentIds: number[],
  teacherIds: number[],
  countsPerTeacher: number[]
): Map<number, number[]> {
  const result = new Map<number, number[]>();
  for (const tid of teacherIds) result.set(tid, []);

  let cursor = 0;
  for (let t = 0; t < teacherIds.length; t++) {
    const count = countsPerTeacher[t] ?? 0;
    result.get(teacherIds[t])!.push(...studentIds.slice(cursor, cursor + count));
    cursor += count;
  }

  return result;
}

/**
 * 一步完成随机分配
 * @param studentIds 全部学生
 * @param teacherCounts Map<teacherId, number> 每位教师份数
 * @param seedStr 种子字符串（如 `${examId}_${blockId}_${timestamp}`）
 */
export function randomDistribute(
  studentIds: number[],
  teacherCounts: Map<number, number>,
  seedStr: string
): Map<number, number[]> {
  const seed = hashSeed(seedStr);
  const shuffled = seededShuffle(studentIds, seed);

  const teacherIds = Array.from(teacherCounts.keys());
  const counts = teacherIds.map((tid) => teacherCounts.get(tid) ?? 0);

  return distributeStudents(shuffled, teacherIds, counts);
}
