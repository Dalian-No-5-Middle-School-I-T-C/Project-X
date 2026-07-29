# 成绩分析界面优化重构 + 选项分析 + 跨班对比 + 阈值体系 — 设计文档

> 日期：2026-07-29 ｜ 状态：已批准实施
> 已结合《成绩分析能力差距分析与建设路线图》（对比一起中学/极课大数据/智学网/好分数）：并入 **P0-1 可配置阈值** 与 **P0-4 轻量版（薄弱项分层+预警）**；路线图 P2-1（作答痕迹/选项回放）即本文档的选项分析功能。

## 〇、已确认决策与默认假设

| 决策点 | 结论 |
|---|---|
| 视觉方向 | 精进现有深红 `#C00F28` 液态玻璃体系，借鉴原型稿信息架构（大数字指标卡、排行徽章、打印样式） |
| 历史数据回填 | 仅支持新阅考试；历史考试显示友好空态"该考试阅卷时未记录选项数据" |
| 跨班对比 | 单场考试内勾选 2–8 个班级对比 |
| 附加功能 | 讲评模式（投屏）、临界生/波动生名单、打印样式、接通知识点分析 |
| 路线图并入 | ✅ P0-1 可配置阈值（全局级）、✅ P0-4 轻量版分层+预警；❌ P0-2/P0-3/P2-3/全部 P1 → 后续迭代 |
| 学生端 | 本次只做教师端 |

## 一、后端改动

### B1. 选项持久化（核心前置；对应路线图 P2-1）
- **迁移 v29**（SQLite `migrations.ts` + MySQL 变体 + `schema.sql` 三处同步）：
  - `question_scores` 新增 `selected_options TEXT`（JSON 数组，如 `["A","C"]`）；
  - `system_settings` 插入阈值默认键（INSERT OR IGNORE）：`analysis_pass_rate=0.6`、`analysis_excellent_rate=0.9`、`analysis_segment_size=10`、`analysis_error_tiers=70,50,30`。
- **`persistGradingResults`**（`src/apps/answer-card/server/index.ts:347-402`）：`insertQsSql` 增加 `selected_options` 列，客观题写入 `JSON.stringify(q.selectedOptions ?? [])`（`ObjectiveQuestionGrade` 天然携带）。
- **学生详情端点换源**（`src/server/routes/score-editing.ts:55-198`）：查询带上 `selected_options`；`recognition` 响应字段改为优先从 `question_scores` 构造（保留 `objective_recognitions` 查询作 confidence 回退）——**响应契约不变**。
- **顺带修复现存缺陷**：同文件"改答案 key 后重评分"（约 417-435 行）目前从永远为空的 `objective_recognitions` 读选项，会把全体学生当未作答——改从 `question_scores.selected_options` 读。
- **DemoDataService**：演示数据生成客观题得分时同步生成符合目标正确率的 `selected_options`（多选题生成多选组合），让新功能立即可演示。

### B2. 新端点：选项分析
`GET /api/analysis/exams/:id/option-analysis?classId=`（analysisGate + requireExamAccess）
- 返回 `{ hasOptionData, questions: [{ questionNumber, mode, optionCount, maxScore, answerKey, correctRate, unansweredCount, options: [{ option, count, rate, isCorrect }] }] }`
- 数据源：`question_scores` 中 `score_type='objective' AND selected_options IS NOT NULL`；classId 过滤沿用 `classFilter` JOIN 模式；多选按"选项被选人次"统计；空选计入 `unansweredCount`；无数据时 `hasOptionData=false`。
- 类型定义加入 `src/shared/types.ts`。

### B3. 新端点：跨班对比
`GET /api/analysis/exams/:id/class-comparison?classIds=1,2,3&includeOptions=1`
- 校验 classIds 数量 2–8，非法 400。
- 返回：`classes`（每班 count/avg/max/min/median/stdDev/passRate/excellentRate/分段 distribution，阈值读配置）、`questionStats`（逐题×逐班 scoreRate，客观题含 correctRate）、`optionStats`（可选，逐客观题×逐班×选项 pick-rate）。
- 复用 `getClassScoreSummaries`/`classFilterQs` 模式，新增 `GROUP BY question_number, class_id` 变体。

### B4. 阈值配置体系（路线图 P0-1，全局级）
- 新增 `GET/PUT /api/analysis/config/thresholds`（GET 任何分析权限可读；PUT 限管理员，写 `system_settings`）。
- `AnalysisRepository` 改造：`getExamOverview`（及格率/优秀率/分段粒度）、`getQuestionAnalysis`（错误率档位）、`getClassScoreSummaries` 等全部改为读配置而非写死 60%/90%/10 分/70-50-30。
- 临界生名单、知识点预警线均使用配置阈值。

### B5. 知识点分层+预警（路线图 P0-4 轻量版）
- `KnowledgePointRepository.getWeaknessesForExam` 扩展：每个知识点增加 `severity`（共性薄弱=得分率低于预警线且覆盖人数占比高 / 一般薄弱）与 `coverageRate` 字段；预警线读阈值配置。
- 不做聚合算法重写、不做 AI 自动标注（P1-1，后续）。

### B6. 已有接口不动
知识点 `/knowledge-points/:examId`、AI 分析、导出等保持现有契约。

## 二、前端改动

### F1. 基础清理（先行）
- 提取 `util/format.ts`（`formatScore` 等 5+ 处重复）；`thS/tdS` 内联表格样式收敛到共享常量/`ui/Table.tsx`；硬编码色值 → CSS 变量/`theme.ts` tokens。
- 删除死代码：`AnalysisRanking.tsx`、App.tsx 的 `loadAnalysis`/`downloadAnalysisCsv`/遗留 analysis 状态、WorkspaceContext 对应声明、未使用的 `ComparisonBar`。
- 扩展 `AnalysisCharts.tsx`：`DistributionBar`（分段柱状图，柱数随配置粒度）等；分布/趋势统一 chart.js；箱线图手写 SVG 提取为共享组件。

### F2. ScoreDetailPage 标签重组（4 → 5 标签）
1. **概况**：KPI 指标卡（均分/及格率/优秀率/标准差 + 较上届变化；指标旁标注当前阈值如"及格线 90 分"）；chart.js 分段柱状图（替换 CSS 条+环形图双份重复）；班级箱线图（保留可点击）；前五/后五统一为单一 `TopList` 组件（删重复实现）；进步/退步 Top5；**临界生名单**（及格/优秀线 ±5 分，阈值可配）；右上角 ⚙ 阈值设置入口（管理员可改，弹窗写 B4 接口）。
2. **成绩**：ScoreTable 样式统一；`StudentScoreDetail` 逐题表为客观题新增"作答"列（所选选项 `B`/`AC`，对绿错红 + 全班正确率），点击行展开迷你选项分布条。
3. **题目分析**（原"考试分析"重构）：题目得分率表（错误档位读配置）；点击题目行展开 `OptionDistributionChart`（横向条形，正确选项绿色高亮、干扰项按选择率红色深浅、标注未答人数）；**知识点分析接通真实数据**（替换虚线占位符），共性薄弱知识点红色预警标记、一般薄弱黄色，并展示覆盖率；"讲评模式"按钮 → 全屏投屏覆盖层（大字号高对比、逐题选项分布+正确率、键盘 ←→ 导航）。
4. **班级对比**（新标签）：班级多选 chips（2–8）→ ① 总分对比统计表+分组柱状图 ② 分段分布对比（分组/堆叠柱状图）③ 逐题得分率热力表（行=题、列=班、色深=得分率，点击客观题单元格下钻选项级跨班对比）。
5. **AI分析**：不动。

### F3. 打印样式
`styles.css` 新增 `@media print`（隐藏导航/按钮/筛选器、白底、图表分页适配）；概况页"打印报告"按钮调 `window.print()`。

### F4. 规范
遵循 `breakpoints.ts`+`useIsMobile()`；热力表移动端降级为卡片列表；全部设计令牌 + 暗色模式适配；lucide 图标；中文文案。

## 三、实施顺序

1. 设计文档落盘（本文件）并提交。
2. **B1 选项持久化**（迁移 + persist + 换源 + 重评分修复 + demo 数据）。
3. **B4 阈值体系**（settings 端点 + Repository 改造）→ **B2/B3 新端点** → **B5 知识点分层**。
4. **F1 基础清理**。
5. **F2 逐标签重构**：概况（含阈值设置+临界生）→ 题目分析（选项+讲评+知识点）→ 班级对比 → 成绩/学生详情。
6. **F3 打印** + 全站走查打磨（暗色/移动端/打印预览）。

## 四、验证

- `npm run typecheck`；`npm run verify:auth`（54 项不回归）；`npm run verify:security-critical`。
- 新增 smoke 脚本（参照 `scripts/grading-rules-smoke.ts`）：选项统计正确性（count/rate/多选/未答）、class-comparison 参数校验与数值、阈值配置生效（改配置后及格率/分段/档位随之变化）。
- 手工验证：`npm run dev` + 演示数据走查五个标签、暗色模式、移动端、打印预览。
- 不新增 npm 依赖。

## 五、明确不做（后续迭代候选）

- 路线图 P0-2（任意两场对比）、P0-3（标准分归一）、P2-3（分数段占比趋势）
- 路线图 P1 全部（知识点自动抽取/图谱、成长档案物化、多维报告体系、增值评价）、P2-2 预测预警、P2-4 常态化学情
- 历史考试选项回填；学生端选项分析；服务端 PDF 报告
