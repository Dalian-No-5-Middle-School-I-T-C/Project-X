// ReviewTracePage —— 阅卷溯源（T5 v2 迁移）
// 视觉层整体切换到 v2：Table / Badge / EmptyState / Spinner。
// 功能守恒：API `/api/review/exams/:examId/trace` 与数据形状零改动。
import React, { useState, useEffect, useCallback } from "react";
import { FileSearch } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { ReviewTraceItem } from "../../../../shared/types";
import {
  Badge,
  EmptyState,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
} from "./ui/v2";

interface Props {
  examId: number;
}

type TraceStatus = ReviewTraceItem["status"];

/** 溯源状态 → v2 Badge tone + 文案（色彩不单独承载状态，始终带文字） */
function traceStatusBadge(status: TraceStatus): React.ReactElement {
  if (status === "reviewed") {
    return (
      <Badge tone="success" dot>
        已审
      </Badge>
    );
  }
  if (status === "disputed") {
    return (
      <Badge tone="danger" dot>
        争议
      </Badge>
    );
  }
  return (
    <Badge tone="neutral" dot>
      {status}
    </Badge>
  );
}

export function ReviewTracePage({ examId }: Props) {
  const [traces, setTraces] = useState<ReviewTraceItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchJson<{ ok: boolean; data: ReviewTraceItem[] }>(
        `/api/review/exams/${examId}/trace`
      );
      if (res.ok) setTraces(res.data);
    } catch { /* silent */ }
    setLoading(false);
  }, [examId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Spinner size={16} /> 加载中...
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <h2 className="text-lg font-semibold text-foreground">阅卷溯源</h2>

      {traces.length === 0 ? (
        <EmptyState
          icon={<FileSearch />}
          title="暂无溯源数据"
          description="本场考试尚未产生评分记录，完成阅卷后此处会展示每份作答的评分轨迹。"
        />
      ) : (
        <TableWrap>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>学生</TableHead>
                <TableHead>学号</TableHead>
                <TableHead>题块</TableHead>
                <TableHead>评分历史</TableHead>
                <TableHead numeric>最终分</TableHead>
                <TableHead>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {traces.map((t) => (
                <TableRow key={t.cropId}>
                  <TableCell className="font-medium">{t.studentName}</TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {t.studentNumber}
                  </TableCell>
                  <TableCell>{t.blockTitle}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                      {t.rounds.map((r, i) => (
                        <span
                          key={i}
                          className="text-xs tabular-nums text-muted-foreground"
                        >
                          R{r.round}: {r.reviewerName}({r.score})
                        </span>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell numeric className="font-medium">
                    {t.finalScore != null
                      ? t.finalScore
                      : t.status === "disputed"
                        ? "争议中"
                        : "-"}
                  </TableCell>
                  <TableCell>{traceStatusBadge(t.status)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableWrap>
      )}
    </div>
  );
}
