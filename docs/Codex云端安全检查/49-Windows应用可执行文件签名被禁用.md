# 49 Windows应用可执行文件签名被禁用

- 原标题：Windows application executable signing is disabled
- 云端级别：Informational
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/fe293302ee748191ba5c34e9f2a16830?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=&page=3)
- 关联提交：[c4cdb02](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/c4cdb02cdb22b3abc94edddccf2bcf5cd513cfff)

## 概要

全局 Windows 打包配置新增 signAndEditExecutable: false，关闭 electron-builder 默认启用的可执行文件编辑与 Authenticode 签名阶段。即使发布环境提供签名凭据，portable 与 MSI 内层应用 EXE 也跳过 Project-X 发布者签名；外层容器仍可能独立签名。

图标更改为仓库受控 PNG，不涉及攻击者输入；--use-system-ca 仅影响操作者运行的 MSI 构建，在可信构建机假设下不独立构成漏洞。建议移除该选项或设为 true，配置发布凭据并检查产物签名。

## 验证与路径

原验证使用固定 app-builder-lib 26.15.2 的配置加载及实际 WinPackager.signApp，证明该选项使函数提前返回，且两种打包流程没有覆盖设置。Linux 环境未生成完整 Windows 产物，未直接检查发布 PE 签名。

攻击者已有发布共享目录、便携解压目录或安装 EXE 写权限 → 替换内层 EXE → 规避或等外层签名保护不再适用 → 用户运行 → 以用户身份执行并访问本地考试数据。

## 等级判断

成功替换后的条件性影响高，可能性低，技术矩阵为低危；最终因依赖已有受保护路径写权限且未证明权限提升，排除为信息提示。仓库未显示远程更新、低权限产品入口、签名凭据、forceCodeSigning、发布自动化或已签名产物；未知实际是否已有签名流水线。该缺陷削弱纵深防御，但本身不提供文件写权限。

## 防护与盲点

ASAR 不认证整个 EXE；外层容器签名可发现解压前篡改。MSI perMachine=false 为每用户安装，Electron 的 contextIsolation、禁用 nodeIntegration 与 sandbox 不能防御整程序替换。文件及发布渠道 ACL 是主要前提控制。

未检查实际 Windows ACL、共享目录、组织发布控制、AppLocker/WDAC、终端防护或安装规模。某些输入 PE 可能保留 Electron 上游签名，但不认证 Project-X 发布者。

## 代码证据

- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/c4cdb02cdb22b3abc94edddccf2bcf5cd513cfff/package.json#L75-L86)

原始页面文本和代码片段见 [结果原文](结果原文.md#结果-49)。
