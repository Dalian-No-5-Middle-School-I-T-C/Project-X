# 35 取消扫描的兜底可能终止被复用的Windows进程号

- 原标题：Cancel fallback can kill a reused Windows PID
- 云端级别：Low
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/667d3d6cc8d881918e602edbaa4f3e17?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=&page=2)
- 关联提交：[f9ecba6](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/f9ecba6caf39f98a651b1bfd765214c6deb876e3)

## 概要

本提交新增取消端点与 taskkill 兜底。cancelScan 初始同时检查 exitCode、signalCode，child.kill 后保留两秒 watchdog，延迟检查却只看 exitCode===null。信号退出的 Node 子进程在 close 后通常仍 exitCode=null、signalCode 非空；close/error 移除 activeScans 但不取消定时器，因此已退出 PID 仍会执行 taskkill /F /T。

若 Windows 在间隔内把 PID 分给另一进程，就可能误杀服务账号有权终止的无关进程树。scanner/full 密钥或 GRADE_WRITE 用户可在原生扫描开启时启动／取消；重复 churn 可能增加机会。建议 close 时取消 watchdog，至少同时检查两字段，最好再校验进程身份。

## 验证及证据

生产函数测试观察原子进程取消后约 105 ms close，两秒后仍对已不存在 PID 发 taskkill。证明定时器过期检查及只存数值 PID，无 signalCode、当前 child 或身份重验。Linux 主机未真实运行 Windows taskkill，也未证明实际 PID 复用／误杀；已有测试只覆盖子进程登记前取消，不能覆盖本项。

## 攻击路径与分级

授权扫描者启动活跃桥 → cancel → 信号退出 → close 清注册但不清 watchdog → Windows 可能复用 PID → 旧定时器 taskkill /F /T → 无关同机进程可能终止。

发生可能性低：Windows、启用 TWAIN、活跃子进程、有效权限、信号退出、短两秒内 PID 复用同时成立。影响程度低：无法确定选择目标，只限同账号可终止进程树的可用性，未证明数据／身份／成绩损害。取消扫描不授权杀别的进程，因此不排除为仅本地正确性；最终低危。

## 假设、控制与盲点

PROJECTX_ENABLE_SCANNER=1/true 或 teacher-scanner，存在未完成会话和注册桥；有 scanner/full 或 GRADE_WRITE（或运维关闭认证）；远程另需公开回环入口。

Web 默认禁 TWAIN、默认认证、会话存在／非终态检查、最初双字段存活检查、两秒延迟、无 Shell 的固定参数避免命令注入均存在；无启动取消限流。Electron 通常只本地。

真实 Windows PID 复用率、服务账号权限、公开扫描端入口、OS 隔离／恢复未知；动态只证明过期调度，不证明替代进程被杀，低评级保留此限制。

## 代码证据

- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/f9ecba6caf39f98a651b1bfd765214c6deb876e3/src/apps/answer-card/server/scanner/index.ts#L157-L172)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/f9ecba6caf39f98a651b1bfd765214c6deb876e3/src/apps/answer-card/server/scanner/twain-bridge.ts#L17-L35)

原始页面文本和代码片段见 [结果原文](结果原文.md#结果-35)。
