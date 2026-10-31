import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Download, ExternalLink, FileText, Images, RefreshCw } from "lucide-react";
import { fetchJson, mediaUrl } from "../auth/api";
import { downloadBlob } from "../util/download";
import { retryMediaTicketImage } from "../lib/mediaTicketRetry";
import { RotatedCardImage, RotationButtons, type ImageRotation } from "./RotatedCardImage";
import type { AnswerBlockCrop } from "../../../../shared/types";
import {
  ANSWER_KEY_MODE_FILE,
  normalizeAnswerKeyMode,
  type AnswerKeyMode,
} from "../../../../shared/answerKeyMode";
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
 * StudentExamPaper —— v54 学生端「查看原卷 / 查看答案解析」
 *
 * 口径与小程序一致：
 *  · 可见性由后端判定（成绩已公布 + 显示原卷或答案直发），前端不再自行推断；
 *  · v66：答案按 exams.answer_key_mode 二选一渲染 —— 'text' 看逐题文字表，
 *    'file' 看老师上传的答案文件本身（图片内联，PDF/DOCX 由浏览器打开或下载）；
 *  · 只渲染下发内容，不判对错、不比对本人作答；
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

/** 答案原文件（直发模式）：fileUrl 只含页码，文件名由后端从库里解析 */
type AnswerFile = {
  pageIndex: number;
  filename: string;
  mimeType: string;
  isImage: boolean;
  fileUrl: string;
};

type PaperPayload = {
  examId: number;
  examName: string | null;
  subject: string | null;
  answerKeyMode?: AnswerKeyMode;
  hasOriginalPaper: boolean;
  showOriginalPaper?: 0 | 1;
  pages: PaperPage[];
  answers: PaperAnswer[];
  answerFiles?: AnswerFile[];
  answerBlocks?: AnswerBlockCrop[];
};

interface Props {
  examId: number;
  examName: string;
  onBack: () => void;
}

/** 原卷页图片：加载失败时不留破图，也不谎报成功 */
function PaperImage({ src, alt, rotation }: { src: string; alt: string; rotation: ImageRotation }) {
  const [resolvedSrc, setResolvedSrc] = useState(src);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setResolvedSrc(src);
    setFailed(false);
  }, [src]);
  if (failed) {
    return (
      <div className="flex h-40 items-center justify-center rounded-md border border-border-subtle bg-secondary text-sm text-muted-foreground">
        该页图片加载失败，可点右上角刷新重试
      </div>
    );
  }
  return (
    <RotatedCardImage
      src={resolvedSrc}
      alt={alt}
      rotation={rotation}
      loading="lazy"
      onError={(event) => {
        // 票据被服务端淘汰时先静默重签一次；新地址写回状态，旋转后的 SVG 也用它
        if (retryMediaTicketImage(event.currentTarget, setResolvedSrc)) return;
        setFailed(true);
      }}
      className="rounded-md border border-border-subtle bg-card"
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

/**
 * 直发模式的一页答案文件：图片直接内联渲染，PDF/DOCX 交给浏览器打开或下载。
 * 不做预览器 —— 后端对 DOCX 发的是 attachment，PDF 在新标签页里由浏览器原生渲染，
 * 两条路都比在页面里嵌 iframe 少一层 CSP / 跨源凭据的不确定性。
 * rotation 与整卷共用：老师直发的多为扫描件，横竖放歪的可能性和原卷一样，
 * 右上角的旋转按钮不该只对原卷生效。
 */
function AnswerFileCard({ file, rotation }: { file: AnswerFile; rotation: ImageRotation }) {
  const url = mediaUrl(file.fileUrl);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  async function saveFile() {
    setDownloadError("");
    setDownloading(true);
    try {
      // 跨源 API 时浏览器会忽略 <a download>，PDF 会把当前页导航走。
      // 用带 cookie / Bearer 的 blob 下载，同源和跨源都落成本机文件。
      await downloadBlob(file.fileUrl, file.filename);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : "下载失败");
    } finally {
      setDownloading(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle className="text-base">答案第 {file.pageIndex} 页</CardTitle>
          <CardDescription className="mt-1 truncate text-xs">{file.filename}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {file.isImage ? (
          <PaperImage src={url} alt={`答案第 ${file.pageIndex} 页`} rotation={rotation} />
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border-subtle bg-secondary px-3 py-2.5">
            <span className="min-w-0 truncate text-sm text-foreground">
              {file.mimeType || "文件"} · 老师上传的原样
            </span>
            <span className="flex shrink-0 gap-2">
              {/* asChild 下 Button 不注入 icon 包装，图标要写在子元素里 */}
              <Button size="sm" variant="outline" asChild>
                <a href={url} target="_blank" rel="noreferrer"><ExternalLink size={16} />打开</a>
              </Button>
              <Button size="sm" variant="ghost" type="button" disabled={downloading} onClick={() => void saveFile()}>
                <Download size={16} />下载
              </Button>
            </span>
          </div>
        )}
        {downloadError && <p className="m-0 text-sm text-destructive-fg">{downloadError}</p>}
      </CardContent>
    </Card>
  );
}

export function StudentExamPaper({ examId, examName, onBack }: Props) {
  const [data, setData] = useState<PaperPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [rotation, setRotation] = useState<ImageRotation>(0);

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
  // 下发哪一套数据由后端 answerKeyMode 决定，前端只按它排版；字段缺失（旧后端响应）退回文字模式
  const fileMode = normalizeAnswerKeyMode(data?.answerKeyMode) === ANSWER_KEY_MODE_FILE;
  const answerFiles = data?.answerFiles ?? [];
  // v66 之前没有 showOriginalPaper 字段，当时能看到这一页就意味着原卷是开的，故缺省按「开」处理
  const paperOpen = data ? data.showOriginalPaper !== 0 : false;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between rounded-lg border border-border-subtle bg-card px-4 py-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
          <ArrowLeft size={16} />返回成绩
        </Button>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{examName || data?.examName || ""}</span>
          <RotationButtons size="icon-sm" variant="ghost" rotation={rotation} onChange={setRotation} />
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
          {fileMode ? (
            <div className="flex flex-col gap-4">
              <h2 className="m-0 text-base font-semibold text-foreground">正确答案</h2>
              <p className="m-0 text-sm text-muted-foreground">
                {data.subject ? `${data.subject} · ` : ""}老师直接下发的答案文件，排版与原答案一致；供学习参考
              </p>
              {answerFiles.length === 0 ? (
                <Card>
                  <CardContent>
                    <EmptyState
                      size="sm"
                      icon={<FileText />}
                      title="答案文件尚未上传"
                      description="老师还没有上传本场考试的答案文件，上传后可在此直接查看。"
                    />
                  </CardContent>
                </Card>
              ) : (
                answerFiles.map((file) => <AnswerFileCard key={file.pageIndex} file={file} rotation={rotation} />)
              )}
            </div>
          ) : (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>逐题正确答案</CardTitle>
                  <CardDescription className="mt-1 text-sm">
                    {data.subject ? `${data.subject} · ` : ""}由老师录入，供学习参考
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
          )}

          {paperOpen && (
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
                        <PaperImage src={mediaUrl(page.imageUrl)} alt={`原卷第 ${page.pageIndex} 页`} rotation={rotation} />
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
          )}

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
                      <PaperImage src={mediaUrl(block.imageUrl)} alt={block.blockTitle || "我的作答"} rotation={rotation} />
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
