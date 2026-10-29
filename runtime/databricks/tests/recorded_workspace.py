"""A local socket that replays recorded Databricks and BenchRouter answers, by method and path.

Tests drive the agent's and the app's own HTTP clients against it; nothing inside them is
replaced. Each call is logged, so a test can prove which calls were (and were not) made.
"""

from __future__ import annotations

import json
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from benchrouter_databricks.workspace import Workspace

GRANT_ANSWERS = json.loads((Path(__file__).parent / "fixtures" / "grants" / "answers.json").read_text())
NOT_FOUND = {"status": 404, "body": {"error_code": "RESOURCE_DOES_NOT_EXIST", "message": "recorded: no such object"}}


class RecordedServer:
    """`answers` maps "METHOD /path" (the query excluded) to {status, body}, or to a list of them
    taken in order; anything else is a 404."""

    def __init__(self, answers: dict[str, Any]) -> None:
        self.answers = answers
        self.calls: list[tuple[str, str, dict[str, str], Any]] = []
        server = self

        class Handler(BaseHTTPRequestHandler):
            def _serve(self) -> None:
                parsed = urllib.parse.urlsplit(self.path)
                length = int(self.headers.get("content-length") or 0)
                raw = self.rfile.read(length) if length else b""
                body = json.loads(raw) if raw else None
                query = dict(urllib.parse.parse_qsl(parsed.query))
                server.calls.append((self.command, urllib.parse.unquote(parsed.path), query, body))
                answer = server.answers.get(f"{self.command} {urllib.parse.unquote(parsed.path)}", NOT_FOUND)
                if isinstance(answer, list):
                    # A sequence: each call takes the next answer, and the last one repeats.
                    answer = answer.pop(0) if len(answer) > 1 else answer[0]
                # `raw` is a file's bytes (the Files API); `body` is a JSON answer.
                data = answer["raw"].encode() if "raw" in answer else json.dumps(answer["body"]).encode()
                self.send_response(answer["status"])
                self.send_header("content-type", "application/octet-stream" if "raw" in answer else "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PATCH = _serve  # noqa: N815

            def log_message(self, format: str, *args: object) -> None:
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self._server.server_address[1]}"
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def workspace(self) -> Workspace:
        return Workspace(self.base, lambda: {"authorization": "Bearer recorded"})

    def paths(self) -> list[tuple[str, str]]:
        return [(method, path) for method, path, _, _ in self.calls]

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
