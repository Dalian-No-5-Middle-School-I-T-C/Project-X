/**
 * 扫描后处理的续接状态。
 *
 * 闪退/白屏后 React state 全丢：`postSessions` 没了，工作台也回不到后处理页，
 * 本机草稿即使还在也打不开。这里把「这批卡有哪些会话」和「上次停在哪张卷」存到
 * localStorage，重载后按卡号恢复；不涉及服务器状态，只是导航记忆。
 */
const SESSIONS_PREFIX = "projectx-postprocess-sessions/v1";
const ACTIVE_KEY = "projectx-postprocess-active/v1";
const VIEW_PREFIX = "projectx-postprocess-view/v1";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface PostprocessSessionRef { sessionId: string; pageCount: number; }
export interface PostprocessViewState {
  view: "results" | "correction" | "queue";
  sessionId: string;
  groupId: string;
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore quota/private mode */ }
}

export function readPostprocessSessions(cardId: string, userId?: number | null): PostprocessSessionRef[] {
  const saved = readJson<{ at?: number; userId?: unknown; sessions?: unknown }>(sessionsKey(cardId, userId));
  if (!saved || typeof saved.at !== "number" || Date.now() - saved.at > MAX_AGE_MS || !Array.isArray(saved.sessions)) return [];
  if (userId != null && saved.userId !== userId) return [];
  return saved.sessions.filter((item): item is PostprocessSessionRef => Boolean(item)
    && typeof (item as PostprocessSessionRef).sessionId === "string"
    && typeof (item as PostprocessSessionRef).pageCount === "number");
}

export function writePostprocessSessions(cardId: string, sessions: PostprocessSessionRef[], userId?: number | null): void {
  if (!cardId) return;
  writeJson(sessionsKey(cardId, userId), { at: Date.now(), userId: typeof userId === "number" ? userId : null, sessions });
}

/** 扫描机常多人共用：会话列表按「账号 + 卡」存，否则后一个人打开同一张卡会把前一个人的恢复入口顶掉。 */
function sessionsKey(cardId: string, userId?: number | null): string {
  return `${SESSIONS_PREFIX}/${typeof userId === "number" ? userId : "anon"}/${encodeURIComponent(cardId)}`;
}

/**
 * 扫描机多人共用：活动卡也按账号存。共用一个槽位的话，后登录的人既看不到前一个人的
 * 恢复入口，还会在登录时把它删掉，前一个人回来就失去自动回到后处理页的机会。
 */
function activeKey(userId?: number | null): string {
  return `${ACTIVE_KEY}/${typeof userId === "number" ? userId : "anon"}`;
}

export function readActivePostprocess(userId?: number | null): { cardId: string; cardTitle: string; userId: number | null; at: number } | null {
  const saved = readJson<{ cardId?: unknown; cardTitle?: unknown; userId?: unknown; at?: unknown }>(activeKey(userId));
  if (!saved || typeof saved.cardId !== "string" || typeof saved.at !== "number"
    || Date.now() - saved.at > MAX_AGE_MS) return null;
  if (userId != null && saved.userId !== userId) return null;
  return {
    cardId: saved.cardId,
    cardTitle: typeof saved.cardTitle === "string" ? saved.cardTitle : saved.cardId,
    userId: typeof saved.userId === "number" ? saved.userId : null,
    at: saved.at,
  };
}

export function writeActivePostprocess(cardId: string, cardTitle: string, userId: number | null | undefined): void {
  if (!cardId) return;
  writeJson(activeKey(userId), { cardId, cardTitle, userId: typeof userId === "number" ? userId : null, at: Date.now() });
}

export function clearActivePostprocess(userId?: number | null): void {
  try { localStorage.removeItem(activeKey(userId)); } catch { /* ignore */ }
}

/** 多人共用一台扫描机时，停留视图也按账号存：别人打开同一张卡不会把「停在哪」改掉。 */
export function readPostprocessView(cardId: string, userId?: number | null): PostprocessViewState | null {
  const saved = readJson<PostprocessViewState & { at?: number }>(viewKey(cardId, userId));
  if (!saved || typeof saved.at !== "number" || Date.now() - saved.at > MAX_AGE_MS) return null;
  if (saved.view !== "results" && saved.view !== "correction" && saved.view !== "queue") return null;
  if (typeof saved.sessionId !== "string" || typeof saved.groupId !== "string") return null;
  return { view: saved.view, sessionId: saved.sessionId, groupId: saved.groupId };
}

export function writePostprocessView(cardId: string, state: PostprocessViewState, userId?: number | null): void {
  writeJson(viewKey(cardId, userId), { ...state, at: Date.now() });
}

/** 正常离开后处理页时清掉停留位置；只有闪退/进程崩溃不会走到这里，才会在下次打开时恢复。 */
export function clearPostprocessView(cardId: string, userId?: number | null): void {
  try { localStorage.removeItem(viewKey(cardId, userId)); } catch { /* ignore */ }
}

function viewKey(cardId: string, userId?: number | null): string {
  return `${VIEW_PREFIX}/${typeof userId === "number" ? userId : "anon"}/${encodeURIComponent(cardId)}`;
}
