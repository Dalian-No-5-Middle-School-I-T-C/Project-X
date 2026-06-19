export interface AuthUser {
  id: number;
  username: string;
  name: string;
  role_id: number;
  role_name: string;
  role_display_name?: string;
  student_number: string | null;
  teacher_role?: string | null;
  subject?: string | null;
  email?: string | null;
  last_login_at?: string | null;
  permissions: string[];
}

export interface LoginResponse {
  token: string;
  user: Omit<AuthUser, "permissions"> & { permissions?: string[] };
  permissions: string[];
  message?: string;
}

export interface UserListItem {
  id: number;
  username: string;
  name: string;
  role_id: number;
  role_name?: string;
  role_display_name?: string;
  student_number: string | null;
  subject: string | null;
  teacher_role?: string | null;
  initial_password: string | null;
  email: string | null;
  phone: string | null;
  is_active: number;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface UsersListResponse {
  users: UserListItem[];
  total: number;
  page: number;
  pageSize: number;
  roleSummary: Array<{ role_name: string; display_name: string; count: number }>;
}

export function roleCount(summary: UsersListResponse["roleSummary"], role: string): number {
  return summary.find((item) => item.role_name === role)?.count ?? 0;
}

export interface GradeRecord {
  id: number;
  name: string;
  sort_order: number;
  created_at: string;
}

export interface ClassRecord {
  id: number;
  grade_id: number;
  name: string;
  sort_order: number;
  created_at: string;
  grade_name?: string;
  student_count?: number;
}

export interface ClassStudent {
  student_id: number;
  username: string;
  name: string;
  student_number: string | null;
  joined_at: string;
}

export interface StudentExamScore {
  exam_id: number;
  exam_name: string;
  subject: string | null;
  objective_score: number;
  subjective_score: number;
  total_score: number;
  rank: number | null;
  percentile: number | null;
  class_size: number;
  graded_at: string;
}

export interface StudentQuestionScore {
  question_number: number | null;
  question_id: string | null;
  block_id: string | null;
  score: number;
  max_score: number;
  score_type: string;
}

export const ROLE_LABELS: Record<string, string> = {
  admin: "管理员",
  teacher: "教师",
  student: "学生"
};

export const TEACHER_ROLE_LABELS: Record<string, string> = {
  subject_teacher: "学科老师",
  head_teacher: "班主任",
  grade_leader: "学年主任"
};

export const PERMISSIONS = {
  CARD_READ: "card:read",
  CARD_WRITE: "card:write",
  EXAM_READ: "exam:read",
  EXAM_WRITE: "exam:write",
  GRADE_READ: "grade:read",
  GRADE_WRITE: "grade:write",
  SCORE_READ: "score:read",
  USER_MANAGE: "user:manage",
  CLASS_MANAGE: "class:manage",
  SYSTEM_MANAGE: "system:manage"
} as const;

export function permissionGrants(held: string[], required: string): boolean {
  const set = new Set(held);
  if (set.has("*")) return true;
  if (set.has(required)) return true;
  const domain = required.split(":")[0];
  return set.has(`${domain}:*`);
}

// ──────────────────────────────────────────────────────────
// v1.1: 教师管理 / 学生管理 新增类型
// ──────────────────────────────────────────────────────────

export interface TeacherRecord {
  id: number;
  username: string;
  name: string;
  role_id: number;
  role_name?: string;
  role_display_name?: string;
  subject: string | null;
  teacher_role?: string | null;
  email: string | null;
  phone: string | null;
  created_at: string;
  classes?: Array<{
    class_id: number;
    class_name: string;
    grade_name: string;
    subject: string | null;
  }>;
}

export interface TeachersListResponse {
  teachers: TeacherRecord[];
  total: number;
  page: number;
  pageSize: number;
}

export interface StudentWithClass {
  student_id: number;
  username: string;
  name: string;
  student_number: string | null;
  initial_password: string | null;
  class_id: number;
  class_name: string;
  grade_id: number;
  grade_name: string;
  joined_at: string;
}

export interface CsvImportResult {
  students: { created: number; skipped: number; errors: Array<{ row: string[]; message: string }> };
  teachers: { created: number; skipped: number; errors: Array<{ row: string[]; message: string }> };
}
