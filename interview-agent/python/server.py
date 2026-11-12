"""Local-only audio transcription and speaker identification service."""

from __future__ import annotations

import io
import json
import os
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel

HOST = "127.0.0.1"
PORT = 8765
MODEL_NAME = os.environ.get("WHISPER_MODEL", "base.en")
MODEL_DIR = os.environ.get("WHISPER_MODEL_DIR")
SPEAKER_MODEL_PATH = Path(os.environ.get("SPEAKER_MODEL_PATH", ""))
SPEAKER_PROFILE_PATH = Path(
    os.environ.get(
        "SPEAKER_PROFILE_PATH",
        str(Path(MODEL_DIR or Path.home()) / "speaker-profile.npy"),
    )
)
SPEAKER_MATCH_THRESHOLD = 0.6

print(f"Loading local Whisper model {MODEL_NAME}...", flush=True)
model = WhisperModel(
    MODEL_NAME,
    device="cpu",
    compute_type="int8",
    cpu_threads=max(2, min(8, os.cpu_count() or 4)),
    download_root=MODEL_DIR,
)

speaker_extractor = None
speaker_profile: np.ndarray | None = None
try:
    if not SPEAKER_MODEL_PATH.is_file():
        raise FileNotFoundError("speaker embedding model was not installed")
    import sherpa_onnx

    speaker_config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=str(SPEAKER_MODEL_PATH),
        num_threads=1,
        provider="cpu",
    )
    if not speaker_config.validate():
        raise ValueError("speaker embedding model configuration is invalid")
    speaker_extractor = sherpa_onnx.SpeakerEmbeddingExtractor(speaker_config)
    if SPEAKER_PROFILE_PATH.is_file():
        try:
            loaded_profile = np.load(SPEAKER_PROFILE_PATH, allow_pickle=False).astype(np.float32)
            if loaded_profile.ndim == 1 and loaded_profile.size == speaker_extractor.dim:
                speaker_profile = loaded_profile
        except Exception as exc:
            print(f"Saved voice signature could not be loaded: {type(exc).__name__}", flush=True)
    print("Local speaker identification is ready.", flush=True)
except Exception as exc:
    speaker_extractor = None
    speaker_profile = None
    print(f"Local speaker identification unavailable: {type(exc).__name__}: {exc}", flush=True)

print(f"Ready at http://{HOST}:{PORT}", flush=True)


def parse_wav(audio: bytes) -> np.ndarray:
    with wave.open(io.BytesIO(audio), "rb") as wav_file:
        if (
            wav_file.getnchannels() != 1
            or wav_file.getsampwidth() != 2
            or wav_file.getframerate() != 16000
            or wav_file.getcomptype() != "NONE"
        ):
            raise ValueError("expected mono 16 kHz PCM audio")
        samples = np.frombuffer(wav_file.readframes(wav_file.getnframes()), dtype=np.int16)
    return np.ascontiguousarray(samples.astype(np.float32) / 32768.0)


def embed_speaker(samples: np.ndarray) -> np.ndarray:
    if speaker_extractor is None:
        raise RuntimeError("speaker identification model is not available")
    stream = speaker_extractor.create_stream()
    try:
        stream.accept_waveform(sample_rate=16000, waveform=np.ascontiguousarray(samples, dtype=np.float32))
        stream.input_finished()
        if not speaker_extractor.is_ready(stream):
            raise ValueError("audio is too short for speaker identification")
        embedding = np.asarray(speaker_extractor.compute(stream), dtype=np.float32)
    finally:
        stream.release()
    norm = float(np.linalg.norm(embedding))
    if not np.isfinite(norm) or norm <= 1e-8:
        raise ValueError("could not create a voice signature from this audio")
    return embedding / norm


def identify_speaker(samples: np.ndarray) -> tuple[str, float | None]:
    if speaker_profile is None or len(samples) < 16_000:
        return "unknown", None
    embedding = embed_speaker(samples)
    similarity = float(np.dot(speaker_profile, embedding))
    # This mode is intended for a two-person interview: the enrolled voice is
    # the candidate, and the other clear speaking voice is the interviewer.
    label = "you" if similarity >= SPEAKER_MATCH_THRESHOLD else "interviewer"
    return label, similarity


class Handler(BaseHTTPRequestHandler):
    server_version = "InterviewCopilotASR/1.1"

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_audio(self) -> np.ndarray | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send(400, {"error": "invalid content length"})
            return None
        if length < 44 or length > 8_000_000:
            self._send(413, {"error": "audio chunk size is outside the accepted range"})
            return None
        audio = self.rfile.read(length)
        if len(audio) != length:
            self._send(400, {"error": "incomplete audio chunk"})
            return None
        try:
            return parse_wav(audio)
        except Exception as exc:
            self._send(400, {"error": str(exc)})
            return None

    def do_GET(self) -> None:
        if self.path not in ("/health", "/speaker/status"):
            self._send(404, {"error": "not found"})
            return
        self._send(
            200,
            {
                "status": "ok",
                "model": MODEL_NAME,
                "device": "cpu",
                "speakerRecognition": speaker_extractor is not None,
                "voiceProfile": speaker_profile is not None,
            },
        )

    def do_POST(self) -> None:
        global speaker_profile

        if self.path == "/speaker/clear":
            try:
                SPEAKER_PROFILE_PATH.unlink(missing_ok=True)
                speaker_profile = None
                self._send(200, {"status": "ok", "voiceProfile": False})
            except OSError:
                self._send(500, {"error": "could not clear the local voice profile"})
            return

        if self.path not in ("/transcribe", "/speaker/enroll"):
            self._send(404, {"error": "not found"})
            return

        if self.path == "/speaker/enroll" and speaker_extractor is None:
            self._send(503, {"error": "local speaker identification is not installed"})
            return

        samples = self._read_audio()
        if samples is None:
            return

        if self.path == "/speaker/enroll":
            if len(samples) < 4 * 16_000:
                self._send(400, {"error": "record at least four seconds of clear speech"})
                return
            if float(np.sqrt(np.mean(np.square(samples)))) < 0.002:
                self._send(400, {"error": "no clear speech was detected in the sample"})
                return
            try:
                profile = embed_speaker(samples)
                SPEAKER_PROFILE_PATH.parent.mkdir(parents=True, exist_ok=True)
                temporary_path = SPEAKER_PROFILE_PATH.with_suffix(".tmp")
                with temporary_path.open("wb") as profile_file:
                    np.save(profile_file, profile, allow_pickle=False)
                temporary_path.replace(SPEAKER_PROFILE_PATH)
                speaker_profile = profile
                self._send(200, {"status": "ok", "voiceProfile": True})
            except Exception as exc:
                print(f"Voice enrollment error: {type(exc).__name__}: {exc}", flush=True)
                self._send(500, {"error": "could not create the local voice profile"})
            return

        speaker = "unknown"
        similarity = None
        if self.headers.get("X-Identify-Speaker", "").lower() == "true":
            if speaker_extractor is None or speaker_profile is None:
                self._send(409, {"error": "record your voice sample before using external call mode"})
                return
            try:
                speaker, similarity = identify_speaker(samples)
            except Exception as exc:
                print(f"Speaker identification error: {type(exc).__name__}: {exc}", flush=True)

        try:
            segments, info = model.transcribe(
                samples,
                language="en" if MODEL_NAME.endswith(".en") else None,
                beam_size=1,
                best_of=1,
                temperature=0.0,
                vad_filter=True,
                condition_on_previous_text=False,
            )
            text = " ".join(segment.text.strip() for segment in segments).strip()
            self._send(
                200,
                {"text": text, "language": info.language, "speaker": speaker, "speakerSimilarity": similarity},
            )
        except Exception as exc:  # Keep audio data and full paths out of HTTP responses.
            print(f"Transcription error: {type(exc).__name__}: {exc}", flush=True)
            self._send(500, {"error": "local transcription failed"})

    def log_message(self, _format: str, *_args) -> None:
        return


ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
