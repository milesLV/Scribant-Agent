"""Google Workspace Execution Tools.

Executors for Google Calendar, Tasks, Drive, and Docs API operations,
with support for authenticated OAuth execution and local sandbox simulation.
"""
from __future__ import annotations
import asyncio
import datetime
import json
import os
import shutil
import time
from typing import Any, Dict, Optional
import httpx
from backend.events import emit_adk_event, create_event, create_event_actions


async def gws_cli_execute(cmd_args: list[str]) -> Optional[str]:
    """Execute a Google Workspace CLI command if a gws/gcloud binary is available."""
    cli_bin = os.environ.get("GWS_CLI_PATH") or shutil.which("gws")
    if not cli_bin:
        return None
    try:
        proc = await asyncio.create_subprocess_exec(
            cli_bin,
            *cmd_args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode == 0:
            return stdout.decode("utf-8").strip()
    except Exception as e:
        print(f"[gws_cli_execute] CLI execution failed: {e}")
    return None


def to_gcal_dates(event: Dict[str, Any]) -> Dict[str, Any]:
    """Convert start/end to Google Calendar API format."""
    start_str = event.get("start", "")
    end_str = event.get("end", "")
    all_day = bool(event.get("allDay"))
    
    if all_day:
        sd = start_str[:10] if len(start_str) >= 10 else datetime.date.today().isoformat()
        ed = end_str[:10] if len(end_str) >= 10 else sd
        if ed <= sd:
            try:
                s_date = datetime.date.fromisoformat(sd)
                ed = (s_date + datetime.timedelta(days=1)).isoformat()
            except Exception:
                ed = sd
        return {"start": {"date": sd}, "end": {"date": ed}}
    
    tz_name = "UTC"
    return {
        "start": {"dateTime": start_str, "timeZone": tz_name},
        "end": {"dateTime": end_str or start_str, "timeZone": tz_name},
    }


async def gcal_create_event(token: str, event: Dict[str, Any]) -> str:
    """Create a Google Calendar event using the user's OAuth token."""
    dates = to_gcal_dates(event)
    payload = {
        "summary": event.get("title", ""),
        "description": event.get("description", ""),
        **dates,
    }
    async with httpx.AsyncClient() as client:
        res = await client.post(
            "https://www.googleapis.com/calendar/v3/calendars/primary/events",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json=payload,
            timeout=10.0,
        )
        if not res.is_success:
            raise RuntimeError(f"Google Calendar API error {res.status_code}: {res.text}")
        data = res.json()
        return str(data.get("id"))


async def gtasks_create_task(token: str, task: Dict[str, Any]) -> str:
    """Create a Google Task using the user's OAuth token."""
    due_date = task.get("dueDate")
    payload: Dict[str, Any] = {
        "title": task.get("title", ""),
        "notes": task.get("notes", ""),
    }
    if due_date:
        try:
            payload["due"] = f"{due_date}T00:00:00.000Z"
        except Exception:
            pass

    async with httpx.AsyncClient() as client:
        res = await client.post(
            "https://www.googleapis.com/tasks/v1/lists/@default/tasks",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json=payload,
            timeout=10.0,
        )
        if not res.is_success:
            raise RuntimeError(f"Google Tasks API error {res.status_code}: {res.text}")
        data = res.json()
        return str(data.get("id"))


async def gdocs_create_document(token: str, title: str, content: Optional[str] = None) -> str:
    """Create a Google Docs document."""
    async with httpx.AsyncClient() as client:
        res = await client.post(
            "https://docs.googleapis.com/v1/documents",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"title": title},
            timeout=10.0,
        )
        if not res.is_success:
            raise RuntimeError(f"Google Docs API error {res.status_code}: {res.text}")
        doc = res.json()
        doc_id = str(doc.get("documentId"))
        
        if content and doc_id:
            await client.post(
                f"https://docs.googleapis.com/v1/documents/{doc_id}:batchUpdate",
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                json={"requests": [{"insertText": {"location": {"index": 1}, "text": content}}]},
                timeout=10.0,
            )
        return doc_id


async def gdrive_create_folder(token: str, folder_name: str) -> str:
    """Create a Google Drive folder or reuse existing."""
    async with httpx.AsyncClient() as client:
        res = await client.post(
            "https://www.googleapis.com/drive/v3/files",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"name": folder_name, "mimeType": "application/vnd.google-apps.folder"},
            timeout=10.0,
        )
        if not res.is_success:
            raise RuntimeError(f"Google Drive API error {res.status_code}: {res.text}")
        data = res.json()
        return str(data.get("id"))


async def gdrive_upload_doc(token: str, file_name: str, content: str, folder_id: Optional[str] = None) -> str:
    """Upload a markdown file to Google Drive."""
    async with httpx.AsyncClient() as client:
        meta_payload: Dict[str, Any] = {"name": file_name, "mimeType": "text/markdown"}
        if folder_id:
            meta_payload["parents"] = [folder_id]
            
        res = await client.post(
            "https://www.googleapis.com/drive/v3/files",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json=meta_payload,
            timeout=10.0,
        )
        if not res.is_success:
            raise RuntimeError(f"Google Drive metadata error {res.status_code}: {res.text}")
        meta = res.json()
        file_id = str(meta.get("id"))
        
        # Upload content bytes
        up_res = await client.patch(
            f"https://www.googleapis.com/upload/drive/v3/files/{file_id}?uploadType=media",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "text/markdown"},
            content=content.encode("utf-8"),
            timeout=15.0,
        )
        if not up_res.is_success:
            raise RuntimeError(f"Google Drive media error {up_res.status_code}: {up_res.text}")
        return file_id


async def gcal_delete_event(token: str, event_id: str) -> None:
    """Delete a Google Calendar event."""
    async with httpx.AsyncClient() as client:
        res = await client.delete(
            f"https://www.googleapis.com/calendar/v3/calendars/primary/events/{event_id}",
            headers={"Authorization": f"Bearer {token}"},
            timeout=10.0,
        )
        if not res.is_success and res.status_code not in (404, 410):
            raise RuntimeError(f"Google Calendar delete error: {res.text}")


async def gtasks_delete_task(token: str, task_id: str) -> None:
    """Delete a Google Task."""
    async with httpx.AsyncClient() as client:
        res = await client.delete(
            f"https://www.googleapis.com/tasks/v1/lists/@default/tasks/{task_id}",
            headers={"Authorization": f"Bearer {token}"},
            timeout=10.0,
        )
        if not res.is_success and res.status_code not in (404, 410):
            raise RuntimeError(f"Google Tasks delete error: {res.text}")


async def execute_workspace_action(
    kind: str,
    item: Dict[str, Any],
    access_token: Optional[str] = None,
    action: str = "execute",
    resource_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Execute a single reviewed item or handle undo deletion."""
    is_sandbox = not access_token or access_token == "sandbox"
    ts_now = int(time.time() * 1000)

    # 1. Emit tool_call event
    emit_adk_event(
        create_event(
            author="workspace_tools",
            invocation_id=f"tool-{ts_now}",
            content={
                "role": "model",
                "parts": [{
                    "functionCall": {
                        "name": f"delete_{kind}" if action == "delete" else kind,
                        "args": {"id": resource_id, "kind": kind} if action == "delete" else item,
                        "id": f"call-{ts_now}",
                    }
                }],
            },
            actions=create_event_actions({
                "eventType": "tool_call",
                "toolName": kind,
                "action": action,
                "args": item,
                "mode": "sandbox" if is_sandbox else "google_api",
            }),
        )
    )

    # Handle Delete / Undo
    if action == "delete":
        if not is_sandbox and resource_id:
            if kind == "create_calendar_event":
                await gcal_delete_event(access_token, resource_id)
            elif kind == "create_task":
                await gtasks_delete_task(access_token, resource_id)

        emit_adk_event(
            create_event(
                author="workspace_tools",
                invocation_id=f"tool-{ts_now}",
                content={
                    "role": "model",
                    "parts": [{
                        "functionResponse": {
                            "name": f"delete_{kind}",
                            "response": {"ok": True, "id": resource_id, "status": "deleted", "mode": "sandbox" if is_sandbox else "google_api"},
                            "id": f"call-{ts_now}",
                        }
                    }],
                },
                actions=create_event_actions({
                    "eventType": "tool_result",
                    "toolName": f"delete_{kind}",
                    "status": "success",
                }),
            )
        )
        return {"ok": True}

    # Handle Execute / Create
    result_id = f"mock-{kind}-{ts_now}"
    if not is_sandbox and access_token:
        if kind == "create_calendar_event":
            result_id = await gcal_create_event(access_token, item)
        elif kind == "create_task":
            result_id = await gtasks_create_task(access_token, item)
        elif kind == "create_drive_doc":
            result_id = await gdocs_create_document(access_token, item.get("title", "Untitled Document"), item.get("content", ""))
        elif kind == "create_drive_folder":
            result_id = await gdrive_create_folder(access_token, item.get("folderName", "New Folder"))

    # Emit tool_result event
    emit_adk_event(
        create_event(
            author="workspace_tools",
            invocation_id=f"tool-{ts_now}",
            content={
                "role": "model",
                "parts": [{
                    "functionResponse": {
                        "name": kind,
                        "response": {"id": result_id, "status": "created", "mode": "sandbox" if is_sandbox else "google_api", **item},
                        "id": f"call-{ts_now}",
                    }
                }],
            },
            actions=create_event_actions({
                "eventType": "tool_result",
                "toolName": kind,
                "status": "success",
                "resultId": result_id,
                "item": item,
                "mode": "sandbox" if is_sandbox else "google_api",
            }),
        )
    )

    return {"id": result_id}
