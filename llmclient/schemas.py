from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ProviderOverride(BaseModel):
    provider_type: str = ""
    base_url: str = ""
    api_key: str = ""


class AnalysisRunRequest(BaseModel):
    examId: int | None = None
    classId: int | None = None
    groupId: int | None = None
    model: str | None = None
    locale: str = "zh-CN"
    providerOverride: ProviderOverride | None = None


class AiAnalysisQuestionAction(BaseModel):
    questionNumber: str = Field(default="")
    reason: str = Field(default="")
    action: str = Field(default="")


class AiAnalysisReport(BaseModel):
    overallJudgement: str = Field(default="")
    distributionInsight: str = Field(default="")
    weakPoints: list[str] = Field(default_factory=list)
    reviewRisks: list[str] = Field(default_factory=list)
    teachingSuggestions: list[str] = Field(default_factory=list)
    nextActions: list[str] = Field(default_factory=list)
    questionActions: list[AiAnalysisQuestionAction] = Field(default_factory=list)
    caveats: list[str] = Field(default_factory=list)


class ToolCallTrace(BaseModel):
    name: str
    arguments: dict[str, Any]
    summary: str


class TokenUsage(BaseModel):
    tokensIn: int
    tokensOut: int


class AnalysisRunResponse(BaseModel):
    generatedAt: str
    model: str
    report: AiAnalysisReport
    toolCalls: list[ToolCallTrace]
    usage: TokenUsage | None = None


REPORT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "overallJudgement": {"type": "string"},
        "distributionInsight": {"type": "string"},
        "weakPoints": {"type": "array", "items": {"type": "string"}},
        "reviewRisks": {"type": "array", "items": {"type": "string"}},
        "teachingSuggestions": {"type": "array", "items": {"type": "string"}},
        "nextActions": {"type": "array", "items": {"type": "string"}},
        "questionActions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "questionNumber": {"type": "string"},
                    "reason": {"type": "string"},
                    "action": {"type": "string"},
                },
                "required": ["questionNumber", "reason", "action"],
            },
        },
        "caveats": {"type": "array", "items": {"type": "string"}},
    },
    "required": [
        "overallJudgement",
        "distributionInsight",
        "weakPoints",
        "reviewRisks",
        "teachingSuggestions",
        "nextActions",
        "questionActions",
        "caveats",
    ],
}


def empty_report(message: str) -> AiAnalysisReport:
    return AiAnalysisReport(
        overallJudgement=message,
        caveats=[message],
    )

