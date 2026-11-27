"""Provider transport shared by the two paper analysis endpoints."""

from __future__ import annotations

import base64
import re
from typing import Any

from openai import OpenAI

from llmclient.config import ModelConfig, env_value
from llmclient.providers import validate_base_url
from llmclient.usage import Usage, gemini_usage, openai_usage

PROVIDER_TIMEOUT_SECONDS = 105


def paper_provider_credentials(
    model: ModelConfig, override: dict[str, str] | None
) -> tuple[str, str | None]:
    default_keys = {"gemini": "GEMINI_API_KEY", "deepseek": "DEEPSEEK_API_KEY", "openai": "OPENAI_API_KEY"}
    api_key = (override or {}).get("api_key") or env_value(default_keys[model.provider])
    if override and override.get("api_key"):
        base_url = validate_base_url(override.get("base_url", "").rstrip("/") or None)
    else:
        base_url = validate_base_url(env_value("OPENAI_BASE_URL") or None) if model.provider == "openai" else None
    if model.provider == "deepseek" and not base_url:
        base_url = "https://api.deepseek.com"
    return api_key, base_url


def request_gemini_json(
    model: ModelConfig, api_key: str, prompt: str, text: str,
    files: list[dict[str, str]], base_url: str | None = None,
) -> tuple[str, Usage | None]:
    from google import genai
    from google.genai import types

    parts = [types.Part.from_text(text=text)]
    parts.extend(types.Part.from_bytes(data=base64.b64decode(file["base64"]), mime_type=file["mimeType"])
                 for file in files)
    http_options = types.HttpOptions(base_url=base_url, timeout=PROVIDER_TIMEOUT_SECONDS * 1000)
    with genai.Client(api_key=api_key, http_options=http_options) as client:
        response = client.models.generate_content(
            model=model.id,
            contents=[types.Content(role="user", parts=parts)],
            config=types.GenerateContentConfig(system_instruction=prompt, response_mime_type="application/json"),
        )
    return response.text or "", gemini_usage(response)


def request_openai_json(
    model: ModelConfig, api_key: str, base_url: str | None, prompt: str, text: str,
    files: list[dict[str, str]], max_tokens: int,
) -> tuple[str, Usage | None]:
    content: str | list[dict[str, Any]] = text
    if files:
        content = [{"type": "text", "text": text}]
        content.extend({"type": "image_url", "image_url": {
            "url": f"data:{file['mimeType']};base64,{file['base64']}",
        }} for file in files)

    # GPT-5 Chat Completions use max_completion_tokens. Other compatible APIs use max_tokens.
    limit = "max_completion_tokens" if re.search(r"(?:^|/)gpt-5(?:[.:-]|$)", model.id.lower()) else "max_tokens"
    with OpenAI(api_key=api_key, base_url=base_url, timeout=PROVIDER_TIMEOUT_SECONDS, max_retries=0) as client:
        response = client.chat.completions.create(
            model=model.id,
            messages=[{"role": "system", "content": prompt}, {"role": "user", "content": content}],
            response_format={"type": "json_object"},
            **{limit: max_tokens},
        )
    return response.choices[0].message.content or "", openai_usage(response)
