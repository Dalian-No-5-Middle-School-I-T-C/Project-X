"""PDF 原卷 -> 压缩页图（多模态直传前处理）。

OpenAI 兼容的多模态接口只接受 webp/png/jpeg/gif 图片，
整份 PDF 以 data URL 直传会被拒绝（实测 deepseek-v4-flash-vision-exp 返回 400）。
因此多模态直传前把 PDF 页渲染成 JPEG（长边 <= 2048，质量 80），
与 Web 端图片上传的压缩策略保持一致。

进程资源隔离（安全 R16）
------------------------
PyMuPDF 解析的是**教师从外部拿到的任意 PDF**（扫描件、别人转出的试卷），
它和 sidecar 跑在同一进程时，一个畸形 PDF 就能把整个 AI 服务带走：

 * 解析死循环 / 字体子集递归 -> 请求永不返回；
 * 「解压炸弹」式页面（1x1pt 页面声明 20000x20000 裁剪框）-> 单页 pixmap 就是几 GB；
 * 40 页 × 大图 -> 渲染结果同时驻留内存。

所以解析与渲染都放进**一次性子进程**（`llmclient.pdf_render_worker`）：
父进程只给一个墙钟预算，超时即 kill；子进程在 POSIX 上再叠
地址空间 / CPU / 进程数上限（Windows 无 setrlimit，改用
「逐页像素预算 + 累计字节预算 + 超时」三道代替）。

**刻意不用 `multiprocessing`**：sidecar 由 `python -m uvicorn llmclient.server:app`
启动，而 uvicorn 的 `__main__.py` 没有主入口保护；spawn 会重新导入它，
等于在子进程里再拉起一个服务。用 `subprocess` 显式指定入口就不踩这个坑。

所有预算沿用 JS 侧的三档约定：默认值 + ``PROJECTX_PDF_*`` 环境变量 + 安全天花板，
非法值回落默认、超天花板夹紧，且启动时打印实际生效档位。
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
from pathlib import Path

MAX_AI_PAGES = 40
LONG_EDGE = 2048
JPEG_QUALITY = 80
MAX_DPI = 300
MIN_DPI = 12


def _env_bounded_int(name: str, default: int, minimum: int, ceiling: int) -> int:
    """默认 + 环境变量 + 天花板：非法值回落默认，超天花板夹紧（不抛错）。"""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(float(raw))
    except (TypeError, ValueError):
        return default
    if value < minimum:
        return default
    return min(value, ceiling)


# 渲染墙钟预算：一份 40 页扫描件在普通笔记本上约 10~20 秒，60 秒已经宽松
PDF_RENDER_TIMEOUT_SEC = _env_bounded_int("PROJECTX_PDF_RENDER_TIMEOUT_SEC", 60, 5, 600)
# 单页像素上限：长边 2048 的页图约 4.4M 像素，留 4 倍余量给高 DPI 中间态
PDF_MAX_PAGE_PIXELS = _env_bounded_int("PROJECTX_PDF_MAX_PAGE_PIXELS", 16_000_000, 1_000_000, 64_000_000)
# 全部页图（base64 前）累计字节上限：8MiB 已经远超一次多模态请求的合理体积
PDF_MAX_TOTAL_IMAGE_BYTES = _env_bounded_int("PROJECTX_PDF_MAX_TOTAL_BYTES", 32_000_000, 1_000_000, 256_000_000)
# 子进程地址空间上限（仅 POSIX 生效；Windows 走上面的像素/字节预算）
PDF_MAX_CHILD_MEMORY_MIB = _env_bounded_int("PROJECTX_PDF_MAX_CHILD_MEMORY_MIB", 2048, 256, 16384)


def describe_pdf_render_limits() -> str:
    return (
        f"timeout={PDF_RENDER_TIMEOUT_SEC}s pagePixels={PDF_MAX_PAGE_PIXELS} "
        f"totalBytes={PDF_MAX_TOTAL_IMAGE_BYTES} childMemoryMiB={PDF_MAX_CHILD_MEMORY_MIB}"
    )


class PdfPageLimitError(ValueError):
    """PDF 页数超过多模态直传上限。"""


class PdfRenderError(ValueError):
    """PDF 渲染失败（超时、崩溃或越过资源预算）。

    继承 ``ValueError``：既有调用方（含 HTTP 层）已经按「输入类错误」处理
    ``PdfPageLimitError``，渲染预算越界同属这一类，不该冒成 500。
    消息面向调用方，**不含主机路径**；细节留在 sidecar 日志里。
    """


class PdfRenderTimeoutError(PdfRenderError):
    """渲染超过墙钟预算，子进程已被终止。"""


def _repo_root() -> str:
    """`llmclient/` 的父目录：子进程要靠它 `import llmclient.*`。"""
    return str(Path(__file__).resolve().parent.parent)


def _subprocess_env() -> dict[str, str]:
    env = dict(os.environ)
    root = _repo_root()
    existing = env.get("PYTHONPATH") or ""
    env["PYTHONPATH"] = root if not existing else os.pathsep.join([root, existing])
    return env


def _render_params(max_pages: int) -> dict[str, int]:
    return {
        "long_edge": LONG_EDGE,
        "jpeg_quality": JPEG_QUALITY,
        "max_dpi": MAX_DPI,
        "min_dpi": MIN_DPI,
        "max_pages": max_pages,
        "max_page_pixels": PDF_MAX_PAGE_PIXELS,
        "max_total_bytes": PDF_MAX_TOTAL_IMAGE_BYTES,
        "max_memory_mib": PDF_MAX_CHILD_MEMORY_MIB,
        # CPU 上限比墙钟略宽，避免正常长任务先被 SIGXCPU 掐断
        "cpu_seconds": PDF_RENDER_TIMEOUT_SEC + 5,
    }


def _run_render_subprocess(pdf_bytes: bytes, max_pages: int) -> list[dict[str, str]]:
    payload = json.dumps(
        {"pdf_b64": base64.b64encode(pdf_bytes).decode(), "params": _render_params(max_pages)}
    ).encode("utf-8")
    try:
        completed = subprocess.run(  # noqa: S603 - 解释器自身、参数固定、无 shell
            [
                sys.executable,
                "-c",
                "import llmclient.pdf_render_worker as w; raise SystemExit(w.main())",
            ],
            input=payload,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=PDF_RENDER_TIMEOUT_SEC,
            env=_subprocess_env(),
            shell=False,
            cwd=_repo_root(),
        )
    except subprocess.TimeoutExpired as exc:
        # subprocess.run 超时已经 kill 子进程；这里只把错误类型换成本模块语义
        stderr = (exc.stderr or b"").decode("utf-8", "replace").strip()
        if stderr:
            print(f"[pdf-render] killed after {PDF_RENDER_TIMEOUT_SEC}s: {stderr[:500]}", flush=True)
        raise PdfRenderTimeoutError(
            f"PDF 渲染超过 {PDF_RENDER_TIMEOUT_SEC} 秒，已终止渲染进程"
        ) from exc
    except OSError as exc:
        raise PdfRenderError("无法启动 PDF 渲染进程，请检查 sidecar 的 Python 运行环境") from exc

    stderr = (completed.stderr or b"").decode("utf-8", "replace").strip()
    if stderr:
        # 子进程诊断（rlimit 生效项、崩溃类型）进 sidecar 日志，不外传给前端
        print(f"[pdf-render] {stderr[:500]}", flush=True)

    stdout = (completed.stdout or b"").decode("utf-8", "replace").strip()
    if not stdout:
        # 被 rlimit / OOM killer 直接结束时拿不到协议输出
        raise PdfRenderError(
            f"PDF 渲染进程异常退出（exitcode={completed.returncode}），可能是文件畸形或越过内存上限"
        )
    try:
        result = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise PdfRenderError("PDF 渲染结果解析失败") from exc
    if not isinstance(result, dict):
        raise PdfRenderError("PDF 渲染结果格式异常")

    if result.get("ok"):
        images = result.get("images")
        if not isinstance(images, list):
            raise PdfRenderError("PDF 渲染结果格式异常")
        return [item for item in images if isinstance(item, dict) and item.get("base64")]

    message = str(result.get("message") or "PDF 渲染失败")
    if result.get("kind") == "page-limit":
        raise PdfPageLimitError(message)
    raise PdfRenderError(message)


def pdf_bytes_to_images(pdf_bytes: bytes, max_pages: int = MAX_AI_PAGES) -> list[dict[str, str]]:
    """把一份 PDF 渲染成压缩 JPEG 页图（base64），每页长边 <= 2048。

    渲染在带资源预算的子进程内完成；失败时抛 ``PdfRenderError`` / ``PdfRenderTimeoutError``，
    页数超限仍抛 ``PdfPageLimitError``（调用方按 4xx 处理）。
    """
    if not pdf_bytes:
        raise PdfRenderError("PDF 内容为空")
    if max_pages < 1:
        raise PdfPageLimitError("多模态直传的剩余页数已用尽")
    # 输入体积也设一道：base64 解码后的 PDF 本身不该是几百 MB
    max_input = PDF_MAX_TOTAL_IMAGE_BYTES
    if len(pdf_bytes) > max_input:
        raise PdfRenderError(f"PDF 体积 {len(pdf_bytes)} 字节超过预算 {max_input}")
    return _run_render_subprocess(pdf_bytes, max_pages)


def normalize_direct_files(files: list[dict[str, str]], max_pages: int = MAX_AI_PAGES) -> list[dict[str, str]]:
    """直传前归一化：PDF 转压缩页图，图片原样保留。"""
    out: list[dict[str, str]] = []
    pdf_pages_used = 0
    for f in files:
        mime = (f.get("mimeType") or "").lower()
        if mime == "application/pdf":
            page_images = pdf_bytes_to_images(
                base64.b64decode(f["base64"]),
                max_pages=max_pages - pdf_pages_used,
            )
            out.extend(page_images)
            pdf_pages_used += len(page_images)
        else:
            out.append(f)
    return out
