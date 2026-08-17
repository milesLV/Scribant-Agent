"""Scribant Multi-Agent Orchestration System.

Coordinates specialist LLM agents using Google Agent Development Kit (ADK)
to proofread unfiltered thoughts, summarize live speech notes, extract
structured actions (calendar events and tasks), and perform grounded web research.
"""
from __future__ import annotations
import asyncio
import datetime
import json
import os
from typing import Any, AsyncGenerator, Callable, Dict, List, Optional, Set
from google.adk.agents import Agent
from google.adk.agents.callback_context import CallbackContext
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.tools import google_search
from google.adk.events import Event
from google.genai import types

from backend.events import emit_adk_event, create_event, create_event_actions
from backend.skills import build_skills_criteria_text
from backend.models import PlanOutput
from backend.utils import (
    build_proofread_prompt,
    parse_proofread,
    apply_corrections,
    resolve_plan_dates,
    clean_json_string,
    split_tiers,
)

MODEL = os.environ.get("GEMINI_MODEL") or os.environ.get("MODEL") or "gemini-3.7-flash"

# Session service for agent execution state
session_service = InMemorySessionService()


# ---- Agent Lifecycle Callbacks ----------------------------------------------

async def proofreader_after_callback(ctx: CallbackContext) -> None:
    """Emits an event following proofreading completion."""
    agent_name = ctx.agent_name
    output_text = ""
    if ctx.output and hasattr(ctx.output, "text"):
        output_text = ctx.output.text or ""
    elif ctx.output and isinstance(ctx.output, str):
        output_text = ctx.output

    emit_adk_event(
        create_event(
            author=agent_name,
            invocation_id=ctx.invocation_id,
            content={"role": "model", "parts": [{"text": output_text}]},
            actions=create_event_actions({
                "eventType": "agent:proofread",
                "stateDelta": {"proofread": True},
            }),
        )
    )
    return None


async def doc_agent_after_callback(ctx: CallbackContext) -> None:
    """Emits an event following live note summarization."""
    agent_name = ctx.agent_name
    output_text = ""
    if ctx.output and hasattr(ctx.output, "text"):
        output_text = ctx.output.text or ""
    elif ctx.output and isinstance(ctx.output, str):
        output_text = ctx.output

    emit_adk_event(
        create_event(
            author=agent_name,
            invocation_id=ctx.invocation_id,
            content={"role": "model", "parts": [{"text": output_text}]},
            actions=create_event_actions({
                "eventType": "agent:summary",
                "length": len(output_text),
            }),
        )
    )
    return None


async def intent_classifier_after_callback(ctx: CallbackContext) -> None:
    """Emits an event following structured intent extraction."""
    agent_name = ctx.agent_name
    output_text = ""
    if ctx.output and hasattr(ctx.output, "text"):
        output_text = ctx.output.text or ""
    elif ctx.output and isinstance(ctx.output, str):
        output_text = ctx.output

    emit_adk_event(
        create_event(
            author=agent_name,
            invocation_id=ctx.invocation_id,
            content={"role": "model", "parts": [{"text": output_text}]},
            actions=create_event_actions({
                "eventType": "agent:plan",
            }),
        )
    )
    return None


async def search_agent_after_callback(ctx: CallbackContext) -> None:
    """Emits an event following grounded web search completion."""
    agent_name = ctx.agent_name
    output_text = ""
    if ctx.output and hasattr(ctx.output, "text"):
        output_text = ctx.output.text or ""
    elif ctx.output and isinstance(ctx.output, str):
        output_text = ctx.output

    emit_adk_event(
        create_event(
            author=agent_name,
            invocation_id=ctx.invocation_id,
            content={"role": "model", "parts": [{"text": output_text}]},
            actions=create_event_actions({
                "eventType": "agent:search",
            }),
        )
    )
    return None


# ---- Agent Declarations -----------------------------------------------------

proofreader_agent = Agent(
    name="proofreader",
    description="Identifies and corrects speech-to-text typos and phonetic mishearings.",
    model=MODEL,
    instruction=(
        "You are a transcript proofreader. Given an indexed list of words (0:word 1:word ...), "
        "identify clear speech-to-text typos or phonetic mishearings. "
        "Return strictly a JSON object with: "
        '{"corrections": [{"index": <number>, "replacement": "<string>", "confidence": "high"|"low", "reason": "<string>"}]}. '
        'If no corrections are needed, return {"corrections": []}.'
    ),
    after_agent_callback=proofreader_after_callback,
)

doc_agent = Agent(
    name="doc_agent",
    description="Generates concise, formatted Markdown bullet summaries of draft thoughts.",
    model=MODEL,
    instruction=(
        "You are a real-time summarizing assistant for an app that captures a person's unfiltered spoken thoughts. "
        "Analyze the provided text and extract an elegant, high-level summary using Markdown bullet points. "
        "Be extremely concise. Output only clean, helpful bullet points. Bold key terms (e.g. **Key Term**)."
    ),
    after_agent_callback=doc_agent_after_callback,
)

task_agent = Agent(
    name="task_agent",
    description="Extracts actionable tasks and checklist items with deadlines and assignees.",
    model=MODEL,
    instruction="Extract actionable todo items with deadlines and assignees from the dialogue.",
)

calendar_agent = Agent(
    name="calendar_agent",
    description="Extracts time-bound calendar events and meetings with ISO start/end times.",
    model=MODEL,
    instruction="Extract time-bound calendar events and meetings with ISO start/end times.",
)

intent_classifier_agent = Agent(
    name="intent_classifier",
    description="Categorizes dialogue into structured calendar events, tasks, and search queries.",
    model=MODEL,
    instruction=(
        "You are an intent parsing engine that categorizes unfiltered spoken thoughts into structured actions.\n\n"
        f"Criteria:\n{build_skills_criteria_text()}\n\n"
        "Output strictly a JSON object conforming to the criteria. If no items match a category, return []."
    ),
    output_schema=PlanOutput,
    after_agent_callback=intent_classifier_after_callback,
)

search_agent = Agent(
    name="search_agent",
    description="Answers research questions using grounded Google Search results.",
    model=MODEL,
    instruction=(
        "You are a research assistant. Use Google Search to ground your answer, then respond in EXACTLY this format:\n"
        "CONDENSED: <a direct 1-2 sentence answer>\n"
        "DETAILED: <a thorough 4-7 sentence explanation with the key facts and context>"
    ),
    tools=[google_search],
    after_agent_callback=search_agent_after_callback,
)

# Root coordinator agent
root_agent = Agent(
    name="root_agent",
    description="Root orchestrator coordinating proofreading, summarization, action extraction, and research.",
    model=MODEL,
    instruction="Coordinate sub-agents to process transcripts, extract action items, and perform research.",
    sub_agents=[
        proofreader_agent,
        doc_agent,
        task_agent,
        calendar_agent,
        intent_classifier_agent,
        search_agent,
    ],
)


# ---- Agent Runner Helper ----------------------------------------------------

async def run_adk_agent(
    agent: Agent,
    prompt_text: str,
    user_id: str = "default_user",
    session_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Execute an agent invocation within a session and return the response."""
    sess_id = session_id or f"sess-{int(datetime.datetime.now().timestamp()*1000)}"
    try:
        session = await session_service.get_session(app_name="scribant", user_id=user_id, session_id=sess_id)
        if not session:
            session = await session_service.create_session(app_name="scribant", user_id=user_id, session_id=sess_id)
    except Exception:
        session = await session_service.create_session(app_name="scribant", user_id=user_id, session_id=sess_id)

    runner = Runner(agent=agent, session_service=session_service, app_name="scribant")
    user_msg = types.Content(role="user", parts=[types.Part.from_text(text=prompt_text)])

    out_text = ""
    grounding = None
    events = []

    async for ev in runner.run_async(user_id=user_id, session_id=session.id, new_message=user_msg):
        events.append(ev)
        if ev.content and ev.content.parts:
            for p in ev.content.parts:
                if getattr(p, "text", None):
                    out_text += p.text
        if getattr(ev, "grounding_metadata", None):
            grounding = ev.grounding_metadata

    return {
        "text": out_text.strip(),
        "grounding": grounding,
        "events": events,
    }


# ---- Pipeline Orchestration -------------------------------------------------

class MasterOrchestrator:
    """Manages the multi-stage pipeline across proofreading, summarization, and intent extraction."""

    async def run_proofread(self, raw_text: str) -> Dict[str, Any]:
        """Proofreads transcript text and applies corrections."""
        prompt_data = build_proofread_prompt(raw_text)
        res = await run_adk_agent(proofreader_agent, prompt_data["contents"])
        parsed = parse_proofread(res["text"], prompt_data)
        applied = apply_corrections(raw_text, parsed["words"], parsed["corrections"])
        return {
            "text": raw_text,
            "corrected": applied["text"],
            "corrections": parsed["corrections"],
            "words": parsed["words"],
        }

    async def run_summary(self, text: str) -> str:
        """Generates live bullet-point summaries of ongoing dialogue."""
        res = await run_adk_agent(doc_agent, f"Draft thoughts:\n\"{text}\"")
        return res["text"]

    async def run_intent_classification(self, text: str, ref_iso: str, live_summary: str = "") -> Dict[str, Any]:
        """Extracts calendar events, tasks, and queries from the text."""
        prompt = f"AI Live Notes Summary: \"{live_summary}\"\n\nCurrent Time context: {ref_iso}\n\nStream of thoughts:\n\"{text}\""
        res = await run_adk_agent(intent_classifier_agent, prompt)
        raw_text = res["text"]
        try:
            parsed = json.loads(clean_json_string(raw_text))
        except Exception:
            parsed = {}
        return resolve_plan_dates(parsed, ref_iso)

    async def run_search(self, query: str) -> Dict[str, Any]:
        """Executes a grounded search query using Google Search."""
        res = await run_adk_agent(search_agent, f"Search the web and answer this research query: \"{query}\"")
        text = res["text"]
        sources = []
        if res.get("grounding") and getattr(res["grounding"], "grounding_chunks", None):
            for ch in res["grounding"].grounding_chunks:
                if getattr(ch, "web", None) and getattr(ch.web, "uri", None):
                    sources.append({"uri": ch.web.uri, "title": getattr(ch.web, "title", None) or ch.web.uri})

        tiers = split_tiers(text)
        return {
            "query": query,
            "condensed": tiers["condensed"],
            "inDepth": tiers["inDepth"],
            "sources": sources,
        }

    async def run_pipeline(
        self,
        text: str,
        stages: Set[str],
        ref_iso: str,
        live_summary: str = "",
        on_stage: Optional[Callable[[str, Any], None]] = None,
    ) -> Dict[str, Any]:
        """Executes the requested stages and streams results as each stage resolves."""
        result: Dict[str, Any] = {}
        corrected_text = text

        if "proof" in stages:
            try:
                proof_res = await self.run_proofread(text)
                corrected_text = proof_res.get("corrected", text)
                result["proof"] = proof_res
                if on_stage:
                    on_stage("proof", {"proof": proof_res})
            except Exception as e:
                print(f"[MasterOrchestrator] Proofread stage error: {e}")
                if on_stage:
                    on_stage("proof", {"error": str(e)})

        tasks = []
        if "summary" in stages:
            async def _do_summary():
                try:
                    summary = await self.run_summary(corrected_text)
                    result["summary"] = summary
                    if on_stage:
                        on_stage("summary", {"summary": summary})
                except Exception as e:
                    print(f"[MasterOrchestrator] Summary stage error: {e}")
                    if on_stage:
                        on_stage("summary", {"error": str(e)})
            tasks.append(_do_summary())

        if "plan" in stages:
            async def _do_plan():
                try:
                    plan = await self.run_intent_classification(corrected_text, ref_iso, live_summary)
                    result["plan"] = plan
                    if on_stage:
                        on_stage("plan", {"plan": plan})
                except Exception as e:
                    print(f"[MasterOrchestrator] Plan stage error: {e}")
                    if on_stage:
                        on_stage("plan", {"error": str(e)})
            tasks.append(_do_plan())

        if tasks:
            await asyncio.gather(*tasks)

        return result


orchestrator = MasterOrchestrator()
