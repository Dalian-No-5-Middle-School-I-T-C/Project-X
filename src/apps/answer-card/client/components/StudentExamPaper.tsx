import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, FileText, Images, RefreshCw } from "lucide-react";
import { fetchJson, mediaUrl } from "../auth/api";
import type { AnswerBlockCrop } from "../../../../shared/types";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/v2";

/**
 * StudentExamPaper —— v53 学生端「查看原卷 / 查看答案解析」
 *
 * 口径与小程序一致：
 *  · 后端已用「成绩已公布 + 教师开启显示原卷」把关，前端不再自行推断可见性；
 *  · 只渲染教师保存的答案文字，不判对错、不比对本人作答；
 *  · 先看卷（原卷页 + 每页下方按题号的答案），再看本人作答。
 */

type PaperAnswer = { questionNumber: number; answerText: string; pageIndex: number | null };

type PaperPage = {
  pageIndex: number;
  filename: string;
  mimeType: string;
  isImage: boolean;
  imageUrl: string;
  answers: PaperAnswer[];
};

type PaperPayload = {
  examId: number;
  examName: string | null;
  subject: string | null;
  hasOriginalPaper: boolean;
  pages: PaperPage[];
  answers: PaperAnswer[];
  answerBlocks?: AnswerBlockCrop[];
};

interface Props {
  examId: number;
  examName: string;
  onBack: () => void;
}

/** 原卷页图片：加载失败时不留破图，也不谎报成功 */
function PaperImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) {
    return (
      <div className="flex h-40 items-center justify-center rounded-md border border-border-subtle bg-secondary text-sm text-muted-foreground">
        该页图片加载失败，可点右上角刷新重试
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className="w-full rounded-md border border-border-subtle bg-card object-contain"
    />
  );
}

function AnswerTable({ answers }: { answers: PaperAnswer[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-24">题号</TableHead>
          <TableHead>正确答案</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {answers.map((answer, i) => (
          <TableRow key={`${answer.questionNumber}_${i}`}>
            <TableCell><span className="tabular-nums">{answer.questionNumber}</span></TableCell>
            <TableCell className="whitespace-pre-wrap break-words">{answer.answerText}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function StudentExamPaper({ examId, examName, onBack }: Props) {
  const [data, setData] = useState<PaperPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await fetchJson<PaperPayload>(`/api/scores/me/exams/${examId}/paper`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "原卷加载失败");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [examId]);

  useEffect(() => {
    void load();
  }, [load]);

  const blocks = (data?.answerBlocks ?? []).filter((block) => block.id && block.imageUrl);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between rounded-lg border border-border-subtle bg-card px-4 py-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
          <ArrowLeft size={16} />返回成绩
        </Button>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{examName || data?.examName || ""}</span>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading} className="gap-1.5">
            <RefreshCw size={16} />刷新
          </Button>
        </div>
      </div>

      {loading && (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      )}

      {!loading && error && <ErrorState description={error} onRetry={() => void load()} retrying={loading} />}

      {!loading && !error && data && (
        <>
          <Card>
            <CardHeader>
              <div>
                <CardTitle>逐题正确答案</CardTitle>
                <CardDescription className="mt-1 text-sm">
                  {data.subject ? `${data.subject} · ` : ""}由老师录入，仅作对照，不判断你的作答
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              {data.answers.length > 0 ? (
                <AnswerTable answers={data.answers} />
              ) : (
                <EmptyState
                  size="sm"
                  icon={<FileText />}
                  title="老师尚未录入逐题答案"
                  description="录入后这里会按题号显示本场考试的正确答案。"
                />
              )}
            </CardContent>
          </Card>

          <div className="flex flex-col gap-4">
            <h2 className="m-0 text-base font-semibold text-foreground">原卷</h2>
            {!data.hasOriginalPaper ? (
              <Card>
                <CardContent>
                  <EmptyState
                    size="sm"
                    icon={<Images />}
                    title="原卷未上传"
                    description="老师还没有上传本场考试的原卷图片，上传后可在此逐页查看。"
                  />
                </CardContent>
              </Card>
            ) : (
              data.pages.map((page) => (
                <Card key={page.pageIndex}>
                  <CardHeader>
                    <div>
                      <CardTitle className="text-base">第 {page.pageIndex} 页</CardTitle>
                      <CardDescription className="mt-1 truncate text-xs">{page.filename}</CardDescription>
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    {page.isImage ? (
                      <PaperImage src={mediaUrl(page.imageUrl)} alt={`原卷第 ${page.pageIndex} 页`} />
                    ) : (
                      <p className="m-0 rounded-md border border-border-subtle bg-secondary px-3 py-2 text-sm text-muted-foreground">
                        该页为 {page.mimeType || "非图片"} 文件，浏览器内可直接点击图片链接查看。
                        <a className="ml-1 text-primary underline-offset-2 hover:underline" href={mediaUrl(page.imageUrl)} target="_blank" rel="noreferrer">打开原文件</a>
                      </p>
                    )}
                    {page.answers.length > 0 && (
                      <div className="rounded-md border border-border-subtle bg-secondary p-3">
                        <p className="m-0 mb-2 text-xs font-medium text-muted-foreground">本页答案</p>
                        <AnswerTable answers={page.answers} />
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))
            )}
          </div>

          {blocks.length > 0 && (
            <div className="flex flex-col gap-4">
              <h2 className="m-0 text-base font-semibold text-foreground">我的作答</h2>
              <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(260px,1fr))] items-start gap-4">
                {blocks.map((block) => (
                  <Card key={block.id}>
                    <CardHeader>
                      <div>
                        <CardTitle className="text-sm">{block.blockTitle || "作答"}</CardTitle>
                        <CardDescription className="mt-1 text-xs">
                          {block.questionNumbers.length > 0 ? `题号 ${block.questionNumbers.join("、")}` : `第 ${block.pageNumber} 页`}
                        </CardDescription>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <PaperImage src={mediaUrl(block.imageUrl)} alt={block.blockTitle || "我的作答"} />
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
