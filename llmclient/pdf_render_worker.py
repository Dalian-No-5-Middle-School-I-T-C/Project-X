"""PDF 渲染子进程（安全 R16）。

**为什么是独立子进程而不是 `multiprocessing`：** sidecar 由
`python -m uvicorn llmclient.server:app` 启动，而 uvicorn 的 `__main__.py`
没有 `if __name__ == "__main__"` 保护。`multiprocessing` 的 spawn 启动方式会
重新导入父进程的 `__main__` 模块——那等于在子进程里再拉起一个 uvicorn 服务，
轻则端口冲突挂死，重则渲染请求永远不返回。所以这里用一次性 `subprocess`：
入口显式指向本模块的 `main()`，不继承父进程的 `__main__`。

协议（全部走 stdin/stdout，避免临时文件与路径泄漏）：
  输入：`{"pdf_b64": str, "params": {...}}`
  输出：`{"ok": true, "images": [{"mimeType","base64"}...]}`
        `{"ok": false, "kind": "page-limit"|"render-error", "message": str}`

错误消息只含数字与中文说明，**绝不含主机路径**；traceback 打到 stderr，
由 sidecar 日志吸收，不进响应体。
"""

from __future__ import annotations

import base64
import json
import sys

DEFAULT_PARAMS = {
    "long_edge": 2048,
    "jpeg_quality": 80,
    "max_dpi": 300,
    "min_dpi": 12,
    "max_pages": 40,
    "max_page_pixels": 16_000_000,
    "max_total_bytes": 32_000_000,
    "max_memory_mib": 2048,
    "cpu_seconds": 65,
}


def apply_limits(max_memory_mib: int, cpu_seconds: int) -> list[str]:
    """尽力收紧子进程资源；返回实际生效的项（写进 stderr 便于排障）。

    Windows 没有 `resource` 模块，此时只剩像素/字节预算与父进程墙钟超时兜底。
    """
    applied: list[str] = []
    try:
        import resource
    except ModuleNotFoundError:
        return applied

    targets = [
        ("RLIMIT_CPU", resource.RLIMIT_CPU, cpu_seconds, cpu_seconds + 5),
        ("RLIMIT_AS", resource.RLIMIT_AS, max_memory_mib * 1024 * 1024, max_memory_mib * 1024 * 1024),
        # 子进程不该再开新进程
        ("RLIMIT_NPROC", resource.RLIMIT_NPROC, 64, 64),
    ]
    for name, what, soft, hard in targets:
        try:
            cur_soft, cur_hard = resource.getrlimit(what)
            if cur_hard != resource.RLIM_INFINITY:
                hard = min(hard, cur_hard)
            if cur_soft != resource.RLIM_INFINITY:
                soft = min(soft, cur_soft)
            resource.setrlimit(what, (max(soft, 1), max(hard, soft, 1)))
            applied.append(name)
        except (ValueError, OSError):
            # 容器里常见：硬限制不允许下调。缺这道仍有墙钟超时兜底。
            continue
    return applied


def render(pdf_bytes: bytes, params: dict) -> list[dict[str, str]]:
    """解析并渲染 PDF 页图，越过预算即抛 ValueError（由 main() 收敛为响应）。"""
    import pymupdf

    long_edge = int(params["long_edge"])
    quality = int(params["jpeg_quality"])
    max_dpi = int(params["max_dpi"])
    min_dpi = int(params["min_dpi"])
    max_pages = int(params["max_pages"])
    max_page_pixels = int(params["max_page_pixels"])
    max_total_bytes = int(params["max_total_bytes"])

    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        if doc.needs_pass:
            raise ValueError("受密码保护的 PDF 无法用于 AI 分析")
        page_count = int(doc.page_count)
        if page_count > max_pages:
            raise PageLimit(f"PDF 共 {page_count} 页，超过多模态直传上限 {max_pages} 页")

        images: list[dict[str, str]] = []
        total_bytes = 0
        for index, page in enumerate(doc):
            rect = page.rect
            long_pt = max(float(rect.width), float(rect.height))
            if long_pt <= 0 or long_pt != long_pt:  # NaN / 负尺寸
                raise ValueError(f"第 {index + 1} 页尺寸非法，无法渲染")
            dpi = min(max_dpi, int(long_edge * 72 / long_pt))
            if dpi < min_dpi:
                # 大页面（海报/长图）继续降 DPI 会渲出看不清的字；先按像素预算拒绝，
                # 到 min_dpi 仍超预算说明这是一张「伪装的巨页」，直接失败。
                dpi = min_dpi
            scale = dpi / 72.0
            estimated_pixels = (float(rect.width) * scale) * (float(rect.height) * scale)
            if estimated_pixels > max_page_pixels:
                raise ValueError(
                    f"第 {index + 1} 页预计渲染 {int(estimated_pixels)} 像素，超过单页预算 {max_page_pixels}"
                )
            pix = page.get_pixmap(dpi=dpi)
            actual_pixels = int(pix.width) * int(pix.height)
            if actual_pixels > max_page_pixels:
                raise ValueError(
                    f"第 {index + 1} 页实际渲染 {actual_pixels} 像素，超过单页预算 {max_page_pixels}"
                )
            data = pix.tobytes("jpeg", jpg_quality=quality)
            total_bytes += len(data)
            if total_bytes > max_total_bytes:
                raise ValueError(f"页图累计 {total_bytes} 字节，超过预算 {max_total_bytes}")
            images.append({"mimeType": "image/jpeg", "base64": base64.b64encode(data).decode()})
        return images
    finally:
        doc.close()


class PageLimit(ValueError):
    """页数超限（与父模块同名语义，独立定义以避免反向依赖）。"""


def main() -> int:
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    except Exception:  # noqa: BLE001
        print(json.dumps({"ok": False, "kind": "render-error", "message": "渲染请求解析失败"}))
        return 0

    params = {**DEFAULT_PARAMS, **(payload.get("params") or {})}
    applied = apply_limits(int(params["max_memory_mib"]), int(params["cpu_seconds"]))
    if applied:
        print(f"[pdf-render] child limits applied: {', '.join(applied)}", file=sys.stderr, flush=True)

    try:
        pdf_bytes = base64.b64decode(payload.get("pdf_b64") or "")
    except Exception:  # noqa: BLE001
        print(json.dumps({"ok": False, "kind": "render-error", "message": "PDF 内容解码失败"}))
        return 0

    try:
        images = render(pdf_bytes, params)
        print(json.dumps({"ok": True, "images": images}))
        return 0
    except PageLimit as exc:
        print(json.dumps({"ok": False, "kind": "page-limit", "message": str(exc)}))
        return 0
    except ValueError as exc:
        print(json.dumps({"ok": False, "kind": "render-error", "message": str(exc)}))
        return 0
    except MemoryError:
        print(json.dumps({"ok": False, "kind": "render-error", "message": "PDF 渲染内存不足，请拆分原卷后重试"}))
        return 0
    except Exception:  # noqa: BLE001 - 解析器抛什么都有可能，一律收敛为渲染失败
        exc_type = sys.exc_info()[0]
        print(
            f"[pdf-render] parser crash: {getattr(exc_type, '__name__', 'Unknown')}",
            file=sys.stderr,
            flush=True,
        )
        print(json.dumps({"ok": False, "kind": "render-error", "message": "PDF 解析失败，文件可能已损坏或不受支持"}))
        return 0


if __name__ == "__main__":
    sys.exit(main())
