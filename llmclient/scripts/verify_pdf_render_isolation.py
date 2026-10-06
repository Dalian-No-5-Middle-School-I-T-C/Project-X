"""PDF 渲染进程隔离回归（安全 R16）。

只依赖标准库：`pymupdf` 缺失时相关用例会自动跳过，
但**父/子进程协议**的用例照跑——因为父进程本来就不该导入解析器。

运行：
    python llmclient/scripts/verify_pdf_render_isolation.py
（需要 sidecar 的那套 Python 环境；完整渲染用例还需 `pip install pymupdf`）
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from llmclient import pdf_to_images as pdfmod  # noqa: E402
from llmclient import pdf_render_worker as worker  # noqa: E402

try:
    import pymupdf  # noqa: F401

    HAS_PYMUPDF = True
except ModuleNotFoundError:
    HAS_PYMUPDF = False


class EnvTierTest(unittest.TestCase):
    """三档约定：默认 / 环境变量覆盖 / 非法回落 / 超天花板夹紧。"""

    def test_default_when_unset(self):
        self.assertEqual(pdfmod._env_bounded_int("PROJECTX_PDF_RENDER_TIMEOUT_SEC", 60, 5, 600), 60)

    def test_override(self):
        with mock.patch.dict(os.environ, {"X_TEST_PDF": "120"}):
            self.assertEqual(pdfmod._env_bounded_int("X_TEST_PDF", 60, 5, 600), 120)

    def test_invalid_falls_back(self):
        for raw in ("abc", "", "0", "-5", "  "):
            with mock.patch.dict(os.environ, {"X_TEST_PDF": raw}):
                self.assertEqual(pdfmod._env_bounded_int("X_TEST_PDF", 60, 5, 600), 60, raw)

    def test_clamped_to_ceiling(self):
        with mock.patch.dict(os.environ, {"X_TEST_PDF": "999999"}):
            self.assertEqual(pdfmod._env_bounded_int("X_TEST_PDF", 60, 5, 600), 600)


class ParentIsolationTest(unittest.TestCase):
    """父进程不得持有解析器：畸形 PDF 只能在子进程里被打开。"""

    def test_parent_module_does_not_import_pymupdf(self):
        code = (
            "import sys; import llmclient.pdf_to_images as m; "
            "print('LOADED' if 'pymupdf' in sys.modules else 'CLEAN')"
        )
        env = dict(os.environ)
        root = str(ROOT)
        env["PYTHONPATH"] = root if not env.get("PYTHONPATH") else os.pathsep.join([root, env["PYTHONPATH"]])
        completed = subprocess.run(
            [sys.executable, "-c", code], capture_output=True, text=True, cwd=root, env=env, timeout=60
        )
        self.assertIn("CLEAN", completed.stdout, completed.stderr)

    def test_no_shell_and_no_host_paths_in_messages(self):
        source = (ROOT / "llmclient" / "pdf_to_images.py").read_text(encoding="utf-8")
        self.assertIn("shell=False", source)
        self.assertNotIn("shell=True", source)


class ParentGuardsTest(unittest.TestCase):
    """越预算的输入必须在 spawn 之前就被拒掉。"""

    def test_empty_pdf_rejected_without_spawn(self):
        with mock.patch.object(pdfmod.subprocess, "run", side_effect=AssertionError("不应启动子进程")):
            with self.assertRaises(pdfmod.PdfRenderError):
                pdfmod.pdf_bytes_to_images(b"")

    def test_oversized_pdf_rejected_without_spawn(self):
        payload = b"%PDF-1.4" + b"x" * (pdfmod.PDF_MAX_TOTAL_IMAGE_BYTES + 1)
        with mock.patch.object(pdfmod.subprocess, "run", side_effect=AssertionError("不应启动子进程")):
            with self.assertRaises(pdfmod.PdfRenderError):
                pdfmod.pdf_bytes_to_images(payload)

    def test_zero_remaining_pages_is_page_limit(self):
        with mock.patch.object(pdfmod.subprocess, "run", side_effect=AssertionError("不应启动子进程")):
            with self.assertRaises(pdfmod.PdfPageLimitError):
                pdfmod.pdf_bytes_to_images(b"%PDF-1.4xx", max_pages=0)


class SubprocessProtocolTest(unittest.TestCase):
    """父进程对子进程各种结局的映射（这些分支无法靠真 PDF 触发）。"""

    def test_timeout_maps_to_timeout_error(self):
        expired = subprocess.TimeoutExpired(cmd=[sys.executable], timeout=pdfmod.PDF_RENDER_TIMEOUT_SEC)
        with mock.patch.object(pdfmod.subprocess, "run", side_effect=expired):
            with self.assertRaises(pdfmod.PdfRenderTimeoutError) as ctx:
                pdfmod.pdf_bytes_to_images(b"%PDF-1.4xx")
        self.assertIn(str(pdfmod.PDF_RENDER_TIMEOUT_SEC), str(ctx.exception))

    def test_killed_child_without_output_maps_to_render_error(self):
        done = subprocess.CompletedProcess(args=[sys.executable], returncode=-9, stdout=b"", stderr=b"")
        with mock.patch.object(pdfmod.subprocess, "run", return_value=done):
            with self.assertRaises(pdfmod.PdfRenderError) as ctx:
                pdfmod.pdf_bytes_to_images(b"%PDF-1.4xx")
        self.assertIn("-9", str(ctx.exception))

    def test_child_error_kind_maps_back(self):
        for kind, expected in (("page-limit", pdfmod.PdfPageLimitError), ("render-error", pdfmod.PdfRenderError)):
            body = json.dumps({"ok": False, "kind": kind, "message": "预算不够"}).encode()
            done = subprocess.CompletedProcess(args=[sys.executable], returncode=0, stdout=body, stderr=b"")
            with mock.patch.object(pdfmod.subprocess, "run", return_value=done):
                with self.assertRaises(expected):
                    pdfmod.pdf_bytes_to_images(b"%PDF-1.4xx")

    def test_garbage_pdf_end_to_end_is_render_error(self):
        # 真实起一个子进程：没有解析器 -> 导入失败；有解析器 -> 解析失败。两条路径都必须是
        # 受控的 PdfRenderError，而不是让异常冒到 HTTP 层变成 500。
        with self.assertRaises(pdfmod.PdfRenderError) as ctx:
            pdfmod.pdf_bytes_to_images(b"%PDF-1.4\nthis is not a pdf\n%%EOF")
        message = str(ctx.exception)
        self.assertNotIn("Traceback", message)
        # 不外泄主机路径：既不该有 Windows 盘符，也不该有多段 POSIX 路径
        self.assertNotIn("\\", message)
        self.assertLessEqual(message.count("/"), 1)

    def test_ok_protocol_returns_images(self):
        body = json.dumps(
            {"ok": True, "images": [{"mimeType": "image/jpeg", "base64": "AAA="}, {"nope": 1}]}
        ).encode()
        done = subprocess.CompletedProcess(args=[sys.executable], returncode=0, stdout=body, stderr=b"")
        with mock.patch.object(pdfmod.subprocess, "run", return_value=done):
            out = pdfmod.pdf_bytes_to_images(b"%PDF-1.4xx")
        self.assertEqual(out, [{"mimeType": "image/jpeg", "base64": "AAA="}])


class WorkerProtocolTest(unittest.TestCase):
    """子进程入口：任何输入都必须以 JSON 收口，且退出码为 0。"""

    def test_bad_json_via_real_subprocess(self):
        env = dict(os.environ)
        root = str(ROOT)
        env["PYTHONPATH"] = root if not env.get("PYTHONPATH") else os.pathsep.join([root, env["PYTHONPATH"]])
        completed = subprocess.run(
            [sys.executable, "-c", "import llmclient.pdf_render_worker as w; raise SystemExit(w.main())"],
            input=b"not json",
            capture_output=True,
            cwd=root,
            env=env,
            timeout=60,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr.decode("utf-8", "replace"))
        result = json.loads(completed.stdout.decode())
        self.assertFalse(result["ok"])

    def test_apply_limits_never_raises(self):
        self.assertIsInstance(worker.apply_limits(1024, 30), list)

    def test_page_limit_class_is_value_error(self):
        self.assertTrue(issubclass(worker.PageLimit, ValueError))
        self.assertTrue(issubclass(pdfmod.PdfRenderError, ValueError))


@unittest.skipUnless(HAS_PYMUPDF, "需要 pymupdf 才能跑真实渲染预算用例")
class RealRenderTest(unittest.TestCase):
    @staticmethod
    def make_pdf(pages: int = 1, width: float = 595, height: float = 842) -> bytes:
        doc = pymupdf.open()
        for index in range(pages):
            page = doc.new_page(width=width, height=height)
            page.insert_text((72, 72), f"page {index + 1}")
        data = doc.tobytes()
        doc.close()
        return data

    def test_single_page_renders_jpeg(self):
        images = pdfmod.pdf_bytes_to_images(self.make_pdf())
        self.assertEqual(len(images), 1)
        self.assertEqual(images[0]["mimeType"], "image/jpeg")
        raw = base64.b64decode(images[0]["base64"])
        self.assertTrue(raw.startswith(b"\xff\xd8"))

    def test_page_limit_still_reported(self):
        with self.assertRaises(pdfmod.PdfPageLimitError):
            pdfmod.pdf_bytes_to_images(self.make_pdf(3), max_pages=2)

    def test_giant_page_rejected_by_pixel_budget(self):
        # 一张 60000x60000 pt 的「伪装的巨页」：即使降到最低 DPI 也仍有上亿像素，
        # 以前会把渲染所在进程的内存打爆
        with self.assertRaises(pdfmod.PdfRenderError) as ctx:
            pdfmod.pdf_bytes_to_images(self.make_pdf(1, width=60000, height=60000))
        self.assertIn("像素", str(ctx.exception))

    def test_password_protected_pdf_rejected(self):
        doc = pymupdf.open()
        doc.new_page().insert_text((72, 72), "secret")
        data = doc.tobytes(
            encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw="user"
        )
        doc.close()
        with self.assertRaises(pdfmod.PdfRenderError) as ctx:
            pdfmod.pdf_bytes_to_images(data)
        self.assertIn("密码", str(ctx.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)
