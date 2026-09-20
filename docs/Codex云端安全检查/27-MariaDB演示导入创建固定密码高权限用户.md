# 27 MariaDB演示导入创建固定密码高权限用户

- 原标题：MariaDB demo import creates fixed-password privileged users
- 云端级别：Medium
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/21326d21a1488191bcd906f1c163d604?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=&page=2)
- 关联提交：[274b282](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/274b2823616075d9f5a70037e6ac429e2c47570e)

## 概要

此前 POST /api/db/import-demo 明确拒绝 MariaDB，本提交移除该保护并直接 seedDemoData，使集中部署也能创建 demo-teacher、demo-teacher-2，固定密码 teacher123。插入未指定 teacher_role、password_change_required、is_active，MariaDB 默认值使其成为活跃、无需改密的普通教师。默认教师有卡片、考试、阅卷六项读写权限，teacher_role=null 兼容逻辑返回无限制考试范围。

管理员导入后，知道公开密码的匿名网络用户可登录并读写非演示教育记录。导入自身正确限管理员，但创建后返回的“不要生产使用”警告不能保护已生效账号。SQLite 早有同类行为，本提交新增 MariaDB 可达性。建议显式非生产模式、随机一次性强制改密或严格演示角色。

## 验证及证据

确认移除方言拒绝、getMysqlDb、MariaDB INSERT IGNORE 和 schema 默认值。真实 Express 登录／列举／PATCH 链以 SQLite 执行：登录 200、passwordChangeRequired=false、六项读写权限，读取并修改无关非演示草稿正式考试。没有 MariaDB 服务或容器，精确 MariaDB seed 全链仅静态确认，不写成动态通过。

## 攻击路径与分级

管理员先导入 → 已知密码活跃演示教师 → 匿名攻击者 POST /api/auth/login → 不强制改密 → 普通教师通用权限＋null 无范围 → 非演示考试读写。

技术影响高：身份跃迁及广泛记录权限，不限演示数据。原“发生可能性”字段先标 High，解释再因管理员主动开发模式导入、MariaDB 部署、账号保留、网络可达及用户名不冲突而调整为中；最终高影响×中可能性为中危。管理员是创建脆弱状态的使用者而非攻击者，所以不是管理员专属漏洞排除。

## 假设、控制与盲点

管理员用 MariaDB 导入；账号仍活跃未清除；用户名未被现有不同凭据行占用；默认认证开启、入口可达。INSERT IGNORE 遇冲突可能保留不同密码，影响利用。

导入需 USER_MANAGE＋SYSTEM_MANAGE，UI 仅管理员开发子菜单并确认；bcrypt／活跃检查；15 分钟 IP 60 次、账号 10 次登录限制；角色门禁、强制改密中间件存在但新账号标志为 0；is_demo 可被管理员 clear-demo 删除；回环监听可经代理公开。警告在创建后才显示，is_demo 不约束运行访问。

未知实际管理员使用频率、账号最终状态及公网暴露；仅 SQLite 运行共享链，MariaDB 各版本完整导入未观察。

## 代码证据

- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/274b2823616075d9f5a70037e6ac429e2c47570e/src/apps/answer-card/server/middleware.ts#L49-L63)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/274b2823616075d9f5a70037e6ac429e2c47570e/src/server/auth/permissions.ts#L63-L75)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/274b2823616075d9f5a70037e6ac429e2c47570e/src/server/db/schema.mariadb.sql#L31-L55)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/274b2823616075d9f5a70037e6ac429e2c47570e/src/server/routes/backup.ts#L293-L308)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/274b2823616075d9f5a70037e6ac429e2c47570e/src/server/services/DemoDataService.ts#L332-L342)

原始页面文本和代码片段见 [结果原文](结果原文.md#结果-27)。
