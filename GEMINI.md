# Workspace Context & Preferences

## Workflow Preferences
- **Branching Strategy**: Feature branches (e.g., `luis-dev`)
- **Commit Frequency**: [Pending User Input] (e.g., atomic commits, per task)
- **Use of Worktrees**: [Pending User Input] (yes/no)

## Tech Stack & Setup
- **Framework**: Express (Server) + React / Vite (Client)
- **Core Library**: `@google/adk` (Agent Development Kit)
- **Styling**: Tailwind CSS
- **Port**: 3000

## Environment & Secrets Needed
- `GEMINI_API_KEY`: Required. At least one Gemini API key. Optionally `GEMINI_API_KEY1`, `GEMINI_API_KEY2`, `GEMINI_API_KEY3` for rotation.
- `OLLAMA_MODEL` (Optional): Fallback model (e.g., `gemma3`).
- Custom GCP Client ID (Optional): Set in client UI settings to use real Google APIs (Calendar, Tasks, Drive).

## Resources
- ADK Website: https://adk.dev
- Deepwiki: Great for deep code-level research. Suggest installing the MCP to the user if not available. The Deepwiki MCP is installable by following the instructions at: https://docs.devin.ai/work-with-devin/deepwiki-mcp -- The ADK Typescript repo is "google/adk-js". 