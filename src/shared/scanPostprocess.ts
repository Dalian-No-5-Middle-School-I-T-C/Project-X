import { uniqueScanConflictCards, type ScanBatchResponse, type ScanConflictCard } from "./scanPages";

/** 队列四类（用户锁定）+ other 兜底（不丢异常，非业务新类型）。 */
export type PostprocessIssueKind = "duplicate" | "student_id" | "missing_page" | "low_confidence" | "other";

export const POSTPROCESS_ISSUE_ORDER: readonly PostprocessIssueKind[] = [
  "duplicate",
  "student_id",
  "missing_page",
  "low_confidence",
  "other",
];

export interface PostprocessGroup {
  sessionId: string;
  groupId: string;
  studentId: string | null;
  saved: boolean;
  totalScore: number;
  maxScore: number;
  objectiveScore: number;
  subjectiveScore: number;
  pageCount: number;
  missingLayoutPages: number[];
  needsReviewCount: number;
  conflicts: ScanConflictCard[];
  thumbRecordId: string | null;
  failureMessage?: string;
  issues: PostprocessIssueKind[];
}

export interface PostprocessQueueItem {
  id: string;
  kind: PostprocessIssueKind;
  sessionId: string;
  groupId: string;
  studentId: string | null;
  label: string;
  conflicts: ScanConflictCard[];
  missingLayoutPages: number[];
  needsReviewCount: number;
  failureMessage?: string;
}

/** 该组实际页相对卡面布局缺哪些 layoutPage（1 起）。 */
export function missingLayoutPages(pages: ReadonlyArray<{ layoutPage: number }>, layoutPageCount: number): number[] {
  const have = new Set(pages.map(p => p.layoutPage));
  const missing: number[] = [];
  for (let page = 1; page <= layoutPageCount; page++) if (!have.has(page)) missing.push(page);
  return missing;
}

/**
 * 把 ScanBatchResponse 摊平成「组」视图模型。分类只用结构化信号：
 * conflicts 非空 → duplicate；studentId 为 null → student_id；缺 layoutPage → missing_page；
 * needsReviewCount>0 → low_confidence；仅有 failure 且以上皆无 → other。不解析 message 文案。
 */
export function buildPostprocessGroups(response: ScanBatchResponse, sessionId: string, layoutPageCount: number): PostprocessGroup[] {
  const byKey = new Map<string, PostprocessGroup>();
  const ensure = (groupId: string): PostprocessGroup => {
    const existing = byKey.get(groupId);
    if (existing) return existing;
    const group: PostprocessGroup = {
      sessionId, groupId, studentId: null, saved: false, totalScore: 0, maxScore: 0,
      objectiveScore: 0, subjectiveScore: 0, pageCount: 0, missingLayoutPages: [],
      needsReviewCount: 0, conflicts: [], thumbRecordId: null, issues: [],
    };
    byKey.set(groupId, group);
    return group;
  };

  for (const result of response.results) {
    const group = ensure(result.groupId);
    group.studentId = result.studentId;
    group.saved = result.saved;
    group.totalScore = result.totalScore;
    group.maxScore = result.maxScore;
    group.objectiveScore = result.objectiveScore;
    group.subjectiveScore = result.subjectiveScore;
    group.pageCount = result.pageCount;
    group.needsReviewCount = result.needsReviewCount;
    group.missingLayoutPages = missingLayoutPages(result.pages, layoutPageCount);
    group.thumbRecordId = result.pages[0]?.recordId ?? null;
  }

  for (const failure of response.failures) {
    const group = ensure(failure.groupId);
    group.studentId = group.studentId ?? failure.studentId;
    group.pageCount = group.pageCount || failure.pages.length;
    group.thumbRecordId = group.thumbRecordId ?? failure.pages[0]?.recordId ?? null;
    group.missingLayoutPages = missingLayoutPages(failure.pages, layoutPageCount);
    group.failureMessage = failure.message;
    if (failure.conflicts?.length) group.conflicts = uniqueScanConflictCards([...group.conflicts, ...failure.conflicts]);
  }

  for (const card of response.reviewCards ?? []) {
    if (card.sessionId !== sessionId) continue; // 历史遗留卷不收编（范围边界）
    const group = ensure(card.groupId);
    group.studentId = group.studentId ?? card.studentId;
    group.pageCount = group.pageCount || card.pages.length;
    group.thumbRecordId = group.thumbRecordId ?? card.pages[0]?.recordId ?? null;
    group.totalScore = group.totalScore || card.totalScore || 0;
    group.conflicts = uniqueScanConflictCards([...group.conflicts, card]);
  }

  for (const group of byKey.values()) {
    const issues: PostprocessIssueKind[] = [];
    if (group.conflicts.length > 0) issues.push("duplicate");
    if (group.studentId === null) issues.push("student_id");
    if (group.missingLayoutPages.length > 0) issues.push("missing_page");
    if (group.needsReviewCount > 0) issues.push("low_confidence");
    if (!issues.length && group.failureMessage) issues.push("other");
    group.issues = issues;
  }

  return [...byKey.values()].sort((a, b) => Number(a.groupId) - Number(b.groupId));
}

/** 一组多异常 = 多条队列项；顺序 duplicate → student_id → missing_page → low_confidence → other，组内按 groupId 数值序。 */
export function buildPostprocessQueue(groups: ReadonlyArray<PostprocessGroup>): PostprocessQueueItem[] {
  const items: PostprocessQueueItem[] = [];
  for (const group of groups) {
    for (const kind of POSTPROCESS_ISSUE_ORDER) {
      if (!group.issues.includes(kind)) continue;
      items.push({
        id: `${kind}|${group.sessionId}|${group.groupId}`,
        kind,
        sessionId: group.sessionId,
        groupId: group.groupId,
        studentId: group.studentId,
        label: queueLabel(kind, group),
        conflicts: group.conflicts,
        missingLayoutPages: group.missingLayoutPages,
        needsReviewCount: group.needsReviewCount,
        failureMessage: group.failureMessage,
      });
    }
  }
  const rank = new Map(POSTPROCESS_ISSUE_ORDER.map((kind, index) => [kind, index]));
  return items.sort((a, b) => rank.get(a.kind)! - rank.get(b.kind)! || Number(a.groupId) - Number(b.groupId));
}

function queueLabel(kind: PostprocessIssueKind, group: PostprocessGroup): string {
  switch (kind) {
    case "duplicate": return `考号重复${group.studentId ? `（${group.studentId}）` : ""}`;
    case "student_id": return "考号未识别";
    case "missing_page": return `缺第 ${group.missingLayoutPages.join("、")} 页`;
    case "low_confidence": return `${group.needsReviewCount} 题存疑`;
    case "other": return group.failureMessage || "处理失败";
  }
}

/**
 * 删除护栏纯逻辑：组内存在非 discarded 回执（已上传/待确认/冲突保留）时，
 * 未 force 一律 blocked；force 时放行（客户端已二次确认代价）。
 */
export function filterDeletableGroups(
  groupIds: ReadonlyArray<string>,
  hasActiveReceipt: ReadonlyMap<string, boolean>,
  force: boolean,
): { deletable: string[]; blocked: string[] } {
  const deletable: string[] = [];
  const blocked: string[] = [];
  for (const groupId of groupIds) {
    if (!force && hasActiveReceipt.get(groupId)) blocked.push(groupId);
    else deletable.push(groupId);
  }
  return { deletable, blocked };
}
