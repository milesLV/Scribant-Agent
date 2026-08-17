"""Scribant API Server.

FastAPI application providing endpoints for live transcription, multi-stage agent orchestration,
grounded web research, Google Workspace tool execution, and real-time SSE telemetry streams.
"""
from __future__ import annotations
import asyncio
import datetime
import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional
import dotenv
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles

# Load environment variables
dotenv.load_dotenv()

from backend.models import (
    AnalyzeRequest,
    LivePipelineRequest,
    TranscribeCorrectRequest,
    SearchRequest,
    TranscribeAudioRequest,
    ExecuteRequest,
    EventsClearRequest,
)
from backend.events import (
    emit_adk_event,
    get_memory_events,
    clear_memory_events,
    subscribe_events,
    create_event,
    create_event_actions,
)
from backend.stt import transcribe_audio_chunk
from backend.queue_manager import message_queue
from backend.agents import orchestrator, root_agent, search_agent
from backend.workspace_tools import execute_workspace_action

app = FastAPI(
    title="Scribant Agent API",
    description="Python ADK Multi-Agent Thought Partner Backend",
    version="2.0.0",
    docs_url="/docs",
    openapi_url="/api/openapi.json",
)

# CORS middleware for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent


@app.get("/api/config")
async def get_config() -> Dict[str, Any]:
    """Return Google Client ID from credentials.json if present."""
    creds_path = PROJECT_ROOT / "credentials.json"
    if creds_path.exists():
        try:
            with open(creds_path, "r", encoding="utf-8") as f:
                creds = json.load(f)
                client_id = (creds.get("installed") or creds.get("web") or {}).get("client_id")
                return {"googleClientId": client_id}
        except Exception:
            pass
    return {"googleClientId": None}


@app.post("/api/live")
async def handle_live_pipeline(req: LivePipelineRequest) -> StreamingResponse:
    """Execute the multi-stage pipeline and stream results as Newline-Delimited JSON (NDJSON)."""
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is required.")

    ref_iso = req.currentLocalTime or datetime.datetime.now(datetime.timezone.utc).isoformat()
    stages = {"proof", "summary"} if req.withPlan is False else {"proof", "summary", "plan"}

    async def event_generator():
        q: asyncio.Queue = asyncio.Queue()

        def _on_stage(stage: str, payload: Any):
            q.put_nowait({"stage": stage, **payload})

        async def _run():
            try:
                await orchestrator.run_pipeline(
                    text=text,
                    stages=stages,
                    ref_iso=ref_iso,
                    live_summary=req.liveSummary or "",
                    on_stage=_on_stage,
                )
            except Exception as e:
                q.put_nowait({"stage": "fatal", "error": str(e)})
            finally:
                q.put_nowait(None)

        asyncio.create_task(_run())

        while True:
            item = await q.get()
            if item is None:
                break
            yield json.dumps(item) + "\n"

    return StreamingResponse(
        event_generator(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/analyze")
async def handle_analyze(req: AnalyzeRequest) -> Dict[str, Any]:
    """Run full intent classification to extract calendar events, tasks, and search queries."""
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is required.")

    ref_iso = req.currentLocalTime or datetime.datetime.now(datetime.timezone.utc).isoformat()
    res = await orchestrator.run_pipeline(
        text=text,
        stages={"plan"},
        ref_iso=ref_iso,
        live_summary=req.liveSummary or "",
    )
    return res.get("plan", {})


@app.post("/api/transcribe-correct")
async def handle_transcribe_correct(req: TranscribeCorrectRequest) -> Dict[str, Any]:
    """Phonetic and typo proofreading only."""
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is required.")

    res = await orchestrator.run_proofread(text)
    return {"corrections": res.get("corrections", []), "words": res.get("words", [])}


@app.post("/api/transcribe-audio")
async def handle_transcribe_audio(req: TranscribeAudioRequest) -> Dict[str, Any]:
    """Dedicated STT endpoint: decodes audio chunk and pushes transcript into Message Queue."""
    res = await transcribe_audio_chunk(
        audio_base64=req.audio,
        mime_type=req.mimeType or "audio/webm",
        source=req.source or "mic",
        enable_diarization=bool(req.enableDiarization),
        min_speakers=req.minSpeakers or 1,
        max_speakers=req.maxSpeakers or 5,
    )
    # Push newly transcribed voice to message queue
    if res.get("text"):
        await message_queue.push_transcript("default_session", res)
    return res


@app.post("/api/search")
async def handle_search(req: SearchRequest) -> Dict[str, Any]:
    """Execute grounded web research via Search Agent."""
    query = req.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Query is required.")
    return await orchestrator.run_search(query)


@app.post("/api/execute")
async def handle_execute(req: ExecuteRequest) -> Dict[str, Any]:
    """Execute or undo a Google Workspace action (or Sandbox mode)."""
    return await execute_workspace_action(
        kind=req.kind,
        item=req.item or {},
        access_token=req.accessToken,
        action=req.action or "execute",
        resource_id=req.id,
    )


@app.get("/api/stt/status")
async def get_stt_status() -> Dict[str, Any]:
    """Report STT service readiness."""
    has_gemini = bool(os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"))
    return {
        "available": has_gemini,
        "authenticated": has_gemini,
        "projectId": os.environ.get("GOOGLE_CLOUD_PROJECT", "local-project"),
        "defaultMinSpeakers": 1,
        "defaultMaxSpeakers": 5,
        "supportedModels": ["gemini-3.7-flash", "chirp_2", "default"],
    }


# ---- ADK & Memory Events Endpoints -----------------------------------------

@app.get("/api/adk/events")
@app.get("/api/memory/events")
async def get_events_handler(
    type: Optional[str] = None,
    author: Optional[str] = None,
    status: Optional[str] = None,
    search: Optional[str] = None,
    fromDisk: Optional[bool] = False,
    limit: Optional[int] = 100,
) -> Dict[str, Any]:
    """Fetch recent recorded events."""
    events = get_memory_events(
        type_filter=type,
        author_filter=author,
        status_filter=status,
        search_filter=search,
        from_disk=bool(fromDisk),
        limit=limit,
    )
    return {"ok": True, "count": len(events), "events": events}


@app.post("/api/adk/events/clear")
@app.post("/api/memory/events/clear")
async def clear_events_handler(req: Optional[EventsClearRequest] = None) -> Dict[str, Any]:
    """Clear recorded events history."""
    clear_disk = req.clearDisk if req else False
    clear_memory_events(clear_disk=bool(clear_disk))
    return {"ok": True, "clearedDisk": clear_disk}


@app.get("/api/adk/events/stream")
@app.get("/api/memory/events/stream")
async def sse_events_stream_handler(request: Request) -> StreamingResponse:
    """Stream real-time ADK events over Server-Sent Events (SSE)."""
    async def sse_gen():
        # Send initial snapshot of recent events
        initial_events = get_memory_events(limit=50)
        yield f"data: {json.dumps({'type': 'init', 'events': initial_events})}\n\n"

        async for ev in subscribe_events():
            if await request.is_disconnected():
                break
            yield f"data: {json.dumps({'type': 'event', 'event': ev})}\n\n"

    return StreamingResponse(
        sse_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ---- Lightweight Status & Telemetry Endpoints -----------------------------

@app.get("/api/tokens/stats")
async def get_token_stats() -> Dict[str, Any]:
    return {
        "ok": True,
        "status": "optimal",
    }


@app.get("/api/tokens/telemetry/timeseries")
async def get_token_timeseries() -> Dict[str, Any]:
    return {"ok": True, "data": []}


@app.get("/api/tokens/telemetry/aggregate")
async def get_token_aggregate() -> Dict[str, Any]:
    return {"ok": True, "aggregate": {}}


@app.get("/api/tokens/telemetry/stream")
async def get_token_stream(request: Request) -> StreamingResponse:
    async def sse():
        while not await request.is_disconnected():
            await asyncio.sleep(10.0)
            yield ": ping\n\n"
    return StreamingResponse(sse(), media_type="text/event-stream")


@app.post("/api/memory/ingest")
@app.post("/api/memory/sync")
@app.get("/api/memory/retrieve")
@app.post("/api/memory/retrieve")
@app.get("/api/memory/search")
@app.post("/api/memory/search")
async def handle_memory_noop() -> Dict[str, Any]:
    """Lightweight memory endpoint response (Vertex AI Memory disabled)."""
    return {"ok": True, "memories": [], "answer": None}


# ---- Static Single Page App (SPA) Handling ---------------------------------

dist_dir = PROJECT_ROOT / "dist"
if dist_dir.exists():
    app.mount("/assets", StaticFiles(directory=dist_dir / "assets"), name="assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        file_path = dist_dir / full_path
        if full_path and file_path.exists() and file_path.is_file():
            return FileResponse(file_path)
        index_file = dist_dir / "index.html"
        if index_file.exists():
            return FileResponse(index_file)
        return JSONResponse({"message": "Scribant Python API running. Build frontend with 'npm run build'."})


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 3000))
    print(f"Starting Scribant Python Server on http://127.0.0.1:{port}")
    uvicorn.run("backend.server:app", host="127.0.0.1", port=port, reload=True)
