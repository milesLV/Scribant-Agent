"""Skill Definitions and Extraction Criteria.

Defines modular Skills for Google Workspace actions (Calendar, Tasks, Drive/Docs)
and Grounded Web Search.
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional


@dataclass(frozen=True)
class BaseSkill:
    """Base definition for an agent skill."""
    name: str
    description: str


class CalendarSkill(BaseSkill):
    """Manages calendar event extraction and scheduling criteria."""

    def __init__(self) -> None:
        super().__init__(
            name="calendarEvents",
            description="""(array of objects) Things that HAPPEN on a timeline — you attend them or they occur over a span of time (appointments, meetings, trips, birthdays). Use a calendar event when the TIME ITSELF matters: either a specific clock time you must be present for ("groomer tomorrow at 9", "dinner with Sam at 7"), OR a whole day/days something occupies even without a clock time ("driving to Yosemite tomorrow", "my sister's birthday Friday"). DO NOT use a calendar event for an action you merely need to finish by some point — that is a task with a dueDate (see #3). DO NOT include vague aspirations. Set "uncertain": true when the commitment, date, or time is vague, else false. Each object must have:
   - "title": (string) Event summary/title
   - "description": (string) Event description/context
   - "allDay": (boolean) true if it spans whole day(s) with no specific clock time; false for events with a start time.
   - "start": (string) Start as ISO-8601 (use the current local time to resolve "tomorrow", "tonight", "next week"). For all-day events use the date at 00:00.
   - "end": (string) End as ISO-8601. Default to 30 minutes after start when no duration is implied.
   - "uncertain": (boolean)
   - "explicitCommand": (boolean) true ONLY when the speaker directly instructs that this be put on their calendar ("add that to my calendar", "schedule it for 5pm"). Merely mentioning a plan is NOT a command — that is false.
   - "sourceText": (string) The exact words from the transcript that triggered this event, copied verbatim.
   - "speaker": (string) Optional speaker name/label who mentioned or is participating. Empty string "" if unspecified.""",
        )


class TaskSkill(BaseSkill):
    """Manages to-do task extraction and checklist criteria."""

    def __init__(self) -> None:
        super().__init__(
            name="tasks",
            description="""(array of objects) Things you DO and check off — actions you can complete at any time rather than at a fixed clock time ("water the plants", "renew my passport", "clean the house"). If the action has a deadline or upper bound, capture it in "dueDate"; if instead it must happen AT a specific time you attend, it is a calendar event. Set "uncertain": true when the task or its details are vague, else false. Each object must have:
   - "title": (string) Compact title of the task
   - "notes": (string) Any descriptions, sub-items, or context
   - "dueDate": (string) Deadline as an ISO date "YYYY-MM-DD" if the action is bounded; empty string "" if open-ended.
   - "uncertain": (boolean) Set to true if the task itself or details are vague, else false.
   - "explicitCommand": (boolean) true ONLY when the speaker directly instructs that this be logged ("add that to my to-do list", "put sweeping on my tasks", "remind me to...").
   - "sourceText": (string) The exact words from the transcript that triggered this task, copied verbatim.
   - "assignee": (string) Optional speaker name/label who committed to or was assigned this task. Empty string "" if unassigned.
   - "requestedBy": (string) Optional speaker name/label who requested or assigned this task. Empty string "" if unspecified.""",
        )


class SearchSkill(BaseSkill):
    """Manages grounded web research query criteria."""

    def __init__(self) -> None:
        super().__init__(
            name="searchQueries",
            description="""(array of objects) ONLY include searchable, well-defined questions or queries (e.g. YES to "I wonder what the most efficient gas mileage for my Toyota Sienna is"). DO NOT include personal, unsearchable thoughts. Each object must have:
   - "query": (string) The search query text
   - "explicitCommand": (boolean) true ONLY when the speaker directly asks for the search to be run ("look that up for me", "search for it").
   - "sourceText": (string) The exact words from the transcript that triggered this query, copied verbatim.""",
        )


class DocSkill(BaseSkill):
    """Manages live notes, session summarization, and Drive document criteria."""

    def __init__(self) -> None:
        super().__init__(
            name="ideasSummary",
            description="""(string) A formatted markdown bullet list summarizing the most important, overall points from the provided "AI Live Notes Summary". If empty, summarize the raw transcript.""",
        )


# Instantiate skills registry
calendar_skill = CalendarSkill()
task_skill = TaskSkill()
search_skill = SearchSkill()
doc_skill = DocSkill()

SKILLS: List[Dict[str, Any]] = [
    {"name": calendar_skill.name, "description": calendar_skill.description},
    {"name": task_skill.name, "description": task_skill.description},
    {"name": search_skill.name, "description": search_skill.description},
]


def build_skills_criteria_text() -> str:
    """Build numbered criteria text for the intent classifier prompt."""
    lines = [
        f'1. "{doc_skill.name}": {doc_skill.description}'
    ]
    for i, s in enumerate(SKILLS, start=2):
        lines.append(f'{i}. "{s["name"]}": {s["description"]}')
    return "\n\n".join(lines)
