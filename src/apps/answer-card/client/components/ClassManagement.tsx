import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRightLeft, Download, Pencil, Plus, RefreshCw, Search, Trash2, Upload, UserMinus, UserPlus } from "lucide-react";
import { fetchJson, authFetch } from "../auth/api";
import type { ClassRecord, ClassStudent, GradeRecord, UserListItem, UsersListResponse } from "../auth/types";
import { cn } from "../lib/utils";
import {
  Button,
  Input,
  Field,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./ui/v2";
import { ImportModal } from "./ImportModal";

/** Radix Select 不允许空字符串作为 value，用哨兵值表达「未选择」。 */
const NONE = "__none__";

// ── CSV / 制表符解析工具 ───────────────────────────────────
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  for (const line of lines) {
    const sep = line.includes(",") ? "," : "\t";
    const cells: string[] = [];
    let cell = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cell += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cell += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === sep) {
          cells.push(cell.trim());
          cell = "";
        } else {
          cell += ch;
        }
      }
    }
    cells.push(cell.trim());
    rows.push(cells);
  }
  return rows;
}

function extractStudents(rows: string[][]): Array<{ name: string; student_number: string; username: string }> {
  if (rows.length === 0) return [];
  const first = rows[0];
  const isHeader = first.some((c) => /姓名|name|学号|student_number|用户名|username/i.test(c));
  const dataRows = isHeader ? rows.slice(1) : rows;

  let nameIdx = -1,
    numberIdx = -1,
    usernameIdx = -1;
  if (isHeader) {
    for (let i = 0; i < first.length; i++) {
      const c = first[i].toLowerCase();
      if (/姓名|name/.test(c)) nameIdx = i;
      if (/学号|student_number/.test(c)) numberIdx = i;
      if (/用户名|username/.test(c)) usernameIdx = i;
    }
  }
  if (nameIdx === -1) nameIdx = 0;
  if (numberIdx === -1) numberIdx = 1;
  if (usernameIdx === -1) usernameIdx = numberIdx;

  return dataRows
    .filter((r) => r[nameIdx]?.trim() && r[numberIdx]?.trim())
    .map((r) => ({
      name: r[nameIdx].trim(),
      student_number: r[numberIdx].trim(),
      username: r[usernameIdx]?.trim() || r[numberIdx].trim()
    }));
}

export function ClassManagement() {
  const [grades, setGrades] = useState<GradeRecord[]>([]);
  const [classes, setClasses] = useState<ClassRecord[]>([]);
  const [selectedGradeId, setSelectedGradeId] = useState<number | null>(null);
  const [selectedClassId, setSelectedClassId] = useState<number | null>(null);
  const [roster, setRoster] = useState<ClassStudent[]>([]);
  const [newGradeName, setNewGradeName] = useState("");
  const [newClassName, setNewClassName] = useState("");
  const [studentSearch, setStudentSearch] = useState("");
  const [studentResults, setStudentResults] = useState<UserListItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // 导入弹窗状态
  const [showImportModal, setShowImportModal] = useState(false);
  const [importText, setImportText] = useState("");
  const [importPreview, setImportPreview] = useState<Array<{ name: string; student_number: string; username: string }>>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 快捷新建学生
  const [newStudentName, setNewStudentName] = useState("");
  const [newStudentNumber, setNewStudentNumber] = useState("");
  // 标题栏新建学生弹窗
  const [showNewStudentGlobal, setShowNewStudentGlobal] = useState(false);

  // v1.1: 批量导入（CSV/Excel）
  const [showCsvImport, setShowCsvImport] = useState(false);

  // 学生迁移弹窗（跨班级/跨年级）
  const [moveTarget, setMoveTarget] = useState<ClassStudent | null>(null);
  const [moveGradeId, setMoveGradeId] = useState<number | null>(null);
  const [moveClassId, setMoveClassId] = useState<number | null>(null);
  const [allClasses, setAllClasses] = useState<ClassRecord[]>([]);

  const loadGrades = useCallback(async () => {
    const data = await fetchJson<GradeRecord[]>("/api/classes/grades");
    setGrades(data);
    setSelectedGradeId((current) => (current === null && data.length > 0 ? data[0].id : current));
  }, []);

  const loadClasses = useCallback(async (gradeId: number | null) => {
    const url = gradeId ? `/api/classes?gradeId=${gradeId}` : "/api/classes";
    const data = await fetchJson<ClassRecord[]>(url);
    setClasses(data);
    setSelectedClassId((current) => {
      if (data.length === 0) return null;
      if (current !== null && data.some((c) => c.id === current)) return current;
      return data[0].id;
    });
    if (data.length === 0) setRoster([]);
  }, []);

  const loadRoster = useCallback(async (classId: number) => {
    const data = await fetchJson<ClassStudent[]>(`/api/classes/${classId}/students`);
    setRoster(data);
  }, []);

  useEffect(() => {
    void (async () => {
      setBusy(true);
      try {
        await loadGrades();
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载年级失败");
      } finally {
        setBusy(false);
      }
    })();
  }, [loadGrades]);

  useEffect(() => {
    if (selectedGradeId === null) return;
    void (async () => {
      setBusy(true);
      try {
        await loadClasses(selectedGradeId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载班级失败");
      } finally {
        setBusy(false);
      }
    })();
  }, [selectedGradeId, loadClasses]);

  useEffect(() => {
    if (selectedClassId === null) return;
    void (async () => {
      try {
        await loadRoster(selectedClassId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载花名册失败");
      }
    })();
  }, [selectedClassId, loadRoster]);

  async function createGrade() {
    if (!newGradeName.trim()) {
      setError("请先填写年级名称");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await fetchJson("/api/classes/grades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newGradeName.trim() })
      });
      setNewGradeName("");
      await loadGrades();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建年级失败");
    } finally {
      setBusy(false);
    }
  }

  async function deleteGrade(id: number, name: string) {
    if (!confirm(`删除年级「${name}」及其下所有班级？`)) return;
    setBusy(true);
    try {
      await fetchJson(`/api/classes/grades/${id}`, { method: "DELETE" });
      if (selectedGradeId === id) setSelectedGradeId(null);
      await loadGrades();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    } finally {
      setBusy(false);
    }
  }

  async function renameGrade(id: number, name: string) {
    const next = prompt("修改年级名称：", name)?.trim();
    if (!next || next === name) return;
    setBusy(true);
    setError("");
    try {
      await fetchJson(`/api/classes/grades/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: next })
      });
      await loadGrades();
    } catch (err) {
      setError(err instanceof Error ? err.message : "重命名失败");
    } finally {
      setBusy(false);
    }
  }

  async function createClass() {
    if (!selectedGradeId) {
      setError("请先选择年级");
      return;
    }
    if (!newClassName.trim()) {
      setError("请先填写班级名称");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await fetchJson("/api/classes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gradeId: selectedGradeId, name: newClassName.trim() })
      });
      setNewClassName("");
      await loadClasses(selectedGradeId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建班级失败");
    } finally {
      setBusy(false);
    }
  }

  async function deleteClass(id: number, name: string) {
    if (!confirm(`删除班级「${name}」？`)) return;
    setBusy(true);
    try {
      await fetchJson(`/api/classes/${id}`, { method: "DELETE" });
      if (selectedClassId === id) setSelectedClassId(null);
      if (selectedGradeId) await loadClasses(selectedGradeId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    } finally {
      setBusy(false);
    }
  }

  async function searchStudents() {
    if (!studentSearch.trim()) return;
    try {
      const result = await fetchJson<UsersListResponse>(
        `/api/users?role=student&keyword=${encodeURIComponent(studentSearch.trim())}&pageSize=10`
      );
      setStudentResults(result.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : "搜索失败");
    }
  }

  async function addStudent(studentId: number) {
    if (!selectedClassId) return;
    setBusy(true);
    try {
      await fetchJson(`/api/classes/${selectedClassId}/students`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId })
      });
      await loadRoster(selectedClassId);
      if (selectedGradeId) await loadClasses(selectedGradeId);
      setStudentResults([]);
      setStudentSearch("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "添加失败");
    } finally {
      setBusy(false);
    }
  }

  async function removeStudent(studentId: number, name: string) {
    if (!selectedClassId || !confirm(`将「${name}」移出班级？`)) return;
    setBusy(true);
    try {
      await fetchJson(`/api/classes/${selectedClassId}/students/${studentId}`, { method: "DELETE" });
      await loadRoster(selectedClassId);
      if (selectedGradeId) await loadClasses(selectedGradeId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "移除失败");
    } finally {
      setBusy(false);
    }
  }

  async function openMoveDialog(student: ClassStudent) {
    setMoveTarget(student);
    setMoveGradeId(selectedGradeId);
    setMoveClassId(null);
    try {
      setAllClasses(await fetchJson<ClassRecord[]>("/api/classes"));
    } catch {
      setAllClasses(classes);
    }
  }

  async function confirmMove() {
    if (!moveTarget || !selectedClassId || !moveClassId) return;
    setBusy(true);
    setError("");
    try {
      await fetchJson(`/api/classes/${selectedClassId}/students/${moveTarget.student_id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetClassId: moveClassId })
      });
      await loadRoster(selectedClassId);
      if (selectedGradeId) await loadClasses(selectedGradeId);
      setMoveTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "迁移失败");
    } finally {
      setBusy(false);
    }
  }

  // ── 导入 ──────────────────────────────────────────────
  function previewImport(text: string) {
    const rows = parseCsv(text);
    const students = extractStudents(rows);
    setImportPreview(students);
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      setImportText(text);
      previewImport(text);
    };
    reader.readAsText(file);
  }

  async function handleImport() {
    if (!selectedClassId || importPreview.length === 0) return;
    setBusy(true);
    setError("");
    try {
      // 1) 批量创建学生
      const importResult = await fetchJson<{ created: number; skipped: number; errors: unknown[]; createdIds: number[] }>(
        "/api/users/import-students",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            students: importPreview.map((s) => ({
              username: s.username,
              name: s.name,
              student_number: s.student_number
            }))
          })
        }
      );

      // 2) 将创建成功的学生加入班级
      const ids = importResult.createdIds ?? [];
      if (ids.length > 0) {
        await fetchJson(`/api/classes/${selectedClassId}/students`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ studentIds: ids })
        });
      }

      // 3) 刷新
      await loadRoster(selectedClassId);
      if (selectedGradeId) await loadClasses(selectedGradeId);

      setShowImportModal(false);
      setImportText("");
      setImportPreview([]);
      setError(
        `导入完成：新创建 ${importResult.created} 人并加入班级，跳过 ${importResult.skipped} 人（已存在），错误 ${importResult.errors.length} 条。`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败");
    } finally {
      setBusy(false);
    }
  }

  // ── v1.1 CSV 批量导入 ────────────────────────────────
  async function handleCsvImport(csvText: string) {
    setBusy(true);
    setError("");
    try {
      await fetchJson("/api/users/import-csv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvText })
      });
      await loadGrades();
      if (selectedGradeId) await loadClasses(selectedGradeId);
      if (selectedClassId) await loadRoster(selectedClassId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败");
      throw err;
    } finally {
      setBusy(false);
    }
  }

  function handleExportStudents() {
    if (!confirm("导出文件将包含学生明文密码，请妥善保管！\n确定要下载吗？")) return;
    authFetch("/api/export/students")
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "student_accounts.xlsx";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "导出失败"));
  }

  // ── 快捷新建学生（输入+加号，与年级/班级交互一致） ──────
  async function handleQuickCreateStudent() {
    if (!selectedClassId || !newStudentName.trim() || !newStudentNumber.trim()) return;
    setBusy(true);
    setError("");
    try {
      const created = await fetchJson<{ id: number }>("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: newStudentNumber.trim(),
          name: newStudentName.trim(),
          role: "student",
          student_number: newStudentNumber.trim()
        })
      });

      await fetchJson(`/api/classes/${selectedClassId}/students`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId: created.id })
      });

      await loadRoster(selectedClassId);
      if (selectedGradeId) await loadClasses(selectedGradeId);

      setNewStudentName("");
      setNewStudentNumber("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建学生失败");
    } finally {
      setBusy(false);
    }
  }

  // ── 新建学生（全局，无班级关联） ──────────────────────
  async function handleGlobalCreateStudent() {
    if (!newStudentName.trim() || !newStudentNumber.trim()) return;
    setBusy(true);
    setError("");
    try {
      await fetchJson("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: newStudentNumber.trim(),
          name: newStudentName.trim(),
          role: "student",
          student_number: newStudentNumber.trim()
        })
      });
      await loadGrades();
      if (selectedGradeId) await loadClasses(selectedGradeId);
      if (selectedClassId) await loadRoster(selectedClassId);
      setNewStudentName("");
      setNewStudentNumber("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建学生失败");
    } finally {
      setBusy(false);
    }
  }

  // ── 新建学生（旧弹窗兼容，保留逻辑供标题栏使用） ──────────
  async function handleCreateStudent() {
    if (!selectedClassId || !newStudentName.trim() || !newStudentNumber.trim()) return;
    setBusy(true);
    setError("");
    try {
      const created = await fetchJson<{ id: number }>("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: newStudentNumber.trim(),
          name: newStudentName.trim(),
          role: "student",
          student_number: newStudentNumber.trim()
        })
      });

      await fetchJson(`/api/classes/${selectedClassId}/students`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId: created.id })
      });

      await loadRoster(selectedClassId);
      if (selectedGradeId) await loadClasses(selectedGradeId);

      setNewStudentName("");
      setNewStudentNumber("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建学生失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">学生管理</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" icon={<RefreshCw size={16} />} onClick={() => void loadGrades()} disabled={busy}>
            刷新
          </Button>
          <Button
            variant="outline"
            size="sm"
            icon={<UserPlus size={16} />}
            onClick={() => { setShowNewStudentGlobal(true); setNewStudentName(""); setNewStudentNumber(""); }}
            disabled={busy}
          >
            新建学生
          </Button>
          <Button variant="outline" size="sm" icon={<Download size={16} />} onClick={() => setShowCsvImport(true)} disabled={busy}>
            导入学生
          </Button>
          <Button variant="primary" size="sm" icon={<Upload size={16} />} onClick={handleExportStudents}>
            导出学生账密
          </Button>
        </div>
      </header>

      {error && <p className="text-sm text-destructive-fg">{error}</p>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* 年级 */}
        <section className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-card p-3">
          <h3 className="text-sm font-semibold text-foreground">年级</h3>
          <div className="flex items-center gap-2">
            <Input placeholder="新年级名称" value={newGradeName} onChange={(e) => setNewGradeName(e.target.value)} />
            <Button variant="primary" size="icon-sm" onClick={() => void createGrade()}>
              <Plus size={14} />
            </Button>
          </div>
          <div className="flex flex-col gap-1">
            {grades.map((g) => (
              <div
                key={g.id}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-md border px-3 py-2",
                  selectedGradeId === g.id ? "border-primary bg-accent" : "border-transparent hover:bg-secondary"
                )}
              >
                <button type="button" onClick={() => setSelectedGradeId(g.id)} className="min-w-0 flex-1 text-left text-sm font-medium text-foreground">
                  {g.name}
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="icon-sm" title="重命名年级" onClick={() => void renameGrade(g.id, g.name)} disabled={busy}>
                    <Pencil size={14} />
                  </Button>
                  <Button variant="ghost" size="icon-sm" title="删除年级" onClick={() => void deleteGrade(g.id, g.name)} disabled={busy}>
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
            ))}
            {grades.length === 0 && <p className="px-2 py-1 text-sm text-muted-foreground">暂无年级</p>}
          </div>
        </section>

        {/* 班级 */}
        <section className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-card p-3">
          <h3 className="text-sm font-semibold text-foreground">班级</h3>
          <div className="flex items-center gap-2">
            <Input
              placeholder="新班级名称"
              value={newClassName}
              onChange={(e) => setNewClassName(e.target.value)}
              disabled={!selectedGradeId}
            />
            <Button variant="primary" size="icon-sm" onClick={() => void createClass()} disabled={!selectedGradeId}>
              <Plus size={14} />
            </Button>
          </div>
          <div className="flex flex-col gap-1">
            {classes.map((c) => (
              <div
                key={c.id}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-md border px-3 py-2",
                  selectedClassId === c.id ? "border-primary bg-accent" : "border-transparent hover:bg-secondary"
                )}
              >
                <button type="button" onClick={() => setSelectedClassId(c.id)} className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left text-sm font-medium text-foreground">
                  <span className="truncate">{c.name}</span>
                  <small className="shrink-0 text-xs text-muted-foreground">{c.student_count ?? 0} 人</small>
                </button>
                <Button variant="ghost" size="icon-sm" title="删除班级" onClick={() => void deleteClass(c.id, c.name)} disabled={busy}>
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
            {classes.length === 0 && <p className="px-2 py-1 text-sm text-muted-foreground">该年级暂无班级</p>}
          </div>
        </section>

        {/* 花名册 */}
        <section className="flex min-h-0 flex-col gap-3 rounded-lg border border-border-subtle bg-card p-3">
          <h3 className="text-sm font-semibold text-foreground">花名册</h3>
          {selectedClassId ? (
            <>
              {/* 搜索已有学生 */}
              <div className="flex items-center gap-2">
                <Input
                  placeholder="搜索已有学生学号/姓名"
                  value={studentSearch}
                  onChange={(e) => setStudentSearch(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void searchStudents()}
                  disabled={busy}
                />
                <Button variant="outline" size="icon-sm" onClick={() => void searchStudents()} disabled={busy} aria-label="搜索">
                  <Search size={14} />
                </Button>
              </div>
              {studentResults.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  {studentResults.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="rounded-md border border-border-subtle px-3 py-2 text-left text-sm text-foreground hover:bg-secondary"
                      onClick={() => void addStudent(s.id)}
                      disabled={busy}
                    >
                      {s.name} ({s.student_number ?? s.username})
                    </button>
                  ))}
                </div>
              )}
              {/* 快捷新建学生 */}
              <div className="flex items-center gap-2">
                <Input
                  placeholder="学号"
                  value={newStudentNumber}
                  onChange={(e) => setNewStudentNumber(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void handleCreateStudent()}
                  disabled={busy}
                  className="flex-1"
                />
                <Input
                  placeholder="姓名"
                  value={newStudentName}
                  onChange={(e) => setNewStudentName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void handleCreateStudent()}
                  disabled={busy}
                  className="flex-1"
                />
                <Button variant="primary" size="icon-sm" onClick={() => void handleCreateStudent()} disabled={busy || !newStudentName.trim() || !newStudentNumber.trim()}>
                  <Plus size={14} />
                </Button>
              </div>
              <div className="flex flex-col gap-1">
                {roster.map((s) => (
                  <div key={s.student_id} className="flex items-center justify-between gap-2 rounded-md border border-border-subtle px-3 py-2">
                    <div className="min-w-0">
                      <div className="text-sm text-foreground">{s.name}</div>
                      <small className="text-xs text-muted-foreground">{s.student_number ?? s.username}</small>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button variant="ghost" size="icon-sm" title="迁移到其他班级" onClick={() => void openMoveDialog(s)} disabled={busy}>
                        <ArrowRightLeft size={14} />
                      </Button>
                      <Button variant="ghost" size="icon-sm" title="移出班级" onClick={() => void removeStudent(s.student_id, s.name)} disabled={busy}>
                        <UserMinus size={14} />
                      </Button>
                    </div>
                  </div>
                ))}
                {roster.length === 0 && <p className="px-2 py-1 text-sm text-muted-foreground">班级暂无学生</p>}
              </div>
            </>
          ) : (
            <p className="px-2 py-1 text-sm text-muted-foreground">请先选择班级</p>
          )}
        </section>
      </div>

      {/* ── v1.1 CSV/Excel 批量导入弹窗 ─────────────────── */}
      {showCsvImport && (
        <ImportModal
          title="批量导入学生"
          csvType="student"
          onImport={handleCsvImport}
          onClose={() => setShowCsvImport(false)}
        />
      )}

      {/* ── 全局新建学生弹窗（标题栏入口） ────────────────── */}
      <Dialog
        open={showNewStudentGlobal}
        onOpenChange={(open) => { if (!open) setShowNewStudentGlobal(false); }}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>新建学生</DialogTitle>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3">
            <Field label="学号">
              <Input
                value={newStudentNumber}
                onChange={(e) => setNewStudentNumber(e.target.value)}
                placeholder="学号（默认作为用户名和初始密码）"
                disabled={busy}
              />
            </Field>
            <Field label="姓名">
              <Input
                value={newStudentName}
                onChange={(e) => setNewStudentName(e.target.value)}
                placeholder="学生姓名"
                disabled={busy}
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewStudentGlobal(false)}>取消</Button>
            <Button
              variant="primary"
              onClick={() => void handleGlobalCreateStudent()}
              disabled={busy || !newStudentName.trim() || !newStudentNumber.trim()}
            >
              创建学生
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── 学生迁移弹窗 ────────────────────────────────── */}
      <Dialog
        open={moveTarget !== null}
        onOpenChange={(open) => { if (!open) setMoveTarget(null); }}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>迁移学生</DialogTitle>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              将 {moveTarget?.name}（{moveTarget?.student_number ?? moveTarget?.username}）迁移到：
            </p>
            <Field label="年级">
              <Select
                value={moveGradeId != null ? String(moveGradeId) : NONE}
                onValueChange={(v) => { setMoveGradeId(v === NONE ? null : Number(v)); setMoveClassId(null); }}
                disabled={busy}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择年级" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>选择年级</SelectItem>
                  {grades.map((g) => <SelectItem key={g.id} value={String(g.id)}>{g.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="班级">
              <Select
                value={moveClassId != null ? String(moveClassId) : NONE}
                onValueChange={(v) => setMoveClassId(v === NONE ? null : Number(v))}
                disabled={busy || moveGradeId == null}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择班级" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>选择班级</SelectItem>
                  {allClasses
                    .filter((c) => c.grade_id === moveGradeId && c.id !== selectedClassId)
                    .map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveTarget(null)}>取消</Button>
            <Button variant="primary" onClick={() => void confirmMove()} disabled={busy || moveClassId == null}>
              迁移
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
