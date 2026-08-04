// ExamManagePage — 从 App.tsx 抽出的「考试管理」页面（B2：改由 useWorkspace 消费共享状态）。
// 不再由 App 透传 props，行为与抽离前完全一致。
import { Plus, Trash2, Layers, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { fetchJson } from "../auth/api";
import { useWorkspace } from "../WorkspaceContext";
import { ExamDetailPage } from "../components/ExamDetailPage";
import { useIsMobile } from "../hooks/useMediaQuery";
import { DataCard } from "../components/ui/DataCard";

export function ExamManagePage() {
  const {
    user,
    mode,
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
    onStartReview,
  } = useWorkspace();

  const active = mode === "exam-manage";
  const teacherId = user?.id ?? 0;
  const teacherRole = user?.teacher_role ?? null;
  const userRole = user?.role_name ?? "";
  const isMobile = useIsMobile();
  const [examSearch, setExamSearch] = useState("");
  const [examStatusFilter, setExamStatusFilter] = useState<"all" | "draft" | "grading" | "closed">("all");
  const visibleExams = useMemo(() => exams.filter((exam) => {
    const matchesSearch = !examSearch.trim() || exam.name.toLowerCase().includes(examSearch.trim().toLowerCase());
    return matchesSearch && (examStatusFilter === "all" || exam.status === examStatusFilter);
  }), [exams, examSearch, examStatusFilter]);

  return (
    <div className={`min-h-full w-full overflow-auto bg-background ${active ? "" : "hidden-panel"}`}>
      {selectedExamId ? (
        <section className="min-h-full w-full">
          <ExamDetailPage examId={selectedExamId} teacherId={teacherId} teacherRole={teacherRole} userRole={userRole} onBackToList={() => setSelectedExamId(null)} onBackHome={() => switchMode("home")} onStartReview={onStartReview} />
        </section>
      ) : (
       <section className="min-h-full w-full overflow-auto bg-background p-6">
         <div className="flex flex-wrap items-center gap-3 mb-4">
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
           <span className="text-sm text-muted-foreground">共 {examManageMode === "single" ? visibleExams.length : examGroups.length} {examManageMode === "single" ? "个考试" : "个大考"}</span>
           {examManageMode === "single" && <div className="order-last flex w-full flex-wrap items-center gap-3 lg:order-none lg:ml-4 lg:w-auto">
             <div className="flex rounded-md bg-secondary p-0.5">
               {([["all", "全部"], ["draft", "未开始"], ["grading", "阅卷中"], ["closed", "已完成"]] as const).map(([value, label]) => <button key={value} type="button" className={`border-0 rounded-sm px-3 py-1.5 text-xs ${examStatusFilter === value ? "bg-card font-semibold text-foreground shadow-1" : "bg-transparent text-muted-foreground"}`} onClick={() => setExamStatusFilter(value)}>{label}</button>)}
             </div>
             <label className="relative"><Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-muted-foreground" /><input className="h-control-md w-56 rounded-md border border-input bg-card pl-8 pr-3 text-sm" value={examSearch} onChange={(event) => setExamSearch(event.target.value)} placeholder="搜索考试名称" /></label>
           </div>}
          {/* Single/Group toggle — right side */}
           <div className="ml-auto flex overflow-hidden rounded-md border border-primary bg-secondary p-0.5">
             <button className={`rounded-sm border-0 px-3 py-1.5 text-xs ${examManageMode === "single" ? "bg-primary font-semibold text-primary-foreground" : "bg-transparent text-muted-foreground"}`} onClick={() => setExamManageMode("single")}>单科考试</button>
             <button className={`flex items-center gap-1 rounded-sm border-0 px-3 py-1.5 text-xs ${examManageMode === "group" ? "bg-primary font-semibold text-primary-foreground" : "bg-transparent text-muted-foreground"}`} onClick={() => { setExamManageMode("group"); loadExamGroups(); }}><Layers size={13} /> 大考</button>
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
          isMobile ? (
            <div className="data-card-list">
              {visibleExams.map((exam) => (
                <DataCard
                  key={exam.id}
                  rows={[
                    { label: "考试名称", value: exam.name, strong: true },
                    { label: "科目", value: exam.subject || "—" },
                    { label: "答题卡", value: exam.card_id ?? "未关联" },
                    {
                      label: "状态",
                      value: (
                        <span className={`exam-list-badge exam-list-badge-${exam.status}`}>
                          {exam.status === "closed" ? "已完成" : exam.status === "grading" ? "阅卷中" : exam.status === "draft" ? "草稿" : exam.status}
                        </span>
                      ),
                    },
                  ]}
                  actions={
                    <>
                      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, flex: "none", minHeight: "var(--touch-target-min)" }}>
                        <input type="checkbox" checked={selectedExamIds.has(exam.id)} onChange={() => {
                          const next = new Set(selectedExamIds);
                          if (next.has(exam.id)) next.delete(exam.id); else next.add(exam.id);
                          setSelectedExamIds(next);
                        }} />
                        选择
                      </label>
                       <button className="ghost-button" style={{ fontSize: 13, color: "var(--px-info-fg)" }}
                        onClick={() => setSelectedExamId(exam.id)}>网阅</button>
                      <button className="ghost-button" style={{ fontSize: 13, color: "var(--brand)" }}
                        onClick={() => setExamDeleteTarget({ exams: [exam], deleteLinkedCards: false })}>删除</button>
                      <button className="ghost-button" style={{ fontSize: 13, color: "#1D9E75" }}
                        onClick={() => setAssignedFormulaExamId(exam.id)}>赋分</button>
                    </>
                  }
                />
              ))}
            </div>
          ) : (
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
               <span style={{ width: 190, textAlign: "right" }}>操作</span>
            </div>
            {visibleExams.map((exam) => (
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
                 <span style={{ width: 190, textAlign: "right", whiteSpace: "nowrap" }}>
                   <button className="ghost-button" style={{ fontSize: 12, color: "var(--px-info-fg)", padding: "2px 6px" }}
                    onClick={() => setSelectedExamId(exam.id)}>网阅</button>
                  <button className="ghost-button" style={{ fontSize: 12, color: "var(--brand)", padding: "2px 6px", marginLeft: 4 }}
                    onClick={() => setExamDeleteTarget({ exams: [exam], deleteLinkedCards: false })}>删除</button>
                  <button className="ghost-button" style={{ fontSize: 12, color: "#1D9E75", padding: "2px 6px", marginLeft: 4 }}
                    onClick={() => setAssignedFormulaExamId(exam.id)}>赋分</button>
                </span>
              </div>
            ))}
          </div>
          )
        )}

        {/* Exam group list */}
        {examManageMode === "group" && examGroups.length === 0 && (
          <div className="empty-text" style={{ padding: 60, textAlign: "center" }}>暂无大考，点击上方「新建大考」创建。</div>
        )}
        {examManageMode === "group" && examGroups.length > 0 && (
          isMobile ? (
            <div className="data-card-list">
              {examGroups.map((group: any) => (
                <DataCard
                  key={group.id}
                  rows={[
                    { label: "大考名称", value: group.name, strong: true },
                    {
                      label: "标签",
                      value: (
                        <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 11,
                          background: group.tag ? "var(--primary)" : "var(--bg-secondary)",
                          color: group.tag ? "#fff" : "var(--muted)" }}>
                          {group.tag || "—"}
                        </span>
                      ),
                    },
                    { label: "年级", value: group.grade_name || "—" },
                    { label: "含考试数", value: group.member_count },
                    {
                      label: "有无成绩",
                      value: (
                        <span className={`exam-list-badge ${group.has_results ? "exam-list-badge-closed" : "exam-list-badge-draft"}`}>
                          {group.has_results ? "有成绩" : "无成绩"}
                        </span>
                      ),
                    },
                  ]}
                  actions={
                    <button className="ghost-button" style={{ fontSize: 13, color: "var(--brand)" }}
                      onClick={() => setGroupDeleteTarget({
                        groupId: group.id,
                        groupName: group.name,
                        memberCount: group.member_count,
                        deleteExams: false
                      })}>删除</button>
                  }
                />
              ))}
            </div>
          ) : (
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
          )
        )}
      </section>
      )}
    </div>
  );
}
