// DesignPage — 从 App.tsx 抽出的「答题卡设计」页面（B2：改由 useWorkspace 消费共享状态）。
// 编辑器组件（CardPreview/ObjectiveEditor/SubjectiveEditor）直接由 DesignEditors 导入；
// 不再由 App 透传 props，行为与抽离前完全一致。
import { SquarePen, ListPlus, ArrowUp, ArrowDown, Plus, Trash2 } from "lucide-react";
import { useWorkspace } from "../WorkspaceContext";
import { CardPreview, ObjectiveEditor, SubjectiveEditor } from "./DesignEditors";
import { DEFAULT_STUDENT_NOTES } from "../../../../shared/defaultCard";

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
    <div className={`main-grid ${active ? "" : "hidden-panel"}`}>
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
              {card.subjectLabel && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", fontSize: 13, color: "var(--text-secondary)" }}>
                  <span>科目</span>
                  <span style={{ fontWeight: 600, color: "var(--text)" }}>{card.subjectLabel}</span>
                </div>
              )}
              {card.examDate && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", fontSize: 13, color: "var(--text-secondary)" }}>
                  <span>考试时间</span>
                  <span style={{ fontWeight: 600, color: "var(--text)" }}>{card.examDate}</span>
                </div>
              )}
              <label>
                答题卡纸型
                <select
                  value={card.paper?.size ?? "A4"}
                  onChange={(event) =>
                    updateCard((draft) => {
                      const size = event.target.value as "A4" | "A3";
                      draft.paper = { size, orientation: size === "A3" ? "landscape" : "portrait" };
                    })
                  }
                >
                  <option value="A4">A4 纵向</option>
                  <option value="A3">A3 横向三版</option>
                </select>
              </label>
              {card.layoutVersion !== 2 && (
                <div className="layout-version-banner" role="note">
                  <strong>当前使用 V1 兼容排版</strong>
                  <span>旧打印件仍按原分数格坐标识别。升级后将使用紧凑分数区和更大的作答空间。</span>
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => {
                      if (!confirm("升级到 V2 后，已经打印的旧答题卡不能再按此卡片的新坐标识别。确认升级并立即重排吗？")) return;
                      updateCard((draft) => void (draft.layoutVersion = 2));
                    }}
                  >
                    升级到紧凑排版 V2
                  </button>
                </div>
              )}
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

              <div style={{ marginTop: 4 }}>
                <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 6 }}>基本信息字段</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 12px" }}>
                  {[
                    { key: "showName", label: "姓名" },
                    { key: "showClass", label: "班级" },
                    { key: "showSeat", label: "座位号" },
                    { key: "showExamNumber", label: "考号" },
                    { key: "showStudentNumber", label: "学号（填涂号区）" }
                  ].map((item) => (
                    <label key={item.key} className="check-row" style={{ fontSize: 12 }}>
                      <input
                        type="checkbox"
                        checked={card.studentInfo[item.key as keyof typeof card.studentInfo] === true}
                        onChange={(event) =>
                          updateCard((draft) => {
                            (draft.studentInfo as unknown as Record<string, boolean | undefined>)[item.key] = event.target.checked;
                          })
                        }
                      />
                      {item.label}
                    </label>
                  ))}
                </div>
              </div>

              <label className="check-row" style={{ marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={card.studentInfo.showNotes === true}
                  onChange={(event) =>
                    updateCard((draft) => {
                      draft.studentInfo.showNotes = event.target.checked;
                      if (event.target.checked && !draft.studentInfo.notesText) {
                        draft.studentInfo.notesText = DEFAULT_STUDENT_NOTES;
                      }
                    })
                  }
                />
                显示注意事项
              </label>
              {card.studentInfo.showNotes === true && (
                <label style={{ marginTop: 4 }}>
                  注意事项内容
                  <textarea
                    rows={4}
                    value={card.studentInfo.notesText || DEFAULT_STUDENT_NOTES}
                    onChange={(event) =>
                      updateCard((draft) => void (draft.studentInfo.notesText = event.target.value))
                    }
                    style={{ fontSize: 12, resize: "vertical" }}
                  />
                </label>
              )}

              <label>
                答题卡面
                <select
                  value={card.sided ?? "double"}
                  onChange={(event) =>
                    updateCard((draft) => void (draft.sided = event.target.value as "single" | "double"))
                  }
                >
                  <option value="single">单面（仅正面有题）</option>
                  <option value="double">双面（正反面均有题）</option>
                </select>
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
                      <strong>{block.type === "objective" ? "客观题" : subjectiveBlockKindLabel(block)}</strong>
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
                <button className="ghost-button" onClick={addBlankBlock}>
                  <Plus size={16} /> 填空题块
                </button>
                <button className="ghost-button" onClick={addSubjectiveBlock}>
                  <Plus size={16} /> 解答题块
                </button>
                <button className="ghost-button" onClick={addEssayBlock}>
                  <Plus size={16} /> 作文块
                </button>
              </div>
            </section>

            {selectedBlock && (
              <section className="panel">
                {selectedBlock.type === "objective" ? (
                  <ObjectiveEditor block={selectedBlock} onChange={(mutator) => updateBlock(selectedBlock.id, mutator)} />
                ) : (
                  <SubjectiveEditor
                    block={selectedBlock}
                    card={card}
                    layoutVersion={card.layoutVersion}
                    onChange={(mutator) => updateBlock(selectedBlock.id, mutator)}
                    onUpload={uploadImage}
                  />
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
  );
}
