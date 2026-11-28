// ReviewTracePage —— 阅卷溯源（T5 v2 迁移）
// 当前服务端溯源接口仅支持 blockId；搜索、状态和分页在已授权响应内有界执行。
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { FileSearch } from "lucide-react";
import { fetchJson, mediaUrl } from "../auth/api";
import type { ReviewBlockSummary, ReviewTraceItem } from "../../../../shared/types";
import {
  filterReviewTrace,
  paginateReviewTrace,
  TRACE_PAGE_SIZE_OPTIONS,
  TRACE_STATUS_OPTIONS,
  traceStatusLabel,
  traceStatusTone,
} from "../../../../shared/reviewTrace";
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Pagination,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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

export function ReviewTracePage({ examId }: Props) {
  const [traces, setTraces] = useState<ReviewTraceItem[]>([]);
  const [blocks, setBlocks] = useState<ReviewBlockSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [blockId, setBlockId] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError("");
    const suffix = blockId ? `?blockId=${encodeURIComponent(blockId)}` : "";
    try {
      const res = await fetchJson<{ ok: boolean; data: ReviewTraceItem[] }>(`/api/review/exams/${examId}/trace${suffix}`);
      if (sequence === requestSequence.current && res.ok) setTraces(res.data);
    } catch (err) {
      if (sequence === requestSequence.current) setError(err instanceof Error ? err.message : "溯源数据加载失败");
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [examId, blockId]);

  useEffect(() => {
    let active = true;
    setQ("");
    setStatus("all");
    setBlockId("");
    setPage(1);
    fetchJson<{ examId: number; blocks: ReviewBlockSummary[] }>(`/api/review/exams/${examId}/blocks`)
      .then(res => { if (active) setBlocks(res.blocks); })
      .catch(() => { if (active) setBlocks([]); });
    return () => { active = false; };
  }, [examId]);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => filterReviewTrace(traces, { q, status, blockId }), [traces, q, status, blockId]);
  const pagination = useMemo(() => paginateReviewTrace(filtered, page, pageSize), [filtered, page, pageSize]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Spinner size={16} /> 加载中...
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">阅卷溯源</h2>
        <div className="flex flex-wrap items-end gap-2">
          <Input
            aria-label="搜索溯源记录"
            placeholder="搜索姓名、学号、题块或评阅人"
            value={q}
            onChange={event => { setQ(event.target.value); setPage(1); }}
            className="w-64"
          />
          <Select aria-label="题块筛选" value={blockId || "all"} onValueChange={value => { setBlockId(value === "all" ? "" : value); setPage(1); }}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部题块</SelectItem>
              {blocks.map(block => <SelectItem key={block.blockId} value={block.blockId}>{block.blockTitle}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select aria-label="状态筛选" value={status} onValueChange={value => { setStatus(value); setPage(1); }}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              {TRACE_STATUS_OPTIONS.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {error && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-destructive-border bg-destructive-soft px-3 py-2 text-sm text-destructive-fg">
          {error}
          <Button variant="ghost" size="sm" onClick={() => void load()}>重试</Button>
        </div>
      )}

      {traces.length === 0 ? (
        <EmptyState icon={<FileSearch />} title="暂无溯源数据" description="本场考试尚未产生评分记录，完成阅卷后此处会展示每份作答的评分轨迹。" />
      ) : filtered.length === 0 ? (
        <EmptyState icon={<FileSearch />} title="没有匹配的溯源记录" description="请调整搜索词、题块或状态筛选。" />
      ) : (
        <div className="overflow-hidden rounded-md border border-border-subtle">
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
                  <TableHead>作答</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagination.rows.map(trace => (
                  <TableRow key={trace.cropId}>
                    <TableCell className="font-medium">{trace.studentName}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">{trace.studentNumber}</TableCell>
                    <TableCell>{trace.blockTitle}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        {trace.rounds.map((round, index) => (
                          <span key={index} className="text-xs tabular-nums text-muted-foreground">R{round.round}: {round.reviewerName}({round.score})</span>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell numeric className="font-medium">
                      {trace.finalScore != null ? trace.finalScore : trace.status === "disputed" ? "争议中" : "-"}
                    </TableCell>
                    <TableCell>
                      <Badge tone={traceStatusTone(trace.status)} dot>{traceStatusLabel(trace.status)}</Badge>
                    </TableCell>
                    <TableCell>
                      <Button asChild variant="ghost" size="sm">
                        <a href={mediaUrl(`/api/answer-block-crops/${encodeURIComponent(trace.cropId)}/image`)} target="_blank" rel="noreferrer">查看切图</a>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableWrap>
          <Pagination
            total={filtered.length}
            page={pagination.page}
            pageSize={pageSize}
            pageSizeOptions={TRACE_PAGE_SIZE_OPTIONS}
            onPageSizeChange={size => { setPageSize(size); setPage(1); }}
            onPageChange={setPage}
          />
        </div>
      )}
    </div>
  );
}
