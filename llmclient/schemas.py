from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ProviderOverride(BaseModel):
    provider_type: str = ""
    base_url: str = ""
    api_key: str = ""


class StudentSubjectSummary(BaseModel):
    subject: str
    examCount: int
    avgScore: float
    avgClassAvg: float
    gap: float


class StudentRecentExam(BaseModel):
    name: str
    subject: str
    score: float
    classAvg: float
    gradeAvg: float
    rank: int
    percentile: float | None = None


class AnalysisRunRequest(BaseModel):
    examId: int
    classId: int | None = None
    model: str | None = None
    locale: str = "zh-CN"
    providerOverride: ProviderOverride | None = None
    studentAnalysis: bool = False
    studentId: int | None = None
    studentName: str | None = None
    subjectSummaries: list[StudentSubjectSummary] = Field(default_factory=list)
    totalExams: int = 0
    recentExams: list[StudentRecentExam] = Field(default_factory=list)


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


class AnalysisRunResponse(BaseModel):
    generatedAt: str
    model: str
    report: AiAnalysisReport
    toolCalls: list[ToolCallTrace]


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

