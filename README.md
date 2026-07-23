# Scribant

Listens to an unfiltered stream of thoughts, transcribes them, summarizes the
key ideas, and turns detected intents into Google Workspace actions (Calendar
events, Tasks, and grounded web searches). Runs against the real Google APIs
when you connect an account, or in a local sandbox otherwise.

## Run locally

**Prerequisites:** Node.js, and at least one Gemini API key.

1. Install dependencies:
   ```
   npm install
   ```
2. Create a `.env` with one or more Gemini keys. Free-tier keys exhaust quickly,
   so on a rate limit the server switches to the next key immediately and only
   waits once every key is limited:
   ```
   GEMINI_API_KEY=...
   GEMINI_API_KEY1=...   # optional extra keys for rotation
   GEMINI_API_KEY2=...
   GEMINI_API_KEY3=...
   ```
3. Start the dev server (Express + Vite):
   ```
   npm run dev
   ```
   Then open http://localhost:3000.

## How it works

Four single-purpose agents live in `agents.ts` — proofreader, live summarizer,
intent classifier, grounded searcher. Each is a factory rather than a singleton,
because the Gemini key is captured when the agent is built and `askAgent` swaps
keys on a rate limit.

- **Capture** — the client runs one debounce timer and POSTs `/api/live`. The
  server proofreads first, then summarizes and classifies in parallel over the
  corrected text, streaming each stage back as newline-delimited JSON so the fast
  proofread lands without waiting on the slow classifier.
- **Finalize** — "Analyze Thoughts" POSTs `/api/analyze` for a full classifier
  pass, archived as a session. Dates are re-resolved with `chrono`, which is more
  reliable than the model at calendar arithmetic.
- **Act** — nothing reaches Google until you approve an item. `/api/execute`
  creates one Calendar event or Task per approved item.

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
2. **APIs & Services → Enable APIs**: enable **Google Calendar API** and **Google Tasks API**.
3. **OAuth consent screen**: type *External*; add your Google account under **Test users**.
4. **Credentials → Create credentials → OAuth client ID → Web application**:
   - **Authorized JavaScript origins**: `http://localhost:3000`
   - **Authorized redirect URIs**: `http://localhost:3000`
5. Copy the **Client ID**, open Scribant → **Settings** (top right), paste it into
   *Custom GCP Client ID*, and **Save**.
6. Click **Sign in with Google**.

The redirect URI must match the address you run on exactly. Tokens live in
`localStorage` and expire after ~1 hour (sign in again to refresh).
