import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchJson, setAuthToken, getAuthToken } from "./api";
import { permissionGrants, TEACHER_ROLE_LABELS, type AuthUser, type LoginResponse } from "./types";

// ── v1.6.0: 运行时 Persona（视图身份） ──────────────────────
export type AppPersona = "student" | "teacher" | "teacher-scanner";
export type TeacherRoleOverride = "subject_teacher" | "head_teacher" | "grade_leader" | null;

const PERSONA_STORAGE_KEY = "projectx_persona";
const TEACHER_ROLE_OVERRIDE_KEY = "projectx_teacher_role_override";

function loadPersona(): AppPersona | null {
  try {
    const v = localStorage.getItem(PERSONA_STORAGE_KEY);
    if (v === "student" || v === "teacher" || v === "teacher-scanner") return v;
  } catch { /* ignore */ }
  return null;
}

function savePersona(p: AppPersona): void {
  try { localStorage.setItem(PERSONA_STORAGE_KEY, p); } catch { /* ignore */ }
}

function loadTeacherRoleOverride(): TeacherRoleOverride {
  try {
    const v = localStorage.getItem(TEACHER_ROLE_OVERRIDE_KEY);
    if (v === "subject_teacher" || v === "head_teacher" || v === "grade_leader") return v;
  } catch { /* ignore */ }
  return null;
}

function saveTeacherRoleOverride(r: TeacherRoleOverride): void {
  try {
    if (r) localStorage.setItem(TEACHER_ROLE_OVERRIDE_KEY, r);
    else localStorage.removeItem(TEACHER_ROLE_OVERRIDE_KEY);
  } catch { /* ignore */ }
}

function defaultPersonaForUser(user: AuthUser): AppPersona {
  if (user.role_name === "admin") {
    // 管理员可任意切换，默认全功能扫描端
    return loadPersona() ?? "teacher-scanner";
  }
  if (user.role_name === "student") return "student";
  // 教师：如果有扫描硬件，默认扫描端；否则普通教师端
  return loadPersona() ?? "teacher";
}

function availablePersonasForUser(user: AuthUser): AppPersona[] {
  if (user.role_name === "admin") {
    return ["teacher-scanner", "teacher", "student"];
  }
  if (user.role_name === "student") return ["student"];
  return ["teacher"];
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (identifier: string, password: string, isPersistent?: boolean) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  hasPermission: (perm: string) => boolean;
  isAdmin: boolean;
  isTeacher: boolean;
  isStudent: boolean;
  teacherRole: string | null;
  isSubjectTeacher: boolean;
  isHeadTeacher: boolean;
  isGradeLeader: boolean;
  teacherRoleLabel: string;
  // ── v1.6.0: 运行时 Persona ──
  persona: AppPersona;
  setPersona: (p: AppPersona) => void;
  teacherRoleOverride: TeacherRoleOverride;
  setTeacherRoleOverride: (r: TeacherRoleOverride) => void;
  availablePersonas: AppPersona[];
  canSwitchPersona: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [persona, setPersonaState] = useState<AppPersona>("teacher");
  const [teacherRoleOverride, setTeacherRoleOverrideState] = useState<TeacherRoleOverride>(null);

  const refreshUser = useCallback(async () => {
    const token = getAuthToken();
    try {
      const me = await fetchJson<AuthUser>("/api/auth/me");
      setUser(me);
      setPersonaState(defaultPersonaForUser(me));
      if (me.role_name === "admin") {
        setTeacherRoleOverrideState(loadTeacherRoleOverride());
      }
    } catch {
      if (token) setAuthToken(null);
      setUser(null);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await refreshUser();
      setLoading(false);
    })();
  }, [refreshUser]);

  const login = useCallback(async (identifier: string, password: string, isPersistent?: boolean) => {
    const result = await fetchJson<LoginResponse>("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password, isPersistent: !!isPersistent })
    });
    setAuthToken(result.token);
    const nextUser: AuthUser = {
      ...result.user,
      role_name: result.user.role_name ?? "unknown",
      permissions: result.permissions ?? result.user.permissions ?? []
    };
    setUser(nextUser);
    setPersonaState(defaultPersonaForUser(nextUser));
    if (nextUser.role_name === "admin") {
      setTeacherRoleOverrideState(loadTeacherRoleOverride());
    }
  }, []);

  useEffect(() => {
    const onUnauthorized = () => setUser(null);
    window.addEventListener("projectx:unauthorized", onUnauthorized);
    return () => window.removeEventListener("projectx:unauthorized", onUnauthorized);
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetchJson("/api/auth/logout", { method: "POST" });
    } catch {
      // ignore logout errors
    }
    setAuthToken(null);
    setUser(null);
  }, []);

  const hasPermission = useCallback(
    (perm: string) => {
      if (!user) return false;
      return permissionGrants(user.permissions, perm);
    },
    [user]
  );

  const setPersona = useCallback((p: AppPersona) => {
    setPersonaState(p);
    savePersona(p);
  }, []);

  const setTeacherRoleOverride = useCallback((r: TeacherRoleOverride) => {
    setTeacherRoleOverrideState(r);
    saveTeacherRoleOverride(r);
  }, []);

  const teacherRole = user?.role_name === "teacher" ? (user?.teacher_role ?? null) : null;
  const availablePersonas = useMemo(
    () => user ? availablePersonasForUser(user) : [],
    [user]
  );
  const canSwitchPersona = useMemo(
    () => user?.role_name === "admin",
    [user]
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      login,
      logout,
      refreshUser,
      hasPermission,
      isAdmin: user?.role_name === "admin",
      isTeacher: user?.role_name === "teacher",
      isStudent: user?.role_name === "student",
      teacherRole,
      isSubjectTeacher: teacherRole === "subject_teacher",
      isHeadTeacher: teacherRole === "head_teacher",
      isGradeLeader: teacherRole === "grade_leader",
      teacherRoleLabel: teacherRole ? (TEACHER_ROLE_LABELS[teacherRole] ?? "") : "",
      // ── v1.6.0 ──
      persona,
      setPersona,
      teacherRoleOverride,
      setTeacherRoleOverride,
      availablePersonas,
      canSwitchPersona,
    }),
    [user, loading, login, logout, refreshUser, hasPermission, teacherRole, persona, setPersona, teacherRoleOverride, setTeacherRoleOverride, availablePersonas, canSwitchPersona]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
