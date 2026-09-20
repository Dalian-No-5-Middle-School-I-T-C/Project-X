# 36 打包systemd服务以root运行且数据权限公开

- 原标题：Packaged systemd service runs as root with public data modes
- 云端级别：低危（Low）
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/01e622650ec88191aa464fa5fcccd97d?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=&page=2)
- 关联提交：[e5f0253](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/e5f0253650c2fe4b2800fc00c965a06ab9910cfc)

- 页面时间：2026 年 6 月 27 日 17:33（原页面未注明时区）。
- 操作者：Toyama Kasumi。

## 概要

本次提交生成 project-x-server.service，并将其加入 Ubuntu 分发归档，由此引入了不安全的部署配置。利用需要操作者安装该服务单元，且没有另外覆盖用户或文件权限设置；这正是该单元默认、预期的系统级运行方式。

服务单元遗漏 User、Group、UMask 和文件系统加固设置，因此系统级 systemd 会以 root 身份及默认 0022 文件创建掩码运行它。在全新安装中，应用创建 /var/lib/project-x 及子目录时没有显式限制权限，SQLite 数据库和上传文件通常归 root 所有，但目录为全局可遍历的 0755，文件为全局可读的 0644。数据库包含学生、成绩、可复用初始密码和模型提供商密钥，答题卡目录包含试卷及答题图片，因此任意低权限本地账号都可能读取。处理网络和上传输入的 Node 进程以 root 运行，还会将未来的解析器或应用代码执行漏洞放大为宿主机 root 失陷。应配置专用 User／Group、UMask=0077，以及通过 StateDirectory 等机制建立的 0700 私有状态目录，并加入 NoNewPrivileges、ProtectSystem 等加固。

## 验证

1. 检查分发包是否包含不安全的系统服务单元，以及安装说明是否提供补偿控制。包中确实包含该单元，但生成的 README 只说明前台执行 ./start.sh，没有给出 systemd 安装指令。
2. 通过 systemd-analyze 和源码确认，缺少相关设置时会采用 root 身份及 0022 掩码，而应用创建状态文件时没有额外限制权限。
3. 专项复现表明，在现实条件下，无关的低权限 UID 可以遍历数据库和答题卡路径，并读取敏感文件。
4. 仓库及动态证据确认，其中包含学生身份、可复用初始密码、提供商密钥和上传资源；该提交没有启动时 chmod、ACL 或加密来防止这类泄露。
5. 利用前提限定为安装该单元且不作安全覆盖。root 身份运行只作为影响放大因素，不算作已经证明的独立远程代码执行。

### 验证输出结果

原页面提供验证输出入口；附件内容未包含在已归档的页面正文中。

## 证据注释

1. 服务单元将状态目录设在 /var/lib，以 Node 启动，没有 User、Group、UMask 或沙箱设置；系统服务因此默认采用 root 和 0022。
2. 不安全的服务单元被写入新增的 Ubuntu 分发包。
3. 状态目录下的答题卡、资源和布局子目录，也没有采用限制性权限模式。
4. 数据库父目录及数据库文件没有显式私有权限，而是继承文件创建掩码。
5. 数据库除了密码哈希还保存初始密码，加重了本地泄露影响。
6. 提供商密钥在同一数据库中直接保存和返回，是另一种被暴露的高价值秘密。

## 攻击路径分析

分别评估影响和可达性后，原来的中危被下调。成功的本地读取可以泄露整个实例的教育记录、初始密码、密钥和上传图片，因此影响为高。但它没有网络攻击向量，需要安装可选服务单元，并存在无关的低权限本地账号；README 反而只说明前台启动，也没有证据表明主机提供不可信 shell 用户，因此发生可能性为低。概念验证证明了现实前提成立时的权限配置及泄露，并非不可达或只影响攻击者本人。高影响乘以低发生可能性得到低危。不再适用其他排除，因为攻击者无需 root、运维或开发权限，也不必是记录所有者。

### 路径

以系统服务方式安装打包单元 → 缺少 User、Group、UMask → 以 root 和 0022 运行 → 初始化 SQLite 及答题卡状态 → 创建 /var/lib/project-x 时未显式限制权限 → 文件全局可读 → 低权限账号遍历 0755 目录并读取 0644 文件 → 直接读取文件或 SQLite，绕过应用认证 → 学校记录、凭据、密钥和图片泄露。

Ubuntu 打包生成器包含用于生产 Web 服务的 systemd 单元，从 /opt 启动 Node，将状态放在 /var/lib/project-x，却没有 User、Group、UMask、StateDirectory、NoNewPrivileges 或文件保护。没有覆盖设置时，进程以 root 运行；应用及每张答题卡的上传目录没有显式权限，普通 0022 掩码会产生 0755 目录和 0644 文件。应用认证和回环监听都不能保护直接文件读取。验证复现了 root 运行模式，并由无关的 nobody 账号读到学生初始密码、密钥和上传资源。最强反向证据是 README 只介绍前台启动，没有要求安装该单元，也没有确立不可信本地账号的存在。因此，条件成立后的泄密影响高，但仓库支持的发生可能性低，最终为低危，而非原来的中危。

## 发生可能性

低。服务单元真实随包分发；一旦启用，systemd 语义使利用直接可行，且已得到验证。但这不是网络攻击，需要独立的低权限本地账号、安装 README 未要求的可选单元、使用 SQLite 路径，并且没有安全覆盖或预先设置的私有目录。仓库没有证明学校主机通常向不可信人员提供本地账号，因此发生可能性低，但路径可达。

## 影响程度

高。攻击者可以广泛读取 SQLite 和答题卡状态，包括身份、成绩／排名、可复用的明文初始密码、明文提供商密钥及试卷／答题图片，造成实例级高机密性影响。没有证明低权限写入；由于不存在代码执行原语，也不将 root 进程失陷计入已证实影响。

## 假设条件

- 以系统服务方式安装并启用该单元，没有 User、Group、UMask 或 ACL 等覆盖设置。
- 使用单元配置的 SQLite 及固定状态路径。
- 目录在全新环境中创建，没有提前配置为私有。
- 宿主机存在能够进行普通文件读取的无关低权限账号。
- systemd 在缺少指令时采用正常的 root／0022 默认行为。

原文另列前提：

- 安装并激活该服务单元。
- 没有安全覆盖或预先建立的私有目录。
- 按配置路径使用 SQLite。
- 攻击者能够访问服务器上的低权限操作系统账号。

## 控制措施

- 服务单元设置 AUTH_ENFORCE=1，但直接文件读取会绕过应用认证。
- 绑定回环 5174 端口，减少直接网络暴露。
- 普通自主访问控制下，root 所有权阻止所测低权限账号修改文件；直接证明的只有泄露。
- 如果操作者刻意使用专用低权限账号、严格文件创建掩码和私有路径，README 中的前台启动方式可以安全运行。
- 服务单元没有 User、Group、UMask、StateDirectory、StateDirectoryMode、NoNewPrivileges、ProtectSystem 或等效加固设置。
- 没有发现补偿性的 chmod 或应用级 umask 设置。

## 盲点

- 没有账号配置或 SSH 政策，无法判断无关低权限用户是否普遍存在。
- 没有 Nginx 或隧道清单证明公开暴露，不过这不影响本地攻击向量。
- README 没有说明是否以及如何安装服务单元，因此实际采用率未知。
- 已有实例可能通过 ACL、安全覆盖、私有父目录或全局 DefaultUMask 阻止泄露。
- 动态验证模拟了与 systemd 等价的 UID 和 umask，没有在真实 PID 1 管理下启动。
- 没有建立独立的应用、上传或原生代码执行原语；宿主机 root 风险只是未计入评级的影响放大忧虑。

## 证据代码

文件名后的数字是该片段在报告所关联提交中的首行行号；不连续的片段分别列出。

### [scripts/package-server-ubuntu.cjs:157](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/e5f0253650c2fe4b2800fc00c965a06ab9910cfc/scripts/package-server-ubuntu.cjs#L157)

~~~~text
function createSystemdUnit() {
  return `[Unit]
Description=Project-X Web Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/project-x-server
Environment=PORT=5174
Environment=PROJECTX_AUTH_ENFORCE=1
Environment=PROJECTX_VARIANT=teacher
Environment=PROJECTX_ENABLE_SCANNER=0
Environment=PROJECTX_DB_PATH=/var/lib/project-x/projectx.db
Environment=ANSWER_CARD_DATA_DIR=/var/lib/project-x/answer-card
ExecStart=/usr/bin/node /opt/project-x-server/dist/server/index.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
~~~~

### [scripts/package-server-ubuntu.cjs:213](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/e5f0253650c2fe4b2800fc00c965a06ab9910cfc/scripts/package-server-ubuntu.cjs#L213)

~~~~text
writeTextFile(path.join(packageDir, "start.sh"), createStartScript());
writeTextFile(path.join(packageDir, "systemd", "project-x-server.service"), createSystemdUnit());
writeTextFile(path.join(packageDir, deployReadmeName), createDeployReadme());
~~~~

### [src/apps/answer-card/server/storage.ts:10](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/e5f0253650c2fe4b2800fc00c965a06ab9910cfc/src/apps/answer-card/server/storage.ts#L10)

~~~~typescript
export const rootDir = process.cwd();
export const dataDir = process.env.ANSWER_CARD_DATA_DIR
  ? path.resolve(process.env.ANSWER_CARD_DATA_DIR)
  : path.join(rootDir, "data", "answer-card");
export const cardsDir = path.join(dataDir, "cards");
export const assetsDir = path.join(dataDir, "assets");
export const layoutsDir = path.join(dataDir, "layouts");

export async function ensureDataDirs(): Promise<void> {
  await mkdir(cardsDir, { recursive: true });
  await mkdir(assetsDir, { recursive: true });
  await mkdir(layoutsDir, { recursive: true });
~~~~

### [src/server/db/index.ts:18](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/e5f0253650c2fe4b2800fc00c965a06ab9910cfc/src/server/db/index.ts#L18)

~~~~typescript
export function getDatabase(): Database.Database {
  if (!dbInstance) {
    const dbPath = resolveProjectDbPath();
    mkdirSync(path.dirname(dbPath), { recursive: true });
    dbInstance = new Database(dbPath);
    dbInstance.pragma("journal_mode = WAL");
    dbInstance.pragma("foreign_keys = ON");
    dbInstance.pragma("synchronous = NORMAL");
    dbInstance.pragma("busy_timeout = 5000");
~~~~

### [src/server/repositories/UserRepository.ts:49](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/e5f0253650c2fe4b2800fc00c965a06ab9910cfc/src/server/repositories/UserRepository.ts#L49)

~~~~typescript
  async createUser(params: CreateUserParams): Promise<UserRecord> {
    const passwordHash = await hashPassword(params.password);
    const result = await this.db.run(
      `INSERT INTO users (username, password_hash, name, role_id, student_number, subject, teacher_role, initial_password, email, phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params.username, passwordHash, params.name, params.role_id, params.student_number ?? null,
      params.subject ?? null, params.teacher_role ?? null, params.initial_password ?? null,
      params.email ?? null, params.phone ?? null
    );
~~~~

### [src/server/routes/ai-providers.ts:18](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/e5f0253650c2fe4b2800fc00c965a06ab9910cfc/src/server/routes/ai-providers.ts#L18)

~~~~typescript
router.get("/", (req: Request, res: Response) => {
  const db = getDatabase();
  const providers = db.prepare(`
    SELECT id, name, provider_type, base_url, api_key, models, is_active, sort_order
    FROM ai_providers
    WHERE user_id = ?
    ORDER BY sort_order, id
  `).all(req.user!.id) as any[];

  res.json(providers.map((p: any) => ({
    id: p.id,
    name: p.name,
    providerType: p.provider_type,
    baseUrl: p.base_url,
    apiKey: p.api_key,
    models: p.models ? JSON.parse(p.models) : null,
~~~~
