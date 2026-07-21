// ExamManagePage — 从 App.tsx 抽出的「考试管理」页面（props 透传范式，行为不变）。
// 与 DesignPage 保持一致：所有状态/handler 由 App 通过 props 传入，组件本身不持有状态。
import React from "react";
import type { Dispatch, SetStateAction } from "react";
import { Plus, Trash2, Layers } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { AnswerCard, CardSummary, ExamRecord } from "../../../../shared/types";
import type { AppMode, ExamDeleteTarget, ExamGroupSummary, GroupDeleteTarget } from "../WorkspaceContext";
import { ExamDetailPage } from "../components/ExamDetailPage";

interface Props {
  active: boolean;
  selectedExamId: number | null;
  setSelectedExamId: Dispatch<SetStateAction<number | null>>;
  examManageMode: "single" | "group";
  setExamManageMode: Dispatch<SetStateAction<"single" | "group">>;
  showCreateExam: boolean;
  setShowCreateExam: Dispatch<SetStateAction<boolean>>;
  showCreateGroup: boolean;
  setShowCreateGroup: Dispatch<SetStateAction<boolean>>;
  selectedExamIds: Set<number>;
  setSelectedExamIds: Dispatch<SetStateAction<Set<number>>>;
  newExamName: string;
  setNewExamName: Dispatch<SetStateAction<string>>;
  newExamSubject: string;
  setNewExamSubject: Dispatch<SetStateAction<string>>;
  newExamCardId: string;
  setNewExamCardId: Dispatch<SetStateAction<string>>;
  exams: ExamRecord[];
  examGroups: ExamGroupSummary[];
  loadExams: () => Promise<void>;
  loadExamGroups: () => Promise<void>;
  setExamDeleteTarget: Dispatch<SetStateAction<ExamDeleteTarget | null>>;
  setGroupDeleteTarget: Dispatch<SetStateAction<GroupDeleteTarget | null>>;
  setAssignedFormulaExamId: Dispatch<SetStateAction<number | null>>;
  cards: CardSummary[];
  card: AnswerCard | null;
  setStatus: Dispatch<SetStateAction<string>>;
  switchMode: (nextMode: AppMode, afterSwitch?: () => void | Promise<void>) => void;
  teacherId: number;
  teacherRole: string | null;
  userRole: string;
  onStartReview: (examId: number, blockId: string) => void;
}

export function ExamManagePage({
  active,
  selectedExamId,
  setSelectedExamId,
  examManageMode,
  setExamManageMode,
  showCreateExam,
  setShowCreateExam,
  showCreateGroup,
  setShowCreateGroup,
  selectedExamIds,
  setSelectedExamIds,
  newExamName,
  setNewExamName,
  newExamSubject,
  setNewExamSubject,
  newExamCardId,
  setNewExamCardId,
  exams,
  examGroups,
  loadExams,
  loadExamGroups,
  setExamDeleteTarget,
  setGroupDeleteTarget,
  setAssignedFormulaExamId,
  cards,
  card,
  setStatus,
  switchMode,
  teacherId,
  teacherRole,
  userRole,
  onStartReview,
}: Props) {
  return (
    <div className={`main-grid exam-manage-grid ${active ? "" : "hidden-panel"}`}>
      {selectedExamId ? (
        <section style={{ gridColumn: "1 / -1", padding: 0 }}>
          <ExamDetailPage examId={selectedExamId} teacherId={teacherId} teacherRole={teacherRole} userRole={userRole} onBackToList={() => setSelectedExamId(null)} onBackHome={() => switchMode("home")} onStartReview={onStartReview} />
        </section>
      ) : (
      <section className="preview-panel" style={{ gridColumn: "1 / -1", padding: 24, overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
          <strong style={{ fontSize: 16 }}>考试管理</strong>
          {examManageMode === "single" ? (
            <button className="primary-button" onClick={() => setShowCreateExam(!showCreateExam)}>
              <Plus size={16} /> 新建考试
            </button>
          ) : (
            <button className="primary-button" onClick={() => setShowCreateGroup(true)}>
              <Plus size={16} /> 新建大考
            </button>
          )}
          {examManageMode === "single" && selectedExamIds.size > 0 && (
            <button
              className="ghost-button"
              style={{ color: "var(--brand)" }}
              onClick={() => setExamDeleteTarget({
                exams: exams.filter((exam) => selectedExamIds.has(exam.id)),
                deleteLinkedCards: false
              })}
            >
              <Trash2 size={16} /> 删除选中 ({selectedExamIds.size})
            </button>
          )}
          {(examManageMode === "single" ? exams.length : examGroups.length) > 0 && (
            <span style={{ fontSize: 13, color: "var(--muted)" }}>
              共 {examManageMode === "single" ? exams.length : examGroups.length} {examManageMode === "single" ? "个考试" : "个大考"}
            </span>
          )}
          {/* Single/Group toggle — right side */}
          <div style={{ display: "flex", gap: 0, border: "1px solid var(--brand)", borderRadius: 6, overflow: "hidden", marginLeft: "auto" }}>
            <button onClick={() => setExamManageMode("single")} style={{
              padding: "5px 14px", border: "none", background: examManageMode === "single" ? "var(--brand)" : "var(--surface)",
              color: examManageMode === "single" ? "#fff" : "var(--text)", fontSize: 12, cursor: "pointer", fontWeight: examManageMode === "single" ? 600 : 400
            }}>单科考试</button>
            <button onClick={() => { setExamManageMode("group"); loadExamGroups(); }} style={{
              padding: "5px 14px", border: "none", background: examManageMode === "group" ? "var(--brand)" : "var(--surface)",
              color: examManageMode === "group" ? "#fff" : "var(--text)", fontSize: 12, cursor: "pointer", fontWeight: examManageMode === "group" ? 600 : 400,
              display: "flex", alignItems: "center", gap: 4
            }}><Layers size={13} /> 大考</button>
          </div>
        </div>

        {examManageMode === "single" && showCreateExam && (
          <div style={{ background: "var(--surface-soft)", borderRadius: 8, padding: 14, marginBottom: 16, display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 10, alignItems: "end" }}>
            <input value={newExamName} onChange={(e) => setNewExamName(e.target.value)} placeholder="考试名称" style={{ padding: "6px 10px", border: "1px solid var(--line-strong)", borderRadius: 4, fontSize: 13 }} />
            <input value={newExamSubject} onChange={(e) => setNewExamSubject(e.target.value)} placeholder="科目（自动从答题卡继承）" style={{ padding: "6px 10px", border: "1px solid var(--line-strong)", borderRadius: 4, fontSize: 13 }} />
            <select
              value={newExamCardId || card?.id || ""}
              onChange={(e) => {
                const selectedCardId = e.target.value;
                setNewExamCardId(selectedCardId);
                const selectedCard = cards.find((c) => c.id === selectedCardId);
                if (selectedCard) {
                  if (!newExamName) setNewExamName(selectedCard.title);
                  if (!newExamSubject) setNewExamSubject(selectedCard.subjectLabel || "");
                }
              }}
              style={{ padding: "6px 10px", border: "1px solid var(--line-strong)", borderRadius: 4, fontSize: 13 }}
            >
              <option value="" disabled>选择答题卡</option>
              {cards.map((c) => (<option key={c.id} value={c.id}>{c.title}</option>))}
            </select>
            <div style={{ display: "flex", gap: 6 }}>
              <button className="primary-button" onClick={async () => {
                const name = newExamName.trim();
                if (!name) { setStatus("请填写考试名称"); return; }
                try {
                  let cardId = newExamCardId || card?.id;
                  // 方案 B：如果没有选择答题卡，先自动创建一张最简答题卡
                  if (!cardId) {
                    const subjectPinyinMap: Record<string, string> = {
                      "语文": "yuwen", "数学": "shuxue", "英语": "yingyu", "外语": "yingyu",
                      "物理": "wuli", "化学": "huaxue", "生物": "shengwu",
                      "政治": "zhengzhi", "历史": "lishi", "地理": "dili"
                    };
                    const subjectVal = newExamSubject.trim();
                    const subjectPinyin = subjectPinyinMap[subjectVal] || subjectVal || "custom";
                    const today = new Date().toISOString().split("T")[0];
                    const cardRes = await fetchJson<any>("/api/cards", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        subject: subjectPinyin,
                        title: name,
                        subjectLabel: subjectVal || undefined,
                        examDate: today,
                        englishListening: false,
                        chineseChoicePlacement: "front"
                      })
                    });
                    cardId = cardRes.id;
                  }
                  await fetchJson("/api/exams", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, cardId, subject: newExamSubject.trim() || undefined }) });
                  setNewExamName(""); setNewExamSubject(""); setShowCreateExam(false);
                  loadExams();
                } catch (err) { setStatus(`创建失败: ${err instanceof Error ? err.message : String(err)}`); }
              }}>确认创建</button>
              <button className="ghost-button" onClick={() => setShowCreateExam(false)}>取消</button>
            </div>
          </div>
        )}

        {examManageMode === "single" && exams.length === 0 && !showCreateExam && (
          <div className="empty-text" style={{ padding: 60, textAlign: "center" }}>暂无考试，点击上方「新建考试」创建。</div>
        )}

        {examManageMode === "single" && exams.length > 0 && (
          <div className="exam-list-table">
            <div className="exam-list-head">
              <span style={{ width: 36, flexShrink: 0 }}>
                <input type="checkbox" onChange={(e) => {
                  if (e.target.checked) setSelectedExamIds(new Set(exams.map(ex => ex.id)));
                  else setSelectedExamIds(new Set());
                }} checked={selectedExamIds.size === exams.length && exams.length > 0} />
              </span>
              <span style={{ flex: 1, minWidth: 160 }}>考试名称</span>
              <span style={{ width: 80 }}>科目</span>
              <span style={{ width: 100 }}>答题卡</span>
              <span style={{ width: 70, textAlign: "center" }}>状态</span>
              <span style={{ width: 100, textAlign: "right" }}>操作</span>
            </div>
            {exams.map((exam) => (
              <div key={exam.id} className="exam-list-row" style={{ cursor: "default" }}>
                <span style={{ width: 36, flexShrink: 0 }}>
                  <input type="checkbox" checked={selectedExamIds.has(exam.id)} onChange={() => {
                    const next = new Set(selectedExamIds);
                    if (next.has(exam.id)) next.delete(exam.id); else next.add(exam.id);
                    setSelectedExamIds(next);
                  }} />
                </span>
                <span style={{ flex: 1, minWidth: 160, fontWeight: 500 }}>{exam.name}</span>
                <span style={{ width: 80, color: "var(--muted)" }}>{exam.subject || "—"}</span>
                <span style={{ width: 100, color: "var(--muted)", fontSize: 12 }}>{exam.card_id ?? "未关联"}</span>
                <span style={{ width: 70, textAlign: "center" }}>
                  <span className={`exam-list-badge exam-list-badge-${exam.status}`}>
                    {exam.status === "closed" ? "已完成" : exam.status === "grading" ? "阅卷中" : exam.status === "draft" ? "草稿" : exam.status}
                  </span>
                </span>
                <span style={{ width: 100, textAlign: "right", whiteSpace: "nowrap" }}>
                  <button className="ghost-button" style={{ fontSize: 12, color: "#3C3489", padding: "2px 6px" }}
                    onClick={() => setSelectedExamId(exam.id)}>网阅</button>
                  <button className="ghost-button" style={{ fontSize: 12, color: "var(--brand)", padding: "2px 6px", marginLeft: 4 }}
                    onClick={() => setExamDeleteTarget({ exams: [exam], deleteLinkedCards: false })}>删除</button>
                  <button className="ghost-button" style={{ fontSize: 12, color: "#1D9E75", padding: "2px 6px", marginLeft: 4 }}
                    onClick={() => setAssignedFormulaExamId(exam.id)}>赋分</button>
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Exam group list */}
        {examManageMode === "group" && examGroups.length === 0 && (
          <div className="empty-text" style={{ padding: 60, textAlign: "center" }}>暂无大考，点击上方「新建大考」创建。</div>
        )}
        {examManageMode === "group" && examGroups.length > 0 && (
          <div className="exam-list-table">
            <div className="exam-list-head">
              <span style={{ flex: 1, minWidth: 180 }}>大考名称</span>
              <span style={{ width: 80 }}>标签</span>
              <span style={{ width: 80 }}>年级</span>
              <span style={{ width: 80, textAlign: "center" }}>含考试数</span>
              <span style={{ width: 80, textAlign: "center" }}>有无成绩</span>
              <span style={{ width: 100, textAlign: "right" }}>操作</span>
            </div>
            {examGroups.map((group: any) => (
              <div key={group.id} className="exam-list-row" style={{ cursor: "default" }}>
                <span style={{ flex: 1, minWidth: 180, fontWeight: 500 }}>{group.name}</span>
                <span style={{ width: 80 }}>
                  <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 11,
                    background: group.tag ? "var(--primary)" : "var(--bg-secondary)",
                    color: group.tag ? "#fff" : "var(--muted)" }}>
                    {group.tag || "—"}
                  </span>
                </span>
                <span style={{ width: 80, color: "var(--muted)" }}>{group.grade_name || "—"}</span>
                <span style={{ width: 80, textAlign: "center", fontWeight: 500 }}>{group.member_count}</span>
                <span style={{ width: 80, textAlign: "center" }}>
                  <span className={`exam-list-badge ${group.has_results ? "exam-list-badge-closed" : "exam-list-badge-draft"}`}>
                    {group.has_results ? "有成绩" : "无成绩"}
                  </span>
                </span>
                <span style={{ width: 100, textAlign: "right", whiteSpace: "nowrap" }}>
                  <button className="ghost-button" style={{ fontSize: 12, color: "var(--brand)", padding: "2px 6px" }}
                    onClick={() => setGroupDeleteTarget({
                      groupId: group.id,
                      groupName: group.name,
                      memberCount: group.member_count,
                      deleteExams: false
                    })}>删除</button>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
      )}
    </div>
  );
}
