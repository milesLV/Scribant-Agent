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
   A local [Ollama](https://ollama.com) `gemma` model is used as a final
   fallback if all Gemini keys fail.
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
touched). Click **Sign in with Google** to authorize real Calendar, Tasks, and
Drive access via the OAuth implicit flow.
