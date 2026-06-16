from __future__ import annotations

from typing import Any, Callable

from llmclient.tools import grades


ToolHandler = Callable[..., dict[str, Any]]


TOOL_HANDLERS: dict[str, ToolHandler] = {
    "get_exam_overview": grades.get_exam_overview,
    "get_score_distribution": grades.get_score_distribution,
    "get_class_summaries": grades.get_class_summaries,
    "get_question_analysis": grades.get_question_analysis,
    "get_rank_segments": grades.get_rank_segments,
    "get_review_risks": grades.get_review_risks,
}


def _params(properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


FUNCTION_DECLARATIONS: list[dict[str, Any]] = [
    {
        "name": "get_exam_overview",
        "description": "Read the selected exam name, subject, and score summary.",
        "parameters": _params(
            {
                "examId": {"type": "integer", "description": "Project-X exam id"},
                "classId": {"type": "integer", "description": "Optional class id; use 0 for unknown class"},
            },
            ["examId"],
        ),
    },
    {
        "name": "get_score_distribution",
        "description": "Read score distribution buckets and quartile summary for an exam.",
        "parameters": _params(
            {
                "examId": {"type": "integer"},
                "classId": {"type": "integer", "description": "Optional class id; use 0 for unknown class"},
            },
            ["examId"],
        ),
    },
    {
        "name": "get_class_summaries",
        "description": "Read class-level score summaries for an exam.",
        "parameters": _params({"examId": {"type": "integer"}}, ["examId"]),
    },
    {
        "name": "get_question_analysis",
        "description": "Read weakest questions ordered by score rate.",
        "parameters": _params(
            {
                "examId": {"type": "integer"},
                "classId": {"type": "integer", "description": "Optional class id; use 0 for unknown class"},
                "limit": {"type": "integer", "description": "Maximum number of questions to return"},
            },
            ["examId"],
        ),
    },
    {
        "name": "get_rank_segments",
        "description": "Read anonymized score summaries by rank segment.",
        "parameters": _params(
            {
                "examId": {"type": "integer"},
                "classId": {"type": "integer", "description": "Optional class id; use 0 for unknown class"},
            },
            ["examId"],
        ),
    },
    {
        "name": "get_review_risks",
        "description": "Read questions with many zero or low-score review risks.",
        "parameters": _params(
            {
                "examId": {"type": "integer"},
                "classId": {"type": "integer", "description": "Optional class id; use 0 for unknown class"},
                "limit": {"type": "integer", "description": "Maximum number of risk items to return"},
            },
            ["examId"],
        ),
    },
]


def openai_tools() -> list[dict[str, Any]]:
    return [{"type": "function", "function": declaration} for declaration in FUNCTION_DECLARATIONS]


def gemini_function_declarations() -> list[dict[str, Any]]:
    return FUNCTION_DECLARATIONS


def call_tool(name: str, arguments: dict[str, Any], exam_id: int, class_id: int | None) -> dict[str, Any]:
    handler = TOOL_HANDLERS.get(name)
    if handler is None:
        return {"error": f"unknown tool: {name}"}

    safe_args = dict(arguments or {})
    requested_exam = int(safe_args.get("examId", exam_id))
    if requested_exam != exam_id:
        return {"error": "tool examId must match the selected exam"}
    safe_args["examId"] = exam_id

    if "classId" in safe_args and safe_args["classId"] is None:
        safe_args.pop("classId")
    if class_id is not None:
        requested_class = safe_args.get("classId", class_id)
        if int(requested_class) != int(class_id):
            return {"error": "tool classId must match the selected class"}
        safe_args["classId"] = class_id

    return handler(**safe_args)

