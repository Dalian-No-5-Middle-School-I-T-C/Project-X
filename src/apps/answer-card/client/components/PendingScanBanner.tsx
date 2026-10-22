import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../auth/api";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "./ui/v2";
import { CardCorrectionButton } from "./CardCorrectionEditor";
import { ScanPreviewModal, type ScanPage } from "./ScanPreviewModal";
import type { ScanBatchPage } from "../../../../shared/scanPages";
type Item = {
  sessionId: string;
  groupId: string;
  studentNumber: string;
  reason: string;
  existingScore: number | null;
  proposedScore: number | null;
  token: string;
  issue?: string;
  pages: ScanBatchPage[];
};
export function PendingScanBanner({
  examId,
  onChanged,
}: {
  examId: number;
  onChanged?: () => void;
}) {
  const [items, setItems] = useState<Item[]>([]),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [choice, setChoice] = useState<{
    item: Item;
    action: "accept" | "discard";
  } | null>(null);
  const [preview, setPreview] = useState<ScanPage[]>([]);
  const load = useCallback(async () => {
    try {
      const response = await authFetch(`/api/exams/${examId}/scanner-pending`);
      if (response.status === 403 || response.status === 404) {
        setItems([]);
        return;
      }
      if (!response.ok) throw new Error("待确认扫描卷读取失败");
      setItems((await response.json()).items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取失败");
    }
  }, [examId]);
  useEffect(() => {
    setItems([]);
    setOpen(false);
    setError("");
    void load();
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = window.setInterval(refresh, 30000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [load]);
  useEffect(
    () => () => {
      for (const page of preview) URL.revokeObjectURL(page.imageUrl);
    },
    [preview],
  );
  async function view(item: Item) {
    setBusy(true);
    setError("");
    const pages: ScanPage[] = [];
    try {
      for (const page of item.pages) {
        const response = await authFetch(
          `/api/scanner/upload/records/${encodeURIComponent(page.recordId)}/image`,
        );
        if (!response.ok) throw new Error("原卷图片读取失败");
        pages.push({
          ...page,
          imageUrl: URL.createObjectURL(await response.blob()),
        });
      }
      setPreview(pages);
    } catch (e) {
      for (const page of pages) URL.revokeObjectURL(page.imageUrl);
      setError(e instanceof Error ? e.message : "读取失败");
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!choice) return;
    setBusy(true);
    setError("");
    try {
      const response = await authFetch(`/api/exams/${examId}/scanner-pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...choice.item, action: choice.action }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "处理失败");
      setChoice(null);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "处理失败");
      await load();
    } finally {
      setBusy(false);
    }
  }
  if (!items.length && !error && !choice) return null;
  return (
    <section
      className="m-4 max-h-[50vh] shrink-0 overflow-y-auto rounded-lg border border-warning-border bg-warning-soft p-4"
      aria-label="异常扫描卷"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <strong>{items.length} 份扫描卷待处理</strong>
          <p className="m-0 text-sm">
            请按各卷提示核对并保存。重复学号需先订正，名单外学生需核对后加入名单。
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setOpen(!open);
            void load();
          }}
        >
          {open ? "收起" : "查看异常卷"}
        </Button>
      </div>
      {open &&
        items.map((item) => (
          <div
            key={`${item.sessionId}/${item.groupId}`}
            className="mt-3 flex flex-col gap-2 border-t border-border-subtle pt-3"
          >
            <strong>
              学号 {item.studentNumber} ·{" "}
              {item.reason === "roster" ? "不在应考名单" : item.reason === "correction" ? "待订正保存" : "重复学号"}
            </strong>
            <span className="text-sm">
              正式成绩：{item.existingScore ?? "未出分"}　此卷成绩：
              {item.proposedScore ?? "待订正"}
            </span>
            {item.issue && (
              <p className="text-sm text-destructive">{item.issue}</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void view(item)}
              >
                查看此卷
              </Button>
              <CardCorrectionButton
                disabled={busy}
                allowUnchangedSave
                url={`/api/scanner/upload/sessions/${encodeURIComponent(item.sessionId)}/groups/${encodeURIComponent(item.groupId)}/correction`}
                onSaved={() => { void load(); onChanged?.(); }}
              />
              {item.reason === "roster" && (
                <>
                  <Button
                    size="sm"
                    disabled={busy || !!item.issue}
                    onClick={() => {
                      setError("");
                      setChoice({ item, action: "accept" });
                    }}
                  >
                    确认加入名单并入库
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setError("");
                      setChoice({ item, action: "discard" });
                    }}
                  >
                    忽略此卷
                  </Button>
                </>
              )}
            </div>
          </div>
        ))}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {choice && (
        <Dialog
          open={true}
          onOpenChange={(v) => {
            if (!v && !busy) setChoice(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {choice?.action === "accept" ? "确认采用此卷" : "确认忽略此卷"}
              </DialogTitle>
              <DialogDescription>
                {choice?.action === "accept"
                  ? `学号 ${choice.item.studentNumber}：正式成绩 ${choice.item.existingScore ?? "未出分"} → ${choice.item.proposedScore ?? "待订正"}。学生会在权限校验通过后加入应考名单。`
                  : "忽略后保留现有正式成绩，此卷归档，不再重复提醒。"}
              </DialogDescription>
            </DialogHeader>
            <DialogBody>{error && <p role="alert">{error}</p>}</DialogBody>
            <DialogFooter>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setChoice(null)}
              >
                取消
              </Button>
              <Button disabled={busy} onClick={() => void confirm()}>
                确认
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {preview.length > 0 && (
        <ScanPreviewModal
          title="待确认原卷"
          pages={preview}
          onClose={() => setPreview([])}
        />
      )}
    </section>
  );
}
