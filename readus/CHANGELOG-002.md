# CHANGELOG-002 | v1.1.0 — 教师/学生批量导入与独立管理

> **发布日期**: 2026-06-14
> **里程碑**: 大量师生账号一键导入、独立教师/学生管理面板、账密 Excel 导出

---

## 核心变更

### 1. CSV/Excel 批量导入师生

- **学生**：`年级,班级,学号,姓名` 格式，导入时自动创建年级/班级，账号 = `P` + 学号，密码 = 账号
- **教师**：`科目,姓名` 格式，导入时自动生成账号（`T` + 6位随机数）和密码（6位随机数字）
- 支持 **CSV / Excel (.xlsx / .xls)** 文件上传和粘贴文本
- 导入弹窗预览 + 模板下载；示例表格在 `input/` 目录

### 2. 教师管理面板

- **顶栏** 常驻「新建教师」「导入教师」「导出教师账密」按钮
- **左侧列表** 按创建时间排序，支持搜索
- **右侧详情** 编辑姓名、任教科目（9科下拉）、关联/解除班级
- 手动创建教师：科目下拉 + 姓名输入 → 自动生成 T+6位随机数账号和6位随机数字密码

### 3. 学生管理（原班级管理 Tab 重构）

- Tab 从「班级管理」改名为「学生管理」
- **顶栏** 常驻「导入学生」「导出学生账密」
- **三栏** 年级 → 班级（含人数） → 花名册（学号/姓名/账号）
- 花名册保留「新建」按钮，移除旧内联导入和空搜索图标
- 独立 StudentManagement Tab 已删除，功能合并到此

### 4. 账密导出统一为 Excel

- 学生导出：`年级,班级,学号,姓名,账号,密码` → `.xlsx`
- 教师导出：`科目,姓名,账号,密码` → `.xlsx`
- 成绩导出（分析 Tab）：`班级,考号,姓名,成绩,排名...` → `.xlsx`
- 导出前弹出安全警告；旧 CSV 端点 301 重定向到 `.xlsx`
- 导出使用 `fetch + blob` 下载，不再打开空白网页

### 5. 教师手动创建

- 教师管理顶部「新建教师」按钮，弹出科目+姓名表单
- 复用 import-csv 接口，自动生成 T+6位随机数账号密码
- 创建后自动刷新列表

---

## Bug 修复

| Bug | 根因 | 修复 |
|-----|------|------|
| 教师管理返回 HTML 而非 JSON | Express 5 `router.use()` 只接受**单个**回调 | 拆为独立两行 `router.use(authMiddleware); router.use(requirePermission(...))` |
| 导出打开空白网页 | `window.open()` 在新标签页打开 `.xlsx` | 改为 `fetch → blob → anchor download` |
| 花名册双导入按钮 | 旧内联导入弹窗 + 新顶部导入并存 | 删除旧导入弹窗代码和触发按钮 |
| 导入/导出图标方向错误 | 导入用 Upload、导出用 Download | 统一为导入=Download、导出=Upload |
| UI 版本号仍为 v1.0.1 | App.tsx 硬编码 | 更新为 v1.1.0 |

---

## 数据库变更

| 变更类型 | 说明 |
|----------|------|
| `users.subject TEXT` | 任教科目（仅教师） |
| `users.initial_password TEXT` | 初始明文密码（导出用） |
| 新建 `teacher_classes` 表 | 教师-班级多对多关联 (+ 可选科目覆盖) |
| 新建索引 | `idx_teacher_classes_teacher` / `idx_teacher_classes_class` |

> 向后兼容：新增列为 NULLABLE，不影响现网数据。

---

## 新增 API

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/users/import-csv` | 统一批量导入（学生+教师） |
| `GET` | `/api/teachers` | 教师列表（按创建时间排序） |
| `GET/PUT` | `/api/teachers/:id` | 教师详情 / 更新姓名/科目 |
| `POST` | `/api/teachers/:id/classes` | 教师关联班级 |
| `DELETE` | `/api/teachers/:id/classes/:classId` | 教师解除班级关联 |
| `GET` | `/api/export/students` | 导出学生账密 Excel |
| `GET` | `/api/export/teachers` | 导出教师账密 Excel |

> 旧 CSV 端点 `/api/export/students.csv` 和 `/api/export/teachers.csv` 301 重定向到上述新端点。

---

## 修改的现有 API

| 方法 | 路径 | 变更 |
|------|------|------|
| `GET` | `/api/analysis/exams/:examId/export-csv` | 输出格式从 CSV → Excel (.xlsx) |

---

## 前端文件变更

| 文件 | 变更 |
|------|------|
| `components/TeacherManagement.tsx` | **新建** — 教师管理面板 |
| `components/StudentManagement.tsx` | **新建** — 学生管理面板（已废弃，功能合并到 ClassManagement） |
| `components/ImportModal.tsx` | **新建** — 通用 CSV/Excel 导入弹窗 |
| `components/ClassManagement.tsx` | **修改** — 标题改名「学生管理」、新增导入/导出按钮、移除旧导入弹窗 |
| `components/AccountManagement.tsx` | **修改** — 2 Tab（教师管理/学生管理） |
| `util/csvParser.ts` | **新建** — CSV/Excel 解析工具 |
| `App.tsx` | **修改** — 成绩导出 .xlsx、UI 版本号 v1.1.0 |

---

## 依赖变更

- 新增 `xlsx` (SheetJS) — Excel 读写支持

---

## 文档更新

- `README.md` — 版本号、组件列表、API 表格
- `readus/DATABASE.md` — 新增列、新表说明
- `readus/ADMIN-GUIDE.md` — 教师/学生管理操作手册（完整重写 4-11 节）
- `readus/CHANGELOG-002.md` — 本文件
- `package.json` — 版本 1.0.1 → 1.1.0
- `input/student_template.{csv,xlsx}` — 学生导入示例
- `input/teacher_template.{csv,xlsx}` — 教师导入示例

---

## 版本号

- **旧版本**：v1.0.1
- **新版本**：v1.1.0
