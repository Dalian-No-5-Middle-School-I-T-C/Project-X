# 35 取消扫描的兜底可能终止被复用的Windows进程号

- 原标题：Cancel fallback can kill a reused Windows PID
- 云端级别：低危（Low）
- 原始报告：[打开报告](https://chatgpt.com/codex/cloud/security/findings/667d3d6cc8d881918e602edbaa4f3e17?repo=https%3A%2F%2Fgithub.com%2FDalian-No-5-Middle-School-I-T-C%2FProject-X&sev=&page=2)
- 关联提交：[f9ecba6](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/commit/f9ecba6caf39f98a651b1bfd765214c6deb876e3)

- 页面时间：2026 年 8 月 9 日 18:38（原页面未注明时区）。
- 操作者：火箭。

## 概要

本次修改新增取消端点及 taskkill 兜底机制。最初的存活检查同时检查 exitCode 和 signalCode，这一做法正确；但延后的检查遗漏 signalCode，也没有保留可取消的定时器句柄，形成与进程号复用有关的检查和使用时差问题。

cancelScan 先调用 child.kill，然后无条件保留一个只关联数字进程号的两秒看门狗。它只检查 exitCode===null，不检查 signalCode。Node 子进程被信号终止时，exitCode 通常仍为 null，signalCode 已有值，即使 close 事件发生后也是如此。因此，原进程退出后仍可能调用 taskkill /F /T。close 不取消定时器，两秒内 Windows 可能将该进程号分配给另一个进程，导致服务账号有权终止的无关进程树被杀死。启用原生扫描时，扫描端密钥或拥有 GRADE_WRITE 的用户可以触达这条路径；反复启动和取消会增加进程更替及附带终止的机会。应在 close 时取消兜底，至少同时要求两个退出字段为 null，最好进一步验证进程身份。

## 验证

1. 在文档中的原生扫描和授权条件下，调用方可以控制活动扫描的取消，并到达 cancelScan。
2. 子进程可以因取消信号触发 close，但在两秒到期前 exitCode 仍为 null。
3. 未被取消的生产看门狗在原子进程 close 之后仍调用 taskkill。
4. 强制终止只使用捕获的数字进程号，不验证 signalCode、活动子进程记录或进程身份。
5. 实际 Windows 进程号碰撞及附带终止无法在 Linux 验证机上执行，因此未复现。

### 验证输出结果

原页面提供验证输出入口；附件内容未包含在已归档的页面正文中。

## 证据注释

1. 新增已认证 HTTP 端点对非终态会话调用取消操作，使路径可达。
2. 发送信号后，只根据 exitCode 延后执行 taskkill；信号退出可能使该字段保持 null，留下使用过时进程号终止进程的风险。
3. error 和 close 会删除注册项，却不取消两秒看门狗。

## 攻击路径分析

有证据支持的效果是有限的同机可用性损失，没有已证明的数据、身份或判分完整性影响，因此影响低。过时定时器已被证明，但附带伤害需要短暂的 Windows 进程号复用竞争、启用扫描及有效授权，因此发生可能性低。矩阵中，低影响与任何非 ignore 可能性组合均为低危。不予排除：影响不限于本人，也不是仅操作者、开发者或本地正确性问题；扫描和判分身份获准取消扫描桥，不等于获准终止无关宿主机进程，这构成受支持生产流程中的有限权限差异。回环监听、Web 默认关闭 TWAIN、默认认证、状态检查及未证明最终碰撞，使其保持低危，而不是不可报告。

### 路径

持有 scanner／full 密钥或 GRADE_WRITE 权限 → TWAIN 开启时通过正常扫描创建活动会话 → 取得非终态会话 ID 并调用取消 → child.kill 加两秒看门狗 → 原子进程因信号退出 → exitCode 为 null，signalCode 有值 → close 后定时器只保留进程号 → Windows 可能复用该号码 → 仅检查 exitCode 的条件通过 → taskkill /F /T /PID 针对当前号码持有者 → 以服务账号权限强制递归终止 → 可能杀死无关的同机进程树。

攻击过程：持有密钥或写入权限的用户启动原生扫描，并在扫描桥活动时取消。kill 之后两秒会执行 taskkill；信号退出后 exitCode 可能仍为 null，但代码只检查这个字段。close／error 会移除 activeScans 中的记录，却不取消定时器。执行框架调用生产函数，观察到取消约 105 毫秒后原子进程触发 close，两秒后又向已不存在的进程号派发 taskkill。如果 Windows 已复用该号码，服务账号就可能杀死替代进程树。最强反向证据是 Web 默认禁用 TWAIN、Electron 在回环环境启用、默认认证，以及实际伤害仍需要尚未证明的短时碰撞。既有测试覆盖注册前取消，没有覆盖活动子进程看门狗，因此测试通过不能否定该问题。不涉及秘密数据流，安全效果限于宿主机可用性。

## 发生可能性

低。过时命令派发可直接复现，已授权客户端也可以正常启动和取消。但最终影响需要 Windows、明确启用原生扫描、活动扫描桥、有效授权、信号退出，以及约两秒内的进程号复用。回环监听及 Web 默认关闭扫描进一步限制范围；重复进程更替可能增加机会，却不能保证碰撞。

## 影响程度

低。可能终止服务账号有权杀死的一个无关同机进程树，越过仅取消扫描桥的权限边界。有依据支持的后果是可用性，而非泄露、成绩修改、身份影响或整个设备群失陷。攻击者不能确定性选择替代进程，验证也没有实际造成附带进程终止。

## 假设条件

- Windows 环境执行 taskkill。
- PROJECTX_ENABLE_SCANNER=1／true，或 PROJECTX_VARIANT=teacher-scanner。
- 调用方持有 scanner／full 密钥或 GRADE_WRITE；另一种情形是运维显式关闭认证。
- 扫描桥已注册到 activeScans，取消时仍存活。
- kill 后原进程退出，进程号在两秒到期前被重新分配。
- 远程访问需要代理或隧道等入口；仓库没有证明启用扫描的部署具备这类入口。

原文另列前提：

- 使用 Windows 宿主机。
- 启用原生 TWAIN。
- 默认强制认证下，持有有效密钥或写入权限。
- 非终态会话存在活动扫描桥。
- 原进程在两秒到期前因信号退出。
- 剩余窗口内进程号被复用。
- 替代进程属于运行服务的操作系统账号有权终止的对象。

## 控制措施

- Web 原生路由具有功能开关，默认关闭。
- 绑定回环地址，远程访问需要另设入口。
- 默认启用认证。
- 强制认证时要求密钥或 GRADE_WRITE。
- 会话必须存在，且不是完成、错误或取消状态。
- cancelScan 最初同时检查 exitCode 和 signalCode，拒绝缺失或已终止的进程。
- 两秒兜底限制了进程号复用窗口。
- taskkill 不通过 shell，使用固定的进程号参数，防止命令注入。
- 没有一般限流来限制反复启动和停止。
- close／error 会移除状态，但不取消强制终止定时器，也不重新验证其目标。

## 盲点

- Linux 环境没有执行真实 Windows taskkill 或进程号复用。
- 不知道扫描部署实际使用的代理、隧道或局域网入口。
- 没有确定现实工作负载下的进程号分配和复用频率。
- Windows 服务账号身份及权限等级未知。
- 框架通过插桩 taskkill 证明 close 后仍派发过时命令，没有证明杀死替代进程。
- 没有清单确定外部操作系统隔离、恢复措施或端点限流。

## 证据代码

文件名后的数字是该片段在报告所关联提交中的首行行号；不连续的片段分别列出。

### [src/apps/answer-card/server/scanner/index.ts:157](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/f9ecba6caf39f98a651b1bfd765214c6deb876e3/src/apps/answer-card/server/scanner/index.ts#L157)

~~~~typescript
    router.post("/scan/:sessionId/cancel", async (req, res, next) => {
      try {
        const id = safeId(req.params.sessionId);
        const session = await getSession(id);
        if (!session) {
          res.status(404).json({ message: "扫描会话不存在" });
          return;
        }
        if (session.status === "completed" || session.status === "error" || session.status === "cancelled") {
          res.json({ message: "扫描已结束，无需取消", status: session.status });
          return;
        }

        const terminated = cancelScan(id);
        await updateSessionStatus(id, "cancelled", "用户取消扫描");
        emitProgress(id, { sessionId: id, type: "cancelled", message: "扫描已取消" });
~~~~

### [src/apps/answer-card/server/scanner/twain-bridge.ts:17](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/f9ecba6caf39f98a651b1bfd765214c6deb876e3/src/apps/answer-card/server/scanner/twain-bridge.ts#L17)

~~~~typescript
export function cancelScan(sessionId: string): boolean {
  cancelRequested.add(sessionId);

  const child = activeScans.get(sessionId);
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return false; // 子进程尚未注册或已退出，交由 runBridge 的取消检查拦截
  }

  child.kill(); // Windows 下 SIGTERM → TerminateProcess

  const pid = child.pid;
  setTimeout(() => {
    if (child.exitCode === null && pid) {
      execFile("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true }, () => {
        // 强杀结果不阻塞调用方；失败时进程也会被 10 分钟超时兜底
      });
    }
  }, 2000).unref();
  return true;
~~~~

### [src/apps/answer-card/server/scanner/twain-bridge.ts:102](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/blob/f9ecba6caf39f98a651b1bfd765214c6deb876e3/src/apps/answer-card/server/scanner/twain-bridge.ts#L102)

~~~~typescript
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (sessionId) {
        activeScans.delete(sessionId);
      }
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (sessionId) {
        activeScans.delete(sessionId);
      }
~~~~
