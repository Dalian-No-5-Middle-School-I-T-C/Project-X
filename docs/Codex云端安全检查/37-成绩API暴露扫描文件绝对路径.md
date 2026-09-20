# 37 成绩API暴露扫描文件绝对路径

- 原标题：Score API exposes absolute scanner file paths
- 云端级别：低危（Low）
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/b4bf0da3256881919e1f6e8345eea83d?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=&page=2)
- 关联提交：[e6ba585](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/e6ba5853e31ff93b79ff52bc458bed762e78cb0c)

- 页面时间：2026 年 6 月 19 日 17:38（原页面未注明时区）。
- 操作者：火箭。

## 概要

本次提交将 sr.file_path 新增到成绩响应中，却没有转换为基本文件名，因此引入信息披露；此前响应只有扫描记录 ID 和页号。

详情查询选择 scan_records.file_path，并将其别名设为 fileName 后原样返回。该值来自 Multer 的 file.path，通常包含绝对数据目录、部署路径，还可能包含操作系统账号名。拥有 exam:read 的已认证教师即可请求学生成绩详情；关闭认证强制执行的部署还允许匿名请求。图片处理器立即取 basename，并在自己的上传根目录下解析，因此返回完整路径没有必要。客户端还会将编码后的绝对路径嵌入图片 URL，可能使其进入浏览器或代理日志。应只返回 basename，或单独保存 file_name。图片端点会丢弃目录分量，不允许任意文件读取，所以直接影响限于部署路径披露。

## 验证

1. 确认生产挂载路由原样序列化 file_path，没有执行 basename 转换或脱敏。
2. 确认该值来自 Multer 路径，可能包含绝对部署目录。
3. 确认强制认证模式要求 exam:read，教师可访问，学生及匿名用户被拒绝；关闭认证时匿名用户可访问。
4. 通过真实 HTTP 请求使用具有辨识性的绝对路径，并断言响应精确返回该路径。
5. 确认客户端将路径编码进 URL，而图片端点仅使用 basename，从而限定影响为元数据披露。

### 验证输出结果

原页面提供验证输出入口；附件内容未包含在已归档的页面正文中。

## 证据注释

1. 客户端将泄露的路径嵌入图片 URL，可能使其传播到请求日志。
2. 图片端点只调用 path.basename(req.params.fileName)，证明目录分量没有必要。
3. 修改后的查询读取原始 file_path，未经处理就放入对外的 fileName 字段。
4. 原始文件系统路径被序列化到 HTTP 响应中。

## 攻击路径分析

不适用排除规则：影响不限于本人，扫描记录属于正常应用状态，推荐认证配置下低权限教师可触发，默认兼容配置还可能允许匿名访问。文档中的公共 Nginx 部署表明它不限于本机；启用认证会移除匿名路径，但不会移除教师路径。披露仅涉及文件系统元数据，basename 防止任意读取，因此影响低。受支持部署可以远程访问，使用有效 ID 发起正常 GET 即可，且生产 Express 验证成功，因此发生可能性高。按矩阵，低影响与任何非 ignore 可能性组合都为低危。

### 路径

远程教师，或关闭认证时的匿名用户 → 文档中的 HTTPS／Nginx 入口 → 回环 5174 服务 → 学生成绩 GET → 强制认证时 examGate 只要求 exam:read → 教师满足权限，或兼容模式跳过检查 → file_path 被选为 fileName → 原样返回 JSON，并被编码进图片 URL → 客户端请求图片 → 图片端点只使用 basename。

这是真实的低影响泄露，而非纯正确性问题。Multer 在绝对 dataDir 下写入图片，判分保存路径，详情接口原样返回 scans[].fileName。生产 Express 验证返回 /srv/project-x/private-data/recognition/uploads/12345678/scan_secret.png；强制认证模式下默认教师成功访问，默认关闭认证的兼容模式下匿名访问也成功。最强反向证据是回环监听及指南要求开启认证；但同一指南明确介绍公共代理，强制认证仍允许教师访问，因此不能否定问题。限定影响的证据决定评级：图片端点使用 basename，并拼接自己的目录，没有证明任意读取或目录穿越。教师按预期能够读取答题图片，但没有必要获知服务器目录。前提是普通扫描状态，不是运维专属操作。可以报告的是有界主机路径泄露，以及可能的日志传播；没有证明凭据泄露、文件内容泄露、完整性或可用性影响。

## 发生可能性

高。只需正常 GET，无需用户交互或竞争条件；扫描记录属于常规数据，默认教师有权访问，兼容模式允许匿名请求。文档支持公网部署，两条访问路径也均已验证。有相关记录时发生可能性高，尽管实际网络暴露仍取决于部署。攻击向量为远程网络。

## 影响程度

低。攻击者获得文件系统及部署元数据，可能被日志保留；没有证明秘密、文件内容、改分、提权、代码执行或可用性影响。basename 明确阻止通过该绝对路径实现任意文件读取。

## 假设条件

- 文档中的 Nginx 公网部署是现实配置，但不声称所有实例都公开。
- 正常扫描在绝对 ANSWER_CARD_DATA_DIR 下生成非空 file_path。
- 代理日志行为取决于部署；JSON 中的直接披露不依赖日志。

原文另列前提：

- 存在匹配考试、答题卡、学生、批次，以及非空路径的扫描记录。
- 攻击者知道有效的考试和学生 ID。
- 强制认证时需要拥有 exam:read 的教师；默认关闭认证时无需会话。
- 能直接或通过代理访问 API。

## 控制措施

- API 之前由 optionalAuth 解析身份。
- 开启认证时，匿名请求返回 401，缺少 exam:read 返回 403。
- 默认学生没有该权限，验证中其请求被拒绝。
- 拒绝非数字 ID，并要求考试、答题卡和学生存在。
- 过滤路径为 null 的记录。
- 图片端点取 basename，并限制在 dataDir/recognition/uploads/:cardId 下，不能通过目录分量选择任意文件。
- 服务绑定回环地址，但文档中的代理可使其远程可达。
- 没有 shell、动态导入或其他执行入口使用该路径。

## 盲点

- 文档不能确定具体实例的部署情况。
- 没有检查在线代理，日志行为及保留策略未知。
- 没有完整执行原生 OCR 入库；路径来源通过静态追踪确认，生产详情及图片端点进行了动态验证。
- 账号名等目录信息的敏感性取决于数据路径和工作目录。
- 本报告不声称存在目录穿越或任意文件读取。

## 证据代码

文件名后的数字是该片段在报告所关联提交中的首行行号；不连续的片段分别列出。

### [src/apps/answer-card/client/components/ScoreFixPage.tsx:311](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/e6ba5853e31ff93b79ff52bc458bed762e78cb0c/src/apps/answer-card/client/components/ScoreFixPage.tsx#L311)

~~~~tsx
                          <img
                            src={`/api/scanner/grading-image/${student.cardId}/${encodeURIComponent(s.fileName)}`}
                            alt={`第${s.pageNum}页`}
                            style={{ width: "100%", border: "1px solid var(--line-light)", borderRadius: 4 }}
                            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
~~~~

### [src/apps/answer-card/server/scanner/index.ts:312](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/e6ba5853e31ff93b79ff52bc458bed762e78cb0c/src/apps/answer-card/server/scanner/index.ts#L312)

~~~~typescript
  router.get("/grading-image/:cardId/:fileName", (req, res, next) => {
    try {
      const cardId = safeId(req.params.cardId);
      const fileName = path.basename(req.params.fileName);
      // Prevent directory traversal
      if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
        res.status(400).json({ message: "Invalid file name" });
        return;
      }
      const targetPath = path.join(dataDir, "recognition", "uploads", cardId, fileName);
~~~~

### [src/server/routes/score-editing.ts:87](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/e6ba5853e31ff93b79ff52bc458bed762e78cb0c/src/server/routes/score-editing.ts#L87)

~~~~typescript
  // Scan record images — return file_path for grading-image endpoint
  const scans: Array<{ recordId: number; fileName: string; pageNum: number }> = [];
  try {
    const scanRows = db.prepare(`
      SELECT sr.id as recordId, sr.file_path as fileName
      FROM scan_records sr
      JOIN scan_batches sb ON sb.id = sr.batch_id
      WHERE sb.exam_id = ? AND sr.student_id = ?
      ORDER BY sr.id
    `).all(examId, studentId) as Array<{ recordId: number; fileName: string | null }>;
    scans.push(...scanRows.filter((r) => r.fileName).map((r, idx) => ({
      recordId: r.recordId, fileName: r.fileName!, pageNum: idx + 1
    })));
~~~~

### [src/server/routes/score-editing.ts:189](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/e6ba5853e31ff93b79ff52bc458bed762e78cb0c/src/server/routes/score-editing.ts#L189)

~~~~typescript
    scans: scans.map((s) => ({
      recordId: s.recordId,
      fileName: s.fileName,
      pageNum: s.pageNum,
    })),
~~~~
