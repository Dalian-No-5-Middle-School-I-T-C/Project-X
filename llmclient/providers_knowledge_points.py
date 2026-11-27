"""Knowledge points analysis provider implementations.

Two paths:
- direct: multimodal (Gemini/GPT/DeepSeek vision) — image base64 → structured output
- text: text-only model — pre-extracted text → structured output
"""

from __future__ import annotations

import json
import logging
from typing import Any

from llmclient.config import ModelConfig
from llmclient.pdf_to_images import normalize_direct_files
from llmclient.providers_paper import paper_provider_credentials, request_gemini_json, request_openai_json
from llmclient.prompts.knowledge_points import build_knowledge_points_prompt
from llmclient.usage import usage_dict

KP_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "knowledgePoints": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "questionNumber": {"type": "integer"},
                    "points": {
                        "type": "array",
                        "items": {"type": "string"}
                    }
                },
                "required": ["questionNumber", "points"],
                "additionalProperties": False
            }
        }
    },
    "required": ["knowledgePoints"],
    "additionalProperties": False
}


def _build_system_prompt(
    subject: str,
    question_range: str,
    extra_notes: str,
    ocr_mode: bool = False,
    answer_card_json: str = "",
) -> str:
    return build_knowledge_points_prompt(
        question_range,
        extra_notes,
        ocr_mode,
        answer_card_json=answer_card_json,
        subject=subject,
    )


def _parse_knowledge_points(text: str) -> dict[str, Any]:
    """Parse JSON response, with fallback extraction."""
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            data = json.loads(text[start:end + 1])
        else:
            return {"knowledgePoints": [], "_parseError": "JSON解析失败"}

    # Validate and clean
    raw = data.get("knowledgePoints", [])
    if not isinstance(raw, list):
        return {"knowledgePoints": [], "_parseError": "非法格式"}

    cleaned = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        qn = item.get("questionNumber")
        pts = item.get("points")
        if not isinstance(qn, (int, float)) or qn < 1:
            continue
        if not isinstance(pts, list) or len(pts) == 0:
            continue
        cleaned_pts = [
            str(p).strip()[:10]  # truncate to 10 chars
            for p in pts if str(p).strip()
        ]
        if cleaned_pts:
            cleaned.append({
                "questionNumber": int(qn),
                "points": cleaned_pts,
            })

    cleaned.sort(key=lambda x: x["questionNumber"])
    return {"knowledgePoints": cleaned}


def run_direct_multimodal(
    model: ModelConfig,
    files: list[dict[str, str]],
    subject: str,
    question_range: str,
    extra_notes: str,
    answer_card_json: str = "",
    provider_override: dict[str, str] | None = None,
) -> dict[str, Any]:
    """直传图片给多模态模型 (Gemini / GPT)."""
    # PDF 原卷先转压缩页图（OpenAI 兼容接口不接受 PDF data URL）
    files = normalize_direct_files(files)

    api_key, base_url = paper_provider_credentials(model, provider_override)
    if model.provider == "gemini":
        return _run_gemini_direct(model, api_key, files, subject, question_range, extra_notes,
                                  answer_card_json=answer_card_json, base_url=base_url)

    return _run_openai_direct(model, api_key, base_url, files, subject, question_range, extra_notes, answer_card_json=answer_card_json)


def run_text_only(
    model: ModelConfig,
    paper_text: str,
    subject: str,
    question_range: str,
    extra_notes: str,
    answer_card_json: str = "",
    provider_override: dict[str, str] | None = None,
) -> dict[str, Any]:
    """纯文本模式 (DeepSeek / 兜底)."""
    api_key, base_url = paper_provider_credentials(model, provider_override)
    prompt = _build_system_prompt(
        subject, question_range, extra_notes, ocr_mode=True, answer_card_json=answer_card_json,
    )
    if model.provider == "gemini":
        text, usage = request_gemini_json(model, api_key, prompt, paper_text, [], base_url)
    else:
        text, usage = request_openai_json(model, api_key, base_url, prompt, paper_text, [], 4096)
    return {**_parse_knowledge_points(text), "usage": usage_dict(usage)}


def _run_gemini_direct(
    model: ModelConfig,
    api_key: str,
    files: list[dict[str, str]],
    subject: str,
    question_range: str,
    extra_notes: str,
    answer_card_json: str = "",
    base_url: str | None = None,
) -> dict[str, Any]:
    prompt = _build_system_prompt(subject, question_range, extra_notes, answer_card_json=answer_card_json)
    text, usage = request_gemini_json(model, api_key, prompt, "请分析试卷图片中的每道题，输出知识点 JSON。", files, base_url)
    return {**_parse_knowledge_points(text), "usage": usage_dict(usage)}


def _run_openai_direct(
    model: ModelConfig,
    api_key: str,
    base_url: str | None,
    files: list[dict[str, str]],
    subject: str,
    question_range: str,
    extra_notes: str,
    answer_card_json: str = "",
) -> dict[str, Any]:
    prompt = _build_system_prompt(subject, question_range, extra_notes, answer_card_json=answer_card_json)
    text, usage = request_openai_json(
        model, api_key, base_url, prompt, "请分析试卷图片中的每道题，输出知识点 JSON。", files, 4096,
    )
    return {**_parse_knowledge_points(text), "usage": usage_dict(usage)}
