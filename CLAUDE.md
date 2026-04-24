## Project Configuration

- **Language**: TypeScript
- **Package Manager**: bun
- **Add-ons**: prettier, eslint, playwright, mcp

## Inspecting prod logs

Historical prod logs are queryable via `bun scripts/logs.ts` (reads `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` from env or `.dev.vars`). Prefer this over `wrangler tail` for any debugging loop — it hits Workers Observability, returns up to 3 days of history as JSONL, and filters by correlation ID in <5s. Run `bun scripts/logs.ts --help` for the flag list; `docs/logging.md` has worked examples and the canonical event-name vocabulary. Structured events emitted by `src/lib/server/log.ts` are filterable by bare key (`--run`, `--heal`, `--workflow`, `--request`, `--event`, `--level`).

---

You are able to use the Svelte MCP server, where you have access to comprehensive Svelte 5 and SvelteKit documentation. Here's how to use the available tools effectively:

## Available Svelte MCP Tools:

### 1. list-sections

Use this FIRST to discover all available documentation sections. Returns a structured list with titles, use_cases, and paths.
When asked about Svelte or SvelteKit topics, ALWAYS use this tool at the start of the chat to find relevant sections.

### 2. get-documentation

Retrieves full documentation content for specific sections. Accepts single or multiple sections.
After calling the list-sections tool, you MUST analyze the returned documentation sections (especially the use_cases field) and then use the get-documentation tool to fetch ALL documentation sections that are relevant for the user's task.

### 3. svelte-autofixer

Analyzes Svelte code and returns issues and suggestions.
You MUST use this tool whenever writing Svelte code before sending it to the user. Keep calling it until no issues or suggestions are returned.

### 4. playground-link

Generates a Svelte Playground link with the provided code.
After completing the code, ask the user if they want a playground link. Only call this tool after user confirmation and NEVER if code was written to files in their project.
