/// <reference types="vite/client" />

import { useEffect, useMemo, useState } from "react";
import { Layers, Search, ClipboardList } from "lucide-react";
import { useIsMobile } from "../hooks/useMediaQuery";
import { SkinSwitcher } from "./SkinSwitcher";
import type { CardSummary, ExamGroupFilterItem } from "../../../../shared/types";
import {
  fetchCardsSynced,
  fetchExamGroupsSynced,
  fetchExamGroupDetailSynced,
  fetchGradesSynced,
  fetchExamsSynced,
  startPolling,
} from "../lib/scannerSync";
import type { SyncSource } from "../lib/scannerSync";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
} from "./ui/v2";

interface Props {
  onSelectCard: (cardId: string) => void;
  /** v2.5.0: 受控皮肤（由 ScannerApp 下发；未传时不渲染切换器，保持组件独立可用） */
  skin?: string;
  onSkinChange?: (skin: string) => void;
}

type MainMode = "single" | "group";

interface GroupMember {
  examId: number;
  examName: string;
  subject: string;
  cardId: string | null;
}

export function CardSelectPage({ onSelectCard, skin, onSkinChange }: Props) {
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

  const [syncSource, setSyncSource] = useState<SyncSource | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  function isAuthError(e: any): boolean {
    const s = e?.status;
    return s === 401 || s === 403 || !!e?.remoteAuthFailed;
  }

  // ── Load helpers (silent=false 为首次加载带 Spinner，silent=true 为后台静默刷新) ──
  const loadCards = async (opts?: { silent?: boolean }) => {
    const silent = !!opts?.silent;
    if (!silent) setLoading(true);
    try {
      const { data, source } = await fetchCardsSynced();
      setCards(Array.isArray(data as unknown as CardSummary[]) ? (data as unknown as CardSummary[]) : []);
      setSyncSource(source);
      setSyncError(null);
    } catch (e: any) {
      if (isAuthError(e)) {
        setSyncError(e.message || "同步失败：API Key 无效或无权限，请检查服务器配置");
      } else if (!silent) setCards([]);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  const loadGroups = async (opts?: { silent?: boolean }) => {
    const silent = !!opts?.silent;
    if (!silent) setGroupLoading(true);
    try {
      const data = await fetchExamGroupsSynced();
      setGroups(Array.isArray(data as unknown as ExamGroupFilterItem[]) ? (data as unknown as ExamGroupFilterItem[]) : []);
      setSyncError(null);
    } catch (e: any) {
      if (isAuthError(e)) {
        setSyncError(e.message || "同步失败：API Key 无效或无权限，请检查服务器配置");
      } else if (!silent) setGroups([]);
    } finally {
      if (!silent) setGroupLoading(false);
    }
  };

  const loadGrades = async (opts?: { silent?: boolean }) => {
    try {
      const d = await fetchGradesSynced();
      setGrades(Array.isArray(d) ? d : []);
      setSyncError(null);
    } catch (e: any) {
      if (isAuthError(e)) {
        setSyncError(e.message || "同步失败：API Key 无效或无权限，请检查服务器配置");
      } else if (!opts?.silent) setGrades([]);
    }
  };

  const loadExpandedGroup = async (groupId: number, opts?: { silent?: boolean }) => {
    if (!opts?.silent) setMembersLoading(true);
    try {
      const data: any = await fetchExamGroupDetailSynced(groupId);
      const members: GroupMember[] = (data.members || []).map((m: any) => ({
        examId: m.examId ?? m.exam_id,
        examName: m.examName ?? m.exam_name ?? `考试${m.examId ?? m.exam_id}`,
        subject: m.subject ?? "",
        cardId: m.cardId ?? m.card_id ?? null,
      }));
      setGroupMembers(members);
    } catch {
      if (!opts?.silent) setGroupMembers([]);
    } finally {
      if (!opts?.silent) setMembersLoading(false);
    }
  };

  // 考试列表静默同步（设计声明的 grades/考试覆盖，即使当前页未直接展示 exam 列表，仍保持与服务端一致）
  const refreshExamsSilent = async () => {
    try { await fetchExamsSynced(); } catch {}
  };

  // ── Initial load ──
  useEffect(() => {
    void loadCards();
    void loadGroups();
    void loadGrades();
  }, []);

  // 30s polling + visibilitychange 静默刷新（不触发 Spinner，不遮列表）
  useEffect(() => {
    return startPolling({
      intervalMs: 30000,
      onUpdate: () => {
        void loadCards({ silent: true });
        void loadGroups({ silent: true });
        void loadGrades({ silent: true });
        void refreshExamsSilent();
        if (expandedGroupId != null) void loadExpandedGroup(expandedGroupId, { silent: true });
      },
    });
  }, [expandedGroupId]);

  // ── Load group members on expand (remote-first) ──
  useEffect(() => {
    if (expandedGroupId == null) {
      setGroupMembers([]);
      return;
    }
    void loadExpandedGroup(expandedGroupId);
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
      list = list.filter(
        (c) =>
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
    return groups.filter(
      (g) => g.name.toLowerCase().includes(q) || (g.tag || "").toLowerCase().includes(q)
    );
  }, [groups, groupSearch]);

  const showSingleGroup = true;

  return (
    <main className="flex h-[100dvh] w-full flex-col overflow-hidden bg-background text-foreground">
      <section className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
        {/* ── Topbar ── */}
        <header className="flex min-h-[56px] shrink-0 items-center gap-3 border-b border-border-subtle bg-card px-6 py-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <ClipboardList size={22} className="shrink-0 text-primary" />
              答题卡扫描端
            </h1>
            <p className="m-0 mt-0.5 text-xs text-muted-foreground">
              选择答题卡或大考组，进入扫描工作台
            </p>
          </div>
          {skin !== undefined && onSkinChange && (
            <div className="ml-auto flex items-center gap-2">
              <SkinSwitcher skin={skin} onSkinChange={onSkinChange} />
            </div>
          )}
        </header>

        <div className="flex min-h-0 flex-col overflow-hidden">
          {syncError && (
            <div className="mx-8 mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
              {syncError}
            </div>
          )}
          {/* ── Filter header ── */}
          <div className="shrink-0 px-8 pt-6">
            <div className="flex items-end justify-between gap-4">
              <div>
                <h2 className="m-0 mb-1 text-lg font-semibold">选择答题卡</h2>
                <p className="m-0 text-sm text-muted-foreground">
                  {mainMode === "single"
                    ? "按科目筛选答题卡，点击进入扫描"
                    : "选择大考组，展开后选择其中一场考试的答题卡"}
                </p>
              </div>
              <SegmentedControl
                aria-label="选择模式"
                value={mainMode}
                onValueChange={(m) => {
                  setMainMode(m);
                  setExpandedGroupId(null);
                }}
                items={[
                  { value: "single", label: "单科", icon: <ClipboardList size={14} /> },
                  { value: "group", label: "大考", icon: <Layers size={14} /> },
                ]}
              />
            </div>

            {/* ── Filters ── */}
            {showSingleGroup && (
              <div className="mb-5 mt-4 flex flex-wrap items-end gap-3">
                {/* Search bar */}
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">搜索</span>
                  <div className="relative">
                    <Search
                      size={14}
                      className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      type="search"
                      className="w-56 pl-8"
                      placeholder={mainMode === "single" ? "搜索答题卡 ID 或名称..." : "搜索大考名称..."}
                      value={mainMode === "single" ? search : groupSearch}
                      onChange={(e) =>
                        mainMode === "single" ? setSearch(e.target.value) : setGroupSearch(e.target.value)
                      }
                    />
                  </div>
                </div>

                {mainMode === "single" && (
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted-foreground">学科</span>
                    <Select value={subjectFilter || "__all__"} onValueChange={(v) => setSubjectFilter(v === "__all__" ? "" : v)}>
                      <SelectTrigger className="w-40">
                        <SelectValue placeholder="全部学科" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__all__">全部学科</SelectItem>
                        {subjects.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {(mainMode === "single" && filteredCards.length > 0) ||
                (mainMode === "group" && filteredGroups.length > 0) ? (
                  <span className="self-end pb-2 text-sm text-muted-foreground">
                    共 {mainMode === "single" ? filteredCards.length : filteredGroups.length}{" "}
                    {mainMode === "single" ? "张答题卡" : "个大考"}
                  </span>
                ) : null}
              </div>
            )}
          </div>

          {/* ── Scrollable content ── */}
          <div className="min-h-0 flex-1 overflow-auto px-8 pb-6">
            {/* ── Single: card list ── */}
            {mainMode === "single" && !loading && filteredCards.length === 0 && (
              <EmptyState
                icon={<ClipboardList size={40} />}
                title={cards.length === 0 ? "暂无答题卡" : "没有匹配的答题卡"}
                description={cards.length === 0 ? "请在「设计」中创建" : undefined}
              />
            )}
            {mainMode === "single" && !loading && filteredCards.length > 0 && (
              <CardListTable cards={filteredCards} onSelect={onSelectCard} />
            )}
            {mainMode === "single" && loading && (
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
                <Spinner size={24} />
                <span className="text-sm">正在加载答题卡...</span>
              </div>
            )}

            {/* ── Group: group list ── */}
            {mainMode === "group" && !groupLoading && filteredGroups.length === 0 && (
              <EmptyState
                icon={<Layers size={40} />}
                title={groups.length === 0 ? "暂无大考组" : "没有匹配的大考组"}
                description={groups.length === 0 ? "请在「考试管理」中创建" : undefined}
              />
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
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
                <Spinner size={24} />
                <span className="text-sm">正在加载大考组...</span>
              </div>
            )}
          </div>
        </div>

        {/* ── Statusbar (sync source hint) ── */}
        <footer className="flex h-statusbar shrink-0 items-center justify-between border-t border-border-subtle bg-card px-4 text-xs text-muted-foreground">
          <span>
            {syncSource === "remote"
              ? "已同步远端"
              : syncSource === "offline-cache"
                ? "离线·显示缓存"
                : syncSource === "local"
                  ? "本地数据"
                  : ""}
          </span>
          <span>{syncSource ? "30s 自动刷新 · 切回窗口即刷新" : ""}</span>
        </footer>
      </section>
    </main>
  );
}

// ── Card list table ──
function CardListTable({
  cards,
  onSelect,
}: {
  cards: CardSummary[];
  onSelect: (id: string) => void;
}) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <div className="flex flex-col gap-2">
        {cards.map((card) => (
          <Card
            key={card.id}
            interactive
            onClick={() => onSelect(card.id)}
            className="flex flex-col gap-2 p-4"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-medium text-foreground">
                {card.title || "未命名答题卡"}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(card.id);
                }}
              >
                选择
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>ID:{card.id}</span>
              <span>{card.subjectLabel || "—"}</span>
              <span>{card.examDate || "—"}</span>
            </div>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <TableWrap className="rounded-lg border border-border-subtle bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>答题卡名称</TableHead>
            <TableHead>科目</TableHead>
            <TableHead>日期</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {cards.map((card) => (
            <TableRow key={card.id} clickable onClick={() => onSelect(card.id)}>
              <TableCell className="font-medium">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{card.title || "未命名答题卡"}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">ID:{card.id}</span>
                </span>
              </TableCell>
              <TableCell className="text-muted-foreground">{card.subjectLabel || "—"}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{card.examDate || "—"}</TableCell>
              <TableCell className="text-right">
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); onSelect(card.id); }}>
                  选择
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableWrap>
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
    <TableWrap className="rounded-lg border border-border-subtle bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>大考名称</TableHead>
            <TableHead>标签</TableHead>
            <TableHead numeric>科目数</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.map((g) => {
            const isExpanded = expandedGroupId === g.id;
            return [
              <TableRow key={g.id} clickable onClick={() => onToggleExpand(g.id)}>
                <TableCell className="font-medium">{g.name}</TableCell>
                <TableCell>
                  {g.tag ? (
                    <Badge tone="accent">{g.tag}</Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell numeric>{g.member_count}科</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); onToggleExpand(g.id); }}>
                    {isExpanded ? "收起" : "展开"}
                  </Button>
                </TableCell>
              </TableRow>,
              isExpanded ? (
                <TableRow key={`${g.id}__detail`} className="hover:bg-transparent">
                  <TableCell colSpan={4} className="bg-secondary py-2">
                    {membersLoading ? (
                      <p className="m-0 py-2 text-sm text-muted-foreground">加载中...</p>
                    ) : groupMembers.length === 0 ? (
                      <p className="m-0 py-2 text-sm text-muted-foreground">该大考组暂无关联考试</p>
                    ) : (
                      <div className="flex flex-col gap-1">
                        {groupMembers.map((m, idx) => (
                          <div
                            key={m.examId}
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (m.cardId) onSelectCard(m.cardId);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && m.cardId) onSelectCard(m.cardId);
                            }}
                            className={`flex items-center gap-3 rounded-md px-3 py-1.5 ${
                              m.cardId ? "cursor-pointer hover:bg-card" : "cursor-default opacity-50"
                            }`}
                          >
                            <span className="w-6 shrink-0 text-right text-xs text-muted-foreground">
                              {idx + 1}.
                            </span>
                            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                              {m.examName}
                            </span>
                            <Badge tone="neutral">{m.subject || "—"}</Badge>
                            <span className="shrink-0 text-xs text-primary">
                              {m.cardId ? "选择 ▶" : "无答题卡"}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ) : null,
            ];
          })}
        </TableBody>
      </Table>
    </TableWrap>
  );
}
