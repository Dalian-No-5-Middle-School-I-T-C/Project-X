import io

path = "src/apps/answer-card/client/pages/DesignEditors.tsx"
src = open(path, encoding="utf-8").read()

# 1) 补充 v2 导入（在 cardModel import 之后）
v2_import = (
    'import {\n'
    '  Button,\n'
    '  Checkbox,\n'
    '  Field,\n'
    '  Input,\n'
    '  Panel,\n'
    '  Select,\n'
    '  SelectContent,\n'
    '  SelectItem,\n'
    '  SelectTrigger,\n'
    '  SelectValue,\n'
    '} from "../components/ui/v2";\n'
)
anchor = '} from "../cardModel";\n'
assert anchor in src, "cardModel import anchor not found"
if 'from "../components/ui/v2"' not in src:
    src = src.replace(anchor, anchor + "\n" + v2_import, 1)

# 2) 替换 ObjectiveEditor 的 return 块
import re
start_marker = 'return (\n    <>\n      <div className="panel-title">客观题机器阅卷块</div>'
start = src.index(start_marker)
end_match = re.search(r'\);\r?\n\}', src[start:])
assert end_match, "end marker not found"
end = start + end_match.end()

new_return = r'''return (
    <Panel className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <SquarePen size={16} /> 客观题机器阅卷块
      </div>

      {/* 标准答案 */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <strong className="text-sm text-foreground">标准答案</strong>
          <span className="text-xs text-muted-foreground tabular-nums">
            {missingAnswerCount === 0 ? "已全部配置" : `${missingAnswerCount} 题未配置`}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {questions.map((questionNumber) => (
            <div key={questionNumber} className="flex items-center gap-2 text-sm">
              <span className="w-6 shrink-0 text-muted-foreground tabular-nums">{questionNumber}</span>
              <div className="flex flex-wrap gap-1">
                {optionLabelsForQuestion(block, questionNumber).map((option) => {
                  const active = answerKey[questionNumber]?.includes(option) ?? false;
                  return (
                    <Button
                      key={option}
                      type="button"
                      size="sm"
                      variant={active ? "primary" : "outline"}
                      onClick={() => toggleAnswer(questionNumber, option)}
                      title={`第 ${questionNumber} 题 ${option} 选项`}
                    >
                      {option}
                    </Button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 题块级设置 */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="起始题号">
          <Input type="number" min={1} value={block.questionStart} onChange={(event) => onChange((draft) => { const objective = draft as ObjectiveBlock; objective.questionStart = Number(event.target.value); objective.answerKey = normalizeObjectiveAnswerKey(objective); })} />
        </Field>
        <Field label="题目数">
          <Input type="number" min={1} max={120} value={block.questionCount} onChange={(event) => onChange((draft) => { const objective = draft as ObjectiveBlock; objective.questionCount = Number(event.target.value); objective.answerKey = normalizeObjectiveAnswerKey(objective); })} />
        </Field>
        <Field label="选项数">
          <Input type="number" min={2} max={8} value={block.optionCount} onChange={(event) => onChange((draft) => { const objective = draft as ObjectiveBlock; objective.optionCount = Number(event.target.value); objective.questions = normalizeObjectiveQuestions(objective); for (const q of objective.questions) { q.optionCount = objective.optionCount; } objective.answerKey = normalizeObjectiveAnswerKey(objective); })} />
        </Field>
        <Field label="每题分值">
          <Input type="number" min={0} step={0.5} value={block.scorePerQuestion} onChange={(event) => onChange((draft) => void ((draft as ObjectiveBlock).scorePerQuestion = Number(event.target.value)))} />
        </Field>
        <Field label="题型">
          <Select value={block.mode} onValueChange={(value) => onChange((draft) => { const objective = draft as ObjectiveBlock; objective.mode = value as ObjectiveMode; objective.questions = normalizeObjectiveQuestions(objective); for (const q of objective.questions) { q.mode = objective.mode; if (objective.mode !== "multiple" && objective.mode !== "indefinite") { delete q.scoringRule; } } objective.answerKey = normalizeObjectiveAnswerKey(objective); })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(modeLabels).map(([value, label]) => (<SelectItem key={value} value={value}>{label}</SelectItem>))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="选项排列">
          <Select value={block.optionLayout ?? "horizontal"} onValueChange={(value) => onChange((draft) => { (draft as ObjectiveBlock).optionLayout = value as ObjectiveOptionLayout; })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(optionLayoutLabels).map(([value, label]) => (<SelectItem key={value} value={value}>{label}</SelectItem>))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="少选1项得分">
          <Input type="number" step={0.5} value={block.multipleScoring?.partialScores[1] ?? 0} onChange={(event) => onChange((draft) => { const objective = draft as ObjectiveBlock; objective.multipleScoring ??= { partialScores: {}, wrongOrExtraScore: 0 }; objective.multipleScoring.partialScores[1] = Number(event.target.value); })} />
        </Field>
        <Field label="多选/错选得分">
          <Input type="number" step={0.5} value={block.multipleScoring?.wrongOrExtraScore ?? 0} onChange={(event) => onChange((draft) => { const objective = draft as ObjectiveBlock; objective.multipleScoring ??= { partialScores: {}, wrongOrExtraScore: 0 }; objective.multipleScoring.wrongOrExtraScore = Number(event.target.value); })} />
        </Field>
      </div>

      <div>
        <Button variant="ghost" size="sm" type="button" onClick={() => setShowPerQuestion(!showPerQuestion)}>
          {showPerQuestion ? "▲ 收起每题配置" : "▼ 展开每题配置"}
        </Button>
      </div>

      {showPerQuestion && (
        <Panel className="flex flex-col gap-3 border border-border-subtle">
          <div className="flex items-center justify-between">
            <strong className="text-sm text-foreground">每题配置</strong>
            <span className="text-xs text-muted-foreground">可混排单选、多选、不定项</span>
          </div>
          <div className="flex flex-col gap-3">
            {questionConfigs.map((question) => (
              <div key={question.questionNumber} className="flex flex-col gap-2 rounded-md border border-border-subtle p-3">
                <div className="text-sm font-medium text-foreground">第 {question.questionNumber} 题</div>
                <div className="grid grid-cols-3 gap-3">
                  <Field label="题号">
                    <Input type="number" min={1} value={question.questionNumber} onChange={(event) => updateQuestionConfig(question.questionNumber, (draft) => void (draft.questionNumber = Number(event.target.value)))} />
                  </Field>
                  <Field label="题型">
                    <Select value={question.mode} onValueChange={(value) => updateQuestionConfig(question.questionNumber, (draft) => { draft.mode = value as ObjectiveMode; if (draft.mode === "single") draft.scoringRule = undefined; })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Object.entries(modeLabels).map(([value, label]) => (<SelectItem key={value} value={value}>{label}</SelectItem>))}
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
                    <div className="grid grid-cols-2 gap-3">
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
                          <div key={correctCount} className="grid grid-cols-[84px_1fr] gap-2 items-center">
                            <span className="text-xs text-secondary-foreground tabular-nums">{correctCount} 个答案</span>
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
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox checked={(scoringRuleFor(question) as any).allowWrongOptions === true} onCheckedChange={(checked) => updateAllowWrongOptions(question.questionNumber, checked === true)} />
                      错选但未超过正确答案数时，只按选对项给分
                    </label>
                  </>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      <p className="text-xs text-muted-foreground">横向模式少于 15 题按行排列、15 题及以上按 5 题小组网格排列；竖向模式按高考 AB 卡式 4 题一组纵向排布，每题选项仍保持横向小组选项。超过 5 个选项的题目独占一行。</p>
    </Panel>
  );
}
'''

src = src[:start] + new_return + src[end:]
open(path, "w", encoding="utf-8").write(src)
print("ObjectiveEditor migrated. new file size:", len(src))
