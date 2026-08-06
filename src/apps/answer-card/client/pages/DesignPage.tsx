// DesignPage — 答题卡设计器（严格按 design/designer-sandbox.html + demo.html 视觉规格）
// 两级流程：select=卡片画廊 / editor=三栏工作台
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  FileDown,
  FileUp,
  ListPlus,
  MoreHorizontal,
  Plus,
  Save,
  SquarePen,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useWorkspace } from "../WorkspaceContext";
import type { ObjectiveBlock, SubjectiveBlock } from "../../../../shared/types";
import type { AnswerCard, LayoutDocument } from "../../../../shared/types";
import { fetchJson } from "../auth/api";
import { cn } from "../lib/utils";
import { CardPreview, ObjectiveEditor, SubjectiveEditor } from "./DesignEditors";
import {
  Button,
  Card,
  CardDescription,
  CardTitle,
  ContextItem,
  ContextPanel,
  ContextPanelBody,
  ContextPanelHeader,
  EmptyState,
  Field,
  Input,
  Panel,
  Select,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from "../components/ui/v2";

function formatDate(d?: string) {
  if (!d) return "";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return d;
  return date.toLocaleDateString("zh-CN");
}

export function DesignPage() {
  const {
    card,
    cards,
    layout,
    selectedBlockId,
    setSelectedBlockId,
    designScreen,
    setDesignScreen,
    loadCard,
    createCard,
    deleteCard,
    saveCard,
    exportPdfForCurrentCard,
    updateCard,
    updateBlock,
    moveBlock,
    removeBlock,
    addObjectiveBlock,
    addSubjectiveBlock,
    addBlankBlock,
    addEssayBlock,
    uploadImage,
    subjectiveBlockKindLabel,
    isBusy,
    autoSaveState,
    autoSaveLabel,
    canDesign,
  } = useWorkspace();

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; cardId: string } | null>(null);

  const selectedBlock = card ? (card.bodyBlocks.find((b) => b.id === selectedBlockId) ?? null) : null;

  const blockSubLabel = (block: typeof selectedBlock) => {
    if (!block) return "";
    if (block.type === "objective") {
      return `${block.questionStart}–${block.questionStart + block.questionCount - 1} 题`;
    }
    return `${block.questions.length} 小题`;
  };

  const enterEditor = async (id: string) => {
    await loadCard(id);
    setDesignScreen("editor");
  };

  const createAndEnter = async () => {
    if (!canDesign) return;
    await createCard({
      title: "未命名答题卡",
      subject: "",
      subjectLabel: "",
      examDate: "",
      examAction: "none",
      paperSize: "A4",
    });
    setDesignScreen("editor");
  };

  const handleDeleteCard = async (id: string) => {
    const item = cards.find((c) => c.id === id);
    const ok = await deleteCard(id);
    if (ok && card?.id === id) {
      setDesignScreen("select");
    }
    if (ok) {
      setCtxMenu(null);
    }
    return ok;
  };

  // ── 选择画廊 ──
  if (designScreen === "select") {
    return (
      <div className="flex h-full flex-col overflow-auto p-6 pt-8">
        {cards.length === 0 ? (
          <EmptyState
            icon={<SquarePen />}
            title="暂无答题卡"
            description="创建第一张答题卡，开始设计你的考试。"
            action={
              <Button variant="primary" size="sm" onClick={createAndEnter} disabled={!canDesign}>
                <Plus size={16} /> 新建答题卡
              </Button>
            }
          />
        ) : (
          <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(228px,1fr))] items-stretch gap-4">
            {cards.map((c) => (
              <Card
                key={c.id}
                interactive
                className="flex h-[248px] cursor-pointer flex-col overflow-hidden"
                onClick={() => void enterEditor(c.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtxMenu({ x: e.clientX, y: e.clientY, cardId: c.id });
                }}
              >
                <CardThumbnail cardId={c.id} />
                <div className="flex h-[68px] shrink-0 flex-col justify-center gap-1 overflow-hidden px-3 py-2.5">
                  <CardTitle className="truncate text-sm" title={c.title}>{c.title}</CardTitle>
                  <CardDescription className="truncate text-xs">
                    {c.subjectLabel || "未设科目"} · {formatDate(c.examDate)}
                  </CardDescription>
                </div>
              </Card>
            ))}
            <button
              type="button"
              onClick={createAndEnter}
              disabled={!canDesign}
              className={cn(
                "flex h-[248px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border-strong bg-card text-sm text-muted-foreground",
                "transition-colors duration-(--px-dur-1) hover:border-primary hover:text-accent-foreground",
                "disabled:opacity-50",
              )}
            >
              <span className="text-3xl font-light leading-none">+</span>
              <span>新建答题卡</span>
            </button>
          </div>
        )}

        {ctxMenu && (
          <>
            <div
              className="fixed inset-0 z-(--px-z-modal)"
              onClick={() => setCtxMenu(null)}
            />
            <div
              className="fixed z-[calc(var(--px-z-modal)+1)] min-w-[120px] overflow-hidden rounded-md border border-border-subtle bg-popover py-1 shadow-3"
              // 动态值：右键菜单出现位置 = 鼠标坐标，无法用工具类表达
              style={{ left: ctxMenu.x, top: ctxMenu.y }}
            >
              <button
                type="button"
                className="w-full px-3 py-1.5 text-left text-sm text-foreground hover:bg-secondary"
                onClick={() => {
                  void enterEditor(ctxMenu.cardId);
                  setCtxMenu(null);
                }}
              >
                编辑
              </button>
              <button
                type="button"
                className="w-full px-3 py-1.5 text-left text-sm text-destructive-fg hover:bg-destructive-soft"
                onClick={() => {
                  const item = cards.find((c) => c.id === ctxMenu.cardId);
                  if (confirm(`确定删除「${item?.title ?? ctxMenu.cardId}」？此操作不可撤销。`)) {
                    void handleDeleteCard(ctxMenu.cardId);
                  }
                }}
              >
                删除
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  // ── 编辑器 ──
  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ContextPanel: 题块列表 */}
      <div className="flex min-h-0 flex-1">
        <ContextPanel>
          <ContextPanelHeader>
            <span className="text-sm font-semibold text-foreground">正文题块</span>
            <span className="text-xs tabular-nums text-muted-foreground">{card?.bodyBlocks.length ?? 0} 块</span>
          </ContextPanelHeader>
          <ContextPanelBody>
            {card?.bodyBlocks.length ? (
              card.bodyBlocks.map((block, idx) => (
                <ContextItem
                  key={block.id}
                  active={selectedBlockId === block.id}
                  title={block.title || "未命名块"}
                  meta={`${block.type === "objective" ? "客观题" : subjectiveBlockKindLabel(block as never)} · ${blockSubLabel(block)}`}
                  onClick={() => setSelectedBlockId(block.id)}
                  trailing={
                    <span className="flex items-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="上移"
                        disabled={idx === 0}
                        onClick={(e) => {
                          e.stopPropagation();
                          moveBlock(block.id, -1);
                        }}
                      >
                        <ArrowUp size={14} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="下移"
                        disabled={idx === (card?.bodyBlocks.length ?? 0) - 1}
                        onClick={(e) => {
                          e.stopPropagation();
                          moveBlock(block.id, 1);
                        }}
                      >
                        <ArrowDown size={14} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="在后面插入客观题"
                        onClick={(e) => {
                          e.stopPropagation();
                          addObjectiveBlock(idx);
                        }}
                      >
                        <Plus size={14} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="删除块"
                        className="text-destructive-fg hover:bg-destructive-soft"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`确定删除「${block.title || block.id}」？`)) {
                            removeBlock(block.id);
                          }
                        }}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </span>
                  }
                />
              ))
            ) : (
              <EmptyState size="sm" icon={<ListPlus />} title="暂无题块" description="点击下方按钮添加第一个题块。" />
            )}

            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button variant="outline" size="sm" onClick={() => addObjectiveBlock()}>
                客观题块
              </Button>
              <Button variant="outline" size="sm" onClick={() => addBlankBlock()}>
                填空题块
              </Button>
              <Button variant="outline" size="sm" onClick={() => addSubjectiveBlock()}>
                解答题块
              </Button>
              <Button variant="outline" size="sm" onClick={() => addEssayBlock()}>
                作文块
              </Button>
            </div>
          </ContextPanelBody>
        </ContextPanel>

        {/* Canvas */}
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
          {layout?.warnings.length ? (
            <div className="mx-4 mt-3 rounded-md border border-warning-border bg-warning-soft p-2.5 text-xs text-warning-fg">
              {layout.warnings.map((w, i) => (
                <p key={i} className="m-0 flex items-start gap-1.5">
                  <TriangleAlert size={12} className="mt-0.5 shrink-0" aria-hidden />
                  {w}
                </p>
              ))}
            </div>
          ) : null}

          <div className="flex min-h-0 flex-1 flex-col items-center gap-6 overflow-auto p-6">
            {card && layout ? (
              <div className="flex w-full flex-col items-center gap-6">
                <CardPreview card={card} layout={layout} />
              </div>
            ) : (
              <EmptyState
                icon={<SquarePen />}
                title="选择或新建答题卡"
                description="从左侧列表选择答题卡，或返回卡片列表新建。"
                action={
                  <Button variant="outline" size="sm" onClick={() => setDesignScreen("select")}>
                    <ArrowLeft size={16} /> 卡片列表
                  </Button>
                }
              />
            )}
          </div>
        </section>

        {/* Inspector */}
        <aside className="flex w-[300px] shrink-0 flex-col overflow-hidden border-l border-border-subtle bg-card">
          {card ? (
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
              <BasicInfoPanel card={card} updateCard={updateCard} />
              {selectedBlock && (
                <Panel>
                  <div className="border-b border-border-subtle px-3 py-2.5 text-sm font-semibold text-foreground">
                    选中块设置
                  </div>
                  <div className="flex flex-col gap-3 p-3">
                    {selectedBlock.type === "objective" ? (
                      <ObjectiveEditor
                        block={selectedBlock as ObjectiveBlock}
                        onChange={(mutator) => updateBlock(selectedBlock.id, mutator)}
                      />
                    ) : (
                      <SubjectiveEditor
                        block={selectedBlock as SubjectiveBlock}
                        layoutVersion={(card.layoutVersion ?? 1) as 1 | 2}
                        onChange={(mutator) => updateBlock(selectedBlock.id, mutator)}
                        onUpload={uploadImage}
                      />
                    )}
                  </div>
                </Panel>
              )}
              {layout && layout.warnings.length > 0 && (
                <Panel>
                  <details className="group" open>
                    <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-sm font-semibold text-foreground">
                      排版警告
                      <span className="text-muted-foreground transition-transform group-open:rotate-90">▶</span>
                    </summary>
                    <div className="flex flex-col gap-2 p-3 pt-0">
                      {layout.warnings.map((w, i) => (
                        <div key={i} className="rounded-md border border-warning-border bg-warning-soft p-2 text-xs text-warning-fg">
                          {w}
                        </div>
                      ))}
                    </div>
                  </details>
                </Panel>
              )}
            </div>
          ) : (
            <EmptyState
              size="sm"
              icon={<SquarePen />}
              title="请新建或载入答题卡"
              description="选择一张答题卡后开始编辑。"
            />
          )}
        </aside>
      </div>
    </div>
  );
}

function CardThumbnail({ cardId }: { cardId: string }) {
  const [data, setData] = useState<{ card: AnswerCard; layout: LayoutDocument } | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([
      fetchJson<AnswerCard>(`/api/cards/${encodeURIComponent(cardId)}`),
      fetchJson<LayoutDocument>(`/api/cards/${encodeURIComponent(cardId)}/layout`),
    ]).then(([card, layout]) => {
      if (active) setData({ card, layout });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [cardId]);

  return (
    <div className="flex h-[180px] shrink-0 items-center justify-center overflow-hidden border-b border-border-subtle bg-muted">
      {data ? <CardPreview card={data.card} layout={data.layout} firstPageOnly /> : <span className="self-center text-xs text-muted-foreground">正在生成预览</span>}
    </div>
  );
}

function BasicInfoPanel({
  card,
  updateCard,
}: {
  card: NonNullable<ReturnType<typeof useWorkspace>["card"]>;
  updateCard: ReturnType<typeof useWorkspace>["updateCard"];
}) {
  return (
    <Panel>
      <div className="border-b border-border-subtle px-3 py-2.5 text-sm font-semibold text-foreground">基本信息</div>
      <div className="flex flex-col gap-3 p-3">
        <Field label="标题">
          <Input value={card.title} onChange={(e) => updateCard((d) => void (d.title = e.target.value))} />
        </Field>
        {card.subjectLabel && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-secondary-foreground">科目</span>
            <span className="font-semibold text-foreground">{card.subjectLabel}</span>
          </div>
        )}
        {card.examDate && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-secondary-foreground">考试时间</span>
            <span className="font-semibold text-foreground">{card.examDate}</span>
          </div>
        )}
        <Field label="答题卡纸型">
          <Select
            value={card.paper?.size ?? "A4"}
            onValueChange={(value) =>
              updateCard((d) => {
                const size = value as "A4" | "A3";
                d.paper = { size, orientation: size === "A3" ? "landscape" : "portrait" };
              })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="A4">A4 纵向</SelectItem>
              <SelectItem value="A3">A3 横向三版</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {card.layoutVersion !== 2 && (
          <div className="rounded-md border border-info-border bg-info-soft p-2.5 text-xs text-info-fg">
            <strong className="block text-sm font-semibold">当前使用 V1 兼容排版</strong>
            <p className="mt-1">旧打印件仍按原分数格坐标识别。升级后将使用紧凑分数区和更大的作答空间。</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => {
                if (confirm("升级到 V2 后，已经打印的旧答题卡不能再按此卡片的新坐标识别。确认升级并立即重排吗？")) {
                  updateCard((d) => void (d.layoutVersion = 2));
                }
              }}
            >
              升级到紧凑排版 V2
            </Button>
          </div>
        )}
        <Field label="学号位数">
          <Input
            type="number"
            min={1}
            max={12}
            value={card.studentInfo.studentNumberDigits}
            onChange={(e) =>
              updateCard((d) => void (d.studentInfo.studentNumberDigits = Number(e.target.value)))
            }
          />
        </Field>
        <Field label="答题卡面">
          <Select
            value={card.sided ?? "double"}
            onValueChange={(value) => updateCard((d) => void (d.sided = value as "single" | "double"))}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="single">单面（仅正面有题）</SelectItem>
              <SelectItem value="double">双面（正反面均有题）</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
    </Panel>
  );
}

function BlockListPanel({
  card,
  selectedBlockId,
  onSelect,
}: {
  card: NonNullable<ReturnType<typeof useWorkspace>["card"]>;
  selectedBlockId: string | null;
  onSelect: (id: string) => void;
}) {
  const { subjectiveBlockKindLabel } = useWorkspace();
  return (
    <Panel>
      <div className="border-b border-border-subtle px-3 py-2.5 text-sm font-semibold text-foreground">正文题块</div>
      <div className="flex flex-col gap-2 p-3">
        {card.bodyBlocks.length === 0 ? (
          <span className="text-center text-sm text-muted-foreground">暂无题块</span>
        ) : (
          card.bodyBlocks.map((block) => (
            <ContextItem
              key={block.id}
              active={selectedBlockId === block.id}
              title={block.title || "未命名块"}
              meta={block.type === "objective" ? "客观题" : subjectiveBlockKindLabel(block as never)}
              onClick={() => onSelect(block.id)}
            />
          ))
        )}
      </div>
    </Panel>
  );
}
