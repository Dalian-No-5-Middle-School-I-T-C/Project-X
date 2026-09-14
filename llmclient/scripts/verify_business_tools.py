"""Read-only business regression against a configured test database."""
import argparse
import json
import sqlite3
from unittest.mock import patch
from datetime import datetime
from decimal import Decimal
from llmclient.tools.grades import QueryResult, _round1, _score_context, _score_summary, get_score_distribution
from llmclient.providers import _parse_report
from llmclient.tools.registry import FUNCTION_DECLARATIONS, call_tool

parser = argparse.ArgumentParser()
parser.add_argument("--exam-id", type=int, required=True)
args = parser.parse_args()
sample = QueryResult([{"created_at": datetime(2026, 9, 5), "score": Decimal("12.5")}]).fetchone()
assert sample["score"] == 12.5
json.dumps(sample)
assert _round1(1.25) == 1.3
for invalid in ('{}', '{"report":{}}'):
    try:
        _parse_report(invalid)
        raise AssertionError("Empty AI report was accepted")
    except ValueError:
        pass
with sqlite3.connect(":memory:") as conn:
    conn.row_factory = sqlite3.Row
    conn.executescript("""
      CREATE TABLE question_scores(exam_id INT,question_number INT,score_type TEXT,max_score REAL);
      INSERT INTO question_scores VALUES(1,1,'objective',150);
      CREATE TABLE student_scores(exam_id INT,student_id INT,total_score REAL);
      INSERT INTO student_scores VALUES(1,1,59.5),(1,2,90),(1,3,135),(1,4,150);
      CREATE TABLE system_settings(`key` TEXT,value TEXT);
      INSERT INTO system_settings VALUES('analysis_pass_rate','0.6'),('analysis_excellent_rate','0.9');
    """)
    context = _score_context(conn, 1)
    summary = _score_summary([59.5, 90, 135, 150], context)
    assert (summary['passScore'], summary['excellentScore'], summary['passRate'], summary['excellentRate']) == (90, 135, 75, 50)
    with patch('llmclient.tools.grades.connect_db', return_value=conn):
        distribution = get_score_distribution(1)
        assert sum(row['count'] for row in distribution['distribution']) == 4
print("PASS non-100-point thresholds, fractional bands and empty AI report rejection")
for declaration in FUNCTION_DECLARATIONS:
    for class_id in (None, 0):
        result = call_tool(declaration["name"], {"examId": args.exam_id}, args.exam_id, class_id)
        assert "error" not in result, result
        json.dumps(result, ensure_ascii=False)
    print("PASS", declaration["name"])
