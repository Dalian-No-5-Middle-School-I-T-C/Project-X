from __future__ import annotations

import ipaddress
import json
import logging
import socket
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

from openai import OpenAI

from llmclient.config import ModelConfig, env_value
from llmclient.schemas import AiAnalysisReport, AnalysisRunResponse, REPORT_SCHEMA, ToolCallTrace, empty_report
from llmclient.tools.registry import call_tool, gemini_function_declarations, openai_tools
from llmclient.prompt import system

SYSTEM_PROMPT = system

# 安全审计（F-4 / P1）：base_url 白名单 —— 仅允许：
#   - https:// 任意公网域名（主流 LLM 服务商均为 HTTPS），且必须解析到公网地址
#   - http:// 仅回环地址（本机 Ollama / vLLM 等本地推理服务）
# 拒绝 http/https 解析到私网/回环/链路本地/保留地址的 base_url，
# 防止 providerOverride 被用于 SSRF 探测内网（含 https://127.0.0.1、云元数据 169.254.169.254 等）。
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "[::1]", "::1"}


def _ip_is_unsafe(ip_str: str) -> bool:
    """判断 IP 是否属于 SSRF 高危段（回环/私网/链路本地/保留/组播/未指定）。"""
    try:
        addr = ipaddress.ip_address(ip_str.strip("[]"))
    except ValueError:
        return True  # 非合法 IP 一律视为危险
    return (
        addr.is_loopback
        or addr.is_private
        or addr.is_link_local
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified
    )


def _resolve_host_ips(hostname: str) -> list[str]:
    """解析 hostname 的全部地址；直接写 IP（含十进制/IPv6 等变体编码）时归一化返回。"""
    candidate = hostname.strip("[]")
    try:
        ipaddress.ip_address(candidate)
        return [candidate]
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(hostname, None, proto=socket.IPPROTO_TCP)
    except OSError:
        return []
    return sorted({info[4][0] for info in infos})


def _hostname_is_unsafe(hostname: str) -> bool:
    """hostname 解析出的任一地址落在高危段即判定为不安全（防 IP 变体编码与 DNS 多记录重绑定）。"""
    return any(_ip_is_unsafe(ip) for ip in _resolve_host_ips(hostname))


def validate_base_url(base_url: str | None) -> str | None:
    if not base_url:
        return None
    parsed = urlparse(base_url)
    hostname = (parsed.hostname or "").lower()
    if not hostname:
        raise ValueError("base_url must include a host; refused to avoid SSRF")
    if parsed.scheme == "https":
        # 安全审计（P1）：https 不再无条件放行 —— 逐一解析并校验地址，
        # 拒绝回环/私网/链路本地/保留地址及其变体（https://127.0.0.1、169.254.169.254 等）。
        # 注：解析在连接前执行；对「解析到公网但在本进程重连瞬间改指内网」的 DNS 重绑定，
        # 由沙箱/防火墙在网络边界兜底，且此处会拒绝任何同时含私网记录的多记录域名。
        if _hostname_is_unsafe(hostname):
            raise ValueError(
                "base_url resolves to a loopback/private/link-local/reserved address; refused to avoid SSRF"
            )
        return base_url
    if parsed.scheme == "http" and hostname in LOOPBACK_HOSTS:
        return base_url
    raise ValueError("base_url must be https:// (public host) or http://127.0.0.1 (loopback only); refused to avoid SSRF")


class _GeminiNonTextWarningFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return "there are non-text parts in the response" not in record.getMessage()


def _quiet_gemini_non_text_warning() -> None:
    for logger_name in ("google_genai.types", "google.genai.types"):
        logger = logging.getLogger(logger_name)
        if not any(isinstance(item, _GeminiNonTextWarningFilter) for item in logger.filters):
            logger.addFilter(_GeminiNonTextWarningFilter())


def _user_prompt(exam_id: int, class_id: int | None, locale: str, group_exam_ids: set[int] | None = None) -> str:
    scope = "all classes" if class_id is None else f"classId={class_id}"
    if group_exam_ids:
        member_list = ", ".join(str(e) for e in sorted(group_exam_ids))
        return (
            f"Generate a structured score analysis report for a GROUP (大考) of member exams [{member_list}], "
            f"scope={scope}, locale={locale}. For each member exam, call get_exam_overview / get_question_analysis with its examId, "
            "then synthesize an overall group report. Use the difficulty (P) and discrimination (D) returned by the tools to evaluate "
            "whether the paper was too hard/easy and whether questions discriminated ability well."
            f"Current Date: {datetime.now().strftime('%Y-%m-%d')}. This is the REAL TIME NOW, NOT a simulated or past or future date."
        )
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
    exam_id: int | None,
    class_id: int | None,
    locale: str,
    provider_override: dict[str, str] | None = None,
    group_exam_ids: set[int] | None = None,
) -> AnalysisRunResponse:
    # Use provider override if provided, else fall back to env vars
    if provider_override:
        api_key = provider_override.get("api_key") or env_value("OPENAI_API_KEY")
        raw_base_url = provider_override.get("base_url")
        # 安全审计（F-4）：SSRF 防护 —— 拒绝非 https / 非回环 http 的 base_url
        try:
            base_url = validate_base_url(raw_base_url.rstrip("/") if raw_base_url else None)
        except ValueError as exc:
            raise ValueError(f"Invalid provider base_url: {exc}") from exc
    elif model.provider == "deepseek":
        api_key = env_value("DEEPSEEK_API_KEY")
        base_url = "https://api.deepseek.com"
    else:
        api_key = env_value("OPENAI_API_KEY")
        base_url = validate_base_url(env_value("OPENAI_BASE_URL") or None)

    client = OpenAI(api_key=api_key, base_url=base_url)
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": _user_prompt(exam_id, class_id, locale, group_exam_ids)},
    ]
    traces: list[ToolCallTrace] = []

    for _ in range(8):
        kwargs: dict[str, Any] = {
            "model": model.id,
            "messages": messages,
            "tools": openai_tools(),
            "response_format": {"type": "json_object"},
            # 2026-08-24：4096 → 8192（成绩分析报告含 7 个工具结果 + 多段结构化字段，
            # 4096 时常在字符串中间截断导致 "Unterminated string" JSON 解析失败）
            "max_tokens": 8192,
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
            result = call_tool(tool.function.name, arguments, exam_id, class_id, group_exam_ids)
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
    exam_id: int | None,
    class_id: int | None,
    locale: str,
    provider_override: dict[str, str] | None = None,
    group_exam_ids: set[int] | None = None,
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
            parts=[types.Part(text=_user_prompt(exam_id, class_id, locale, group_exam_ids))],
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
            result = call_tool(fc.name, arguments, exam_id, class_id, group_exam_ids)
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
    exam_id: int | None,
    class_id: int | None,
    locale: str,
    provider_override: dict[str, str] | None = None,
    group_exam_ids: set[int] | None = None,
) -> AnalysisRunResponse:
    # If provider_override is given, treat as OpenAI-compatible unless explicitly gemini
    effective_provider = provider_override.get("provider_type", model.provider) if provider_override else model.provider

    if effective_provider == "gemini":
        return run_gemini_analysis(model, exam_id, class_id, locale, provider_override, group_exam_ids)
    # All other providers (openai, deepseek, custom) are OpenAI-compatible
    return run_openai_compatible_analysis(model, exam_id, class_id, locale, provider_override, group_exam_ids)

