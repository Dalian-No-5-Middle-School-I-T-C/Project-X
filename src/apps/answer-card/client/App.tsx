import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  FileDown,
  ImagePlus,
  ListPlus,
  Plus,
  Save,
  ScanLine,
  SquarePen,
  Trash2
} from "lucide-react";
import ScanPanel from "./ScanPanel";
import type {
  AnswerCard,
  BodyBlock,
  CardSummary,
  LayoutDocument,
  ObjectiveBlock,
  ObjectiveMode,
  PageRenderBlock,
  SubjectiveBlock,
  SubjectiveKind,
  SubjectiveQuestion,
  SubjectiveStyle
} from "../../../shared/types";
import { buildLayout } from "../../../shared/layout";
import { createBlockId } from "../../../shared/defaultCard";

const modeLabels: Record<ObjectiveMode, string> = {
  single: "单选",
  multiple: "多选",
  indefinite: "不定项"
};

const styleLabels: Record<SubjectiveStyle, string> = {
  manual_score_grid: "带顶部分数填涂区",
  plain_subjective: "纯主观题书写块"
};

const kindLabels: Record<SubjectiveKind, string> = {
  blank: "填空",
  lined_answer: "横线格",
  plain_box: "空白大框"
};

function cloneCard(card: AnswerCard): AnswerCard {
  return JSON.parse(JSON.stringify(card)) as AnswerCard;
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return (await response.json()) as T;
}

function defaultObjective(start: number): ObjectiveBlock {
  return {
    id: createBlockId("obj"),
    type: "objective",
    title: "客观题",
    questionStart: start,
    questionCount: 10,
    optionCount: 4,
    mode: "single",
    scorePerQuestion: 5,
    density: "compact",
    answerKey: {},
    multipleScoring: {
      partialScores: { 1: 2, 2: 4 },
      wrongOrExtraScore: 0
    }
  };
}

function defaultSubjective(nextNumber: number): SubjectiveBlock {
  return {
    id: createBlockId("subj"),
    type: "subjective",
    title: "主观题",
    questions: [
      {
        id: createBlockId("q"),
        number: nextNumber,
        score: 12,
        style: "manual_score_grid",
        kind: "plain_box",
        lineGrid: { enabled: false, lineSpacingMm: 8 },
        images: [],
        minHeightMm: 62
      }
    ]
  };
}

function findNextQuestionNumber(card: AnswerCard): number {
  let max = 0;
  for (const block of card.bodyBlocks) {
    if (block.type === "objective") max = Math.max(max, block.questionStart + block.questionCount - 1);
    if (block.type === "subjective") {
      for (const question of block.questions) max = Math.max(max, question.number);
    }
  }
  return max + 1;
}

function App() {
  const [cards, setCards] = useState<CardSummary[]>([]);
  const [card, setCard] = useState<AnswerCard | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [status, setStatus] = useState("准备就绪");
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [activeView, setActiveView] = useState<"design" | "scan">("design");

  const layout = useMemo<LayoutDocument | null>(() => (card ? buildLayout(card) : null), [card]);

  useEffect(() => {
    void refreshCards(true);
  }, []);

  async function refreshCards(loadFirst = false) {
    const list = await fetchJson<CardSummary[]>("/api/cards");
    setCards(list);
    if (loadFirst && list.length > 0) {
      await loadCard(list[0].id);
    }
  }

  async function createCard() {
    setIsBusy(true);
    try {
      const created = await fetchJson<AnswerCard>("/api/cards", { method: "POST" });
      setCard(created);
      setSelectedBlockId(created.bodyBlocks[0]?.id ?? null);
      setStatus(`已创建答题卡 ${created.id}`);
      await refreshCards();
    } catch (err) {
      let msg = "未知错误";
      if (err instanceof Error) {
        try {
          const parsed = JSON.parse(err.message);
          msg = parsed.message || err.message;
        } catch {
          msg = err.message;
        }
      }
      setError(`创建答题卡失败: ${msg}`);
      console.error("创建答题卡失败:", err);
    } finally {
      setIsBusy(false);
    }
  }

  async function loadCard(id: string) {
    setIsBusy(true);
    try {
      const loaded = await fetchJson<AnswerCard>(`/api/cards/${id}`);
      setCard(loaded);
      setSelectedBlockId(loaded.bodyBlocks[0]?.id ?? null);
      setStatus(`已载入 ${loaded.title}`);
    } finally {
      setIsBusy(false);
    }
  }

  async function saveCard() {
    if (!card) return;
    setIsBusy(true);
    try {
      const saved = await fetchJson<AnswerCard>(`/api/cards/${card.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(card)
      });
      setCard(saved);
      setStatus("已保存，并生成坐标布局数据");
      await refreshCards();
    } finally {
      setIsBusy(false);
    }
  }

  function updateCard(mutator: (draft: AnswerCard) => void) {
    if (!card) return;
    const draft = cloneCard(card);
    mutator(draft);
    setCard(draft);
  }

  function updateBlock(blockId: string, mutator: (block: BodyBlock) => void) {
    updateCard((draft) => {
      const block = draft.bodyBlocks.find((item) => item.id === blockId);
      if (block) mutator(block);
    });
  }

  function moveBlock(blockId: string, direction: -1 | 1) {
    updateCard((draft) => {
      const index = draft.bodyBlocks.findIndex((item) => item.id === blockId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= draft.bodyBlocks.length) return;
      const [block] = draft.bodyBlocks.splice(index, 1);
      draft.bodyBlocks.splice(nextIndex, 0, block);
    });
  }

  function removeBlock(blockId: string) {
    updateCard((draft) => {
      draft.bodyBlocks = draft.bodyBlocks.filter((item) => item.id !== blockId);
      if (selectedBlockId === blockId) setSelectedBlockId(draft.bodyBlocks[0]?.id ?? null);
    });
  }

  function addObjectiveBlock(afterIndex?: number) {
    if (!card) return;
    const block = defaultObjective(findNextQuestionNumber(card));
    updateCard((draft) => {
      const index = afterIndex ?? draft.bodyBlocks.length - 1;
      draft.bodyBlocks.splice(index + 1, 0, block);
    });
    setSelectedBlockId(block.id);
  }

  function addSubjectiveBlock() {
    if (!card) return;
    const block = defaultSubjective(findNextQuestionNumber(card));
    updateCard((draft) => {
      draft.bodyBlocks.push(block);
    });
    setSelectedBlockId(block.id);
  }

  async function uploadImage(blockId: string, questionId: string, file: File) {
    if (!card) return;
    const form = new FormData();
    form.append("file", file);
    const uploaded = await fetchJson<{ assetId: string; originalName: string }>(`/api/cards/${card.id}/assets`, {
      method: "POST",
      body: form
    });
    updateBlock(blockId, (block) => {
      if (block.type !== "subjective") return;
      const question = block.questions.find((item) => item.id === questionId);
      if (!question) return;
      question.images = [
        ...(question.images ?? []),
        {
          assetId: uploaded.assetId,
          originalName: uploaded.originalName,
          widthMm: 48,
          heightMm: 28,
          align: "left"
        }
      ];
    });
    setStatus("图片已加入主观题，保存后写入答题卡配置");
  }

  const selectedBlock = card?.bodyBlocks.find((block) => block.id === selectedBlockId) ?? null;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div>
            <strong>答题卡设计系统</strong>
            <span>Project-X v1</span>
          </div>
        </div>
        <div className="nav-tabs">
          <button
            className={`nav-tab ${activeView === "design" ? "active" : ""}`}
            onClick={() => setActiveView("design")}
          >
            <SquarePen size={16} /> 设计
          </button>
          <button
            className={`nav-tab ${activeView === "scan" ? "active" : ""}`}
            onClick={() => setActiveView("scan")}
          >
            <ScanLine size={16} /> 扫描
          </button>
        </div>
        {activeView === "design" && (
          <button className="primary-button" onClick={createCard} disabled={isBusy}>
            <Plus size={17} /> 新建答题卡
          </button>
        )}
        <div className="card-list">
          {cards.map((item) => (
            <button
              key={item.id}
              className={`card-list-item ${card?.id === item.id ? "active" : ""}`}
              onClick={() => void loadCard(item.id)}
            >
              <span>{item.title}</span>
              <small>ID:{item.id}</small>
            </button>
          ))}
          {cards.length === 0 && <p className="empty-text">暂无答题卡，先新建一张。</p>}
        </div>
      </aside>

      <section className="workspace">
        {error && (
          <div className="error-banner">
            <span className="error-banner-text">{error}</span>
            <button className="error-banner-close" onClick={() => setError(null)}>✕</button>
          </div>
        )}
        {activeView === "scan" ? (
          <ScanPanel />
        ) : (
          <>
            <header className="topbar">
          <div>
            <h1>{card?.title ?? "答题卡设计器"}</h1>
            <p>{card ? `ID:${card.id} · ${layout?.pages.length ?? 1} 页 · ${layout?.elements.length ?? 0} 个坐标元素` : "创建答题卡后开始编辑"}</p>
          </div>
          <div className="topbar-actions">
            {card && (
              <>
                <a className="ghost-button" href={`/api/cards/${card.id}/layout`} target="_blank" rel="noreferrer">
                  坐标JSON
                </a>
                <a className="ghost-button" href={`/api/cards/${card.id}/pdf?v=${encodeURIComponent(card.updatedAt)}`} target="_blank" rel="noreferrer">
                  <FileDown size={17} /> PDF
                </a>
                <button className="primary-button" onClick={() => void saveCard()} disabled={isBusy}>
                  <Save size={17} /> 保存
                </button>
              </>
            )}
          </div>
        </header>

        <div className="main-grid">
          <section className="preview-panel">
            {card && layout ? <CardPreview card={card} layout={layout} /> : <div className="blank-preview">选择或新建答题卡</div>}
          </section>

          <aside className="inspector">
            {card ? (
              <>
                <section className="panel">
                  <div className="panel-title">
                    <SquarePen size={17} /> 基本信息
                  </div>
                  <label>
                    标题
                    <input value={card.title} onChange={(event) => updateCard((draft) => void (draft.title = event.target.value))} />
                  </label>
                  <label>
                    学号位数
                    <input
                      type="number"
                      min={1}
                      max={12}
                      value={card.studentInfo.studentNumberDigits}
                      onChange={(event) =>
                        updateCard((draft) => void (draft.studentInfo.studentNumberDigits = Number(event.target.value)))
                      }
                    />
                  </label>
                </section>

                <section className="panel">
                  <div className="panel-title">
                    <ListPlus size={17} /> 正文题块
                  </div>
                  <div className="block-list">
                    {card.bodyBlocks.map((block, index) => (
                      <div key={block.id} className={`block-chip ${selectedBlockId === block.id ? "active" : ""}`}>
                        <button onClick={() => setSelectedBlockId(block.id)}>
                          <strong>{block.type === "objective" ? "客观题" : "主观题"}</strong>
                          <span>{block.title}</span>
                        </button>
                        <div className="chip-actions">
                          <button title="上移" onClick={() => moveBlock(block.id, -1)} disabled={index === 0}>
                            <ArrowUp size={15} />
                          </button>
                          <button title="下移" onClick={() => moveBlock(block.id, 1)} disabled={index === card.bodyBlocks.length - 1}>
                            <ArrowDown size={15} />
                          </button>
                          <button title="在后面插入客观题" onClick={() => addObjectiveBlock(index)}>
                            <Plus size={15} />
                          </button>
                          <button title="删除" onClick={() => removeBlock(block.id)}>
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="split-actions">
                    <button className="ghost-button" onClick={() => addObjectiveBlock()}>
                      <Plus size={16} /> 客观题块
                    </button>
                    <button className="ghost-button" onClick={addSubjectiveBlock}>
                      <Plus size={16} /> 主观题块
                    </button>
                  </div>
                </section>

                {selectedBlock && (
                  <section className="panel">
                    {selectedBlock.type === "objective" ? (
                      <ObjectiveEditor block={selectedBlock} onChange={(mutator) => updateBlock(selectedBlock.id, mutator)} />
                    ) : (
                      <SubjectiveEditor block={selectedBlock} onChange={(mutator) => updateBlock(selectedBlock.id, mutator)} onUpload={uploadImage} />
                    )}
                  </section>
                )}

                {layout?.warnings.length ? (
                  <section className="panel warning-panel">
                    {layout.warnings.map((warning) => (
                      <p key={warning}>{warning}</p>
                    ))}
                  </section>
                ) : null}
              </>
            ) : (
              <div className="empty-text">请新建或载入答题卡。</div>
            )}
          </aside>
        </div>
        <footer className="statusbar">{status}</footer>
          </>
        )}
      </section>
    </main>
  );
}

function ObjectiveEditor({ block, onChange }: { block: ObjectiveBlock; onChange: (mutator: (block: BodyBlock) => void) => void }) {
  return (
    <>
      <div className="panel-title">客观题机器阅卷块</div>
      <label>
        标题
        <input value={block.title} onChange={(event) => onChange((draft) => void (draft.title = event.target.value))} />
      </label>
      <div className="two-col">
        <label>
          起始题号
          <input type="number" min={1} value={block.questionStart} onChange={(event) => onChange((draft) => void ((draft as ObjectiveBlock).questionStart = Number(event.target.value)))} />
        </label>
        <label>
          题目数
          <input type="number" min={1} max={120} value={block.questionCount} onChange={(event) => onChange((draft) => void ((draft as ObjectiveBlock).questionCount = Number(event.target.value)))} />
        </label>
      </div>
      <div className="two-col">
        <label>
          选项数
          <input type="number" min={2} max={8} value={block.optionCount} onChange={(event) => onChange((draft) => void ((draft as ObjectiveBlock).optionCount = Number(event.target.value)))} />
        </label>
        <label>
          每题分值
          <input type="number" min={0} step={0.5} value={block.scorePerQuestion} onChange={(event) => onChange((draft) => void ((draft as ObjectiveBlock).scorePerQuestion = Number(event.target.value)))} />
        </label>
      </div>
      <label>
        题型
        <select value={block.mode} onChange={(event) => onChange((draft) => void ((draft as ObjectiveBlock).mode = event.target.value as ObjectiveMode))}>
          {Object.entries(modeLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
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
      <p className="hint">客观题使用固定紧凑排版，填涂框尺寸保持一致。</p>
    </>
  );
}

function SubjectiveEditor({
  block,
  onChange,
  onUpload
}: {
  block: SubjectiveBlock;
  onChange: (mutator: (block: BodyBlock) => void) => void;
  onUpload: (blockId: string, questionId: string, file: File) => Promise<void>;
}) {
  function updateQuestion(questionId: string, mutator: (question: SubjectiveQuestion) => void) {
    onChange((draft) => {
      if (draft.type !== "subjective") return;
      const question = draft.questions.find((item) => item.id === questionId);
      if (question) mutator(question);
    });
  }

  return (
    <>
      <div className="panel-title">主观题块</div>
      <label>
        标题
        <input value={block.title} onChange={(event) => onChange((draft) => void (draft.title = event.target.value))} />
      </label>
      {block.questions.map((question) => (
        <div className="question-editor" key={question.id}>
          <div className="question-editor-title">
            <strong>第 {question.number} 题</strong>
            <button
              title="删除小题"
              onClick={() =>
                onChange((draft) => {
                  if (draft.type === "subjective") draft.questions = draft.questions.filter((item) => item.id !== question.id);
                })
              }
            >
              <Trash2 size={15} />
            </button>
          </div>
          <div className="two-col">
            <label>
              题号
              <input type="number" min={1} value={question.number} onChange={(event) => updateQuestion(question.id, (draft) => void (draft.number = Number(event.target.value)))} />
            </label>
            <label>
              分值
              <input type="number" min={0} step={0.5} value={question.score} onChange={(event) => updateQuestion(question.id, (draft) => void (draft.score = Number(event.target.value)))} />
            </label>
          </div>
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
          <label>
            作答区类型
            <select value={question.kind} onChange={(event) => updateQuestion(question.id, (draft) => void (draft.kind = event.target.value as SubjectiveKind))}>
              {Object.entries(kindLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            最小高度(mm)
            <input type="number" min={24} max={220} value={question.minHeightMm} onChange={(event) => updateQuestion(question.id, (draft) => void (draft.minHeightMm = Number(event.target.value)))} />
          </label>
          {question.kind === "blank" && (
            <div className="three-col">
              <label>
                空数
                <input type="number" min={1} value={question.blanks?.count ?? 4} onChange={(event) => updateQuestion(question.id, (draft) => void (draft.blanks = { ...(draft.blanks ?? { widthMm: 28, heightMm: 6 }), count: Number(event.target.value) }))} />
              </label>
              <label>
                宽
                <input type="number" min={8} value={question.blanks?.widthMm ?? 28} onChange={(event) => updateQuestion(question.id, (draft) => void (draft.blanks = { ...(draft.blanks ?? { count: 4, heightMm: 6 }), widthMm: Number(event.target.value) }))} />
              </label>
              <label>
                高
                <input type="number" min={4} value={question.blanks?.heightMm ?? 6} onChange={(event) => updateQuestion(question.id, (draft) => void (draft.blanks = { ...(draft.blanks ?? { count: 4, widthMm: 28 }), heightMm: Number(event.target.value) }))} />
              </label>
            </div>
          )}
          <label className="check-row">
            <input
              type="checkbox"
              checked={question.lineGrid?.enabled ?? false}
              onChange={(event) => updateQuestion(question.id, (draft) => void (draft.lineGrid = { ...(draft.lineGrid ?? { lineSpacingMm: 8 }), enabled: event.target.checked }))}
            />
            使用横线格
          </label>
          <label>
            横线间距(mm)
            <input
              type="number"
              min={5}
              max={16}
              value={question.lineGrid?.lineSpacingMm ?? 8}
              onChange={(event) => updateQuestion(question.id, (draft) => void (draft.lineGrid = { ...(draft.lineGrid ?? { enabled: true }), lineSpacingMm: Number(event.target.value) }))}
            />
          </label>
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
          {(question.images ?? []).map((image, index) => (
            <div className="image-row" key={`${image.assetId}_${index}`}>
              <span>{image.originalName ?? image.assetId}</span>
              <input type="number" min={10} value={image.widthMm} onChange={(event) => updateQuestion(question.id, (draft) => void ((draft.images![index].widthMm = Number(event.target.value))))} />
              <input type="number" min={10} value={image.heightMm} onChange={(event) => updateQuestion(question.id, (draft) => void ((draft.images![index].heightMm = Number(event.target.value))))} />
            </div>
          ))}
        </div>
      ))}
      <button
        className="ghost-button"
        onClick={() =>
          onChange((draft) => {
            if (draft.type !== "subjective") return;
            const next = Math.max(0, ...draft.questions.map((item) => item.number)) + 1;
            draft.questions.push(defaultSubjective(next).questions[0]);
          })
        }
      >
        <Plus size={16} /> 添加主观小题
      </button>
    </>
  );
}

function CardPreview({ card, layout }: { card: AnswerCard; layout: LayoutDocument }) {
  return (
    <div className="pages">
      {layout.pages.map((page) => (
        <svg className="page" key={page.pageNumber} viewBox="0 0 210 297" role="img" aria-label={`第${page.pageNumber}页预览`}>
          <rect x="0" y="0" width="210" height="297" fill="#fff" />
          {page.markers.map((marker) => (
            <rect key={marker.role} {...marker.rect} fill="#20342f" />
          ))}
          <text x={page.header.idTextX} y={page.header.idTextY} className="svg-small">
            ID:{page.header.id}
          </text>
          {page.header.codeBoxes.map((box, index) => (
            <rect key={index} {...box} fill={index === 0 || index === page.header.codeBoxes.length - 1 ? "#20342f" : "#fff"} stroke="#222" strokeWidth="0.25" />
          ))}
          {page.header.title && (
            <text x="105" y={page.header.titleY} textAnchor="middle" className="svg-title">
              {page.header.title}
            </text>
          )}
          {page.studentArea && <StudentAreaSvg area={page.studentArea} />}
          {page.blocks.map((block, index) =>
            block.type === "objective" ? <ObjectiveSvg block={block} key={`${block.blockId}_${index}`} /> : <SubjectiveSvg card={card} block={block} key={`${block.blockId}_${index}`} />
          )}
          <text x="105" y="284" textAnchor="middle" className="svg-footer">
            第{page.pageNumber}页/共{layout.pages.length}页
          </text>
        </svg>
      ))}
    </div>
  );
}

function StudentAreaSvg({ area }: { area: NonNullable<LayoutDocument["pages"][number]["studentArea"]> }) {
  const rowCount = Math.max(...area.digitCells.map((cell) => cell.digitIndex)) + 1;
  return (
    <g>
      <rect {...area.infoRect} fill="none" stroke="#333" strokeWidth="0.25" />
      <rect {...area.digitRect} fill="none" stroke="#333" strokeWidth="0.25" />
      <text x={area.digitRect.x + area.digitRect.width / 2} y={area.digitRect.y + 5.2} textAnchor="middle" className="svg-label">
        填涂号区
      </text>
      <text x={area.infoRect.x + 5} y={area.infoRect.y + 13.5} className="svg-label">
        姓名：
      </text>
      <line x1={area.infoRect.x + 18} y1={area.infoRect.y + 14.5} x2={area.infoRect.x + area.infoRect.width - 9} y2={area.infoRect.y + 14.5} stroke="#333" strokeWidth="0.25" />
      <text x={area.infoRect.x + 5} y={area.infoRect.y + 25.5} className="svg-label">
        班级：
      </text>
      <line x1={area.infoRect.x + 18} y1={area.infoRect.y + 26.5} x2={area.infoRect.x + area.infoRect.width - 9} y2={area.infoRect.y + 26.5} stroke="#333" strokeWidth="0.25" />
      {Array.from({ length: rowCount }).map((_, row) => (
        <line key={row} x1={area.digitRect.x} y1={area.digitRect.y + 7 + row * 4.8} x2={area.digitRect.x + area.digitRect.width} y2={area.digitRect.y + 7 + row * 4.8} stroke="#999" strokeWidth="0.15" />
      ))}
      {area.digitCells.map((cell) => (
        <g key={`${cell.digitIndex}_${cell.digit}`}>
          <rect {...cell.rect} fill="#fff" stroke="#333" strokeWidth="0.15" />
          <text x={cell.rect.x + cell.rect.width / 2} y={cell.rect.y + 2.15} textAnchor="middle" className="svg-tiny">
            {cell.digit}
          </text>
        </g>
      ))}
    </g>
  );
}

function ObjectiveSvg({ block }: { block: Extract<PageRenderBlock, { type: "objective" }> }) {
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
          <text x={item.labelX - 2.5} y={item.labelY} className="svg-tiny">
            {item.questionNumber}
          </text>
          {item.options.map((option) => (
            <g key={option.label}>
              <rect {...option.rect} fill="#fff" stroke="#333" strokeWidth="0.15" />
              <text x={option.rect.x + option.rect.width / 2} y={option.rect.y + 2.05} textAnchor="middle" className="svg-tiny">
                {option.label}
              </text>
            </g>
          ))}
        </g>
      ))}
    </g>
  );
}

function SubjectiveSvg({ card, block }: { card: AnswerCard; block: Extract<PageRenderBlock, { type: "subjective" }> }) {
  return (
    <g>
      {block.title && (
        <text x={block.rect.x} y={block.rect.y + 4.4} className="svg-section">
          {block.title}
        </text>
      )}
      {block.questions.map((question) => (
        <g key={question.questionId}>
          <rect {...question.rect} fill="none" stroke="#222" strokeWidth="0.25" />
          {question.style === "manual_score_grid" && (
            <>
              <line x1={question.rect.x} y1={question.contentRect.y} x2={question.rect.x + question.rect.width} y2={question.contentRect.y} stroke="#777" strokeWidth="0.2" strokeDasharray="1.5 1.5" />
              {question.scoreCells.map((cell) => (
                <g key={cell.score}>
                  <rect {...cell.rect} fill="#fff" stroke="#222" strokeWidth="0.2" />
                  <text x={cell.rect.x + cell.rect.width / 2} y={cell.rect.y + 4.2} textAnchor="middle" className="svg-tiny">
                    {cell.score}
                  </text>
                </g>
              ))}
            </>
          )}
          <text x={question.rect.x + 2} y={question.contentRect.y + 6} className="svg-tiny">
            {question.questionNumber}.（{question.score}分）
          </text>
          {question.lineYs.map((lineY) => (
            <line key={lineY} x1={question.contentRect.x + 8} y1={lineY} x2={question.contentRect.x + question.contentRect.width - 6} y2={lineY} stroke="#888" strokeWidth="0.2" />
          ))}
          {question.blanks.map((blank, index) => (
            <g key={index}>
              <text x={blank.x - 6} y={blank.y + 4.2} className="svg-tiny">
                {question.questionNumber}.{index + 1}
              </text>
              <line x1={blank.x} y1={blank.y + blank.height} x2={blank.x + blank.width} y2={blank.y + blank.height} stroke="#333" strokeWidth="0.25" />
            </g>
          ))}
          {question.images.map((image) => (
            <g key={image.assetId}>
              <image href={`/assets/${card.id}/${image.assetId}`} x={image.rect.x} y={image.rect.y} width={image.rect.width} height={image.rect.height} preserveAspectRatio="xMidYMid meet" />
              <rect {...image.rect} fill="none" stroke="#666" strokeWidth="0.18" />
            </g>
          ))}
        </g>
      ))}
    </g>
  );
}

export default App;
