# 50 非法await使独立分析页面无法加载

- 原标题：Invalid await prevents the analysis page from loading
- 云端级别：信息提示（Informational）
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/408baa6ca8a0819195c4ab371f8f301d?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=&page=3)
- 关联提交：[9bd9f59](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/9bd9f593fe99059f588940b675c53a3ee816ffa3)

- 页面时间：2026 年 6 月 13 日 08:43（原页面未注明时区）。
- 操作者：Tim-Hanchuan-Yang。

## 概要

此问题由本次修改引入。Grade-Analysis-System-database.html 是该修改范围中新加入的文件，其内联脚本在非 async 的 map 回调中使用 await，因此无法通过语法验证。

在 fetchClassStats() 中，传给 classes.map() 的回调没有声明为 async，却在调用 fetchExams() 时使用 await。这是 JavaScript 语法错误，浏览器会在解析阶段拒绝整个内联脚本。因此，初始化及所有事件处理函数，包括 API 健康检查、登录、演示数据加载和报告渲染，都不会被定义。故障发生在任何真实数据或演示流程运行之前。该文件是仓库根目录下的独立页面，不属于生产 Vite 构建，因此实际运行影响受到限制。

## 验证

1. 确认随文件提供的内联 JavaScript，在所述 await／非 async 回调位置无法通过符合标准的解析。
2. 确认错误位于页面唯一的主应用脚本中，导致初始化及事件处理函数声明无法生效。
3. 通过受限本地接口访问实际提供的页面；浏览器执行不可用时，使用最小解析测试程序验证。
4. 确定部署可达性，并验证独立页面被排除在主要生产构建之外。
5. 验证问题由所提供提交引入，并记录反向证据、前提，以及影响补丁充分性的另一处解析错误。

### 验证输出结果

原页面提供验证输出入口；附件内容未包含在已归档的页面正文中。

## 证据注释

1. classes.map 接收同步回调，但第 313 行在其中使用 await，使整个内联脚本解析失败。

## 攻击路径分析

底层正确性缺陷的技术影响较低，因为它只会使独立页面不可用。策略调整后，发生可能性被设为忽略：没有攻击者控制的输入到达故障点，没有跨越身份或授权边界，仓库证据也表明该文件位于正常生产构建及静态服务目录之外。访问它需要通过回环地址提供仓库根目录开发服务，或由操作者另行部署，并明确访问其 URL。按要求的矩阵机械计算，impact=low 与 likelihood=ignore 得到 adjusted criticality=ignore。

### 路径

明确请求根目录中的独立 HTML 页面 → 浏览器加载并解析页面 → 经典内联 JavaScript 解析器 → 解析到第 313 行 → 非 async 的 map 回调中存在非法 await → SyntaxError 阻止脚本实例化 → 整个内联脚本被拒绝 → 健康检查、登录、演示加载、渲染及初始化均未定义 → 独立页面流程不可用。

所报告的语法故障已在 Grade-Analysis-System-database.html:313 确认：fetchClassStats 是 async 函数，但第 311 行传给 classes.map 的回调不是，因此其中的 await 表达式非法。符合标准的解析器会拒绝整个经典脚本，使后续健康检查、登录、演示数据和初始化声明永远无法使用。提供的可执行解析证据确认了该行为。关于适用范围的最强反向证据是，Vite 在开发期间能够提供仓库根目录文件，而且该页面包含面向 API 的成绩分析逻辑。不过，仓库正常开发命令将 Vite 绑定 127.0.0.1，生产构建使用 index.html 和 dist/client，生产 Express 也只提供 dist/client。没有攻击者输入触发该故障，也没有跨越安全边界。因此，这是独立页面可用性／正确性缺陷，而不是可报告的安全漏洞。

## 发生可能性

忽略（Ignore）。不存在现实可行的低权限攻击行为：故障无条件发生，没有攻击者输入，请求页面只是向请求者展示已经存在的故障。仓库支持的可达范围限于回环开发服务器上的明确路径，生产静态服务排除此文件。按强制策略，缺少攻击者路径，以及需要开发者／操作者部署的前提，使安全利用不可报告。

## 影响程度

低（Low）。如果页面被单独提供，该缺陷会使所有打开它的用户完全无法使用这一独立分析页面。它不影响主要生产 React 构建，也不会泄露或修改凭据、学生记录、成绩或其他敏感资产。因此，技术影响较低，仅限这一独立文件的可用性和功能。

## 假设条件

- 仓库文档中的 Vite 和 Express 命令代表正常开发及生产流程。
- 仓库之外没有部署系统另行发布 Grade-Analysis-System-database.html。
- 如提供的验证证据所示，用户明确请求文件名时，以源码根目录为基础的 Vite 开发服务器可以提供该文件。

原文另列前提：

- 操作者必须运行以源码根目录为基础的开发／静态服务，或单独部署该 HTML 文件。
- 用户必须明确导航至 Grade-Analysis-System-database.html，因为正常应用入口为 index.html。
- 浏览器必须解析页面的经典内联脚本；不需要攻击者控制的输入。

## 控制措施

- Vite 开发命令显式使用 --host 127.0.0.1。
- 正常生产客户端构建输出至 dist/client，不包含该独立 HTML 文件。
- 生产 Express 静态处理器提供 dist/client，而非仓库根目录。
- 正常 index.html 入口加载 React 客户端，而非 Grade-Analysis-System-database.html。
- 在该页面处理凭据、Bearer 令牌、API 响应或成绩数据之前，浏览器解析就已失败。

## 盲点

- 仓库之外的部署流程可能把根目录 HTML 文件复制到公共文档根目录。
- 静态分析无法确定操作者是否手工分发这一独立文件。
- 验证环境缺少 Electron／Chromium 所需系统库，因此未能完整浏览器复现；不过 Node 解析和 vm.Script 均独立确认了语法错误。
- 没有仓库入口或负载均衡文件证明 Vite 开发服务器对外暴露。

## 证据代码

文件名后的数字是该片段在报告所关联提交中的首行行号；不连续的片段分别列出。

### [Grade-Analysis-System-database.html:310](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/9bd9f593fe99059f588940b675c53a3ee816ffa3/Grade-Analysis-System-database.html#L310)

~~~~text
  const classes = [...new Set(students.map(s => s.className))];
  return classes.map(cls => {
    const clsStudents = students.filter(s => s.className === cls);
    const subjects = (await fetchExams()).find(e => e.id === examId).subjects.map(s => s.name);
    const subjectAvgs = {};
~~~~
