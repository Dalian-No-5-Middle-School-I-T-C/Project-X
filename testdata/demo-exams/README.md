# 演示考试数据包

覆盖 Project-X **v1.4.8+**（main）及 **v1.5.0**（PR #112）功能测试所需的完整数据集。

## 内容

| 文件/目录 | 说明 |
|-----------|------|
| `backup/projectx-demo.zip` | 全量数据库备份，通过 `POST /api/db/restore` 导入 |
| `import/students.csv` | 16 名演示学生（可单独 CSV 导入） |
| `import/teachers.csv` | 1 名演示教师 |
| `manifest.json` | 用例清单与预期结果 |
| `scripts/seed.ts` | 可重复运行的种子脚本 |
| `scripts/build-backup.ts` | 重新生成 ZIP 备份 |
| `scripts/verify.ts` | 导入后 API 校验 |
| `scripts/import-all.sh` | 一键导入入口 |

## 数据概览

- **年级**：高一(演示)
- **班级**：演示1班、演示2班（各 8 人）
- **学生**：`20260101` ~ `20260116`，密码 = 学号
- **教师**：`demo-teacher` / `teacher123`
- **考试**：8 场（含数学月考用于名次变化）
- **大考合集**：演示-2026高考摸底大考（6 科）
- **跨考已存组**：演示-第25周考试包（6/16~6/22）

### 特意设计的测试点

- 数学 4 人同分 128 → 并列排名
- 化学缺考周杰（20260108）、生物缺考沈婷（20260116）
- 演示-数学含 Q1~Q5 客观题小分（导出测试）
- 演示-数学月考 + 演示-数学 → 名次变化

## 导入方式

### 方式一：全量 ZIP（推荐）

```bash
npm run dev   # 先启动服务

./testdata/demo-exams/scripts/import-all.sh restore
# 恢复后重启 dev 服务

./testdata/demo-exams/scripts/import-all.sh verify
```

### 方式二：种子脚本（写入当前 DB）

```bash
./testdata/demo-exams/scripts/import-all.sh seed
```

### 方式三：重新生成备份包

```bash
./testdata/demo-exams/scripts/import-all.sh build
```

## 手动 API 导入

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:5174/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"identifier":"admin","password":"admin123"}' | jq -r .token)

curl -X POST http://127.0.0.1:5174/api/db/restore \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/zip' \
  --data-binary @testdata/demo-exams/backup/projectx-demo.zip
```

## 兼容性说明

- **大考组**使用 `exam_group_members` 表
- **跨考已存组**同时写入 `exam_group_members` 与 `exam_group_items`（兼容 main 与 PR #112）
- 所有考试名称以 `演示-` 为前缀，重复导入会先清理旧数据
