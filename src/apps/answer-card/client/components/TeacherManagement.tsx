import { useCallback, useEffect, useState } from "react";
import { Download, Link, Plus, RefreshCw, Search, Unlink, Upload, X } from "lucide-react";
import { fetchJson, authFetch } from "../auth/api";
import { TEACHER_ROLE_LABELS } from "../auth/types";
import type { GradeRecord, ClassRecord, TeacherRecord, TeachersListResponse } from "../auth/types";
import { cn } from "../lib/utils";
import {
  Button,
  Input,
  Field,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from "./ui/v2";
import { ImportModal } from "./ImportModal";

/** 9科固定科目列表 */
const SUBJECTS = ["语文", "数学", "英语", "物理", "化学", "生物", "历史", "地理", "政治"];

/** Radix Select 不允许空字符串 value，用哨兵值表达「未设置」 */
const NONE = "__none__";

export function TeacherManagement() {
  const [teachers, setTeachers] = useState<TeacherRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [keyword, setKeyword] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // 详情编辑
  const [editName, setEditName] = useState("");
  const [editSubject, setEditSubject] = useState("");
  const [editTeacherRole, setEditTeacherRole] = useState("");

  // 关联班级
  const [grades, setGrades] = useState<GradeRecord[]>([]);
  const [allClasses, setAllClasses] = useState<ClassRecord[]>([]);
  const [selectedGradeId, setSelectedGradeId] = useState<number | null>(null);
  const [selectedClassId, setSelectedClassId] = useState<number | null>(null);

  // 弹窗
  const [showImport, setShowImport] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newTeacherName, setNewTeacherName] = useState("");
  const [newTeacherSubject, setNewTeacherSubject] = useState("");

  const selected = teachers.find((t) => t.id === selectedId) ?? null;

  const loadTeachers = useCallback(async () => {
    setBusy(true);
    try {
      const qs = keyword ? `?keyword=${encodeURIComponent(keyword)}` : "";
      const data = await fetchJson<TeachersListResponse>(`/api/teachers${qs}`);
      setTeachers(data.teachers);
      setTotal(data.total);
      // 保持选中或默认第一个
      if (selectedId === null || !data.teachers.some((t) => t.id === selectedId)) {
        if (data.teachers.length > 0) setSelectedId(data.teachers[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载教师失败");
    } finally {
      setBusy(false);
    }
  }, [keyword, selectedId]);

  const loadGrades = useCallback(async () => {
    try {
      const data = await fetchJson<GradeRecord[]>("/api/classes/grades");
      setGrades(data);
      if (data.length > 0 && selectedGradeId === null) setSelectedGradeId(data[0].id);
    } catch {}
  }, [selectedGradeId]);

  const loadClasses = useCallback(async (gradeId: number | null) => {
    if (!gradeId) { setAllClasses([]); return; }
    try {
      const data = await fetchJson<ClassRecord[]>(`/api/classes?gradeId=${gradeId}`);
      setAllClasses(data);
      setSelectedClassId(data.length > 0 ? data[0].id : null);
    } catch {}
  }, []);

  useEffect(() => { void loadTeachers(); }, [loadTeachers]);
  useEffect(() => { void loadGrades(); }, [loadGrades]);
  useEffect(() => { void loadClasses(selectedGradeId); }, [selectedGradeId, loadClasses]);

  useEffect(() => {
    if (selected) {
      setEditName(selected.name);
      setEditSubject(selected.subject ?? "");
      setEditTeacherRole(selected.teacher_role ?? "");
    }
  }, [selected]);

  async function handleRefresh() {
    await loadTeachers();
    if (selected) {
      try {
        const detail = await fetchJson<TeacherRecord>(`/api/teachers/${selected.id}`);
        setTeachers((prev) => prev.map((t) => (t.id === selected.id ? detail : t)));
      } catch {}
    }
  }

  async function handleSave() {
    if (!selected || !editName.trim()) return;
    setBusy(true);
    setError("");
    try {
      await fetchJson(`/api/teachers/${selected.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName.trim(), subject: editSubject.trim() || null, teacher_role: editTeacherRole || null })
      });
      await handleRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleLinkClass() {
    if (!selected || !selectedClassId) return;
    setBusy(true);
    setError("");
    try {
      const resp = await fetchJson<{ teacher: TeacherRecord }>(`/api/teachers/${selected.id}/classes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classIds: [selectedClassId], subject: editSubject.trim() || null })
      });
      // 直接更新当前教师详情（关联班级即时可见，无需手动刷新）
      if (resp.teacher) {
        setTeachers((prev) => prev.map((t) => (t.id === selected.id ? resp.teacher! : t)));
      }
      setSelectedClassId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "关联失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleUnlinkClass(classId: number) {
    if (!selected) return;
    setBusy(true);
    try {
      const resp = await fetchJson<{ teacher: TeacherRecord }>(`/api/teachers/${selected.id}/classes/${classId}`, { method: "DELETE" });
      // 直接更新当前教师详情（即时可见）
      if (resp.teacher) {
        setTeachers((prev) => prev.map((t) => (t.id === selected.id ? resp.teacher! : t)));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "解除失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleImport(csvText: string) {
    await fetchJson("/api/users/import-csv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csvText })
    });
    await loadTeachers();
  }

  function handleExport() {
    if (!confirm("导出文件将包含教师明文密码，请妥善保管！\n确定要下载吗？")) return;
    authFetch("/api/export/teachers")
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "teacher_accounts.xlsx";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "导出失败"));
  }

  // ── 手动创建教师 ──────────────────────────────────────
  async function handleCreateTeacher() {
    if (!newTeacherName.trim() || !newTeacherSubject.trim()) return;
    setBusy(true);
    setError("");
    try {
      // 使用 csv 导入接口创建一个教师
      const csvText = `科目,姓名\n${newTeacherSubject.trim()},${newTeacherName.trim()}`;
      await fetchJson("/api/users/import-csv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvText })
      });
      setShowCreateModal(false);
      setNewTeacherName("");
      setNewTeacherSubject("");
      await loadTeachers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">教师管理</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" icon={<RefreshCw size={14} />} onClick={handleRefresh} disabled={busy}>
            刷新
          </Button>
          <Button
            variant="outline"
            size="sm"
            icon={<Plus size={14} />}
            onClick={() => { setShowCreateModal(true); setNewTeacherName(""); setNewTeacherSubject(""); }}
            disabled={busy}
          >
            新建教师
          </Button>
          <Button variant="outline" size="sm" icon={<Download size={14} />} onClick={() => setShowImport(true)} disabled={busy}>
            导入教师
          </Button>
          <Button variant="primary" size="sm" icon={<Upload size={14} />} onClick={handleExport}>
            导出教师账密
          </Button>
        </div>
      </header>

      {error && <p className="text-sm text-destructive-fg">{error}</p>}

      <div className="grid grid-cols-[220px_1fr] gap-4">
        {/* 左侧：教师列表 */}
        <section className="flex min-h-0 flex-col gap-2 rounded-lg border border-border-subtle bg-card p-3">
          <div className="flex items-center gap-2">
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void loadTeachers()}
              placeholder="搜索教师..."
              disabled={busy}
            />
            <Button variant="outline" size="icon-sm" onClick={() => void loadTeachers()} disabled={busy} aria-label="搜索">
              <Search size={14} />
            </Button>
          </div>
          <div className="flex min-h-0 flex-col gap-1 overflow-auto max-h-[calc(100vh-260px)]">
            {teachers.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setSelectedId(t.id)}
                className={cn(
                  "flex w-full flex-col items-start rounded-md border px-3 py-2 text-left transition-colors",
                  selectedId === t.id
                    ? "border-primary bg-accent"
                    : "border-transparent hover:bg-secondary"
                )}
              >
                <span className="text-sm font-medium text-foreground">{t.name}</span>
                <small className="text-xs text-muted-foreground">
                  {t.subject || "未设科目"}{t.teacher_role ? ` · ${TEACHER_ROLE_LABELS[t.teacher_role] ?? t.teacher_role}` : ""}
                </small>
              </button>
            ))}
            {teachers.length === 0 && (
              <p className="px-2 py-1 text-sm text-muted-foreground">{keyword ? "无匹配教师" : "暂无教师"}</p>
            )}
          </div>
          <p className="px-2 text-xs text-muted-foreground">共 {total} 名教师</p>
        </section>

        {/* 右侧：详情面板 */}
        <section className="flex min-h-0 flex-col gap-3 rounded-lg border border-border-subtle bg-card p-4">
          {selected ? (
            <>
              <h3 className="text-sm font-semibold text-foreground">教师详情</h3>
              <div className="flex flex-col gap-3">
                <Field label="姓名">
                  <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label="任教科目">
                  <Select
                    value={editSubject || NONE}
                    onValueChange={(v) => setEditSubject(v === NONE ? "" : v)}
                    disabled={busy}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="— 未设置 —" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>— 未设置 —</SelectItem>
                      {SUBJECTS.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="教师角色">
                  <Select
                    value={editTeacherRole || NONE}
                    onValueChange={(v) => setEditTeacherRole(v === NONE ? "" : v)}
                    disabled={busy}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="普通教师（全权限）" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>普通教师（全权限）</SelectItem>
                      <SelectItem value="subject_teacher">学科老师</SelectItem>
                      <SelectItem value="head_teacher">班主任</SelectItem>
                      <SelectItem value="grade_leader">学年主任</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <div className="flex items-center gap-2">
                  <Button variant="primary" size="sm" onClick={handleSave} disabled={busy}>保存</Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setEditName(selected.name); setEditSubject(selected.subject ?? ""); }}
                    disabled={busy}
                  >
                    重置
                  </Button>
                </div>

                {/* 关联班级 */}
                <h3 className="pt-3 text-sm font-semibold text-foreground">关联班级</h3>
                <div className="flex max-h-[200px] flex-col gap-2 overflow-auto">
                  {selected.classes && selected.classes.length > 0 ? (
                    selected.classes.map((c) => (
                      <div
                        key={c.class_id}
                        className="flex items-center justify-between gap-2 rounded-md border border-border-subtle px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="text-sm text-foreground">{c.grade_name} · {c.class_name}</div>
                          <small className="text-xs text-muted-foreground">{c.subject || selected.subject || "任教"}</small>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="解除关联"
                          onClick={() => void handleUnlinkClass(c.class_id)}
                          disabled={busy}
                        >
                          <Unlink size={14} />
                        </Button>
                      </div>
                    ))
                  ) : (
                    <p className="px-2 py-1 text-sm text-muted-foreground">暂无关联班级</p>
                  )}
                </div>

                {/* 添加关联 */}
                <div className="flex items-center gap-2">
                  <Select
                    value={selectedGradeId != null ? String(selectedGradeId) : NONE}
                    onValueChange={(v) => setSelectedGradeId(v === NONE ? null : Number(v))}
                    disabled={busy}
                  >
                    <SelectTrigger className="w-auto">
                      <SelectValue placeholder="选年级" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>选年级</SelectItem>
                      {grades.map((g) => <SelectItem key={g.id} value={String(g.id)}>{g.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Select
                    value={selectedClassId != null ? String(selectedClassId) : NONE}
                    onValueChange={(v) => setSelectedClassId(v === NONE ? null : Number(v))}
                    disabled={busy}
                  >
                    <SelectTrigger className="w-auto">
                      <SelectValue placeholder="选班级" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>选班级</SelectItem>
                      {allClasses.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Button variant="outline" size="sm" icon={<Link size={14} />} onClick={handleLinkClass} disabled={busy || !selectedClassId}>
                    关联
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <p className="p-4 text-sm text-muted-foreground">请选择一名教师查看详情</p>
          )}
        </section>
      </div>

      {showImport && (
        <ImportModal
          title="批量导入教师"
          csvType="teacher"
          onImport={handleImport}
          onClose={() => setShowImport(false)}
        />
      )}

      {/* ── 新建教师弹窗 ────────────────────────────────── */}
      <Dialog
        open={showCreateModal}
        onOpenChange={(open) => { if (!open) setShowCreateModal(false); }}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>新建教师</DialogTitle>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3">
            <Field label="姓名">
              <Input
                value={newTeacherName}
                onChange={(e) => setNewTeacherName(e.target.value)}
                placeholder="教师姓名"
                disabled={busy}
              />
            </Field>
            <Field label="任教科目">
              <Select
                value={newTeacherSubject || NONE}
                onValueChange={(v) => setNewTeacherSubject(v === NONE ? "" : v)}
                disabled={busy}
              >
                <SelectTrigger>
                  <SelectValue placeholder="— 请选择科目 —" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>— 请选择科目 —</SelectItem>
                  {SUBJECTS.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <p className="text-xs text-muted-foreground">账号将自动生成（T + 6位随机数），密码为6位随机数字。</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateModal(false)}>取消</Button>
            <Button
              variant="primary"
              onClick={handleCreateTeacher}
              disabled={busy || !newTeacherName.trim() || !newTeacherSubject.trim()}
            >
              创建教师
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
