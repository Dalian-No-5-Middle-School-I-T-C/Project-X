export type HistoryMergeOptions = {
  mergeKey?: string;
  mergeWindowMs?: number;
};

export type DesignerHistorySnapshot = {
  card: unknown;
  selectedBlockId: string | null;
};

export type DesignerHistoryState = {
  past: DesignerHistorySnapshot[];
  present: DesignerHistorySnapshot;
  future: DesignerHistorySnapshot[];
  lastMergeKey?: string;
  lastTimestamp: number;
};

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function createDesignerHistory(present: DesignerHistorySnapshot, capacity = 80): DesignerHistoryState {
  const limit = Math.max(2, Math.trunc(capacity) || 80);
  return { past: [], present: clone(present), future: [], lastTimestamp: 0 };
}

/** 连续输入按 key 与时间窗合并；离散操作始终形成独立撤销边界。 */
export function pushDesignerHistory(
  state: DesignerHistoryState,
  next: DesignerHistorySnapshot,
  now = Date.now(),
  options: HistoryMergeOptions = {},
  capacity = 80
): DesignerHistoryState {
  const limit = Math.max(2, Math.trunc(capacity) || 80);
  const nextSnapshot = clone(next);
  const shouldMerge = Boolean(options.mergeKey)
    && options.mergeKey === state.lastMergeKey
    && now - state.lastTimestamp <= Math.max(0, options.mergeWindowMs ?? 800);
  const past = shouldMerge ? state.past : [...state.past, state.present].slice(-limit);
  return {
    past,
    present: nextSnapshot,
    future: [],
    lastMergeKey: options.mergeKey,
    lastTimestamp: now
  };
}

export function replaceDesignerHistoryPresent(state: DesignerHistoryState, next: DesignerHistorySnapshot): DesignerHistoryState {
  return { ...state, present: clone(next) };
}

export function undoDesignerHistory(state: DesignerHistoryState): DesignerHistoryState {
  const previous = state.past[state.past.length - 1];
  if (!previous) return state;
  return {
    past: state.past.slice(0, -1),
    present: clone(previous),
    future: [state.present, ...state.future].slice(0, 80),
    lastTimestamp: 0,
    lastMergeKey: undefined
  };
}

export function redoDesignerHistory(state: DesignerHistoryState): DesignerHistoryState {
  const next = state.future[0];
  if (!next) return state;
  return {
    past: [...state.past, state.present].slice(-80),
    present: clone(next),
    future: state.future.slice(1),
    lastTimestamp: 0,
    lastMergeKey: undefined
  };
}
