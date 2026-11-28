import { competitionRank } from "../../shared/ranking";

export interface ExamGroupExportMember {
  exam_id: number;
  exam_name: string;
  subject: string | null;
  sort_order: number;
  assigned_formula?: string | null;
}

export interface ExamGroupExportScore {
  student_id: number;
  exam_id: number;
  total_score: number;
  assigned_score: number | null;
  student_number: string;
  name: string;
  class_id: number | null;
  class_name: string | null;
}

export type ExamGroupExportRows = Array<Record<string, string | number>>;

type SubjectSelection =
  | { ok: true; examIds: number[] }
  | { ok: false; message: string };

/** undefined means all members; an explicit empty array means overview only. */
export function selectExamGroupExportMembers(
  members: ExamGroupExportMember[],
  requested: unknown,
): SubjectSelection {
  if (requested === undefined) return { ok: true, examIds: members.map((member) => member.exam_id) };
  if (!Array.isArray(requested)) return { ok: false, message: "subjectExamIds 必须是考试 ID 数组" };
  const memberIds = new Set(members.map((member) => member.exam_id));
  const examIds: number[] = [];
  for (const value of requested) {
    const id = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(id) || id <= 0 || !memberIds.has(id)) {
      return { ok: false, message: `无效的大考科目考试 ID：${String(value)}` };
    }
    examIds.push(id);
  }
  return { ok: true, examIds };
}

/**
 * Build the overview workbook from real score rows. Missing subjects stay blank
 * in subject columns, while totals use zero so partial participation remains
 * comparable with the group ranking endpoint.
 */
export function buildExamGroupExportOverview(
  members: ExamGroupExportMember[],
  scores: ExamGroupExportScore[],
  totalScoreMode: "raw" | "assigned",
): { headers: string[]; rows: ExamGroupExportRows } {
  const studentMap = new Map<number, {
    number: string;
    name: string;
    classId: number | null;
    className: string;
    exams: Map<number, { raw: number; assigned: number | null }>;
  }>();
  for (const score of scores) {
    let student = studentMap.get(score.student_id);
    if (!student) {
      student = {
        number: score.student_number,
        name: score.name,
        classId: score.class_id,
        className: score.class_name || "未知班级",
        exams: new Map(),
      };
      studentMap.set(score.student_id, student);
    }
    student.exams.set(score.exam_id, { raw: score.total_score, assigned: score.assigned_score });
  }

  const headers = ["班级", "姓名", "考号", "原始总分", "赋分总分", "总分年排", "总分班排"];
  for (const member of members) {
    const subject = member.subject || `科目${member.exam_id}`;
    headers.push(`${subject}原始分`);
    if (member.assigned_formula) headers.push(`${subject}赋分`);
    headers.push(`${subject}年排`, `${subject}班排`);
  }

  const rows: ExamGroupExportRows = [];
  const rowClassIds = new Map<ExamGroupExportRows[number], number | null>();
  for (const student of studentMap.values()) {
    let totalRaw = 0;
    let totalAssigned = 0;
    const row: Record<string, string | number> = {
      "班级": student.className,
      "姓名": student.name,
      "考号": student.number,
      "原始总分": 0,
      "赋分总分": 0,
      "总分年排": "",
      "总分班排": "",
    };
    for (const member of members) {
      const subject = member.subject || `科目${member.exam_id}`;
      const score = student.exams.get(member.exam_id);
      if (!score) {
        row[`${subject}原始分`] = "";
        if (member.assigned_formula) row[`${subject}赋分`] = "";
        row[`${subject}年排`] = "";
        row[`${subject}班排`] = "";
        continue;
      }
      totalRaw += score.raw;
      totalAssigned += score.assigned ?? score.raw;
      row[`${subject}原始分`] = score.raw;
      if (member.assigned_formula) row[`${subject}赋分`] = score.assigned ?? score.raw;
      row[`${subject}年排`] = "";
      row[`${subject}班排`] = "";
    }
    row["原始总分"] = totalRaw;
    row["赋分总分"] = totalAssigned;
    rows.push(row);
    rowClassIds.set(row, student.classId);
  }

  const totalKey = totalScoreMode === "assigned" ? "赋分总分" : "原始总分";
  rows.sort((a, b) => Number(b[totalKey]) - Number(a[totalKey]));
  competitionRank(rows, (row) => Number(row[totalKey]), (row, rank) => {
    row["总分年排"] = rank;
    row["总分班排"] = "";
  });

  const classGroups = new Map<number | null, ExamGroupExportRows>();
  for (const row of rows) {
    const key = rowClassIds.get(row) ?? null;
    if (!classGroups.has(key)) classGroups.set(key, []);
    classGroups.get(key)!.push(row);
  }
  for (const group of classGroups.values()) {
    competitionRank(group, (row) => Number(row[totalKey]), (row, rank) => { row["总分班排"] = rank; });
  }

  for (const member of members) {
    const subject = member.subject || `科目${member.exam_id}`;
    const rawKey = `${subject}原始分`;
    const gradeKey = `${subject}年排`;
    const classKey = `${subject}班排`;
    const withScore = rows.filter((row) => row[rawKey] !== "");
    withScore.sort((a, b) => Number(b[rawKey]) - Number(a[rawKey]));
    competitionRank(withScore, (row) => Number(row[rawKey]), (row, rank) => { row[gradeKey] = rank; });

    const subjectClasses = new Map<number | null, ExamGroupExportRows>();
    for (const row of withScore) {
      const key = rowClassIds.get(row) ?? null;
      if (!subjectClasses.has(key)) subjectClasses.set(key, []);
      subjectClasses.get(key)!.push(row);
    }
    for (const group of subjectClasses.values()) {
      competitionRank(group, (row) => Number(row[rawKey]), (row, rank) => { row[classKey] = rank; });
    }
  }

  return { headers, rows };
}
