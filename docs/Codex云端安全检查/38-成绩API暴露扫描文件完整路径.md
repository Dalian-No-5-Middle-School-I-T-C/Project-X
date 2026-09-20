# 38 成绩API暴露扫描文件完整路径

- 原标题：Score API exposes absolute scan-file paths
- 云端级别：Low
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/437bd471d96c8191a359a7108bcff8a1?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=&page=2)
- 关联提交：[6d424a3](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/6d424a30da7e6480f2c1a421569e4e72bd73dd99)

## 概要

本历史提交把原先只含数字扫描 ID 的响应扩展为原样 scan_records.file_path，别名 scans[].fileName。上传目录取绝对 dataDir，常规阅卷持久化 Multer file.path，所以教师能看到类似 /workspace/Project-X/data/answer-card/recognition/uploads/<card>/scan_....png 的主机结构。客户端再编码进图像 URL，可能扩散到浏览器、反代和访问日志。

应服务端 basename 或不透明图像 URL。图像处理本已 basename 并固定在 recognition/uploads/:cardId，不支持任意文件读。本项与另一历史提交相近标题分别保留。

## 验证、路径与分级

有界 Express/API 测试观察匿名 401、教师登录成功、真实成绩响应中精确绝对路径，以及受固定目录限制的图片读取。原生 OCR 未执行，测试种入绝对 file_path，正常上传到数据库链由源码确立。

教师 exam:read 请求 → 原始路径查询与序列化 → 客户端 encodeURIComponent → 图片请求及可能日志。发生可能性高：正常界面自动消费、默认教师权限、既有扫描记录，无竞态。影响低：仅文件系统元数据，没有凭据、秘密、额外学籍、RCE、完整性或可用性损害。固定目录 basename 阻止升级为穿越，最终低危。

## 假设、控制与盲点

按生产指南认证和 HTTPS 反代；有效教师、数值考试／学生 ID、关联卡片及扫描行。身份、角色、数值／对象存在、服务端生成文件名、basename、private 缓存、扫描默认 30 天过期和回环监听均存在。

完整 createApp 因缺 expr-eval 未实例化，使用确切相关模块。具体 Nginx 入口未知，代码不消费某部署示例 HOST，远程仍需代理。日志保留未证明。成绩编辑路线是否还存在对象范围缺失是独立问题，本项不主张更广成绩或图像 IDOR。

## 代码证据

- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/6d424a30da7e6480f2c1a421569e4e72bd73dd99/src/apps/answer-card/client/components/ScoreFixPage.tsx#L311-L313)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/6d424a30da7e6480f2c1a421569e4e72bd73dd99/src/apps/answer-card/server/index.ts#L296-L300)
- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/6d424a30da7e6480f2c1a421569e4e72bd73dd99/src/server/routes/score-editing.ts#L87-L99)

原始页面文本和代码片段见 [结果原文](结果原文.md#结果-38)。
