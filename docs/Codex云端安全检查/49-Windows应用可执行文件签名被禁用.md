# 49 Windows应用可执行文件签名被禁用

- 原标题：Windows application executable signing is disabled
- 云端级别：信息提示（Informational）
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/fe293302ee748191ba5c34e9f2a16830?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=&page=3)
- 关联提交：[c4cdb02](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/c4cdb02cdb22b3abc94edddccf2bcf5cd513cfff)

- 页面时间：2026 年 6 月 14 日 18:03（原页面未注明时区）。
- 操作者：火箭。

## 概要

本次提交将 electron-builder 默认启用的行为改为 signAndEditExecutable: false，由此引入签名退化。图标路径修改使用仓库控制的 PNG，不会暴露攻击者输入。新增 --use-system-ca 只影响由操作者执行的 MSI 构建过程，在所述可信构建主机假设下，不能独立利用。

新增的全局 Windows 构建选项将 signAndEditExecutable 设为 false。正常情况下，提供签名凭据时，electron-builder 会利用这个阶段修改已打包的应用可执行文件，并为其添加 Authenticode 签名。因此，即使发布环境配置了签名凭据，便携版和 MSI 打包流程仍会生成未签名的内部应用可执行文件。这不一定阻止外层 MSI 或便携容器被独立签名，但会移除可执行文件级的发布者认证，使签名强制策略无法验证已安装或已解压的应用。能够修改共享部署副本、解压后的便携应用或已安装可执行文件的攻击者，可以替换代码，而不会使应用可执行文件签名失效，因为该签名根本不存在。利用仍需要对分发或应用位置的写入权限，以及后续用户执行，因此这是低优先级供应链／本地完整性弱点，而不是可远程触达的应用漏洞。应移除该选项或将其设为 true，在发布环境提供签名凭据，并验证生成产物的签名。

## 验证

1. 确认提交在实际生效的 Windows electron-builder 配置中加入 signAndEditExecutable=false。
2. 确认所配置 electron-builder 版本及默认语义，使该选项即使在存在凭据时也会禁用可执行文件修改和签名。
3. 确认选项应用于真实便携版和 MSI 发布流程，且没有被脚本或其他配置覆盖。
4. 通过 electron-builder 配置加载器及实际 WinPackager.signApp 实现，复现最接近可行的生产签名行为；由于记录的平台限制，仍无法取得完整 Windows 产物。
5. 在所提供威胁模型下，确定所述完整性影响及所需攻击者／操作者前提。

### 验证输出结果

原页面提供验证输出入口；附件内容未包含在已归档的页面正文中。

## 证据注释

1. 全局 Windows 打包配置明确禁用了 electron-builder 的可执行文件签名和修改阶段。

## 攻击路径分析

校准后的总体影响为高，因为成功替换的可执行文件能够运行任意代码，并访问本地存储的考试数据；但发生可能性为低，按要求的高影响／低可能性矩阵得到低严重性。随后单独进行的策略调整适用强制排除：所有有证据支持的攻击路径，都要求预先拥有对构建输出、部署副本、解压后的便携目录或安装目录的特权或受保护路径写入能力。禁用签名不会提供这种访问，也不会带来额外提权能力，没有证据证明存在远程或低权限产品入口。因此，尽管构建控制退化已经验证，最终可报告性仍为忽略。

### 路径

Project-X Windows 发布构建 → signAndEditExecutable=false 跳过内部可执行文件签名阶段 → 便携 EXE 或 MSI 内含没有 Project-X 发布者签名的内部可执行文件 → 不存在可被替换行为破坏的 Project-X 内部可执行文件签名 → 应用可执行文件被替换 → 替换文件被交给用户执行 → 受害用户启动应用 → 载荷以当前登录用户权限运行 → 以受害者身份执行任意代码并访问本地 Project-X 数据。

这是文档记载的 Windows 产品流程中真实的可执行文件完整性退化。package.json 全局设置 build.win.signAndEditExecutable=false，提供的可执行验证针对固定版本 app-builder-lib 26.15.2 证明：即使正常情况下会签名，WinPackager.signApp 仍会在修改或签名应用可执行文件之前返回。该设置适用于文档中的便携版和 MSI 构建命令。最强反向证据是仓库没有签名凭据、forceCodeSigning 配置、发布自动化、更新器或已签名产物，无法证明 Project-X 当前运行已签名发布流水线。此外，外层 MSI 或便携容器仍可独立签名，MSI 也配置为按用户安装。这些因素没有否定配置缺陷：外部有效凭据仍会在内部可执行文件处被跳过。但它们对可报告性具有决定作用，因为利用需要预先拥有受保护分发或应用路径的写入权限，需要绕过外层容器保护或等到该保护不再适用，还需要后续受害者执行。仓库没有提供远程用户、学生、教师或其他低权限主体获取该写入能力的路径。因此，此问题削弱纵深防御中的发布者认证，但本身没有跨越权限边界。

## 发生可能性

低（Low）。不存在可通过网络触达的签名危险操作、更新机制，或仓库支持的低权限可执行文件替换路径。攻击者必须已经控制发布共享位置或可写应用目录，避开外层产物验证或等到验证不再适用，并诱使用户执行。没有已提交签名凭据或已签名发布流水线，能够证明否则一定会执行可执行文件签名。这些条件使利用不太可能发生。

## 影响程度

高（High）。成功替换并执行后，攻击者可获得受害应用用户权限下的任意代码执行。打包应用指向 Electron userData 目录中的本地数据库和答题卡数据，项目文档也说明扫描图片和成绩保存在本地。因此，利用后的机密性、完整性及可用性后果可能较高，但签名设置本身不授予所需写入权限。

## 假设条件

- Windows 发布通过仓库的 electron:dist 或 electron:msi 脚本构建，并使用全局 build.win 配置。
- 提供的验证所演示的固定版本 electron-builder／app-builder-lib 26.15.2 行为，仍能代表发布构建。
- 有意义的攻击需要受害者从攻击者可修改的位置取得或运行可执行文件。
- 签名凭据可能在仓库之外提供；仓库中没有提交凭据或已签名产物。

原文另列前提：

- 使用受影响 electron-builder 配置生成 Windows 便携版或 MSI 发布包。
- 发布环境原本具备有效的 Project-X 签名凭据。
- 攻击者取得共享部署副本、解压后便携目录或已安装应用可执行文件的写入权限。
- 外层容器签名检查被绕过、被省略，或因替换发生在解压／安装后而不再适用。
- 受害者执行被替换的应用。

## 控制措施

- 应用资源启用 ASAR 打包，但它不能认证或保护被替换的外层应用可执行文件。
- 外层 MSI 或便携容器可独立签名；强制验证签名时，可以检测解压前篡改。
- MSI 的 perMachine=false 将安装配置为按用户安装，而非需要特权的全机安装。
- Electron 使用 contextIsolation=true、nodeIntegration=false 和 sandbox=true，但这些渲染进程控制不能缓解整个可执行文件替换。
- 仓库中未发现自动更新机制，因此没有已证明的远程更新投递替换路径。
- 文件系统和发布渠道访问控制列表是主要前提控制，但其部署配置位于仓库之外。

## 盲点

- Linux 验证环境没有生成完整 Windows 产物，因此未直接检查已发布 PE 文件的实际签名。
- 仓库没有签名凭据、发布 CI 配置或已签名产物，当前实际签名实践未知。
- 外部 GitHub 组织控制、发布资源保护、学校部署共享目录、Windows ACL、AppLocker 或 WDAC 策略及终端防护，都不在仓库范围内。
- 仓库无法确定某一产物被多少系统使用，因此整个设备群的影响范围未知。
- 某些输入 PE 文件可能仍保留上游 Electron 厂商签名，但这不能认证 Project-X 为发布者。

## 证据代码

文件名后的数字是该片段在报告所关联提交中的首行行号；不连续的片段分别列出。

### [package.json:75](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/c4cdb02cdb22b3abc94edddccf2bcf5cd513cfff/package.json#L75)

~~~~json
    "win": {
      "icon": "resources/icon.png",
      "executableName": "答题卡设计系统",
      "signAndEditExecutable": false,
      "target": [
        {
          "target": "portable",
          "arch": [
            "x64"
          ]
        }
      ],
~~~~
