"""Loopback model for the pdf-knowledge stage on the Ubuntu test VM."""
import json
import time
import argparse
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import pymupdf


class PdfProvider(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        if self.path != "/v1/chat/completions" or not 0 < length <= 64 * 1024 * 1024:
            self.send_error(400)
            return
        request = json.loads(self.rfile.read(length))
        images = [
            item["image_url"]["url"]
            for message in request.get("messages", []) if isinstance(message.get("content"), list)
            for item in message["content"] if item.get("type") == "image_url"
        ]
        sizes = []
        try:
            if len(images) != self.server.pages:
                raise ValueError("Page count mismatch")
            for image in images:
                header, encoded = image.split(",", 1)
                if header != "data:image/jpeg;base64":
                    raise ValueError("Expected a rendered JPEG page")
                data = base64.b64decode(encoded, validate=True)
                if not data.startswith(b"\xff\xd8\xff"):
                    raise ValueError("Invalid JPEG")
                page = pymupdf.Pixmap(data)
                if not 0 < min(page.width, page.height) <= max(page.width, page.height) <= 2048:
                    raise ValueError("Unexpected page dimensions")
                sizes.append([page.width, page.height])
        except (ValueError, TypeError, RuntimeError, KeyError):
            self.send_error(400, "Expected the configured number of decoded JPEG pages")
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
        print(json.dumps({"renderedImages": len(sizes), "dimensions": sizes}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pages", type=int, required=True, choices=range(1, 41))
    args = parser.parse_args()
    with ThreadingHTTPServer(("127.0.0.1", 8000), PdfProvider) as server:
        server.pages = args.pages
        print("PDF fixture ready on 127.0.0.1:8000", flush=True)
        server.serve_forever()
