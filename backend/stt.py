"""Audio Transcription Service.

Handles real-time audio chunk processing, speaker identification, and transcript generation.
"""
from __future__ import annotations
import base64
import os
import re
from typing import Any, Dict, List, Optional
from google import genai
from google.genai import types
from backend.events import emit_adk_event, create_event, create_event_actions

MODEL = os.environ.get("GEMINI_MODEL") or os.environ.get("MODEL") or "gemini-3.7-flash"


def get_gemini_client() -> genai.Client:
    """Instantiate a Gemini Client using Vertex AI (project/location/ADC) or API key."""
    use_vertex = (
        os.environ.get("GOOGLE_GENAI_USE_VERTEXAI", "").lower() in ("true", "1")
        or os.environ.get("GOOGLE_GENAI_USE_ENTERPRISE", "").lower() in ("true", "1")
        or bool(os.environ.get("GOOGLE_CLOUD_PROJECT"))
    )
    if use_vertex:
        project = os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("PROJECT_ID")
        location = os.environ.get("GOOGLE_CLOUD_LOCATION") or os.environ.get("LOCATION") or "us-central1"
        return genai.Client(vertexai=True, project=project, location=location)
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    return genai.Client(api_key=api_key)


async def transcribe_audio_chunk(
    audio_base64: str,
    mime_type: str = "audio/webm",
    source: str = "mic",
    enable_diarization: bool = False,
    min_speakers: int = 1,
    max_speakers: int = 5,
    api_key: Optional[str] = None,
) -> Dict[str, Any]:
    """Transcribe an audio chunk into verbatim or speaker-labeled text."""
    # Clean base64 header if present
    clean_b64 = re.sub(r"^data:audio/[^;]+;base64,", "", audio_base64)
    audio_bytes = base64.b64decode(clean_b64)
    
    prompt = (
        "Transcribe the spoken audio verbatim. If multiple distinct speakers are talking, separate their turns and "
        "prefix each turn with a clear speaker label (e.g., 'Speaker 1: ...', 'Speaker 2: ...'). If speakers introduce themselves "
        "or address each other by name (e.g., 'Hi Alice', 'Thanks Bob'), use their actual names as the speaker label. "
        "If only one person is speaking, transcribe verbatim without speaker labels. No markdown formatting, timestamps, "
        "or commentary — return only the transcribed speech in English. If the clip has no discernible speech (silence, noise, music only), "
        "return an empty string."
    )
    
    client = get_gemini_client(api_key)
    part = types.Part.from_bytes(data=audio_bytes, mime_type=mime_type or "audio/webm")
    
    response = client.models.generate_content(
        model=MODEL,
        contents=[part, prompt],
    )
    
    text = (response.text or "").strip()
    
    # Parse turns if speaker labels were generated
    turns = []
    lines = text.split("\n")
    for line in lines:
        match = re.match(r"^([^:]+):\s*(.*)$", line.strip())
        if match:
            turns.append({"speaker": match.group(1).strip(), "text": match.group(2).strip()})
            
    # Emit ADK STT event
    emit_adk_event(
        create_event(
            author="gemini_stt",
            content={"role": "model", "parts": [{"text": text}]},
            actions=create_event_actions({
                "eventType": "stt:transcribe",
                "provider": "gemini",
                "charCount": len(text),
                "speakerTurns": len(turns),
                "diarizationEnabled": enable_diarization,
                "source": source,
            }),
        )
    )
    
    return {
        "text": text,
        "source": source,
        "provider": "gemini",
        "turns": turns if turns else None,
    }
