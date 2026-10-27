import type { CorrectionDocument, CorrectionEdit } from "../../../../shared/scanCorrection";

/**
 * 异常卷订正的本机草稿。
 *
 * 现场反馈：处理到一半闪退/白屏，所有改分都没了。订正只存在 React state，
 * 页面一崩就归零；上传恢复记录能续传，但人工改过的格选没有第二份。
 *
 * 草稿按「答题卡 + 扫描会话 + 组」存 localStorage，并记录每页 revision。
 * 重新打开同一份卷时，只有页面 revision 完全一致才恢复；服务端改过卷就丢弃，
 * 避免把旧格选写到新识别结果上。保存成功后立即清掉。
 */
const KEY_PREFIX = "projectx-correction-draft/v1";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface CorrectionDraft {
  savedAt: number;
  revisions: Record<string, number>;
  edits: CorrectionEdit[];
  /** 考号面板里手输但还没落到格上的原文。 */
  typed?: string;
}

function storageKey(cardId: string, sessionId: string, groupId: string): string {
  return `${KEY_PREFIX}/${encodeURIComponent(cardId)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(groupId)}`;
}

function isValidEdit(value: unknown): value is CorrectionEdit {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<CorrectionEdit>;
  return typeof row.sourceId === "string"
    && typeof row.revision === "number"
    && Array.isArray(row.selected)
    && row.selected.every(item => typeof item === "string");
}

export function readCorrectionDraft(cardId: string, sessionId: string, groupId: string): CorrectionDraft | null {
  try {
    const raw = localStorage.getItem(storageKey(cardId, sessionId, groupId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CorrectionDraft> | null;
    if (!parsed || typeof parsed.savedAt !== "number" || Date.now() - parsed.savedAt > MAX_AGE_MS) {
      clearCorrectionDraft(cardId, sessionId, groupId);
      return null;
    }
    if (!parsed.revisions || typeof parsed.revisions !== "object" || !Array.isArray(parsed.edits)
      || !parsed.edits.every(isValidEdit)) {
      clearCorrectionDraft(cardId, sessionId, groupId);
      return null;
    }
    return {
      savedAt: parsed.savedAt,
      revisions: parsed.revisions as Record<string, number>,
      edits: parsed.edits,
      typed: typeof parsed.typed === "string" ? parsed.typed : undefined,
    };
  } catch {
    return null;
  }
}

export function writeCorrectionDraft(
  cardId: string,
  sessionId: string,
  groupId: string,
  document: CorrectionDocument,
  edits: CorrectionEdit[],
  typed?: string | null,
): void {
  try {
    const revisions: Record<string, number> = {};
    for (const page of document.pages) revisions[page.sourceId] = page.revision;
    const draft: CorrectionDraft = {
      savedAt: Date.now(),
      revisions,
      edits: edits.map(edit => ({ ...edit, selected: [...edit.selected], touched: edit.touched ? [...edit.touched] : undefined })),
      ...(typed ? { typed } : {}),
    };
    localStorage.setItem(storageKey(cardId, sessionId, groupId), JSON.stringify(draft));
  } catch {
    /* 隐私模式或配额满：不影响正在进行的订正 */
  }
}

export function clearCorrectionDraft(cardId: string, sessionId: string, groupId: string): void {
  try {
    localStorage.removeItem(storageKey(cardId, sessionId, groupId));
  } catch {
    /* ignore */
  }
}

/** 草稿必须与当前文档的页数和每页 revision 完全一致，才允许恢复。 */
export function draftMatchesDocument(draft: CorrectionDraft, document: CorrectionDocument): boolean {
  if (draft.edits.length !== document.pages.length) return false;
  return document.pages.every(page => {
    if (draft.revisions[page.sourceId] !== page.revision) return false;
    const edit = draft.edits.find(item => item.sourceId === page.sourceId);
    return Boolean(edit) && edit!.revision === page.revision;
  });
}
