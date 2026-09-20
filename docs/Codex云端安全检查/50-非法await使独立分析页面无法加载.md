# 50 非法await使独立分析页面无法加载

- 原标题：Invalid await prevents the analysis page from loading
- 云端级别：Informational
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/408baa6ca8a0819195c4ab371f8f301d?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=&page=3)
- 关联提交：[9bd9f59](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/9bd9f593fe99059f588940b675c53a3ee816ffa3)

## 概要

新增根目录 Grade-Analysis-System-database.html 中，fetchClassStats() 虽为 async，但 classes.map() 的回调未声明 async，却在第 313 行 await fetchExams()，导致 JavaScript 语法错误。整个主要内联脚本在解析阶段被拒绝，健康检查、登录、演示数据加载、报表渲染和初始化函数均不可用。

## 验证与路径

原验证通过实际本地页面服务和标准解析器确认故障，Node 解析与 vm.Script 独立验证语法错误。验证清单还要求记录额外解析错误对修复充分性的影响，但页面叙述未给出其具体位置，因此不能据此断言只改这一处即可完全修复。

用户显式打开独立 HTML → 浏览器解析经典内联脚本 → 同步回调内非法 await → 整段脚本不实例化 → 该页全部业务流程不可用。

## 等级判断

影响低，最终为信息提示：没有攻击者输入或身份/权限边界突破，只是已经存在的页面故障。该文件不属于主 React 生产构建：正常入口 index.html，生产构建和 Express 静态服务使用该历史提交的 dist/client，而非仓库根目录。开发 Vite 可按显式文件路径提供它，但默认监听 127.0.0.1。

## 前提、防护与盲点

需操作者单独发布该 HTML 或启动源码根目录静态/开发服务，再由用户访问明确文件名。解析在凭据、令牌或成绩数据处理前即失败，不涉及数据读取或修改。

完整浏览器复现因缺失 Electron/Chromium 宿主系统库未执行。未知外部部署是否复制根目录 HTML，或是否有人手动分发；仓库未证明开发服务外网入口。这里的 dist/client 是报告关联提交事实，不是对当前仓库构建目录的重新描述。

## 代码证据

- [](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/9bd9f593fe99059f588940b675c53a3ee816ffa3/Grade-Analysis-System-database.html#L310-L314)

原始页面文本和代码片段见 [结果原文](结果原文.md#结果-50)。
