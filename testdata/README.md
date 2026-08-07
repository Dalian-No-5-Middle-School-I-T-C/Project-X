# Project-X 测试数据

本目录存放**与源代码分离**的演示/测试数据集，不嵌入 `src/` 或业务脚本。

## 目录

| 路径 | 说明 |
|------|------|
| [`demo-exams/`](./demo-exams/) | 完整演示考试数据包（v1.9.4+ / v1.9.5 / v1.9.6 / v2.0.0 功能测试） |

## 快速导入

```bash
# 方式一：种子脚本（推荐，直接写入当前数据库，幂等）
npm run dev   # 先启动服务初始化 schema
npx tsx testdata/demo-exams/scripts/seed.ts

# 方式二：全量 ZIP 恢复（覆盖所有功能，需重启服务补齐迁移）
./testdata/demo-exams/scripts/import-all.sh restore

# 导入后校验（自动处理管理员首次改密）
npx tsx testdata/demo-exams/scripts/verify.ts
```

默认管理员：`admin`，密码见数据库旁 `bootstrap-admin.txt`（#185 起为随机一次性密码，首次登录强制改密）  
演示学生：`20260101` ~ `20260116`，密码 = 学号（seed 显式覆盖默认随机密码，便于验证登录）  
演示教师：`demo-teacher` / `teacher123`、`demo-teacher-2` / `teacher123`

详见 [`demo-exams/README.md`](./demo-exams/README.md) 与 [`demo-exams/manifest.json`](./demo-exams/manifest.json)。