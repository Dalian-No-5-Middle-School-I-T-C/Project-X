import path from "node:path";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

/**
 * 背景文件名只认正整数用户 id + `.jpg`。
 * 上传处理程序会把临时文件 rename 成这个固定名；删除和清退也只动这一份，
 * 避免把 `upload_*` 临时文件、教师文件或目录外路径卷进去。
 */
export function parseUserId(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    return value;
  }
  if (typeof value === "string" && /^[1-9]\d{0,15}$/.test(value)) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
    return parsed;
  }
  return null;
}

/** 解析 `backgrounds/<userId>.jpg`。id 非法或结果跑出目录时返回 null。 */
export function resolveUserBackgroundPath(dir: string, userId: unknown): string | null {
  const id = parseUserId(userId);
  if (id == null) return null;
  const root = path.resolve(dir);
  const filename = `${id}.jpg`;
  const target = path.resolve(root, filename);
  const relative = path.relative(root, target);
  if (relative !== filename || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return target;
}

/** 删除该用户的背景文件。文件本来就不存在时返回 false，不抛错。 */
export async function removeUserBackgroundFile(dir: string, userId: unknown): Promise<boolean> {
  const target = resolveUserBackgroundPath(dir, userId);
  if (!target || !existsSync(target)) return false;
  // force: 双标签页并发删除时，另一个请求已经删掉文件不应变成 500。
  await rm(target, { force: true });
  return true;
}

/** 只删除给定学生 id 对应的文件，返回实际删掉的份数。 */
export async function removeStudentBackgroundFiles(dir: string, studentIds: readonly unknown[]): Promise<number> {
  let removed = 0;
  for (const id of studentIds) {
    if (await removeUserBackgroundFile(dir, id)) removed += 1;
  }
  return removed;
}
