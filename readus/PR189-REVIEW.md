# PR #189 代码审查报告

> 审查对象：`0eb0961 兼容`（分支 `187与186之后的188`，作者 NaOH1g，2026-07-23）
> 与 `origin/main`（`#187`）相比 3 个提交（`0eb0961 兼容`、`270b38f 一次小修复`、`c38aeea 新一轮修复`）、14 个文件、+424/−35。B1–B4 修复后，`GradePanel` 已接入 `config.scoringMode`（见第五节遗留 #1 当前状态）。
> 审查结论：**存在 4 处需修复的问题（其中 1 处为设计冲突）**，已全部修复并通过类型检查 + 单元验证。

---

## 一、PR 意图

本 PR 在 v1.9.4「网阅逐题评分（#186 严格校验）」基础上引入**「题块总分模式」**：
教师对一个题块只填一个合计分，后端按比例拆分到各小题写入 `question_scores`。

涉及文件：
- 前端：`GradePanel.tsx`（改为只提交 `blockTotalScore`，不再逐题传 `score`/`maxScore`）
- 数据层：`migrations.ts`(v27) / `mysql.ts`(v27) / `schema.sql` / `schema.mariadb.sql`（新增 `scoring_mode`、`score_distribution` 两列）
- 配置：`block-grading-config.ts`（路由透传）、`BlockGradingConfigService.ts`（读写）
- 核心逻辑：`ReviewService.ts` 的 `submitReviewCropScores` + 新函数 `splitBlockTotal`
- 类型：`types.ts` 的 `BlockGradingConfig`

---

## 二、发现的 Bug 与冲突

### 🔴 B1 `scoreDistribution` 是死代码（功能未完成）
- **位置**：`ReviewService.ts` `splitBlockTotal` / `submitReviewCropScores`
- **问题**：新增字段 `proportional` / `equal` 在 schema、路由、Service 中都被存库、透传，但 `splitBlockTotal` **只实现了 `proportional`**，`equal`（均分）从未被调用。`submitReviewCropScores` 也没有把 `config.scoreDistribution` 传入拆分函数。结果：管理员把某题块设为「均分」后，系统仍按「比例」拆分，配置形同虚设。
- **修复**：`splitBlockTotal` 新增 `distribution` 参数，实现 `equal`（忽略满分、按题数均分）；`submitReviewCropScores` 从 `config.scoreDistribution` 解析后传入（非 `equal` 一律按 `proportional`）。

### 🔴 B2 `scoringMode` 配置不生效（设计冲突）
- **位置**：`ReviewService.ts` `submitReviewCropScores`（第 231 行判断 `params.blockTotalScore != null`）
- **问题**：后端用「前端是否提交了 `blockTotalScore`」来决定走哪种评分模式，**完全忽略 `config.scoringMode`**。而 `GradePanel.tsx` 被本 PR 改为**永远**提交 `blockTotalScore`。两个因素叠加导致：即便管理员把题块配置成「逐题评分（`per_question`）」，GradePanel 仍会按「题块总分」处理，`per_question` 配置对 GradePanel 路径彻底失效——两个模式本应互斥，却因配置不被读取而相互打架。
- **修复**：以 `config.scoringMode` 为权威来源；当配置为 `per_question` 却收到 `blockTotalScore` 时，抛出清晰错误（提示改用在线阅卷逐题输入或改配置为题块总分）。默认 `block_total` 与 OnlineReviewPanel（只发逐题、不带 `blockTotalScore`）行为不变，无回归。

### 🟠 B3 `splitBlockTotal` 合计不精确（取整溢出 + 末题粒度不一致）
- **位置**：`ReviewService.ts` `splitBlockTotal`
- **问题**：原函数末题兜底 `v = Math.min(blockTotal - allocated, max)` 只在「剩余 ≤ 末题满分」时成立；前 N−1 题按 `step` 取整后可能**取整超分**（`allocated > blockTotal`），此时末题被 clamp 到 `0`，最终合计 **< 题块总分**；且末题本身未按 `step` 取整，粒度与其他题不一致。
- **修复**：先按 `step` 取整并 clamp 到 `[0, max]`，再用余数修正（从末题向前吸收/吐出余量），保证合计在 `step` 粒度内精确等于题块总分。已用 8 组用例验证（见第四节）。

### 🟡 B4 枚举值未校验
- **位置**：`BlockGradingConfigService.ts` `upsertBlockConfig`
- **问题**：`scoringMode` / `scoreDistribution` 接受任意字符串直接入库。一旦写入非法值（如笔误），未来按值分支（如 `=== "equal"`）会静默走默认逻辑，难以排查。
- **修复**：在 `upsertBlockConfig` 入口对两字段做白名单校验，非法值立即抛错（PUT 单条与 batch 批量走同一函数，均被覆盖）。

---

## 三、修复后的文件改动

| 文件 | 改动 |
| --- | --- |
| `src/server/services/ReviewService.ts` | 重写 `splitBlockTotal`（支持 `equal`、精确合计）；`submitReviewCropScores` 解析并传入 `distribution`，新增 `scoringMode` 一致性校验 |
| `src/server/services/BlockGradingConfigService.ts` | `upsertBlockConfig` 新增 `scoringMode` / `scoreDistribution` 枚举白名单校验 |

> 注：原 PR 的 schema/migration/路由/类型/GradePanel 改动本身正确，未改动。

---

## 四、验证

- **类型检查**：`tsc --noEmit` 对两个改动文件**零错误**。仓库内其余 20 个 `error TS` 均为**既有问题**（`react-router-dom` 模块解析失败 + `App.tsx` 隐式 `any`），与本次改动无关。
- **拆分逻辑单元验证**（独立脚本，12 组用例全过）：

| 场景 | 结果 | 合计=目标 | 不超满分 | 非负 |
| --- | --- | --- | --- | --- |
| 比例 3×10 总25 step1 | [8,8,9] | ✅ | ✅ | ✅ |
| 均分 3×10 总25 step1 | [8,8,9] | ✅ | ✅ | ✅ |
| 均分 满分不对称 总12 | [4,4,4] | ✅ | ✅ | ✅ |
| 比例 clamp 2:[2,18] 总20 | [2,18] | ✅ | ✅ | ✅ |
| 比例 0.5 粒度 总29 | [9.5,9.5,10] | ✅ | ✅ | ✅ |
| 比例 总0 | [0,0,0] | ✅ | ✅ | ✅ |
| 均分 0.5 粒度 总7 | [2.5,2.5,2] | ✅ | ✅ | ✅ |
| 比例 不对称 5/15 总20 | [5,15] | ✅ | ✅ | ✅ |
| 余量吸收 3×4 总10 | [3,3,4] | ✅ | ✅ | ✅ |
| 负余量 1×1×1 总2 | [1,1,0] | ✅ | ✅ | ✅ |
| 单题 总7 | [7] | ✅ | ✅ | ✅ |
| 均分 含0分题 总6 | [0,2,4] | ✅ | ✅ | ✅ |

---

## 五、遗留 / 建议

1. ~~**前端未消费 `scoringMode`**~~ ✅ **已修复**：`GradePanel` 已通过 `loadConfig` 读取 `config.scoringMode`，当为 `per_question` 时隐藏 `ScorePad` 并提示改用在线阅卷逐题输入；B2 的后端校验在正常流也会生效。此条不再遗留。
2. **schema 与 migration 列顺序不一致**：`schema.sql`/`schema.mariadb.sql` 把新列插在 `review_mode` 之后，而 v27 迁移 `ALTER TABLE` 追加在表尾。对显式列名 INSERT 无影响，仅全新库的列顺序不同，属一致性瑕疵，可后续对齐。
3. **仓库既有类型错误**（`react-router-dom` 无法解析等）建议单独修，否则 `npm run build` 整体不通过。
4. 建议补充 `splitBlockTotal` 与「配置/提交模式不一致」的回归测试到 `scripts/`（当前 `grading-rules-smoke.ts` 未覆盖题块总分模式）。

*审查与修复由 WorkBuddy 在本地仓库完成（GitHub 直连因 SSL 不可达，PR 内容取自本地分支提交 `0eb0961`）。*
