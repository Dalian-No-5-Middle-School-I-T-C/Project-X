# 更新日志（CHANGELOG）

本项目遵循语义化版本规范（SemVer）。所有版本变更均记录于此文件，最新条目居首。

---

## [v1.9.7] — 2026-08-18 · 答题卡设计器实机缺陷修复

> 版本定位：基于 `v1.9.6`（答题卡设计器子模块 `answer-card-designer` 对应包版本 `2.2.2`）的缺陷修复补丁。
> 本次为纯 Bug Fix 版本，无新增功能、无破坏性变更（API / 数据库 Schema 不变）。

### 修复（Bug Fixes）

| 优先级 | 问题 | 模块 | 修复说明 |
|--------|------|------|----------|
| **P0** | 保存答题卡报错：`Bind parameters must not contain undefined` | 后端 `CardRepository.ts` | 主观题（`INSERT INTO subjective_questions`）在字段缺失时将 `blanks` 相关四列回退为 `undefined`、JSON 列回退为 `undefined`，better-sqlite3 拒绝绑定。**将四列改为 `?? null`、四处 JSON 列改为 `null`**，消除保存阻断。影响所有含主观题块（填空 / 解答 / 作文）的卡。 |
| **P0** | PDF 导出完全无法使用 | 前端 `App.tsx` / 后端 `pdf.ts` | 根因为上述保存阻断（`flushPendingCardSave` 抛错后直接 `return`，PDF 请求未发起）。随保存修复一并打通；并加固 `pdf.ts` 的主观题得分格绘制逻辑，使其显式受 `scoreGrid.enabled` 控制（V1 / V2 布局均生效）。 |
| **P1** | 作文格编辑器功能列表混乱、无法正常使用 | 前端 `DesignEditors.tsx` | `SubjectiveEditor` 此前对所有主观题块统一走通用逐题编辑器，作文块被渲染大量不适用控件并与作文专属控件并存。现对 `blockKind === "essay"` 跳过通用逐题循环，仅呈现作文专属控件；并补全此前遗漏的「显示粗边框（`showFrame`）」「显示字数刻度（`showWordScale`）」开关。 |
| **P1** | 填空题缺少得分栏（分数格）显隐开关 | 前端 `DesignEditors.tsx` / 后端 `pdf.ts` / 共享 `scoreGrid.ts` | 得分填涂格开关此前被 `!isFillBlankBlock` 门控，填空题无法关闭得分格。现于填空题分支新增「显示得分填涂格」「显示"得分"标签」两个开关，与解答题语义一致。**代码评审补丁（PR #242）**：抽取共享判定函数 `shouldRenderScoreGrid`（`src/shared/scoreGrid.ts`），SVG 预览（`SubjectiveSvg`）与 PDF 导出（`pdf.ts`）统一消费同一门控，消除两端口径漂移；`enabled` 缺省视为开启（旧数据向后兼容），`showLabel=false` 仅隐藏"得分"标签、不影响方格。 |
| **P2** | 右栏「选中块设置」与「基本信息」视觉混淆、相互覆盖 | 前端 `DesignPage.tsx` | 右栏检查器原将两块面板顺序堆叠于同一窄栏，表头雷同易混淆。现改造为标签页：「基本信息」/「选中块设置」二选一展示，选中题块时自动切换至块设置，亦可手动切回。 |
| **P2** | 填空题右侧批注水平高度与答题横线齐平、不美观 | 前端 `DesignEditors.tsx` | SVG 预览中填空左侧空号标签与右侧批注文本原定位在答题横线（`y = blank.y + blank.height`），压线而过。现统一上移 `1.8mm`，与 PDF 端既有 `-2.35mm` 偏移视觉对齐，呈现于横线上方居中。 |
| **P3** | 填空题「横线高度（MM）」标签在窄栏内换行 | 前端 `DesignEditors.tsx` | 标签文案过长导致折行破坏对齐。缩短为「横线高(mm)」。 |

### 部署注意事项

- **PDF 中文渲染（非代码阻断项）**：`pdf.ts` 已内置多平台 CJK 字体候选（Windows `simsun.ttc`、macOS `PingFang`、Linux `Noto Sans CJK` 等）及系统字体扫描回退；仅当全部缺失时才降级为 `Helvetica`（中文空白）。生产环境（浪潮 5220 / Linux）需确保存在可用 CJK 字体，或显式设置环境变量 `PROJECTX_PDF_FONT_PATH` 指向字体文件。
- 本次改动经 `tsc --noEmit` 类型校验，新增代码无语法 / 类型错误；项目基线既有类型告警（`Button` 组件 props 未声明 `variant` 等，全库 340 处同类）不影响 Vite / esbuild 构建与运行。

### 测试

- 新增 `npm run verify:score-grid`（`scripts/verify-score-grid.ts`，沿用项目 `verify:*` tsx 冒烟体系，无新增依赖）：覆盖判定函数 8 组单元用例（enabled 开关 / 缺省向后兼容 / showLabel 独立性 / 非分数格样式 / V2 空方格防御 / V1 放行）+ 3 组布局链路集成（enabled=false 时 `layout.ts` 不产出 `scoreCells`、缺省正常产出、showLabel 不影响方格）+ PDF 渲染冒烟（关闭得分格后仍正常输出）。全部通过。

### 修复顺序与依赖

`#7 保存阻断` → `#5 PDF（强依赖 #7）` → `#6 作文编辑器` → `#2 填空分数栏` → `#1 右栏标签页` → `#3 批注高度` → `#4 标签换行`。

---

## [v1.9.6] — 实机问题修复前基线

（详见项目记忆与 `实机问题核实报告.md`。本版本为答题卡设计器 `2.2.1`，包含 Home 仪表盘、网上阅卷系统重构、答题卡设计器增强等既有能力；本次 `v1.9.7` 仅修复上述 7 项实机缺陷。）

---

### 版本说明

- 版本号采用 `主版本.次版本.修订号`，修订号递增代表缺陷修复。
- 重大结构变更（Schema / API 破坏性调整）将提升次版本或主版本号并单列「破坏性变更」章节。
