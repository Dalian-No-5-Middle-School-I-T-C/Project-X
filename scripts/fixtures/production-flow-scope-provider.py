"""Serve the bounded AI scope acceptance runs on loopback."""
import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

MODEL = "e2e-scope-check"
OUTSIDE = 2_000_000_001


def run(exam, group, port, class_summaries=False):
    arguments = {
        "other-exam": {"examId": OUTSIDE, "classId": group},
        "other-class": {"examId": exam, "classId": OUTSIDE},
        "selected": {"examId": exam, "classId": group},
    }
    tool = "get_exam_overview"
    if class_summaries:
        tool = "get_class_summaries"
        arguments = {"summary": {"examId": exam}}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            size = int(self.headers.get("Content-Length", 0))
            if self.path != "/v1/chat/completions" or not 0 < size <= 524288:
                self.send_error(400)
                return
            request = json.loads(self.rfile.read(size))
            if request.get("model") != MODEL or not request.get("tools"):
                self.send_error(400)
                return
            results = {m["tool_call_id"]: json.loads(m["content"])
                       for m in request["messages"] if m["role"] == "tool"}
            message = {"role": "assistant"}
            if not results:
                message.update(content=None, tool_calls=[
                    {"id": key, "type": "function", "function": {
                        "name": tool, "arguments": json.dumps(value)}}
                    for key, value in arguments.items()])
            elif class_summaries:
                result = results["summary"]
                observed = {"scopedClassId": result["scopedClassId"], "classes": [
                    {"id": row["classId"], "count": row["summary"]["count"], "avg": row["summary"]["avg"]}
                    for row in result["classes"]]}
                print(json.dumps(observed), flush=True)
            else:
                assert set(results) == set(arguments)
                assert results["other-exam"] == {"error": "tool examId must match the selected exam"}
                assert results["other-class"] == {"error": "tool classId must match the selected class"}
                control = results["selected"]
                assert control["exam"]["id"] == exam and control["classId"] == group
                assert control["summary"]["count"] > 0
                print(json.dumps({"deniedExamFields": sorted(results["other-exam"]),
                                  "deniedClassFields": sorted(results["other-class"]),
                                  "exam": exam, "class": group, "count": control["summary"]["count"]}), flush=True)
            if results:
                message["content"] = json.dumps({"overallJudgement": "Scope check completed.",
                                                 "distributionInsight": json.dumps(observed) if class_summaries else "Selected class verified.",
                                                 "weakPoints": [], "reviewRisks": [], "teachingSuggestions": [],
                                                 "nextActions": [], "questionActions": [], "caveats": []})
            body = json.dumps({"id": "scope-check", "object": "chat.completion", "model": MODEL,
                               "created": int(time.time()), "choices": [{"index": 0, "message": message,
                               "finish_reason": "stop" if results else "tool_calls"}],
                               "usage": {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            if results:
                self.server.remaining -= 1

    if not (0 < exam < OUTSIDE and (class_summaries or 0 < group < OUTSIDE)):
        raise ValueError("Select the seeded test exam and class")
    with HTTPServer(("127.0.0.1", port), Handler) as server:
        server.timeout = 2
        server.remaining = 2 if class_summaries else 1
        print("Scope fixture ready", flush=True)
        deadline = time.monotonic() + 150
        while server.remaining and time.monotonic() < deadline:
            server.handle_request()
        if server.remaining:
            raise TimeoutError("Did not receive all expected tool results")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--exam", required=True, type=int)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--class-id", type=int)
    mode.add_argument("--class-summaries", action="store_true")
    parser.add_argument("--port", type=int, default=1234)
    args = parser.parse_args()
    run(args.exam, args.class_id, args.port, args.class_summaries)
