// DesignEditors.tsx —— 答题卡设计器的三个编辑器与 SVG 预览子组件。
// 从 App.tsx 抽出（B1），仅依赖 cardModel（设计 helper）与 props，行为不变。
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  BookOpen,
  Check,
  ChevronDown,
  ClipboardCheck,
  ClipboardList,
  Copy,
  Download,
  FileDown,
  FileUp,
  FolderOpen,
  Home,
  ImagePlus,
  Layers,
  ListPlus,
  Plus,
  RotateCcw,
  Save,
  Search,
  SquarePen,
  Trash2,
  Upload,
  Users,
  X
} from "lucide-react";
import {
  Badge,
  Button,
  Field,
  Input,
  Panel,
  SegmentedControl,
  Select,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from "../components/ui/v2";
import { apiUrl, authFetch, fetchJson, mediaUrl, urlWithToken } from "../auth/api";
import { cn } from "../lib/utils";
import type {
  AnswerCard,
  BlankItem,
  BlankLabelStyle,
  BodyBlock,
  LayoutDocument,
  ObjectiveBlock,
  ObjectiveMode,
  ObjectiveOptionLayout,
  PageRenderBlock,
  SubjectiveBlock,
  SubjectiveKind,
  SubjectiveQuestion,
  SubjectiveStyle
} from "../../../../shared/types";
import {
  normalizeObjectiveAnswerKey,
  normalizeObjectiveQuestions,
  objectiveQuestionDefinitions,
  objectiveQuestionNumbers,
  optionLabelsForQuestion
} from "../../../../shared/grading";
import { createBlockId } from "../../../../shared/defaultCard";
import { ESSAY_DEFAULT_LINE_COLOR, ESSAY_GRID_INSET_X, essayGridGeometry, essayWordScaleMarks } from "../../../../shared/essayGrid";
import { formatBlankLabel } from "../../../../shared/blankLabels";
import { shouldRenderScoreGrid } from "../../../../shared/scoreGrid";
import {
  answerBlankItems,
  answerLineCount,
  answerText,
  blankLabelStyleLabels,
  cloneCard,
  defaultAnswerBlankQuestion,
  defaultBlankQuestion,
  defaultEssayBlock,
  defaultObjective,
  defaultSubjective,
  findNextQuestionNumber,
  heightForAnswerLines,
  kindLabels,
  modeLabels,
  numericQuestionValue,
  optionLayoutLabels,
  styleLabels,
  subjectiveBlockKind,
  subjectiveBlockKindLabel,
  type PreviewMode,
  PREVIEW_MAX_PERCENT,
  PREVIEW_MIN_PERCENT,
  PREVIEW_SETTINGS_KEY
} from "../cardModel";

export function ObjectiveEditor({ block, onChange }: { block: ObjectiveBlock; onChange: (mutator: (block: BodyBlock) => void) => void }) {
  const questions = objectiveQuestionNumbers(block);
  const questionConfigs = objectiveQuestionDefinitions(block);
  const answerKey = normalizeObjectiveAnswerKey(block);
  const missingAnswerCount = questions.filter((questionNumber) => !answerKey[questionNumber]?.length).length;
  const [showPerQuestion, setShowPerQuestion] = useState(false);  // v1.4.7: 默认折叠每题配置

  function toggleAnswer(questionNumber: number, option: string) {
    onChange((draft) => {
      const objective = draft as ObjectiveBlock;
      objective.questions = normalizeObjectiveQuestions(objective);
      const config = objective.questions.find((item) => item.questionNumber === questionNumber);
      const current = new Set(config?.answerKey ?? objective.answerKey?.[questionNumber] ?? []);
      if ((config?.mode ?? objective.mode) === "single") {
        if (config) config.answerKey = current.has(option) ? [] : [option];
      } else {
        if (current.has(option)) {
          current.delete(option);
        } else {
          current.add(option);
        }
        if (config) config.answerKey = Array.from(current).sort();
      }
      if (config?.answerKey?.length === 0) {
        delete config.answerKey;
      }
      objective.answerKey = normalizeObjectiveAnswerKey(objective);
    });
  }

  function updateQuestionConfig(questionNumber: number, mutator: (question: NonNullable<ObjectiveBlock["questions"]>[number]) => void) {
    onChange((draft) => {
      const objective = draft as ObjectiveBlock;
      objective.questions = normalizeObjectiveQuestions(objective);
      const question = objective.questions.find((item) => item.questionNumber === questionNumber);
      if (!question) return;
      mutator(question);
      if (question.mode === "single" && question.answerKey && question.answerKey.length > 1) {
        question.answerKey = [question.answerKey[0]];
      }
      objective.answerKey = normalizeObjectiveAnswerKey(objective);
      const first = objective.questions[0];
      objective.questionStart = first?.questionNumber ?? objective.questionStart;
      objective.questionCount = objective.questions.length;
    });
  }

  function defaultQuestionScoringRule() {
    return {
      type: "per_selected_count" as const,
      partialScores: {},
      wrongOrExtraScore: 0
    };
  }

  function scoringRuleFor(question: (typeof questionConfigs)[number]) {
    return question.scoringRule ?? defaultQuestionScoringRule();
  }

  function updateScoringRule(questionNumber: number, mutator: (rule: any) => any) {
    updateQuestionConfig(questionNumber, (draft) => {
      const current = draft.scoringRule ?? defaultQuestionScoringRule();
      draft.scoringRule = mutator(JSON.parse(JSON.stringify(current)));
    });
  }

  function setScoringRuleType(questionNumber: number, type: "per_selected_count" | "by_correct_count" | "fixed_partial") {
    updateScoringRule(questionNumber, (rule) => {
      const common = {
        wrongOrExtraScore: Number(rule.wrongOrExtraScore ?? 0),
        allowWrongOptions: rule.allowWrongOptions === true
      };
      if (type === "fixed_partial") return { type, partialScore: 0, ...common };
      if (type === "by_correct_count") return { type, partialScoresByCorrectCount: {}, ...common };
      return { type, partialScores: {}, ...common };
    });
  }

  function updateWrongOrExtraScore(questionNumber: number, value: number) {
    updateScoringRule(questionNumber, (rule) => ({ ...rule, wrongOrExtraScore: value }));
  }

  function updateAllowWrongOptions(questionNumber: number, checked: boolean) {
    updateScoringRule(questionNumber, (rule) => ({ ...rule, allowWrongOptions: checked }));
  }

  function updateFixedPartialScore(questionNumber: number, value: number) {
    updateScoringRule(questionNumber, (rule) => ({ ...rule, type: "fixed_partial", partialScore: value }));
  }

  function updatePerSelectedScore(questionNumber: number, selectedCount: number, value: number) {
    updateScoringRule(questionNumber, (rule) => ({
      ...rule,
      type: "per_selected_count",
      partialScores: { ...(rule.partialScores ?? {}), [selectedCount]: value }
    }));
  }

  function updateByCorrectCountScore(questionNumber: number, correctCount: number, selectedCount: number, value: number) {
    updateScoringRule(questionNumber, (rule) => ({
      ...rule,
      type: "by_correct_count",
      partialScoresByCorrectCount: {
        ...(rule.partialScoresByCorrectCount ?? {}),
        [correctCount]: {
          ...(rule.partialScoresByCorrectCount?.[correctCount] ?? {}),
          [selectedCount]: value
        }
      }
    }));
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="text-sm font-semibold text-foreground">客观题机器阅卷块</div>
      <Field label="标题">
        <Input value={block.title} onChange={(event) => onChange((draft) => void (draft.title = event.target.value))} />
      </Field>

      <Panel className="gap-2 p-3">
        <div className="flex items-center justify-between text-xs">
          <strong>标准答案</strong>
          <span className="text-muted-foreground">{missingAnswerCount === 0 ? "已全部配置" : `${missingAnswerCount} 题未配置`}</span>
        </div>
        <div className="flex flex-col gap-1.5">
          {questions.map((questionNumber) => (
            <div className="grid grid-cols-[22px_1fr] items-center gap-2" key={questionNumber}>
              <span className="text-center text-xs font-semibold tabular-nums text-foreground">{questionNumber}</span>
              <div className="flex flex-wrap gap-1">
                {optionLabelsForQuestion(block, questionNumber).map((option) => {
                  const active = answerKey[questionNumber]?.includes(option) ?? false;
                  return (
                    <Button
                      key={option}
                      type="button"
                      variant={active ? "primary" : "outline"}
                      size="icon-sm"
                      aria-label={`第 ${questionNumber} 题 ${option} 选项`}
                      onClick={() => toggleAnswer(questionNumber, option)}
                      className="text-xs"
                    >
                      {option}
                    </Button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <div className="grid grid-cols-2 gap-3">
        <Field label="起始题号">
          <Input
            type="number"
            min={1}
            value={block.questionStart}
            onChange={(event) =>
              onChange((draft) => {
                const objective = draft as ObjectiveBlock;
                objective.questionStart = Number(event.target.value);
                objective.answerKey = normalizeObjectiveAnswerKey(objective);
              })
            }
          />
        </Field>
        <Field label="题目数">
          <Input
            type="number"
            min={1}
            max={120}
            value={block.questionCount}
            onChange={(event) =>
              onChange((draft) => {
                const objective = draft as ObjectiveBlock;
                const nextCount = Math.max(1, Math.min(120, Number(event.target.value) || 1));
                objective.questionCount = nextCount;
                if (objective.questions && objective.questions.length > 0) {
                  const normalized = normalizeObjectiveQuestions(objective);
                  if (normalized.length !== nextCount) {
                    if (normalized.length > nextCount) {
                      objective.questions = normalized.slice(0, nextCount);
                    } else {
                      const toAdd = nextCount - normalized.length;
                      const startNum = (objective.questionStart ?? 1) + normalized.length;
                      for (let i = 0; i < toAdd; i++) {
                        normalized.push({
                          questionNumber: startNum + i,
                          mode: objective.mode,
                          optionCount: objective.optionCount,
                          score: objective.scorePerQuestion,
                        });
                      }
                      objective.questions = normalized;
                    }
                  } else {
                    objective.questions = normalized;
                  }
                }
                objective.answerKey = normalizeObjectiveAnswerKey(objective);
              })
            }
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="选项数">
          <Input
            type="number"
            min={2}
            max={8}
            value={block.optionCount}
            onChange={(event) =>
              onChange((draft) => {
                const objective = draft as ObjectiveBlock;
                objective.optionCount = Number(event.target.value);
                objective.questions = normalizeObjectiveQuestions(objective);
                for (const q of objective.questions) {
                  q.optionCount = objective.optionCount;
                }
                objective.answerKey = normalizeObjectiveAnswerKey(objective);
              })
            }
          />
        </Field>
        <Field label="每题分值">
          <Input
            type="number"
            min={0}
            step={0.5}
            value={block.scorePerQuestion}
            onChange={(event) => onChange((draft) => void ((draft as ObjectiveBlock).scorePerQuestion = Number(event.target.value)))}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="题型">
          <Select value={block.mode} onValueChange={(value) => onChange((draft) => {
            const objective = draft as ObjectiveBlock;
            objective.mode = value as ObjectiveMode;
            objective.questions = normalizeObjectiveQuestions(objective);
            for (const q of objective.questions) {
              q.mode = objective.mode;
              if (objective.mode !== "multiple" && objective.mode !== "indefinite") {
                delete q.scoringRule;
              }
            }
            objective.answerKey = normalizeObjectiveAnswerKey(objective);
          })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(modeLabels).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="选项排列">
          <Select value={block.optionLayout ?? "horizontal"} onValueChange={(value) => onChange((draft) => { (draft as ObjectiveBlock).optionLayout = value as ObjectiveOptionLayout; })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(optionLayoutLabels).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="少选1项得分">
          <Input
            type="number"
            step={0.5}
            value={block.multipleScoring?.partialScores[1] ?? 0}
            onChange={(event) =>
              onChange((draft) => {
                const objective = draft as ObjectiveBlock;
                objective.multipleScoring ??= { partialScores: {}, wrongOrExtraScore: 0 };
                objective.multipleScoring.partialScores[1] = Number(event.target.value);
              })
            }
          />
        </Field>
        <Field label="多选/错选得分">
          <Input
            type="number"
            step={0.5}
            value={block.multipleScoring?.wrongOrExtraScore ?? 0}
            onChange={(event) =>
              onChange((draft) => {
                const objective = draft as ObjectiveBlock;
                objective.multipleScoring ??= { partialScores: {}, wrongOrExtraScore: 0 };
                objective.multipleScoring.wrongOrExtraScore = Number(event.target.value);
              })
            }
          />
        </Field>
      </div>

      <Button variant="ghost" size="sm" onClick={() => setShowPerQuestion(!showPerQuestion)}>
        {showPerQuestion ? "▲ 收起每题配置" : "▼ 展开每题配置"}
      </Button>

      {showPerQuestion && (
        <Panel className="gap-2 p-3">
          <div className="flex items-center justify-between text-xs">
            <strong>每题配置</strong>
            <span className="text-muted-foreground">可混排单选、多选、不定项</span>
          </div>
          <div className="flex flex-col gap-3">
            {questionConfigs.map((question) => (
              <Panel key={question.questionNumber} className="gap-2 p-3">
                <div className="text-xs font-semibold text-foreground">第 {question.questionNumber} 题</div>
                <div className="grid grid-cols-3 gap-2">
                  <Field label="题号">
                    <Input type="number" min={1} value={question.questionNumber} onChange={(event) => updateQuestionConfig(question.questionNumber, (draft) => void (draft.questionNumber = Number(event.target.value)))} />
                  </Field>
                  <Field label="题型">
                    <Select value={question.mode} onValueChange={(value) => updateQuestionConfig(question.questionNumber, (draft) => { draft.mode = value as ObjectiveMode; if (draft.mode === "single") draft.scoringRule = undefined; })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Object.entries(modeLabels).map(([v, l]) => (<SelectItem key={v} value={v}>{l}</SelectItem>))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="选项数">
                    <Input type="number" min={2} max={8} value={question.optionCount} onChange={(event) => updateQuestionConfig(question.questionNumber, (draft) => void (draft.optionCount = Number(event.target.value)))} />
                  </Field>
                </div>
                <Field label="分值">
                  <Input type="number" min={0} step={0.5} value={question.score} onChange={(event) => updateQuestionConfig(question.questionNumber, (draft) => void (draft.score = Number(event.target.value)))} />
                </Field>
                {question.mode !== "single" && (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="少选计分方式">
                        <Select value={scoringRuleFor(question).type} onValueChange={(value) => setScoringRuleType(question.questionNumber, value as "per_selected_count" | "by_correct_count" | "fixed_partial")}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="per_selected_count">按选对项数给分</SelectItem>
                            <SelectItem value="by_correct_count">按正确答案数量给分</SelectItem>
                            <SelectItem value="fixed_partial">少选固定分</SelectItem>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field label="错选/多选/不选得分">
                        <Input type="number" step={0.5} value={(scoringRuleFor(question) as any).wrongOrExtraScore ?? 0} onChange={(event) => updateWrongOrExtraScore(question.questionNumber, Number(event.target.value))} />
                      </Field>
                    </div>
                    {scoringRuleFor(question).type === "fixed_partial" ? (
                      <Field label="少选固定得分">
                        <Input type="number" step={0.5} value={(scoringRuleFor(question) as any).partialScore ?? 0} onChange={(event) => updateFixedPartialScore(question.questionNumber, Number(event.target.value))} />
                      </Field>
                    ) : scoringRuleFor(question).type === "by_correct_count" ? (
                      <div className="flex flex-col gap-2">
                        <span className="text-xs text-muted-foreground">根据标准答案个数，设置少选时选对几项得几分</span>
                        {Array.from({ length: Math.max(0, question.optionCount - 1) }, (_, index) => index + 2).map((correctCount) => (
                          <div key={correctCount} className="grid grid-cols-[84px_1fr] items-center gap-2">
                            <span className="text-xs text-secondary-foreground">{correctCount} 个答案</span>
                            <div className="grid grid-cols-3 gap-2">
                              {Array.from({ length: correctCount - 1 }, (_, index) => index + 1).map((selectedCount) => (
                                <Field key={selectedCount} label={`${selectedCount} 项对`}>
                                  <Input type="number" step={0.5} value={(scoringRuleFor(question) as any).partialScoresByCorrectCount?.[correctCount]?.[selectedCount] ?? 0} onChange={(event) => updateByCorrectCountScore(question.questionNumber, correctCount, selectedCount, Number(event.target.value))} />
                                </Field>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="grid grid-cols-3 gap-2">
                        {Array.from({ length: Math.max(1, question.optionCount - 1) }, (_, index) => index + 1).map((selectedCount) => (
                          <Field key={selectedCount} label={`选对 ${selectedCount} 项`}>
                            <Input type="number" step={0.5} value={(scoringRuleFor(question) as any).partialScores?.[selectedCount] ?? 0} onChange={(event) => updatePerSelectedScore(question.questionNumber, selectedCount, Number(event.target.value))} />
                          </Field>
                        ))}
                      </div>
                    )}
                    <label className="flex items-center gap-2 text-xs text-secondary-foreground">
                      <input
                        type="checkbox"
                        checked={(scoringRuleFor(question) as any).allowWrongOptions === true}
                        onChange={(event) => updateAllowWrongOptions(question.questionNumber, event.target.checked)}
                      />
                      错选但未超过正确答案数时，只按选对项给分
                    </label>
                  </>
                )}
              </Panel>
            ))}
          </div>
        </Panel>
      )}

      <p className="rounded-md bg-secondary p-2.5 text-xs text-muted-foreground">
        横向模式少于 15 题按行排列、15 题及以上按 5 题小组网格排列；竖向模式按高考 AB 卡式 4 题一组纵向排布，每题选项仍保持横向小组选项；选项竖排模式下每题的 A/B/C/D 在题号下方纵向堆叠。超过 5 个选项的题目独占一行。
      </p>
    </div>
  );}

export function SubjectiveEditor({
  block,
  layoutVersion,
  onChange,
  onUpload
}: {
  block: SubjectiveBlock;
  layoutVersion: 1 | 2;
  onChange: (mutator: (block: BodyBlock) => void) => void;
  onUpload: (blockId: string, questionId: string, file: File) => Promise<void>;
}) {
  const isFillBlankBlock = subjectiveBlockKind(block) === "fill_blank";
  const isEssayBlock = subjectiveBlockKind(block) === "essay";

  function updateQuestion(questionId: string, mutator: (question: SubjectiveQuestion) => void) {
    onChange((draft) => {
      if (draft.type !== "subjective") return;
      const question = draft.questions.find((item) => item.id === questionId);
      if (question) mutator(question);
    });
  }

  function updateAnswerBlankItems(questionId: string, mutator: (items: BlankItem[]) => BlankItem[]) {
    updateQuestion(questionId, (draft) => {
      const items = mutator(answerBlankItems(draft));
      const first = items[0] ?? { label: "(1)", widthMm: 32, heightMm: 6 };
      draft.blanks = {
        ...(draft.blanks ?? { labelStyle: "arabic_parentheses" }),
        count: items.length,
        widthMm: first.widthMm,
        heightMm: first.heightMm,
        labelStyle: draft.blanks?.labelStyle ?? "arabic_parentheses",
        items
      };
    });
  }

  return (
    <>
      <div className="flex flex-col gap-3">
        <div className="text-sm font-semibold text-foreground">{isFillBlankBlock ? "填空题块" : isEssayBlock ? "作文块" : "解答题块"}</div>
        <Field label="标题">
          <Input value={block.title} onChange={(event) => onChange((draft) => void (draft.title = event.target.value))} />
        </Field>
        {isFillBlankBlock && (
          <>
            <Field label="填空题块满分">
              <Input
                type="number"
                min={0}
                max={60}
                step={0.5}
                value={block.questions[0]?.score ?? 0}
                onChange={(event) =>
                  onChange((draft) => {
                    if (draft.type !== "subjective") return;
                    const scoreQuestion = draft.questions[0];
                    if (!scoreQuestion) return;
                    scoreQuestion.score = Number(event.target.value);
                    scoreQuestion.style = "manual_score_grid";
                  })
                }
              />
            </Field>
            {layoutVersion === 2 && (block.questions[0]?.score ?? 0) <= 0 && (
              <p className="rounded-md border border-warning-border bg-warning-soft p-2 text-xs text-warning-fg">满分为 0，V2 不会生成分数填涂格。请先设置满分。</p>
            )}
          </>
        )}
        {!isEssayBlock && block.questions.map((question) => (
          <Panel key={question.id} className="gap-2 p-3">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <span className="text-xs font-semibold text-foreground">第 {question.number} 题</span>
                {/* 填空题块的得分填涂格是块级的：只有首题（计分题）承载整块得分格 */}
                {isFillBlankBlock && block.questions[0]?.id === question.id && <Badge>计分题</Badge>}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="删除小题"
                className="text-destructive-fg hover:bg-destructive-soft"
                onClick={() =>
                  onChange((draft) => {
                    if (draft.type !== "subjective") return;
                    const isScoreQuestion = isFillBlankBlock && draft.questions[0]?.id === question.id;
                    const blockScore = draft.questions[0]?.score ?? 0;
                    draft.questions = draft.questions.filter((item) => item.id !== question.id);
                    if (isScoreQuestion && draft.questions[0]) {
                      draft.questions[0].score = blockScore;
                      draft.questions[0].style = "manual_score_grid";
                    }
                  })
                }
              >
                <Trash2 size={14} />
              </Button>
            </div>
            {layoutVersion === 2 && !isFillBlankBlock && question.style === "manual_score_grid" && question.score <= 0 && (
              <p className="rounded-md border border-warning-border bg-warning-soft p-2 text-xs text-warning-fg">分值为 0，V2 已隐藏 0/0.5 分数格；设置正分后会自动显示。</p>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Field label="题号">
                <Input value={question.number} onChange={(event) => updateQuestion(question.id, (draft) => void (draft.number = event.target.value))} />
              </Field>
              {isFillBlankBlock ? (
                <Field label="横线宽(mm)">
                  <Input
                    type="number"
                    min={8}
                    value={question.blanks?.widthMm ?? 22}
                    onChange={(event) =>
                      updateQuestion(
                        question.id,
                        (draft) => void (draft.blanks = { ...(draft.blanks ?? { count: 1, heightMm: 6, labelStyle: "none" }), widthMm: Number(event.target.value) })
                      )
                    }
                  />
                </Field>
              ) : (
                <Field label="分值">
                  <Input type="number" min={0} step={0.5} value={question.score} onChange={(event) => updateQuestion(question.id, (draft) => void (draft.score = Number(event.target.value)))} />
                </Field>
              )}
            </div>
            {isFillBlankBlock ? (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <Field label="空数">
                    <Input
                      type="number"
                      min={1}
                      max={8}
                      value={question.blanks?.count ?? 1}
                      onChange={(event) =>
                        updateQuestion(question.id, (draft) => {
                          const count = Math.max(1, Math.min(8, Number(event.target.value) || 1));
                          const widthMm = draft.blanks?.widthMm ?? 22;
                          const heightMm = draft.blanks?.heightMm ?? 6;
                          const labelStyle = draft.blanks?.labelStyle ?? "none";
                          const prev = draft.blanks?.items ?? [];
                          const items = Array.from({ length: count }, (_, index) => ({
                            label: prev[index]?.label,
                            widthMm: prev[index]?.widthMm ?? widthMm,
                            heightMm: prev[index]?.heightMm ?? heightMm,
                            rightAnnotation: prev[index]?.rightAnnotation
                          }));
                          draft.blanks = { count, widthMm, heightMm, labelStyle, items };
                        })
                      }
                    />
                  </Field>
                  <Field label="横线高(mm)">
                    <Input
                      type="number"
                      min={4}
                      value={question.blanks?.heightMm ?? 6}
                      onChange={(event) =>
                        updateQuestion(
                          question.id,
                          (draft) => void (draft.blanks = { ...(draft.blanks ?? { count: 1, widthMm: 22, labelStyle: "none" }), heightMm: Number(event.target.value) })
                        )
                      }
                    />
                  </Field>
                  <Field label="序号类型">
                    <Select value={question.blanks?.labelStyle ?? "none"} onValueChange={(value) =>
                      updateQuestion(
                        question.id,
                        (draft) =>
                          void (draft.blanks = {
                            ...(draft.blanks ?? { count: 1, widthMm: 22, heightMm: 6 }),
                            labelStyle: value as BlankLabelStyle
                          })
                      )
                    }>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Object.entries(blankLabelStyleLabels).map(([value, label]) => (
                          <SelectItem key={value} value={value}>{label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
                {block.questions[0]?.id === question.id ? (
                  <div className="border-l-2 border-border-subtle pl-2">
                    <label className="flex items-center gap-2 text-xs text-secondary-foreground">
                      <input
                        type="checkbox"
                        checked={question.scoreGrid?.enabled !== false}
                        onChange={(event) => updateQuestion(question.id, (draft) => {
                          draft.scoreGrid = {
                            enabled: event.target.checked,
                            strokeColor: draft.scoreGrid?.strokeColor ?? "#999",
                            strokeWidthMm: draft.scoreGrid?.strokeWidthMm ?? 0.15,
                            fillColor: draft.scoreGrid?.fillColor ?? "#fff",
                            fontSize: draft.scoreGrid?.fontSize ?? 2.8,
                            dividerColor: draft.scoreGrid?.dividerColor ?? "#ccc",
                            dividerWidthMm: draft.scoreGrid?.dividerWidthMm ?? 0.1,
                            showLabel: draft.scoreGrid?.showLabel !== false,
                          };
                        })}
                      />
                      显示得分填涂格
                    </label>
                    {question.scoreGrid?.enabled !== false && (
                      <label className="mt-2 flex items-center gap-2 text-xs text-secondary-foreground">
                        <input
                          type="checkbox"
                          checked={question.scoreGrid?.showLabel !== false}
                          onChange={(event) => updateQuestion(question.id, (draft) => {
                            if (draft.scoreGrid) draft.scoreGrid = { ...draft.scoreGrid, showLabel: event.target.checked };
                          })}
                        />
                        显示"得分"标签
                      </label>
                    )}
                    <p className="mt-1.5 text-xs text-muted-foreground">填空题块整块共用一组得分格，由块首题（计分题）与「填空题块满分」控制。</p>
                  </div>
                ) : (
                  <p className="border-l-2 border-border-subtle pl-2 text-xs text-muted-foreground">得分填涂格由块首题（计分题）统一控制，本题不单独显示。</p>
                )}
                <div className="flex flex-col gap-2 border-l-2 border-border-subtle pl-2">
                  {answerBlankItems(question).map((item, blankIndex) => (
                    <Field key={blankIndex} label={`空${blankIndex + 1} 右侧批注`}>
                      <Input
                        value={item.rightAnnotation ?? ""}
                        placeholder="如：填＞或＜"
                        onChange={(event) =>
                          updateAnswerBlankItems(question.id, (items) =>
                            items.map((current, index) =>
                              index === blankIndex ? { ...current, rightAnnotation: event.target.value || undefined } : current
                            )
                          )
                        }
                      />
                    </Field>
                  ))}
                </div>
              </>
            ) : (
              <>
                <Field label="主观题样式">
                  <Select value={question.style} onValueChange={(value) => updateQuestion(question.id, (draft) => void (draft.style = value as SubjectiveStyle))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(styleLabels).map(([value, label]) => (
                        <SelectItem key={value} value={value}>{label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <div className="border-l-2 border-border-subtle pl-2">
                  <label className="flex items-center gap-2 text-xs text-secondary-foreground">
                    <input
                      type="checkbox"
                      checked={question.style === "manual_score_grid" && question.scoreGrid?.enabled !== false}
                      onChange={(event) => updateQuestion(question.id, (draft) => {
                        const enabled = event.target.checked;
                        // 开启即切到带分数填涂区的样式，避免「开关开着却因样式不匹配而不渲染」
                        if (enabled) draft.style = "manual_score_grid";
                        draft.scoreGrid = {
                          enabled,
                          strokeColor: draft.scoreGrid?.strokeColor ?? "#999",
                          strokeWidthMm: draft.scoreGrid?.strokeWidthMm ?? 0.15,
                          fillColor: draft.scoreGrid?.fillColor ?? "#fff",
                          fontSize: draft.scoreGrid?.fontSize ?? 2.8,
                          dividerColor: draft.scoreGrid?.dividerColor ?? "#ccc",
                          dividerWidthMm: draft.scoreGrid?.dividerWidthMm ?? 0.1,
                          showLabel: draft.scoreGrid?.showLabel !== false,
                        };
                      })}
                      />
                      显示得分填涂格
                    </label>
                    {question.style === "manual_score_grid" && question.scoreGrid?.enabled !== false && (
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <Field label="格线色">
                          <Input type="color" value={question.scoreGrid?.strokeColor ?? "#999"}
                            onChange={(e) => updateQuestion(question.id, (draft) => {
                              if (draft.scoreGrid) draft.scoreGrid = { ...draft.scoreGrid, strokeColor: e.target.value };
                            })}
                            className="h-7 px-1 py-0.5" />
                        </Field>
                        <Field label="分隔线">
                          <Input type="color" value={question.scoreGrid?.dividerColor ?? "#ccc"}
                            onChange={(e) => updateQuestion(question.id, (draft) => {
                              if (draft.scoreGrid) draft.scoreGrid = { ...draft.scoreGrid, dividerColor: e.target.value };
                            })}
                            className="h-7 px-1 py-0.5" />
                        </Field>
                        <label className="col-span-2 flex items-center gap-2 text-xs text-secondary-foreground">
                          <input type="checkbox" checked={question.scoreGrid?.showLabel !== false}
                            onChange={(e) => updateQuestion(question.id, (draft) => {
                              if (draft.scoreGrid) draft.scoreGrid = { ...draft.scoreGrid, showLabel: e.target.checked };
                            })} />
                          显示"得分"标签
                        </label>
                      </div>
                    )}
                </div>
                <Field label="作答区类型">
                  <Select
                    value={question.kind}
                    onValueChange={(value) =>
                      updateQuestion(question.id, (draft) => {
                        draft.kind = value as SubjectiveKind;
                        if (draft.kind === "blank" && !draft.blanks?.items?.length) {
                          draft.blanks = defaultAnswerBlankQuestion(numericQuestionValue(draft.number)).blanks;
                        }
                        if (draft.kind === "blank") {
                          draft.style = "manual_score_grid";
                          if (draft.score <= 0) draft.score = 12;
                        }
                      })
                    }
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(kindLabels).map(([value, label]) => (
                        <SelectItem key={value} value={value}>{label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                {layoutVersion === 2 && question.kind === "lined_answer" && question.lineGrid?.enabled ? (
                  <Field label="作答行数">
                    <Input
                      type="number"
                      min={1}
                      max={20}
                      value={answerLineCount(question)}
                      onChange={(event) =>
                        updateQuestion(question.id, (draft) => {
                          const spacing = draft.lineGrid?.lineSpacingMm ?? 8;
                          draft.minHeightMm = heightForAnswerLines(Number(event.target.value), spacing);
                        })
                      }
                    />
                  </Field>
                ) : (
                  <Field label="最小高度(mm)">
                    <Input type="number" min={24} max={220} value={question.minHeightMm} onChange={(event) => updateQuestion(question.id, (draft) => void (draft.minHeightMm = Number(event.target.value)))} />
                  </Field>
                )}
              </>
            )}
            {question.kind === "blank" && !isFillBlankBlock && (
              <div className="flex flex-col gap-2 border-l-2 border-border-subtle pl-2">
                {answerBlankItems(question).map((item, blankIndex) => (
                  <div className="grid grid-cols-[1fr_1fr_80px_80px_28px] items-end gap-2" key={blankIndex}>
                    <Field label="小题号">
                      <Input
                        value={item.label ?? ""}
                        onChange={(event) =>
                          updateAnswerBlankItems(question.id, (items) =>
                            items.map((current, index) => (index === blankIndex ? { ...current, label: event.target.value } : current))
                          )
                        }
                      />
                    </Field>
                    <Field label="右侧批注">
                      <Input
                        value={item.rightAnnotation ?? ""}
                        placeholder="如：填＞或＜"
                        onChange={(event) =>
                          updateAnswerBlankItems(question.id, (items) =>
                            items.map((current, index) => (index === blankIndex ? { ...current, rightAnnotation: event.target.value || undefined } : current))
                          )
                        }
                      />
                    </Field>
                    <Field label="宽(mm)">
                      <Input
                        type="number"
                        min={8}
                        value={item.widthMm}
                        onChange={(event) =>
                          updateAnswerBlankItems(question.id, (items) =>
                            items.map((current, index) => (index === blankIndex ? { ...current, widthMm: Number(event.target.value) } : current))
                          )
                        }
                      />
                    </Field>
                    <Field label="高(mm)">
                      <Input
                        type="number"
                        min={4}
                        value={item.heightMm}
                        onChange={(event) =>
                          updateAnswerBlankItems(question.id, (items) =>
                            items.map((current, index) => (index === blankIndex ? { ...current, heightMm: Number(event.target.value) } : current))
                          )
                        }
                      />
                    </Field>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="删除这个空"
                      className="text-destructive-fg hover:bg-destructive-soft"
                      onClick={() => updateAnswerBlankItems(question.id, (items) => (items.length > 1 ? items.filter((_, index) => index !== blankIndex) : items))}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                ))}
                <Button variant="outline" size="sm" onClick={() =>
                  updateAnswerBlankItems(question.id, (items) => [
                    ...items,
                    {
                      label: `(${items.length + 1})`,
                      widthMm: items[items.length - 1]?.widthMm ?? 32,
                      heightMm: items[items.length - 1]?.heightMm ?? 6
                    }
                  ])
                }>
                  <Plus size={14} /> 添加空
                </Button>
              </div>
            )}
            {!isFillBlankBlock && question.kind !== "blank" && (
              <>
                <label className="flex items-center gap-2 text-xs text-secondary-foreground">
                  <input
                    type="checkbox"
                    checked={question.lineGrid?.enabled ?? false}
                    onChange={(event) => updateQuestion(question.id, (draft) => {
                      const wasOn = draft.lineGrid?.enabled;
                      const enabled = event.target.checked;
                      draft.lineGrid = {
                        lineSpacingMm: draft.lineGrid?.lineSpacingMm ?? 8,
                        lineColor: draft.lineGrid?.lineColor ?? "#222",
                        lineWidthMm: draft.lineGrid?.lineWidthMm ?? 0.15,
                        insetLeftMm: draft.lineGrid?.insetLeftMm ?? 8,
                        insetRightMm: draft.lineGrid?.insetRightMm ?? 6,
                        lineStyle: draft.lineGrid?.lineStyle ?? "solid",
                        fixedLineCount: draft.lineGrid?.fixedLineCount,
                        enabled,
                      };
                      if (!wasOn && enabled) {
                        draft.kind = "lined_answer";
                        draft.lineGrid = { ...draft.lineGrid, fixedLineCount: answerLineCount(draft) };
                        draft.minHeightMm = heightForAnswerLines(draft.lineGrid.fixedLineCount!, draft.lineGrid.lineSpacingMm);
                      }
                        })}
                      />
                      启用横线格
                    </label>
                    {question.lineGrid?.enabled && (
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="线型" className="col-span-2">
                          <Select value={question.lineGrid.lineStyle ?? "solid"} onValueChange={(value) => updateQuestion(question.id, (draft) => {
                            if (draft.lineGrid) draft.lineGrid = { ...draft.lineGrid, lineStyle: value as "solid" | "dashed" | "dotted" };
                          })}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="solid">实线</SelectItem>
                              <SelectItem value="dashed">虚线</SelectItem>
                              <SelectItem value="dotted">点线</SelectItem>
                            </SelectContent>
                          </Select>
                        </Field>
                        <Field label="行数">
                          <Input
                            type="number" min={1} max={30}
                            value={question.lineGrid.fixedLineCount ?? answerLineCount(question)}
                            onChange={(event) => updateQuestion(question.id, (draft) => {
                              if (!draft.lineGrid) return;
                              const count = Math.max(1, Math.min(30, Number(event.target.value) || 1));
                              draft.lineGrid = { ...draft.lineGrid, fixedLineCount: count };
                              draft.minHeightMm = heightForAnswerLines(count, draft.lineGrid.lineSpacingMm);
                            })}
                          />
                        </Field>
                        <Field label="间距 (mm)">
                          <Input
                            type="number" min={5} max={16} step={1}
                            value={question.lineGrid.lineSpacingMm ?? 8}
                            onChange={(event) => updateQuestion(question.id, (draft) => {
                              if (!draft.lineGrid) return;
                              const sp = Number(event.target.value) || 8;
                              draft.lineGrid = { ...draft.lineGrid, lineSpacingMm: sp };
                              const count = draft.lineGrid.fixedLineCount;
                              if (count) draft.minHeightMm = heightForAnswerLines(count, sp);
                            })}
                          />
                        </Field>
                        <Field label="颜色">
                          <Input type="color" value={question.lineGrid.lineColor ?? "#222"}
                            onChange={(event) => updateQuestion(question.id, (draft) => {
                              if (draft.lineGrid) draft.lineGrid = { ...draft.lineGrid, lineColor: event.target.value };
                            })}
                            className="h-7 px-1 py-0.5" />
                        </Field>
                        <Field label="线宽 (mm)">
                          <Input type="number" min={0.05} max={0.5} step={0.05} value={question.lineGrid.lineWidthMm ?? 0.15}
                            onChange={(event) => updateQuestion(question.id, (draft) => {
                              if (draft.lineGrid) draft.lineGrid = { ...draft.lineGrid, lineWidthMm: Number(event.target.value) || 0.15 };
                            })} />
                        </Field>
                        <Field label="左边距 (mm)">
                          <Input type="number" min={0} max={20} value={question.lineGrid.insetLeftMm ?? 8}
                            onChange={(event) => updateQuestion(question.id, (draft) => {
                              if (draft.lineGrid) draft.lineGrid = { ...draft.lineGrid, insetLeftMm: Number(event.target.value) ?? 8 };
                            })} />
                        </Field>
                        <Field label="右边距 (mm)">
                          <Input type="number" min={0} max={20} value={question.lineGrid.insetRightMm ?? 6}
                            onChange={(event) => updateQuestion(question.id, (draft) => {
                              if (draft.lineGrid) draft.lineGrid = { ...draft.lineGrid, insetRightMm: Number(event.target.value) ?? 6 };
                            })} />
                        </Field>
                      </div>
                    )}
                </>
              )}
              {isFillBlankBlock && (
                <Field label="文字注释">
                  <Input
                    value={question.annotation ?? ""}
                    placeholder="填空横线上方的说明文字"
                    onChange={(event) => updateQuestion(question.id, (draft) => void (draft.annotation = event.target.value || undefined))}
                  />
                </Field>
              )}
              {/* 图片插入对所有主观题小题可用（含填空题块，#221 重构曾误将此控件随横线格一起隐藏） */}
              <label className="relative inline-flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-border-strong bg-card px-3 py-2 text-xs text-secondary-foreground transition-colors hover:border-primary hover:text-accent-foreground">
                <ImagePlus size={16} /> 插入图片
                <input
                  type="file"
                  accept="image/*"
                  className="absolute inset-0 cursor-pointer opacity-0"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void onUpload(block.id, question.id, file);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
              {(question.images ?? []).map((image, index) => (
                  <div
                    draggable
                    onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(index)); }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const from = Number(e.dataTransfer.getData("text/plain"));
                      const to = index;
                      if (Number.isNaN(from) || from === to) return;
                      updateQuestion(question.id, (draft) => {
                        const arr = draft.images ?? [];
                        const [moved] = arr.splice(from, 1);
                        arr.splice(to, 0, moved);
                      });
                    }}
                    className="flex items-center gap-1.5 rounded-md border border-transparent px-1 py-1 text-xs text-secondary-foreground hover:border-border-subtle hover:bg-secondary"
                    key={`${image.assetId}_${index}`}
                  >
                    <span className="cursor-grab select-none text-muted-foreground" title="拖拽排序">⋮⋮</span>
                    <span className="min-w-0 flex-1 truncate" title={image.originalName ?? image.assetId}>{image.originalName ?? image.assetId}</span>
                    <Input type="number" min={10} value={image.widthMm} onChange={(event) => updateQuestion(question.id, (draft) => void ((draft.images![index].widthMm = Number(event.target.value))))} className="w-20" />
                    <Input type="number" min={10} value={image.heightMm} onChange={(event) => updateQuestion(question.id, (draft) => void ((draft.images![index].heightMm = Number(event.target.value))))} className="w-20" />
                    <Button variant="ghost" size="icon-sm" aria-label="上移" disabled={index === 0} onClick={() => updateQuestion(question.id, (draft) => { const arr = draft.images ?? []; if (index>0) { const t=arr[index-1]; arr[index-1]=arr[index]; arr[index]=t; } })}><ArrowUp size={14} /></Button>
                    <Button variant="ghost" size="icon-sm" aria-label="下移" disabled={index === (question.images?.length ?? 0)-1} onClick={() => updateQuestion(question.id, (draft) => { const arr = draft.images ?? []; if (index < arr.length-1) { const t=arr[index+1]; arr[index+1]=arr[index]; arr[index]=t; } })}><ArrowDown size={14} /></Button>
                    <Button variant="ghost" size="icon-sm" aria-label="删除图片" className="text-destructive-fg hover:bg-destructive-soft" onClick={() => updateQuestion(question.id, (draft) => void (draft.images = (draft.images ?? []).filter((_, i) => i !== index)))}><Trash2 size={14} /></Button>
                  </div>
                ))}
          </Panel>
        ))}
        {isFillBlankBlock && (
          <Button variant="outline" size="sm" onClick={() =>
            onChange((draft) => {
              if (draft.type !== "subjective") return;
              const next = Math.max(0, ...draft.questions.map((item) => numericQuestionValue(item.number))) + 1;
              draft.questions.push(defaultBlankQuestion(next));
            })
          }>
            <Plus size={14} /> 添加填空题
          </Button>
        )}
        {isEssayBlock && (
          <div className="flex flex-col gap-2">
            <Field label="目标字数">
              <Input
                type="number"
                value={block.questions[0]?.essayGrid?.targetChars ?? 600}
                min={100} max={2000} step={50}
                onChange={(event) => updateQuestion(block.questions[0].id, (draft) => {
                  if (!draft.essayGrid) draft.essayGrid = { columns: 0, rows: 0, cellWidthMm: 7, cellHeightMm: 7, targetChars: 600, showTitle: true, lineColor: ESSAY_DEFAULT_LINE_COLOR, lineWidthMm: 0.15 };
                  draft.essayGrid.targetChars = Number(event.target.value) || 600;
                })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="格子宽 (mm)">
                <Input
                  type="number"
                  value={block.questions[0]?.essayGrid?.cellWidthMm ?? 7}
                  min={4} max={12} step={0.5}
                  onChange={(event) => updateQuestion(block.questions[0].id, (draft) => {
                    if (!draft.essayGrid) draft.essayGrid = { columns: 0, rows: 0, cellWidthMm: 7, cellHeightMm: 7, targetChars: 600, showTitle: true, lineColor: ESSAY_DEFAULT_LINE_COLOR, lineWidthMm: 0.15 };
                    draft.essayGrid.cellWidthMm = Number(event.target.value) || 7;
                  })}
                />
              </Field>
              <Field label="格子高 (mm)">
                <Input
                  type="number"
                  value={block.questions[0]?.essayGrid?.cellHeightMm ?? 7}
                  min={4} max={12} step={0.5}
                  onChange={(event) => updateQuestion(block.questions[0].id, (draft) => {
                    if (!draft.essayGrid) draft.essayGrid = { columns: 0, rows: 0, cellWidthMm: 7, cellHeightMm: 7, targetChars: 600, showTitle: true, lineColor: ESSAY_DEFAULT_LINE_COLOR, lineWidthMm: 0.15 };
                    draft.essayGrid.cellHeightMm = Number(event.target.value) || 7;
                  })}
                />
              </Field>
            </div>
            <Field label="格线颜色">
              <Input
                type="color"
                value={block.questions[0]?.essayGrid?.lineColor ?? ESSAY_DEFAULT_LINE_COLOR}
                onChange={(event) => updateQuestion(block.questions[0].id, (draft) => {
                  if (!draft.essayGrid) draft.essayGrid = { columns: 0, rows: 0, cellWidthMm: 7, cellHeightMm: 7, targetChars: 600, showTitle: true, lineColor: ESSAY_DEFAULT_LINE_COLOR, lineWidthMm: 0.15 };
                  draft.essayGrid.lineColor = event.target.value;
                })}
                className="h-7 px-1 py-0.5"
              />
            </Field>
            <label className="flex items-center gap-2 text-xs text-secondary-foreground">
              <input
                type="checkbox"
                checked={block.questions[0]?.essayGrid?.showTitle !== false}
                onChange={(event) => updateQuestion(block.questions[0].id, (draft) => {
                  if (!draft.essayGrid) draft.essayGrid = { columns: 0, rows: 0, cellWidthMm: 7, cellHeightMm: 7, targetChars: 600, showTitle: true, lineColor: ESSAY_DEFAULT_LINE_COLOR, lineWidthMm: 0.15 };
                  draft.essayGrid.showTitle = event.target.checked;
                })}
              /> 显示"题：（000）"标题
            </label>
            <label className="flex items-center gap-2 text-xs text-secondary-foreground">
              <input
                type="checkbox"
                checked={block.questions[0]?.essayGrid?.showFrame !== false}
                onChange={(event) => updateQuestion(block.questions[0].id, (draft) => {
                  if (!draft.essayGrid) draft.essayGrid = { columns: 0, rows: 0, cellWidthMm: 7, cellHeightMm: 7, targetChars: 600, showTitle: true, lineColor: ESSAY_DEFAULT_LINE_COLOR, lineWidthMm: 0.15 };
                  draft.essayGrid.showFrame = event.target.checked;
                })}
              /> 显示粗边框
            </label>
            <label className="flex items-center gap-2 text-xs text-secondary-foreground">
              <input
                type="checkbox"
                checked={block.questions[0]?.essayGrid?.showWordScale !== false}
                onChange={(event) => updateQuestion(block.questions[0].id, (draft) => {
                  if (!draft.essayGrid) draft.essayGrid = { columns: 0, rows: 0, cellWidthMm: 7, cellHeightMm: 7, targetChars: 600, showTitle: true, lineColor: ESSAY_DEFAULT_LINE_COLOR, lineWidthMm: 0.15 };
                  draft.essayGrid.showWordScale = event.target.checked;
                })}
              /> 显示字数刻度
            </label>
            <div className="text-xs text-muted-foreground">
              系统将自动计算每栏列数和行数。A3 三栏模式生效时网格均分到三栏。
            </div>
          </div>
        )}
      </div>
    </>
  );}

export function CardPreview({ card, layout, firstPageOnly = false }: { card: AnswerCard; layout: LayoutDocument; firstPageOnly?: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 760, height: 560 });
  // 每次进入编辑器先按 demo 的默认状态展示完整纸面；缩放操作仍可在本次编辑中使用。
  const [{ mode, customPercent }, setPreviewSettings] = useState<{ mode: PreviewMode; customPercent: number }>({
    mode: "fit-width",
    customPercent: 100,
  });

  useEffect(() => {
    try {
      localStorage.setItem(PREVIEW_SETTINGS_KEY, JSON.stringify({ mode, customPercent }));
    } catch {}
  }, [mode, customPercent]);

  useEffect(() => {
    // 只测量自身滚动区（高度由 flex 链决定、不随内容增长）；
    // 观察外层内容自适应容器会与 fit-page 的 SVG 高度形成反馈环（无限放大）。
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const style = getComputedStyle(el);
      const horizontalPadding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
      setViewport({
        width: Math.max(1, el.clientWidth - horizontalPadding),
        height: Math.max(1, el.clientHeight - verticalPadding)
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const firstPage = layout.pages[0];
  const paperRatio = firstPage ? firstPage.width / firstPage.height : 1;
  const panelRatio = firstPage?.panels[0]?.rect.width
    ? firstPage.width / firstPage.panels[0].rect.width
    : 1;
  // Fit width fills the usable canvas; fit page must show the whole paper,
  // so it is bounded by both the usable width and the usable height.
  const pageWidth = mode === "fit-page"
    ? Math.min(viewport.width, viewport.height * paperRatio)
    : mode === "fit-panel"
      ? viewport.width * Math.min(PREVIEW_MAX_PERCENT, panelRatio * 100) / 100
      : mode === "custom"
        ? viewport.width * customPercent / 100
        : viewport.width;
  const effectivePercent = Math.max(
    PREVIEW_MIN_PERCENT,
    Math.min(
      PREVIEW_MAX_PERCENT,
      mode === "custom" ? customPercent : (pageWidth / viewport.width) * 100
    )
  );

  const changeZoom = (delta: number) => {
    const next = Math.max(PREVIEW_MIN_PERCENT, Math.min(PREVIEW_MAX_PERCENT, Math.round(effectivePercent / 10) * 10 + delta));
    setPreviewSettings({ mode: "custom", customPercent: next });
  };

  const isThumbnail = firstPageOnly;
  const thumbnailPageWidth = isThumbnail
    ? Math.min(viewport.width, viewport.height * paperRatio)
    : pageWidth;

  return (
    <div className={cn("flex h-full min-h-0 w-full min-w-0 flex-col", isThumbnail && "card-preview-thumbnail")} ref={rootRef}>
      {!isThumbnail && <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border-subtle bg-card px-4" aria-label="预览缩放工具栏">
        <SegmentedControl<PreviewMode>
          value={mode}
          onValueChange={(value) => setPreviewSettings({ mode: value, customPercent })}
          items={[
            { value: "fit-width", label: "适合宽度" },
            { value: "fit-page", label: "适合页面" },
            { value: "fit-panel", label: "适合单版" },
          ]}
          size="sm"
        />
        <div className="h-4 w-px bg-border" />
        <Button variant="ghost" size="icon-sm" aria-label="缩小预览" onClick={() => changeZoom(-10)} disabled={effectivePercent <= PREVIEW_MIN_PERCENT}>
          <span className="text-sm">−</span>
        </Button>
        <output className="min-w-[42px] text-center text-xs tabular-nums text-muted-foreground" aria-label="当前缩放比例">
          {Math.round(effectivePercent)}%
        </output>
        <Button variant="ghost" size="icon-sm" aria-label="放大预览" onClick={() => changeZoom(10)} disabled={effectivePercent >= PREVIEW_MAX_PERCENT}>
          <Plus size={14} />
        </Button>
      </div>}
      <div className={cn("flex min-h-0 flex-1 flex-col items-center gap-6 overflow-auto p-6", isThumbnail && "gap-0 p-0")} ref={scrollRef}>
        {(firstPageOnly ? layout.pages.slice(0, 1) : layout.pages).map((page) => (
          <svg
            key={page.pageNumber}
            viewBox={`0 0 ${page.width} ${page.height}`}
             className="paper-a4-preview shrink-0 rounded-xs bg-paper shadow-2"
             style={{ aspectRatio: `${page.width} / ${page.height}`, width: `${thumbnailPageWidth}px`, height: `${thumbnailPageWidth * page.height / page.width}px` }}
            role="img"
            aria-label={`第${page.pageNumber}页预览`}
          >
            <rect x="0" y="0" width={page.width} height={page.height} fill="#fff" />
            {page.markers.map((marker) => (
              <rect key={marker.role} {...marker.rect} fill="#20342f" />
            ))}
            <text x={page.header.idTextX} y={page.header.idTextY} fontSize={3} fill="#1a1a1a">
              ID:{page.header.id}
            </text>
            {page.header.codeBoxes.map((box, index) => (
              <rect key={index} {...box} fill={index === 0 || index === page.header.codeBoxes.length - 1 ? "#20342f" : "#fff"} stroke="#222" strokeWidth="0.25" />
            ))}
            {page.header.title && (
              <text x={page.header.titleX} y={page.header.titleY} textAnchor="middle" dominantBaseline="middle" fontSize={5} fontWeight={700} fill="#1a1a1a">
                {page.header.title}
              </text>
            )}
            {page.studentArea && <StudentAreaSvg area={page.studentArea} />}
            {page.blocks.map((block, index) =>
              block.type === "objective" ? <ObjectiveSvg block={block} key={`${block.blockId}_${index}`} /> : <SubjectiveSvg card={card} block={block} key={`${block.blockId}_${index}`} />
            )}
            <text x={page.width / 2} y={page.height - 13} textAnchor="middle" fontSize={3} fill="#1a1a1a">
              第{page.pageNumber}页/共{layout.pages.length}页
            </text>
          </svg>
        ))}
      </div>
    </div>
  );}

export function StudentAreaSvg({ area }: { area: NonNullable<LayoutDocument["pages"][number]["studentArea"]> }) {
  const rowCount = Math.max(...area.digitCells.map((cell) => cell.digitIndex)) + 1;
  const separatorX = area.digitRect.x + 8.5;
  return (
    <g>
      <rect {...area.infoRect} fill="none" stroke="#333" strokeWidth="0.25" />
      <rect {...area.digitRect} fill="none" stroke="#333" strokeWidth="0.25" />
      <text x={area.digitRect.x + area.digitRect.width / 2} y={area.digitRect.y + 5.2} textAnchor="middle" fontSize={2.6} fill="#1a1a1a">
        填涂号区
      </text>
      <text x={area.infoRect.x + 5} y={area.infoRect.y + 13.5} fontSize={2.6} fill="#1a1a1a">
        姓名：
      </text>
      <line x1={area.infoRect.x + 18} y1={area.infoRect.y + 14.5} x2={area.infoRect.x + area.infoRect.width - 9} y2={area.infoRect.y + 14.5} stroke="#333" strokeWidth="0.25" />
      <text x={area.infoRect.x + 5} y={area.infoRect.y + 25.5} fontSize={2.6} fill="#1a1a1a">
        班级：
      </text>
      <line x1={area.infoRect.x + 18} y1={area.infoRect.y + 26.5} x2={area.infoRect.x + area.infoRect.width - 9} y2={area.infoRect.y + 26.5} stroke="#333" strokeWidth="0.25" />
      {Array.from({ length: rowCount }).map((_, row) => (
        <line key={row} x1={area.digitRect.x} y1={area.digitRect.y + 7 + row * 4.8} x2={area.digitRect.x + area.digitRect.width} y2={area.digitRect.y + 7 + row * 4.8} stroke="#999" strokeWidth="0.15" />
      ))}
      <line x1={separatorX} y1={area.digitRect.y + 7} x2={separatorX} y2={area.digitRect.y + area.digitRect.height} stroke="#333" strokeWidth="0.2" />
      {area.digitCells.map((cell) => (
        <g key={`${cell.digitIndex}_${cell.digit}`}>
          <rect {...cell.rect} fill="#fff" stroke="#333" strokeWidth="0.15" />
          <text x={cell.rect.x + cell.rect.width / 2} y={cell.rect.y + cell.rect.height / 2} textAnchor="middle" dominantBaseline="middle" fontSize={2.4} fill="#1a1a1a">
            {cell.digit}
          </text>
        </g>
      ))}
    </g>
  );
}

export function ObjectiveSvg({ block }: { block: Extract<PageRenderBlock, { type: "objective" }> }) {
  return (
    <g>
      <text x={block.rect.x} y={block.rect.y + 4.4} dominantBaseline="middle" fontSize={3.4} fontWeight={600} fill="#1a1a1a">
        {block.title}
      </text>
      <rect {...block.frameRect} fill="none" stroke="#222" strokeWidth="0.25" />
      {block.rowMarkers.map((marker) => (
        <g key={marker.row}>
          <rect {...marker.left} fill="#20342f" />
          <rect {...marker.right} fill="#20342f" />
        </g>
      ))}
      {block.items.map((item) => (
        <g key={item.questionNumber}>
          <text x={item.labelX - 2.5} y={(item.options[0]?.rect.y ?? item.labelY) + (item.options[0]?.rect.height ?? 0) / 2} textAnchor="middle" dominantBaseline="central" fontSize={2.6} fill="#1a1a1a">
            {item.questionNumber}
          </text>
          {item.options.map((option) => (
            <g key={option.label}>
              <rect {...option.rect} fill="#fff" stroke="#333" strokeWidth="0.15" />
              <text x={option.rect.x + option.rect.width / 2} y={option.rect.y + option.rect.height / 2} textAnchor="middle" dominantBaseline="central" fontSize={2.6} fill="#1a1a1a">
                {option.label}
              </text>
            </g>
          ))}
        </g>
      ))}
    </g>
  );
}

export function SubjectiveSvg({ card, block }: { card: AnswerCard; block: Extract<PageRenderBlock, { type: "subjective" }> }) {
  const isV2 = card.layoutVersion === 2;

  // 作文块专用渲染
  const originalBlock = card.bodyBlocks.find(b => b.id === block.blockId);
  const isEssay = originalBlock?.type === "subjective" && originalBlock.blockKind === "essay";

  if (isEssay) {
    const q = originalBlock && originalBlock.type === "subjective" ? originalBlock.questions[0] : null;
    const g = q?.essayGrid;
    if (!g) return null;
    // 几何（列/行/行缝/刻度）唯一事实源：shared/essayGrid，预览与 PDF、排版共用
    const geo = essayGridGeometry(block.rect, g);
    const lineColor = g.lineColor || "#222";
    const lineW = g.lineWidthMm ?? 0.15;
    const showTitle = g.showTitle !== false;
    const showFrame = g.showFrame !== false;
    const showWordScale = g.showWordScale !== false;
    const marks = showWordScale ? essayWordScaleMarks(geo, block.essayStartCell ?? 0, g.targetChars || 600) : [];

    return (
      <g>
        {showFrame && block.frameRect && <rect {...block.frameRect} fill="none" stroke="#111" strokeWidth={0.4} />}
        {showTitle && block.title && (
          <>
            <text x={block.rect.x + ESSAY_GRID_INSET_X} y={block.rect.y + 5} fontSize={3.4} fontWeight={600} fill="#1a1a1a">{block.title}（{q?.score}分）</text>
            <text x={block.rect.x + block.rect.width - ESSAY_GRID_INSET_X} y={block.rect.y + 5} textAnchor="end" fontSize={2.4} fill="#888">
              题：（{String(q?.number ?? 1).padStart(3, "0")}）
            </text>
          </>
        )}
        {[...Array(geo.rows)].map((_, row) =>
          [...Array(geo.columns)].map((_, col) => (
            <rect
              key={`${row}_${col}`}
              x={geo.offsetX + col * geo.cellW}
              y={geo.rowY(row)}
              width={geo.cellW}
              height={geo.cellH}
              fill="#fff"
              stroke={lineColor}
              strokeWidth={lineW}
            />
          ))
        )}
        {/* 行间淡虚线（末行不画），与 PDF 导出一致 */}
        {[...Array(Math.max(0, geo.rows - 1))].map((_, row) => (
          <line
            key={`seam_${row}`}
            x1={geo.offsetX}
            y1={geo.rowSeamY(row)}
            x2={geo.offsetX + geo.gridW}
            y2={geo.rowSeamY(row)}
            stroke="#ddd"
            strokeWidth={0.08}
            strokeDasharray="1 1"
          />
        ))}
        {/* 每 100 字刻度：右对齐落在里程碑格右边线的下方窄缝（跨栏续号） */}
        {marks.map((mark) => (
          <text key={`mark_${mark.milestone}`} x={mark.x - 0.6} y={mark.seamY + 0.9} textAnchor="end" fontSize={1.6} fill="#888">
            {mark.milestone}
          </text>
        ))}
      </g>
    );
  }

  return (
    <g>
      {block.title && (
        <text x={block.rect.x} y={block.rect.y + 4.4} dominantBaseline="middle" fontSize={3.4} fontWeight={600} fill="#1a1a1a">
          {block.title}
        </text>
      )}
      {block.frameRect && <rect {...block.frameRect} fill="none" stroke="#222" strokeWidth="0.25" />}
      {block.questions.map((question) => (
        <g key={question.questionId}>
          {!block.frameRect && <rect {...question.rect} fill="none" stroke="#222" strokeWidth="0.25" />}
          {shouldRenderScoreGrid(question, isV2) && (
            (() => {
              const sg = question.scoreGrid;
              const sc = sg?.strokeColor ?? "#999";
              const sw = sg?.strokeWidthMm ?? 0.15;
              const fc = sg?.fillColor ?? "#fff";
              const fs = sg?.fontSize ?? 2.8;
              const dc = sg?.dividerColor ?? "#ccc";
              const dw = sg?.dividerWidthMm ?? 0.1;
              const showL = sg?.showLabel !== false;
              return (
            <>
              {block.frameRect && question.kind === "blank" && question.scoreCells.length > 0 ? (
                <>
                  {showL && (
                    <text x={block.frameRect.x + 4} y={question.scoreCells[0].rect.y + (isV2 ? 3 : 4.2)} fontSize={2.4} fill="#1a1a1a">
                      得分
                    </text>
                  )}
                  <line
                    x1={block.frameRect.x}
                    y1={isV2 ? block.frameRect.y + 6 : question.scoreCells[0].rect.y + question.scoreCells[0].rect.height + 2}
                    x2={block.frameRect.x + block.frameRect.width}
                    y2={isV2 ? block.frameRect.y + 6 : question.scoreCells[0].rect.y + question.scoreCells[0].rect.height + 2}
                    stroke={dc}
                    strokeWidth={dw}
                  />
                </>
              ) : (
                <line x1={question.rect.x} y1={question.contentRect.y} x2={question.rect.x + question.rect.width} y2={question.contentRect.y} stroke={dc} strokeWidth={dw} />
              )}
              {question.scoreCells.map((cell) => (
                <g key={cell.score} data-testid="score-cell">
                  <rect x={cell.rect.x} y={cell.rect.y} width={cell.rect.width} height={cell.rect.height}
                    fill={fc} stroke={sc} strokeWidth={sw} style={{ fill: fc }} />
                  {cell.score !== null && (
                    <text x={cell.rect.x + cell.rect.width / 2} y={cell.rect.y + (isV2 ? 3 : 4.2)} textAnchor="middle"
                      fontSize={fs} fill="#333">
                      {cell.score}
                    </text>
                  )}
                </g>
              ))}
            </>
              );
            })()
          )}
          {question.kind === "blank" ? (
            <text x={question.contentRect.x + 3} y={question.contentRect.y + 7.2} fontSize={2.4} fill="#1a1a1a">
              {question.questionNumber}
            </text>
          ) : (
            <text x={question.rect.x + 2} y={isV2 ? question.rect.y + 4.3 : question.contentRect.y + 6} fontSize={2.4} fill="#1a1a1a">
              {question.questionNumber}.（{question.score}分）
            </text>
          )}
          {question.lineYs.map((lineY) => {
            const cfg = question.lineGrid;
            const color = cfg?.lineColor ?? "#222";
            const width = cfg?.lineWidthMm ?? 0.15;
            const insetL = cfg?.insetLeftMm ?? 8;
            const insetR = cfg?.insetRightMm ?? 6;
            const dash = cfg?.lineStyle === "dashed" ? "1.2,0.8" : cfg?.lineStyle === "dotted" ? "0.3,0.7" : undefined;
            return (
              <line key={lineY} x1={question.contentRect.x + insetL} y1={lineY}
                    x2={question.contentRect.x + question.contentRect.width - insetR} y2={lineY}
                    stroke={color} strokeWidth={width} strokeDasharray={dash} strokeLinecap={cfg?.lineStyle === "dotted" ? "round" : undefined} />
            );
          })}
          {question.blanks.map((blank, index) => {
            const blankLabel = question.blankLabels?.[index] ?? (question.kind === "blank" ? formatBlankLabel(question.blankLabelStyle, index) : `${question.questionNumber}.${index + 1}`);
            return (
              <g key={index}>
                {blankLabel && (
                  <text x={blank.x - 0.8} y={blank.y + blank.height - 1.8} textAnchor="end" dominantBaseline="middle" fontSize={2.4} fill="#1a1a1a">
                    {blankLabel}
                  </text>
                )}
                <line x1={blank.x} y1={blank.y + blank.height} x2={blank.x + blank.width} y2={blank.y + blank.height} stroke="#333" strokeWidth="0.25" />
                {question.blankRightAnnotations?.[index] && (
                  <text x={blank.x + blank.width + 1.2} y={blank.y + blank.height - 1.8} dominantBaseline="middle"
                    fontSize="3" fill="#888">
                    {question.blankRightAnnotations[index]}
                  </text>
                )}
              </g>
            );
          })}
          {(question.annotationLines ?? []).map((line, index) => (
            <text key={`anno_${index}`} x={line.rect.x} y={line.rect.y} fontSize={2.5} fill="#1a1a1a">
              {line.text}
            </text>
          ))}
          {question.images.map((image) => (
            <g key={image.assetId}>
              {/* 受控资源路由在 /api 下（#202 移除了公开 /assets 静态目录），少了 /api 前缀会 404 */}
              <image href={apiUrl(`/api/assets/${card.id}/${image.assetId}`)} x={image.rect.x} y={image.rect.y} width={image.rect.width} height={image.rect.height} preserveAspectRatio="xMidYMid meet" />
              <rect {...image.rect} fill="none" stroke="#666" strokeWidth="0.18" />
            </g>
          ))}
        </g>
      ))}
    </g>
  );
}
