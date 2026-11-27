"""Exercise the sidecar HTTP contract without calling external model APIs."""

from __future__ import annotations

import base64
import json
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient
from google import genai
import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from llmclient import providers_paper
from llmclient.server import app

API_PATH = "/analysis/answer-key-ocr"
ENV = {
    "LLMCLIENT_INTERNAL_API_KEY": "ocr-regression-key",
    "GEMINI_API_KEY": "gemini-regression-key",
    "OPENAI_API_KEY": "openai-regression-key",
    "OPENAI_BASE_URL": "",
}
HEADERS = {"Authorization": f"Bearer {ENV['LLMCLIENT_INTERNAL_API_KEY']}"}


def scanned_pdf() -> str:
    with pymupdf.open() as fixture:
        page = fixture.new_page(width=300, height=180)
        page.insert_text((30, 60), "1-3 A B C", fontsize=28)
        image = page.get_pixmap().tobytes("png")
    with pymupdf.open() as scan:
        page = scan.new_page(width=300, height=180)
        page.insert_image(page.rect, stream=image)
        return base64.b64encode(scan.tobytes()).decode("ascii")


class AnswerKeyOcrTest(unittest.TestCase):
    def setUp(self):
        env = patch.dict(os.environ, ENV)
        env.start()
        self.addCleanup(env.stop)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_scan_pdf_reaches_gemini_as_jpeg_with_provider_zero(self):
        with patch.object(genai, "Client") as provider:
            generate = provider.return_value.__enter__.return_value.models.generate_content
            generate.return_value = SimpleNamespace(
                text='{"answers":[{"questionNumber":3,"answerText":"C"},{"questionNumber":1,"answerText":"A"}]}',
                usage_metadata=SimpleNamespace(prompt_token_count=25, candidates_token_count=12),
            )
            response = self.client.post(API_PATH, headers=HEADERS, json={
                "providerId": 0, "model": "gemini-3.1-flash-lite", "mode": "direct",
                "files": [{"mimeType": "application/pdf", "base64": scanned_pdf()}],
            })

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {
            "answers": [{"questionNumber": 1, "answerText": "A"}, {"questionNumber": 3, "answerText": "C"}],
            "usage": {"tokensIn": 25, "tokensOut": 12},
        })
        self.assertEqual(provider.call_args.kwargs["api_key"], ENV["GEMINI_API_KEY"])
        parts = generate.call_args.kwargs["contents"][0].parts
        images = [part.inline_data for part in parts if part.inline_data]
        self.assertEqual(len(images), 1)
        self.assertEqual(images[0].mime_type, "image/jpeg")
        self.assertTrue(images[0].data.startswith(b"\xff\xd8"))

    def test_text_mode_validates_answers_and_preserves_math(self):
        raw = {"answers": [
            {"questionNumber": 200, "answerText": "长" * 510},
            {"questionNumber": 2, "answerText": " 3.14\n  1:2\t9:30   (1)  x=2 "},
            {"questionNumber": 2, "answerText": "重复"},
            {"questionNumber": 3, "answerText": "\n "},
            {"questionNumber": 4, "answerText": 42},
            *[{"questionNumber": n, "answerText": "无效"} for n in [0, 201, 1.5, True, "8"]],
        ]}
        extracted = "第2题：3.14 1:2 9:30\n(1) x=2"
        with patch.object(providers_paper, "OpenAI") as provider:
            complete = provider.return_value.__enter__.return_value.chat.completions.create
            complete.return_value = SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(raw)))],
                usage=SimpleNamespace(prompt_tokens=40, completion_tokens=80),
            )
            response = self.client.post(API_PATH, headers=HEADERS, json={
                "providerId": 0, "model": "gpt-5.4", "mode": "text", "paperText": extracted,
            })

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {
            "answers": [
                {"questionNumber": 2, "answerText": "3.14 1:2 9:30 (1) x=2"},
                {"questionNumber": 200, "answerText": "长" * 500},
            ],
            "usage": {"tokensIn": 40, "tokensOut": 80},
        })
        self.assertEqual(complete.call_args.kwargs["messages"][-1], {"role": "user", "content": extracted})
        self.assertEqual(complete.call_args.kwargs["response_format"], {"type": "json_object"})
        self.assertEqual(provider.call_args.kwargs["api_key"], ENV["OPENAI_API_KEY"])

    def test_knowledge_points_with_provider_zero(self):
        with patch.object(genai, "Client") as provider:
            generate = provider.return_value.__enter__.return_value.models.generate_content
            generate.return_value = SimpleNamespace(
                text='{"knowledgePoints":[{"questionNumber":1,"points":["光合作用"]}]}',
            )
            response = self.client.post("/analysis/knowledge-points", headers=HEADERS, json={
                "providerId": 0, "model": "gemini-3.1-flash-lite", "mode": "text", "paperText": "第1题",
            })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["knowledgePoints"], [{"questionNumber": 1, "points": ["光合作用"]}])

    def test_fenced_json_response_is_parsed(self):
        with patch.object(providers_paper, "OpenAI") as provider:
            complete = provider.return_value.__enter__.return_value.chat.completions.create
            complete.return_value = SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(
                    content='```json\n{"answers":[{"questionNumber":5,"answerText":"BD"}]}\n```'
                ))],
                usage=SimpleNamespace(prompt_tokens=10, completion_tokens=15),
            )
            response = self.client.post(API_PATH, headers=HEADERS, json={
                "providerId": 0, "model": "gpt-5.5", "mode": "text", "paperText": "5. BD",
            })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["answers"], [{"questionNumber": 5, "answerText": "BD"}])
        self.assertEqual(complete.call_args.kwargs.get("max_completion_tokens"), 16_384)
        self.assertNotIn("max_tokens", complete.call_args.kwargs)

    def test_deepseek_token_cap_and_empty_model_override_matching_provider(self):
        with patch.object(providers_paper, "OpenAI") as provider:
            complete = provider.return_value.__enter__.return_value.chat.completions.create
            complete.return_value = SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(
                    content='{"answers":[{"questionNumber":1,"answerText":"A"}]}'
                ))],
                usage=SimpleNamespace(prompt_tokens=8, completion_tokens=6),
            )
            ds_resp = self.client.post(API_PATH, headers=HEADERS, json={
                "providerId": 0, "model": "deepseek-v4-flash", "mode": "text", "paperText": "1. A",
            })
            self.assertEqual(ds_resp.status_code, 200, ds_resp.text)
            self.assertEqual(complete.call_args.kwargs.get("max_tokens"), 8192)

            override_resp = self.client.post(API_PATH, headers=HEADERS, json={
                "providerId": 7, "model": None, "mode": "text", "paperText": "1. A",
                "providerOverride": {"provider_type": "openai", "api_key": "sk-test", "base_url": ""},
            })
            self.assertEqual(override_resp.status_code, 200, override_resp.text)
            self.assertTrue(complete.call_args.kwargs["model"].startswith("gpt-"))

            kp_resp = self.client.post("/analysis/knowledge-points", headers=HEADERS, json={
                "providerId": 7, "model": None, "mode": "text", "paperText": "第1题",
                "providerOverride": {"provider_type": "openai", "api_key": "sk-test", "base_url": None},
            })
            self.assertEqual(kp_resp.status_code, 200, kp_resp.text)
            self.assertTrue(complete.call_args.kwargs["model"].startswith("gpt-"))

    def test_auth_and_input_guards(self):
        payload = {"providerId": 0, "mode": "text", "paperText": "1. A"}
        self.assertEqual(self.client.post(API_PATH, json=payload).status_code, 401)
        for invalid, status in [
            ({"mode": "text", "paperText": "1. A"}, 422),
            ({**payload, "paperText": " "}, 400),
            ({**payload, "paperText": "A" * 32_001}, 413),
            ({"providerId": 0, "mode": "direct"}, 400),
        ]:
            with self.subTest(invalid=list(invalid)):
                self.assertEqual(self.client.post(API_PATH, headers=HEADERS, json=invalid).status_code, status)


if __name__ == "__main__":
    unittest.main()
