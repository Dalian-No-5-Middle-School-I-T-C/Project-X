# 成绩天梯系统 — 本地测试指南

## 启动服务

```bash
cd "D:/paper star GitHub storage/Project-X"
npm run dev
```

前端 http://127.0.0.1:5173 | 后端 http://127.0.0.1:5174

## 测试清单

### 1. 登录
- 管理员：`admin` / 数据库同目录 `bootstrap-admin.txt` 中的一次性密码（首次登录须改密）
- 学生：任意已录入的学生账号

### 2. 前端验证（学生端）

| 步骤 | 预期结果 |
|------|----------|
| 学生登录 → 进入「我的成绩」 | 顶部出现「成绩天梯」Tab |
| 点击「成绩天梯」Tab | 显示范围选择器（单场/大考组/跨考） |
| 选择「单场考试」→ 下拉选考试 | 显示年级前十阶梯榜单（同分并列跨过截断线时整组一并显示，条数可超过 10） |
| 观察前三名 | #1 金色皇冠、#2 银色奖牌、#3 铜色奖杯；并列第 1 的每个人都戴皇冠，同分竞赛排名下可能不出现 #2/#3 |
| 观察本人 | 自己那一行整条高亮（`isCurrentUser` 驱动），与前三名徽章可叠加 |
| 观察趋势箭头 | 绿↑ / 红↓ / 灰— / 蓝 NEW |
| 观察统计栏 | 参与人数 / 你的排名 / 你的总分 |
| 切换「大考组」→ 选组 | 显示多科汇总前十 + 各科小标签 |
| 切换「跨考累计」 | 显示多场考试总分前十 |

### 3. 管理员天梯开关

| 步骤 | 预期结果 |
|------|----------|
| 管理员登录 → 成绩天梯 | 顶部红色「已开放」开关栏 |
| 点击「关闭」 | 按钮变「开启」，标签变「已关闭（仅管理员可见）」 |
| 刷新榜单 | 管理员仍可正常查看榜单 |
| 学生登录 → 成绩天梯 | 显示「成绩天梯暂未开放」 |
| 管理员重新「开启」 | 学生恢复可见 |

### 4. API 端点（curl 测试）

```bash
# 获取天梯开关状态
curl -H "Authorization: Bearer <token>" http://127.0.0.1:5174/api/ladder/config

# 管理员关闭天梯
curl -X PUT -H "Content-Type: application/json" -H "Authorization: Bearer <admin_token>" \
  -d '{"enabled":false}' http://127.0.0.1:5174/api/ladder/config

# 管理员开启天梯
curl -X PUT -H "Content-Type: application/json" -H "Authorization: Bearer <admin_token>" \
  -d '{"enabled":true}' http://127.0.0.1:5174/api/ladder/config

# 单场考试前十（替换 <examId>）
curl -H "Authorization: Bearer <token>" http://127.0.0.1:5174/api/ladder/exams/<examId>

# 大考组前十（替换 <groupId>）
curl -H "Authorization: Bearer <token>" http://127.0.0.1:5174/api/ladder/exam-groups/<groupId>

# 跨考累计前十
curl -H "Authorization: Bearer <token>" "http://127.0.0.1:5174/api/ladder/cross-exam?mode=week"
```

### 5. 空数据 / 边界情况

| 场景 | 预期 |
|------|------|
| 未选择考试/组 | 显示「请选择考试范围」 |
| 选中的考试无成绩数据 | 显示「暂无排名数据」 |
| 天梯关闭 + 学生访问 | 显示「暂未开放」 |
| 天梯关闭 + 管理员访问 | 红色警告条 + 榜单正常加载 |
| 切换范围（单场→大考组） | 旧榜单清空，新选择器出现 |
| 学生未参加所选考试 | 统计栏显示「— 未参加」 |

### 6. 同分并列（需构造并列数据）

截断规则：默认取前十，但截断线落在某个并列组中间时该组一并返回（`src/shared/ranking.ts` 的 `takeLadder`），三条天梯接口一致。

| 场景 | 预期 |
|------|------|
| 12 人并列第 1 | 返回 12 条、全部第 1 名且各戴皇冠，不出现第 2 名 |
| 恰好 10 人并列第 1 | 仍是 10 条，不扩表（并列组未跨过截断线） |
| 第 9 名并列 5 人 | 顺延到 13 条，5 个第 9 名全在；后续第 14 名起照常截断 |
| 第 10、11 名同分 | 顺延到 11 条，两人同为第 10 名 |
| 榜单超过 10 条 | 网页榜单上方出现「前十 · 同分并列全显（共 N 人）」；小程序副标题同步 |
| 本人在榜内 / 榜外 | 榜内那一条带 `isCurrentUser`；榜外时 `myRank`、`myScore` 仍是全量年排 |
