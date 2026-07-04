/// <reference types="vite/client" />

import { useEffect, useMemo, useState } from "react";
import { Layers, Search, ClipboardList } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { CardSummary, ExamGroupFilterItem } from "../../../../shared/types";

interface Props {
  onSelectCard: (cardId: string) => void;
}

type MainMode = "single" | "group";

// ── Filter label component (reused from ExamSelectPage) ──
function FilterCol({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}><span style={{ color: "var(--muted)" }}>{label}</span>{children}</div>;
}

function toggleBtn(active: boolean): React.CSSProperties {
  return {
    padding: "5px 12px", border: "none", background: active ? "var(--brand)" : "var(--surface)",
    color: active ? "#fff" : "var(--text)", fontSize: 12, cursor: "pointer", fontWeight: active ? 600 : 400,
    display: "flex", alignItems: "center", gap: 4
  };
}

interface GroupMember {
  examId: number;
  examName: string;
  subject: string;
  cardId: string | null;
}

export function CardSelectPage({ onSelectCard }: Props) {
  const [mainMode, setMainMode] = useState<MainMode>("single");

  // ── Card list states ──
  const [cards, setCards] = useState<CardSummary[]>([]);
  const [search, setSearch] = useState("");
  const [subjectFilter, setSubjectFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [grades, setGrades] = useState<Array<{ id: number; name: string }>>([]);
  const [gradeId, setGradeId] = useState("");

  // ── Group states ──
  const [groups, setGroups] = useState<ExamGroupFilterItem[]>([]);
  const [groupSearch, setGroupSearch] = useState("");
  const [groupLoading, setGroupLoading] = useState(false);
  const [expandedGroupId, setExpandedGroupId] = useState<number | null>(null);
  const [groupMembers, setGroupMembers] = useState<GroupMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);

  // ── Load cards ──
  const loadCards = async () => {
    setLoading(true);
    try {
      const data = await fetchJson<CardSummary[]>("/api/cards?limit=500");
      setCards(Array.isArray(data) ? data : []);
    } catch { setCards([]); }
    finally { setLoading(false); }
  };

  // ── Load groups ──
  const loadGroups = async () => {
    setGroupLoading(true);
    try {
      const data = await fetchJson<ExamGroupFilterItem[]>("/api/exam-groups");
      setGroups(Array.isArray(data) ? data : []);
    } catch { setGroups([]); }
    finally { setGroupLoading(false); }
  };

  // ── Load grades ──
  useEffect(() => {
    fetchJson<Array<{ id: number; name: string }>>("/api/classes/grades")
      .then(setGrades).catch(() => setGrades([]));
  }, []);

  useEffect(() => {
    loadCards();
    loadGroups();
  }, []);

  // ── Load group members on expand ──
  useEffect(() => {
    if (expandedGroupId == null) {
      setGroupMembers([]);
      return;
    }
    setMembersLoading(true);
    fetchJson<any>(`/api/exam-groups/${expandedGroupId}`)
      .then((data) => {
        const members: GroupMember[] = (data.members || []).map((m: any) => ({
          examId: m.examId ?? m.exam_id,
          examName: m.examName ?? m.exam_name ?? `考试${m.examId ?? m.exam_id}`,
          subject: m.subject ?? "",
          cardId: m.cardId ?? m.card_id ?? null,
        }));
        setGroupMembers(members);
      })
      .catch(() => setGroupMembers([]))
      .finally(() => setMembersLoading(false));
  }, [expandedGroupId]);

  // ── Extract subjects from cards ──
  const subjects = useMemo(() => {
    const set = new Set<string>();
    for (const c of cards) if (c.subjectLabel) set.add(c.subjectLabel);
    return Array.from(set).sort();
  }, [cards]);

  // ── Filter cards ──
  const filteredCards = useMemo(() => {
    let list = cards;
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((c) =>
        c.id.toLowerCase().includes(q) ||
        (c.title || "").toLowerCase().includes(q) ||
        (c.subjectLabel || "").toLowerCase().includes(q)
      );
    }
    if (subjectFilter) {
      list = list.filter((c) => c.subjectLabel === subjectFilter);
    }
    return list;
  }, [cards, search, subjectFilter]);

  // ── Filter groups ──
  const filteredGroups = useMemo(() => {
    const q = groupSearch.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) =>
      g.name.toLowerCase().includes(q) ||
      (g.tag || "").toLowerCase().includes(q)
    );
  }, [groups, groupSearch]);

  const showSingleGroup = true;

  return (
    <main className="app-shell no-card-sidebar">
      <section className="workspace">
        <header className="topbar" style={{ flexShrink: 0 }}>
          <div>
            <h1 style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <ClipboardList size={24} />
              答题卡扫描端
            </h1>
            <p>选择答题卡或大考组，进入扫描工作台</p>
          </div>
        </header>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* ── Filter header ── */}
          <div style={{ padding: "24px 32px 0", flexShrink: 0 }}>
            <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 16 }}>
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, marginBottom: 4 }}>选择答题卡</h2>
                <p style={{ fontSize: 13, color: "var(--muted)", margin: 0 }}>
                  {mainMode === "single" ? "按科目筛选答题卡，点击进入扫描" : "选择大考组，展开后选择其中一场考试的答题卡"}
                </p>
              </div>
              <div style={{ display: "flex", gap: 0, border: "1.5px solid var(--brand)", borderRadius: 6, overflow: "hidden", flexShrink: 0 }}>
                <button onClick={() => { setMainMode("single"); setExpandedGroupId(null); }} style={toggleBtn(mainMode === "single")}>
                  <ClipboardList size={14} style={{ marginRight: 2 }} />单科
                </button>
                <button onClick={() => { setMainMode("group"); setExpandedGroupId(null); }} style={toggleBtn(mainMode === "group")}>
                  <Layers size={14} style={{ marginRight: 2 }} />大考
                </button>
              </div>
            </div>

            {/* ── Filters ── */}
            {showSingleGroup && (
              <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap", alignItems: "flex-end" }}>
                {/* Search bar */}
                <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                  <span style={{ color: "var(--muted)" }}>搜索</span>
                  <div style={{ position: "relative" }}>
                    <Search size={14} style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }} />
                    <input
                      type="search"
                      placeholder={mainMode === "single" ? "搜索答题卡 ID 或名称..." : "搜索大考名称..."}
                      value={mainMode === "single" ? search : groupSearch}
                      onChange={(e) => mainMode === "single" ? setSearch(e.target.value) : setGroupSearch(e.target.value)}
                      className="exam-filter-select"
                      style={{ paddingLeft: 28, width: 220 }}
                    />
                  </div>
                </div>

                {mainMode === "single" && (
                  <FilterCol label="学科">
                    <select value={subjectFilter} onChange={(e) => setSubjectFilter(e.target.value)} className="exam-filter-select">
                      <option value="">全部学科</option>
                      {subjects.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </FilterCol>
                )}

                {(mainMode === "single" && filteredCards.length > 0) || (mainMode === "group" && filteredGroups.length > 0) ? (
                  <span style={{ fontSize: 13, color: "var(--muted)", paddingBottom: 10 }}>
                    共 {mainMode === "single" ? filteredCards.length : filteredGroups.length} {mainMode === "single" ? "张答题卡" : "个大考"}
                  </span>
                ) : null}
              </div>
            )}
          </div>

          {/* ── Scrollable content ── */}
          <div style={{ flex: 1, overflow: "auto", padding: "0 32px 24px" }}>

            {/* ── Single: card list ── */}
            {mainMode === "single" && !loading && filteredCards.length === 0 && (
              <div style={{ textAlign: "center", padding: 60 }}>
                <ClipboardList size={48} style={{ opacity: 0.3, marginBottom: 12 }} />
                <p style={{ fontSize: 15, color: "var(--muted)", margin: 0 }}>
                  {cards.length === 0 ? "暂无答题卡，请在「设计」中创建" : "没有匹配的答题卡"}
                </p>
              </div>
            )}
            {mainMode === "single" && !loading && filteredCards.length > 0 && (
              <CardListTable cards={filteredCards} onSelect={onSelectCard} />
            )}
            {mainMode === "single" && loading && (
              <div style={{ textAlign: "center", padding: 60, color: "var(--muted)", fontSize: 14 }}>正在加载答题卡...</div>
            )}

            {/* ── Group: group list ── */}
            {mainMode === "group" && !groupLoading && filteredGroups.length === 0 && (
              <div style={{ textAlign: "center", padding: 60 }}>
                <Layers size={48} style={{ opacity: 0.3, marginBottom: 12 }} />
                <p style={{ fontSize: 15, color: "var(--muted)", margin: 0 }}>
                  {groups.length === 0 ? "暂无大考组，请在「考试管理」中创建" : "没有匹配的大考组"}
                </p>
              </div>
            )}
            {mainMode === "group" && !groupLoading && filteredGroups.length > 0 && (
              <GroupCardList
                groups={filteredGroups}
                expandedGroupId={expandedGroupId}
                onToggleExpand={(id) => setExpandedGroupId(expandedGroupId === id ? null : id)}
                groupMembers={groupMembers}
                membersLoading={membersLoading}
                onSelectCard={onSelectCard}
              />
            )}
            {mainMode === "group" && groupLoading && (
              <div style={{ textAlign: "center", padding: 60, color: "var(--muted)", fontSize: 14 }}>正在加载大考组...</div>
            )}
          </div>
        </div>

        <footer className="statusbar">
          <span className="statusbar-message" />
        </footer>
      </section>
    </main>
  );
}

// ── Card list table ──
function CardListTable({ cards, onSelect }: { cards: CardSummary[]; onSelect: (id: string) => void }) {
  return (
    <div className="exam-list-table">
      <div className="exam-list-head">
        <span style={{ flex: 1, minWidth: 200 }}>答题卡名称</span>
        <span style={{ width: 80 }}>科目</span>
        <span style={{ width: 90 }}>日期</span>
        <span style={{ width: 60, textAlign: "center" }} />
      </div>
      {cards.map((card) => (
        <div
          key={card.id}
          className="exam-list-row"
          onClick={() => onSelect(card.id)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === "Enter") onSelect(card.id); }}
          style={{ cursor: "pointer" }}
        >
          <span style={{ flex: 1, minWidth: 200, fontWeight: 500 }}>
            {card.title || "未命名答题卡"}
            <span style={{ fontSize: 11, color: "var(--muted)", marginLeft: 8 }}>ID:{card.id}</span>
          </span>
          <span style={{ width: 80, color: "var(--muted)" }}>{card.subjectLabel || "—"}</span>
          <span style={{ width: 90, color: "var(--muted)", fontSize: 12 }}>{card.examDate || "—"}</span>
          <span style={{ width: 60, textAlign: "center" }}>
            <span style={{ color: "var(--brand)", fontSize: 12 }}>选择 ▶</span>
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Group card list ──
function GroupCardList({
  groups,
  expandedGroupId,
  onToggleExpand,
  groupMembers,
  membersLoading,
  onSelectCard,
}: {
  groups: ExamGroupFilterItem[];
  expandedGroupId: number | null;
  onToggleExpand: (id: number) => void;
  groupMembers: GroupMember[];
  membersLoading: boolean;
  onSelectCard: (cardId: string) => void;
}) {
  return (
    <div className="exam-list-table">
      <div className="exam-list-head">
        <span style={{ flex: 1, minWidth: 180 }}>大考名称</span>
        <span style={{ width: 80 }}>标签</span>
        <span style={{ width: 70, textAlign: "center" }}>科目数</span>
        <span style={{ width: 80, textAlign: "center" }} />
      </div>
      {groups.map((g: any) => {
        const isExpanded = expandedGroupId === g.id;
        return (
          <div key={g.id}>
            <div
              className="exam-list-row"
              onClick={() => onToggleExpand(g.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter") onToggleExpand(g.id); }}
              style={{ cursor: "pointer" }}
            >
              <span style={{ flex: 1, minWidth: 180, fontWeight: 500 }}>
                {g.name}
              </span>
              <span style={{ width: 80 }}>
                <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 11, background: g.tag ? "var(--primary)" : "var(--bg-secondary)", color: g.tag ? "#fff" : "var(--muted)" }}>
                  {g.tag || "—"}
                </span>
              </span>
              <span style={{ width: 70, textAlign: "center", color: "var(--muted)" }}>{g.member_count ?? 0}科</span>
              <span style={{ width: 80, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
                {isExpanded ? "收起 ▲" : "展开 ▼"}
              </span>
            </div>

            {/* Expanded members */}
            {isExpanded && (
              <div style={{ background: "var(--bg-secondary)", borderBottom: "1px solid var(--border)" }}>
                {membersLoading && (
                  <div style={{ padding: "14px 24px", fontSize: 13, color: "var(--muted)" }}>加载中...</div>
                )}
                {!membersLoading && groupMembers.length === 0 && (
                  <div style={{ padding: "14px 24px", fontSize: 13, color: "var(--muted)" }}>该大考组暂无关联考试</div>
                )}
                {!membersLoading && groupMembers.map((m, idx) => (
                  <div
                    key={m.examId}
                    className="exam-list-row"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (m.cardId) onSelectCard(m.cardId);
                    }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" && m.cardId) onSelectCard(m.cardId); }}
                    style={{
                      cursor: m.cardId ? "pointer" : "default",
                      paddingLeft: 32,
                      background: idx % 2 === 0 ? undefined : "var(--surface)",
                      opacity: m.cardId ? 1 : 0.5,
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 180, display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 11, color: "var(--muted)", width: 16, textAlign: "right", flexShrink: 0 }}>{idx + 1}.</span>
                      <span style={{ fontWeight: 500, fontSize: 13 }}>{m.examName}</span>
                      <span style={{ fontSize: 11, color: "var(--muted)" }}>({m.subject})</span>
                    </span>
                    <span style={{ width: 80 }}>
                      <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 11, background: "var(--surface)", color: "var(--muted)" }}>{m.subject}</span>
                    </span>
                    <span style={{ width: 70, textAlign: "center" }} />
                    <span style={{ width: 80, textAlign: "center" }}>
                      {m.cardId ? (
                        <span style={{ color: "var(--brand)", fontSize: 12 }}>选择 ▶</span>
                      ) : (
                        <span style={{ fontSize: 11, color: "var(--muted)" }}>无答题卡</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
