import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchJson, setAuthToken, getAuthToken } from "./api";
import { permissionGrants, type AuthUser, type LoginResponse } from "./types";

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
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    const token = getAuthToken();
    try {
      const me = await fetchJson<AuthUser>("/api/auth/me");
      setUser(me);
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
      isStudent: user?.role_name === "student"
    }),
    [user, loading, login, logout, refreshUser, hasPermission]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
