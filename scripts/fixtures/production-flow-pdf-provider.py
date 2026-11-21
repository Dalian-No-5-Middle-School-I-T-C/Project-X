"""Loopback model for the pdf-knowledge stage on the Ubuntu test VM."""
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class PdfProvider(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        if self.path != "/v1/chat/completions" or not 0 < length <= 64 * 1024 * 1024:
            self.send_error(400)
            return
        request = json.loads(self.rfile.read(length))
        images = sum(
            item.get("type") == "image_url"
            for message in request.get("messages", []) if isinstance(message.get("content"), list)
            for item in message["content"]
        )
        if not images:
            self.send_error(400, "Expected rendered paper pages")
            return
        # Keep two real requests in flight while the third reaches admission.
        time.sleep(1)
        points = {"knowledgePoints": [{"questionNumber": 1, "points": ["一二三四五六七八九十十一十二"]}]}
        message = {"role": "assistant", "content": json.dumps(points, ensure_ascii=False)}
        response = {
            "object": "chat.completion", "id": "pdf-knowledge", "model": request["model"],
            "created": int(time.time()), "choices": [{"index": 0, "message": message, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 30, "completion_tokens": 7, "total_tokens": 37},
        }
        body = json.dumps(response).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        print(json.dumps({"renderedImages": images}), flush=True)


if __name__ == "__main__":
    with ThreadingHTTPServer(("127.0.0.1", 8000), PdfProvider) as server:
        print("PDF fixture ready on 127.0.0.1:8000", flush=True)
        server.serve_forever()
