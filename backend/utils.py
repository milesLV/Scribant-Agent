"""Formatting and Parsing Utilities.

Helpers for JSON extraction, relative date parsing, proofreading tokenizers,
and multi-tier response formatting.
"""
from __future__ import annotations
import datetime
import json
import re
from typing import Any, Dict, List, Optional, Tuple
import dateparser
from dateutil import tz


def clean_json_string(s: str) -> str:
    """Extract valid JSON from markdown code blocks or messy model outputs."""
    s = s.strip()
    if s.startswith("```"):
        # Strip opening ```json or ```
        s = re.sub(r"^```(?:json)?\s*", "", s, flags=re.IGNORECASE)
        # Strip closing ```
        s = re.sub(r"\s*```$", "", s)
    return s.strip()


def split_tiers(text: str) -> Dict[str, str]:
    """Parse CONDENSED: / DETAILED: tiers from search model outputs."""
    condensed_match = re.search(r"CONDENSED:\s*(.*?)(?=\n\s*DETAILED:|\Z)", text, flags=re.DOTALL | re.IGNORECASE)
    detailed_match = re.search(r"DETAILED:\s*(.*)", text, flags=re.DOTALL | re.IGNORECASE)
    
    condensed = condensed_match.group(1).strip() if condensed_match else ""
    in_depth = detailed_match.group(1).strip() if detailed_match else ""
    
    if not condensed and not in_depth:
        condensed = text.strip()
        in_depth = text.strip()
    elif not in_depth:
        in_depth = condensed
    elif not condensed:
        condensed = in_depth[:200]
        
    return {"condensed": condensed, "inDepth": in_depth}


def build_proofread_prompt(text: str) -> Dict[str, Any]:
    """Tokenize words and produce indexed token format '0:word 1:word ...'."""
    # Split preserving words and positions
    tokens = re.findall(r"\S+", text)
    indexed = " ".join(f"{i}:{t}" for i, t in enumerate(tokens))
    return {
        "words": tokens,
        "contents": f"Tokenized text:\n{indexed}\n\nOriginal text:\n\"{text}\""
    }


def parse_proofread(raw_json: str, prompt_data: Dict[str, Any]) -> Dict[str, Any]:
    """Parse proofreader output into structured corrections and word list."""
    words = prompt_data.get("words", [])
    try:
        data = json.loads(clean_json_string(raw_json))
        corrections = data.get("corrections", [])
        valid_corrections = []
        for c in corrections:
            idx = c.get("index")
            rep = c.get("replacement")
            if isinstance(idx, int) and 0 <= idx < len(words) and rep is not None:
                valid_corrections.append({
                    "index": idx,
                    "original": words[idx],
                    "replacement": str(rep),
                    "confidence": c.get("confidence", "high"),
                    "reason": c.get("reason", ""),
                })
        return {"corrections": valid_corrections, "words": words}
    except Exception:
        return {"corrections": [], "words": words}


def apply_corrections(text: str, words: List[str], corrections: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Apply high-confidence corrections deterministically to words."""
    if not corrections or not words:
        return {"text": text, "changed": False}

    word_map = {c["index"]: c["replacement"] for c in corrections if c.get("confidence") == "high"}
    if not word_map:
        return {"text": text, "changed": False}

    new_words = list(words)
    for idx, rep in word_map.items():
        if 0 <= idx < len(new_words):
            new_words[idx] = rep

    return {"text": " ".join(new_words), "changed": True}


def resolve_plan_dates(plan: Dict[str, Any], ref_iso: str) -> Dict[str, Any]:
    """Anchor relative dates/times in calendar events and tasks against ref_iso."""
    try:
        ref_dt = datetime.datetime.fromisoformat(ref_iso.replace("Z", "+00:00")) if ref_iso else datetime.datetime.now(datetime.timezone.utc)
    except Exception:
        ref_dt = datetime.datetime.now(datetime.timezone.utc)

    resolved = dict(plan)
    
    # Process calendar events
    events = resolved.get("calendarEvents") or []
    new_events = []
    for ev in events:
        ev_copy = dict(ev)
        start_raw = ev_copy.get("start", "")
        end_raw = ev_copy.get("end", "")
        
        # Try date parsing if not strict ISO
        if start_raw and not re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", start_raw):
            parsed_start = dateparser.parse(start_raw, settings={"RELATIVE_BASE": ref_dt, "PREFER_DATES_FROM": "future"})
            if parsed_start:
                ev_copy["start"] = parsed_start.isoformat()
                
        if end_raw and not re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", end_raw):
            parsed_end = dateparser.parse(end_raw, settings={"RELATIVE_BASE": ref_dt, "PREFER_DATES_FROM": "future"})
            if parsed_end:
                ev_copy["end"] = parsed_end.isoformat()
        elif not end_raw and ev_copy.get("start") and not ev_copy.get("allDay"):
            try:
                sdt = datetime.datetime.fromisoformat(ev_copy["start"].replace("Z", "+00:00"))
                ev_copy["end"] = (sdt + datetime.timedelta(minutes=30)).isoformat()
            except Exception:
                pass
                
        new_events.append(ev_copy)
    resolved["calendarEvents"] = new_events

    # Process tasks
    tasks = resolved.get("tasks") or []
    new_tasks = []
    for t in tasks:
        t_copy = dict(t)
        due_raw = t_copy.get("dueDate", "")
        if due_raw and not re.match(r"^\d{4}-\d{2}-\d{2}$", due_raw):
            parsed_due = dateparser.parse(due_raw, settings={"RELATIVE_BASE": ref_dt, "PREFER_DATES_FROM": "future"})
            if parsed_due:
                t_copy["dueDate"] = parsed_due.strftime("%Y-%m-%d")
        new_tasks.append(t_copy)
    resolved["tasks"] = new_tasks

    return resolved
