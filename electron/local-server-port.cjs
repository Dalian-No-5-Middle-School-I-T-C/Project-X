// 内嵌服务端的端口选择。
//
// 端口就是页面的 origin，而订正草稿、崩溃恢复标记都存在 localStorage（按 origin 隔离）：
// 一旦回退到系统随机端口，上一次留在本机的草稿和「停在哪张卷」就全读不到，恢复会静默变成空白。
// 所以沿固定阶梯往下找空端口，让同一台机器每次落在同一个 origin；整段都被占才返回 0 交给系统分配。
// 探测用独立的 net server，避免 startServer 里 createApp 建好的数据库连接随失败次数堆积。
const net = require("node:net");

const PORT_LADDER_STEPS = 9;

function isPortFree(port, onUnavailable) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", (error) => {
      // 只报「不可用」会把 EACCES、EMFILE 这类原因一起吞掉，现场就查不到为什么整段阶梯都失败。
      if (typeof onUnavailable === "function") onUnavailable(error && error.code ? error.code : "unknown");
      resolve(false);
    });
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

/**
 * @param {number} preferredPort 首选端口（PROJECTX_ELECTRON_PORT 或 5174）
 * @param {(message: string) => void} [log] 落日志用的回调，探测失败时逐个端口报一次
 * @returns {Promise<number>} 可用端口；阶梯整段被占时返回 0（系统分配）
 */
async function pickLocalPort(preferredPort, log) {
  const report = typeof log === "function" ? log : () => {};
  for (let step = 0; step <= PORT_LADDER_STEPS; step += 1) {
    const port = preferredPort + step;
    if (await isPortFree(port, (code) => report(`Port ${port} is unavailable (${code}); trying the next candidate.`))) return port;
  }
  return 0;
}

module.exports = { PORT_LADDER_STEPS, isPortFree, pickLocalPort };
