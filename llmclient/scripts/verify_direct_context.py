"""直传(多模态)路径必须把答题卡客观题 JSON 注入 system prompt,与文本模式一致。

背景:run_direct_multimodal 接收 answer_card_json 但未转发给直传实现,
_build_system_prompt 在直传路径拿不到客观题结构(题号映射),AI 只能猜题号。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from llmclient import providers_knowledge_points as pkp

CARD_JSON = '{"objectiveQuestions":[{"questionNumber":1,"options":["A","B","C","D"]}]}'


class _Stop(Exception):
    """哨兵异常:system prompt 构建后立即停止,避免真实调用模型。"""


class DirectMultimodalContextTest(unittest.TestCase):
    def _capture_prompt_json(self, run_func, **kwargs):
        """用 spy 替换 _build_system_prompt,捕获 answer_card_json 后短路返回。"""
        captured: dict[str, str] = {}

        def spy(subject, question_range, extra_notes, **kw):
            captured["answer_card_json"] = kw.get("answer_card_json", "")
            raise _Stop

        original = pkp._build_system_prompt
        pkp._build_system_prompt = spy
        try:
            with self.assertRaises(_Stop):
                run_func(**kwargs)
        finally:
            pkp._build_system_prompt = original
        return captured["answer_card_json"]

    def test_run_direct_multimodal_forwards_json_to_gemini_direct(self):
        captured: dict[str, str] = {}
        original = pkp._run_gemini_direct

        def fake_gemini(model, api_key, files, subject, question_range, extra_notes, **kw):
            captured["answer_card_json"] = kw.get("answer_card_json", "")
            return {"knowledgePoints": [], "usage": {}}

        try:
            pkp._run_gemini_direct = fake_gemini
            pkp.run_direct_multimodal(
                model=SimpleNamespace(provider="gemini", id="gemini-2.5-flash"),
                files=[],
                subject="数学",
                question_range="1-10",
                extra_notes="",
                answer_card_json=CARD_JSON,
                provider_override=None,
            )
        finally:
            pkp._run_gemini_direct = original
        self.assertEqual(captured["answer_card_json"], CARD_JSON)

    def test_run_direct_multimodal_forwards_json_to_openai_direct(self):
        captured: dict[str, str] = {}
        original = pkp._run_openai_direct

        def fake_openai(model, api_key, base_url, files, subject, question_range, extra_notes, **kw):
            captured["answer_card_json"] = kw.get("answer_card_json", "")
            return {"knowledgePoints": [], "usage": {}}

        try:
            pkp._run_openai_direct = fake_openai
            pkp.run_direct_multimodal(
                model=SimpleNamespace(provider="deepseek", id="deepseek-v4-flash-vision-exp"),
                files=[],
                subject="数学",
                question_range="1-10",
                extra_notes="",
                answer_card_json=CARD_JSON,
                provider_override=None,
            )
        finally:
            pkp._run_openai_direct = original
        self.assertEqual(captured["answer_card_json"], CARD_JSON)

    def test_gemini_direct_injects_json_into_system_prompt(self):
        seen = self._capture_prompt_json(
            pkp._run_gemini_direct,
            model=None,
            api_key="",
            files=[],
            subject="数学",
            question_range="1-10",
            extra_notes="",
            answer_card_json=CARD_JSON,
        )
        self.assertEqual(seen, CARD_JSON)

    def test_openai_direct_injects_json_into_system_prompt(self):
        seen = self._capture_prompt_json(
            pkp._run_openai_direct,
            model=None,
            api_key="",
            base_url=None,
            files=[],
            subject="数学",
            question_range="1-10",
            extra_notes="",
            answer_card_json=CARD_JSON,
        )
        self.assertEqual(seen, CARD_JSON)


if __name__ == "__main__":
    unittest.main()