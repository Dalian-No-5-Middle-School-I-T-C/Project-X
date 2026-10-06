import type { Request, Response, NextFunction } from "express";
import {
  requireExamAccess,
  getPermittedBlocks,
  getVisibleExamIds,
  isExamSoftDeleted,
} from "../../apps/answer-card/server/middleware";
import { getMysqlDb } from "../db";
import { CardRepository } from "../repositories/CardRepository";
import { resolveScannerExam } from "../services/scannerExam";
import { isAuthEnforced } from "../lib/authEnforce";
import { buildLayout } from "../../shared/layout";
import { mapScanPageToLayout } from "../../shared/scanPages";
import type { AnswerCard } from "../../shared/types";

/** 把「扫描记录 ID」映射到它所属的会话 ID（R04：记录级路由只有 recordId）。 */
export async function sessionIdOfScanRecord(recordId: string): Promise<string | null> {
  const row = await getMysqlDb().get<{ session_id: string | null }>(
    "SELECT session_id FROM twain_scan_records WHERE id = ?", recordId);
  return row?.session_id ?? null;
}

/**
 * 题块级阅卷人在扫描接口上的可读范围（PR #312 复核 CR5）。
 *
 * restricted=false 表示整卷可读（管理员，或该考试没有题块权限矩阵）。
 * restricted=true 时只允许访问 pages 里的排版页，且识别结果里只保留 blocks 里的题块——
 * 此前题块限制只加在 DELETE 上，GET 照样返回其它题块的识别结果、整卷分数和原卷图片，
 * 「按题块分配」就退化成了「按题块分配写入、全卷开放读取」。
 */
export interface ScanPageScope {
  restricted: boolean;
  pages: Set<number>;
  blocks: Set<string>;
}

const SCOPE_LOCAL = "scanPageScope";

export function attachScanPageScope(res: Response, scope: ScanPageScope): void {
  (res.locals as Record<string, unknown>)[SCOPE_LOCAL] = scope;
}

/** 排版页总数：题块权限只能落在排版页上，而物理扫描页要按卡的张面方式换算过去。 */
export function layoutPageCount(card: AnswerCard | null): number {
  return card ? buildLayout(card).pages.length : 0;
}

/** 扫描记录（物理页码 + 正反面）→ 答题卡排版页；与上传/判分用的是同一个 mapScanPageToLayout。 */
export function scanRecordLayoutPage(card: AnswerCard | null, pageNum: number, side: "front" | "back"): number {
  return mapScanPageToLayout(Number(pageNum) || 0, side, layoutPageCount(card), card?.sided ?? "single").layoutPage;
}

/** 路由侧读取当前请求的题块范围；未挂中间件时返回 null（视为不限制）。 */
export function scanPageScopeOf(res: Response): ScanPageScope | null {
  const scope = (res.locals as Record<string, unknown>)[SCOPE_LOCAL];
  return scope ? scope as ScanPageScope : null;
}

/** 某一物理扫描页（页码 + 正反面）是否落在可读范围内。 */
export function scanPageAllowed(scope: ScanPageScope | null, layoutPage: number): boolean {
  if (!scope || !scope.restricted) return true;
  return scope.pages.has(layoutPage);
}

/**
 * 识别结果 JSON 的题块过滤：objective_json / subjective_json 都是按 blockId 归组的数组。
 * 无法解析或不是数组时**整段丢弃**——宁可少给，也不让畸形结构绕过题块范围。
 */
export function filterRecognitionJson(raw: string | null | undefined, scope: ScanPageScope | null): string | null {
  if (!raw) return null;
  if (!scope || !scope.restricted) return raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const kept = parsed.filter(item => item && typeof item === "object"
      && scope.blocks.has(String((item as Record<string, unknown>).blockId ?? "")));
    return JSON.stringify(kept);
  } catch {
    return null;
  }
}

/** 排版页 → 该页上的题块集合；题块权限要落到「哪些扫描页可读」上才能拦住图片类端点。 */
async function pagesOfBlocks(cardId: string, blocks: Set<string>): Promise<Set<number>> {
  const card = await new CardRepository().findById(cardId);
  const pages = new Set<number>();
  if (!card) return pages;
  for (const page of buildLayout(card).pages) {
    if (page.blocks.some(b => blocks.has(b.blockId))) pages.add(page.pageNumber);
  }
  return pages;
}

/**
 * 计算某张答题卡对当前用户的题块范围。只要有一场候选考试不受题块矩阵限制，整卷就可读；
 * 全部受限才收紧，并把受限题块的并集作为可读页来源。
 */
export async function resolveScanPageScope(user: NonNullable<Request["user"]>, cardId: string,
  candidateIds: number[]): Promise<ScanPageScope> {
  if (user.role_name === "admin") return { restricted: false, pages: new Set(), blocks: new Set() };
  const blocks = new Set<string>();
  for (const examId of candidateIds) {
    const permitted = await getPermittedBlocks(user, examId);
    if (permitted === null) return { restricted: false, pages: new Set(), blocks: new Set() };
    for (const blockId of permitted) blocks.add(blockId);
  }
  return { restricted: true, pages: await pagesOfBlocks(cardId, blocks), blocks };
}

/** 答题卡被软删除考试独占（或全部被归档）时的统一口径：非管理员按「不存在」处理（CR4）。 */
function refuseSoftDeletedOnly(res: Response, user: NonNullable<Request["user"]>, resolved: { exams: unknown[]; allExamIds: number[] }): boolean {
  if (resolved.exams.length > 0 || resolved.allExamIds.length === 0) return false;
  if (user.role_name === "admin") return false;
  res.status(404).json({ message: "考试不存在或已按数据保留策略清理" });
  return true;
}

/**
 * 安全（R04）：记录/会话级路由（读取原卷图片、查看扫描结果、删除扫描记录）的访问校验。
 *
 * 与 requireScannerExamScope 的差别在于：这些请求里没有 examId，而且一张答题卡可能被多场
 * 考试复用，会话归属并不唯一。归属唯一时直接复用 requireExamAccess（含软删除与学生规则）；
 * 归属不唯一时要求**全部候选考试都可见**——只要有一个不可见就不能放行，否则越权考试的原卷
 * 图片会借着「另一场考试可见」的名义被读走。删除类请求还要求整份答题卡的阅卷权限。
 */
export function requireScannerRecordScope(params: { recordIdParam?: string } = {}) {
  return async function scannerRecordScope(req: Request, res: Response, next: NextFunction): Promise<void> {
    if ((req as Request & { isApiClient?: boolean }).isApiClient) { next(); return; }
    if (!req.user) {
      if (isAuthEnforced()) { res.status(401).json({ message: "未提供认证令牌" }); return; }
      next(); return;
    }
    try {
      const recordId = params.recordIdParam ? req.params[params.recordIdParam] : undefined;
      const sessionId = recordId
        ? await sessionIdOfScanRecord(String(recordId))
        : String(req.params.sessionId ?? "");
      if (!sessionId) { res.status(404).json({ message: "扫描记录不存在" }); return; }
      const session = await getMysqlDb().get<{ card_id: string }>(
        "SELECT card_id FROM twain_scan_sessions WHERE id = ?", sessionId);
      if (!session) { res.status(404).json({ message: "扫描会话不存在" }); return; }

      const resolved = await resolveScannerExam(session.card_id, sessionId);
      // 答题卡尚未绑定任何考试（本机扫描、未提交）：与既有会话级行为一致，放行读取。
      // 但「绑过的考试全被软删除」不能算这一类——否则删除考试反而放宽了范围校验（CR4）。
      if (refuseSoftDeletedOnly(res, req.user, resolved)) return;
      if (resolved.exams.length === 0) { attachScanPageScope(res, { restricted: false, pages: new Set(), blocks: new Set() }); next(); return; }
      const candidateIds = (resolved.exam ? [resolved.exam.id] : resolved.exams.map(e => e.id)).map(Number);

      if (req.user.role_name === "student") {
        res.status(403).json({ message: "权限不足：扫描原卷仅限阅卷侧访问" }); return;
      }
      if (candidateIds.length === 1 && req.user.role_name === "teacher") {
        const original = req.params.examId;
        let allowed = false;
        try {
          req.params.examId = String(candidateIds[0]);
          await requireExamAccess(req, res, () => { allowed = true; });
        } finally {
          if (original === undefined) delete req.params.examId;
          else req.params.examId = original;
        }
        if (!allowed) return;
      } else {
        const visible = await getVisibleExamIds(req.user);
        for (const examId of candidateIds) {
          if (visible !== null && !visible.includes(examId)) {
            res.status(403).json({ message: "权限不足：无权访问此扫描记录所属考试" }); return;
          }
          if (req.user.role_name !== "admin" && await isExamSoftDeleted(examId)) {
            res.status(404).json({ message: "考试不存在或已按数据保留策略清理" }); return;
          }
        }
      }

      const scope = await resolveScanPageScope(req.user, session.card_id, candidateIds);
      attachScanPageScope(res, scope);

      if (req.method === "DELETE") {
        // 删除扫描记录会连带撤出已判成绩与阅卷队列，权限口径与「保存整卷」一致；
        // 取消扫描、读取进度一类操作不改动成绩，仍只要求考试可见。
        for (const examId of candidateIds) {
          const permitted = await getPermittedBlocks(req.user, examId);
          if (permitted === null) continue;
          const exam = await getMysqlDb().get<{ card_id: string }>("SELECT card_id FROM exams WHERE id = ?", examId);
          const card = exam && await new CardRepository().findById(exam.card_id);
          const blocks = card?.bodyBlocks.filter(b => b.type === "objective" || b.type === "subjective") ?? [];
          if (!blocks.length || blocks.some(b => !permitted.includes(b.id))) {
            res.status(403).json({ message: "权限不足：删除扫描记录需要整份答题卡的阅卷权限" }); return;
          }
        }
        next(); return;
      }

      // 读取单条记录/图片时直接按页收口：这一页上没有本人的题块就读不到（CR5）。
      if (recordId && scope.restricted) {
        const record = await getMysqlDb().get<{ page_num: number; side: string }>(
          "SELECT page_num, side FROM twain_scan_records WHERE id = ?", String(recordId));
        const card = await new CardRepository().findById(session.card_id);
        const layoutPage = scanRecordLayoutPage(card, Number(record?.page_num ?? 0), record?.side === "back" ? "back" : "front");
        if (!scanPageAllowed(scope, layoutPage)) {
          res.status(403).json({ message: "权限不足：该扫描页不含本人被分配的题块" }); return;
        }
      }
      next();
    } catch (error) { next(error); }
  };
}

/**
 * 只有 cardId 的请求共用的考试范围校验（PR #312 复核 CR3，本次抽成函数）。
 *
 * 返回值 true 表示放行；false 表示**响应已经写出**，调用方直接 return。
 * 判断口径与原 `requireScannerCardScope` 完全一致：卡号映射回它绑定的全部考试，逐一要求可见；
 * 学生一律 403；绑过的考试全被软删除按「不存在」处理；命中后把题块范围挂进 `res.locals`。
 *
 * 抽成函数而不是只留中间件，是因为 `POST /api/scanner/upload/sessions` 的卡号在**请求体**里，
 * 而且此刻还没有 sessionId，挂不上 `/sessions/:sessionId` 那组中间件（评审 P2：能读卡但不能
 * 读该考试扫描列表的教师，照样可以反复建会话，每个会话落 1 条 session + 最多
 * `MAX_SCAN_SESSION_PAGES` 条待上传记录与令牌）。两处共用同一份判断，才不会一边「读不到」一边「照样建」。
 * API Key 扫描端凭据保持原样绕过——它本来就没有 user 身份，是设计内的机器入口。
 */
export async function enforceScannerCardScope(
  req: Request,
  res: Response,
  cardId: string,
  opts: { wholePaperRead?: boolean } = {}
): Promise<boolean> {
  if ((req as Request & { isApiClient?: boolean }).isApiClient) return true;
  if (!req.user) {
    if (isAuthEnforced()) { res.status(401).json({ message: "未提供认证令牌" }); return false; }
    return true;
  }
  if (!cardId) { res.status(400).json({ message: "缺少答题卡编号" }); return false; }
  const resolved = await resolveScannerExam(cardId, "");
  if (refuseSoftDeletedOnly(res, req.user, resolved)) return false;
  if (resolved.exams.length === 0) {
    attachScanPageScope(res, { restricted: false, pages: new Set(), blocks: new Set() });
    return true;
  }
  if (req.user.role_name === "student") {
    res.status(403).json({ message: "权限不足：扫描原卷仅限阅卷侧访问" }); return false;
  }
  const visible = await getVisibleExamIds(req.user);
  for (const exam of resolved.exams) {
    const examId = Number(exam.id);
    if (visible !== null && !visible.includes(examId)) {
      res.status(403).json({ message: "权限不足：无权访问此答题卡所属考试" }); return false;
    }
    if (req.user.role_name !== "admin" && await isExamSoftDeleted(examId)) {
      res.status(404).json({ message: "考试不存在或已按数据保留策略清理" }); return false;
    }
  }
  const scope = await resolveScanPageScope(req.user, cardId, resolved.exams.map(e => Number(e.id)));
  attachScanPageScope(res, scope);
  if (opts.wholePaperRead && scope.restricted) {
    res.status(403).json({ message: "权限不足：整卷原图预览需要整份答题卡的阅卷权限" }); return false;
  }
  return true;
}

/**
 * 只有 cardId 的扫描列表/会话列表端点（PR #312 复核 CR3）。
 *
 * `/sessions/:cardId`、`/card/:cardId/scans`、`/grading-image/:cardId/:fileName` 都不带 examId，
 * 因此此前完全绕开了考试范围：详情端点已经拒绝的教师，仍可以按卡号从列表读回其它考试的
 * 学号、记录 ID 与总分。范围判断本身见 `enforceScannerCardScope`。
 */
export function requireScannerCardScope(params: { cardIdParam: string; wholePaperRead?: boolean }) {
  return async function scannerCardScope(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cardId = String(req.params[params.cardIdParam] ?? "");
      const allowed = await enforceScannerCardScope(req, res, cardId, { wholePaperRead: params.wholePaperRead });
      if (!allowed) return;
      next();
    } catch (error) { next(error); }
  };
}

/** Mount only after scanner authentication. A raw X-Api-Key header never grants a bypass. */
export async function requireScannerExamScope(req: Request, res: Response, next: NextFunction) {
  if ((req as Request & { isApiClient?: boolean }).isApiClient) { next(); return; }
  if (!req.user) {
    if (isAuthEnforced()) { res.status(401).json({ message: "未提供认证令牌" }); return; }
    next(); return;
  }
  try {
    const db = getMysqlDb();
    let examId = Number(req.params.examId);
    if (!req.params.examId) {
      const session = await db.get<{ card_id: string }>(
        "SELECT card_id FROM twain_scan_sessions WHERE id = ?", req.params.sessionId);
      if (!session) { res.status(404).json({ message: "扫描会话不存在" }); return; }
      const resolved = await resolveScannerExam(session.card_id, String(req.params.sessionId));
      // Unbound local sessions may still be recognized, but cannot mutate exam grades.
      // Same distinction as above: exams that were soft-deleted are not "unbound" (CR4).
      if (refuseSoftDeletedOnly(res, req.user, resolved)) return;
      if (!resolved.exam && resolved.exams.length === 0) { next(); return; }
      if (!resolved.exam) { res.status(409).json({ message: "无法确定扫描会话的考试归属" }); return; }
      examId = resolved.exam.id;
    }
    if (!Number.isSafeInteger(examId) || examId < 1) { res.status(400).json({ message: "无效的考试编号" }); return; }
    const original = req.params.examId;
    let allowed = false;
    try {
      req.params.examId = String(examId);
      await requireExamAccess(req, res, () => { allowed = true; });
    } finally {
      if (original === undefined) delete req.params.examId;
      else req.params.examId = original;
    }
    if (!allowed) return;
    // 扫描端点无论读写都以「整份答题卡」为最小单位（PR #312 复核 CR5）：保存/订正会改动整卷成绩，
    // 会话结果与会话状态本身就是整卷识别结果 + 总分 + 全量页，题块级账号在这里没有可读子集。
    const permitted = await getPermittedBlocks(req.user, examId);
    if (permitted !== null) {
      const exam = await db.get<{ card_id: string }>("SELECT card_id FROM exams WHERE id = ?", examId);
      const card = exam && await new CardRepository().findById(exam.card_id);
      const blocks = card?.bodyBlocks.filter(b => b.type === "objective" || b.type === "subjective") ?? [];
      if (!blocks.length || blocks.some(b => !permitted.includes(b.id))) {
        const reading = req.method === "GET" || req.method === "HEAD";
        res.status(403).json({ message: reading
          ? "权限不足：扫描会话的整卷预览需要整份答题卡的阅卷权限"
          : "权限不足：扫描保存和订正需要整份答题卡的阅卷权限" }); return;
      }
    }
    next();
  } catch (error) { next(error); }
}
