from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

from openai import OpenAI

from llmclient.config import ModelConfig, env_value
from llmclient.schemas import AiAnalysisReport, AnalysisRunResponse, REPORT_SCHEMA, ToolCallTrace, empty_report
from llmclient.tools.registry import call_tool, gemini_function_declarations, openai_tools
from llmclient.prompt import system

SYSTEM_PROMPT = system


class _GeminiNonTextWarningFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return "there are non-text parts in the response" not in record.getMessage()


def _quiet_gemini_non_text_warning() -> None:
    for logger_name in ("google_genai.types", "google.genai.types"):
        logger = logging.getLogger(logger_name)
        if not any(isinstance(item, _GeminiNonTextWarningFilter) for item in logger.filters):
            logger.addFilter(_GeminiNonTextWarningFilter())


def _user_prompt(exam_id: int, class_id: int | None, locale: str) -> str:
    scope = "all classes" if class_id is None else f"classId={class_id}"
    return (
        f"Generate a structured score analysis report for examId={exam_id}, scope={scope}, locale={locale}. "
        "Call tools as needed before writing the final json report."
        f"Current Date: {datetime.now().strftime('%Y-%m-%d')}. This is the REAL TIME NOW, NOT a simulated or past or future date."
    )


def _parse_report(text: str) -> AiAnalysisReport:
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            data = json.loads(text[start : end + 1])
        else:
            raise
    return AiAnalysisReport.model_validate(data)


def _trace(name: str, arguments: dict[str, Any], result: dict[str, Any]) -> ToolCallTrace:
    if "error" in result:
        summary = str(result["error"])
    elif "questions" in result:
        summary = f"{len(result.get('questions') or [])} questions"
    elif "risks" in result:
        summary = f"{len(result.get('risks') or [])} risk rows"
    elif "classes" in result:
        summary = f"{len(result.get('classes') or [])} classes"
    elif "summary" in result:
        summary = f"summary count={(result.get('summary') or {}).get('count', 0)}"
    else:
        summary = "ok"
    return ToolCallTrace(name=name, arguments=arguments, summary=summary)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _gemini_function_calls(response: Any) -> list[Any]:
    calls: list[Any] = []
    for candidate in getattr(response, "candidates", None) or []:
        content = getattr(candidate, "content", None)
        for part in getattr(content, "parts", None) or []:
            function_call = getattr(part, "function_call", None)
            if function_call is not None:
                calls.append(function_call)
    return calls


def _gemini_text(response: Any) -> str:
    texts: list[str] = []
    for candidate in getattr(response, "candidates", None) or []:
        content = getattr(candidate, "content", None)
        for part in getattr(content, "parts", None) or []:
            text = getattr(part, "text", None)
            if text:
                texts.append(text)
    return "\n".join(texts)


def run_openai_compatible_analysis(
    model: ModelConfig,
    exam_id: int,
    class_id: int | None,
    locale: str,
    provider_override: dict[str, str] | None = None,
) -> AnalysisRunResponse:
    # Use provider override if provided, else fall back to env vars
    if provider_override:
        api_key = provider_override["api_key"]
        base_url = provider_override["base_url"].rstrip("/") if provider_override.get("base_url") else None
    elif model.provider == "deepseek":
        api_key = env_value("DEEPSEEK_API_KEY")
        base_url = "https://api.deepseek.com"
    else:
        api_key = env_value("OPENAI_API_KEY")
        base_url = env_value("OPENAI_BASE_URL") or None

    client = OpenAI(api_key=api_key, base_url=base_url)
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": _user_prompt(exam_id, class_id, locale)},
    ]
    traces: list[ToolCallTrace] = []

    for _ in range(8):
        kwargs: dict[str, Any] = {
            "model": model.id,
            "messages": messages,
            "tools": openai_tools(),
            "response_format": {"type": "json_object"},
            "max_tokens": 4096,
            "stream": False,
        }
        if model.provider in ("deepseek", "openai") and model.thinking:
            kwargs["reasoning_effort"] = model.reasoning_effort or "high"
        if model.provider == "deepseek" and model.thinking:
            kwargs["extra_body"] = {"thinking": {"type": "enabled"}}
        elif not model.thinking:
            kwargs["temperature"] = 0.7

        response = client.chat.completions.create(**kwargs)
        message = response.choices[0].message
        tool_calls = message.tool_calls or []
        assistant_message: dict[str, Any] = {
            "role": "assistant",
            "content": message.content or "",
        }
        reasoning_content = getattr(message, "reasoning_content", None)
        if reasoning_content:
            assistant_message["reasoning_content"] = reasoning_content
        if tool_calls:
            assistant_message["tool_calls"] = [
                {
                    "id": tool.id,
                    "type": tool.type,
                    "function": {
                        "name": tool.function.name,
                        "arguments": tool.function.arguments,
                    },
                }
                for tool in tool_calls
            ]
        messages.append(assistant_message)

        if not tool_calls:
            content = message.content or "{}"
            try:
                report = _parse_report(content)
            except Exception as exc:
                report = empty_report(f"AI report JSON parse failed: {exc}")
            return AnalysisRunResponse(generatedAt=_now_iso(), model=model.id, report=report, toolCalls=traces)

        for tool in tool_calls:
            try:
                arguments = json.loads(tool.function.arguments or "{}")
            except json.JSONDecodeError:
                arguments = {}
            result = call_tool(tool.function.name, arguments, exam_id, class_id)
            traces.append(_trace(tool.function.name, arguments, result))
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tool.id,
                    "content": json.dumps(result, ensure_ascii=False),
                }
            )

    return AnalysisRunResponse(
        generatedAt=_now_iso(),
        model=model.id,
        report=empty_report("AI tool loop reached the maximum number of steps."),
        toolCalls=traces,
    )


def run_gemini_analysis(
    model: ModelConfig,
    exam_id: int,
    class_id: int | None,
    locale: str,
    provider_override: dict[str, str] | None = None,
) -> AnalysisRunResponse:
    from google import genai
    from google.genai import types

    _quiet_gemini_non_text_warning()
    api_key = provider_override["api_key"] if provider_override else env_value("GEMINI_API_KEY")
    client = genai.Client(api_key=api_key)
    tools = types.Tool(function_declarations=gemini_function_declarations())
    config_kwargs: dict[str, Any] = {
        "tools": [tools],
        "system_instruction": SYSTEM_PROMPT,
        "response_mime_type": "application/json",
        "response_json_schema": REPORT_SCHEMA,
    }
    if model.thinking:
        config_kwargs["thinking_config"] = types.ThinkingConfig(thinking_level="high")
    config = types.GenerateContentConfig(**config_kwargs)

    contents: list[Any] = [
        types.Content(
            role="user",
            parts=[types.Part(text=_user_prompt(exam_id, class_id, locale))],
        )
    ]
    traces: list[ToolCallTrace] = []

    for _ in range(8):
        response = client.models.generate_content(model=model.id, contents=contents, config=config)
        function_calls = _gemini_function_calls(response)
        if not function_calls:
            try:
                report = _parse_report(_gemini_text(response) or "{}")
            except Exception as exc:
                report = empty_report(f"AI report JSON parse failed: {exc}")
            return AnalysisRunResponse(generatedAt=_now_iso(), model=model.id, report=report, toolCalls=traces)

        content = response.candidates[0].content
        contents.append(content)
        response_parts = []
        for fc in function_calls:
            arguments = dict(getattr(fc, "args", None) or {})
            result = call_tool(fc.name, arguments, exam_id, class_id)
            traces.append(_trace(fc.name, arguments, result))
            response_parts.append(
                types.Part(
                    functionResponse=types.FunctionResponse(
                        name=fc.name,
                        response=result,
                        id=getattr(fc, "id", None),
                    ),
                )
            )
        contents.append(types.Content(role="user", parts=response_parts))

    return AnalysisRunResponse(
        generatedAt=_now_iso(),
        model=model.id,
        report=empty_report("AI tool loop reached the maximum number of steps."),
        toolCalls=traces,
    )


def run_analysis(
    model: ModelConfig,
    exam_id: int,
    class_id: int | None,
    locale: str,
    provider_override: dict[str, str] | None = None,
) -> AnalysisRunResponse:
    # If provider_override is given, treat as OpenAI-compatible unless explicitly gemini
    effective_provider = provider_override.get("provider_type", model.provider) if provider_override else model.provider

    if effective_provider == "gemini" and not provider_override:
        return run_gemini_analysis(model, exam_id, class_id, locale)
    # All other providers (openai, deepseek, haqimi, custom) are OpenAI-compatible
    return run_openai_compatible_analysis(model, exam_id, class_id, locale, provider_override)

