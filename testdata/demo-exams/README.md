# 演示考试数据包

覆盖 Project-X **v1.9.4 ~ v1.9.9 / v2.0.0** 功能测试所需的完整数据集（含文理分科 #212、填空题升级 #211、网阅打分记录/双评仲裁/断点续批 #173/#177）。

## 内容

| 文件/目录 | 说明 |
|-----------|------|
| `backup/projectx-demo.zip` | 全量数据库备份，通过 `POST /api/db/restore` 导入 |
| `import/students.csv` | 16 名演示学生（可单独 CSV 导入） |
| `import/teachers.csv` | 1 名演示教师 |
| `manifest.json` | 用例清单与预期结果（含账号、场景） |
| `scripts/seed.ts` | 可重复运行的种子脚本（CLI 薄包装，核心逻辑在 `src/server/services/DemoDataService.ts`） |
| `scripts/seed-review.ts` | 网阅演示种子（已并入 DemoDataService，本文件仅保留兼容占位） |
| `scripts/build-backup.ts` | 重新生成 ZIP 备份 |
| `scripts/verify.ts` | 导入后 API 校验（含自动改密） |
| `scripts/import-all.sh` | 一键导入入口 |

## 数据概览

- **年级**：高一(演示)
- **班级**：演示1班（理科班）、演示2班（文科班），各 8 人
- **学生**：`20260101` ~ `20260116`，密码 = 学号（seed 显式覆盖默认随机密码）；`01~08` 理科、`09~16` 文科（`users.track`）
- **教师**：`demo-teacher` / `teacher123`、`demo-teacher-2` / `teacher123`
- **考试**：8 场周考/月考 + 1 场网阅测试（共 9 场）
- **大考合集**：演示-2026高考摸底大考（7 科：语数英=共同、物化生=理科、历史=文科）
- **跨考已存组**：演示-第25周考试包（6/16~6/22，6 科全共同）
- **填空题演示**：演示-语文卡（88000001）含 fill_blank 块 3 道题（逐空自定义横线 / 文字注释 / 插入图片）

### 特意设计的测试点

- 数学 4 人同分 128 → 并列排名
- 化学缺考周杰（20260108）、生物缺考沈婷（20260116）——常规缺考测试点，与文理分科无关（文理分科仅作用于大考合集统计）
- 演示-数学含 Q1~Q5 客观题小分（导出测试）
- 演示-数学月考 + 演示-数学 → 名次变化
- **文理分科**：大考合集 7 科成员 track_type（common/arts/science），物化生仅统计理科 8 人、历史仅统计文科 8 人
- **填空题升级**：88000001 卡 fill_blank 块 — Q1 两空宽度/高度不同 + 右侧批注 + 注释；Q2 插入居中图片（`/api/assets/88000001/fig-demo.png`）；Q3 普通横线
- **网阅打分**（演示-网阅测试）：
  - 题块 A（满分15·含0.5·双评2P·block_total+proportional）：3 份双评一致已批、1 份争议（9 vs 13，差 4 > 阈值 2）、4 份待二评
  - 题块 B（满分25·单评1P·per_question+equal）：3 份已批、5 份待批
  - 已批卷含 `final_score` + `score_breakdown`（两轮明细），逐题主观分已落 `question_scores`，`student_scores` 张明 30 / 李华 34 / 王芳 29
  - 断点续批：demo-teacher 题块 B 草稿会话（`review_sessions.draft_scores`）
  - 批注：题块 B 已批卷 1 条文字批注
- 全局设置：require_original_paper / highlight_missing_paper

## 导入方式

### 方式零：前端一键导入（推荐，无需命令行）

管理员登录后，点击右上角**账户菜单 → 导入演示数据**（调用 `POST /api/db/import-demo`，无需重启）。注意：重复导入会**重置全部「演示-」前缀数据并更换考试 ID**，在演示数据上完成的阅卷/改分会被清空，非演示数据不受影响。
配套的**清除演示数据**按钮（`POST /api/db/clear-demo`）可一键清理全部「演示-」前缀数据。仅 SQLite 部署可用。

### 方式一：种子脚本（命令行，直接写入当前 DB）

```bash
npm run dev   # 先启动服务以初始化 schema
npx tsx testdata/demo-exams/scripts/seed.ts
```

### 方式二：全量 ZIP 恢复

```bash
npm run dev
./testdata/demo-exams/scripts/import-all.sh restore
# 恢复后必须重启 dev 服务以补齐缺失迁移（项目自动迁移幂等）
```

### 方式三：重新生成备份包

```bash
./testdata/demo-exams/scripts/import-all.sh build
```

v1.9.9 起备份包同时包含资源文件（`data/answer-card/`：填空题图片与网阅切块占位图），ZIP 恢复后图片资源完整可用。

## 校验

```bash
npx tsx testdata/demo-exams/scripts/verify.ts
```

verify.ts 会自动处理管理员首次强制改密：读 `bootstrap-admin.txt` 一次性密码 → 若返回 428 PASSWORD_CHANGE_REQUIRED → 自动改密为 `Admin@Demo2026` 并回写文件。

## 手动 API 导入

```bash
# #185 起管理员为随机一次性密码，读取数据库旁的 bootstrap-admin.txt
ADMIN_PW="$(tr -d '[:space:]' < data/bootstrap-admin.txt 2>/dev/null || echo admin123)"
TOKEN=$(curl -s -X POST http://127.0.0.1:5174/api/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"identifier\":\"admin\",\"password\":\"$ADMIN_PW\"}" | jq -r .token)

curl -X POST http://127.0.0.1:5174/api/db/restore \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/zip' \
  --data-binary @testdata/demo-exams/backup/projectx-demo.zip
```

## 兼容性说明

- 数据库迁移版本：v1~v31（v17 跳过），所有迁移幂等（`addColumnIfMissing` / `CREATE TABLE IF NOT EXISTS`）
- **大考组**使用 `exam_group_members` 表（v31 起含 `track_type` 文理分科字段）
- **跨考已存组**同时写入 `exam_group_members` 与 `exam_group_items`（兼容 main 与 PR #112）
- 所有考试/组/答题卡名称以 `演示-` 为前缀，重复导入会先清理旧数据（idempotent）
- 清理演示数据时 `review_sessions` 一并按考试 id 清除（v1.9.9 起）
- ZIP 恢复后必须重启 dev 服务，`initializeDatabase()` 会自动执行缺失迁移（v25~v31 等）
