# 成绩天梯系统 — 本地测试指南

## 启动服务

```bash
cd "D:/paper star GitHub storage/Project-X"
npm run dev
```

前端 http://127.0.0.1:5173 | 后端 http://127.0.0.1:5174

## 测试清单

### 1. 登录
- 管理员：`admin` / `admin123`
- 学生：任意已录入的学生账号

### 2. 前端验证（学生端）

| 步骤 | 预期结果 |
|------|----------|
| 学生登录 → 进入「我的成绩」 | 顶部出现「成绩天梯」Tab |
| 点击「成绩天梯」Tab | 显示范围选择器（单场/大考组/跨考） |
| 选择「单场考试」→ 下拉选考试 | 显示年级前十名阶梯榜单 |
| 观察前三名 | #1 金色皇冠、#2 银色奖牌、#3 铜色奖杯 |
| 观察趋势箭头 | 绿↑ / 红↓ / 灰— / 蓝 NEW |
| 观察统计栏 | 参与人数 / 你的排名 / 你的总分 |
| 切换「大考组」→ 选组 | 显示多科汇总前十名 + 各科小标签 |
| 切换「跨考累计」 | 显示多场考试总分前十名 |

### 3. 管理员天梯开关

| 步骤 | 预期结果 |
|------|----------|
| 管理员登录 → 成绩天梯 | 顶部红色「已开放」开关栏 |
| 点击「关闭」 | 按钮变「开启」，标签变「已关闭（仅管理员可见）」 |
| 刷新榜单 | 管理员仍可正常查看前十 |
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
