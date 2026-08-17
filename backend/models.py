"""Data Models and Request/Response Schemas.

Pydantic schemas for API validation and structured agent outputs.
"""
from __future__ import annotations
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class CalendarEventItem(BaseModel):
    title: str = Field(description="Event summary/title")
    description: Optional[str] = Field(default="", description="Event description/context")
    start: str = Field(description="Start time as ISO-8601 string")
    end: Optional[str] = Field(default="", description="End time as ISO-8601 string")
    uncertain: bool = Field(default=False, description="Whether there is uncertainty about commitment or details")
    allDay: bool = Field(default=False, description="True if it spans whole day(s) with no specific clock time")
    explicitCommand: bool = Field(default=False, description="True only when speaker directly instructed scheduling")
    sourceText: str = Field(default="", description="Verbatim transcript phrase that triggered this event")
    speaker: Optional[str] = Field(default="", description="Speaker or participant associated with this event")


class TaskItem(BaseModel):
    title: str = Field(description="Compact title of the task")
    notes: Optional[str] = Field(default="", description="Any descriptions, sub-items, or context")
    uncertain: bool = Field(default=False, description="Whether the task itself or details are vague")
    dueDate: Optional[str] = Field(default="", description="Deadline as ISO date YYYY-MM-DD if bounded, else empty")
    explicitCommand: bool = Field(default=False, description="True only when speaker directly instructed logging this")
    sourceText: str = Field(default="", description="Verbatim transcript phrase that triggered this task")
    assignee: Optional[str] = Field(default="", description="Speaker assigned to or volunteering for this task")
    requestedBy: Optional[str] = Field(default="", description="Speaker who requested or assigned this task")


class SearchQueryItem(BaseModel):
    query: str = Field(description="Search query string")
    explicitCommand: bool = Field(default=False, description="True only when speaker directly asked for search")
    sourceText: str = Field(default="", description="Verbatim transcript phrase that triggered this query")


class PlanOutput(BaseModel):
    ideasSummary: str = Field(default="", description="Summarized ideas and insights in markdown bullet points")
    calendarEvents: List[CalendarEventItem] = Field(default_factory=list)
    tasks: List[TaskItem] = Field(default_factory=list)
    searchQueries: List[SearchQueryItem] = Field(default_factory=list)


class AnalyzeRequest(BaseModel):
    text: str = Field(min_length=1, description="Raw or corrected transcript text")
    currentLocalTime: Optional[str] = Field(default=None, description="ISO-8601 reference time")
    liveSummary: Optional[str] = Field(default="", description="Rolling live summary so far")
    sessionId: Optional[str] = Field(default=None, description="Active session ID")


class LivePipelineRequest(BaseModel):
    text: str = Field(min_length=1, description="Transcribed text so far")
    currentLocalTime: Optional[str] = Field(default=None, description="ISO-8601 reference time")
    liveSummary: Optional[str] = Field(default="", description="Rolling live summary so far")
    withPlan: Optional[bool] = Field(default=True, description="Whether to run the plan classification stage")
    sessionId: Optional[str] = Field(default=None, description="Active session ID")


class TranscribeCorrectRequest(BaseModel):
    text: str = Field(min_length=1, description="Transcribed text")


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, description="Search query")


class TranscribeAudioRequest(BaseModel):
    audio: str = Field(min_length=1, description="Base64-encoded audio chunk")
    mimeType: Optional[str] = Field(default="audio/webm", description="MIME type of audio chunk")
    source: Optional[str] = Field(default="mic", description="Audio source: mic or tab")
    enableDiarization: Optional[bool] = Field(default=False, description="Enable speaker diarization")
    minSpeakers: Optional[int] = Field(default=1, description="Minimum speakers for diarization")
    maxSpeakers: Optional[int] = Field(default=5, description="Maximum speakers for diarization")


class ExecuteRequest(BaseModel):
    kind: str = Field(description="Action name (e.g. create_calendar_event, create_task, create_drive_doc)")
    item: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Payload parameters")
    accessToken: Optional[str] = Field(default=None, description="Google OAuth access token or 'sandbox'")
    action: Optional[str] = Field(default="execute", description="'execute' or 'delete'")
    id: Optional[str] = Field(default=None, description="Resource ID for deletion")


class EventsClearRequest(BaseModel):
    clearDisk: Optional[bool] = Field(default=False)
