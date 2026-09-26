# 成绩发布微信订阅消息 —— 部署与排错清单

> 适用范围：Project-X Linux 服务端（MariaDB）+ 微信小程序「成绩发布通知」订阅消息。
> 代码侧已完成，**部署侧配置尚未执行**。本文按上线顺序给出检查项与踩坑对策。
> 服务端操作的具体命令（部署探活、systemd 环境变量写法、启动日志与迁移核对、诊断接口读法）见
> [WECHAT-GRADE-RELEASE-开发者上线清单.md](./WECHAT-GRADE-RELEASE-开发者上线清单.md)。

## 1. 链路

```
小程序 wx.requestSubscribeMessage（学生点允许）
  → wx.login 取 code
  → POST /api/wechat/subscriptions/grade-release { code, templateId }   // Bearer Token，学生身份取自 token
  → 服务端 jscode2session 换 openid → 写 wechat_subscription_bindings
教师端「公布成绩」事务提交后
  → notifyGradeReleaseSubscribers(examId) 异步执行
  → 认领去重位 → 查有成绩且已绑定的学生 → 逐条 subscribe/send
```

每场考试只推一次；推送失败绝不回滚成绩发布，只记日志与计数。

## 2. 环境变量（只写进部署环境，不入库、不入 Git、不打日志）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `WECHAT_MINIPROGRAM_APP_ID` | 是 | 小程序 AppID |
| `WECHAT_MINIPROGRAM_APP_SECRET` | 是 | **仅存在于服务端环境变量**；曾在聊天中明文出现，功能验收后请在小程序后台轮换 |
| `WECHAT_GRADE_RELEASE_TEMPLATE_ID` | 是 | 后台「考试成绩通知」模板 ID，必须与小程序端 `utils/subscribe.js` 中的常量完全一致 |
| `WECHAT_SUBSCRIBE_PAGE` | 否 | 默认 `pages/scores/scores`；小程序页面路径变更后要同步 |
| `WECHAT_MINIPROGRAM_STATE` | 否 | 默认 `formal`；灰度期见第 4 条 |

三项必填中缺任意一项 → 功能整体关闭（不建绑定、不推送），启动日志会打印缺失项名称。

systemd 部署示例（写入 override，不要写进仓库）：

```
systemctl edit project-x     # 追加 Environment=WECHAT_MINIPROGRAM_APP_ID=...
systemctl restart project-x
```

## 3. 出网与 IP 白名单（最常见的「本地能跑、服务器不推」）

1. **小程序后台 → 开发 → 开发设置 → IP 白名单**：必须加上服务端**公网出口 IP**。
   未加白名单时 `cgi-bin/token` 直接返回 `errcode 40164`，表现为全场零送达。
2. 服务端要能访问 `https://api.weixin.qq.com:443`。检查（只判链路，不看业务码）：
   ```
   curl -s -o /dev/null -w '%{http_code}\n' 'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential'
   ```
   返回 `200` 即出网正常（正文会是错误码）；连不上则是防火墙 / IPv6 / 代理问题。
3. 容器化部署注意：容器出口 IP 与宿主机不同，白名单要按容器实际出口 IP 填。
4. 服务器时钟不影响本功能（token 有效期由微信侧返回，进程内按秒数缓存）。

## 4. `miniprogram_state` 与发布状态

| 取值 | 前提 | 用途 |
| --- | --- | --- |
| `formal` | 小程序**已有线上版本** | 正式环境 |
| `trial` | 接收者是**体验成员** | 灰度 / 验收阶段推荐 |
| `developer` | 接收者是**开发者** | 开发自测 |

小程序尚未发布就设 `formal`，学生端订阅弹窗可以正常，但服务端发送会失败。
建议上线顺序：先 `trial` 给自己和一位测试学生推送验收 → 小程序发布 → 改回 `formal` 并重启服务。

## 5. 模板字段

`subscribe/send` 的 `data` 键名必须与后台模板字段一一对应，否则 `errcode 47003`（参数不匹配）：

- `thing1` = 课程名称（代码内为「科目 · 考试名」，超 20 字截断为 19 字 + `…`）
- `number2` = 学生成绩（一位小数，赋分优先）

后台改模板（换字段名、换模板 ID）后，必须同步：服务端 `WECHAT_GRADE_RELEASE_TEMPLATE_ID`、
小程序 `utils/subscribe.js` 的模板 ID 常量，并清空 `wechat_subscription_bindings` 中旧模板的绑定。

## 6. 数据库迁移（v52）

代码启动时自动执行；SQLite 与 MariaDB 双方言均已提供 `schema` + 增量迁移。

- 全新库：`schema.sql` / `schema.mariadb.sql` 直接建表。
- 已有库：`52 / wechat-grade-release-notifications` 建 `wechat_subscription_bindings` 与 `wechat_grade_release_notifications`。

**已按第一版 v52 建过表的开发库需要手工修一次**（旧版把 `openid` 建成了唯一索引，会让共用设备 / 一个家长绑多个孩子互相顶掉）：

```sql
-- MariaDB
ALTER TABLE wechat_subscription_bindings
  DROP INDEX uk_wsb_openid_template,
  ADD INDEX idx_wsb_openid (openid);
```

```sql
-- SQLite（表内 UNIQUE 无法 ALTER；本地开发库可直接重建）
DROP TABLE IF EXISTS wechat_subscription_bindings;
DROP TABLE IF EXISTS wechat_grade_release_notifications;
DELETE FROM schema_migrations WHERE version = 52;
-- 重启服务，迁移会按新 DDL 重建
```

生产库尚未跑过 v52，按新 DDL 直接建表，无需处理。

## 7. 上线自检

1. 启动日志出现 `[wechat] 成绩发布订阅推送已启用 (miniprogram_state=..., page=...)`。
   出现「配置不完整」告警时，日志里列出的就是缺失的变量名。
2. 管理员调诊断接口（**绕过 token 缓存实取一次**，只返回布尔与错误码，不回显任何密钥）：
   ```
   curl -s -H "Authorization: Bearer <管理员 token>" https://<host>/api/wechat/subscriptions/diagnostic
   ```
   | 返回 | 含义 | 处理 |
   | --- | --- | --- |
   | `configured: false, missing: [...]` | 环境变量缺失 | 补第 2 节 |
   | `accessToken.ok: true` | AppID/Secret/IP/出网全通 | 继续第 8 节 |
   | `accessToken.errcode: 40013` | 不合法的 AppID | 核对 `WECHAT_MINIPROGRAM_APP_ID` |
   | `accessToken.errcode: 40001` | AppSecret 错误，或 access_token 已失效 | 更新环境变量并重启（轮换后必须同步） |
   | `accessToken.errcode: 42001` | access_token 超时 | 代码已自动清缓存重取，偶发可忽略 |
   | `accessToken.errcode: 40164` | 服务器出口 IP 不在白名单 | 见第 3 节 |
   | `accessToken.errcode: -1` 或 `null` | 系统繁忙 / 网络出网失败 | 重试；查防火墙与 DNS |
   | `boundStudents: 0` | 还没有学生绑定 | 让学生按新版小程序重新订阅 |

   其余错误码以微信官方[返回码说明](https://developers.weixin.qq.com/doc/oplatform/Return_codes/Return_code_descriptions_new.html)为准，诊断接口只回显错误码，不回显 errmsg 原文与任何密钥。
3. 回归脚本（不打真实微信接口）：`npm run verify:wechat-grade-release`（临时 SQLite + 打桩 fetch）。
   MariaDB 侧结构校验：`npm run verify:mariadb`（需一次性空的 `projectx_ci` 库，含 v52 索引断言）。

## 8. 端到端验收（一场真实考试）

1. 测试学生用体验版/线上版小程序：我的 → 成绩通知 → 允许订阅；界面应显示订阅成功（失败会提示「绑定失败，请重试」）。
2. 教师端公布该场成绩。
3. 学生微信收到「考试成绩通知」服务消息，点进去落到 `pages/scores/scores`。
4. 服务端核对：
   ```sql
   SELECT * FROM wechat_grade_release_notifications WHERE exam_id = <该场>;
   -- status: completed / completed_with_errors；success_count / failure_count
   ```
5. 撤回→重新公布：不应重复收到消息（去重位已保留）。

## 9. 失败不占用去重位（重推语义）

| 场景 | 结果 |
| --- | --- |
| 该场无人送达（token 失败、全员 43101、网络故障、配置错误） | **删除认领行**，日志 `slot released for retry`；修好配置后「撤回 → 公布」即可重推 |
| 该场无任何绑定收件人 / 考试非公布态 | 同上，不占用 |
| 至少 1 条送达 | 保留认领行并记 `completed_with_errors`，其余失败学生不自动重推（避免已收到者被重复打扰） |
| 进程崩溃留下的 `sending` 行 | 超过 10 分钟视为僵尸，下次发布会自动重新认领 |
| 学生本人拒绝订阅 / 额度用完（`43101`） | 属正常业务，不需运维处理；下一场发布前前端会重新引导订阅 |

排障用日志关键字：`wechat grade release`（`send failed` 带 `errcode` 与 `studentId`，`slot released for retry` 带 `reason`）。

## 10. 已知边界

- **一次性订阅**：微信侧不提供长期订阅，学生每次「允许」只够发一条，因此每场发布前需重新引导；未重新订阅的学生该场收不到（`43101`），这是产品既定取舍。
- 同一 openid 绑定多个学生时，一次授权只够发一条：该设备上排在后面的学生该场可能收不到，需其本人重新订阅。
- 订阅消息内容仅含课程名与分数，不传姓名/学号；openid 不出服务端。
- `src/server/db/schema.mysql.sql`（早期 MySQL 草稿，不参与运行时初始化，且缺少 v47 之后的多张表）未同步 v52。
