/**
 * 教师任教学科（教师管理、班级教师配置、服务端校验共用同一份，避免多处硬编码漂移）。
 */
export const TEACHER_SUBJECTS = [
  "语文",
  "数学",
  "英语",
  "物理",
  "化学",
  "生物",
  "历史",
  "地理",
  "政治"
] as const;

export type TeacherSubject = (typeof TEACHER_SUBJECTS)[number];

export function isTeacherSubject(value: string): value is TeacherSubject {
  return (TEACHER_SUBJECTS as readonly string[]).includes(value);
}
