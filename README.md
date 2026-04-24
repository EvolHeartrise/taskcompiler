# Runely

Prompt → TypeScript workflow, self-healing ECA engine.

Runely is a Pabbly/Zapier/n8n alternative where you describe a workflow in plain English, the agent emits a TypeScript module, and the engine runs it on webhook / cron triggers. Every event is persisted. When a workflow fails, a healing agent diagnoses the bug, tests a patch against all historical events, deploys a new version, and replays every failed event — so events are never dropped.

## Status: MVP

- No auth / no multi-tenancy / no sandboxing. Workflows execute in-process with full Bun capabilities.
- Single-box deployment (SvelteKit + `bun:sqlite`).
- OpenRouter for model access. Default: `anthropic/claude-sonnet-4.6`.
- Webhook + cron triggers. No external-source polling yet.

## Quickstart

```sh
# 1. deps
bun install

# 2. env (OpenRouter key required for workflow generation + healing)
export OPENROUTER_API_KEY=sk-or-...

# 3. dev server
bun run dev
#   → http://localhost:5173
```

Optional: `RUNELY_DATA_DIR=/absolute/path bun run dev` (default `./data`).

## Architecture

```
┌───────────────────────── SvelteKit ─────────────────────────┐
│  Routes                                                      │
│    /                 workflow list                           │
│    /new              prompt → generate → deploy              │
│    /w/[id]           Overview · Events & Runs · Failures     │
│                      · Healings · Code                       │
│    /hook/[id]        webhook endpoint (POST/GET)             │
│  hooks.server.ts     bootstrap triggers + wire healer        │
└─────────────┬───────────────────────────────────────────────┘
              │
┌─────────────▼── src/lib/server ─────────────────────────────┐
│  db/              bun:sqlite schema + typed queries         │
│    workflows, workflow_versions, events, runs,              │
│    heal_sessions, workflow_state                            │
│                                                              │
│  triggers/        webhook (route) + cron (in-proc) + manual │
│                                                              │
│  engine/                                                     │
│    executor         persists event+run, loads + invokes     │
│                     run(event, ctx). Single-flight per wf.  │
│    loader           Bun.Transpiler → data-URL import        │
│                     (cached per version)                    │
│    context          ctx.http / log / state / secret         │
│    replay           marks old failed runs superseded,       │
│                     re-runs against current version         │
│    test-runner      ephemeral, no-persistence run for heal  │
│    hooks            pluggable on-run-failed hook            │
│                                                              │
│  workflows-store/   writes data/workflows/<id>/v<n>.ts      │
│                                                              │
│  agent/             Pi-inspired tool-calling loop           │
│    openrouter         fetch-based client                    │
│    loop               turn-taking, OpenAI tool format       │
│    tools              Tool interface + default 4 tools      │
│    roles/gen          prompt → workflow (emit_workflow)     │
│    roles/heal         failure → fixed version               │
│                                                              │
│  healer/                                                     │
│    orchestrator     on run failure: open heal_session,      │
│                     run heal agent, orchestrator-side test  │
│                     sweep against ALL historical events,    │
│                     deploy + replay on green                │
└─────────────────────────────────────────────────────────────┘
```

## The workflow contract

Generated workflows are single TypeScript files:

```ts
export default async function run(event: unknown, ctx: Ctx): Promise<unknown> {
	// validate event shape, throw on mismatch
	// use ctx.* for side effects
	// return a JSON-serializable value (or void)
}
```

### `ctx` surface (the full capability set)

| Property                           | Type                              | Notes                                      |
| ---------------------------------- | --------------------------------- | ------------------------------------------ |
| `ctx.workflow`                     | `{ id, name }`                    | metadata                                   |
| `ctx.event`                        | `{ id, triggerType, receivedAt }` | current event metadata                     |
| `ctx.http.fetch(input, init?)`     | `Promise<Response>`               | logged                                     |
| `ctx.http.get(url, init?)`         | `Promise<Response>`               | logged                                     |
| `ctx.http.post(url, body?, init?)` | `Promise<Response>`               | auto-JSON-encodes plain objects            |
| `ctx.log(level, message, data?)`   | `void`                            | persisted with the run                     |
| `ctx.state.get<T>(key)`            | `Promise<T \| undefined>`         | per-workflow kv in SQLite                  |
| `ctx.state.set(key, value)`        | `Promise<void>`                   | JSON-serializable values                   |
| `ctx.secret(name)`                 | `string`                          | reads `process.env[name]`; throws if unset |

Workflows may NOT import from `node_modules` or from other files. Everything comes through `ctx`.

## Triggers

### Webhook

Each workflow has an endpoint:

```
POST /hook/<workflowId>   # JSON body becomes event.payload
GET  /hook/<workflowId>   # query params become event.payload
```

The endpoint returns `200` with `{ eventId, runId, status, result?, error? }` whether the run succeeded or failed. This is intentional — the event is persisted either way, and failed runs will be healed and replayed.

### Cron

Set `triggerType` to `cron` or `both` and provide a cron expression (e.g. `0 9 * * *`). The scheduler runs in-process and re-reads the workflow row on each fire, so edits to the schedule take effect automatically.

## Self-healing loop

```
 run fails  ─► run-failed hook fires
             │
             ▼
 single-flight guard (getActiveHealSession)
             │
             ▼
 open heal_session(workflow, triggering_run)
             │
             ▼
 heal agent loop (OpenRouter):
   tools: list_events · get_event
          list_failed_runs · get_run
          submit_candidate_source · emit_cannot_fix
             │
             ▼
 orchestrator test sweep:
   for every historical event → runAgainstEventEphemeral
             │
             ▼
   all green? ─► no ─► heal_session status=failed, keep old version
             │
             yes
             ▼
 writeVersion(n+1) · createVersion(createdBy='heal')
 setAsCurrent · invalidateVersion(prev)
             │
             ▼
 replayFailedEvents(workflow)
   – marks old failed runs superseded
   – re-executes each against the new version
```

The agent converges by calling `submit_candidate_source`, which the harness tests against every previously-failing event (resuming from the last failure on re-submit). The orchestrator's sweep is the regression gate against previously-passing events; only it can deploy.

## Writing good prompts

The agent gets the `ctx` reference above as context, so prompts should focus on intent and event shape:

> _Good._ "When a webhook arrives with `{ repo: string, pr_number: number, action: 'opened' | 'closed' }`, and `action === 'opened'`, post a message to Slack via `ctx.secret('SLACK_WEBHOOK_URL')` with the PR link `https://github.com/${repo}/pull/${pr_number}`. Log the outcome."

> _Bad._ "Slack me when a PR opens." (ambiguous event shape, no secret specified)

## File layout

```
src/
  hooks.server.ts             bootstrapTriggers() + wireHealer()
  routes/
    +layout.svelte / +page.*  workflow list
    new/                      prompt-to-workflow form
    w/[workflowId]/           detail page with tabs
    hook/[workflowId]/        webhook endpoint
  lib/server/
    db/                       schema + queries
    engine/                   executor, loader, context, replay, test-runner
    triggers/                 cron, manual, bootstrap
    agent/                    harness + roles
    workflows-store/          on-disk TS version files
    healer/                   orchestrator + diff
scripts/
  smoke-harness.ts            non-LLM: exercises engine, failure, replay
  smoke-live.ts               LLM: generate → run, requires OPENROUTER_API_KEY
data/                         (gitignored) runely.db + workflows/<id>/v<n>.ts
```

## Smoke tests

```sh
bun run smoke:harness     # no key required
bun run smoke:live        # requires OPENROUTER_API_KEY
```

`smoke:harness` validates: create workflow, execute, capture failure, fire the run-failed hook, simulate heal-deploy, replay, mark superseded. Fully exercises the harness minus the LLM.

`smoke:live` generates a real workflow from a prompt via OpenRouter, fires a webhook, and verifies the result.

## Environment

| Var                             | Required       | Default  | Purpose                                     |
| ------------------------------- | -------------- | -------- | ------------------------------------------- |
| `OPENROUTER_API_KEY`            | for gen + heal | —        | OpenRouter bearer token                     |
| `RUNELY_DATA_DIR`               | no             | `./data` | sqlite db + workflow source files           |
| `RUNELY_SECRET_*` / any env var | per-workflow   | —        | exposed to workflows via `ctx.secret(name)` |

## Known limitations / deliberately-deferred

- No sandboxing. Workflows run with full Bun capabilities (fs, net, env) — do not run untrusted workflows.
- No account system, no multi-tenant isolation.
- No streaming of agent events to the UI (gen / heal show a final transcript only).
- Cron scheduler is in-process; restart resets timers (they're rebuilt on boot from DB).
- No rate limiting on webhooks.
- The heal test gate currently asserts "didn't throw" — not "produced the expected output." Assertions-based testing is a natural next step.

## Stack

Bun · SvelteKit · Svelte 5 (runes) · TypeScript · `bun:sqlite` · OpenRouter · `cron-parser`. Agent harness inspired by [badlogic/pi-mono](https://github.com/badlogic/pi-mono).
