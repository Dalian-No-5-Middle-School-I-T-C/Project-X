# Project-X 测试数据

本目录存放**与源代码分离**的演示/测试数据集，不嵌入 `src/` 或业务脚本。

## 目录

| 路径 | 说明 |
|------|------|
| [`demo-exams/`](./demo-exams/) | 完整演示考试数据包（v1.4.8+ / v1.5.0 功能测试） |

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
