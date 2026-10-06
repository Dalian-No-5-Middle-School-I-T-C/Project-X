/**
 * 安全（R28）：multipart 请求的「累计」预算。
 *
 * multer 的 `limits` 只有单文件尺寸（`fileSize`）与文件数量（`files`），两者相乘
 * 才是一次请求真正能占用的量：扫描切块曾经是 50 张 × 50 MiB = 2.5 GiB 全部进服务端内存，
 * 判分批量上传连文件数量都没有上限。把单文件上限压低会直接影响真实扫描（一页原卷就有
 * 几十 MiB），所以这里在请求层加一道「本次请求总字节」闸门：
 *
 *  - 有 `Content-Length` 时先做零成本预拒；
 *  - 分块传输时按实际收到的字节累计，超限立即中断请求（413）并丢弃剩余正文。
 *
 * 统计的是整个请求体（含 multipart 边界开销），因此它是「文件字节之和」的保守上界。
 * 计数器挂在 req 的 `data` 事件上：busboy 已经在消费同一个流，这里只是旁路观测，
 * 不接管、不改变存储引擎的行为。
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";

export interface UploadBudgetOptions {
  /** 本次请求体的字节上限（含 multipart 开销） */
  maxTotalBytes: number;
  /** 用于错误提示的场景名，例如「扫描切块上传」 */
  label?: string;
}

export const UPLOAD_BUDGET_EXCEEDED = Symbol.for("projectx.uploadBudgetExceeded");

type BudgetedRequest = Request & { [UPLOAD_BUDGET_EXCEEDED]?: boolean };

export function formatMebibytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024 / 1024))} MiB`;
}

function reject(req: BudgetedRequest, res: Response, label: string, maxTotalBytes: number): void {
  if (req[UPLOAD_BUDGET_EXCEEDED]) return;
  req[UPLOAD_BUDGET_EXCEEDED] = true;
  if (res.headersSent) {
    req.destroy();
    return;
  }
  res.status(413).json({
    code: "UPLOAD_BUDGET_EXCEEDED",
    message: `${label}单次请求累计 ${formatMebibytes(maxTotalBytes)} 上限已超出，请减少单次上传数量或分辨率`,
  });
  // 先把 413 交付出去再断开：立即 req.destroy() 会连响应一起丢掉，扫描端只会看到网络错误
  // 并按「可重试」无限重传。响应写完即断开，剩余正文不再接收。
  res.once("finish", () => req.destroy());
}

/**
 * 这次请求是否**已经给出过答复**。
 *
 * 预算是在正文还没收完时就回 413 的，而 multer 已经在消费同一个流：`req.destroy()` 会让它
 * 随后抛出 `LIMIT_FILE_SIZE`/断流错误，路由里的手写错误回调于是晚了半步。这时再
 * `res.status(400).json(...)` 就是对一个已结束的响应二次写入（`ERR_HTTP_HEADERS_SENT`），
 * 轻则把 413 改成客户端看不懂的 400，重则未捕获异常。
 *
 * 判据以预算位为准、`res` 的状态为辅：符号位是「本次拒绝」的事实本身，不依赖 Node 内部标志
 * 在断开后是否还可靠；`headersSent / writableEnded / destroyed` 覆盖其它已答复路径。
 * 注意只用于**跳过响应**——临时文件的回收必须在调用它之前做完。
 */
export function isUploadAlreadyRejected(rawReq: Request, res: Response): boolean {
  return (rawReq as BudgetedRequest)[UPLOAD_BUDGET_EXCEEDED] === true
    || res.headersSent || res.writableEnded || res.destroyed;
}

/**
 * 请求级上传预算中间件；挂在对应的 multer 处理之前。
 * 超限时请求被销毁，multer 会抛出断流错误，但响应已经给出 413，
 * 全局错误处理不再覆盖它（见 `index.ts` 的 headersSent 兜底）。
 */
export function requestUploadBudget(options: UploadBudgetOptions): RequestHandler {
  const maxTotalBytes = options.maxTotalBytes;
  const label = options.label ?? "本次上传";
  return (rawReq: Request, res: Response, next: NextFunction): void => {
    const req = rawReq as BudgetedRequest;
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > maxTotalBytes) {
      reject(req, res, label, maxTotalBytes);
      return;
    }
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxTotalBytes) reject(req, res, label, maxTotalBytes);
    });
    next();
  };
}
