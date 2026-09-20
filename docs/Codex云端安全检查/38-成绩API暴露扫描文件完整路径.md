# 38 成绩API暴露扫描文件完整路径

- 原标题：Score API exposes absolute scan-file paths
- 云端级别：低危（Low）
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/437bd471d96c8191a359a7108bcff8a1?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=&page=2)
- 关联提交：[6d424a3](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/6d424a30da7e6480f2c1a421569e4e72bd73dd99)

- 页面时间：2026 年 6 月 19 日 17:25（原页面未注明时区）。
- 操作者：火箭。

## 概要

本次提交引入与安全相关的信息披露。此前响应只返回数字扫描 ID，现在却返回 scan_records.file_path，而没有转换为基本文件名。

正常判分保存 Multer 的 file.path，上传根目录来自绝对 dataDir。本次提交直接将其别名设为 fileName，并在学生成绩 GET 响应中序列化。拥有 exam:read 的教师会收到类似 /workspace/Project-X/data/answer-card/recognition/uploads/`<card>`/scan_....png 的值。客户端又把完整路径编码进图片请求，可能使其进入浏览器、代理及访问日志。图片端点只需要 basename，因此 API 应在服务端转换，只提供基本文件名或不透明图片 URL。影响限于文件系统及部署元数据；它本身不允许任意文件读取，因为图片端点会在固定上传根目录下重建路径。

## 验证

1. 确认生产路由及授权允许具有 exam:read 的教师访问详情。
2. 确认正常上传及持久化保存的是绝对 Multer 路径，会暴露部署信息。
3. 确认 scans[].fileName 原样返回路径，没有 basename 转换。
4. 使用现实的 Express／API 专项测试框架，以获授权教师身份观察到响应中的绝对路径。
5. 确认客户端将完整值放入 URL，而图片端点限制在上传目录，支持有限元数据披露的影响判断。

### 验证输出结果

原页面提供验证输出入口；附件内容未包含在已归档的页面正文中。

## 证据注释

1. 客户端将绝对路径编码进 URL，可能使其传播到日志。
2. 正常持久化保存实际上传路径，证明该字段并非只有文件名。
3. 修改后的查询直接为原始列设置别名，没有执行 basename。
4. 原始路径被新增序列化为 scans[].fileName。

## 攻击路径分析

技术评估为低影响与高发生可能性；矩阵中，低影响与任何非 ignore 可能性组合均为低危。不适用排除规则：影响不限于本人，不需要宿主机、运维、开发或物理访问，也不依赖攻击者写入受保护字段。教师虽然已认证，但在威胁模型中属于部分可信主体；exam:read 不等于获准了解宿主机布局，服务端信息跨越到客户端的机密边界正是问题所在。回环监听、生产角色访问控制和 basename 降低暴露或限定影响，但不能消除已证实的响应泄露。因此保持可报告的低危，不上调，也不忽略。

### 路径

拥有 exam:read 的教师 → 携带考试及学生 ID 发起详情 GET → 查询 sr.file_path → 取得 Multer 路径 → 原样放入 fileName → JSON 返回绝对路径 → 客户端通过 encodeURIComponent 构造图片 URL → 教师及可能的日志系统获知该路径 → 文件系统和部署信息披露。

攻击过程：恶意或已失陷的教师账号通过正常改分流程请求已有学生详情，凭默认读取权限获准访问。绝对上传路径经判分写入数据库，再原样返回；React 又将其编码进图片请求，可能扩大日志中的披露。这是真实的服务端到客户端泄露，而非单纯正确性问题，但仅涉及元数据，不包含凭据、密钥、文件内容或成绩完整性。图片端点使用 basename 和固定目录，因此没有依据声称目录穿越、任意读取、代码执行或提权。专项验证观察到匿名请求返回 401、教师登录成功、真实响应精确包含数据库绝对路径，同时受目录限制的图片读取成功。

## 发生可能性

高。普通教师对具有扫描数据的考试和学生发起正常请求即可，复杂度低，默认拥有所需权限，界面自动使用该字段，验证也成功复现。文档中的代理可使其远程访问；实际入口、认证及已有扫描记录要求会限制适用范围。攻击向量为远程网络。

## 影响程度

低。披露绝对上传路径及生成文件名，并可能进一步进入日志；影响仅涉及主机布局，没有证明秘密泄露、任意内容读取、超出原成绩流程的额外学生数据、代码执行、完整性或可用性后果。固定目录及 basename 明确阻止将其升级为目录穿越或任意文件读取。

## 假设条件

- 生产环境遵循开启认证并通过 HTTPS 代理暴露回环服务的配置。
- 攻击者已控制拥有 exam:read 的教师账号，不声称学生或匿名身份能够提权。
- URL 是否被浏览器、代理或访问日志保留取决于配置。
- 考试有关联答题卡，且存在所选学生的扫描记录。

原文另列前提：

- 强制认证模式下存在有效教师会话。
- 默认教师拥有 exam:read。
- 已知或可发现数字考试 ID 和学生 ID。
- 考试关联答题卡。
- 该考试和学生具有 scan_records 记录。

## 控制措施

- 路由之前执行 optionalAuth。
- 强制认证开关可对考试 GET 要求认证及 exam:read。
- 默认绑定回环 5174 端口。
- 验证数字 ID，并检查考试、答题卡和学生是否存在。
- 识别文件名由服务端生成。
- 图片路由使用 basename，并固定上传目录。
- 图片响应使用 private 缓存策略。
- 扫描记录默认 30 天后过期。

## 盲点

- 没有清单证明某个具体 Nginx 公网部署，暴露取决于部署方式。
- 服务直接绑定 localhost，代码不使用示例中的 HOST 设置，远程访问依赖代理或隧道。
- 无关服务导入缺少 expr-eval，因此专项验证无法完整运行 createApp。
- 动态验证预置了绝对路径，没有执行原生 OCR；从 Multer 到数据库的路径由静态分析确认。
- 没有资料证明浏览器或代理实际保留该目标，日志持久化只是可能后果。
- 改分路由没有明显执行逐考试教师范围检查，但本报告不扩大声称存在成绩或图片 IDOR，仅限已证实的路径披露。

## 证据代码

文件名后的数字是该片段在报告所关联提交中的首行行号；不连续的片段分别列出。

### [src/apps/answer-card/client/components/ScoreFixPage.tsx:311](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/6d424a30da7e6480f2c1a421569e4e72bd73dd99/src/apps/answer-card/client/components/ScoreFixPage.tsx#L311)

~~~~tsx
                          <img
                            src={`/api/scanner/grading-image/${student.cardId}/${encodeURIComponent(s.fileName)}`}
                            alt={`第${s.pageNum}页`}
~~~~

### [src/apps/answer-card/server/index.ts:296](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/6d424a30da7e6480f2c1a421569e4e72bd73dd99/src/apps/answer-card/server/index.ts#L296)

~~~~typescript
        // Add scan record (actualPath = multer file path for reliable preview)
        examRepo.addScanRecord({
          batch_id: batchId,
          file_path: (row as any).actualPath || row.fileName,
          file_name: row.fileName,
~~~~

### [src/server/routes/score-editing.ts:87](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/6d424a30da7e6480f2c1a421569e4e72bd73dd99/src/server/routes/score-editing.ts#L87)

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

### [src/server/routes/score-editing.ts:189](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/6d424a30da7e6480f2c1a421569e4e72bd73dd99/src/server/routes/score-editing.ts#L189)

~~~~typescript
    scans: scans.map((s) => ({
      recordId: s.recordId,
      fileName: s.fileName,
      pageNum: s.pageNum,
    })),
~~~~
