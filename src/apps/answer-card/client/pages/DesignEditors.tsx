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
import { apiUrl, authFetch, fetchJson, mediaUrl, urlWithToken } from "../auth/api";
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
import { formatBlankLabel } from "../../../../shared/blankLabels";
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
    <>
      <div className="panel-title">客观题机器阅卷块</div>
      <label>
        标题
        <input value={block.title} onChange={(event) => onChange((draft) => void (draft.title = event.target.value))} />
      </label>
      <div className="answer-key-editor">
        <div className="answer-key-title">
          <strong>标准答案</strong>
          <span>{missingAnswerCount === 0 ? "已全部配置" : `${missingAnswerCount} 题未配置`}</span>
        </div>
        <div className="answer-key-grid">
          {questions.map((questionNumber) => (
            <div className="answer-key-row" key={questionNumber}>
              <span>{questionNumber}</span>
              <div>
                {optionLabelsForQuestion(block, questionNumber).map((option) => {
                  const active = answerKey[questionNumber]?.includes(option) ?? false;
                  return (
                    <button
                      key={option}
                      type="button"
                      className={active ? "active" : ""}
                      onClick={() => toggleAnswer(questionNumber, option)}
                      title={`第 ${questionNumber} 题 ${option} 选项`}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="two-col">
        <label>
          起始题号
          <input
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
        </label>
        <label>
          题目数
          <input
            type="number"
            min={1}
            max={120}
            value={block.questionCount}
            onChange={(event) =>
              onChange((draft) => {
                const objective = draft as ObjectiveBlock;
                objective.questionCount = Number(event.target.value);
                objective.answerKey = normalizeObjectiveAnswerKey(objective);
              })
            }
          />
        </label>
      </div>
      <div className="two-col">
        <label>
          选项数
          <input
            type="number"
            min={2}
            max={8}
            value={block.optionCount}
            onChange={(event) =>
              onChange((draft) => {
                const objective = draft as ObjectiveBlock;
                objective.optionCount = Number(event.target.value);
                // v1.4.7: 同步到逐题配置
                objective.questions = normalizeObjectiveQuestions(objective);
                for (const q of objective.questions) {
                  q.optionCount = objective.optionCount;
                }
                objective.answerKey = normalizeObjectiveAnswerKey(objective);
              })
            }
          />
        </label>
        <label>
          每题分值
          <input type="number" min={0} step={0.5} value={block.scorePerQuestion} onChange={(event) => onChange((draft) => void ((draft as ObjectiveBlock).scorePerQuestion = Number(event.target.value)))} />
        </label>
      </div>
      <div className="two-col">
        <label>
          题型
          <select
            value={block.mode}
            onChange={(event) =>
              onChange((draft) => {
                const objective = draft as ObjectiveBlock;
                objective.mode = event.target.value as ObjectiveMode;
                // v1.4.7: 同步块级题型到所有逐题配置
                objective.questions = normalizeObjectiveQuestions(objective);
                for (const q of objective.questions) {
                  q.mode = objective.mode;
                  if (objective.mode !== "multiple" && objective.mode !== "indefinite") {
                    delete q.scoringRule;
                  }
                }
                objective.answerKey = normalizeObjectiveAnswerKey(objective);
              })
            }
          >
            {Object.entries(modeLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          选项排列
          <select
            value={block.optionLayout ?? "horizontal"}
            onChange={(event) =>
              onChange((draft) => {
                (draft as ObjectiveBlock).optionLayout = event.target.value as ObjectiveOptionLayout;
              })
            }
          >
            {Object.entries(optionLayoutLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="two-col">
        <label>
          少选1项得分
          <input
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
        </label>
        <label>
          多选/错选得分
          <input
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
        </label>
      </div>
      <div style={{ marginTop: 8 }}>
        <button className="ghost-button" type="button" onClick={() => setShowPerQuestion(!showPerQuestion)} style={{ fontSize: 12 }}>
          {showPerQuestion ? "▲ 收起每题配置" : "▼ 展开每题配置"}
        </button>
      </div>
      {showPerQuestion && (
      <div className="answer-key-editor">
        <div className="answer-key-title">
          <strong>每题配置</strong>
          <span>可混排单选、多选、不定项</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {questionConfigs.map((question) => (
            <div className="question-editor" key={question.questionNumber} style={{ margin: 0 }}>
              <div className="question-editor-title">
                <strong>第 {question.questionNumber} 题</strong>
              </div>
              <div className="three-col">
                <label>
                  题号
                  <input type="number" min={1} value={question.questionNumber} onChange={(event) => updateQuestionConfig(question.questionNumber, (draft) => void (draft.questionNumber = Number(event.target.value)))} />
                </label>
                <label>
                  题型
                  <select value={question.mode} onChange={(event) => updateQuestionConfig(question.questionNumber, (draft) => { draft.mode = event.target.value as ObjectiveMode; if (draft.mode === "single") draft.scoringRule = undefined; })}>
                    {Object.entries(modeLabels).map(([value, label]) => (<option key={value} value={value}>{label}</option>))}
                  </select>
                </label>
                <label>
                  选项数
                  <input type="number" min={2} max={8} value={question.optionCount} onChange={(event) => updateQuestionConfig(question.questionNumber, (draft) => void (draft.optionCount = Number(event.target.value)))} />
                </label>
              </div>
              <label>
                分值
                <input type="number" min={0} step={0.5} value={question.score} onChange={(event) => updateQuestionConfig(question.questionNumber, (draft) => void (draft.score = Number(event.target.value)))} />
              </label>
              {question.mode !== "single" && (
                <>
                  <div className="two-col">
                    <label>
                      少选计分方式
                      <select
                        value={scoringRuleFor(question).type}
                        onChange={(event) =>
                          setScoringRuleType(
                            question.questionNumber,
                            event.target.value as "per_selected_count" | "by_correct_count" | "fixed_partial"
                          )
                        }
                      >
                        <option value="per_selected_count">按选对项数给分</option>
                        <option value="by_correct_count">按正确答案数量给分</option>
                        <option value="fixed_partial">少选固定分</option>
                      </select>
                    </label>
                    <label>
                      错选/多选/不选得分
                      <input
                        type="number"
                        step={0.5}
                        value={(scoringRuleFor(question) as any).wrongOrExtraScore ?? 0}
                        onChange={(event) => updateWrongOrExtraScore(question.questionNumber, Number(event.target.value))}
                      />
                    </label>
                  </div>
                  {scoringRuleFor(question).type === "fixed_partial" ? (
                    <label>
                      少选固定得分
                      <input
                        type="number"
                        step={0.5}
                        value={(scoringRuleFor(question) as any).partialScore ?? 0}
                        onChange={(event) => updateFixedPartialScore(question.questionNumber, Number(event.target.value))}
                      />
                    </label>
                  ) : scoringRuleFor(question).type === "by_correct_count" ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <span style={{ fontSize: 12, color: "var(--muted)" }}>
                        根据标准答案个数，设置少选时选对几项得几分
                      </span>
                      {Array.from({ length: Math.max(0, question.optionCount - 1) }, (_, index) => index + 2).map((correctCount) => (
                        <div key={correctCount} style={{ display: "grid", gridTemplateColumns: "84px 1fr", gap: 8, alignItems: "center" }}>
                          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{correctCount} 个答案</span>
                          <div className="three-col">
                            {Array.from({ length: correctCount - 1 }, (_, index) => index + 1).map((selectedCount) => (
                              <label key={selectedCount}>
                                {selectedCount} 项对
                                <input
                                  type="number"
                                  step={0.5}
                                  value={(scoringRuleFor(question) as any).partialScoresByCorrectCount?.[correctCount]?.[selectedCount] ?? 0}
                                  onChange={(event) =>
                                    updateByCorrectCountScore(
                                      question.questionNumber,
                                      correctCount,
                                      selectedCount,
                                      Number(event.target.value)
                                    )
                                  }
                                />
                              </label>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="three-col">
                      {Array.from({ length: Math.max(1, question.optionCount - 1) }, (_, index) => index + 1).map((selectedCount) => (
                        <label key={selectedCount}>
                          选对 {selectedCount} 项
                          <input
                            type="number"
                            step={0.5}
                            value={(scoringRuleFor(question) as any).partialScores?.[selectedCount] ?? 0}
                            onChange={(event) =>
                              updatePerSelectedScore(question.questionNumber, selectedCount, Number(event.target.value))
                            }
                          />
                        </label>
                      ))}
                    </div>
                  )}
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={(scoringRuleFor(question) as any).allowWrongOptions === true}
                      onChange={(event) => updateAllowWrongOptions(question.questionNumber, event.target.checked)}
                    />
                    错选但未超过正确答案数时，只按选对项给分
                  </label>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
      )}
      <p className="hint">横向模式少于 15 题按行排列、15 题及以上按 5 题小组网格排列；竖向模式按高考 AB 卡式 4 题一组纵向排布，每题选项仍保持横向小组选项。超过 5 个选项的题目独占一行。</p>
    </>
  );
}

export function SubjectiveEditor({
  block,
  card,
  layoutVersion,
  onChange,
  onUpload
}: {
  block: SubjectiveBlock;
  card: AnswerCard;
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

  function renderImageEditor(question: SubjectiveQuestion) {
    const images = question.images ?? [];
    return (
      <>
        <label className="upload-button">
          <ImagePlus size={16} /> 插入图片
          <input
            type="file"
            accept="image/*"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void onUpload(block.id, question.id, file);
              event.currentTarget.value = "";
            }}
          />
        </label>
        {images.map((image, index) => (
          <div className="image-row" key={`${image.assetId}_${index}`}>
            <span title={image.originalName ?? image.assetId}>{image.originalName ?? image.assetId}</span>
            <input
              type="number"
              min={10}
              max={200}
              title="宽度(mm)"
              value={image.widthMm}
              onChange={(event) => updateQuestion(question.id, (draft) => void ((draft.images![index].widthMm = Number(event.target.value))))}
            />
            <input
              type="number"
              min={10}
              max={200}
              title="高度(mm)"
              value={image.heightMm}
              onChange={(event) => updateQuestion(question.id, (draft) => void ((draft.images![index].heightMm = Number(event.target.value))))}
            />
            <select
              value={image.align}
              title="对齐方式"
              onChange={(event) =>
                updateQuestion(question.id, (draft) => void ((draft.images![index].align = event.target.value as "left" | "center" | "right")))
              }
            >
              <option value="left">靠左</option>
              <option value="center">居中</option>
              <option value="right">靠右</option>
            </select>
            <button
              title="删除图片"
              onClick={() => updateQuestion(question.id, (draft) => void (draft.images = (draft.images ?? []).filter((_, imgIndex) => imgIndex !== index)))}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </>
    );
  }

  return (
    <>
      <div className="panel-title">{isFillBlankBlock ? "填空题块" : isEssayBlock ? "作文块" : "解答题块"}</div>
      <label>
        标题
        <input value={block.title} onChange={(event) => onChange((draft) => void (draft.title = event.target.value))} />
      </label>
      {isFillBlankBlock && (
        <>
          <label>
            填空题块满分
            <input
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
          </label>
          {layoutVersion === 2 && (block.questions[0]?.score ?? 0) <= 0 && (
            <p className="inline-warning">满分为 0，V2 不会生成分数填涂格。请先设置满分。</p>
          )}
        </>
      )}
      {block.questions.map((question) => (
        <div className="question-editor" key={question.id}>
          <div className="question-editor-title">
            <strong>第 {question.number} 题</strong>
            {!isEssayBlock && (
            <button
              title="删除小题"
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
              <Trash2 size={15} />
            </button>
            )}
          </div>
          {layoutVersion === 2 && !isFillBlankBlock && question.style === "manual_score_grid" && question.score <= 0 && (
            <p className="inline-warning">分值为 0，V2 已隐藏 0/0.5 分数格；设置正分后会自动显示。</p>
          )}
          <div className="two-col">
            <label>
              题号
              <input value={question.number} onChange={(event) => updateQuestion(question.id, (draft) => void (draft.number = event.target.value))} />
            </label>
            {isFillBlankBlock ? (
              <label>
                默认横线宽(mm)
                <input
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
              </label>
            ) : (
              <label>
                分值
                <input type="number" min={0} step={0.5} value={question.score} onChange={(event) => updateQuestion(question.id, (draft) => void (draft.score = Number(event.target.value)))} />
              </label>
            )}
          </div>
          {isFillBlankBlock ? (
            <>
            <div className="three-col">
              <label>
                空数
                <input
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
              </label>
              <label>
                默认横线高(mm)
                <input
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
              </label>
              <label>
                序号类型
                <select
                  value={question.blanks?.labelStyle ?? "none"}
                  onChange={(event) =>
                    updateQuestion(
                      question.id,
                      (draft) =>
                        void (draft.blanks = {
                          ...(draft.blanks ?? { count: 1, widthMm: 22, heightMm: 6 }),
                          labelStyle: event.target.value as BlankLabelStyle
                        })
                    )
                  }
                >
                  {Object.entries(blankLabelStyleLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="hint">「默认横线宽/高」仅作为新增空的默认值；已列出的每个空可单独调整宽、高与批注。</p>
            <label>
              文字注释
              <textarea
                rows={2}
                maxLength={160}
                placeholder="可填写题干说明，如：看图计算并填空；注：答案不唯一"
                value={question.annotation ?? ""}
                onChange={(event) =>
                  updateQuestion(question.id, (draft) => void (draft.annotation = event.target.value.trim() ? event.target.value : undefined))
                }
              />
            </label>
            <div className="blank-item-list">
              {answerBlankItems(question).map((item, blankIndex) => (
                <div className="blank-item-row" key={blankIndex}>
                  <label>
                    空{blankIndex + 1} 宽(mm)
                    <input
                      type="number"
                      min={8}
                      max={60}
                      value={item.widthMm}
                      onChange={(event) =>
                        updateAnswerBlankItems(question.id, (items) =>
                          items.map((current, index) => (index === blankIndex ? { ...current, widthMm: Number(event.target.value) } : current))
                        )
                      }
                    />
                  </label>
                  <label>
                    高(mm)
                    <input
                      type="number"
                      min={4}
                      max={20}
                      value={item.heightMm}
                      onChange={(event) =>
                        updateAnswerBlankItems(question.id, (items) =>
                          items.map((current, index) => (index === blankIndex ? { ...current, heightMm: Number(event.target.value) } : current))
                        )
                      }
                    />
                  </label>
                  <label>
                    空{blankIndex + 1} 右侧批注
                    <input
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
                  </label>
                  <button
                    title="删除这个空"
                    onClick={() => updateAnswerBlankItems(question.id, (items) => (items.length > 1 ? items.filter((_, index) => index !== blankIndex) : items))}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
              <button
                className="ghost-button"
                onClick={() =>
                  updateAnswerBlankItems(question.id, (items) => [
                    ...items,
                    {
                      label: undefined,
                      widthMm: question.blanks?.widthMm ?? 22,
                      heightMm: question.blanks?.heightMm ?? 6
                    }
                  ])
                }
              >
                <Plus size={16} /> 添加空
              </button>
            </div>
            {renderImageEditor(question)}
            </>
          ) : (!isEssayBlock && (
            <>
              <label>
                主观题样式
                <select value={question.style} onChange={(event) => updateQuestion(question.id, (draft) => void (draft.style = event.target.value as SubjectiveStyle))}>
                  {Object.entries(styleLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {question.style === "manual_score_grid" && (
                <div style={{ borderLeft: "1px solid var(--line)", paddingLeft: 8, margin: "4px 0" }}>
                  <label className="check-row">
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
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
                      <label>
                        格线色
                        <input type="color" value={question.scoreGrid?.strokeColor ?? "#999"}
                          onChange={(e) => updateQuestion(question.id, (draft) => {
                            if (draft.scoreGrid) draft.scoreGrid = { ...draft.scoreGrid, strokeColor: e.target.value };
                          })}
                          style={{ padding: 1, height: 24, width: "100%" }} />
                      </label>
                      <label>
                        分隔线
                        <input type="color" value={question.scoreGrid?.dividerColor ?? "#ccc"}
                          onChange={(e) => updateQuestion(question.id, (draft) => {
                            if (draft.scoreGrid) draft.scoreGrid = { ...draft.scoreGrid, dividerColor: e.target.value };
                          })}
                          style={{ padding: 1, height: 24, width: "100%" }} />
                      </label>
                      <label className="check-row" style={{ gridColumn: "1 / -1" }}>
                        <input type="checkbox" checked={question.scoreGrid?.showLabel !== false}
                          onChange={(e) => updateQuestion(question.id, (draft) => {
                            if (draft.scoreGrid) draft.scoreGrid = { ...draft.scoreGrid, showLabel: e.target.checked };
                          })} />
                        显示"得分"标签
                      </label>
                    </div>
                  )}
                </div>
              )}
              <label>
                作答区类型
                <select
                  value={question.kind}
                  onChange={(event) =>
                    updateQuestion(question.id, (draft) => {
                      draft.kind = event.target.value as SubjectiveKind;
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
                  {Object.entries(kindLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {layoutVersion === 2 && question.kind === "lined_answer" && question.lineGrid?.enabled ? (
                <label>
                  作答行数
                  <input
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
                </label>
              ) : (
                <label>
                  最小高度(mm)
                  <input type="number" min={24} max={220} value={question.minHeightMm} onChange={(event) => updateQuestion(question.id, (draft) => void (draft.minHeightMm = Number(event.target.value)))} />
                </label>
              )}
            </>
          ))}
          {question.kind === "blank" && !isFillBlankBlock && (
            <div className="blank-item-list">
              {answerBlankItems(question).map((item, blankIndex) => (
                <div className="blank-item-row" key={blankIndex}>
                  <label>
                    小题号
                    <input
                      value={item.label ?? ""}
                      onChange={(event) =>
                        updateAnswerBlankItems(question.id, (items) =>
                          items.map((current, index) => (index === blankIndex ? { ...current, label: event.target.value } : current))
                        )
                      }
                    />
                  </label>
                  <label>
                    右侧批注
                    <input
                      value={item.rightAnnotation ?? ""}
                      placeholder="如：填＞或＜"
                      onChange={(event) =>
                        updateAnswerBlankItems(question.id, (items) =>
                          items.map((current, index) => (index === blankIndex ? { ...current, rightAnnotation: event.target.value || undefined } : current))
                        )
                      }
                    />
                  </label>
                  <label>
                    宽(mm)
                    <input
                      type="number"
                      min={8}
                      value={item.widthMm}
                      onChange={(event) =>
                        updateAnswerBlankItems(question.id, (items) =>
                          items.map((current, index) => (index === blankIndex ? { ...current, widthMm: Number(event.target.value) } : current))
                        )
                      }
                    />
                  </label>
                  <label>
                    高(mm)
                    <input
                      type="number"
                      min={4}
                      value={item.heightMm}
                      onChange={(event) =>
                        updateAnswerBlankItems(question.id, (items) =>
                          items.map((current, index) => (index === blankIndex ? { ...current, heightMm: Number(event.target.value) } : current))
                        )
                      }
                    />
                  </label>
                  <button
                    title="删除这个空"
                    onClick={() => updateAnswerBlankItems(question.id, (items) => (items.length > 1 ? items.filter((_, index) => index !== blankIndex) : items))}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
              <button
                className="ghost-button"
                onClick={() =>
                  updateAnswerBlankItems(question.id, (items) => [
                    ...items,
                    {
                      label: `(${items.length + 1})`,
                      widthMm: items[items.length - 1]?.widthMm ?? 32,
                      heightMm: items[items.length - 1]?.heightMm ?? 6
                    }
                  ])
                }
              >
                <Plus size={16} /> 添加空
              </button>
            </div>
          )}
          {!isFillBlankBlock && (
            <>
              {question.kind !== "blank" && !isEssayBlock && (
                <>
              <label className="check-row">
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
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  <label style={{ gridColumn: "1 / -1" }}>
                    线型
                    <select
                      value={question.lineGrid.lineStyle ?? "solid"}
                      onChange={(event) => updateQuestion(question.id, (draft) => {
                        if (draft.lineGrid) draft.lineGrid = { ...draft.lineGrid, lineStyle: event.target.value as "solid" | "dashed" | "dotted" };
                      })}
                    >
                      <option value="solid">实线</option>
                      <option value="dashed">虚线</option>
                      <option value="dotted">点线</option>
                    </select>
                  </label>
                  <label>
                    行数
                    <input
                      type="number" min={1} max={30}
                      value={question.lineGrid.fixedLineCount ?? answerLineCount(question)}
                      onChange={(event) => updateQuestion(question.id, (draft) => {
                        if (!draft.lineGrid) return;
                        const count = Math.max(1, Math.min(30, Number(event.target.value) || 1));
                        draft.lineGrid = { ...draft.lineGrid, fixedLineCount: count };
                        draft.minHeightMm = heightForAnswerLines(count, draft.lineGrid.lineSpacingMm);
                      })}
                    />
                  </label>
                  <label>
                    间距 (mm)
                    <input
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
                  </label>
                  <label>
                    颜色
                    <input
                      type="color"
                      value={question.lineGrid.lineColor ?? "#222"}
                      onChange={(event) => updateQuestion(question.id, (draft) => {
                        if (draft.lineGrid) draft.lineGrid = { ...draft.lineGrid, lineColor: event.target.value };
                      })}
                      style={{ padding: 2, height: 28, width: "100%" }}
                    />
                  </label>
                  <label>
                    线宽 (mm)
                    <input
                      type="number" min={0.05} max={0.5} step={0.05}
                      value={question.lineGrid.lineWidthMm ?? 0.15}
                      onChange={(event) => updateQuestion(question.id, (draft) => {
                        if (draft.lineGrid) draft.lineGrid = { ...draft.lineGrid, lineWidthMm: Number(event.target.value) || 0.15 };
                      })}
                    />
                  </label>
                  <label>
                    左边距 (mm)
                    <input
                      type="number" min={0} max={20}
                      value={question.lineGrid.insetLeftMm ?? 8}
                      onChange={(event) => updateQuestion(question.id, (draft) => {
                        if (draft.lineGrid) draft.lineGrid = { ...draft.lineGrid, insetLeftMm: Number(event.target.value) ?? 8 };
                      })}
                    />
                  </label>
                  <label>
                    右边距 (mm)
                    <input
                      type="number" min={0} max={20}
                      value={question.lineGrid.insetRightMm ?? 6}
                      onChange={(event) => updateQuestion(question.id, (draft) => {
                        if (draft.lineGrid) draft.lineGrid = { ...draft.lineGrid, insetRightMm: Number(event.target.value) ?? 6 };
                      })}
                    />
                  </label>
                </div>
              )}
                </>
              )}
              {renderImageEditor(question)}
            </>
          )}
        </div>
      ))}
      {isFillBlankBlock && (
        <button
          className="ghost-button"
          onClick={() =>
            onChange((draft) => {
              if (draft.type !== "subjective") return;
              const next = Math.max(0, ...draft.questions.map((item) => numericQuestionValue(item.number))) + 1;
              draft.questions.push(defaultBlankQuestion(next));
            })
          }
        >
          <Plus size={16} /> 添加填空题
        </button>
      )}
      {isEssayBlock && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
          <label>
            目标字数
            <input
              type="number"
              value={block.questions[0]?.essayGrid?.targetChars ?? 600}
              min={100} max={2000} step={50}
              onChange={(event) => updateQuestion(block.questions[0].id, (draft) => {
                if (!draft.essayGrid) draft.essayGrid = { columns: 0, rows: 0, cellWidthMm: 7, cellHeightMm: 7, targetChars: 600, showTitle: true, lineColor: "#222", lineWidthMm: 0.15 };
                draft.essayGrid.targetChars = Number(event.target.value) || 600;
              })}
            />
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <label>
              格子宽 (mm)
              <input
                type="number"
                value={block.questions[0]?.essayGrid?.cellWidthMm ?? 7}
                min={4} max={12} step={0.5}
                onChange={(event) => updateQuestion(block.questions[0].id, (draft) => {
                  if (!draft.essayGrid) draft.essayGrid = { columns: 0, rows: 0, cellWidthMm: 7, cellHeightMm: 7, targetChars: 600, showTitle: true, lineColor: "#222", lineWidthMm: 0.15 };
                  draft.essayGrid.cellWidthMm = Number(event.target.value) || 7;
                })}
              />
            </label>
            <label>
              格子高 (mm)
              <input
                type="number"
                value={block.questions[0]?.essayGrid?.cellHeightMm ?? 7}
                min={4} max={12} step={0.5}
                onChange={(event) => updateQuestion(block.questions[0].id, (draft) => {
                  if (!draft.essayGrid) draft.essayGrid = { columns: 0, rows: 0, cellWidthMm: 7, cellHeightMm: 7, targetChars: 600, showTitle: true, lineColor: "#222", lineWidthMm: 0.15 };
                  draft.essayGrid.cellHeightMm = Number(event.target.value) || 7;
                })}
              />
            </label>
          </div>
          <label>
            <input
              type="checkbox"
              checked={block.questions[0]?.essayGrid?.showTitle !== false}
              onChange={(event) => updateQuestion(block.questions[0].id, (draft) => {
                if (!draft.essayGrid) draft.essayGrid = { columns: 0, rows: 0, cellWidthMm: 7, cellHeightMm: 7, targetChars: 600, showTitle: true, lineColor: "#222", lineWidthMm: 0.15, showFrame: true, showWordScale: true };
                draft.essayGrid.showTitle = event.target.checked;
              })}
            /> 在答题区上方显示标题
          </label>
          <label>
            <input
              type="checkbox"
              checked={block.questions[0]?.essayGrid?.showFrame !== false}
              onChange={(event) => updateQuestion(block.questions[0].id, (draft) => {
                if (!draft.essayGrid) draft.essayGrid = { columns: 0, rows: 0, cellWidthMm: 7, cellHeightMm: 7, targetChars: 600, showTitle: true, lineColor: "#222", lineWidthMm: 0.15, showFrame: true, showWordScale: true };
                draft.essayGrid.showFrame = event.target.checked;
              })}
            /> 显示作文区外边框
          </label>
          <label>
            <input
              type="checkbox"
              checked={block.questions[0]?.essayGrid?.showWordScale !== false}
              onChange={(event) => updateQuestion(block.questions[0].id, (draft) => {
                if (!draft.essayGrid) draft.essayGrid = { columns: 0, rows: 0, cellWidthMm: 7, cellHeightMm: 7, targetChars: 600, showTitle: true, lineColor: "#222", lineWidthMm: 0.15, showFrame: true, showWordScale: true };
                draft.essayGrid.showWordScale = event.target.checked;
              })}
            /> 显示字数刻度（每 100 字标注）
          </label>
          <div style={{ fontSize: 11, color: "var(--muted)" }}>
            系统将自动计算每栏列数和行数。A3 三栏模式生效时网格均分到三栏。
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", background: "var(--bg-soft)", padding: "6px 8px", borderRadius: 6 }}>
            {(() => {
              const eg = block.questions[0]?.essayGrid;
              const cw = eg?.cellWidthMm ?? 7;
              const isA3 = card.paper?.size === "A3";
              const bodyWidth = (isA3 ? 420 : 210) - 17 * 2;
              const usableW = bodyWidth - 4 * 2;
              const colsPerPanel = Math.max(1, Math.floor(usableW / cw));
              const panelCount = isA3 ? 3 : 1;
              const totalCols = colsPerPanel * panelCount;
              const rows = Math.ceil((eg?.targetChars ?? 600) / totalCols);
              return `预计约 ${rows} 行 × ${totalCols} 栏（每面板 ${colsPerPanel} 列${isA3 ? "，A3 三栏并排" : ""}）。实际页数取决于版面余量。`;
            })()}
          </div>
        </div>
      )}
    </>
  );
}

export function CardPreview({ card, layout }: { card: AnswerCard; layout: LayoutDocument }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 760, height: 560 });
  const [{ mode, customPercent }, setPreviewSettings] = useState<{ mode: PreviewMode; customPercent: number }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PREVIEW_SETTINGS_KEY) ?? "null") as { mode?: string; customPercent?: number } | null;
      const validModes: PreviewMode[] = ["fit-width", "fit-page", "fit-panel", "custom"];
      const savedMode = validModes.includes(saved?.mode as PreviewMode) ? saved?.mode as PreviewMode : "fit-width";
      const savedPercent = Number(saved?.customPercent);
      return {
        mode: savedMode,
        customPercent: Number.isFinite(savedPercent)
          ? Math.max(PREVIEW_MIN_PERCENT, Math.min(PREVIEW_MAX_PERCENT, savedPercent))
          : 100
      };
    } catch {
      return { mode: "fit-width", customPercent: 100 };
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(PREVIEW_SETTINGS_KEY, JSON.stringify({ mode, customPercent }));
    } catch {}
  }, [mode, customPercent]);

  useEffect(() => {
    const root = rootRef.current;
    const parent = root?.parentElement;
    if (!root || !parent) return;
    const measure = () => {
      const style = getComputedStyle(parent);
      const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
      setViewport({
        width: Math.max(1, root.clientWidth),
        height: Math.max(1, parent.clientHeight - verticalPadding - (toolbarRef.current?.offsetHeight ?? 0) - 16)
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const firstPage = layout.pages[0];
  const paperRatio = firstPage ? firstPage.width / firstPage.height : 1;
  const panelRatio = firstPage?.panels[0]?.rect.width
    ? firstPage.width / firstPage.panels[0].rect.width
    : 1;
  const fitPagePercent = Math.max(
    PREVIEW_MIN_PERCENT,
    Math.min(100, viewport.height * paperRatio / viewport.width * 100)
  );
  const effectivePercent = Math.max(
    PREVIEW_MIN_PERCENT,
    Math.min(
      PREVIEW_MAX_PERCENT,
      mode === "fit-page"
        ? fitPagePercent
        : mode === "fit-panel"
          ? panelRatio * 100
          : mode === "custom"
            ? customPercent
            : 100
    )
  );
  const pageWidth = viewport.width * effectivePercent / 100;

  const changeZoom = (delta: number) => {
    const next = Math.max(PREVIEW_MIN_PERCENT, Math.min(PREVIEW_MAX_PERCENT, Math.round(effectivePercent / 10) * 10 + delta));
    setPreviewSettings({ mode: "custom", customPercent: next });
  };

  return (
    <div className="preview-shell" ref={rootRef}>
      <div className="preview-toolbar" ref={toolbarRef} aria-label="预览缩放工具栏">
        <button type="button" className={mode === "fit-width" ? "active" : ""} onClick={() => setPreviewSettings({ mode: "fit-width", customPercent })}>适合宽度</button>
        <button type="button" className={mode === "fit-page" ? "active" : ""} onClick={() => setPreviewSettings({ mode: "fit-page", customPercent })}>适合页面</button>
        <button type="button" className={mode === "fit-panel" ? "active" : ""} onClick={() => setPreviewSettings({ mode: "fit-panel", customPercent })}>适合单版</button>
        <span className="preview-toolbar-separator" />
        <button type="button" aria-label="缩小预览" onClick={() => changeZoom(-10)} disabled={effectivePercent <= PREVIEW_MIN_PERCENT}>−</button>
        <output aria-label="当前缩放比例">{Math.round(effectivePercent)}%</output>
        <button type="button" aria-label="放大预览" onClick={() => changeZoom(10)} disabled={effectivePercent >= PREVIEW_MAX_PERCENT}>＋</button>
      </div>
      <div className="pages">
        {layout.pages.map((page) => (
          <svg
            className="page"
            key={page.pageNumber}
            viewBox={`0 0 ${page.width} ${page.height}`}
            style={{ aspectRatio: `${page.width} / ${page.height}`, width: `${pageWidth}px` }}
            role="img"
            aria-label={`第${page.pageNumber}页预览`}
          >
            <rect x="0" y="0" width={page.width} height={page.height} style={{ fill: "#fff" }} />
            {page.markers.map((marker) => (
              <rect key={marker.role} {...marker.rect} fill="#20342f" />
            ))}
            <text x={page.header.idTextX} y={page.header.idTextY} className="svg-small">
              ID:{page.header.id}
            </text>
            {page.header.codeBoxes.map((box, index) => (
              <rect key={index} {...box} fill={index === 0 || index === page.header.codeBoxes.length - 1 ? "#20342f" : "#fff"} stroke="#222" strokeWidth="0.25" style={index !== 0 && index !== page.header.codeBoxes.length - 1 ? { fill: "#fff" } : undefined} />
            ))}
            {page.header.title && (
              <text x={page.header.titleX} y={page.header.titleY} textAnchor="middle" className="svg-title">
                {page.header.title}
              </text>
            )}
            {page.studentArea && <StudentAreaSvg area={page.studentArea} />}
            {page.blocks.map((block, index) =>
              block.type === "objective" ? <ObjectiveSvg block={block} key={`${block.blockId}_${index}`} /> : <SubjectiveSvg card={card} block={block} key={`${block.blockId}_${index}`} />
            )}
            <text x={page.width / 2} y={page.height - 13} textAnchor="middle" className="svg-footer">
              第{page.pageNumber}页/共{layout.pages.length}页
            </text>
          </svg>
        ))}
      </div>
    </div>
  );
}

export function StudentAreaSvg({ area }: { area: NonNullable<LayoutDocument["pages"][number]["studentArea"]> }) {
  const hasDigits = area.digitCells.length > 0;
  return (
    <g>
      <rect {...area.infoRect} fill="none" stroke="#333" strokeWidth="0.25" />
      {area.fieldRows.map((row) => (
        <g key={row.label}>
          <text x={row.labelX} y={row.lineY - 1.0} className="svg-label">
            {row.label}
          </text>
          <line x1={row.lineX1} y1={row.lineY} x2={row.lineX2} y2={row.lineY} stroke="#333" strokeWidth="0.25" />
        </g>
      ))}
      {area.notesLines && area.notesLines.length > 0 && area.notesY !== undefined &&
        area.notesLines.map((line, index) => (
          <text key={index} x={area.infoRect.x + 5} y={area.notesY! + index * 4.2} className="svg-notes">
            {line}
          </text>
        ))}
      {hasDigits && (
        <>
          <rect {...area.digitRect} fill="none" stroke="#333" strokeWidth="0.25" />
          <text x={area.digitRect.x + area.digitRect.width / 2} y={area.digitRect.y + 5.2} textAnchor="middle" className="svg-label">
            填涂号区
          </text>
          {Array.from({ length: Math.max(...area.digitCells.map((cell) => cell.digitIndex)) + 1 }).map((_, row) => (
            <line key={row} x1={area.digitRect.x} y1={area.digitRect.y + 7 + row * 4.8} x2={area.digitRect.x + area.digitRect.width} y2={area.digitRect.y + 7 + row * 4.8} stroke="#999" strokeWidth="0.15" />
          ))}
          <line x1={area.digitRect.x + 8.5} y1={area.digitRect.y + 7} x2={area.digitRect.x + 8.5} y2={area.digitRect.y + area.digitRect.height} stroke="#333" strokeWidth="0.2" />
          {area.digitCells.map((cell) => (
            <g key={`${cell.digitIndex}_${cell.digit}`}>
              <rect {...cell.rect} fill="#fff" stroke="#333" strokeWidth="0.15" style={{ fill: "#fff" }} />
              <text x={cell.rect.x + cell.rect.width / 2} y={cell.rect.y + cell.rect.height / 2} textAnchor="middle" dominantBaseline="middle" className="svg-tiny">
                {cell.digit}
              </text>
            </g>
          ))}
        </>
      )}
    </g>
  );
}

export function ObjectiveSvg({ block }: { block: Extract<PageRenderBlock, { type: "objective" }> }) {
  return (
    <g>
      <text x={block.rect.x} y={block.rect.y + 4.4} className="svg-section">
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
          <text x={item.labelX - 2.5} y={(item.options[0]?.rect.y ?? item.labelY) + (item.options[0]?.rect.height ?? 0) / 2} textAnchor="middle" dominantBaseline="central" className="svg-option-label">
            {item.questionNumber}
          </text>
          {item.options.map((option) => (
            <g key={option.label}>
              <rect {...option.rect} fill="#fff" stroke="#333" strokeWidth="0.15" style={{ fill: "#fff" }} />
              <text x={option.rect.x + option.rect.width / 2} y={option.rect.y + option.rect.height / 2} textAnchor="middle" dominantBaseline="central" className="svg-option-label">
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
    const g = q?.essayGrid ?? { columns: 0, rows: 0, cellWidthMm: 7, cellHeightMm: 7, targetChars: 600, showTitle: true, lineColor: "#222", lineWidthMm: 0.15, showFrame: true, showWordScale: true };
    const cellW = g.cellWidthMm || 7;
    const cellH = g.cellHeightMm || 7;
    const lineColor = g.lineColor || "#222";
    const lineW = g.lineWidthMm ?? 0.15;
    const showTitle = g.showTitle !== false;
    const showFrame = g.showFrame !== false;
    const showWordScale = g.showWordScale !== false;

    // 计算栏宽和列数
    const bodyW = block.rect.width;
    const insetX = 4;
    const usableW = bodyW - insetX * 2;
    const columns = g.columns > 0 ? g.columns : Math.max(1, Math.floor(usableW / cellW));
    const gridW = columns * cellW;
    const offsetX = block.rect.x + (bodyW - gridW) / 2;

    const gap = 1.6; // 行间窄溜宽度（mm），仅作为格间空隙，格子保持完整高度
    const gridTop = showTitle ? 9 : 2;
    const bottomPad = 2;
    const gridH = block.rect.height - gridTop - bottomPad;
    const rows = Math.max(0, Math.floor((gridH + gap) / (cellH + gap)));
    const startY = block.rect.y + gridTop;

    const cells: ReactElement[] = [];
    const guideLines: ReactElement[] = [];
    for (let row = 0; row < rows; row++) {
      const cy = startY + row * (cellH + gap);
      for (let col = 0; col < columns; col++) {
        cells.push(
          <rect
            key={`${row}_${col}`}
            x={offsetX + col * cellW}
            y={cy}
            width={cellW}
            height={cellH}
            fill="#fff"
            stroke={lineColor}
            strokeWidth={lineW}
          />
        );
      }
      // 行间窄溜：淡虚线贯穿整栏（末行不画）
      if (row < rows - 1) {
        const lineY = startY + (row + 1) * (cellH + gap) - gap / 2;
        guideLines.push(
          <line key={`gap_${row}`} x1={offsetX} y1={lineY} x2={offsetX + gridW} y2={lineY} stroke="#ddd" strokeWidth={0.08} strokeDasharray="1,1" />
        );
      }
    }

    const scaleTicks: ReactElement[] = [];
    if (showWordScale && columns > 0) {
      const startCell = block.essayStartCell ?? 0;
      const targetCells = g.targetChars || 600;
      for (let row = 0; row < rows; row++) {
        const rowStart = startCell + row * columns;
        const rowEnd = rowStart + columns - 1;
        const milestone = Math.ceil((rowStart + 1) / 100) * 100;  // 本行跨过的第一个 100 倍数
        if (milestone <= rowEnd && milestone <= targetCells) {
          const cellIndex = milestone - rowStart - 1; // 0-based column of the milestone cell
          const cellRight = offsetX + (cellIndex + 1) * cellW;   // 该格右边线
          const seamY = startY + (row + 1) * (cellH + gap) - gap / 2; // 该行下方窄缝中心
          scaleTicks.push(
            <text
              key={`scale_${row}`}
              x={cellRight - 0.6}
              y={seamY}
              fontSize={1.7}
              textAnchor="end"
              dominantBaseline="middle"
              fill="#555"
              className="svg-micro"
            >
              {milestone}
            </text>
          );
        }
      }
    }

    return (
      <g>
        {showFrame && block.frameRect && (
          <rect {...block.frameRect} fill="none" stroke="#111" strokeWidth={0.4} />
        )}
        {showTitle && block.title && (
          <text x={block.rect.x + insetX} y={block.rect.y + 5} className="svg-section">{block.title}</text>
        )}
        {guideLines}
        {cells}
        {scaleTicks}
      </g>
    );
  }

  return (
    <g>
      {block.title && (
        <text x={block.rect.x} y={block.rect.y + 4.4} className="svg-section">
          {block.title}
        </text>
      )}
      {block.frameRect && <rect {...block.frameRect} fill="none" stroke="#222" strokeWidth="0.25" />}
      {block.questions.map((question) => (
        <g key={question.questionId}>
          {!block.frameRect && <rect {...question.rect} fill="none" stroke="#222" strokeWidth="0.25" />}
          {question.style === "manual_score_grid" && (!isV2 || question.scoreCells.length > 0) && (
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
                    <text x={block.frameRect.x + 4} y={question.scoreCells[0].rect.y + (isV2 ? 3 : 4.2)} className="svg-tiny">
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
                <g key={cell.score}>
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
            <text x={question.contentRect.x + 3} y={question.contentRect.y + 7.2} className="svg-tiny">
              {question.questionNumber}
            </text>
          ) : (
            <text x={question.rect.x + 2} y={isV2 ? question.rect.y + 4.3 : question.contentRect.y + 6} className="svg-tiny">
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
                  <text x={blank.x - 0.8} y={blank.y + blank.height} textAnchor="end" dominantBaseline="middle" className="svg-blank-label">
                    {blankLabel}
                  </text>
                )}
                <line x1={blank.x} y1={blank.y + blank.height} x2={blank.x + blank.width} y2={blank.y + blank.height} stroke="#333" strokeWidth="0.25" />
                {question.blankRightAnnotations?.[index] && (
                  <text x={blank.x + blank.width + 1.2} y={blank.y + blank.height} dominantBaseline="middle"
                    fontSize="3" fill="#888">
                    {question.blankRightAnnotations[index]}
                  </text>
                )}
              </g>
            );
          })}
          {(question.annotationLines ?? []).map((line) => (
            <text key={`${line.rect.x}-${line.rect.y}`} x={line.rect.x} y={line.rect.y + 2.6} className="svg-tiny" fill="#444">
              {line.text}
            </text>
          ))}
          {question.images.map((image) => (
            <g key={image.assetId}>
              <image href={apiUrl(`/api/assets/${card.id}/${image.assetId}`)} x={image.rect.x} y={image.rect.y} width={image.rect.width} height={image.rect.height} preserveAspectRatio="xMidYMid meet" />
              <rect {...image.rect} fill="none" stroke="#666" strokeWidth="0.18" />
            </g>
          ))}
        </g>
      ))}
    </g>
  );
}
