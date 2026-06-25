#!/usr/bin/env python3
"""Smoke test for student personal AI analysis request schema."""

from __future__ import annotations

from llmclient.schemas import AnalysisRunRequest, StudentRecentExam, StudentSubjectSummary


def main() -> None:
    request = AnalysisRunRequest(
        examId=0,
        studentAnalysis=True,
        studentId=42,
        studentName="测试学生",
        totalExams=2,
        subjectSummaries=[
            StudentSubjectSummary(
                subject="数学",
                examCount=2,
                avgScore=88.0,
                avgClassAvg=82.5,
                gap=5.5,
            )
        ],
        recentExams=[
            StudentRecentExam(
                name="期中",
                subject="数学",
                score=90.0,
                classAvg=84.0,
                gradeAvg=80.0,
                rank=3,
                percentile=85.0,
            )
        ],
    )

    payload = request.model_dump()
    assert payload["studentAnalysis"] is True
    assert payload["subjectSummaries"][0]["subject"] == "数学"
    assert payload["recentExams"][0]["score"] == 90.0

    legacy = AnalysisRunRequest(examId=12, classId=3, model="deepseek-chat")
    assert legacy.studentAnalysis is False

    print("student-ai-analysis-smoke: ok")


if __name__ == "__main__":
    main()
