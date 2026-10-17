# readus/ 文档索引

> **本索引建立于 2026-10-17**，对应 `package.json` 版本 **v2.6.0**、数据库迁移 **v60**（`src/server/db/migrations.ts` 与 `src/server/db/mysql.ts` 两侧同号）。
>
> 建索引的原因：issue #283「readus目录下文件亟待更新」。`readus/` 里同时存在**描述现状的规范文档**和**某一天的排查/评审记录**，两类混在一起时，读者会把历史快照当成现行行为。本索引把它们分开，并如实标注每份文档本轮是否对照代码复核过。

## 一、现行规范（描述当前实现，改代码要同步改这里）

| 文档 | 覆盖范围 | 2026-10-17 复核状态 |
| --- | --- | --- |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 系统总体架构、模块关系、构建产物 | 已复核，本轮更正默认皮肤、CSS/令牌事实源、mode 数量（12）与路由壳组件名 |
| [ACCOUNT-ARCHITECTURE.md](./ACCOUNT-ARCHITECTURE.md) | 三级账号模型全栈视角、Token 与会话、UI 权限映射 | 已复核两轮，本轮更正会话有效期、鉴权默认值、教师权限表述、角色权限位的可改性、构建命令；返修补上 §1/§3.2 的凭据流向（Cookie 主通道 + 跨域内存 token，非 localStorage）与 `admin-permissions` 定性（教师矩阵而非角色权限位） |
| [ACCOUNT-CONTROL.md](./ACCOUNT-CONTROL.md) | 后端认证/账号 API 清单与权限门 | 已复核，本轮补自助设置端点与 #322 学生边界、Cookie 主通道与媒体票据、鉴权默认值；§6 的开关作用范围按「挂了哪个门」逐条写清（PR #334 评审 P2） |
| [DATABASE.md](./DATABASE.md) | 表结构、双方言、迁移与 SQL 兼容 | 迁移上界本轮由 v34 更正为 **v60**，新增 v35→v60 编号台账与 Token 口径；v41 以后的逐表说明仍未补 |
| [双方言SQL函数安全清单.md](./双方言SQL函数安全清单.md) | SQLite / MariaDB 函数与日期比较红线 | 条目仍有效（含 2026-10-04 新 entries） |
| [UI-ARCHITECTURE.md](./UI-ARCHITECTURE.md) | v2 组件体系、主题令牌、样式分层 | 已复核两轮，本轮移除失效的令牌同步流程与外围文档引用；返修清掉残留的三处自动同步表述（§1 铁律、§3 换色第 5 步、§6 `app.css`）与 §7 皮肤段的过期默认值（现为 `paper-edge`，且始终写 `data-skin`） |
| [SKIN-THEME.md](./SKIN-THEME.md) | 皮肤/明暗模型与账号级偏好持久化 | 已复核，与当前实现一致 |
| [ADMIN-GUIDE.md](./ADMIN-GUIDE.md) | 管理员操作流程、角色与引导密码 | 已复核（版本号本轮对齐），新增 §8.6「学生账号能自己改什么」（#322） |
| [ADMIN-BOOTSTRAP-PASSWORD.md](./ADMIN-BOOTSTRAP-PASSWORD.md) | 首次启动管理员引导密码机制 | 本轮未逐条复核；机制存在性由 `scripts/verify-auth.ts` 覆盖 |
| [SCANNER-SETUP.md](./SCANNER-SETUP.md) | 扫描端安装、TWAIN/OMR 环境 | 本轮未逐条复核（涉及 Windows 实机验收） |
| [多端使用说明.md](./多端使用说明.md) | 学生端 / 教师端 / 扫描端三形态用法 | 已复核（版本号本轮标注复核时点） |
| [原卷与逐题答案-使用说明.md](./原卷与逐题答案-使用说明.md) | 原卷与逐题答案的开关与可见性 | 本轮未逐条复核（对应迁移 v54） |
| [WECHAT-GRADE-RELEASE-开发者上线清单.md](./WECHAT-GRADE-RELEASE-开发者上线清单.md) · [WECHAT-GRADE-RELEASE-部署与排错.md](./WECHAT-GRADE-RELEASE-部署与排错.md) | 成绩公布订阅消息 | 本轮未逐条复核（对应迁移 v53） |
| [答题卡二维码说明.md](./答题卡二维码说明.md) | 卡面二维码与身份绑定 | 本轮未逐条复核 |
| [LADDER_TEST.md](./LADDER_TEST.md) | 天梯功能验证要点 | 本轮未逐条复核 |
| [AI成绩分析.md](./AI成绩分析.md) | AI 分析链路与 llmclient 用法 | 本轮未逐条复核 |
| [SPONSOR-PAGE.md](./SPONSOR-PAGE.md) | 赞助页机制 | 本轮未逐条复核 |
| [演示数据.md](./演示数据.md) | 演示数据生成与清理 | 迁移上界本轮更正为 v60，其余未逐条复核 |
| [KNOWN-ISSUES.md](./KNOWN-ISSUES.md) | 已知问题台账 | 内容维护到 2026-10-05；条目按记录时点描述，最新状态以 CHANGELOG 为准 |
| [CHANGELOG.md](./CHANGELOG.md) | 发版与整改流水账（只追加） | 持续维护 |
| [项目胶囊.md](./项目胶囊.md) | 项目背景与产品定位叙述 | 本轮未逐条复核，不作为实现依据 |

## 二、时间点记录（保留原文，不作为现行规范来源）

这些文档描述的是某一天做了什么的现场，代码演进后不再逐条更新；与现行实现冲突时，以第一节文档和代码为准。

| 文档 | 记录时点 |
| --- | --- |
| [BUGFIX-SUMMARY-2026-07-19.md](./BUGFIX-SUMMARY-2026-07-19.md) | 2026-07-19 批量修复 |
| [CODE-REVIEW.md](./CODE-REVIEW.md) | 2026-07 全量代码评审 |
| [TWAIN驱动问题研究报告.md](./TWAIN驱动问题研究报告.md) | 2026-08 TWAIN 驱动排查 |
| [整改清单-2026-08-03-正态分布同步评审.md](./整改清单-2026-08-03-正态分布同步评审.md) | 2026-08-03 专项评审 |
| [成绩分析系统优化建议清单.md](./成绩分析系统优化建议清单.md) | 2026-08 优化建议（未落地项可能已变化） |
| [PR248-成绩公布发布说明.md](./PR248-成绩公布发布说明.md) | PR #248 发布说明 |
| [Project-X快速问题处置报告.md](./Project-X快速问题处置报告.md) | 2026-09 快速处置台账 |
| [SECURITY-AUDIT-NOTES-2026-10-04.md](./SECURITY-AUDIT-NOTES-2026-10-04.md) | 2026-10-04 安全审查 |

## 三、按任务找文档

与根目录 [AGENTS.md](../AGENTS.md) 的「文档入口」表一致，这里只给最短路径：

- 改权限 / 账号 → [ACCOUNT-CONTROL.md](./ACCOUNT-CONTROL.md)（后端门与 API）＋ [ACCOUNT-ARCHITECTURE.md](./ACCOUNT-ARCHITECTURE.md)（全栈模型）；权限约束必须落在后端，前端隐藏入口不算校验。
- 改表结构 / 迁移 → [DATABASE.md](./DATABASE.md) ＋ [双方言SQL函数安全清单.md](./双方言SQL函数安全清单.md)。
- 改 UI / 样式 → [UI-ARCHITECTURE.md](./UI-ARCHITECTURE.md) ＋ [SKIN-THEME.md](./SKIN-THEME.md) ＋ AGENTS.md 的样式事实源一节。
- 改扫描端 → [SCANNER-SETUP.md](./SCANNER-SETUP.md) ＋ [多端使用说明.md](./多端使用说明.md)；TWAIN/OMR 的历史排查见第二节对应文件。
- 部署与发版 → 根目录 [README.md](../README.md)、[SERVER-README.md](../SERVER-README.md)、[deploy-guide.md](../deploy-guide.md)、[CHANGELOG.md](./CHANGELOG.md)。

## 四、维护约定

1. **改代码时只更新第一节的文档。** 第二节的时间点记录不回头改写——它们是「当时为什么这样做」的证据，改掉就失去价值。
2. 新增文档在第一节或第二节登记一行，并注明是否对照当前代码复核过。**没复核过就写「未逐条复核」**，不要让读者替你猜哪份是活的。
3. 版本相关内容（`package.json` 版本、迁移号、`verify:*` 用例数）不要写死在正文里当现状；需要引用就写明「以代码为准」。AGENTS.md 已把「旧文档中的版本号、测试通过数不代表当前状态」列为现行约束。
4. 命令、路径、环境变量名以 `package.json`、`vite.config.ts` 与代码为准；文档与实现冲突时**先修文档中确实错的那部分**，不凭旧说明改实现行为。
5. `docs/superpowers` 不是项目文档目录，不在本索引登记范围内（见 AGENTS.md）。
