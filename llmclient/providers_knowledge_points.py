"""Knowledge points analysis provider implementations.

Two paths:
- direct: multimodal (Gemini/GPT/DeepSeek vision) — image base64 → structured output
- text: text-only model — pre-extracted text → structured output
"""

from __future__ import annotations

import json
import logging
from typing import Any

from openai import OpenAI

from llmclient.config import ModelConfig, env_value
from llmclient.providers import validate_base_url
from llmclient.prompts.knowledge_points import build_knowledge_points_prompt
from llmclient.usage import gemini_usage, openai_usage, usage_dict

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
    if provider_override:
        api_key = provider_override.get("api_key") or env_value("OPENAI_API_KEY")
        base_url = validate_base_url(provider_override.get("base_url", "").rstrip("/") or None)
    elif model.provider == "gemini":
        api_key = env_value("GEMINI_API_KEY")
        base_url = None
    elif model.provider == "deepseek":
        api_key = env_value("DEEPSEEK_API_KEY")
        base_url = "https://api.deepseek.com"
    else:
        api_key = env_value("OPENAI_API_KEY")
        base_url = validate_base_url(env_value("OPENAI_BASE_URL") or None)

    if model.provider == "gemini":
        return _run_gemini_direct(model, api_key, files, subject, question_range, extra_notes)

    return _run_openai_direct(model, api_key, base_url, files, subject, question_range, extra_notes)


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
    if provider_override:
        api_key = provider_override.get("api_key") or env_value("OPENAI_API_KEY")
        base_url = validate_base_url(provider_override.get("base_url", "").rstrip("/") or None)
    elif model.provider == "deepseek":
        api_key = env_value("DEEPSEEK_API_KEY")
        base_url = "https://api.deepseek.com"
    else:
        api_key = env_value("OPENAI_API_KEY")
        base_url = validate_base_url(env_value("OPENAI_BASE_URL") or None)

    system_prompt = _build_system_prompt(
        subject,
        question_range,
        extra_notes,
        ocr_mode=True,
        answer_card_json=answer_card_json,
    )

    client = OpenAI(api_key=api_key, base_url=base_url)
    response = client.chat.completions.create(
        model=model.id,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": paper_text[:32000]},  # truncate for safety
        ],
        response_format={"type": "json_object"},
        max_tokens=4096,
        temperature=0.3,
    )

    content = response.choices[0].message.content or "{}"
    parsed = _parse_knowledge_points(content)
    return {**parsed, "usage": usage_dict(openai_usage(response))}


def _run_gemini_direct(
    model: ModelConfig,
    api_key: str,
    files: list[dict[str, str]],
    subject: str,
    question_range: str,
    extra_notes: str,
) -> dict[str, Any]:
    """Gemini multimodal direct analysis."""
    from google import genai
    from google.genai import types

    system_prompt = _build_system_prompt(subject, question_range, extra_notes)

    client = genai.Client(api_key=api_key)
    config = types.GenerateContentConfig(
        system_instruction=system_prompt,
        response_mime_type="application/json",
    )

    parts: list[Any] = []
    for f in files:
        parts.append(types.Part.from_bytes(
            data=f["base64"],
            mime_type=f["mimeType"],
        ))

    contents = [
        types.Content(role="user", parts=parts),
    ]

    response = client.models.generate_content(
        model=model.id,
        contents=contents,
        config=config,
    )

    text = ""
    for candidate in getattr(response, "candidates", None) or []:
        content = getattr(candidate, "content", None)
        for part in getattr(content, "parts", None) or []:
            t = getattr(part, "text", None)
            if t:
                text += t

    parsed = _parse_knowledge_points(text)
    return {**parsed, "usage": usage_dict(gemini_usage(response))}


def _run_openai_direct(
    model: ModelConfig,
    api_key: str,
    base_url: str | None,
    files: list[dict[str, str]],
    subject: str,
    question_range: str,
    extra_notes: str,
) -> dict[str, Any]:
    """OpenAI/GPT multimodal direct analysis."""
    system_prompt = _build_system_prompt(subject, question_range, extra_notes)

    client = OpenAI(api_key=api_key, base_url=base_url)

    image_contents: list[dict[str, Any]] = [
        {"type": "text", "text": "请分析试卷图片中的每道题，输出知识点JSON。"}
    ]
    for f in files:
        image_contents.append({
            "type": "image_url",
            "image_url": {"url": f"data:{f['mimeType']};base64,{f['base64']}"}
        })

    response = client.chat.completions.create(
        model=model.id,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": image_contents},
        ],
        response_format={"type": "json_object"},
        max_tokens=4096,
        temperature=0.3,
    )

    content = response.choices[0].message.content or "{}"
    parsed = _parse_knowledge_points(content)
    return {**parsed, "usage": usage_dict(openai_usage(response))}
