// v2.5.1: 扫描会话终态取页——服务端权威记录与本地 SSE 已知页的合并策略。
// 背景：SSE 订阅晚到/中途断线重连后，服务端只补发终态 done、不回放 page_done
// （server/scanner/index.ts 的 progress 端点无事件回放），本地 ref 可能缺页甚至为空。
// 终态上传前必须以 GET /api/scanner/scan/:sessionId 的 records 为权威来源重建页列表；
// 服务端不可用时才回退本地已知页。

export interface ScanPageRef {
  recordId: string;
  pageNum: number;
  side: "front" | "back";
}

export interface ScanRecordLike {
  id: string;
  pageNum: number;
  side: string;
}

function normalizeSide(s: string): "front" | "back" {
  return s === "back" ? "back" : "front";
}

/** 服务端记录优先；按 recordId 去重；按 pageNum 升序；服务端为空时回退本地已知 */
export function mergeAuthoritativePages(
  serverRecords: ScanRecordLike[],
  knownPages: Array<{ recordId: string; pageNum: number; side: string }>,
): ScanPageRef[] {
  const dedupeSorted = <T extends { pageNum: number }>(
    items: T[],
    keyOf: (item: T) => string,
    toPage: (item: T) => ScanPageRef,
  ): ScanPageRef[] => {
    const seen = new Set<string>();
    return items
      .slice()
      .sort((a, b) => a.pageNum - b.pageNum)
      .filter((item) => {
        const key = keyOf(item);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(toPage);
  };

  if (serverRecords.length > 0) {
    return dedupeSorted(
      serverRecords,
      (r) => r.id,
      (r) => ({ recordId: r.id, pageNum: r.pageNum, side: normalizeSide(r.side) }),
    );
  }
  return dedupeSorted(
    knownPages,
    (p) => p.recordId,
    (p) => ({ recordId: p.recordId, pageNum: p.pageNum, side: normalizeSide(p.side) }),
  );
}
