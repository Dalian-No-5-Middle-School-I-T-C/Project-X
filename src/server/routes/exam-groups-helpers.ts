import type { NextFunction, Request, Response } from "express";
import { getMysqlDb } from "../db";
import { getVisibleExamIds } from "../../apps/answer-card/server/middleware";

// Issue #177 文理分科：科目归属 / 筛选
export type TrackType = "common" | "arts" | "science";
export type TrackFilter = "all" | "arts" | "science";

export interface AiProviderRow {
  id: number;
  provider_type: string;
  base_url: string;
  api_key: string;
  user_id: number;
  is_system: number;
}

export interface GroupRow {
  id: number; name: string; description: string | null;
  grade_id: number | null; tag: string | null; status: string;
  is_official: number; total_score_mode: string;
  only_full_participants: number; created_by: number | null;
  created_at: string; updated_at: string;
}

export interface GroupMemberRow {
  id: number; exam_id: number; sort_order: number;
  e_name: string; e_subject: string | null; e_status: string;
  e_exam_date: string | null; e_assigned_formula: string | null;
  graded_count: number; avg_score: number;
}

export interface StudentScoreRow {
  student_id: number; student_number: string; name: string;
  class_name: string | null; class_id: number | null; grade_name: string | null;
}

export interface QuestionScoreRow {
  exam_id: number; student_id: number; question_number: number;
  score: number; max_score: number; score_type: string;
}

export function normalizeTrackType(value: unknown): TrackType | null {
  return value === "arts" || value === "science" || value === "common" ? value : null;
}

export function normalizeTrackFilter(value: unknown): TrackFilter {
  return value === "arts" || value === "science" ? value : "all";
}

export function memberMatchesTrack(trackType: string | null | undefined, track: TrackFilter): boolean {
  const tt = trackType || "common";
  return track === "all" || tt === "common" || tt === track;
}

export async function getAiProviderForUser(providerId: number, userId: number): Promise<AiProviderRow | null> {
  const db = getMysqlDb();
  return (await db.get<AiProviderRow>("SELECT * FROM ai_providers WHERE id = ? AND (user_id = ? OR is_system = 1)", providerId, userId)) ?? null;
}

export function requireGroupManager(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role_name === "admin" || (req.user?.role_name === "teacher" && req.user.teacher_role === "grade_leader")) {
    next();
    return;
  }
  res.status(403).json({ message: "权限不足：仅管理员或年级组长可管理考试组" });
}

export async function visibleExamIdsForGroupRead(req: Request): Promise<number[] | null> {
  if (req.user?.role_name === "admin" || req.user?.teacher_role === "grade_leader") return null;
  if (req.user?.role_name !== "teacher" || !req.user.teacher_role) return [];
  return getVisibleExamIds(req.user);
}

export async function canReadGroup(req: Request, groupId: number): Promise<boolean> {
  const visibleIds = await visibleExamIdsForGroupRead(req);
  if (visibleIds === null) return true;
  if (visibleIds.length === 0) return false;
  const rows = await getMysqlDb().all<{ exam_id: number }>(
    "SELECT exam_id FROM exam_group_members WHERE group_id = ?",
    groupId
  );
  if (rows.length === 0) return false;
  const visible = new Set(visibleIds);
  return rows.every((row) => visible.has(Number(row.exam_id)));
}

export async function requireReadableGroup(req: Request, res: Response, next: NextFunction): Promise<void> {
  const groupId = Number(req.params.groupId);
  if (!Number.isInteger(groupId) || groupId <= 0) {
    res.status(400).json({ message: "无效的考试组 ID" });
    return;
  }
  if (!(await canReadGroup(req, groupId))) {
    res.status(403).json({ message: "权限不足：考试组包含不可访问的考试" });
    return;
  }
  next();
}

export async function assertExamIdsVisible(req: Request, res: Response, examIds: number[]): Promise<boolean> {
  const uniqueIds = [...new Set(examIds.map(Number))];
  if (uniqueIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    res.status(400).json({ message: "examIds 必须全部为正整数" });
    return false;
  }
  if (uniqueIds.length > 0) {
    const existingRows = await getMysqlDb().all<{ id: number }>(
      `SELECT id FROM exams WHERE id IN (${uniqueIds.map(() => "?").join(",")})`,
      ...uniqueIds
    );
    if (existingRows.length !== uniqueIds.length) {
      res.status(404).json({ message: "包含不存在的考试" });
      return false;
    }
  }
  const visibleIds = await visibleExamIdsForGroupRead(req);
  if (visibleIds === null) return true;
  const visible = new Set(visibleIds);
  if (uniqueIds.some((id) => !visible.has(id))) {
    res.status(403).json({ message: "权限不足：包含不可访问的考试" });
    return false;
  }
  return true;
}
