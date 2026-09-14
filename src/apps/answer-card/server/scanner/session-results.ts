import { buildLayout } from "../../../../shared/layout";
import { gradeSessionStudentResults, type CombinedStudentResult } from "../../../../shared/grading";
import { mapScanPageToLayout, type ScanBatchResponse, type ScanBatchPage } from "../../../../shared/scanPages";
import type { AnswerCard, CombinedRecognitionResult } from "../../../../shared/types";
import type { ScanRecordWithResult, StudentGradingResultRow } from "../database/scan-store";

export function groupSessionPages(card: AnswerCard, records: ScanRecordWithResult[]) {
  const pageCount = buildLayout(card).pages.length;
  const groups = new Map<string, Array<{ record: ScanRecordWithResult; page: ScanBatchPage }>>();
  for (const record of [...records].sort((a, b) => a.page_num - b.page_num || (a.side === b.side ? 0 : a.side === "front" ? -1 : 1))) {
    const mapping = mapScanPageToLayout(record.page_num, record.side, pageCount, card.sided);
    if (mapping.unusedSide) continue;
    const key = String(mapping.groupIndex);
    const group = groups.get(key) ?? [];
    group.push({ record, page: { recordId: record.id, pageNum: record.page_num, side: record.side, layoutPage: mapping.layoutPage } });
    groups.set(key, group);
  }
  return { pageCount, groups };
}

/** Recompute from authoritative records. A partial cache must never hide failed cards. */
export async function collectSessionResults(
  card: AnswerCard,
  records: ScanRecordWithResult[],
  cached: StudentGradingResultRow[],
  save?: (result: CombinedStudentResult) => Promise<void>,
): Promise<ScanBatchResponse> {
  const { pageCount, groups } = groupSessionPages(card, records);
  const response: ScanBatchResponse = { results: [], failures: [] };
  const studentGroups = new Map<string, Set<string>>();
  for (const [groupId, rows] of groups) {
    for (const { record } of rows) {
      if (!record.student_id) continue;
      const ids = studentGroups.get(record.student_id) ?? new Set();
      ids.add(groupId);
      studentGroups.set(record.student_id, ids);
    }
  }
  for (const [groupId, rows] of groups) {
    const pages = rows.map(r => r.page);
    const studentIds = [...new Set(rows.map(r => r.record.student_id).filter((id): id is string => Boolean(id)))];
    const studentId = studentIds.length === 1 ? studentIds[0] : null;
    let stage: "recognition" | "grading" | "saving" = "recognition";
    try {
      if (studentIds.length > 1) throw new Error("同一份答题卡的学号不一致，请核对正反面后订正");
      if (!studentId) throw new Error("未识别到学号，请核对图片并填写正确学号后重试");
      if ((studentGroups.get(studentId)?.size ?? 0) > 1) throw new Error("同一学号出现多份答题卡，请核对后重新扫描");
      const layoutPages = new Set(pages.map(p => p.layoutPage));
      if (layoutPages.size !== pageCount || pages.length !== pageCount) throw new Error(`答题卡缺页或重复页：应有 ${pageCount} 面，实有 ${pages.length} 面，请补齐后重新扫描`);
      for (const { record, page } of rows) {
        if (!record.recognition || record.ocr_status === "failed" || record.ocr_status === "pending" || record.ocr_status === "processing") {
          throw new Error(`第 ${page.pageNum} 张${page.side === "front" ? "正面" : "背面"}识别失败：${record.ocr_error || "尚无有效识别结果"}`);
        }
      }
      stage = "grading";
      const combined = gradeSessionStudentResults(card, rows.map(({ record }) => ({
        recordId: record.id, pageNum: record.page_num, side: record.side, imagePath: record.image_path,
        ocrStatus: record.ocr_status,
        recognition: {
          status: "ok", studentId: { status: "ok", value: studentId },
          questions: JSON.parse(record.recognition!.objective_json ?? "[]"),
          subjectiveQuestions: JSON.parse(record.recognition!.subjective_json ?? "[]"),
        } as CombinedRecognitionResult,
      })));
      const prior = cached.find(r => r.student_id === studentId);
      let saved = Boolean(prior && prior.objective_json === JSON.stringify(combined.objectiveQuestions)
        && prior.subjective_json === JSON.stringify(combined.subjectiveQuestions)
        && prior.total_score === combined.totalScore && prior.max_score === combined.totalMaxScore
        && prior.page_count === combined.pageCount);
      if (save && !saved) {
        stage = "saving";
        await save(combined);
        saved = true;
      }
      response.results.push({
        groupId, studentId, pages: pages.map((page, index) => ({ ...combined.pages[index], ...page })),
        saved, totalScore: combined.totalScore, maxScore: combined.totalMaxScore,
        objectiveScore: combined.objectiveScore, objectiveMaxScore: combined.objectiveMaxScore,
        subjectiveScore: combined.subjectiveScore, subjectiveMaxScore: combined.subjectiveMaxScore,
        needsReviewCount: combined.needsReviewCount, pageCount: combined.pageCount,
      });
    } catch (err) {
      // Each complete answer card is an independent unit: retain the failure and continue the batch.
      response.failures.push({ groupId, studentId, pages, stage, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return response;
}
