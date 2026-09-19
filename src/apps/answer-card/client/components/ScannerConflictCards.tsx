import { useEffect, useState } from "react";
import type { ScanConflictCard } from "../../../../shared/scanPages";
import { authFetch } from "../auth/api";
import { Button, Input } from "./ui/v2";
import { ScanPreviewModal, type ScanPage } from "./ScanPreviewModal";

export function ScannerConflictCards({ cards, remote = false, request = authFetch, onChanged }: {
  cards: ScanConflictCard[]; remote?: boolean;
  request?: (url: string, init?: RequestInit) => Promise<Response>;
  onChanged: () => void;
}) {
  const [ids, setIds] = useState<Record<string, string>>({});
  const [corrected, setCorrected] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<ScanPage[]>([]);
  useEffect(() => () => { for (const page of preview) URL.revokeObjectURL(page.imageUrl); }, [preview]);
  async function view(card: ScanConflictCard) {
    setBusy(true); setMessage("");
    const pages: ScanPage[] = [];
    try {
      for (const page of card.pages) {
        const response = await request(remote ? `/api/scanner/upload/records/${encodeURIComponent(page.recordId)}/image` : `/api/scanner/scan-image/${encodeURIComponent(page.recordId)}`);
        if (!response.ok) throw new Error("原卷图片读取失败");
        pages.push({ ...page, imageUrl: URL.createObjectURL(await response.blob()) });
      }
      setPreview(pages);
    } catch (error) {
      for (const page of pages) URL.revokeObjectURL(page.imageUrl);
      setMessage(error instanceof Error ? error.message : "图片读取失败");
    } finally { setBusy(false); }
  }
  async function act(card: ScanConflictCard, save: boolean) {
    setBusy(true); setMessage("");
    try {
      const base = remote ? `/api/scanner/upload/sessions/${encodeURIComponent(card.sessionId)}` : `/api/scanner/session/${encodeURIComponent(card.sessionId)}`;
      const key = `${card.sessionId}/${card.groupId}`;
      const legacy = card.sessionId.startsWith("legacy:");
      const url = legacy ? `/api/scanner/${remote ? "upload/" : ""}legacy/${card.sessionId.slice(7)}/${encodeURIComponent(card.groupId)}/${save ? "save" : "correct"}`
        : `${base}/${save ? (remote ? "complete" : "results") : (remote ? "correct" : "retry")}`;
      const response = await request(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        ...(!save ? { body: JSON.stringify({ groupId: card.groupId, studentId: ids[key]?.trim() }) } : {}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.failures?.map((f: { message: string }) => f.message).join("；") || data.message || "处理失败");
      if (!save) setCorrected(old => ({ ...old, [key]: ids[key].trim() }));
      setMessage(save ? (data.failures?.length ? "仍有问题卷未保存，请继续核对" : "保存完成") : "学号已订正，请核对后重新保存相关卷");
      // Keep both originals accessible until the teacher has saved each corrected attempt.
      if (save) onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : "处理失败"); }
    finally { setBusy(false); }
  }
  return <div className="flex flex-col gap-2 rounded-md border border-warning-border bg-warning-soft p-2">
    <strong className="text-sm">相关新旧卷（均待核对）</strong>
    {cards.map(card => {
      const key = `${card.sessionId}/${card.groupId}`;
      const legacy = card.sessionId.startsWith("legacy:");
      return <div key={key} className="flex flex-col gap-2 border-t border-border-subtle pt-2">
        <span className="text-sm">学号 {corrected[key] ?? card.studentId} · {card.previouslySaved ? "原已入库，成绩已撤出" : "未入库"}{card.totalScore != null ? ` · 原总分 ${card.totalScore}` : ""} · {card.pages.length} 面</span>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy || !card.pages.length} onClick={() => void view(card)}>查看原卷</Button>
          <>
            <Input aria-label={`原卷 ${key} 订正学号`} placeholder="订正后的学号" value={ids[key] ?? ""} onChange={e => setIds(old => ({ ...old, [key]: e.target.value }))} disabled={busy} />
            <Button size="sm" variant="outline" disabled={busy || !ids[key]?.trim()} onClick={() => void act(card, false)}>订正此卷</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(card, true)}>{legacy ? "恢复核对后的历史成绩" : "重新保存此会话"}</Button>
          </>
        </div>
        {legacy && <p className="text-xs text-muted-foreground">历史成绩缺少可验证的原卷来源，已保留完整成绩快照；所列图片为匹配的历史扫描记录，请人工核对。</p>}
      </div>;
    })}
    {message && <p role="status" className="text-sm">{message}</p>}
    {preview.length > 0 && <ScanPreviewModal title="重复学号原卷" pages={preview} onClose={() => setPreview([])} />}
  </div>;
}
