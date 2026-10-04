/**
 * 安全 R33：演示数据的凭据与导入口径（单一来源）。
 *
 * 演示账号的口令曾固定为公开文档里的 `teacher123` / 学号，而演示教师又没有 `teacher_role`——
 * 按 `routes/scores.ts` 的兼容分支，未配置 `teacher_role` 的教师「全部可见」。两者叠加的后果是：
 * 只要生产库导入过一次演示数据，任何读过 README 的人都能以**全校可见**的教师身份登录。
 * 现在默认「随机口令 + 任课教师范围」，固定口令只在显式声明的测试环境下恢复。
 *
 * 这两个开关都是**布尔**而非数值上限，因此没有「默认值 / 环境变量 / 天花板」三档，
 * 但沿用同一条纪律：取值非法一律按关闭处理并打印一行 `[demo-policy]`，绝不静默放宽。
 */

export const DEMO_FIXED_CREDENTIALS_ENV = "PROJECTX_DEMO_FIXED_CREDENTIALS";
export const DEMO_ALLOW_PRODUCTION_IMPORT_ENV = "PROJECTX_DEMO_ALLOW_PRODUCTION_IMPORT";

/** 本模块读取的全部环境变量，供 verify 脚本断言「清空的变量清单 == 模块声明的清单」。 */
export const DEMO_POLICY_ENV_VARS: readonly string[] = Object.freeze([
  DEMO_FIXED_CREDENTIALS_ENV,
  DEMO_ALLOW_PRODUCTION_IMPORT_ENV,
]);

/** 生产库导入演示数据所需的显式确认串（前端二次确认后随请求体提交）。 */
export const DEMO_IMPORT_PRODUCTION_CONFIRM = "IMPORT_DEMO_INTO_PRODUCTION";

/**
 * 历史公开演示口令：出现在任何公开文档/旧版本代码里的演示口令一律视为**无效**（与 R01 同口径）。
 * 只在 `PROJECTX_DEMO_FIXED_CREDENTIALS` 显式打开时才会被使用。
 */
export const LEGACY_PUBLIC_DEMO_TEACHER_PASSWORD = "teacher123";

/** 演示教师的固定用户名（保留名：库里的同名账号一律按演示账号处置，见 DemoDataService）。 */
export const DEMO_TEACHER_USERNAMES: readonly string[] = Object.freeze(["demo-teacher", "demo-teacher-2"]);

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

function readBooleanEnv(name: string): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return false;
  if (TRUTHY.has(raw)) return true;
  if (FALSY.has(raw)) return false;
  warnOnce(`bad-${name}`, `[demo-policy] ${name}="${raw}" 无法识别，按关闭处理（只接受 1/true/yes/on 或 0/false/no/off）`);
  return false;
}

/**
 * 是否使用公开文档里的固定演示口令。默认关闭：演示账号口令每次导入随机生成，
 * 教师口令随导入结果返回一次并写入 `users.initial_password`（管理员可在既有导出里查回）。
 */
export function demoFixedCredentialsEnabled(): boolean {
  const enabled = readBooleanEnv(DEMO_FIXED_CREDENTIALS_ENV);
  if (enabled) {
    warnOnce(
      "fixed-credentials",
      `[demo-policy] ${DEMO_FIXED_CREDENTIALS_ENV} 已打开：演示账号使用公开文档里的固定口令，仅限隔离测试环境`
    );
  }
  return enabled;
}

/**
 * 是否允许在**已有真实数据**的库里导入演示数据而不要求逐次确认。默认关闭：
 * 导入会写入 16 个演示账号与十几场考试，误点一次就得靠 clear-demo 收拾，
 * 所以默认要求前端带上 `DEMO_IMPORT_PRODUCTION_CONFIRM` 再执行。
 */
export function demoProductionImportAllowedByEnv(): boolean {
  return readBooleanEnv(DEMO_ALLOW_PRODUCTION_IMPORT_ENV);
}
