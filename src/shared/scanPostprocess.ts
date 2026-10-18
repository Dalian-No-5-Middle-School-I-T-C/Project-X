import {
  uniqueScanConflictCards,
  type ScanBatchResponse,
  type ScanBatchResult,
  type ScanConflictCard,
} from "./scanPages";

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

/** 这批结果里实际出现过的最大布局页。版本对不上时用它当页数，避免按后来的新卡发明缺页。 */
export function observedLayoutPageCount(response: ScanBatchResponse | undefined): number {
  if (!response) return 0;
  let max = 0;
  const consider = (pages: ReadonlyArray<{ layoutPage: number }> | undefined) => {
    for (const page of pages ?? []) if (page.layoutPage > max) max = page.layoutPage;
  };
  for (const result of response.results) consider(result.pages);
  for (const failure of response.failures) {
    consider(failure.pages);
    for (const copy of failure.conflicts ?? []) consider(copy.pages);
  }
  for (const card of response.reviewCards ?? []) consider(card.pages);
  return max;
}

/**
 * 缺页对照用哪一版卡的页数。
 * 会话指纹对上本机卡或远端卡时用那一版（本机优先）；对不上就按本批实际扫到的最大页，并标 layoutStale。
 * 没有指纹的旧会话仍用当前卡页数，真缺页继续提示。
 */
export function matchingLayoutPageCount(input: {
  cardVersion: string | null;
  localFingerprint: string | null;
  localPageCount: number;
  remoteFingerprint: string | null;
  remotePageCount: number;
  observedMaxLayoutPage: number;
}): { pageCount: number; layoutStale: boolean } {
  const { cardVersion, localFingerprint, localPageCount, remoteFingerprint, remotePageCount, observedMaxLayoutPage } = input;
  if (cardVersion && localFingerprint === cardVersion && localPageCount > 0) {
    return { pageCount: localPageCount, layoutStale: false };
  }
  if (cardVersion && remoteFingerprint === cardVersion && remotePageCount > 0) {
    return { pageCount: remotePageCount, layoutStale: false };
  }
  if (cardVersion) return { pageCount: observedMaxLayoutPage, layoutStale: true };
  const fallback = localPageCount > 0 ? localPageCount : remotePageCount;
  return { pageCount: fallback, layoutStale: false };
}

export interface PreviewDiscardRef {
  sessionId: string;
  groupId: string;
}

/** 远端预览没有回执，不能走作废接口。把本机记下的「不保留」从后续预览里拿掉，并放出仍在本会话里的保留份。 */
export function omitPreviewDiscardedGroups(
  response: ScanBatchResponse,
  discarded: readonly PreviewDiscardRef[],
  sessionId: string,
): ScanBatchResponse {
  const dropped = (sid: string, gid: string) => discarded.some(item => item.sessionId === sid && item.groupId === gid);
  const results = response.results.filter(result => !dropped(sessionId, result.groupId));
  const reviewCards = (response.reviewCards ?? []).filter(card => !dropped(card.sessionId, card.groupId));
  const failures: ScanBatchResponse["failures"] = [];
  const promoted = new Map<string, ScanBatchResult>();
  const remember = (result: ScanBatchResult) => {
    if (!result.studentId || dropped(sessionId, result.groupId)) return;
    if (results.some(existing => existing.groupId === result.groupId) || promoted.has(result.groupId)) return;
    promoted.set(result.groupId, result);
  };
  for (const failure of response.failures) {
    const conflicts = (failure.conflicts ?? []).filter(card => !dropped(card.sessionId, card.groupId));
    const ownDropped = dropped(sessionId, failure.groupId);
    const hadConflicts = (failure.conflicts?.length ?? 0) > 0;
    if (hadConflicts && conflicts.length < 2) {
      if (ownDropped) {
        for (const copy of conflicts) if (copy.sessionId === sessionId) remember(synthesizeKeptResult(copy));
      } else if (failure.studentId) {
        remember(synthesizeKeptResult({
          sessionId, groupId: failure.groupId, studentId: failure.studentId,
          previouslySaved: false, pages: failure.pages,
        }));
      }
      continue;
    }
    if (ownDropped) continue;
    failures.push({ ...failure, conflicts });
  }
  return { ...response, results: [...results, ...promoted.values()], failures, reviewCards };
}

function synthesizeKeptResult(card: ScanConflictCard): ScanBatchResult {
  const pages = card.pages.map(page => ({
    ...page,
    objectiveScore: 0,
    subjectiveScore: 0,
    totalScore: 0,
    totalMaxScore: 0,
  }));
  // 预览重卡在判分前就被收成冲突，这里只能用服务端已经算好的复核和分数。
  // 没带 needsReviewCount 时不能写成 0，否则未确认的低置信度卷会离开异常队列并自动上传。
  const needsReviewCount = typeof card.needsReviewCount === "number" ? card.needsReviewCount : 1;
  return {
    groupId: card.groupId,
    studentId: card.studentId,
    totalScore: card.totalScore ?? 0,
    maxScore: card.maxScore ?? 0,
    objectiveScore: card.objectiveScore ?? 0,
    objectiveMaxScore: 0,
    subjectiveScore: card.subjectiveScore ?? 0,
    subjectiveMaxScore: 0,
    needsReviewCount,
    pageCount: pages.length,
    saved: false,
    pages,
  };
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
 * 把「某题的新格选」写回各页选中集：只替换该题作用域内的格，
 * 其余格（学号、别的题）一律保留。整页覆盖会把同页其他填涂一起抹掉。
 * picked 里的格可能分布在多页，按 cellOwner 归位到各自页面。
 */
export function replaceScopedSelection<T extends { sourceId: string; selected: string[] }>(
  pages: ReadonlyArray<T>,
  cellOwner: ReadonlyMap<string, string>,
  scope: ReadonlySet<string>,
  picked: ReadonlyArray<string>,
): T[] {
  return pages.map(page => {
    const kept = page.selected.filter(id => !scope.has(id));
    const added = picked.filter(id => cellOwner.get(id) === page.sourceId && !kept.includes(id));
    return { ...page, selected: [...kept, ...added] };
  });
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
