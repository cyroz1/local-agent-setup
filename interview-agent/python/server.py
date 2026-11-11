"""Local-only audio transcription service for Interview Copilot."""

from __future__ import annotations

import json
import os
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from faster_whisper import WhisperModel

HOST = "127.0.0.1"
PORT = 8765
MODEL_NAME = os.environ.get("WHISPER_MODEL", "base.en")
MODEL_DIR = os.environ.get("WHISPER_MODEL_DIR")

print(f"Loading local Whisper model {MODEL_NAME}...", flush=True)
model = WhisperModel(
    MODEL_NAME,
    device="cpu",
    compute_type="int8",
    cpu_threads=max(2, min(8, os.cpu_count() or 4)),
    download_root=MODEL_DIR,
)
print(f"Ready at http://{HOST}:{PORT}", flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "InterviewCopilotASR/1.0"

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path != "/health":
            self._send(404, {"error": "not found"})
            return
        self._send(200, {"status": "ok", "model": MODEL_NAME, "device": "cpu"})

    def do_POST(self) -> None:
        if self.path != "/transcribe":
            self._send(404, {"error": "not found"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send(400, {"error": "invalid content length"})
            return
        if length < 44 or length > 8_000_000:
            self._send(413, {"error": "audio chunk size is outside the accepted range"})
            return

        audio = self.rfile.read(length)
        if len(audio) != length:
            self._send(400, {"error": "incomplete audio chunk"})
            return

        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as audio_file:
                audio_file.write(audio)
                temp_path = Path(audio_file.name)
            segments, info = model.transcribe(
                str(temp_path),
                language="en" if MODEL_NAME.endswith(".en") else None,
                beam_size=1,
                best_of=1,
                temperature=0.0,
                vad_filter=True,
                condition_on_previous_text=False,
            )
            text = " ".join(segment.text.strip() for segment in segments).strip()
            self._send(200, {"text": text, "language": info.language})
        except Exception as exc:  # Keep audio data and full paths out of HTTP responses.
            print(f"Transcription error: {type(exc).__name__}: {exc}", flush=True)
            self._send(500, {"error": "local transcription failed"})
        finally:
            if temp_path is not None:
                try:
                    temp_path.unlink(missing_ok=True)
                except OSError:
                    pass

    def log_message(self, _format: str, *_args) -> None:
        return


HTTPServer((HOST, PORT), Handler).serve_forever()
