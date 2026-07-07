# Project-X 测试数据

本目录存放**与源代码分离**的演示/测试数据集，不嵌入 `src/` 或业务脚本。

## 目录

| 路径 | 说明 |
|------|------|
| [`demo-exams/`](./demo-exams/) | 完整演示考试数据包（v1.6.3+ / v1.7.0 功能测试） |

## 快速导入

```bash
# 方式一：全量 ZIP 恢复（推荐，覆盖所有功能）
./testdata/demo-exams/scripts/import-all.sh restore

# 方式二：仅写入演示考试到当前数据库
./testdata/demo-exams/scripts/import-all.sh seed

# 导入后校验
npx tsx testdata/demo-exams/scripts/verify.ts
```

默认管理员：`admin` / `admin123`  
演示学生：`20260101` ~ `20260116`，密码 = 学号

## 纯静态离线演示（无需数据库）

主站登录页输入 **`offline-demo` / `offline-demo`** 将跳转到 `/demo/` 纯静态演示页。

- 数据来自 [`demo-exams/demo-dataset.ts`](./demo-exams/demo-dataset.ts)，构建时生成 `public/demo/demo-data.json`
- 覆盖 manifest 中全部测试场景（并列排名、缺考、大考、跨考、名次变化、客观题小分、百分位公式 A 等）
- 与主应用完全隔离，不调用 `/api`，不影响其它功能

重新生成 JSON：`npm run build:demo-static`
