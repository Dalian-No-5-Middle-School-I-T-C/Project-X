import crypto from "node:crypto";

export const MIN_PASSWORD_LENGTH = 6;
export const RANDOM_INITIAL_PASSWORD_LENGTH = 8;

/** 生成不可推导的随机初始密码（hex，长度 >= 8），用于学生/账号导入时无显式密码的兜底。 */
export function generateRandomInitialPassword(length = RANDOM_INITIAL_PASSWORD_LENGTH): string {
  if (length < RANDOM_INITIAL_PASSWORD_LENGTH) length = RANDOM_INITIAL_PASSWORD_LENGTH;
  const bytes = crypto.randomBytes(Math.ceil(length / 2));
  return bytes.toString("hex").slice(0, length);
}

export function validateInitialPassword(options: {
  password: string;
  isStudent: boolean;
  studentNumber?: string | null;
}): string | null {
  const password = options.password;
  if (!password) return "请为该账号设置初始密码";
  if (password.length < MIN_PASSWORD_LENGTH) return `初始密码至少 ${MIN_PASSWORD_LENGTH} 位`;
  return null;
}

export function validateUserChosenPassword(password: string): string | null {
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    return `新密码长度至少 ${MIN_PASSWORD_LENGTH} 位`;
  }
  return null;
}