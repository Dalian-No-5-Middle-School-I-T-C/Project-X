import { useState } from "react";
import type { PdfWarningState } from "../WorkspaceContext";
import { KnowledgeAnalysisInline } from "./KnowledgeAnalysisInline";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/v2";

export function PdfExportDialog({ check, onClose, onExport, onManagePaper }: {
  check: PdfWarningState;
  onClose: () => void;
  onExport: () => void;
  onManagePaper: () => void;
}) {
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzedPoints, setPoints] = useState<PdfWarningState["knowledgePoints"]>();
  const points = analyzedPoints ?? check.knowledgePoints ?? [];
  const { validation } = check;
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent size="sm" className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle>导出 PDF</DialogTitle>
          <p className="m-0 text-sm text-muted-foreground">确认分值后即可导出。原卷和知识点可按需补充，不影响打印答题卡。</p>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <section className="rounded-md border border-border bg-secondary p-3">
            <h3 className="m-0 text-base font-semibold">总分 {validation.totalScore} 分</h3>
            <p className="mt-1 mb-0 text-sm text-muted-foreground">客观题 {validation.objectiveScore} 分 · 主观题 {validation.subjectiveScore} 分</p>
            {validation.issues.length > 0 ? (
              <div className="mt-3 rounded-md border border-warning-border bg-warning-soft p-3 text-sm">
                <p className="m-0 font-medium">请确认以下分值提醒</p>
                <ul className="mb-0 mt-2 list-disc space-y-1 pl-5">
                  {validation.issues.map((issue, index) => <li key={index}>{issue.message}</li>)}
                </ul>
                <p className="mb-0 mt-2 text-muted-foreground">若符合本次考试安排，可直接确认导出。</p>
              </div>
            ) : <p className="mb-0 mt-2 text-sm text-success-foreground">分值检查通过</p>}
          </section>
          <section className="rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="m-0 text-base font-semibold">原卷 <span className="text-sm font-normal text-muted-foreground">可选</span></h3>
              <Button variant="outline" size="sm" onClick={onManagePaper}>{check.paperInfo?.hasPaper ? "管理原卷" : "上传原卷"}</Button>
            </div>
            <p className="mb-0 mt-2 text-sm text-muted-foreground">{!check.paperInfo ? "原卷信息暂未加载，不影响导出。" : check.paperInfo.hasPaper ? `已上传：${check.paperInfo.filename || "原卷"}` : "尚未上传，可在需要分析试题时再补充。"}</p>
          </section>
          <section className="rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="m-0 text-base font-semibold">知识点分析 <span className="text-sm font-normal text-muted-foreground">可选</span></h3>
              {check.paperInfo?.hasPaper && !analyzing && <Button variant="outline" size="sm" onClick={() => setAnalyzing(true)}>{points.length ? "重新分析" : "分析知识点"}</Button>}
            </div>
            <p className="mb-0 mt-2 text-sm text-muted-foreground">{points.length ? `已有 ${points.length} 道题的知识点。` : "用于后续知识点统计，可稍后分析。"}</p>
            {analyzing && check.cardId && <div className="mt-3"><KnowledgeAnalysisInline cardId={check.cardId} onDone={value => { setPoints(value); setAnalyzing(false); }} /></div>}
          </section>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>返回编辑</Button>
          <Button variant="primary" autoFocus onClick={onExport}>{validation.issues.length ? "确认分值并导出 PDF" : "导出 PDF"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
