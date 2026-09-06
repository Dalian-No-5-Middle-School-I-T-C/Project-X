"""Local OpenAI-compatible provider fixture. No external requests or API keys."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import sys
from pathlib import Path

fixture_path = Path(sys.argv[1])
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        has_tool = any(m.get("role") == "tool" for m in body.get("messages", []))
        if body.get("tools") and not has_tool:
            fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
            message = {"role": "assistant", "content": None, "tool_calls": [{"id": "bench-call", "type": "function", "function": {"name": "get_exam_overview", "arguments": json.dumps({"examId": fixture["analysisExamId"]})}}]}
            reason = "tool_calls"
        else:
            report = {"overallJudgement": "四名学生的成绩存在差异。", "distributionInsight": "四个成绩均已纳入统计。", "weakPoints": [], "reviewRisks": [], "teachingSuggestions": ["按题目得分安排复习。"], "nextActions": [], "questionActions": [], "caveats": ["本报告为自动化服务商夹具，不代表真实模型分析质量。"]}
            message = {"role": "assistant", "content": json.dumps(report, ensure_ascii=False)}
            reason = "stop"
        result = {"id": "benchmark", "object": "chat.completion", "model": body.get("model"), "choices": [{"index": 0, "message": message, "finish_reason": reason}], "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}}
        data = json.dumps(result).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

ThreadingHTTPServer(("127.0.0.1", 5293), Handler).serve_forever()
