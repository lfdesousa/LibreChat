"""LC-10a probe recorder (ADDENDUM-5 §5 / C1). One file, two modes.

  MODE=api  : reverse proxy IN FRONT OF the LibreChat API (P-2). Records, for
              POST /api/files*, the multipart field NAMES and the value of the
              `conversationId` field ONLY.
  MODE=bff  : stands in for the BFF host name the chart-rendered baseURL names
              (P-1). Records path, inbound header NAMES and the value of
              `x-session-id` ONLY; answers a minimal OpenAI-style reply.

Redaction happens at capture time: Authorization / Cookie / any token value is
never read into a record. Values recorded: conversationId, clientRequestId (the
new-chat seed, a client-minted UUID; AC-P2b), x-session-id.
"""
import email
import email.policy
import http.client
import json
import logging
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

logger = logging.getLogger("recorder")
MODE = os.environ["MODE"]
OUT = os.environ["OUT"]
UPSTREAM = os.environ.get("UPSTREAM", "")
_lock = threading.Lock()
_HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
        "te", "trailers", "transfer-encoding", "upgrade"}


def record(obj):
    with _lock, open(OUT, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(obj, sort_keys=True) + "\n")


def multipart_fields(content_type, body):
    msg = email.message_from_bytes(
        b"Content-Type: " + content_type.encode() + b"\r\n\r\n" + body,
        policy=email.policy.HTTP,
    )
    names, conv, seed = [], None, None
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        names.append(name)
        if name == "conversationId":
            conv = part.get_content().strip()
        elif name == "clientRequestId":
            seed = part.get_content().strip()
    return names, conv, seed


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, fmt, *args):  # no access log: it could carry query strings
        return

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _handle(self):
        body = self._body()
        path = self.path.split("?", 1)[0]
        if MODE == "bff":
            return self._bff(path, body)
        return self._api(path, body)

    def _bff(self, path, body):
        names = sorted({k.lower() for k in self.headers.keys()})
        record({
            "mode": "bff-inbound", "method": self.command, "path": path,
            "header_names": names,
            "x-session-id": self.headers.get("X-Session-Id"),
        })
        out = json.dumps({"id": "probe", "object": "chat.completion", "created": 0,
                          "model": "audittrace-chat",
                          "choices": [{"index": 0, "finish_reason": "stop",
                                       "message": {"role": "assistant", "content": "probe"}}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def _api(self, path, body):
        ctype = self.headers.get("Content-Type", "")
        if self.command == "POST" and path.startswith("/api/files") and ctype.startswith("multipart/"):
            names, conv, seed = multipart_fields(ctype, body)
            record({"mode": "api-inbound", "method": self.command, "path": path,
                    "multipart_field_names": names,
                    "conversationId_present": conv is not None,
                    "conversationId": conv,
                    "clientRequestId_present": seed is not None,
                    "clientRequestId": seed})
        host, port = UPSTREAM.split(":")
        conn = http.client.HTTPConnection(host, int(port), timeout=300)
        headers = {k: v for k, v in self.headers.items() if k.lower() not in _HOP}
        conn.request(self.command, self.path, body=body or None, headers=headers)
        resp = conn.getresponse()
        self.send_response(resp.status)
        for k, v in resp.getheaders():
            if k.lower() in _HOP or k.lower() == "content-length":
                continue
            self.send_header(k, v)
        self.end_headers()
        while chunk := resp.read(4096):
            self.wfile.write(chunk)
            self.wfile.flush()
        conn.close()

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = do_HEAD = _handle


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(os.environ["PORT"])), Handler).serve_forever()
