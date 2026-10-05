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

/**
 * 安全 R34：兼容模式（无二维码）下的学生归属判定。
 *
 * 严格模式有二维码逐页校验 cardId + pageNumber，页序错位会被 identity 校验挡下；
 * 兼容模式没有这层信息，分组完全依赖物理页序，一旦缺页/乱序/ADF 双进纸让页序错位，
 * 「按页序分组 + 继承同组学号」就会把后一名学生的答卷静默挂到前一名学生名下。
 *
 * 可用的硬事实是：学号填涂区只在布局第 1 页生成（layout.ts 仅对 page 1 调用
 * layoutStudentArea），所以兼容模式下一份答题卡的学号**只可能**来自本组第 1 页。
 * 据此失败闭合，交人工归组，绝不猜测。返回空数组表示可以放行。
 */
export function legacyIdentityProblems(
  rows: ReadonlyArray<{ layoutPage: number; studentId: string | null; identityMode?: "strict" | "legacy" | null }>,
): string[] {
  if (!rows.some((row) => row.identityMode === "legacy")) return [];
  const problems: string[] = [];
  const first = rows.find((row) => row.layoutPage === 1);
  if (!first) {
    problems.push(
      "兼容模式（无二维码）下本份答题卡没有第 1 页：物理页序已不可信，" +
        "请核对是否缺页、乱序或 ADF 双进纸后重新扫描，或改用人工归组",
    );
    return problems;
  }
  const stray = rows.find((row) => row.layoutPage !== 1 && row.studentId && row.studentId !== first.studentId);
  if (!first.studentId) {
    problems.push(
      stray
        ? `兼容模式（无二维码）下第 1 页没有学号，却在第 ${stray.layoutPage} 页读到学号 ${stray.studentId}：` +
          "学号填涂区只印在第 1 页，这说明页序已经错位（缺页/乱序/ADF 双进纸）。" +
          "不能把它当作本份答题卡的归属，也不会沿用前一名学生的学号，请人工归组后重试"
        : "兼容模式（无二维码）下第 1 页未识别到学号：不能从其它页或前一份答题卡推断归属，" +
          "请核对该份答题卡后人工指定学号再重试",
    );
    return problems;
  }
  if (stray) {
    problems.push(
      `兼容模式（无二维码）下第 ${stray.layoutPage} 页读到学号 ${stray.studentId}，` +
        `与第 1 页的 ${first.studentId} 不一致：疑似缺页/乱序/ADF 双进纸导致页序错位，请人工归组后重试`,
    );
  }
  return problems;
}

type IdentityRow = { layoutPage: number; studentId: string | null; identityMode?: "strict" | "legacy" | null };

function identityRows(rows: ReadonlyArray<{ record: ScanRecordWithResult; page: ScanBatchPage }>): IdentityRow[] {
  return rows.map(({ record, page }) => ({
    layoutPage: page.layoutPage,
    studentId: record.student_id,
    identityMode: record.identity_mode,
  }));
}

/**
 * 安全 R34（会话级）：兼容模式下单份卡的失败不足以说明整批可信。
 *
 * 页序错位（缺页 / 乱序 / ADF 双进纸）会让**某一份**卡的第 1 页落到别组里去，
 * 于是那一份会因缺学号而失败闭合，但被顶替进来的另一份却可能页数齐整、学号也读得到，
 * 看起来毫无异常——逐份独立判定放不出这个信号。因此兼容模式下再做两条会话级检查：
 *   1. 纸张总数必须是「每份卡用纸数」的整数倍（缺一张纸或多进一张纸都会破坏整除）；
 *   2. 只要有任何一份卡的第 1 页学号不可信，整批就不入库，改为要求人工归组。
 * 严格模式有二维码逐页校验，不受这两条限制。返回 null 表示放行。
 */
export function legacySessionBlockReason(opts: {
  pageCount: number;
  sided: "single" | "double";
  records: ReadonlyArray<Pick<ScanRecordWithResult, "page_num" | "identity_mode">>;
  groups: ReadonlyMap<string, Array<{ record: ScanRecordWithResult; page: ScanBatchPage }>>;
}): string | null {
  const { pageCount, sided, records, groups } = opts;
  const legacy = records.some((record) => record.identity_mode === "legacy");
  if (!legacy || records.length === 0) return null;

  const sidesPerSheet = sided === "double" ? 2 : 1;
  const sheetsPerStudent = Math.max(1, Math.ceil(pageCount / sidesPerSheet));
  const sheets = new Set(records.map((record) => Number(record.page_num))).size;
  if (sheets % sheetsPerStudent !== 0) {
    return (
      `兼容模式（无二维码）下本次共 ${sheets} 张纸，不是每份答题卡 ${sheetsPerStudent} 张的整数倍：` +
      "存在缺页或多进纸（ADF 双进纸），物理页序已不可信，请核对后重新扫描"
    );
  }

  const untrusted: string[] = [];
  for (const [groupId, rows] of groups) {
    if (legacyIdentityProblems(identityRows(rows)).length > 0) untrusted.push(groupId);
  }
  if (untrusted.length > 0) {
    return (
      `兼容模式（无二维码）下第 ${untrusted.join("、")} 份答题卡的第 1 页学号不可信。` +
      "没有二维码就无法排除整批页序错位，因此本批成绩暂不入库；" +
      "请为这些卡人工指定学号（或重新扫描）后再汇总"
    );
  }
  return null;
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
  // 安全 R34：兼容模式的页序可信度是**整批**属性，先算一次，再让每份卡各自失败闭合。
  const legacyBlock = legacySessionBlockReason({ pageCount, sided: card.sided, records, groups });
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
      for (const { record, page } of rows) {
        if (record.ocr_status === "failed") throw new Error(record.ocr_error || "页面识别失败");
        const identity = record.identity_json ? JSON.parse(record.identity_json) : null;
        const verified = identity?.status === "verified" && identity.cardId === card.id && identity.pageNumber === page.layoutPage;
        const legacy = record.identity_mode === "legacy" && identity?.status === "unverified" && ["QR_MISSING", "QR_UNREADABLE"].includes(identity.code);
        if (!verified && !legacy) throw new Error(`第 ${page.layoutPage} 页未通过二维码身份校验，请在 Windows 扫描端重新识别`);
      }
      if (legacyBlock) throw new Error(legacyBlock);
      const identityProblems = legacyIdentityProblems(identityRows(rows));
      if (identityProblems.length > 0) throw new Error(identityProblems[0]);
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
