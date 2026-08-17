"""Asynchronous Message Queue.

Buffers and queues transcribed voice segments for downstream multi-agent processing.
"""
from __future__ import annotations
import asyncio
from typing import Any, Dict, List, Optional
from collections import defaultdict


class TranscribedMessageQueue:
    """Async buffer and message queue for incoming voice transcription chunks."""

    def __init__(self) -> None:
        self._queues: Dict[str, asyncio.Queue] = defaultdict(asyncio.Queue)
        self._buffers: Dict[str, List[Dict[str, Any]]] = defaultdict(list)

    async def push_transcript(self, session_id: str, item: Dict[str, Any]) -> None:
        """Push a newly transcribed voice chunk to the session queue and buffer."""
        self._buffers[session_id].append(item)
        await self._queues[session_id].put(item)

    async def get_next_transcript(self, session_id: str, timeout: Optional[float] = None) -> Optional[Dict[str, Any]]:
        """Pop the next transcript chunk from the queue."""
        q = self._queues[session_id]
        if timeout:
            try:
                return await asyncio.wait_for(q.get(), timeout=timeout)
            except asyncio.TimeoutError:
                return None
        return await q.get()

    def get_buffered_text(self, session_id: str) -> str:
        """Get the full concatenated transcript buffer so far for a session."""
        chunks = [c.get("text", "") for c in self._buffers[session_id] if c.get("text")]
        return " ".join(chunks)

    def clear(self, session_id: str) -> None:
        """Clear the queue and buffer for a session."""
        self._buffers.pop(session_id, None)
        self._queues.pop(session_id, None)


# Global instance
message_queue = TranscribedMessageQueue()
