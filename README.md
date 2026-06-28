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
2. Create a `.env` with one or more Gemini keys. The server validates all of
   them on startup and rotates through the working ones on rate limits:
   ```
   GEMINI_API_KEY=...
   GEMINI_API_KEY1=...   # optional extra keys for rotation
   GEMINI_API_KEY2=...
   GEMINI_API_KEY3=...
   ```
   Optionally add `OLLAMA_MODEL=gemma3` (any local [Ollama](https://ollama.com)
   model) to use it as a final fallback when all Gemini keys fail. Left unset,
   no local model is attempted.
3. Start the dev server (Express + Vite):
   ```
   npm run dev
   ```
   Then open http://localhost:3000.

## Scripts

- `npm run dev` — Express server with Vite middleware (hot reload).
- `npm run build` — build the client bundle and the server (`dist/`).
- `npm start` — run the production build.
- `npm run lint` — typecheck with `tsc --noEmit`.

## Google integration

By default the app runs in **Sandbox Mode** (simulated APIs, no real data
touched). To use real Calendar, Tasks, and Drive you sign in against your own
Google Cloud OAuth client (there is no shared one):

1. In the [Google Cloud Console](https://console.cloud.google.com), create or pick a project.
2. **APIs & Services → Enable APIs**: enable **Google Calendar API**, **Google Tasks API**, **Google Drive API**.
3. **OAuth consent screen**: type *External*; add your Google account under **Test users**.
4. **Credentials → Create credentials → OAuth client ID → Web application**:
   - **Authorized JavaScript origins**: `http://localhost:3000`
   - **Authorized redirect URIs**: `http://localhost:3000`
5. Copy the **Client ID**, open Scribant → **Settings** (top right), paste it into
   *Custom GCP Client ID*, and **Save**.
6. Click **Sign in with Google**.

The redirect URI must match the address you run on exactly. Tokens live in
`localStorage` and expire after ~1 hour (sign in again to refresh).
