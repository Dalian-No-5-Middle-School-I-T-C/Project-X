from __future__ import annotations

import math
import sqlite3
from pathlib import Path
from statistics import median
from typing import Any

from llmclient.config import default_db_path


def connect_db(db_path: Path | None = None) -> sqlite3.Connection:
    target = db_path or default_db_path()
    conn = sqlite3.connect(str(target))
    conn.row_factory = sqlite3.Row
    return conn


def _round1(value: float | int | None) -> float:
    if value is None:
        return 0.0
    return round(float(value), 1)


def _class_filter(alias: str, class_id: int | None) -> tuple[str, str, list[Any]]:
    if class_id is None:
        return "", "", []
    if class_id == 0:
        where = f"AND NOT EXISTS (SELECT 1 FROM class_students cs_scope WHERE cs_scope.student_id = {alias}.student_id)"
        return "", where, []
    join = f"JOIN class_students cs_scope ON cs_scope.student_id = {alias}.student_id"
    return join, "AND cs_scope.class_id = ?", [class_id]


def _scores(conn: sqlite3.Connection, exam_id: int, class_id: int | None = None) -> list[float]:
    join, where, params = _class_filter("ss", class_id)
    rows = conn.execute(
        f"""
        SELECT ss.total_score AS total_score
        FROM student_scores ss
        {join}
        WHERE ss.exam_id = ? {where}
        ORDER BY ss.total_score ASC
        """,
        [exam_id, *params],
    ).fetchall()
    return [float(row["total_score"]) for row in rows if row["total_score"] is not None]


def _percentile(sorted_scores: list[float], p: float) -> float:
    if not sorted_scores:
        return 0
    if len(sorted_scores) == 1:
        return sorted_scores[0]
    index = (len(sorted_scores) - 1) * p
    lower = math.floor(index)
    upper = math.ceil(index)
    if lower == upper:
        return sorted_scores[lower]
    return sorted_scores[lower] + (sorted_scores[upper] - sorted_scores[lower]) * (index - lower)


def _score_summary(scores: list[float]) -> dict[str, Any]:
    if not scores:
        return {"count": 0}
    ordered = sorted(scores)
    avg = sum(ordered) / len(ordered)
    std_dev = math.sqrt(sum((score - avg) ** 2 for score in ordered) / len(ordered))
    return {
        "count": len(ordered),
        "min": _round1(ordered[0]),
        "q1": _round1(_percentile(ordered, 0.25)),
        "median": _round1(median(ordered)),
        "q3": _round1(_percentile(ordered, 0.75)),
        "max": _round1(ordered[-1]),
        "avg": _round1(avg),
        "stdDev": _round1(std_dev),
        "passRate": round(sum(1 for score in ordered if score >= 60) / len(ordered) * 100),
        "excellentRate": round(sum(1 for score in ordered if score >= 85) / len(ordered) * 100),
    }


def get_exam_overview(examId: int, classId: int | None = None) -> dict[str, Any]:
    with connect_db() as conn:
        exam = conn.execute(
            "SELECT id, name, subject, start_time, end_time, created_at FROM exams WHERE id = ?",
            [examId],
        ).fetchone()
        if exam is None:
            return {"error": f"exam {examId} not found"}
        scores = _scores(conn, examId, classId)
        return {
            "exam": dict(exam),
            "classId": classId,
            "summary": _score_summary(scores),
        }


def get_score_distribution(examId: int, classId: int | None = None) -> dict[str, Any]:
    ranges = [
        {"range": "0-59", "min": 0, "max": 59},
        {"range": "60-69", "min": 60, "max": 69},
        {"range": "70-79", "min": 70, "max": 79},
        {"range": "80-89", "min": 80, "max": 89},
        {"range": "90-100", "min": 90, "max": 100},
    ]
    with connect_db() as conn:
        scores = _scores(conn, examId, classId)
    return {
        "summary": _score_summary(scores),
        "distribution": [
            {**item, "count": sum(1 for score in scores if item["min"] <= score <= item["max"])}
            for item in ranges
        ],
    }


def get_class_summaries(examId: int) -> dict[str, Any]:
    with connect_db() as conn:
        classes = conn.execute(
            """
            SELECT DISTINCT c.id AS classId, c.name AS className
            FROM student_scores ss
            JOIN class_students cs ON cs.student_id = ss.student_id
            JOIN classes c ON c.id = cs.class_id
            WHERE ss.exam_id = ?
            ORDER BY c.sort_order, c.name
            """,
            [examId],
        ).fetchall()
        summaries = []
        for row in classes:
            class_id = int(row["classId"])
            summaries.append(
                {
                    "classId": class_id,
                    "className": row["className"],
                    "summary": _score_summary(_scores(conn, examId, class_id)),
                }
            )
        unknown_scores = _scores(conn, examId, 0)
        if unknown_scores:
            summaries.append({"classId": 0, "className": "Unknown class", "summary": _score_summary(unknown_scores)})
        return {"classes": summaries}


def get_question_analysis(examId: int, classId: int | None = None, limit: int = 12) -> dict[str, Any]:
    join, where, params = _class_filter("qs", classId)
    with connect_db() as conn:
        rows = conn.execute(
            f"""
            SELECT
              qs.question_number AS questionNumber,
              qs.score_type AS questionType,
              ROUND(AVG(qs.score), 1) AS avgScore,
              MAX(qs.max_score) AS maxScore,
              COUNT(*) AS totalCount,
              SUM(CASE WHEN qs.score >= qs.max_score THEN 1 ELSE 0 END) AS correctCount,
              SUM(CASE WHEN qs.score = 0 OR qs.score < qs.max_score * 0.5 THEN 1 ELSE 0 END) AS reviewCount
            FROM question_scores qs
            {join}
            WHERE qs.exam_id = ? {where}
            GROUP BY qs.question_number, qs.score_type
            ORDER BY CASE WHEN MAX(qs.max_score) > 0 THEN AVG(qs.score) / MAX(qs.max_score) ELSE 1 END ASC
            LIMIT ?
            """,
            [examId, *params, max(1, min(int(limit), 50))],
        ).fetchall()
    questions = []
    for row in rows:
        max_score = float(row["maxScore"] or 0)
        avg_score = float(row["avgScore"] or 0)
        total = int(row["totalCount"] or 0)
        questions.append(
            {
                "questionNumber": str(row["questionNumber"]),
                "questionType": "objective" if row["questionType"] == "objective" else "subjective",
                "avgScore": _round1(avg_score),
                "maxScore": _round1(max_score),
                "scoreRate": round(avg_score / max_score * 100) if max_score > 0 else 0,
                "correctRate": round(int(row["correctCount"] or 0) / total * 100) if total > 0 else None,
                "reviewCount": int(row["reviewCount"] or 0),
                "totalCount": total,
            }
        )
    return {"questions": questions}


def get_rank_segments(examId: int, classId: int | None = None) -> dict[str, Any]:
    with connect_db() as conn:
        scores = _scores(conn, examId, classId)
    if not scores:
        return {"segments": [], "count": 0}
    ordered = sorted(scores, reverse=True)
    n = len(ordered)
    buckets = [
        ("top10", 0, max(1, math.ceil(n * 0.1))),
        ("top25", 0, max(1, math.ceil(n * 0.25))),
        ("middle50", math.floor(n * 0.25), max(math.floor(n * 0.75), math.floor(n * 0.25) + 1)),
        ("bottom25", math.floor(n * 0.75), n),
    ]
    segments = []
    for name, start, end in buckets:
        values = ordered[start:end]
        segments.append({"segment": name, "summary": _score_summary(values)})
    return {"count": n, "segments": segments}


def get_review_risks(examId: int, classId: int | None = None, limit: int = 12) -> dict[str, Any]:
    join, where, params = _class_filter("qs", classId)
    with connect_db() as conn:
        rows = conn.execute(
            f"""
            SELECT
              qs.question_number AS questionNumber,
              qs.score_type AS questionType,
              COUNT(*) AS riskCount,
              ROUND(AVG(qs.score), 1) AS avgScore,
              MAX(qs.max_score) AS maxScore
            FROM question_scores qs
            {join}
            WHERE qs.exam_id = ?
              AND (qs.score = 0 OR qs.score < qs.max_score * 0.5)
              {where}
            GROUP BY qs.question_number, qs.score_type
            ORDER BY riskCount DESC, questionNumber ASC
            LIMIT ?
            """,
            [examId, *params, max(1, min(int(limit), 50))],
        ).fetchall()
    return {
        "risks": [
            {
                "questionNumber": str(row["questionNumber"]),
                "questionType": "objective" if row["questionType"] == "objective" else "subjective",
                "riskCount": int(row["riskCount"] or 0),
                "avgScore": _round1(row["avgScore"]),
                "maxScore": _round1(row["maxScore"]),
            }
            for row in rows
        ]
    }

