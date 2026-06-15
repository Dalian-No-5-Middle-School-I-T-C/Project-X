export const MIN_PASSWORD_LENGTH = 6;

export function isStudentDefaultPassword(password: string, studentNumber: string | null | undefined): boolean {
  return Boolean(studentNumber) && password === studentNumber;
}

export function validateInitialPassword(options: {
  password: string;
  isStudent: boolean;
  studentNumber?: string | null;
}): string | null {
  const password = options.password;
  if (!password) return "请为该账号设置初始密码";
  if (options.isStudent && isStudentDefaultPassword(password, options.studentNumber)) return null;
  if (password.length < MIN_PASSWORD_LENGTH) return `初始密码至少 ${MIN_PASSWORD_LENGTH} 位`;
  return null;
}

export function validateUserChosenPassword(password: string): string | null {
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    return `新密码长度至少 ${MIN_PASSWORD_LENGTH} 位`;
  }
  return null;
}

