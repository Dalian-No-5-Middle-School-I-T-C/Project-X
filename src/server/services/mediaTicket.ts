/**
 * 单次资源票据（安全 R30）。
 *
 * 票据 = 随机 32 字节十六进制串，绑定「用户 + 一个具体媒体路径」，只读、限时、限量。
 * 它替代的是「把主会话令牌拼进 URL」的做法：日志/历史里留下一条 `?mt=…`，
 * 攻击者拿到的也只能在有效期内重放那一张图/那一份 PDF，读不到其它接口。
 *
 * 为什么放内存而不是建表：票据的价值就在「短命且不外泄成长期状态」。落库会让它变成
 * 一份可被备份、被恢复、跨重启复用的凭据（本仓库的备份链路会整库打包），与初衷相反；
 * SQLite / MariaDB 两方言还要各自处理过期行清理。进程重启后票据自然失效，
 * 前端在 401 时自动补取，是这里更合适的语义。
 *
 * 生命周期：签发即计一次；命中即校验 TTL；过期项在每次签发时顺带清扫；
 * 单用户与全局各有上限（`shared/mediaTicketLimits.ts`，默认 + 环境变量 + 天花板）。
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  MEDIA_TICKET_MAX_PER_USER,
  MEDIA_TICKET_MAX_TOTAL,
  MEDIA_TICKET_TTL_SECONDS,
  describeMediaTicketLimits,
} from "../../shared/mediaTicketLimits";
import { isUrlCredentialAllowedPath } from "../lib/mediaAllowlist";

export interface MediaTicketUserSnapshot {
  id: number;
  username: string;
  name: string;
  role_id: number;
  role_name: string;
  student_number: string | null;
  teacher_role: string | null;
  subject: string | null;
  password_change_required: boolean;
}

interface TicketRecord {
  token: string;
  userId: number;
  /** 绑定的请求路径（不含查询串） */
  path: string;
  expiresAt: number;
  user: MediaTicketUserSnapshot;
}

const tickets = new Map<string, TicketRecord>();

function sweepExpired(now = Date.now()): number {
  let removed = 0;
  for (const [token, record] of tickets) {
    if (record.expiresAt <= now) {
      tickets.delete(token);
      removed++;
    }
  }
  return removed;
}

function countForUser(userId: number): number {
  let n = 0;
  for (const record of tickets.values()) if (record.userId === userId) n++;
  return n;
}

export interface IssuedMediaTicket {
  ticket: string;
  path: string;
  expiresAt: number;
  ttlSeconds: number;
}

/**
 * 签发票据。只允许白名单内的只读媒体路径——否则票据就成了「换个形式的主令牌」。
 * 返回 null 表示该路径不允许用 URL 凭据访问，调用方应改走 Authorization 头。
 */
export function issueMediaTicket(
  user: MediaTicketUserSnapshot,
  rawPath: unknown,
  now = Date.now()
): IssuedMediaTicket | null {
  sweepExpired(now);
  if (typeof rawPath !== "string" || !rawPath.startsWith("/")) return null;
  let pathname: string;
  try {
    pathname = new URL(rawPath, "http://localhost").pathname;
  } catch {
    return null;
  }
  if (!isUrlCredentialAllowedPath(pathname)) return null;
  if (countForUser(user.id) >= MEDIA_TICKET_MAX_PER_USER) {
    // 超出单账号上限时淘汰该用户最旧的一张，避免「开满图集后签不出新票据」。
    let oldest: TicketRecord | undefined;
    for (const record of tickets.values()) {
      if (record.userId !== user.id) continue;
      if (!oldest || record.expiresAt < oldest.expiresAt) oldest = record;
    }
    if (oldest) tickets.delete(oldest.token);
  }
  while (tickets.size >= MEDIA_TICKET_MAX_TOTAL) {
    const first = tickets.keys().next();
    if (first.done) break;
    tickets.delete(first.value);
  }
  const token = randomBytes(32).toString("hex");
  const expiresAt = now + MEDIA_TICKET_TTL_SECONDS * 1000;
  tickets.set(token, { token, userId: user.id, path: pathname, expiresAt, user });
  return { ticket: token, path: pathname, expiresAt, ttlSeconds: MEDIA_TICKET_TTL_SECONDS };
}

/**
 * 校验票据并取回绑定的用户。任何一步不满足都返回 null（不区分原因，避免成为票据探测 oracle）。
 */
export function resolveMediaTicket(
  rawToken: unknown,
  method: string,
  pathname: string,
  now = Date.now()
): MediaTicketUserSnapshot | null {
  if (typeof rawToken !== "string" || rawToken.length < 16) return null;
  if (method !== "GET" && method !== "HEAD") return null;
  const record = tickets.get(rawToken);
  if (!record) return null;
  if (record.expiresAt <= now) {
    tickets.delete(rawToken);
    return null;
  }
  if (record.path !== pathname) return null;
  // 定长比较：Map 命中已经查过，这里只是防止未来改成「按前缀匹配」时把比较退化成短路。
  const expected = Buffer.from(record.token, "utf8");
  const given = Buffer.from(rawToken, "utf8");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return record.user;
}

/** 测试与运维用：当前存活票据数（不暴露内容）。 */
export function mediaTicketStats(now = Date.now()): { active: number; expiredSwept: number } {
  const expiredSwept = sweepExpired(now);
  return { active: tickets.size, expiredSwept };
}

/** 登出/改密时清空该用户的全部票据。 */
export function revokeMediaTicketsForUser(userId: number): number {
  let removed = 0;
  for (const [token, record] of tickets) {
    if (record.userId === userId) {
      tickets.delete(token);
      removed++;
    }
  }
  return removed;
}

export function describeMediaTicketStatus(): string {
  return `${describeMediaTicketLimits()}`;
}

/** 仅测试使用：清空票据表。 */
export function __resetMediaTicketsForTests(): void {
  tickets.clear();
}
