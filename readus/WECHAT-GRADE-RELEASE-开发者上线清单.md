# 成绩发布微信订阅消息 —— 开发者上线清单（部署 / 环境变量 / 启动日志 / 自检接口）

> 本文只讲**开发者与运维在服务端要做的事**，是 [`WECHAT-GRADE-RELEASE-部署与排错.md`](./WECHAT-GRADE-RELEASE-部署与排错.md) 第 2/6/7 节的展开版。
> 微信后台的模板选用、端到端业务验收、失败重推语义仍以那份文档为准；两份冲突时以本文为**操作事实**、以那份为**产品口径**。

## 0. 为什么要按这个顺序

订阅链路有两个独立环节，卡在哪一段决定你要做的事：

```
[环节 A] 小程序 wx.requestSubscribeMessage  →  学生点「允许」        （只依赖微信后台模板，不依赖你的服务器）
[环节 B] POST /api/wechat/subscriptions/grade-release  →  写绑定表   （依赖你的服务器上有这条路由 + 三个环境变量）
[环节 C] 教师公布成绩 → subscribe/send 推送                          （依赖 access_token：IP 白名单 + 小程序发布状态）
```

当前生产状态（2026-09-25 核对）：

| 事实 | 证据 |
| --- | --- |
| 路由与推送代码只存在于 v2.6.0 | `src/server/routes/wechat-subscriptions.ts` 的唯一提交是 `1bd54c6 Project-X v2.6.0 · 变更说明` |
| `origin/main` 还没有这条路由 | `origin/main` 头部为 `bf10680`，`git cat-file origin/main:src/server/routes/wechat-subscriptions.ts` → 对象不存在 |
| 小程序打的是生产域名 | `X-exam/utils/env.js` → `https://dl5zx.cn` |

所以学生端开关「开启失败」目前**必然**发生在环节 B：弹窗成功、后端 404、前端提示「绑定失败，请重试」。
**这不是发布状态问题**——一次性订阅弹窗不要求小程序有线上版本，发布状态只影响环节 C 的 `miniprogram_state=formal`。

下面四步按顺序做，每步都有「怎么算通过」的判据。

---

## 1. 步骤①：把含订阅路由的版本部署到 `dl5zx.cn`

### 1.1 部署前先确认工作区

```bash
git status --porcelain
git log --oneline -1
```

分支 `2.6.0-小程序联动与原卷答案更新` 的工作区当前还有**未提交**的天梯并列修复（`src/shared/ranking.ts`、`src/server/services/LadderService.ts`、`src/server/routes/ladder.ts` 等 11 个文件）。
未提交的内容不会随任何构建上线——如果这次部署的目标是「顺带修好天梯 16 人并列只显示 10 人」，先把这批改动提交并发版。
合并与 PR 按惯例由维护者手动执行，本文不代为操作。

### 1.2 构建

```bash
npm run typecheck              # 必过；订阅相关类型在 WechatMiniProgramService.ts
npm run build:web:full         # dist/web/ + dist/server/
# 或走 Ubuntu 包（该脚本不含类型检查，必须先单独验证）
npm run package:server:ubuntu24
```

### 1.3 上线后 30 秒判据：探活必须是 POST

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://dl5zx.cn/api/wechat/subscriptions/grade-release \
  -H 'Content-Type: application/json' -d '{}'
```

| 返回 | 含义 | 下一步 |
| --- | --- | --- |
| `404` | 路由没上线（构建或部署没到位） | 回到 1.2 核对产物与 `ExecStart` 指向 |
| `401` | 路由已上线且 `authMiddleware` 生效 | ✅ 进入步骤② |
| `405` / `500` | 路由在但中间件异常 | 查 `journalctl` 启动栈 |

⚠️ **不要用 GET 探未知 `/api` 路径**：`src/apps/answer-card/server/index.ts` 末尾有 SPA 兜底 `app.get("/{*splat}")`，任何未注册的 GET 都会返回 **200 + index.html**，看不出路由存不存在。判定路由是否上线只能用 POST（或带管理员 token 调 `GET /api/wechat/subscriptions/diagnostic`，未上线时会拿到 HTML 而非 JSON——这本身也是个信号）。

### 1.4 小程序侧配套项（通常已满足）

小程序后台 → 开发 → 开发设置 → 服务器域名 → `request` 合法域名需含 `https://dl5zx.cn`。
判据很简单的：真机能正常查分就说明这条已经对了，不用动。

---

## 2. 步骤②：服务端环境变量

### 2.1 需要哪些

| 变量 | 必填 | 取值来源 | 一致性要求 |
| --- | --- | --- | --- |
| `WECHAT_MINIPROGRAM_APP_ID` | 是 | 小程序后台 → 开发管理 → 开发设置 | 必须是**这个**小程序的 AppID |
| `WECHAT_MINIPROGRAM_APP_SECRET` | 是 | 同上（生成/查看） | **只存在于服务端环境变量**；曾在聊天中明文出现，验收后请立即轮换 |
| `WECHAT_GRADE_RELEASE_TEMPLATE_ID` | 是 | 后台 → 功能 → 订阅消息 → 我的模板 | 必须与小程序端 `X-exam/utils/subscribe.js` 的 `TEMPLATE_ID` **逐字相同** |
| `WECHAT_SUBSCRIBE_PAGE` | 否 | 默认 `pages/scores/scores` | 该页面必须存在于**线上版本**，否则点击消息会失败 |
| `WECHAT_MINIPROGRAM_STATE` | 否 | 默认 `formal`；灰度期用 `trial` | 见 2.4 |

缺任意一项 → 整条链路自动关闭（不建绑定、不推送），路由直接返回 `503 服务端未配置成绩发布订阅模板`，学生端同样显示「绑定失败，请重试」。这是刻意设计的安全降级。

模板 ID 一致性核对（两处必须一样）：

```bash
grep TEMPLATE_ID ../path/to/X-exam/utils/subscribe.js
# 与服务端（只比长度与前缀，别把后台值贴进公共终端）
systemctl show -p Environment project-x-server | tr ' ' '\n' \
  | sed -n 's/^\(WECHAT_GRADE_RELEASE_TEMPLATE_ID=\).\{6\}.*/\1<prefix-ok>/p'
```

### 2.2 先确认你们机器的 unit 名

仓库里生成的是 `project-x-server.service`（`scripts/package-server-ubuntu.cjs`），而历史上人工排障时出现过 `project-x.service.d/`。**以机器上实际存在的为准**：

```bash
systemctl list-units --type=service | grep -i project
```

下面示例统一写作 `project-x-server`，按实际名字替换。Windows/NSSM 部署（见 `SERVER-README.md`）在项目服务的环境里加同样三个变量，其余步骤一致。

### 2.3 推荐写法：EnvironmentFile + 权限收紧

密钥不要直接写进 `systemctl edit` 的 drop-in（那会明文躺在 `/etc/systemd/system/…/override.conf`），更不要写进仓库、`.env.example` 或 `/opt/project-x-server`（升级包会被覆盖）。

```bash
sudo mkdir -p /etc/project-x
sudo install -m 600 -o root -g root /dev/null /etc/project-x/wechat.env
sudoedit /etc/project-x/wechat.env          # 用编辑器写入，避免密钥进 shell history
```

文件内容（systemd 的 env 格式：**不能加 `export`**，值含空格要整体加引号，`#` 后是注释）：

```
WECHAT_MINIPROGRAM_APP_ID=wx...
WECHAT_MINIPROGRAM_APP_SECRET=...
WECHAT_GRADE_RELEASE_TEMPLATE_ID=...
WECHAT_MINIPROGRAM_STATE=trial
```

再挂到服务上：

```bash
sudo systemctl edit project-x-server        # 写入下面两行
```

```ini
[Service]
EnvironmentFile=/etc/project-x/wechat.env
```

```bash
sudo systemctl daemon-reload
sudo systemctl restart project-x-server
```

### 2.4 灰度期的 `WECHAT_MINIPROGRAM_STATE`

| 取值 | 前提 | 用在哪 |
| --- | --- | --- |
| `trial` | 接收者是**体验成员** | **本次上线推荐**：小程序还没发布也能端到端验收 |
| `developer` | 接收者是**开发者** | 单人自测 |
| `formal` | 小程序**已有线上版本** | 正式发布后改回来 |

建议顺序：`trial` 给自己 + 一名测试学生推通 → 发布小程序 → 改成 `formal` 并重启 → 再推一场验收。**别忘了改回来**，留在 `trial` 会让正式用户静默收不到。

### 2.5 验证变量已生效（且不泄露值）

```bash
systemctl show -p EnvironmentFiles project-x-server
systemctl show -p Environment project-x-server | tr ' ' '\n' | sed 's/=.*/=<hidden>/' | grep -c WECHAT
```

第二条只列变量名。`systemctl show -p Environment` 的原始输出**包含 AppSecret 明文**，不要粘贴到聊天、issue 或日志里。

---

## 3. 步骤③：启动日志与数据库迁移

### 3.1 三条启动日志，只有最后一条是好的

```bash
journalctl -u project-x-server -n 100 --no-pager | grep -i wechat
```

| 日志 | 含义 | 处理 |
| --- | --- | --- |
| `[wechat] 未配置订阅消息环境变量，成绩发布推送关闭` | 三个必填全缺 | 回到 2.3 |
| `[wechat] 订阅消息配置不完整…缺少: <变量名>` | 配了一半 | 日志列出的就是要补的变量名 |
| `[wechat] 成绩发布订阅推送已启用 (miniprogram_state=…, page=…)` | ✅ 通过 | 进入步骤④ |

实现见 `src/server/services/WechatMiniProgramService.ts`（`logWechatSubscriptionStatus`），调用点在 `startServer()` 的 `listening` 回调里（`src/apps/answer-card/server/index.ts`），所以它排在 `Answer card designer API running at …` **之后**；重启后如果只看到端口行没看到 wechat 行，说明进程还在跑旧代码或启动失败在循环重启（`journalctl -u project-x-server --since -10min | grep -i 'start request repeated'`）。

日志只打印变量名和状态，绝不打印值——这条约束别破。

### 3.2 v52 迁移

启动时自动执行，SQLite 与 MariaDB 双方言均已覆盖（`src/server/db/migrations.ts` 中 `version: 52, name: "wechat-grade-release-notifications"`），建两张表：

- `wechat_subscription_bindings` —— 学生 ↔ openid ↔ 模板
- `wechat_grade_release_notifications` —— 每场考试的推送认领与计数

生产库此前没跑过 v52 → 直接按新 DDL 建表，无需人工干预。
**只有按第一版 v52 建过表的开发库**要手工修（旧 DDL 把 openid 建成了唯一索引，共用设备/一个家长多孩会互相顶掉），SQL 见 `WECHAT-GRADE-RELEASE-部署与排错.md` 第 6 节。

结构自检（MariaDB）：

```sql
SHOW INDEX FROM wechat_subscription_bindings;
```

期望：唯一键落在 `(student_id, template_id)`，`idx_wsb_openid` 是**普通**索引。
看到 `uk_wsb_openid_template` 就是旧 DDL，必须改。

---

## 4. 步骤④：管理员诊断接口自检

`GET /api/wechat/subscriptions/diagnostic`（仅管理员）会**绕过 token 缓存实取一次 access_token**，并把配置、环境变量缺失项、绑定人数一起返回。响应只含布尔值、错误码与聚合计数，**不回显任何密钥或 openid**。

### 4.0 首选：网页端「微信订阅消息」卡片（零命令行）

管理员登录 Web 端 → 全局设置 → **微信订阅消息** → 「开始自检」。面板直接给出四行：环境变量（已就绪 / 缺少哪几项，只列变量名）、access_token（可取 / 失败 + 错误码解释）、推送环境（`miniprogram_state · page`）、已绑定学生人数。

- 面板**不会自动拉取**，必须点「开始自检」。原因见上面的「绕过 token 缓存」——`cgi-bin/token` 有日调用上限，每次打开设置页都烧一次额度不合理。
- 自检报出 HTML 而非 JSON 时，面板会提示「多半是这一版后端还没部署到本服务器」，即 SPA 兜底把未注册的 GET 请求接住了，回到 1.2。
- 需要脚本化、或浏览器进不去服务器时才用下面的 curl 路径。

### 4.1 取一个管理员 Bearer

```bash
read -s -p 'admin password: ' PX_PWD; echo
TOKEN=$(curl -s -X POST https://dl5zx.cn/api/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"identifier\":\"admin\",\"password\":\"$PX_PWD\"}" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')
```

- 登录接口在无 `Origin` 头时才会回传 `token`（同源浏览器只发 HttpOnly Cookie），curl 正好走这条分支。
- `read -s` 让密码不进 history，但它仍会出现在 curl 的进程参数里：多人共用的跳板机上，改用浏览器已登录会话，或事后 `history -c`。
- 反复调用会撞 `loginIpLimiter` / `loginAccountLimiter` → 429，自检一两次足够。

### 4.2 调用并读结果

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  https://dl5zx.cn/api/wechat/subscriptions/diagnostic
```

| 字段 | 期望 | 不对时 |
| --- | --- | --- |
| `configured` | `true` | `false` 时看 `missing`，回 2.3 |
| `page` | `pages/scores/scores` | 与小程序线上版本页面路径不一致会导致点击消息打不开 |
| `miniprogramState` | 灰度期 `trial`，正式 `formal` | 见 2.4 |
| `accessToken.ok` | `true` | 见下表 |
| `accessToken.errcode` | `null` | 见下表 |
| `boundStudents` | **> 0** | 为 0 说明环节 B 还没通：学生端开关仍会失败 |

| errcode | 含义 | 处理 |
| --- | --- | --- |
| `40013` | AppID 不合法 | 核对 `WECHAT_MINIPROGRAM_APP_ID` |
| `40001` | AppSecret 错误 / token 已失效 | 更新变量并重启；轮换 Secret 后必须同步 |
| `42001` | access_token 超时 | 代码已自动清缓存重取，偶发可忽略 |
| `40164` | **服务器出口 IP 不在白名单** | 后台 → 开发设置 → IP 白名单，加服务端**公网出口 IP**；容器部署要填容器实际出口 IP |
| `-1` / `null` | 系统繁忙 / 出网失败 | `curl 'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential'` 只判链路 |

一个容易搞反的点：**IP 白名单只影响 `cgi-bin/token` 这类接口，也就是环节 C（推送）**。环节 B 用的 `jscode2session` 不校验白名单，所以「学生开开关」在白名单没配好之前也应该能成功——如果开关仍失败，别去查白名单，查 `boundStudents` 和路由是否上线。

### 4.3 让 `boundStudents` 变成非零

用体验版小程序：我的 → 成绩发布提醒 → 打开开关 → 弹窗点「允许」。
成功标志是 toast「已开启成绩提醒」；显示「绑定失败，请重试」说明环节 B 仍在失败，回到 1.3 / 4.2。
开关本身走的是 `<switch bindchange>`（用户手势内同步调用，符合要求）；查分后的引导只弹一个「去『我的』开启」的 toast，不会在手势外调用订阅接口，这两处逻辑不需要改。

---

## 5. 回归脚本（不消耗微信额度）

```bash
npm run verify:wechat-grade-release   # 临时 SQLite + 打桩 fetch，不打真实微信接口
npm run verify:mariadb                # 需一次性空 projectx_ci 库，含 v52 索引断言
npm run typecheck
```

端到端业务验收（一场真实考试、体验版、`trial` 状态）见 `WECHAT-GRADE-RELEASE-部署与排错.md` 第 8 节。

排障用 SQL 与日志关键字：

```sql
SELECT student_id, template_id, accepted_at FROM wechat_subscription_bindings ORDER BY accepted_at DESC LIMIT 20;
SELECT exam_id, status, success_count, failure_count FROM wechat_grade_release_notifications ORDER BY exam_id DESC;
```

```bash
journalctl -u project-x-server --since -1h --no-pager | grep -i 'wechat grade release'
# 关注 send failed（带 errcode 与 studentId）与 slot released for retry（该场零送达、已释放去重位）
```

「失败不占用去重」意味着：某场全员没送达时，管理员修好配置后把成绩**撤回 → 重新公布**即可重推，不需要清表。

---

## 6. 完成判据

- [ ] `POST /api/wechat/subscriptions/grade-release` 返回 **401**（不是 404）
- [ ] 启动日志出现 `[wechat] 成绩发布订阅推送已启用`
- [ ] `SHOW INDEX` 里 openid 不是唯一索引，唯一键是 `(student_id, template_id)`
- [ ] 全局设置「微信订阅消息」自检面板四项齐全，`access_token` 一行显示「可取」（等价：`diagnostic` 的 `accessToken.ok: true`）
- [ ] 测试学生打开开关看到「已开启成绩提醒」，且 `boundStudents ≥ 1`
- [ ] `trial` 下公布一场成绩，测试学生微信收到「考试成绩通知」，点进去落在成绩页
- [ ] 撤回 → 重新公布，**不**重复收到
- [ ] 小程序已发布、`WECHAT_MINIPROGRAM_STATE` 改回 `formal` 并重启
- [ ] AppSecret 已在小程序后台轮换，新值同步进服务端环境变量

## 7. 不要做的事

- 不要把 AppSecret 写进仓库、`.env`、CI 变量明文、日志、issue 或聊天记录。
- 不要把 `WECHAT_MINIPROGRAM_STATE` 留在 `trial` 当成正式环境。
- 不要为了反复测试而多次撤回/公布：一次性订阅额度会耗尽，学生该场就收不到（`43101` 属正常业务）。
- 不要改服务端模板字段名而不同步小程序端常量（反之亦然）——字段不匹配是 `47003`，模板 ID 不一致会让绑定和推送分属两套数据。
- 不要在生产库手工插入 openid 做测试。
