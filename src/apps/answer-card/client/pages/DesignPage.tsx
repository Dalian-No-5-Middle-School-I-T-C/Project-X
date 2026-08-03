// DesignPage — 从 App.tsx 抽出的「答题卡设计」页面（B2：改由 useWorkspace 消费共享状态）。
// 编辑器组件（CardPreview/ObjectiveEditor/SubjectiveEditor）直接由 DesignEditors 导入；
// 不再由 App 透传 props，行为与抽离前完全一致。
// P4-T6：整页迁移到 v2 组件 + Tailwind（三栏工作台：预览区 + inspector）。
import { SquarePen, ListPlus, ArrowUp, ArrowDown, Plus, Trash2 } from "lucide-react";
import { useWorkspace } from "../WorkspaceContext";
import { CardPreview, ObjectiveEditor, SubjectiveEditor } from "./DesignEditors";
import {
  Button,
  ContextItem,
  EmptyState,
  Field,
  Input,
  Panel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/v2";

export function DesignPage() {
  const {
    mode,
    card,
    layout,
    selectedBlockId,
    setSelectedBlockId,
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
  } = useWorkspace();

  const active = mode === "design";
  const selectedBlock = card ? (card.bodyBlocks.find((block) => block.id === selectedBlockId) ?? null) : null;

  return (
    <div className={`flex h-full min-h-0 ${active ? "" : "hidden"}`}>
      {/* 预览区：纸面恒白居中 */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex-1 flex items-center justify-center bg-background p-6 overflow-auto">
          {card && layout ? (
            <CardPreview card={card} layout={layout} />
          ) : (
            <EmptyState
              icon={<SquarePen />}
              title="选择或新建答题卡"
              description="从左侧选择一张答题卡，或新建一张开始设计。"
            />
          )}
        </div>
      </section>

      {/* inspector：基本信息 + 正文题块 + 选中块编辑器 */}
      <aside className="flex w-[360px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-border-subtle bg-card p-4">
        {card ? (
          <>
            <Panel className="flex flex-col gap-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <SquarePen size={16} /> 基本信息
              </div>

              <Field label="标题">
                <Input
                  value={card.title}
                  onChange={(event) => updateCard((draft) => void (draft.title = event.target.value))}
                />
              </Field>

              {card.subjectLabel && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">科目</span>
                  <span className="font-medium text-foreground">{card.subjectLabel}</span>
                </div>
              )}
              {card.examDate && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">考试时间</span>
                  <span className="font-medium text-foreground tabular-nums">{card.examDate}</span>
                </div>
              )}

              <Field label="答题卡纸型">
                <Select
                  value={card.paper?.size ?? "A4"}
                  onValueChange={(value) =>
                    updateCard((draft) => {
                      const size = value as "A4" | "A3";
                      draft.paper = { size, orientation: size === "A3" ? "landscape" : "portrait" };
                    })
                  }
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="A4">A4 纵向</SelectItem>
                    <SelectItem value="A3">A3 横向三版</SelectItem>
                  </SelectContent>
                </Select>
              </Field>

              {card.layoutVersion !== 2 && (
                <div className="rounded-md border border-warning bg-warning-soft p-3 text-sm text-warning-fg">
                  <strong className="mb-1 block">当前使用 V1 兼容排版</strong>
                  <p className="mb-2 text-xs">
                    旧打印件仍按原分数格坐标识别。升级后将使用紧凑分数区和更大的作答空间。
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (!confirm("升级到 V2 后，已经打印的旧答题卡不能再按此卡片的新坐标识别。确认升级并立即重排吗？")) return;
                      updateCard((draft) => void (draft.layoutVersion = 2));
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
                  onChange={(event) =>
                    updateCard((draft) => void (draft.studentInfo.studentNumberDigits = Number(event.target.value)))
                  }
                />
              </Field>

              <Field label="答题卡面">
                <Select
                  value={card.sided ?? "double"}
                  onValueChange={(value) =>
                    updateCard((draft) => void (draft.sided = value as "single" | "double"))
                  }
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="single">单面（仅正面有题）</SelectItem>
                    <SelectItem value="double">双面（正反面均有题）</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </Panel>

            <Panel className="flex flex-col gap-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <ListPlus size={16} /> 正文题块
              </div>
              <div className="flex flex-col gap-1.5">
                {card.bodyBlocks.map((block, index) => (
                  <ContextItem
                    key={block.id}
                    icon={block.type === "objective" ? <SquarePen size={16} /> : <ListPlus size={16} />}
                    title={block.title || "未命名题块"}
                    meta={block.type === "objective" ? "客观题" : subjectiveBlockKindLabel(block)}
                    active={selectedBlockId === block.id}
                    onClick={() => setSelectedBlockId(block.id)}
                    trailing={
                      <div className="flex items-center gap-0.5">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={(event) => {
                            event.stopPropagation();
                            moveBlock(block.id, -1);
                          }}
                          disabled={index === 0}
                          aria-label="上移"
                        >
                          <ArrowUp size={14} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={(event) => {
                            event.stopPropagation();
                            moveBlock(block.id, 1);
                          }}
                          disabled={index === card.bodyBlocks.length - 1}
                          aria-label="下移"
                        >
                          <ArrowDown size={14} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={(event) => {
                            event.stopPropagation();
                            addObjectiveBlock(index);
                          }}
                          aria-label="在后面插入客观题"
                        >
                          <Plus size={14} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={(event) => {
                            event.stopPropagation();
                            removeBlock(block.id);
                          }}
                          aria-label="删除"
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    }
                  />
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => addObjectiveBlock()}>
                  <Plus size={16} /> 客观题块
                </Button>
                <Button variant="outline" size="sm" onClick={addBlankBlock}>
                  <Plus size={16} /> 填空题块
                </Button>
                <Button variant="outline" size="sm" onClick={addSubjectiveBlock}>
                  <Plus size={16} /> 解答题块
                </Button>
                <Button variant="outline" size="sm" onClick={addEssayBlock}>
                  <Plus size={16} /> 作文块
                </Button>
              </div>
            </Panel>

            {selectedBlock && (
              <div className="flex flex-col gap-3">
                {selectedBlock.type === "objective" ? (
                  <ObjectiveEditor block={selectedBlock} onChange={(mutator) => updateBlock(selectedBlock.id, mutator)} />
                ) : (
                  <SubjectiveEditor
                    block={selectedBlock}
                    layoutVersion={card.layoutVersion}
                    onChange={(mutator) => updateBlock(selectedBlock.id, mutator)}
                    onUpload={uploadImage}
                  />
                )}
              </div>
            )}

            {layout?.warnings.length ? (
              <div className="flex flex-col gap-1 rounded-md border border-destructive bg-destructive-soft p-3 text-sm text-destructive-fg">
                {layout.warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <EmptyState icon={<SquarePen />} title="请新建或载入答题卡" />
        )}
      </aside>
    </div>
  );
}
