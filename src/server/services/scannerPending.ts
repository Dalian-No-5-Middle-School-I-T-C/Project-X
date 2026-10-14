import { createHash } from "node:crypto";
import { getMysqlDb, buildInsertIgnore, type DbAdapter } from "../db";
import { CardRepository } from "../repositories/CardRepository";
import {
  enqueueScannerSubmission,
  linkSavedScannerCrops,
} from "./scannerSubmissions";
import {
  groupSessionPages,
  validateSessionGroupStructure,
  gradeSessionGroup,
  legacySessionBlockReason,
} from "../../apps/answer-card/server/scanner/session-results";
import type { ScanRecordWithResult } from "../../apps/answer-card/server/database/scan-store";
import { cardFingerprint } from "../../shared/cardVersion";
import {
  ensureExamParticipants,
  isExamParticipant,
  findStudentsOutsideParticipantScope,
} from "./examParticipants";
import { persistScannerResultToMainDb } from "./scannerResultPersistence";
import { recomputeExamRankings } from "./rankingUpdate";
import { analysisCache } from "./analysisCache";

type PendingRow = {
  exam_id: number;
  session_id: string;
  group_id: string;
  student_number: string;
  state: string;
  pages_json: string;
  previously_saved: number;
  result_json: string | null;
  score_snapshot: string | null;
};
async function evidence(db: DbAdapter, row: PendingRow) {
  const exam = await db.get<{
    card_id: string;
    class_id: number | null;
    grade_id: number | null;
  }>("SELECT card_id,class_id,grade_id FROM exams WHERE id=?", row.exam_id);
  const card = exam && (await new CardRepository(db).findById(exam.card_id));
  if (!exam || !card) throw new Error("考试或答题卡不存在");
  const session = await db.get<{
    card_id: string;
    card_version: string | null;
    version_source: string;
  }>(
    "SELECT card_id,card_version,version_source FROM twain_scan_sessions WHERE id=?",
    row.session_id,
  );
  const raw = await db.all<
    ScanRecordWithResult & {
      objective_json: string | null;
      subjective_json: string | null;
    }
  >(
    `SELECT r.*,s.identity_mode,g.objective_json,g.subjective_json
    FROM twain_scan_records r JOIN twain_scan_sessions s ON s.id=r.session_id
    LEFT JOIN twain_recognition_results g ON g.scan_record_id=r.id WHERE r.session_id=? ORDER BY r.page_num,r.side,r.id`,
    row.session_id,
  );
  const records = raw.map((r) => ({
    ...r,
    recognition: r.objective_json
      ? { objective_json: r.objective_json, subjective_json: r.subjective_json }
      : null,
  })) as ScanRecordWithResult[];
  const grouped = groupSessionPages(card, records),
    group = grouped.groups.get(row.group_id);
  let result: ReturnType<typeof gradeSessionGroup> | undefined,
    issue: string | undefined;
  try {
    if (
      !session ||
      session.card_id !== card.id ||
      session.card_version !== cardFingerprint(card) ||
      session.version_source === "legacy_verified"
    )
      throw new Error("答题卡版本变化或来源未验证，请重新上传");
    if (!group) throw new Error("原卷已变更，请重新上传");
    if (
      legacySessionBlockReason({
        pageCount: grouped.pageCount,
        sided: card.sided,
        records,
        groups: grouped.groups,
      })
    )
      throw new Error("原卷分组尚未验证");
    validateSessionGroupStructure(card, group, grouped.pageCount);
    const numbers = [
      ...new Set(group.map((r) => r.record.student_id).filter(Boolean)),
    ];
    if (numbers.length !== 1 || numbers[0] !== row.student_number)
      throw new Error("学号已变化，请先保存订正并刷新");
    result = gradeSessionGroup(card, group, row.student_number);
  } catch (error) {
    issue = error instanceof Error ? error.message : "原卷校验失败";
  }
  const user = await db.get<{ id: number }>(
    "SELECT id FROM users WHERE student_number=? AND role_id=3 AND is_active=1",
    row.student_number,
  );
  const score = user
    ? await db.get<Record<string, unknown>>(
        "SELECT * FROM student_scores WHERE exam_id=? AND student_id=?",
        row.exam_id,
        user.id,
      )
    : null;
  const questions = user
    ? await db.all(
        "SELECT * FROM question_scores WHERE exam_id=? AND student_id=? ORDER BY question_number,score_type",
        row.exam_id,
        user.id,
      )
    : [];
  const related = await db.all(
    "SELECT * FROM scanner_submissions WHERE exam_id=? AND student_number=? ORDER BY session_id,group_id",
    row.exam_id,
    row.student_number,
  );
  const token = createHash("sha256")
    .update(
      JSON.stringify({
        row,
        raw,
        score,
        questions,
        related,
        version: cardFingerprint(card),
        session,
      }),
    )
    .digest("hex");
  return { exam, card, result, issue, user, score, token };
}
export async function listPendingScans(examId: number) {
  const db = getMysqlDb();
  const rows = await db.all<PendingRow>(
    "SELECT * FROM scanner_submissions WHERE exam_id=? AND state IN ('held','roster') ORDER BY session_id,group_id",
    examId,
  );
  return Promise.all(
    rows.map(async (row) => {
      const e = await evidence(db, row);
      return {
        sessionId: row.session_id,
        groupId: row.group_id,
        studentNumber: row.student_number,
        reason: row.state === "roster" ? "roster" : "duplicate",
        existingScore: e.score?.total_score ?? null,
        proposedScore: e.result?.totalScore ?? null,
        token: e.token,
        issue: e.issue,
        pages: JSON.parse(row.pages_json),
      };
    }),
  );
}
export async function confirmPendingScan(
  examId: number,
  sessionId: string,
  groupId: string,
  action: "accept" | "discard",
  token: string,
  userId: number,
  accessibleClassIds: number[] | null,
) {
  return enqueueScannerSubmission(async () => {
    const db = getMysqlDb();
    await db.transaction(async (tx) => {
      await tx.run("UPDATE exams SET id=id WHERE id=?", examId);
      const row = await tx.get<PendingRow>(
        "SELECT * FROM scanner_submissions WHERE exam_id=? AND session_id=? AND group_id=? AND state IN ('held','roster')",
        examId,
        sessionId,
        groupId,
      );
      if (!row) throw new Error("此卷已处理，请刷新");
      const e = await evidence(tx, row);
      if (token !== e.token)
        throw new Error("原卷或正式成绩已更新，请刷新后重新核对");
      if (action === "discard") {
        await tx.run(
          "UPDATE scanner_submissions SET state='discarded' WHERE exam_id=? AND session_id=? AND group_id=?",
          examId,
          sessionId,
          groupId,
        );
      } else {
        if (e.issue || !e.result) throw new Error(e.issue ?? "原卷无有效成绩");
        if (!e.user)
          throw new Error("该学号没有有效学生账号，请先订正学号或建立学生档案");
        await ensureExamParticipants(tx, examId);
        if (!(await isExamParticipant(tx, examId, e.user.id))) {
          if (
            (
              await findStudentsOutsideParticipantScope(
                tx,
                examId,
                e.exam,
                [e.user.id],
                accessibleClassIds,
              )
            ).length
          )
            throw new Error("该学生超出考试或你的班级权限范围，不能加入名单");
          await tx.run(
            buildInsertIgnore(tx.dialect, "exam_participants", [
              "exam_id",
              "student_id",
              "source",
            ]),
            examId,
            e.user.id,
            "explicit",
          );
        }
        await persistScannerResultToMainDb(e.card.id, e.result, true, {
          db: tx,
          examId,
        });
        // The teacher explicitly selects this attempt; archive other attempts without deleting their evidence.
        await tx.run(
          "UPDATE scanner_submissions SET state='discarded' WHERE exam_id=? AND student_number=? AND NOT (session_id=? AND group_id=?) AND state<>'discarded'",
          examId,
          row.student_number,
          sessionId,
          groupId,
        );
        await tx.run(
          "UPDATE answer_block_crops SET exam_id=NULL,student_id=NULL WHERE exam_id=? AND student_id=?",
          examId,
          e.user.id,
        );
        await tx.run(
          "UPDATE scanner_submissions SET state='saved',previously_saved=1,result_json=? WHERE exam_id=? AND session_id=? AND group_id=?",
          JSON.stringify(e.result),
          examId,
          sessionId,
          groupId,
        );
        await linkSavedScannerCrops(tx, e.card.id, { ...row, state: "saved" });
        const recalc = await recomputeExamRankings(tx, examId);
        if (!recalc.assignedScoresRecalculated)
          throw new Error(
            `赋分重算失败，确认未保存：${recalc.assignedScoreError}`,
          );
      }
      await tx.run(
        "INSERT INTO answer_overrides (exam_id,card_id,question_number,score_type,override_type,old_value,new_value,created_by,created_at) VALUES (?,?,'*','objective','score',?,?,?,CURRENT_TIMESTAMP)",
        examId,
        e.card.id,
        JSON.stringify({ totalScore: e.score?.total_score ?? null }),
        JSON.stringify({
          action,
          sessionId,
          groupId,
          studentNumber: row.student_number,
          totalScore: e.result?.totalScore,
        }),
        userId,
      );
    });
    analysisCache.invalidateExam(examId);
  });
}
