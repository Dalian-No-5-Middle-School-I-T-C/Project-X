/**
 * Zod request-validation schemas (Kimi 建议 #3).
 *
 * Each schema mirrors the existing manual validation in the route handlers.
 * Using `.parse()` / `.safeParse()` gives:
 *   1. Runtime type-safety (replaces `req.body as Record<string, unknown>`)
 *   2. Declarative error messages
 *   3. TypeScript inference via `z.infer`
 *
 * The `validate` helper returns a middleware that calls the schema and sends
 * a 400 response on failure so the route handler receives typed data.
 */
import { z } from "zod";
import type { Request, Response, NextFunction } from "express";

// ── Shared atoms ─────────────────────────────────────────
const EXAM_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ── Card schemas ─────────────────────────────────────────

export const CreateCardSchema = z.object({
  subject: z.string().min(1, "科目为必填项"),
  title: z.string().min(1, "考试名称为必填项"),
  subjectLabel: z.string().optional(),
  examDate: z
    .string()
    .regex(EXAM_DATE_PATTERN, "考试时间需为有效的 YYYY-MM-DD 日期")
    .min(1, "考试时间为必填项"),
  englishListening: z.boolean().optional().default(true),
  chineseChoicePlacement: z.enum(["inline", "front"]).optional().default("front"),
});
export type CreateCardInput = z.infer<typeof CreateCardSchema>;

export const UpdateCardSchema = z.object({
  examDate: z.string().regex(EXAM_DATE_PATTERN, "无效的日期格式").optional(),
  title: z.string().optional(),
  subject: z.string().optional(),
  subjectLabel: z.string().optional(),
  // The rest of the card body is free-form (blocks etc.) — the handler
  // uses normalizeCard() which already sanitises unknown fields.
});
export type UpdateCardInput = z.infer<typeof UpdateCardSchema>;

// ── Exam schemas ─────────────────────────────────────────

export const CreateExamSchema = z.object({
  name: z.string().min(1, "考试名称不能为空"),
  cardId: z.string().min(1, "答题卡 ID 不能为空"),
  gradeId: z.number().int().positive().optional(),
  classId: z.number().int().positive().optional(),
  subject: z.string().optional(),
});
export type CreateExamInput = z.infer<typeof CreateExamSchema>;

export const UpdateExamSchema = z.object({
  cardId: z.string().optional(),
  name: z.string().optional(),
  subject: z.string().optional(),
});
export type UpdateExamInput = z.infer<typeof UpdateExamSchema>;

// ── Cross-exam group schema ──────────────────────────────

export const CreateExamGroupSchema = z.object({
  name: z.string().min(1, "请输入考试组名称"),
  examIds: z
    .array(z.union([z.number(), z.string()]))
    .min(1, "请选择至少一场考试"),
  source: z.enum(["cross-manual", "week"]).optional().default("cross-manual"),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});
export type CreateExamGroupInput = z.infer<typeof CreateExamGroupSchema>;

// ── User settings schema ─────────────────────────────────

export const UpdateUserSettingsSchema = z.object({
  scoreDisplayMode: z.enum(["deviation", "zscore", "percentile"]).optional(),
  reviewConfidenceThreshold: z.number().min(0).max(1).optional(),
  aiApiKey: z.string().nullable().optional(),
  backgroundOpacity: z.number().min(0).max(1).optional(),
});
export type UpdateUserSettingsInput = z.infer<typeof UpdateUserSettingsSchema>;

// ── Middleware factory ───────────────────────────────────

/**
 * Returns Express middleware that validates `req.body` against `schema`.
 * On failure: 400 + structured Zod errors.
 * On success: `req.body` is mutated to the parsed (coerced) value.
 */
export function validateBody(schema: z.ZodObject<any>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        code: "INVALID_VALUE",
        message: "请求参数校验失败",
        errors: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }
    req.body = result.data;
    next();
  };
}
