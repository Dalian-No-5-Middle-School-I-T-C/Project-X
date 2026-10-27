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

export function readPostprocessSessions(cardId: string): PostprocessSessionRef[] {
  const saved = readJson<{ at?: number; sessions?: unknown }>(`${SESSIONS_PREFIX}/${encodeURIComponent(cardId)}`);
  if (!saved || typeof saved.at !== "number" || Date.now() - saved.at > MAX_AGE_MS || !Array.isArray(saved.sessions)) return [];
  return saved.sessions.filter((item): item is PostprocessSessionRef => Boolean(item)
    && typeof (item as PostprocessSessionRef).sessionId === "string"
    && typeof (item as PostprocessSessionRef).pageCount === "number");
}

export function writePostprocessSessions(cardId: string, sessions: PostprocessSessionRef[]): void {
  if (!cardId) return;
  writeJson(`${SESSIONS_PREFIX}/${encodeURIComponent(cardId)}`, { at: Date.now(), sessions });
}

export function readActivePostprocess(): { cardId: string; cardTitle: string; at: number } | null {
  const saved = readJson<{ cardId?: unknown; cardTitle?: unknown; at?: unknown }>(ACTIVE_KEY);
  if (!saved || typeof saved.cardId !== "string" || typeof saved.at !== "number"
    || Date.now() - saved.at > MAX_AGE_MS) return null;
  return { cardId: saved.cardId, cardTitle: typeof saved.cardTitle === "string" ? saved.cardTitle : saved.cardId, at: saved.at };
}

export function writeActivePostprocess(cardId: string, cardTitle: string): void {
  if (!cardId) return;
  writeJson(ACTIVE_KEY, { cardId, cardTitle, at: Date.now() });
}

export function clearActivePostprocess(): void {
  try { localStorage.removeItem(ACTIVE_KEY); } catch { /* ignore */ }
}

export function readPostprocessView(cardId: string): PostprocessViewState | null {
  const saved = readJson<PostprocessViewState & { at?: number }>(`${VIEW_PREFIX}/${encodeURIComponent(cardId)}`);
  if (!saved || typeof saved.at !== "number" || Date.now() - saved.at > MAX_AGE_MS) return null;
  if (saved.view !== "results" && saved.view !== "correction" && saved.view !== "queue") return null;
  if (typeof saved.sessionId !== "string" || typeof saved.groupId !== "string") return null;
  return { view: saved.view, sessionId: saved.sessionId, groupId: saved.groupId };
}

export function writePostprocessView(cardId: string, state: PostprocessViewState): void {
  writeJson(`${VIEW_PREFIX}/${encodeURIComponent(cardId)}`, { ...state, at: Date.now() });
}

/** 正常离开后处理页时清掉停留位置；只有闪退/进程崩溃不会走到这里，才会在下次打开时恢复。 */
export function clearPostprocessView(cardId: string): void {
  try { localStorage.removeItem(`${VIEW_PREFIX}/${encodeURIComponent(cardId)}`); } catch { /* ignore */ }
}
