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
  /** 同一组可能有多条异常项（考号 + 存疑等）：恢复时要回到具体那一条，不能只按组找第一条。 */
  itemId?: string;
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

let warnedWriteFailure = false;

function writeJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // 恢复标记只是导航记忆：失败时不影响本次操作，但要留下一次痕迹，
    // 否则现场只会看到「崩溃后怎么没回到原处」而没有任何线索。
    if (!warnedWriteFailure) {
      warnedWriteFailure = true;
      console.warn("[scanner] 本机恢复标记写入失败（配额已满或存储被禁用），崩溃后可能无法自动回到上次位置");
    }
    return false;
  }
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
 * 落盘该记到哪张卡上：有当前选择就用它；选择已被清空（返回卡片列表）时用「刚才那张卡」，
 * 但必须同一个账号——否则上一个账号的卡会被写进新账号的槽位，覆盖人家自己的恢复列表。
 */
export function resolvePersistCardId(
  selectedCardId: string,
  last: { userId: number; cardId: string } | null,
  userId?: number | null,
): string {
  if (selectedCardId) return selectedCardId;
  if (!last || userId == null || last.userId !== userId) return "";
  return last.cardId;
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
  return {
    view: saved.view,
    sessionId: saved.sessionId,
    groupId: saved.groupId,
    ...(typeof saved.itemId === "string" ? { itemId: saved.itemId } : {}),
  };
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
