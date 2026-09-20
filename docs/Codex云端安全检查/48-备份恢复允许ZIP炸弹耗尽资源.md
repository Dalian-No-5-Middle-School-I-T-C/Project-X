# 48 备份恢复允许ZIP炸弹耗尽资源

- 原标题：Backup restore permits ZIP-bomb denial of service
- 云端级别：信息提示（Informational）
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/2b5e8a2504048191a433c2900e05df6b?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=&page=3)
- 关联提交：[c2a1745](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/c2a1745e7fc4593baaa746eb50d7e2a3d0646851)

- 页面时间：2026 年 6 月 17 日 22:53（原页面未注明时区）。
- 操作者：火箭。

## 概要

本次修改引入了存在问题的完整备份恢复功能。压缩上传大小限制不能约束解压输出，而新的提取辅助函数在验证备份结构之前就执行无界同步解压。

虽然路由要求仅管理员拥有的 user:manage 权限，备份文件仍是不可信输入。请求解析器只将压缩请求体限制为 512 MiB。extractZipFromBuffer 随后同步遍历所有条目，调用 entry.getData() 将每个条目的完整解压内容放入内存，再同步写入磁盘。单个或累计解压大小、压缩比、条目数量均没有限制。提取还发生在 metadata.json 和 projectx.db 验证之前，因此恶意归档不必是有效的 Project-X 备份。诱使管理员导入精心构造 ZIP 炸弹的攻击者，可以阻塞 Node 事件循环、耗尽堆或原生缓冲区内存、填满临时存储，并可能使服务终止。如果进程被杀死，正常清理不会执行，膨胀后的临时数据可能残留在磁盘上。恢复流程应在流式提取时采用保守的条目数、单条目及累计解压大小限制，拒绝可疑压缩比和不支持的条目类型，并避免同步分配完整条目的内存。

## 验证

1. 确定攻击者控制的 ZIP 是否可达及所需权限：通过真实账号菜单上传流程、已挂载 HTTP 路由、成功管理员登录和 user:manage 中间件确认。
2. 评估最近的资源控制：确认 512 MiB 解析限制只作用于压缩输入，ZIP 魔数及路径检查没有限制解压大小、压缩比或条目数。
3. 追踪验证顺序和危险操作：确认提取先于备份结构验证，并使用同步整条目 getData() 加 writeFileSync。
4. 通过生产接口复现资源放大和可用性影响：一个 261,030 字节的归档解压为 268,435,456 字节，并使并发请求延迟约 2.08 秒。
5. 验证清理行为并明确前提：无效备份的提前返回使全部解压数据残留在 /tmp；利用仍需要管理员交互或同等 user:manage 授权。

### 验证输出结果

原页面提供验证输出入口；附件内容未包含在已归档的页面正文中。

## 证据注释

1. 路由限制为管理员访问，但唯一资源限制只作用于压缩请求体，允许最大 512 MiB。
2. 完整请求在内存中接收；在验证元数据或必需数据库文件之前，归档已经全部解压。
3. 每个 ZIP 条目都通过 entry.getData() 同步解压并写入，没有条目数、解压大小、压缩比或累计输出限制。

## 攻击路径分析

原始中等级别反映了真实的 ZIP 炸弹条件，以及可能达到高等级的单服务可用性影响。按所要求矩阵，高影响与低发生可能性组合得到低严重性。随后单独执行的强制策略阶段将发现排除为 ignore，因为到达危险操作需要管理员或具有同等 user:manage 权限的主体执行受保护恢复操作，且该缺陷没有带来额外提权能力。仓库证据显示：src/server/routes/backup.ts:19–24 强制认证和授权；AccountMenu.tsx:168–192 仅向管理员展示界面入口；index.ts:1366–1380 默认绑定回环地址；也没有现实可行的低权限路径。受支持的代理部署可能扩大网络可达范围，但不会消除管理员授权及用户交互前提。

### 路径

精心构造的高膨胀 ZIP → 诱使特权用户选择归档 → 管理员导入界面 → 浏览器携带用户 Bearer 令牌原样发送文件 → 使用已认证 user:manage 会话 POST /api/db/restore → 通过 authMiddleware 及 user:manage 授权 → 512 MiB 压缩请求体限制和 PK 前缀检查 → 压缩大小及魔数检查无法约束膨胀 → AdmZip entry.getData() 加 writeFileSync 提取 → 同步解压并写入完整条目 → 共享 Node 事件循环、进程内存和临时文件系统 → 事件循环阻塞及内存或磁盘消耗影响服务 → Project-X 可用性下降或中断。

攻击情景：恶意方准备一个高度可压缩的 ZIP，诱使 Project-X 管理员将其作为备份导入。正常界面携带管理员令牌，将原始归档发送到 POST /api/db/restore。该路由属于挂载在 /api/db 的生产流程，但 authMiddleware 和 requirePermission(user:manage) 阻止未认证用户、学生和默认教师访问。一旦授权通过，系统只限制压缩请求为 512 MiB，并只检查 PK 前缀。提取发生在备份元数据验证之前，每个条目都同步展开成完整 Buffer，再同步写入，没有解压资源限制。提供的可执行验证将 261,030 字节归档展开为 268,435,456 字节，使并发请求延迟约 2.075 秒，并证明缺少元数据时的提前响应会留下解压目录。这确认了真实的可用性缺陷，但内存耗尽、进程终止及磁盘写满仍是推断，没有为复现而实际触发这些破坏性极限。最强反向证据对可报告性具有决定作用：端点受强管理员授权保护，界面仅供管理员使用，服务直接绑定回环地址，仓库也没有建立低权限路径或授权绕过。因此，该问题在技术上有效，存在于真实产品流程中，但按所要求的仅特权用户策略被排除。

## 发生可能性

低（Low）。归档格式容易构造，存在问题的解压行为也是确定性的，但正常访问需要有效 user:manage 会话及明确的特权恢复操作。服务默认绑定 localhost，没有仓库入口文件证明公开暴露；在所检查授权控制下，低权限攻击者不能直接调用路由。外部攻击者还需要依赖社会工程或预先攻陷管理员账号。

## 影响程度

高（High）。成功的资源放大可阻塞共享 Node 事件循环，消耗原生 Buffer 内存和临时存储，终止进程，或使单个 Project-X 服务不可用。验证直接证明了同步跨请求阻塞及持续残留的 256 MiB 临时输出；没有尝试终止进程或耗尽整个磁盘。没有证明机密性、完整性、代码执行或整个服务群层面的影响。

## 假设条件

- 所检查提交代表生产备份恢复实现。
- Node 进程与其他 Project-X 用户请求共享事件循环和临时文件系统。
- 没有尚未检查的反向代理或主机级资源配额阻止归档膨胀，也没有自动清除遗留恢复目录的机制。
- 非管理员攻击者需要将构造归档交给管理员，或先攻陷被授予 user:manage 的账号；仓库没有证明这种投递或账号失陷路径。

原文另列前提：

- 存在角色授予 user:manage 的有效已认证会话。
- 特权管理员或同等权限持有者必须提交或选择构造的 ZIP 进行数据库恢复。
- 对于外部攻击情景，攻击者必须说服特权用户导入归档，或已经控制特权账号。
- 在发生资源耗尽之前，主机必须具备足够内存或临时存储，以承载所选择的膨胀过程。

## 控制措施

- 整个备份路由组强制令牌认证。
- 服务端 user:manage 检查独立于可选的全局 API 身份解析器。
- React 界面仅向管理员提供导入控件。
- 压缩请求体上限为 512 MiB。
- 检查 Buffer 非空及 PK 前缀。
- 规范化路径并检查目标路径前缀包含关系。
- 成功恢复后或捕获异常时清理临时目录。
- 默认监听地址限制为 127.0.0.1:5174。
- 没有恢复专用限流、提取配额、压缩比限制或工作进程隔离。

## 盲点

- 没有找到具体部署的反向代理、隧道、负载均衡器、容器或主机资源限制清单，因此实际远程暴露和文件系统配额未知。
- 提供的验证有意没有导致内存耗尽、进程终止或文件系统写满；这些最大影响仍由无界提取行为推断。
- 没有测量堆及原生 Buffer 内存峰值。
- 仓库无法确定管理员导入不可信第三方备份的可能性。
- 自定义角色权限可能将 user:manage 授予非默认角色，但路由仍要求该特权权限。
- 工作区之外的主机清理任务、磁盘配额、进程监控器或反向代理请求限制，可能减少残留时间或中断时长。

## 证据代码

文件名后的数字是该片段在报告所关联提交中的首行行号；不连续的片段分别列出。

### [src/server/routes/backup.ts:19](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/c2a1745e7fc4593baaa746eb50d7e2a3d0646851/src/server/routes/backup.ts#L19)

~~~~typescript
// 管理员权限
router.use(authMiddleware);
router.use(requirePermission(PERMISSIONS.USER_MANAGE));

// 导入使用 raw body（避免 multpart/form-data 解析 corrupt ZIP 二进制数据）
const rawBodyParser = expressRaw({ type: "application/zip", limit: "512mb" });
~~~~

### [src/server/routes/backup.ts:164](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/c2a1745e7fc4593baaa746eb50d7e2a3d0646851/src/server/routes/backup.ts#L164)

~~~~typescript
router.post("/restore", rawBodyParser, async (req: Request, res: Response) => {
  const zipBuffer = req.body as Buffer;
  if (!zipBuffer || !Buffer.isBuffer(zipBuffer) || zipBuffer.length === 0) {
    res.status(400).json({ message: "请上传 .zip 备份文件（需以 application/zip Content-Type 发送）" });
    return;
  }

  // 快速校验 ZIP 魔数
  if (zipBuffer[0] !== 0x50 || zipBuffer[1] !== 0x4b) {
    res.status(400).json({ message: "上传的文件不是有效的 ZIP 格式（缺少 PK 文件头）" });
    return;
  }

  const tmpDir = path.join(os.tmpdir(), `projectx-restore-${crypto.randomUUID()}`);
  try {
    await mkdir(tmpDir, { recursive: true });

    // 使用 adm-zip 解压
    extractZipFromBuffer(zipBuffer, tmpDir);

    // 验证 metadata
    const metadataPath = path.join(tmpDir, "metadata.json");
    if (!existsSync(metadataPath)) {
      res.status(400).json({ message: "备份文件格式不正确，缺少 metadata.json" });
      return;
    }

    // 验证必须有 projectx.db
    const projectxBak = path.join(tmpDir, "projectx.db");
    if (!existsSync(projectxBak)) {
      res.status(400).json({ message: "备份文件中未找到 projectx.db" });
      return;
~~~~

### [src/server/routes/backup.ts:294](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/c2a1745e7fc4593baaa746eb50d7e2a3d0646851/src/server/routes/backup.ts#L294)

~~~~typescript
function extractZipFromBuffer(zipBuffer: Buffer, destDir: string): void {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  for (const entry of entries) {
    // 安全检查：防止路径穿越攻击
    const relativePath = path.normalize(entry.entryName).replace(/^[\\/]+/, "");
    const safePath = path.join(destDir, relativePath);
    if (!safePath.startsWith(path.resolve(destDir))) {
      continue;
    }
    if (entry.isDirectory) {
      mkdirSync(safePath, { recursive: true });
    } else {
      mkdirSync(path.dirname(safePath), { recursive: true });
      writeFileSync(safePath, entry.getData());
    }
~~~~
