import { getDatabase } from "../db";

/**
 * 三级账号权限模型
 * ----------------------------------------------------------------
 * 权限以 "域:动作" 命名（如 card:write），统一在此集中定义，
 * 供中间件 requirePermission() 与角色初始化共同引用，避免散落的字符串字面量。
 *
 * 通配符规则：
 *   - "*"          ：超级权限（管理员），匹配任何权限
 *   - "card:*"     ：域级通配，匹配该域下所有动作
 */

export const PERMISSIONS = {
  // 答题卡
  CARD_READ: "card:read",
  CARD_WRITE: "card:write",
  // 考试
  EXAM_READ: "exam:read",
  EXAM_WRITE: "exam:write",
  // 阅卷 / 成绩
  GRADE_READ: "grade:read",
  GRADE_WRITE: "grade:write",
  // 学生查看自己的成绩
  SCORE_READ: "score:read",
  // 用户管理（仅管理员）
  USER_MANAGE: "user:manage",
  // 班级 / 年级管理（仅管理员）
  CLASS_MANAGE: "class:manage",
  // 系统维护（数据清理、归档等，仅管理员）
  SYSTEM_MANAGE: "system:manage"
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ROLE_IDS = {
  ADMIN: 1,
  TEACHER: 2,
  STUDENT: 3
} as const;

export const ROLE_NAMES = {
  ADMIN: "admin",
  TEACHER: "teacher",
  STUDENT: "student"
} as const;

/**
 * 角色 → 默认权限映射。
 * 这是写库的真实来源（roles.permissions 列由此初始化），
 * 同时作为运行期权限缓存缺失时的兜底。
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: ["*"],
  teacher: [
    PERMISSIONS.CARD_READ,
    PERMISSIONS.CARD_WRITE,
    PERMISSIONS.EXAM_READ,
    PERMISSIONS.EXAM_WRITE,
    PERMISSIONS.GRADE_READ,
    PERMISSIONS.GRADE_WRITE
  ],
  student: [PERMISSIONS.SCORE_READ]
};

/** 角色权限缓存（角色权限极少变更，进程内缓存即可） */
let permissionCache: Map<number, Set<string>> | null = null;

/**
 * 加载/刷新角色权限缓存。
 * 直接读取 roles.permissions（JSON 数组字符串）。
 */
export function loadRolePermissions(forceReload = false): Map<number, Set<string>> {
  if (permissionCache && !forceReload) {
    return permissionCache;
  }
  const db = getDatabase();
  const rows = db.prepare("SELECT id, name, permissions FROM roles").all() as Array<{
    id: number;
    name: string;
    permissions: string | null;
  }>;

  const map = new Map<number, Set<string>>();
  for (const row of rows) {
    let perms: string[] = [];
    if (row.permissions) {
      try {
        const parsed = JSON.parse(row.permissions);
        if (Array.isArray(parsed)) perms = parsed.map(String);
      } catch {
        perms = [];
      }
    }
    if (perms.length === 0 && DEFAULT_ROLE_PERMISSIONS[row.name]) {
      perms = DEFAULT_ROLE_PERMISSIONS[row.name];
    }
    map.set(row.id, new Set(perms));
  }
  permissionCache = map;
  return map;
}

/** 角色变更后调用，清空缓存。 */
export function invalidatePermissionCache(): void {
  permissionCache = null;
}

/** 判断一组持有权限是否满足某个所需权限（支持 "*" 与 "域:*" 通配）。 */
export function permissionSetGrants(held: Set<string>, required: string): boolean {
  if (held.has("*")) return true;
  if (held.has(required)) return true;
  const domain = required.split(":")[0];
  if (held.has(`${domain}:*`)) return true;
  return false;
}

/** 根据角色 ID 判断是否拥有某权限。 */
export function roleHasPermission(roleId: number, required: Permission | string): boolean {
  const cache = loadRolePermissions();
  const held = cache.get(roleId);
  if (!held) return false;
  return permissionSetGrants(held, required);
}

/** 返回某角色的全部权限（用于 /api/auth/me 回传前端做 UI 控制）。 */
export function permissionsForRole(roleId: number): string[] {
  const cache = loadRolePermissions();
  return Array.from(cache.get(roleId) ?? []);
}
