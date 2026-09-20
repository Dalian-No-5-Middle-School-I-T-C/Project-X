# 36 打包systemd服务以root运行且数据权限公开

- 原标题：Packaged systemd service runs as root with public data modes
- 云端级别：Low
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/01e622650ec88191aa464fa5fcccd97d?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=&page=2)
- 关联提交：[e5f0253](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/e5f0253650c2fe4b2800fc00c965a06ab9910cfc)

## 概要

本提交在 Ubuntu 包中生成 project-x-server.service，未设置 User、Group、UMask、StateDirectory 或文件系统加固。系统级 unit 通常以 root、0022 掩码运行；应用新建 /var/lib/project-x、数据库和上传目录未指定严格模式，干净安装常得到 0755 目录、0644 文件。其他普通本地账号可读 SQLite 中学生／分数、可复用初始密码、提供商密钥及试卷答案图。root 网络／解析进程会放大未来 RCE，但本报告没有证明 RCE，不计作既有效果。

建议专用 User/Group、UMask=0077、StateDirectoryMode=0700、NoNewPrivileges、ProtectSystem 等。

## 验证及证据

打包确含不安全 unit，systemd-analyze 和源码支持默认身份／掩码。模拟同等 UID/umask 的实测产生 root-owned 0755/0644，独立 nobody UID 可读取学生初始密码、提供商密钥和上传文件；该历史提交未有启动 chmod/ACL 或相应秘密加密补偿。

验证同时纠正一个前提：生成 README 只教前台 ./start.sh，并没有指导安装 bundled systemd unit。动态不是在真正 systemd PID 1 下启动，而是等价身份／掩码再现。

## 攻击路径与分级

运维自行启用打包系统 unit → root＋0022 → 无显式模式创建状态 → 本地普通账号穿越目录并读文件 → 绕过应用认证读敏感数据。

影响程度高：全实例教育记录、初始密码、明文提供商密钥和图像保密性；未证明普通账号写入或代码执行。发生可能性低：非网络向量，需可选 unit、SQLite 固定路径、未私有预配置或覆盖及不可信普通本地用户。README 未引导此安装，亦无证据学校服务器向不可信用户提供 Shell。原中危调整为高影响×低可能性＝低危，非不可实现或自身影响排除。

## 假设、控制与盲点

系统 unit 无安全 override，使用 /var/lib/project-x SQLite，新目录，默认 systemd 掩码，本机另有普通 UID。unit 启用 PROJECTX_AUTH_ENFORCE=1 和回环监听不防直接磁盘读；root 所有权通常阻止普通修改，所以直接只证泄密。前台模式若由专用用户＋严格掩码启动可安全。

未知普通主机用户存在率、unit 使用率、SSH 策略、现有 ACL、父目录模式和全局 DefaultUMask。公网入口与此本地链无关。未来 root RCE 仅作为放大隐患，未找到独立代码执行原语。

## 代码证据

- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/e5f0253650c2fe4b2800fc00c965a06ab9910cfc/scripts/package-server-ubuntu.cjs#L157-L177)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/e5f0253650c2fe4b2800fc00c965a06ab9910cfc/src/apps/answer-card/server/storage.ts#L10-L21)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/e5f0253650c2fe4b2800fc00c965a06ab9910cfc/src/server/db/index.ts#L18-L26)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/e5f0253650c2fe4b2800fc00c965a06ab9910cfc/src/server/repositories/UserRepository.ts#L49-L56)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/e5f0253650c2fe4b2800fc00c965a06ab9910cfc/src/server/routes/ai-providers.ts#L18-L33)

原始页面文本和代码片段见 [结果原文](结果原文.md#结果-36)。
