/**
 * Admin-only: manage teacher permissions (which grades/data they can see).
 * Accessible via the Account menu when logged in as admin.
 */
import { useEffect, useState } from "react";
import { Check, Save, Shield, Trash2, X } from "lucide-react";
import { fetchJson } from "../auth/api";
import {
  Button,
  Checkbox,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Card,
  CardContent,
  TableWrap,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "./ui/v2";

/** Radix Select 不允许空字符串 value，用哨兵值表达「未选择」 */
const NONE = "__none__";

interface Permission {
  id: number;
  teacher_id: number;
  teacher_name: string;
  teacher_role: string;
  grade_id: number | null;
  grade_name: string | null;
  subject: string | null;
  class_id: number | null;
  block_id: string | null;
  can_view_scores: number;
  can_view_charts: number;
  can_view_students: number;
  can_grade: number;
  can_assign: number;
}

interface Teacher {
  id: number;
  name: string;
  role_name: string;
  teacher_role: string | null;
}

interface Grade {
  id: number;
  name: string;
}

interface Props {
  onBack: () => void;
}

export function PermissionManager({ onBack }: Props) {
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // New/edit form state
  const [selectedTeacher, setSelectedTeacher] = useState<number>(0);
  const [selectedGrade, setSelectedGrade] = useState<number | null>(null);
  const [subject, setSubject] = useState("");
  const [classId, setClassId] = useState("");
  const [blockId, setBlockId] = useState("");
  const [canScores, setCanScores] = useState(true);
  const [canCharts, setCanCharts] = useState(true);
  const [canStudents, setCanStudents] = useState(true);
  const [canGrade, setCanGrade] = useState(true);
  const [canAssign, setCanAssign] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);

  async function loadData() {
    setLoading(true);
    setError("");
    try {
      const [perms, teacherList, gradeList] = await Promise.all([
        fetchJson<Permission[]>("/api/admin/permissions"),
        fetchJson<{ users: Teacher[] }>("/api/teachers").then((r) => r.users || []),
        fetchJson<Grade[]>("/api/classes/grades"),
      ]);
      setPermissions(perms);
      setTeachers(teacherList.filter((t) => t.role_name === "teacher"));
      setGrades(gradeList);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadData(); }, []);

  async function handleSave() {
    if (!selectedTeacher) return;
    try {
      await fetchJson("/api/admin/permissions", {
        method: "PUT",
        body: JSON.stringify({
          teacher_id: selectedTeacher,
          grade_id: selectedGrade,
          subject: subject.trim() || undefined,
          class_id: classId.trim() ? Number(classId.trim()) : undefined,
          block_id: blockId.trim() || undefined,
          can_view_scores: canScores,
          can_view_charts: canCharts,
          can_view_students: canStudents,
          can_grade: canGrade,
          can_assign: canAssign,
        }),
      });
      // Reset form
      setSelectedTeacher(0);
      setSelectedGrade(null);
      setSubject("");
      setClassId("");
      setBlockId("");
      setCanScores(true);
      setCanCharts(true);
      setCanStudents(true);
      setCanGrade(true);
      setCanAssign(true);
      setEditingId(null);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("确定删除此权限设置？")) return;
    try {
      await fetchJson(`/api/admin/permissions/${id}`, { method: "DELETE" });
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    }
  }

  function editPermission(p: Permission) {
    setSelectedTeacher(p.teacher_id);
    setSelectedGrade(p.grade_id ?? null);
    setSubject(p.subject ?? "");
    setClassId(p.class_id != null ? String(p.class_id) : "");
    setBlockId(p.block_id ?? "");
    setCanScores(p.can_view_scores === 1);
    setCanCharts(p.can_view_charts === 1);
    setCanStudents(p.can_view_students === 1);
    setCanGrade(p.can_grade === 1);
    setCanAssign(p.can_assign === 1);
    setEditingId(p.id);
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Shield size={20} className="text-foreground" />
          <strong className="text-lg font-semibold text-foreground">教师权限管理</strong>
        </div>
        <Button variant="outline" size="sm" icon={<X size={16} />} onClick={onBack}>
          返回
        </Button>
      </header>

      {error && <p className="text-sm text-destructive-fg">{error}</p>}

      {/* Permission editor */}
      <Card>
        <CardContent className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-foreground">{editingId ? "编辑权限" : "新增权限"}</h3>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">教师</span>
              <Select
                value={selectedTeacher ? String(selectedTeacher) : NONE}
                onValueChange={(v) => setSelectedTeacher(v === NONE ? 0 : Number(v))}
              >
                <SelectTrigger className="min-w-[140px]">
                  <SelectValue placeholder="选择教师..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>选择教师...</SelectItem>
                  {teachers.map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>{t.name} ({t.teacher_role || "教师"})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">年级 (空=全部)</span>
              <Select
                value={selectedGrade != null ? String(selectedGrade) : NONE}
                onValueChange={(v) => setSelectedGrade(v === NONE ? null : Number(v))}
              >
                <SelectTrigger className="min-w-[120px]">
                  <SelectValue placeholder="全部年级" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>全部年级</SelectItem>
                  {grades.map((g) => (
                    <SelectItem key={g.id} value={String(g.id)}>{g.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">科目 (空=不限)</span>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="如：数学"
                className="h-9 min-w-[110px] rounded-md border border-input bg-card px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">班级 ID (空=不限)</span>
              <input
                value={classId}
                onChange={(e) => setClassId(e.target.value.replace(/[^\d]/g, ""))}
                placeholder="如：3"
                className="h-9 min-w-[110px] rounded-md border border-input bg-card px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">题块 ID (空=不限)</span>
              <input
                value={blockId}
                onChange={(e) => setBlockId(e.target.value)}
                placeholder="如：block-a"
                className="h-9 min-w-[110px] rounded-md border border-input bg-card px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Checkbox checked={canScores} onCheckedChange={(c) => setCanScores(c === true)} />
              查看成绩
            </label>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Checkbox checked={canCharts} onCheckedChange={(c) => setCanCharts(c === true)} />
              查看图表
            </label>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Checkbox checked={canStudents} onCheckedChange={(c) => setCanStudents(c === true)} />
              查看学生
            </label>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Checkbox checked={canGrade} onCheckedChange={(c) => setCanGrade(c === true)} />
              可阅卷
            </label>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Checkbox checked={canAssign} onCheckedChange={(c) => setCanAssign(c === true)} />
              可分配
            </label>
            <Button variant="primary" size="sm" icon={<Save size={14} />} onClick={() => void handleSave()} disabled={!selectedTeacher}>
              {editingId ? "更新" : "添加"}
            </Button>
            {editingId && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setEditingId(null); setSelectedTeacher(0); setSelectedGrade(null); setSubject(""); setClassId(""); setBlockId(""); setCanScores(true); setCanCharts(true); setCanStudents(true); setCanGrade(true); setCanAssign(true); }}
              >
                取消
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Permissions list */}
      {loading ? (
        <p className="py-10 text-center text-sm text-muted-foreground">加载中...</p>
      ) : permissions.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">暂无权限设置。默认教师可见所教班级的全部数据。</p>
      ) : (
        <TableWrap className="rounded-lg border border-border-subtle">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>教师</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>年级</TableHead>
                <TableHead>科目</TableHead>
                <TableHead>班级</TableHead>
                <TableHead>题块</TableHead>
                <TableHead className="text-center">成绩</TableHead>
                <TableHead className="text-center">图表</TableHead>
                <TableHead className="text-center">学生</TableHead>
                <TableHead className="text-center">阅卷</TableHead>
                <TableHead className="text-center">分配</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {permissions.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.teacher_name}</TableCell>
                  <TableCell className="text-muted-foreground">{p.teacher_role || "教师"}</TableCell>
                  <TableCell className="text-muted-foreground">{p.grade_name || "全部"}</TableCell>
                  <TableCell className="text-muted-foreground">{p.subject || "不限"}</TableCell>
                  <TableCell className="text-muted-foreground">{p.class_id != null ? p.class_id : "不限"}</TableCell>
                  <TableCell className="max-w-[140px] truncate text-muted-foreground" title={p.block_id ?? undefined}>{p.block_id || "不限"}</TableCell>
                  <TableCell className="text-center">
                    {p.can_view_scores ? <Check size={14} className="mx-auto text-foreground" /> : <X size={14} className="mx-auto text-muted-foreground" />}
                  </TableCell>
                  <TableCell className="text-center">
                    {p.can_view_charts ? <Check size={14} className="mx-auto text-foreground" /> : <X size={14} className="mx-auto text-muted-foreground" />}
                  </TableCell>
                  <TableCell className="text-center">
                    {p.can_view_students ? <Check size={14} className="mx-auto text-foreground" /> : <X size={14} className="mx-auto text-muted-foreground" />}
                  </TableCell>
                  <TableCell className="text-center">
                    {p.can_grade ? <Check size={14} className="mx-auto text-foreground" /> : <X size={14} className="mx-auto text-muted-foreground" />}
                  </TableCell>
                  <TableCell className="text-center">
                    {p.can_assign ? <Check size={14} className="mx-auto text-foreground" /> : <X size={14} className="mx-auto text-muted-foreground" />}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => editPermission(p)}>编辑</Button>
                      <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={() => void handleDelete(p.id)}>删除</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableWrap>
      )}
    </div>
  );
}
