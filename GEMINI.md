# Workspace Context & Preferences — Scribant Agent

Welcome to Scribant! Scribant is an intelligent thought-partner agent that listens to unfiltered streams of speech/thought, transcribes and proofreads them, extracts structured summaries and action plans (Google Calendar events, Tasks, grounded searches, Drive notes), and integrates with Vertex AI Memory Bank and Google Workspace.

---

## 1. Workflow Preferences & Standards

- **Branching Strategy**: Feature branches (`feature/<name>` or `luis-<feature>`) branched from the primary active branch (e.g. `luis-monitoring-improvements` / `main`).
- **Use of Worktrees**: **Required**. Always create an isolated git worktree for non-trivial feature development or refactoring:
  ```bash
  git worktree add ../Scribant-Agent-<feature> -b feature/<feature-name>
  ln -s $(pwd)/node_modules ../Scribant-Agent-<feature>/node_modules
  ```
- **Commit Frequency & Quality**: Atomic commits with descriptive semantic commit messages (e.g., `feat(memory): ...`, `fix(events): ...`, `refactor(adk): ...`).
- **Automated Validation Gate**: Always run `npm run check` (runs `tsc --noEmit` + all module self-checks) and `npm run build` prior to merging or completing tasks.

---

## 2. Tech Stack & Architecture

- **Backend**: Node.js / Express (TypeScript) with `@google/adk` (Agent Development Kit v1.3.0).
- **Frontend**: React 19 + Vite + Tailwind CSS v4.
- **Port**: `3000` (Express serves API routes and integrates Vite middleware in development; serves built assets in production).
- **Core AI Framework**: Google ADK TypeScript (`@google/adk`).
- **Models & Execution**:
  - Model: Defaults to `gemini-3.6-flash` (configurable via `GEMINI_MODEL` or `MODEL`).
  - Key Rotation: Built-in multi-key load balancer in [`agents.ts`](file:///Users/luissala/development/agent-clinic-103/Scribant-Agent/agents.ts) rotating across `GEMINI_API_KEY`, `GEMINI_API_KEY1`, `GEMINI_API_KEY2`, `GEMINI_API_KEY3`, `GOOGLE_API_KEY` on rate limits (429s).
  - Vertex AI Mode: Enabled via `GOOGLE_GENAI_USE_VERTEXAI=true` or `GOOGLE_GENAI_USE_ENTERPRISE=true`, using Google Cloud ADC / IAM instead of API keys.

---

## 3. Subsystems & Codebase Map

```
Scribant-Agent/
├── agents.ts              # Specialist ADK LLM Agents & key rotation runner
├── orchestrator.ts        # ADK SequentialAgent pipeline (proofread -> summarize/classify -> plan)
├── memory.ts              # Vertex AI Memory Bank & local fallback memory system
├── adk-events.ts          # Append-only immutable ADK Event Stream & disk persistence
├── workspace-tools.ts     # Google Workspace tools registry (Calendar, Tasks, Drive)
├── transcriber.ts         # Audio chunking & transcription utilities
├── openapi.ts             # Single source of truth Zod schemas & OpenAPI 3.0.3 spec
├── server.ts              # Express API endpoints & SSE streaming handlers
├── server-utils.ts        # Server helpers & validation wrappers
├── evals/                 # Evaluation suite with LLM-as-a-judge datasets
│   ├── run.ts             # Eval runner & scoring harness
│   └── data/              # Benchmark datasets (intent, consent, correction, etc.)
├── data/                  # Persistent data storage
│   ├── events/            # Time-partitioned ADK event logs (YYYY/MM/DD/HH/events.jsonl)
│   └── memory/            # Local memory store JSON fallback
└── src/                   # React 19 Frontend
    ├── App.tsx            # Main application shell & tab routing
    ├── components/        # UI Views: ActiveSession, AdminMonitoring, ApiDocsView, etc.
    ├── hooks/             # Custom React hooks (e.g. useTabAudioCapture)
    └── utils/             # Frontend utilities (autonomy, transcript, workspace)
```

### Key Subsystems:
1. **Agent Pipeline ([`orchestrator.ts`](file:///Users/luissala/development/agent-clinic-103/Scribant-Agent/orchestrator.ts))**:
   - Composes an ADK `SequentialAgent` with custom `Step` stages:
     - `proof` (`proofreader` LLM Agent + `correction_applier`)
     - `summary` (`live_summarizer` LLM Agent)
     - `plan` (`intent_classifier` LLM Agent + `plan_resolver` deterministic chrono date parser)
   - Supports independent stage retry, stage skipping for rapid debounce ticks, and NDJSON streaming over `/api/live`.
2. **OpenAPI & Schema Single Source of Truth ([`openapi.ts`](file:///Users/luissala/development/agent-clinic-103/Scribant-Agent/openapi.ts))**:
   - All server request/response payloads MUST be defined in `openapi.ts` with Zod schemas.
   - Enforced at runtime in `server.ts` via `validatePayload(Schema, req.body)`.
   - Exposed live at `/api/openapi.json`, `/docs` (Swagger/Scalar), and in the UI via [`ApiDocsView.tsx`](file:///Users/luissala/development/agent-clinic-103/Scribant-Agent/src/components/ApiDocsView.tsx).
3. **ADK Events & Telemetry ([`adk-events.ts`](file:///Users/luissala/development/agent-clinic-103/Scribant-Agent/adk-events.ts))**:
   - Follows strict **append-only immutability** aligned with ADK standards.
   - Persists events to `data/events/{YYYY}/{MM}/{DD}/{HH}/events.jsonl`.
   - Broadcasts real-time events over Server-Sent Events (SSE) at `/api/adk/events/stream`.
4. **Memory Bank Integration ([`memory.ts`](file:///Users/luissala/development/agent-clinic-103/Scribant-Agent/memory.ts))**:
   - Integrates with Vertex AI Memory Bank (`VertexAiMemoryBankService`) and local fallback (`InMemoryMemoryService`).
   - Supports semantic search, memory insertion, context enrichment, and sync.
5. **Workspace Actions & Sandbox ([`workspace-tools.ts`](file:///Users/luissala/development/agent-clinic-103/Scribant-Agent/workspace-tools.ts))**:
   - `WORKSPACE_ACTIONS` registry for `create_calendar_event`, `create_task`, `create_drive_folder`, `create_drive_doc`.
   - Runs in sandbox mode with mock responses when unauthenticated, or real Google APIs when authenticated with OAuth tokens.

---

## 4. Environment & Secrets Configuration

Create or update `.env` in the repository root:
```ini
# Primary Gemini API key (Required)
GEMINI_API_KEY=AIzaSy...

# Optional additional keys for automated rate-limit rotation
GEMINI_API_KEY1=AIzaSy...
GEMINI_API_KEY2=AIzaSy...
GEMINI_API_KEY3=AIzaSy...

# Vertex AI Memory Bank (Optional - falls back to in-memory/local JSON if omitted)
GOOGLE_CLOUD_PROJECT=your-gcp-project-id
GOOGLE_CLOUD_LOCATION=us-central1
VERTEX_MEMORY_BANK_ID=your-memory-bank-id

# Vertex AI Enterprise Mode (Optional - uses ADC instead of API keys)
# GOOGLE_GENAI_USE_VERTEXAI=true

# Application Identification
APP_NAME=scribant
PORT=3000
```

---

## 5. Development Playbook & Commands

- **Development Server**: `npm run dev` (Starts Express + Vite with hot module replacement).
- **Code Health & Self-Check Gate**: `npm run check` (Typechecks with `tsc --noEmit` and runs all 12 submodule self-test suites).
- **Production Build**: `npm run build` (Builds Vite React client to `dist/` and bundles server via esbuild to `dist/server.cjs`).
- **Run Production**: `npm start` (Runs the compiled bundle).
- **Run Evals**: `npm run eval` (Runs LLM-as-a-judge benchmark evaluations against `evals/data/`).
- **Memory Bank Script**: `npm run create:memory-bank` (Provisions a Vertex AI Memory Bank instance in GCP).

---

## 6. Coding Invariants for Agents Working on Scribant

1. **Schema-First API Changes**: When adding or updating an API endpoint, **always** update [`openapi.ts`](file:///Users/luissala/development/agent-clinic-103/Scribant-Agent/openapi.ts) first, export the schema, and validate request/response in `server.ts` with `validatePayload`.
2. **Immutable ADK Events**: Do NOT mutate existing ADK `Event` objects or fabricate synthetic LLM tool-call events outside the runner. ADK events are strictly immutable, point-in-time facts.
3. **Preserve Self-Check Tests**: Every core module (`openapi.ts`, `agents.ts`, `orchestrator.ts`, `memory.ts`, `adk-events.ts`, `server-utils.ts`, `workspace-tools.ts`, `transcriber.ts`) includes an `if (import.meta.url === ...)` self-check suite. When modifying a module, ensure its self-check passes during `npm run check`.
4. **Light-Mode Warm Stone UI Theme**: UI components in `src/` follow Scribant's warm stone aesthetic (`bg-stone-50`, `border-stone-200`, `text-stone-800`, `amber-600` accents). Avoid dark-mode purple/violet clichés.

---

## 7. Useful Resources
- **ADK Documentation**: https://adk.dev
- **DeepWiki MCP**: For codebase and ADK repo search (`google/adk-js`).
