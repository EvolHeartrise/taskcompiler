# TaskCompiler

Prompt → TypeScript workflow, self-healing ECA engine.

TaskCompiler is a Pabbly/Zapier/n8n alternative where you describe a workflow in plain English, an agent emits a TypeScript module, and the engine runs it on webhook / cron triggers. Every event is persisted. When a workflow fails, a healing agent diagnoses the bug, tests a patch against all historical events, deploys a new version, and replays every failed event — so events are never dropped.

## Status: MVP

- Runs on Cloudflare Workers. Data in D1. User workflow code is dispatched through a Workers-for-Platforms namespace (isolated V8 per workflow).
- Magic-link auth (Better Auth) and per-project membership with an `owner | admin | editor` role model.
- Agent calls go through Cloudflare AI Gateway to Workers AI. Default model: `@cf/moonshotai/kimi-k2.6`.
- Webhook + cron triggers. No external-source polling yet.

## Quickstart

```sh
bun install
bunx wrangler d1 execute taskcompiler-dev --local --file db/schema.sql
# .dev.vars (gitignored) — see "Environment" for the full list
echo 'BETTER_AUTH_SECRET=dev
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_GATEWAY_NAME=...' > .dev.vars
bun run dev        # wrangler dev
bun run deploy     # vite build + wrangler deploy
```

## Architecture

```
┌──── SvelteKit on Cloudflare Workers ─────────────────────────┐
│  Routes                                                       │
│    /projects                  user's projects                 │
│    /p/[projectId]             project home                    │
│    /p/[projectId]/new         prompt → generate → deploy      │
│    /p/[projectId]/w/[wfId]    workflow detail                 │
│    /p/[projectId]/s/[srcId]   event source                    │
│    /p/[projectId]/secrets     per-project secret vault        │
│    /p/[projectId]/members     members + invites               │
│    /invite/[token]            accept-invite (anon landing)    │
│    /auth, /api/auth/*         Better Auth                     │
│    /hook/[sourceId]           webhook endpoint (POST/GET)     │
│  worker.ts   fetch + scheduled() → cron tick handler          │
│  hooks.server.ts   auth gate + per-request log context        │
└──────────────────────────┬────────────────────────────────────┘
                           │  Cloudflare bindings
                           │    DB             D1
                           │    DISPATCHER     dispatch namespace
                           │    GEN_WORKFLOW   Cloudflare Workflow
                           │    HEAL_WORKFLOW  Cloudflare Workflow
                           │    EMAIL          send_email
┌──────────────────────────▼────────────────────────────────────┐
│  src/lib/server                                                │
│    db/           raw D1 SQL + mappers (drizzle only for        │
│                  Better Auth's tables, auth-schema.ts)         │
│    engine/       executor (persist + dispatch), replay,        │
│                  backfill, test-runner                         │
│    triggers/     cron-handler                                  │
│    webhooks/     ingest + header redaction                     │
│    wfp/          upload user source as a WFP child Worker      │
│    workflows-store/  writeVersion + tearDownWorkflow           │
│    agent/        ai-gateway client + loop + roles/{gen,heal}   │
│    healer/       deploy healed version + replay failed events  │
│    workflows/    Cloudflare Workflow classes — gen-flow.ts     │
│                  (GenerateWorkflowFlow), heal-flow.ts          │
│                  (HealWorkflowFlow)                            │
│    auth.ts       Better Auth (magic link, Google OAuth)        │
│    invites/      invite email sender                           │
└───────────────────────────────────────────────────────────────┘
```

Two senses of "workflow" coexist:

1. _User workflows_ — generated TypeScript modules, each uploaded as a child Worker in the `taskcompiler-workflows` dispatch namespace, invoked via `env.DISPATCHER.get(deployPath).fetch(...)`.
2. _Cloudflare Workflows_ — the durable-execution product. `GEN_WORKFLOW` orchestrates generation (agent loop + WFP upload + optional backfill); `HEAL_WORKFLOW` orchestrates healing (agent loop + per-event test sweep + deploy + replay). Backfill itself is _not_ a Cloudflare Workflow — it's a detached loop kicked off under `ctx.waitUntil`.

## The workflow contract

Generated workflows are single TypeScript files:

```ts
export default async function run(event: unknown, ctx: Ctx): Promise<unknown> {
	// validate event shape, throw on mismatch
	// use ctx.* for side effects
	// return a JSON-serializable value (or void)
}
```

`event` is `{ body, headers }` at runtime. `body` is the parsed payload (JSON object, form fields, text, or null) for webhooks; `{ firedAt: number }` for cron; pass-through for manual/replay. `headers` is a lowercased `Record<string, string>` with auth/signature headers redacted to `"<redacted>"` and Cloudflare proxy noise stripped; discriminator headers like `x-github-event` are preserved.

### `ctx` surface

| Property                           | Type                              | Notes                                          |
| ---------------------------------- | --------------------------------- | ---------------------------------------------- |
| `ctx.workflow`                     | `{ id, name }`                    | metadata                                       |
| `ctx.event`                        | `{ id, triggerType, receivedAt }` | `receivedAt` is original-receipt unix-ms       |
| `ctx.http.fetch(input, init?)`     | `Promise<Response>`               | logged                                         |
| `ctx.http.get(url, init?)`         | `Promise<Response>`               | logged                                         |
| `ctx.http.post(url, body?, init?)` | `Promise<Response>`               | auto-JSON-encodes plain objects                |
| `ctx.log(level, message, data?)`   | `void`                            | persisted with run + mirrored to Observability |
| `ctx.state.get<T>(key)`            | `Promise<T \| undefined>`         | per-workflow kv in D1 (`workflow_state`)       |
| `ctx.state.set(key, value)`        | `Promise<void>`                   | JSON-serializable values                       |
| `ctx.secret(name)`                 | `string`                          | reads `project_secrets`; throws if unset       |

Workflows may NOT import from `node_modules` or other files. Everything comes through `ctx`. `ctx.secret` is type-narrowed to the project's current secret names at gen/heal time — a typo is a TS error before the code is uploaded. `triggerType` is `webhook | cron | manual | replay`; compare `receivedAt` against `Date.now()` to skip stale events during replay/backfill.

## Triggers

Event sources are the unit of trigger. One source can feed many workflows (parallel dispatch, A/B, graceful cutover).

**Webhook.** A row in `event_sources` with `trigger_type='webhook'` exposes `POST /hook/<sourceId>` (JSON / form / text body → `event.body`) and `GET /hook/<sourceId>` (query params → `event.body`). The endpoint always returns `200` with a fanout summary `{ eventId, dispatched: [{ workflowId, runId, status, result?, error? }] }`. The event is persisted once and fanned out to every attached workflow; failures don't change the HTTP status — they get healed and replayed.

**Cron.** `trigger_type='cron'` + a `cron_expr`. The Worker's `scheduled()` handler fires every minute (`wrangler.toml` → `[triggers] crons = ["* * * * *"]`), scans active sources, and dispatches any due.

## Self-healing loop

```
 run fails  ─► executor atomically claims a heal slot
               (partial UNIQUE INDEX on heal_sessions WHERE status='running')
               │
               ▼
 env.HEAL_WORKFLOW.create(...)  — durable Cloudflare Workflow
               │
               ▼
 step: agent-heal (agent loop via AI Gateway)
   tools: list_events · get_event · list_failed_runs · get_run
          submit_candidate_source · emit_cannot_fix
               │
               ▼
 step: per-event sweep
   for every historical event → step.do(`test-event-${id}`, …)
                              → runAgainstEventEphemeral
               │
               ▼
   any failed? ─► yes ─► finish session status=failed, keep old
               │
               no
               ▼
 step: deploy-and-replay
   writeVersion(n+1) · createVersion(createdBy='heal')
   setAsCurrent · replayFailedEvents(workflow)
```

The agent converges by calling `submit_candidate_source`, which type-checks the source against the project's secret names, then runs it against every previously-failing event in chronological order (resuming from the last failure on re-submit). Only a fully-green sweep promotes the candidate. If the workflow gets paused mid-heal, the session is finalized `abandoned` with the proposed diff preserved for inspection.

## Multi-tenancy

Every workflow, event source, secret, and run belongs to a `project`. Access is gated by a row in `project_members`. The creator is an `owner`; other members join via invite.

Roles (from `src/lib/permissions.ts`):

| Action                            | Owner | Admin | Editor |
| --------------------------------- | :---: | :---: | :----: |
| workflow.create / edit / delete   |   ✓   |   ✓   |   ✓    |
| workflow.run / viewHistory / Code |   ✓   |   ✓   |   ✓    |
| eventSource.manage                |   ✓   |   ✓   |   ✓    |
| secret.manage                     |   ✓   |   ✓   |        |
| member.invite / invite.revoke     |   ✓   |   ✓   |        |
| member.remove / member.changeRole |   ✓   |   ✓   |        |
| project.rename                    |   ✓   |   ✓   |        |
| project.delete                    |   ✓   |       |        |
| project.transferOwnership         |   ✓   |       |        |

An admin can invite or promote peers to admin but not to owner. `requireCan(role, action)` is the server-side gate (throws a SvelteKit 403); the same matrix is imported by components to toggle UI affordances.

**Invites** are email-scoped and token-linked. `createProjectInvite` writes a row with `status='pending'`, a random token, and a 7-day expiry. The accept URL is emailed via the `EMAIL` binding, or — when `EMAIL_FROM` is unset — logged to Workers Observability as `invite.sent` with `accept_url`. Accepting at `/invite/[token]` matches the invite's `email` against the authenticated user's email, inserts a `project_members` row with the invite's role, and marks it `accepted`.

**Project deletion.** Owner-only, typed-name confirmation. `tearDownWorkflow` runs per-workflow first (deletes each WFP child Worker, clears non-cascade inner FKs `current_version_id`, `parent_version_id`, `healed_from_run_id`, `parent_run_id`, `triggering_run_id`, `new_version_id`). Then `DELETE FROM projects` — FK cascades remove `event_sources`, `project_members`, `project_invites`, `project_secrets`, and the workflow children with clean cascade paths.

## Pause / resume / backfill

Every workflow has `status IN ('active','paused')`. Pause is gated by `workflow.edit`.

- **Paused**: events still ingest and persist, but the executor short-circuits before creating a `runs` row. The healer's executor-side claim also no-ops while paused.
- **Resume**: flips to `active`. If the UI's backfill box is checked, `startBackfill` kicks off a detached FIFO loop under `ctx.waitUntil` that dispatches each un-run event (in `received_at` order) via the normal executor path with `isReplay: true`. A per-isolate single-flight map prevents double-running. The loop re-checks pause state between events, so a re-pause halts cleanly.

## Environment

TaskCompiler reads secrets + vars from Worker bindings. Locally they come from `.dev.vars` (gitignored); in prod via `wrangler secret put` or the dashboard. The canonical typed contract is `src/app.d.ts → Cloudflare.Env`.

| Var                            | Required    | Purpose                                                                             |
| ------------------------------ | ----------- | ----------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`           | yes         | Session signing for Better Auth                                                     |
| `CLOUDFLARE_API_TOKEN`         | yes         | WFP script uploads + AI Gateway calls + `scripts/logs.ts`                           |
| `CLOUDFLARE_ACCOUNT_ID`        | yes         | Same                                                                                |
| `CLOUDFLARE_GATEWAY_NAME`      | yes         | AI Gateway route name (agent calls Workers AI via this)                             |
| `CLOUDFLARE_GATEWAY_TOKEN`     | no          | Bearer token for Authenticated Gateway. Set if the gateway requires auth headers    |
| `APP_URL`                      | recommended | Override for Better Auth's baseURL + invite links (defaults to the prod Worker URL) |
| `EMAIL_FROM`                   | no          | Verified sender for magic-link + invite emails. Unset = log-only dev fallback       |
| `GOOGLE_CLIENT_ID` / `_SECRET` | no          | Optional Google OAuth for Better Auth (magic link works without it)                 |

Per-workflow secrets (API keys etc.) live in the `project_secrets` D1 table, exposed via `ctx.secret(name)`. Managed from `/p/[projectId]/secrets`; loaded fresh on every workflow invocation — rotate without redeploy.

## Smoke tests

DB-level smokes against the deployed prod Worker + D1. Each creates a throwaway user/project, replays the exact SQL real handlers run, and cleans up on exit (pre/post `COUNT()` drift check).

```sh
bun scripts/smoke-invites.ts       # create → accept → revoke / leave / remove
bun scripts/smoke-permissions.ts   # can() matrix + updateMemberRole + transferOwnership
bun scripts/smoke-pause.ts         # pause defers runs; backfill FIFO + re-pause halts
```

Also useful: `bun scripts/synthetic-webhook.ts --help` posts realistic GitHub/Stripe/Slack shapes at a webhook URL; `bun scripts/logs.ts --help` queries Workers Observability (see `docs/logging.md` for the event vocabulary).

## Writing good prompts

The agent gets the `ctx` reference plus the project's current secret names, so prompts should focus on intent and event shape:

> _Good._ "When a webhook arrives with `{ repo: string, pr_number: number, action: 'opened' | 'closed' }`, and `action === 'opened'`, post a message to Slack via `ctx.secret('SLACK_WEBHOOK_URL')` with the PR link `https://github.com/${repo}/pull/${pr_number}`. Log the outcome."

> _Bad._ "Slack me when a PR opens." (ambiguous event shape, no secret specified)

## Known limitations / deliberately-deferred

- Workflow code runs in its own WFP Worker — isolated from TaskCompiler, but _not_ sandboxed against the user's own Cloudflare account capabilities.
- No streaming of agent events to the UI — gen / heal show a final transcript only.
- Cron fires once per minute (minimum granularity). Sub-minute schedules silently coarsen.
- No rate limiting on webhook endpoints beyond Cloudflare's defaults.
- The heal test gate asserts "didn't throw", not "produced the expected output". Assertions-based testing is a natural next step.
- `scheduled()` walks every active cron source per tick; fine at current scale, will want a due-index if project count grows.

## Stack

SvelteKit · Svelte 5 (runes) · Cloudflare Workers + Workflows + D1 + Workers-for-Platforms · Better Auth · drizzle (Better Auth tables only) · `cron-parser` · sucrase (TS → JS for uploaded workflows). Agent harness inspired by [badlogic/pi-mono](https://github.com/badlogic/pi-mono).
