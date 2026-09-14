"""Independent assertions; imports the selected product, never its test scripts."""
import inspect
import json
import sys
from datetime import datetime
from decimal import Decimal
from llmclient.tools import grades
from llmclient.tools.registry import call_tool
from llmclient.providers import _parse_report

fixture = json.load(open(sys.argv[1], encoding="utf-8"))
exam = fixture["analysisExamId"]
results = []

def check(id, title, family, fn):
    try:
        evidence = fn()
        results.append(dict(id=id, title=title, family=family, status="PASS", evidence=evidence))
    except Exception as error:
        results.append(dict(id=id, title=title, family=family, status="FAIL", evidence=str(error)))

def tool(name):
    result = call_tool(name, {"examId": exam}, exam, None)
    assert "error" not in result, result
    json.dumps(result, ensure_ascii=False)
    return result

check("B08", "AI 考试概况在 MariaDB 上可执行", "ai-overview-sql", lambda: tool("get_exam_overview"))
check("B09", "AI 数据结果可序列化日期和小数", "ai-result-serialization",
      lambda: json.dumps(grades.QueryResult([{"time": datetime(2026, 9, 5), "score": Decimal("12.5")}]).fetchone()))
check("B10", "AI 阅卷风险查询兼容 MariaDB", "ai-risk-sql", lambda: tool("get_review_risks"))
check("B11", "知识点工具接受注册表声明的参数", "ai-knowledge-contract", lambda: tool("get_knowledge_point_weaknesses"))

def direct_knowledge():
    handler = grades.get_knowledge_point_weaknesses
    # Use the declared signature to isolate database access from registry binding.
    value = handler(**{next(iter(inspect.signature(handler).parameters)): exam})
    assert "error" not in value, value
    return value
check("B12", "知识点工具可打开数据库连接", "ai-knowledge-connection", direct_knowledge)

def thresholds():
    summary = tool("get_score_distribution")["summary"]
    assert summary["passRate"] == 50 and summary["excellentRate"] == 25, summary
    return summary
check("B13", "150 分制按配置计算及格率和优秀率", "ai-score-thresholds", thresholds)

def distribution():
    value = tool("get_score_distribution")
    count = sum(row["count"] for row in value["distribution"])
    assert count == 4, {"expected": 4, "actual": count, "distribution": value["distribution"]}
    return value["distribution"]
check("B14", "分数段完整覆盖小数及超过 100 分的成绩", "ai-distribution", distribution)

def empty_report():
    for raw in ("{}", '{"report":{}}'):
        try:
            _parse_report(raw)
        except ValueError:
            continue
        raise AssertionError("Empty report accepted: " + raw)
    return "Both empty report forms rejected"
check("B15", "AI 空报告不能作为成功结果", "ai-empty-report", empty_report)
print("BENCH_RESULTS=" + json.dumps(results, ensure_ascii=False, default=str))
