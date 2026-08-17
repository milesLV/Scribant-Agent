"""Test suite for Scribant Python Multi-Agent Backend."""
from __future__ import annotations
import asyncio
import datetime
import json
from google.adk.agents import Agent
from google.adk.tools import google_search

from backend.events import (
    create_event,
    create_event_actions,
    emit_adk_event,
    get_memory_events,
    clear_memory_events,
)
from backend.utils import (
    clean_json_string,
    split_tiers,
    build_proofread_prompt,
    parse_proofread,
    apply_corrections,
    resolve_plan_dates,
)
from backend.models import (
    AnalyzeRequest,
    CalendarEventItem,
    TaskItem,
    SearchQueryItem,
    PlanOutput,
    LivePipelineRequest,
)
from backend.queue_manager import message_queue
from backend.workspace_tools import to_gcal_dates, execute_workspace_action
from backend.agents import (
    proofreader_agent,
    doc_agent,
    task_agent,
    calendar_agent,
    intent_classifier_agent,
    search_agent,
    root_agent,
    orchestrator,
)


def test_agent_declarations():
    """Verify that all ADK agents are properly instantiated with valid configs."""
    assert isinstance(proofreader_agent, Agent)
    assert proofreader_agent.name == "proofreader"
    assert proofreader_agent.after_agent_callback is not None

    assert isinstance(doc_agent, Agent)
    assert doc_agent.name == "doc_agent"
    assert doc_agent.after_agent_callback is not None

    assert isinstance(task_agent, Agent)
    assert task_agent.name == "task_agent"

    assert isinstance(calendar_agent, Agent)
    assert calendar_agent.name == "calendar_agent"

    assert isinstance(intent_classifier_agent, Agent)
    assert intent_classifier_agent.name == "intent_classifier"
    assert intent_classifier_agent.output_schema == PlanOutput

    assert isinstance(search_agent, Agent)
    assert search_agent.name == "search_agent"
    assert search_agent.tools == [google_search]

    assert isinstance(root_agent, Agent)
    assert root_agent.name == "root_agent"
    assert len(root_agent.sub_agents) == 6
    print("✓ test_agent_declarations passed")


def test_events():
    """Verify event creation, buffering, and querying."""
    clear_memory_events()
    ev = create_event(
        author="test_agent",
        content={"role": "model", "parts": [{"text": "hello"}]},
        actions=create_event_actions({"eventType": "test:action", "status": "success"}),
    )
    emit_adk_event(ev)
    events = get_memory_events(author_filter="test_agent")
    assert len(events) == 1
    assert events[0]["author"] == "test_agent"
    print("✓ test_events passed")


def test_utils():
    """Verify parsing, tokenization, correction, and date resolution."""
    # Clean JSON
    markdown_json = "```json\n{\"key\": \"val\"}\n```"
    assert clean_json_string(markdown_json) == '{"key": "val"}'

    # Split Tiers
    text = "CONDENSED: Quick answer here.\nDETAILED: Detailed explanation here."
    tiers = split_tiers(text)
    assert tiers["condensed"] == "Quick answer here."
    assert tiers["inDepth"] == "Detailed explanation here."

    # Proofreading
    prompt_data = build_proofread_prompt("buy som milck")
    mock_corrections_json = json.dumps({
        "corrections": [
            {"index": 1, "replacement": "some", "confidence": "high"},
            {"index": 2, "replacement": "milk", "confidence": "high"},
        ]
    })
    parsed = parse_proofread(mock_corrections_json, prompt_data)
    assert len(parsed["corrections"]) == 2
    applied = apply_corrections("buy som milck", parsed["words"], parsed["corrections"])
    assert applied["text"] == "buy some milk"

    # Date resolution
    ref_iso = "2026-08-17T12:00:00+00:00"
    plan = {
        "calendarEvents": [{"title": "Lunch", "start": "tomorrow at 1pm", "allDay": False}],
        "tasks": [{"title": "Sweep", "dueDate": "Friday"}],
    }
    resolved = resolve_plan_dates(plan, ref_iso)
    assert "2026-08-18" in resolved["calendarEvents"][0]["start"]
    assert "2026-08-" in resolved["tasks"][0]["dueDate"]
    print("✓ test_utils passed")


def test_workspace():
    """Verify Google Workspace date conversion and format."""
    gcal = to_gcal_dates({"title": "Trip", "start": "2026-08-20", "allDay": True})
    assert "date" in gcal["start"]
    assert gcal["start"]["date"] == "2026-08-20"
    assert gcal["end"]["date"] == "2026-08-21"
    print("✓ test_workspace passed")


async def test_queue_and_actions():
    """Verify async message queue and sandbox actions."""
    # Queue
    await message_queue.push_transcript("s1", {"text": "Hello world"})
    await message_queue.push_transcript("s1", {"text": "How are you"})
    assert "Hello world How are you" == message_queue.get_buffered_text("s1")
    
    # Sandbox action
    res = await execute_workspace_action(
        kind="create_calendar_event",
        item={"title": "Meeting", "start": "2026-08-18T10:00:00"},
        access_token="sandbox",
    )
    assert "mock-create_calendar_event" in res["id"]
from backend.skills import calendar_skill, task_skill, search_skill, doc_skill, build_skills_criteria_text


def test_skills():
    """Verify Skill registry and criteria generation."""
    assert calendar_skill.name == "calendarEvents"
    assert task_skill.name == "tasks"
    assert search_skill.name == "searchQueries"
    assert doc_skill.name == "ideasSummary"
    criteria = build_skills_criteria_text()
    assert "calendarEvents" in criteria
    assert "tasks" in criteria
    print("✓ test_skills passed")


if __name__ == "__main__":
    test_agent_declarations()
    test_skills()
    test_events()
    test_utils()
    test_workspace()
    asyncio.run(test_queue_and_actions())
    print("\nAll Python backend tests passed successfully! ✓")
