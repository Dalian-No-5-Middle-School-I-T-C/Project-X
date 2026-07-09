/**
 * Offline demo mode helpers — SPA-integrated (same UI as main app).
 * Login with offline-demo / offline-demo enters the React app with mock data.
 */
export const OFFLINE_DEMO_IDENTIFIER = "offline-demo";
export const OFFLINE_DEMO_PASSWORD = "offline-demo";
/** Legacy static path; now redirects into the SPA login / demo session. */
export const OFFLINE_DEMO_PATH = "/";
export const OFFLINE_DEMO_TOKEN = "projectx-offline-demo-token";
export const OFFLINE_DEMO_FLAG_KEY = "projectx_offline_demo";

export function isOfflineDemoLogin(identifier: string, password: string): boolean {
  return (
    identifier.trim().toLowerCase() === OFFLINE_DEMO_IDENTIFIER &&
    password === OFFLINE_DEMO_PASSWORD
  );
}

export function getOfflineDemoUrl(): string {
  return OFFLINE_DEMO_PATH;
}

export function isOfflineDemoToken(token: string | null | undefined): boolean {
  return token === OFFLINE_DEMO_TOKEN;
}

export function markOfflineDemoSession(): void {
  try {
    localStorage.setItem(OFFLINE_DEMO_FLAG_KEY, "1");
  } catch {
    /* ignore */
  }
}

export function clearOfflineDemoSession(): void {
  try {
    localStorage.removeItem(OFFLINE_DEMO_FLAG_KEY);
  } catch {
    /* ignore */
  }
}

export function hasOfflineDemoSession(): boolean {
  try {
    return localStorage.getItem(OFFLINE_DEMO_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}
