/** 离线演示入口：登录页输入此账号将跳转到纯静态演示页，不经过后端鉴权。 */
export const OFFLINE_DEMO_IDENTIFIER = "offline-demo";
export const OFFLINE_DEMO_PASSWORD = "offline-demo";
export const OFFLINE_DEMO_PATH = "/demo/index.html";

export function isOfflineDemoLogin(identifier: string, password: string): boolean {
  return (
    identifier.trim().toLowerCase() === OFFLINE_DEMO_IDENTIFIER &&
    password === OFFLINE_DEMO_PASSWORD
  );
}

export function getOfflineDemoUrl(): string {
  return OFFLINE_DEMO_PATH;
}
