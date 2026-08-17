"""Event System & Real-Time Broadcasting.

Provides event data models, in-memory buffering, time-partitioned disk logging,
and Server-Sent Events (SSE) broadcasting.
"""
from __future__ import annotations
import asyncio
import datetime
import json
import os
from collections import deque
from pathlib import Path
from typing import Any, AsyncGenerator, Callable, Dict, List, Optional, Set
import uuid

# Event buffer in memory (up to 2000 events)
_EVENTS_BUFFER: deque = deque(maxlen=2000)
_SUBSCRIBERS: Set[asyncio.Queue] = set()
_DATA_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parent.parent / "data"))


def create_event(
    author: str,
    invocation_id: Optional[str] = None,
    content: Optional[Dict[str, Any]] = None,
    actions: Optional[Dict[str, Any]] = None,
    grounding_metadata: Optional[Dict[str, Any]] = None,
    usage_metadata: Optional[Dict[str, Any]] = None,
    error_code: Optional[Any] = None,
    error_message: Optional[str] = None,
) -> Dict[str, Any]:
    """Create an immutable ADK event representation."""
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    return {
        "id": f"ev-{uuid.uuid4().hex[:12]}",
        "timestamp": now_iso,
        "author": author,
        "invocationId": invocation_id or f"inv-{int(datetime.datetime.now().timestamp()*1000)}",
        "content": content or {},
        "actions": actions or {},
        "groundingMetadata": grounding_metadata,
        "usageMetadata": usage_metadata,
        "errorCode": error_code,
        "errorMessage": error_message,
    }


def create_event_actions(state_delta: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Helper to wrap state delta in standard event actions format."""
    return {"stateDelta": state_delta or {}}


def persist_event_to_disk(event: Dict[str, Any]) -> None:
    """Save an event to time-partitioned JSONL data/events/{YYYY}/{MM}/{DD}/{HH}/events.jsonl."""
    try:
        now = datetime.datetime.now(datetime.timezone.utc)
        part_dir = _DATA_DIR / "events" / now.strftime("%Y") / now.strftime("%m") / now.strftime("%d") / now.strftime("%H")
        part_dir.mkdir(parents=True, exist_ok=True)
        file_path = part_dir / "events.jsonl"
        with open(file_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(event) + "\n")
    except Exception as e:
        print(f"[events] Warning: failed to persist event to disk: {e}")


def emit_adk_event(event: Dict[str, Any]) -> None:
    """Emit an event to in-memory history, disk, and all active SSE subscribers."""
    _EVENTS_BUFFER.append(event)
    persist_event_to_disk(event)

    # Broadcast to all live SSE queues
    for q in list(_SUBSCRIBERS):
        try:
            q.put_nowait(event)
        except Exception:
            pass


def get_memory_events(
    type_filter: Optional[str] = None,
    author_filter: Optional[str] = None,
    status_filter: Optional[str] = None,
    search_filter: Optional[str] = None,
    session_id: Optional[str] = None,
    from_disk: bool = False,
    limit: Optional[int] = 100,
) -> List[Dict[str, Any]]:
    """Query recent events with optional filtering."""
    events_list = list(_EVENTS_BUFFER)
    
    if from_disk:
        try:
            disk_events = []
            events_root = _DATA_DIR / "events"
            if events_root.exists():
                for p in sorted(events_root.glob("*/*/*/*/*.jsonl"), reverse=True):
                    with open(p, "r", encoding="utf-8") as f:
                        for line in f:
                            line = line.strip()
                            if line:
                                try:
                                    disk_events.append(json.loads(line))
                                except Exception:
                                    pass
            events_list = disk_events or events_list
        except Exception as e:
            print(f"[events] Warning reading disk events: {e}")

    filtered = []
    for ev in events_list:
        if author_filter and ev.get("author") != author_filter:
            continue
        state_delta = ev.get("actions", {}).get("stateDelta", {})
        ev_type = state_delta.get("eventType")
        if type_filter and ev_type != type_filter:
            continue
        ev_status = state_delta.get("status")
        if status_filter and ev_status != status_filter:
            continue
        if search_filter:
            text_repr = json.dumps(ev).lower()
            if search_filter.lower() not in text_repr:
                continue
        filtered.append(ev)

    if limit:
        return filtered[-limit:]
    return filtered


def clear_memory_events(clear_disk: bool = False) -> None:
    """Clear in-memory and optionally disk events."""
    _EVENTS_BUFFER.clear()
    if clear_disk:
        try:
            events_root = _DATA_DIR / "events"
            if events_root.exists():
                for p in events_root.glob("*/*/*/*/*.jsonl"):
                    try:
                        p.unlink()
                    except Exception:
                        pass
        except Exception as e:
            print(f"[events] Warning clearing disk events: {e}")


async def subscribe_events() -> AsyncGenerator[Dict[str, Any], None]:
    """Async generator yielding events for SSE clients."""
    q: asyncio.Queue = asyncio.Queue()
    _SUBSCRIBERS.add(q)
    try:
        while True:
            ev = await q.get()
            yield ev
    finally:
        _SUBSCRIBERS.discard(q)
