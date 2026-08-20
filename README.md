# Scribant

Listens to an unfiltered stream of thoughts, transcribes them, summarizes the
key ideas, and turns detected intents into Google Workspace actions (Calendar
events, Tasks, grounded web searches, and Markdown notes saved to Drive). Runs
against the real Google APIs when you connect an account, or in a local sandbox
otherwise.

## Run locally

**Prerequisites:** Node.js, and a Google Cloud project with the Vertex AI API
enabled. There are no API keys — auth is Application Default Credentials.

1. Install dependencies:
   ```
   npm install
   ```
2. Authenticate with Google Cloud and point the app at your project:
   ```
   gcloud auth application-default login
   gcloud auth application-default set-quota-project YOUR_PROJECT_ID
   ```
   Then create a `.env`:
   ```
   GOOGLE_GENAI_USE_VERTEXAI=true
   GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID
   GOOGLE_CLOUD_LOCATION=global
   ```
   `make setup` writes this for you. On a rate limit the server backs off and
   retries twice (15s, then 30s) before surfacing the error.
3. Start the dev server (Express + Vite):
   ```
   npm run dev
   ```
   Then open http://localhost:3000.

## How it works

One orchestrator coordinates every specialist. `orchestrator.ts` composes an ADK
`SequentialAgent` — proofread, then summarize and classify in parallel over the
corrected text, then a deterministic date pass:

```
orchestrator (SequentialAgent)
├── proofreader        → proofRaw             (LlmAgent)
├── correction_applier → corrected            ⇢ "proof" stage
├── parallel
│   ├── live_summarizer   → summary           ⇢ "summary" stage
│   └── intent_classifier → planRaw
└── plan_resolver      → plan (chrono dates)  ⇢ "plan" stage
```

Sub-agents live in `agents.ts` and pass data through session state (`outputKey`
in, instruction providers out), which is what lets the deterministic steps sit
between them. Each is a factory rather than a singleton, because the Gemini key
is captured when the agent is built and both runners swap keys on a rate limit.

Every route is the same orchestrator with a different **stage set**, so no two of
them can drift apart:

- **Capture** — one debounce timer POSTs `/api/live`; stages `proof`, `summary`
  and `plan` (the classifier is skipped on a small tick). Each stage streams back
  as newline-delimited JSON the moment it lands, so the fast proofread doesn't
  wait on the slow classifier — and a stage that fails retries on its own without
  re-running the ones that already succeeded.
- **Finalize** — "Analyze Thoughts" POSTs `/api/analyze`; stage `plan` only,
  archived as a session.
- **Act** — nothing reaches Google until you approve an item. `/api/execute`
  creates one Calendar event, Task, Drive folder or Drive doc per approved item,
  dispatching by name into the `WORKSPACE_ACTIONS` registry in
  `workspace-tools.ts`, where each action's Zod schema doubles as the endpoint's
  request validation.
- **Archive** — finalizing appends the raw transcript to
  `data/transcripts/{userId}/{sessionId}.jsonl` (gitignored). `userId` is your
  Google account id when signed in, otherwise a per-browser id.

## Scripts

- `npm run dev` — Express server with Vite middleware (hot reload).
- `npm run build` — build the client bundle and the server (`dist/`).
- `npm start` — run the production build.
- `npm run lint` — typecheck with `tsc --noEmit`.
- `npm run check` — typecheck plus every module's self-check. The gate to run
  before committing; needs no API key.
- `npm run eval` — grade live agent output against the datasets in `evals/data`
  (needs a running dev server and burns quota).

## Google integration

By default the app runs in **Sandbox Mode** (simulated APIs, no real data
touched). To use real Calendar and Tasks you sign in against your own
Google Cloud OAuth client (there is no shared one):

1. In the [Google Cloud Console](https://console.cloud.google.com), create or pick a project.
2. **APIs & Services → Enable APIs**: enable **Google Calendar API**, **Google Tasks API** and **Google Drive API**.
3. **OAuth consent screen**: type *External*; add your Google account under **Test users**.
4. **Credentials → Create credentials → OAuth client ID → Web application**:
   - **Authorized JavaScript origins**: `http://localhost:3000`
   - **Authorized redirect URIs**: `http://localhost:3000`
5. Copy the **Client ID**, open Scribant → **Settings** (top right), paste it into
   *Custom GCP Client ID*, and **Save**.
6. Click **Sign in with Google**.

The redirect URI must match the address you run on exactly. Tokens live in
`localStorage` and expire after ~1 hour (sign in again to refresh).

Drive access uses the `drive.file` scope — the app can only see files it created
itself. If you were signed in before Drive was added, your existing token lacks
that scope and the Drive buttons will fail until you sign in again.
