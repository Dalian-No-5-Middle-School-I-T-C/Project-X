# Project-X 测试数据

本目录存放**与源代码分离**的演示/测试数据集，不嵌入 `src/` 或业务脚本。

## 目录

| 路径 | 说明 |
|------|------|
| [`demo-exams/`](./demo-exams/) | 完整演示考试数据包（v1.9.4+ / v1.9.5 / v1.9.6 / v2.0.0 / v2.2.9 功能测试，含作文格仿高考样式与选项竖排演示） |

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
演示学生：`20260101` ~ `20260116`，密码 = 学号（**仅本测试数据包**：`scripts/seed.ts` 会显式打开
`PROJECTX_DEMO_FIXED_CREDENTIALS=1` 恢复固定口令，好让 `scripts/verify.ts` 能按 manifest 登录断言）  
演示教师：`demo-teacher` / `teacher123`、`demo-teacher-2` / `teacher123`（同上，仅本测试数据包）

> 安全 R33：**生产环境不要用这套口令**。前端「导入演示数据」（`POST /api/db/import-demo`）默认每次随机换发
> 演示教师口令、演示学生口令走批量导入的随机初始密码，教师口令只在导入响应里出现一次并加密存入
> `users.initial_password`（管理员可从「导出账密」查回）；演示教师的可见范围也收敛为
> `teacher_role='subject_teacher'` + 两个演示班级。固定口令开关只在隔离测试库里打开。
> 另有两道闸：库中已有真实数据时需二次确认，演示卡号撞真实答题卡时整单拒绝（零改动）。
> 回归：`npm run verify:demo-credentials`。

详见 [`demo-exams/README.md`](./demo-exams/README.md) 与 [`demo-exams/manifest.json`](./demo-exams/manifest.json)。