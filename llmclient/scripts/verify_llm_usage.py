from __future__ import annotations

import base64
import sys
import unittest
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from llmclient.config import configured_models, find_model
from llmclient.prompts.knowledge_points import build_knowledge_points_prompt
from llmclient.schemas import AnalysisRunResponse, TokenUsage, empty_report
from llmclient.usage import gemini_usage, merge_usage, openai_usage, usage_dict


class _Usage:
    def __init__(self, prompt_tokens=None, completion_tokens=None):
        self.prompt_tokens = prompt_tokens
        self.completion_tokens = completion_tokens


class _OpenAiResponse:
    def __init__(self, usage=None):
        self.usage = usage


class _UsageMetadata:
    def __init__(self, prompt_token_count=None, candidates_token_count=None):
        self.prompt_token_count = prompt_token_count
        self.candidates_token_count = candidates_token_count


class _GeminiResponse:
    def __init__(self, usage_metadata=None):
        self.usage_metadata = usage_metadata


class ModelCatalogVisionTest(unittest.TestCase):
    def test_deepseek_vision_exp_model_in_catalog_with_vision_flag(self):
        model = find_model("deepseek-v4-flash-vision-exp")
        self.assertIsNotNone(model)
        self.assertEqual(model.provider, "deepseek")
        self.assertTrue(model.vision)

    def test_deepseek_text_models_have_no_vision_flag(self):
        self.assertFalse(find_model("deepseek-v4-flash").vision)
        self.assertFalse(find_model("deepseek-v4-pro").vision)

    def test_configured_models_expose_vision_capability(self):
        by_id = {m["id"]: m for m in configured_models()}
        self.assertTrue(by_id["deepseek-v4-flash-vision-exp"]["vision"])
        self.assertFalse(by_id["deepseek-v4-flash"]["vision"])


class OpenAiUsageTest(unittest.TestCase):
    def test_extracts_prompt_and_completion_tokens(self):
        usage = _Usage(prompt_tokens=12, completion_tokens=34)
        self.assertEqual(openai_usage(_OpenAiResponse(usage)), (12, 34))

    def test_missing_usage_returns_none(self):
        self.assertIsNone(openai_usage(_OpenAiResponse()))


class GeminiUsageTest(unittest.TestCase):
    def test_extracts_prompt_and_candidate_tokens(self):
        meta = _UsageMetadata(prompt_token_count=100, candidates_token_count=40)
        self.assertEqual(gemini_usage(_GeminiResponse(meta)), (100, 40))

    def test_missing_usage_metadata_returns_none(self):
        self.assertIsNone(gemini_usage(_GeminiResponse()))


class MergeUsageTest(unittest.TestCase):
    def test_sums_present_usage_and_ignores_none(self):
        self.assertEqual(merge_usage((1, 2), None, (3, 4)), (4, 6))

    def test_all_none_returns_none(self):
        self.assertIsNone(merge_usage(None, None))


class UsageDictTest(unittest.TestCase):
    def test_shapes_camel_case_payload(self):
        self.assertEqual(usage_dict((7, 8)), {"tokensIn": 7, "tokensOut": 8})

    def test_none_passthrough(self):
        self.assertIsNone(usage_dict(None))


class AnalysisRunResponseUsageTest(unittest.TestCase):
    def test_response_accepts_usage(self):
        resp = AnalysisRunResponse(
            generatedAt="2026-08-30T00:00:00Z",
            model="deepseek-v4-flash-vision-exp",
            report=empty_report("ok"),
            toolCalls=[],
            usage=TokenUsage(tokensIn=7, tokensOut=8),
        )
        self.assertEqual(resp.usage.tokensIn, 7)
        self.assertEqual(resp.usage.tokensOut, 8)


class KnowledgePointsPromptContextTest(unittest.TestCase):
    def test_build_prompt_includes_answer_card_json(self):
        prompt = build_knowledge_points_prompt(
            "全部",
            "",
            answer_card_json='{"objectiveQuestions":[{"questionNumber":1,"answerKey":["A"]}]}',
        )
        self.assertIn("答题卡客观题结构", prompt)
        self.assertIn('"questionNumber"', prompt)

    def test_build_prompt_omits_section_when_empty(self):
        prompt = build_knowledge_points_prompt("全部", "")
        self.assertNotIn("答题卡客观题结构", prompt)


class PdfToImagesTest(unittest.TestCase):
    @staticmethod
    def make_pdf(pages: int = 1) -> bytes:
        doc = pymupdf.open()
        for i in range(pages):
            page = doc.new_page()
            page.insert_text((72, 72), f"page {i + 1} test")
        return doc.tobytes()

    def test_pdf_converted_to_compressed_jpeg_within_2048(self):
        from llmclient.pdf_to_images import normalize_direct_files

        pdf_b64 = base64.b64encode(self.make_pdf()).decode()
        out = normalize_direct_files([{"mimeType": "application/pdf", "base64": pdf_b64}])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["mimeType"], "image/jpeg")
        img = base64.b64decode(out[0]["base64"])
        self.assertTrue(img.startswith(b"\xff\xd8"))
        doc = pymupdf.open(stream=img, filetype="jpeg")
        self.assertLessEqual(max(doc[0].rect.width, doc[0].rect.height), 2048.0)

    def test_mixed_files_keep_images_unchanged(self):
        from llmclient.pdf_to_images import normalize_direct_files

        img_b64 = base64.b64encode(b"\xff\xd8\xff\xe0fakejpeg").decode()
        pdf_b64 = base64.b64encode(self.make_pdf()).decode()
        out = normalize_direct_files(
            [
                {"mimeType": "image/jpeg", "base64": img_b64},
                {"mimeType": "application/pdf", "base64": pdf_b64},
            ]
        )
        self.assertEqual(out[0]["base64"], img_b64)
        self.assertEqual(out[1]["mimeType"], "image/jpeg")

    def test_page_limit_raises(self):
        from llmclient.pdf_to_images import PdfPageLimitError, normalize_direct_files

        pdf_b64 = base64.b64encode(self.make_pdf(3)).decode()
        with self.assertRaises(PdfPageLimitError):
            normalize_direct_files([{"mimeType": "application/pdf", "base64": pdf_b64}], max_pages=2)


if __name__ == "__main__":
    unittest.main()
