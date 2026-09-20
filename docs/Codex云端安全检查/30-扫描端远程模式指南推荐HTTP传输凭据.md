# 30 扫描端远程模式指南推荐HTTP传输凭据

- 原标题：Scanner remote-mode guide exposes credentials over HTTP
- 云端级别：Medium
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/bb4738134740819191f3b5e307143d73?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=&page=2)
- 关联提交：[047b91e](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/047b91efd57e23785101164081700bdbead80710)

## 概要

客户端原已接受任意 HTTP URL，本提交将 http://192.168.1.100:5174 与扫描 API 密钥配置一起放进用户可达的主指南，没有要求非回环 HTTPS或警告只可本地开发。所有 API 使用该基地址：登录 JSON 带用户名／密码，后续头带 X-Api-Key 和 Bearer，扫描上传还带每页令牌及答案图。

学校局域网在途攻击者无需 Project-X 账号即可读或改这些流量，重放扫描密钥上传，或用用户密码／会话执行其权限。建议指南改 HTTPS，明确所有非回环必须 TLS，客户端除明确回环开发模式外拒明文远程 URL。

## 验证及证据

生产 URL 与请求头工具接受文档 HTTP，无 TLS／回环限制或警告；HTTP 接收器观察到登录密码、API 密钥、Bearer、上传令牌及 multipart 答案图片。源码追踪已分发扫描客户端、令牌签发、可复用密钥鉴权及上传路径。未用真实校园网嗅探器或 TWAIN，但密码／密钥泄露不依赖扫描硬件。

## 攻击路径与分级

操作员按内置指南设 HTTP 远程 URL＋扫描密钥 → 登录／扫描 → 无 TLS 的秘密和图像 → 无认证 LAN 在途者截获／修改 → 重放用户或扫描身份。

影响程度高：可复用身份、学生答案保密性及提交完整性。发生可能性中：需在途位置、操作员选择非默认本地模式、另配 LAN 入口（Node 自身仅回环）。另一本部署指南要求 HTTPS 是有意义反证，但产品内指南和占位符明推 HTTP、客户端无强制，不能消除路径；高影响×中可能性为中危。

## 假设、控制与盲点

用户按指南设可达非回环 HTTP；登录或上传经过该连接；攻击者可观察／修改网络。现有默认本地、回环监听、另一指南 HTTPS Nginx、上传认证、密钥 scope／active／可撤销都降低概率，却不能保护明文中已被窃取的有效凭据。

没有具体 LAN listener/proxy 部署证明；实验是 HTTP 接收器而非独立真实网络主机抓包。用户数量和权限未知。相同 HTTP 示例在此前 readus/多端使用说明.md 已有，本提交新增主内置指南分发，并非最早创造每处不安全行为。

## 代码证据

- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/047b91efd57e23785101164081700bdbead80710/src/apps/answer-card/client/auth/api.ts#L48-L59)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/047b91efd57e23785101164081700bdbead80710/src/apps/answer-card/client/auth/AuthContext.tsx#L123-L129)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/047b91efd57e23785101164081700bdbead80710/src/apps/answer-card/client/components/ScannerPanel.tsx#L198-L237)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/047b91efd57e23785101164081700bdbead80710/user%20guide/Project-X%E7%94%A8%E6%88%B7%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E.md#L154-L168)

原始页面文本和代码片段见 [结果原文](结果原文.md#结果-30)。
