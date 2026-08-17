# Workspace Context & Preferences — Scribant Agent (Python Multi-Agent Redesign)

Welcome to Scribant! Scribant is an intelligent thought-partner agent that listens to unfiltered streams of speech/thought, transcribes and proofreads them, extracts structured summaries and action plans (Google Calendar events, Tasks, grounded searches, Drive notes), and integrates with Google Workspace.

---

## 1. System Architecture (Python Backend)

```
                       ┌─────────────────────────┐
                       │     React 19 UI         │
                       └───────────┬─────────────┘
                                   │ Audio Stream (/api/transcribe-audio)
                                   ▼
                       ┌─────────────────────────┐
                       │   Transcription (STT)   │  (Not an agent - Gemini / Cloud STT)
                       └───────────┬─────────────┘
                                   │ Pushes transcribed voice
                                   ▼
                       ┌─────────────────────────┐
                       │  Message Queue (async)  │  (asyncio.Queue buffer)
                       └───────────┬─────────────┘
                                   │ Consumes buffered speech
                                   ▼
                       ┌─────────────────────────┐
                       │       Root Agent        │  (Master coordinator & dispatcher)
                       └───────────┬─────────────┘
                                   │
                                   ▼
                       ┌─────────────────────────┐
                       │   Intent Recognition    │  (Combined with Proofreading & Date Resolution)
                       └───────────┬─────────────┘
                                   │
         ┌─────────────────────────┼─────────────────────────┐
         ▼                         ▼                         ▼
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│   Task Agent    │       │ Calendar Agent  │       │    Doc Agent    │
│ (GWS Tasks/CLI) │       │ (GWS Calendar)  │       │ (Live Notes)    │
└────────┬────────┘       └────────┬────────┘       └────────┬────────┘
         │                         │                         │
         └─────────────────────────┼─────────────────────────┘
                                   ▼
                       ┌─────────────────────────┐
                       │      Search Agent       │  (Grounding w/ Google Search)
                       └───────────┬─────────────┘
                                   │
                                   ▼
                       ┌─────────────────────────┐
                       │ Events & Callbacks Hook │  (after_agent_callback -> ADK Events)
                       └───────────┬─────────────┘
                                   │ Real-time Event Stream (SSE: /api/adk/events/stream)
                                   ▼
                       ┌─────────────────────────┐
                       │   Feedback Loop to UI   │
                       └─────────────────────────┘
```

---

## 2. Tech Stack

- **Backend**: Python 3.13+ with **FastAPI**, **Google GenAI SDK** (`google-genai`), and **Google ADK** (`google-adk`).
- **Frontend**: React 19 + Vite + Tailwind CSS v4 (served seamlessly by FastAPI at `/`).
- **Port**: `3000` (FastAPI serves both API routes and compiled SPA assets).
- **Core Architecture Invariants**:
  - **No Vertex AI Memory Bank or context compaction** overhead in this version.
  - **Separation of Concerns**: Transcription (STT) is purely a non-agent audio processor; transcribed voice is buffered in an asynchronous Message Queue; the Root Agent coordinates specialist sub-agents.
  - **Event-Driven Lifecycle**: Sub-agents use `after_agent_callback` to intercept structured outputs and emit immutable ADK events to the real-time SSE stream.

---

## 3. Subsystems & Codebase Map

```
Scribant-Agent/
├── backend/                  # Python Multi-Agent Backend
│   ├── __init__.py           # Package marker
│   ├── server.py             # FastAPI REST endpoints & SSE streaming handlers
│   ├── agents.py             # RootAgent, Intent Recognition, Task/Cal/Doc/Search Sub-Agents
│   ├── queue_manager.py      # TranscribedMessageQueue (asyncio.Queue)
│   ├── stt.py                # Dedicated STT service (multimodal Gemini / Cloud STT)
│   ├── workspace_tools.py    # Google Workspace executors (Calendar, Tasks, Drive, Docs) + Sandbox
│   ├── events.py             # Immutable ADK events store, disk persistence & SSE broadcaster
│   ├── skills.py             # Extraction criteria for Calendar, Tasks, Search Queries
│   ├── models.py             # Pydantic request/response schemas
│   ├── utils.py              # Chrono date resolution, proofreading token parser, clean JSON
│   └── test_backend.py       # Comprehensive backend test suite
├── src/                      # React 19 Frontend (unmodified contract)
│   ├── App.tsx               # Main application shell & tab routing
│   ├── components/           # UI Views: ActiveSession, AdminMonitoring, ApiDocsView, etc.
│   └── hooks/                # Custom React hooks (e.g. useTabAudioCapture)
├── Makefile                  # LLM and developer-friendly task runner
└── package.json              # Frontend build dependencies
```

---

## 4. ADK Patterns & Anti-Pattern Prevention Rules

As confirmed via DeepWiki (`google/adk-python`):
1. **Never Mix `output_schema` with Tool Calling**: In ADK, setting `output_schema` triggers controlled JSON-only mode. Extraction agents (Proofreader, IntentClassifier) use `output_schema` / JSON mode, while tool-calling agents (SearchAgent with Google Search) do NOT set `output_schema`.
2. **Never Directly Mutate Event Arrays**: Emit structured events using `emit_adk_event` and `create_event` following append-only immutability.
3. **No Synchronous Blocking in Async Loops**: All model calls and network calls run asynchronously or via `asyncio.to_thread`.
4. **Vertex AI & Google Cloud ADC Authentication**: Uses Vertex AI enterprise mode (`vertexai=True`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`) via Google Cloud Application Default Credentials (ADC) / IAM.
5. **Preserve Frontend Contract**: The UI is untouched; all API routes (`/api/live`, `/api/analyze`, `/api/transcribe-audio`, `/api/execute`, `/api/search`, `/api/adk/events/stream`) maintain 100% schema compatibility.

---

## 5. Development Playbook & Commands

- **`make dev-py`**: Starts the Python FastAPI backend server with hot-reload on port 3000.
- **`make check-py`**: Runs the full Python backend test suite (`python -m backend.test_backend`).
- **`make build`**: Compiles the React 19 frontend into `dist/`.
- **`make start-py`**: Runs the production Python server on port 3000.
