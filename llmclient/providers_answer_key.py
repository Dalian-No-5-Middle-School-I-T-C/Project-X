"""Extract and validate answer drafts returned by the configured model."""

from __future__ import annotations

import json
from typing import Any

from llmclient.config import ModelConfig
from llmclient.pdf_to_images import normalize_direct_files
from llmclient.prompts.answer_key import ANSWER_KEY_PROMPT, MAX_ANSWER_TEXT_LENGTH, MAX_QUESTION_NUMBER
from llmclient.providers_paper import (
    paper_provider_credentials,
    request_gemini_json,
    request_openai_json,
    uses_max_completion_tokens,
)
from llmclient.usage import usage_dict


def parse_answer_key_response(raw: str) -> list[dict[str, int | str]]:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        start = raw.find("{")
        end = raw.rfind("}")
        if start >= 0 and end > start:
            data = json.loads(raw[start:end + 1])
        else:
            raise
    if not isinstance(data, dict) or not isinstance(data.get("answers"), list):
        raise ValueError("Answer key response must include an answers array")

    answers: dict[int, str] = {}
    for row in data["answers"]:
        if not isinstance(row, dict):
            continue
        number = row.get("questionNumber")
        text = row.get("answerText")
        if type(number) is not int or not 1 <= number <= MAX_QUESTION_NUMBER or not isinstance(text, str):
            continue
        cleaned = " ".join(text.split())[:MAX_ANSWER_TEXT_LENGTH]
        if cleaned:
            answers.setdefault(number, cleaned)
    return [{"questionNumber": number, "answerText": answers[number]} for number in sorted(answers)]


def run_answer_key_ocr(
    model: ModelConfig,
    paper_text: str,
    files: list[dict[str, str]],
    provider_override: dict[str, str] | None,
) -> dict[str, Any]:
    api_key, base_url = paper_provider_credentials(model, provider_override)
    images = normalize_direct_files(files) if files else []
    content = "请按题号转写这些图片中的参考答案。" if images else paper_text
    if model.provider == "gemini":
        raw, usage = request_gemini_json(model, api_key, ANSWER_KEY_PROMPT, content, images, base_url)
    else:
        # DeepSeek and most OpenAI-compatible APIs cap max_tokens at 8192;
        # reasoning models using max_completion_tokens need a 16k budget.
        token_limit = 16_384 if uses_max_completion_tokens(model.id) else 8192
        raw, usage = request_openai_json(model, api_key, base_url, ANSWER_KEY_PROMPT, content, images, token_limit)
    return {"answers": parse_answer_key_response(raw), "usage": usage_dict(usage)}
