// GradingPage — 从 App.tsx 抽出的「阅卷」页面（props 透传范式，行为不变）。
// 与 DesignPage / ExamManagePage 一致：所有状态/handler 由 App 通过 props 传入，组件本身不持有状态。
// GradingResults 由 App 渲染后以 resultsNode 传入，避免循环依赖。
import React from "react";
import type { Dispatch, SetStateAction, ReactNode } from "react";
import { ClipboardCheck, Upload, FolderOpen } from "lucide-react";
import type { AnswerCard, CardSummary, ExamRecord } from "../../../../shared/types";

interface Props {
  active: boolean;
  resultsNode: ReactNode;
  gradingExamId: string;
  setGradingExamId: Dispatch<SetStateAction<string>>;
  setCardOverride: Dispatch<SetStateAction<boolean>>;
  cardOverride: boolean;
  exams: ExamRecord[];
  card: AnswerCard | null;
  loadCard: (id: string) => Promise<void>;
  cards: CardSummary[];
  isBusy: boolean;
  directoryInputProps: Record<string, string>;
  addGradingFiles: (files: FileList | null) => void;
  gradingFiles: File[];
  setGradingFiles: Dispatch<SetStateAction<File[]>>;
  gradeAnswerCardFiles: () => Promise<void>;
  gradingProgress: { active: boolean; finished: number; total: number };
}

export function GradingPage({
  active,
  resultsNode,
  gradingExamId,
  setGradingExamId,
  setCardOverride,
  cardOverride,
  exams,
  card,
  loadCard,
  cards,
  isBusy,
  directoryInputProps,
  addGradingFiles,
  gradingFiles,
  setGradingFiles,
  gradeAnswerCardFiles,
  gradingProgress
}: Props) {
  return (
    <div className={`main-grid grading-grid ${active ? "" : "hidden-panel"}`}>
      <section className="preview-panel grading-results-panel">
        {resultsNode}
      </section>

      <aside className="inspector">
        <section className="panel">
          <div className="panel-title">
            <ClipboardCheck size={17} /> 阅卷设置
          </div>
          <label>
            考试
            <select
              value={gradingExamId}
              onChange={async (e) => {
                const examId = e.target.value;
                setGradingExamId(examId);
                setCardOverride(false);  // 切换考试时重置覆盖状态
                if (examId) {
                  // 自动加载考试关联的答题卡
                  const exam = exams.find((ex) => String(ex.id) === examId);
                  if (exam?.card_id && exam.card_id !== card?.id) {
                    await loadCard(exam.card_id);
                  }
                }
              }}
            >
              <option value="">不关联考试</option>
              {exams.map((exam) => (
                <option key={exam.id} value={String(exam.id)}>
                  {exam.name} {exam.subject ? `(${exam.subject})` : ""}
                </option>
              ))}
            </select>
          </label>
          {gradingExamId && card ? (
            // 已选考试 → 只读展示关联答题卡，可手动覆盖
            <div>
              <label style={{ marginBottom: 4 }}>关联答题卡</label>
              {cardOverride ? (
                <select
                  value={card?.id ?? ""}
                  onChange={(e) => { void loadCard(e.target.value); setCardOverride(false); }}
                  disabled={isBusy}
                >
                  {cards.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title} / {item.id}
                    </option>
                  ))}
                </select>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "var(--surface-soft)", borderRadius: 6 }}>
                  <span style={{ fontSize: 13, flex: 1 }}>{card.title} / {card.id}</span>
                  <button className="link-button" type="button" onClick={() => setCardOverride(true)} disabled={isBusy} style={{ fontSize: 12, padding: "2px 8px" }}>
                    换答题卡
                  </button>
                </div>
              )}
              <p className="hint" style={{ marginTop: 4 }}>答题卡已根据所选考试自动关联</p>
            </div>
          ) : (
            // 未选考试 → 独立选择答题卡（裸阅卷场景）
            <label>
              答题卡
              <select value={card?.id ?? ""} onChange={(event) => void loadCard(event.target.value)} disabled={isBusy || cards.length === 0}>
                <option value="" disabled>
                  请选择答题卡
                </option>
                {cards.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title} / {item.id}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="split-actions">
            <label className="upload-button">
              <Upload size={16} /> 导入图片
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={(event) => {
                  addGradingFiles(event.target.files);
                  event.currentTarget.value = "";
                }}
              />
            </label>
            <label className="upload-button">
              <FolderOpen size={16} /> 导入目录
              <input
                type="file"
                accept="image/*"
                multiple
                {...directoryInputProps}
                onChange={(event) => {
                  addGradingFiles(event.target.files);
                  event.currentTarget.value = "";
                }}
              />
            </label>
          </div>
          <div className="file-queue">
            <div>
              <strong>{gradingFiles.length}</strong>
              <span>张待阅卷图片</span>
            </div>
            <button className="ghost-button" type="button" onClick={() => setGradingFiles([])} disabled={gradingFiles.length === 0 || isBusy}>
              清空
            </button>
          </div>
          {gradingFiles.length > 0 && (
            <div className="queued-files">
              {gradingFiles.slice(0, 8).map((file) => (
                <span key={`${file.name}_${file.size}_${file.lastModified}`}>{file.webkitRelativePath || file.name}</span>
              ))}
              {gradingFiles.length > 8 && <span>还有 {gradingFiles.length - 8} 张...</span>}
            </div>
          )}
          <button className="primary-button wide-button" onClick={() => void gradeAnswerCardFiles()} disabled={!card || gradingFiles.length === 0 || isBusy}>
            <ClipboardCheck size={17} /> 开始识别并判分
          </button>
          {gradingProgress.active && (
            <div className="grading-progress">
              <div className="grading-progress-text">
                识别答题卡，已识别 {gradingProgress.finished}/{gradingProgress.total} 张
              </div>
              <div className="grading-progress-track">
                <div
                  className="grading-progress-fill"
                  style={{
                    width: `${gradingProgress.total > 0 ? Math.min(100, (gradingProgress.finished / gradingProgress.total) * 100) : 0}%`
                  }}
                />
              </div>
            </div>
          )}
          <p className="hint">低置信题会标记待复核；学号未识别时仍保留成绩行。</p>
        </section>
      </aside>
    </div>
  );
}
