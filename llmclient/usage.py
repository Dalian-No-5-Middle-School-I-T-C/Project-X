"""Token usage extraction from provider SDK responses.

llmclient 内部统一以 (tokensIn, tokensOut) 元组传递用量；
对外响应使用 camelCase：{"usage": {"tokensIn": n, "tokensOut": n}}。
"""

from __future__ import annotations

from typing import Any

Usage = tuple[int, int]


def openai_usage(response: Any) -> Usage | None:
    """OpenAI SDK chat.completions 响应的 usage 字段。"""
    usage = getattr(response, "usage", None)
    if usage is None:
        return None
    prompt = getattr(usage, "prompt_tokens", None)
    completion = getattr(usage, "completion_tokens", None)
    if prompt is None or completion is None:
        return None
    try:
        return int(prompt), int(completion)
    except (TypeError, ValueError):
        return None


def gemini_usage(response: Any) -> Usage | None:
    """Gemini genai SDK 响应的 usage_metadata 字段。"""
    metadata = getattr(response, "usage_metadata", None)
    if metadata is None:
        return None
    prompt = getattr(metadata, "prompt_token_count", None)
    completion = getattr(metadata, "candidates_token_count", None)
    if prompt is None or completion is None:
        return None
    try:
        return int(prompt), int(completion)
    except (TypeError, ValueError):
        return None


def merge_usage(*items: Usage | None) -> Usage | None:
    """累加多次模型调用（工具多轮 / 两段式），全为空时返回 None。"""
    total_in = 0
    total_out = 0
    seen = False
    for item in items:
        if item is None:
            continue
        seen = True
        total_in += item[0]
        total_out += item[1]
    return (total_in, total_out) if seen else None


def usage_dict(item: Usage | None) -> dict[str, int] | None:
    """对外响应体中的用量字段。"""
    if item is None:
        return None
    return {"tokensIn": item[0], "tokensOut": item[1]}
