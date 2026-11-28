export type PdfTicketFreshness = {
  revision?: number;
  issuedAt: number;
  ttlMs: number;
};

/** 导出门票绑定 revision；临期（30 秒余量）或版本变化时必须重新保存、校验并签票。 */
export function isPdfTicketStale(ticket: PdfTicketFreshness, currentRevision: number | undefined, now = Date.now()): boolean {
  if (ticket.revision !== undefined && currentRevision !== undefined && ticket.revision !== currentRevision) return true;
  return !Number.isFinite(ticket.issuedAt) || ticket.ttlMs <= 0 || now - ticket.issuedAt >= Math.max(0, ticket.ttlMs - 30_000);
}
