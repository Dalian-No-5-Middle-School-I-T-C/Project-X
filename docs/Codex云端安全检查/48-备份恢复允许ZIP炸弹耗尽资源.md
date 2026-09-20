# 48 备份恢复允许ZIP炸弹耗尽资源

- 原标题：Backup restore permits ZIP-bomb denial of service
- 云端级别：Informational
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/2b5e8a2504048191a433c2900e05df6b?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=&page=3)
- 关联提交：[c2a1745](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/c2a1745e7fc4593baaa746eb50d7e2a3d0646851)

## 概要

新增整库恢复仅将压缩请求限制为 512 MiB。extractZipFromBuffer 枚举全部条目，同步 entry.getData() 将每个条目完整展开到内存，再同步写盘，没有条目数、单项/总展开大小或压缩比上限。解压先于 metadata.json 和 projectx.db 验证，恶意 ZIP 无需是有效备份。

应流式解压并限制条目数、单项及累计大小，拒绝异常压缩比与不支持条目类型，避免同步整项分配。

## 验证与路径

实际管理员菜单上传 → 携带令牌 POST /api/db/restore → 认证与 user:manage 通过 → 检查压缩体积和 PK 前缀 → 同步解压写盘 → 共享事件循环、内存与临时磁盘受影响。

原测试用 261,030 字节归档展开 268,435,456 字节（256 MiB），并发请求延迟约 2.08 秒。缺少元数据的提前返回将展开目录留在 /tmp。未尝试 OOM、杀进程或填满磁盘；最大宕机影响属于推断，不能写成已复现。

## 等级判断

条件性单服务可用性影响高、可能性低，矩阵为低危；最终因需要管理员或等效 user:manage 权限主动恢复，且没有权限提升或低权限路径，按策略排除为信息提示。原报告此前中危判断代表真实 ZIP 放大问题，并非否认技术缺陷。

外部攻击者需诱导管理员导入，或已控制该权限账号。代理可增加远程可达性，但不能消除管理员授权和交互前提。

## 已有防护与盲点

备份路由独立强制令牌认证及 user:manage，界面仅管理员可见；有压缩请求上限、非空 Buffer / PK 检查、路径归一化与目标前缀约束；成功及捕获异常后清理临时目录，但缺失元数据提前返回未清理。默认监听 127.0.0.1:5174。没有恢复专用限流、解压配额、压缩比限制或工作进程隔离。

未测峰值堆/原生 Buffer，未检查真实代理、容器配额、清理任务或进程监管；这些可能减少故障时间或残留。未知管理员导入不可信备份的概率；自定义角色也可能有 user:manage，但仍需该高权限。未证明泄密、数据完整性、代码执行或跨服务集群影响。

## 代码证据

- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/c2a1745e7fc4593baaa746eb50d7e2a3d0646851/src/server/routes/backup.ts#L19-L24)

原始页面文本和代码片段见 [结果原文](结果原文.md#结果-48)。
