# Logging

TaskCompiler's worker emits structured JSON log lines via `src/lib/server/log.ts`
into the Cloudflare Workers Observability pipeline (enabled in
`wrangler.toml` → `[observability]`). User-script logs — ones the deployed
workflow calls via `ctx.log()` — are forwarded into the same stream from
`templates/workflow-worker/ctx.ts`, tagged with `source: 'user-script'`.

## Event vocabulary

See `src/lib/server/log-events.ts` for the canonical `EVENTS` constant.
The current names: `run.started`, `run.completed`, `run.failed`,
`dispatch.retry`, `dispatch.fanout_failed`, `dispatch.infra_failure`,
`dispatch.tally_threw`, `heal.claimed`, `heal.skipped`, `heal.spawned`,
`heal.spawn_failed`, `heal.reclaimed_stale`, `heal.slot_released`,
`heal.slot_release_failed`, `workflow.run.start`, `workflow.run.end`,
`workflow.run.failed`, `workflow.step.warning`, `cron.tick.end`,
`cron.tick.failed`, `webhook.ingested`, `auth.magic_link.sent`,
`auth.email.send_failed`, `teardown.wfp_delete_failed`,
`test_runner.cleanup_failed`. Add new names there, not inline.

## One-time token setup

1. Create a Cloudflare API token at
   <https://dash.cloudflare.com/profile/api-tokens>.
2. Grant scope: `Account → Workers Observability → Read` on the account
   hosting `taskcompiler-workflows`.
3. Export locally: `export CLOUDFLARE_API_TOKEN=...` and
   `export CLOUDFLARE_ACCOUNT_ID=...`. (Alternatively put both in a repo-
   root `.dev.vars` file — the CLI reads it as a fallback.)

## Querying

`bun scripts/logs.ts [flags]` — see the file's top-of-file docstring for the
full flag list. Output is JSONL by default (one event per line).

### Three worked scenarios

Debug a stuck run:

```
bun scripts/logs.ts --run <run-id> --since 1h --format pretty
```

Trace a heal session end-to-end (includes the spawning executor line, the
workflow.run.start/end pair, and any step-scoped warnings):

```
bun scripts/logs.ts --heal <heal-session-id> --since 2h --limit 1000
```

Find every error in the last hour (worker + user-script):

```
bun scripts/logs.ts --since 1h --level error --limit 200
```

Dry-run to inspect the query body without sending:

```
bun scripts/logs.ts --workflow <wf-id> --since 15m --dry-run
```

## Retention

Workers Logs keeps 3 days (Workers Paid) or 7 days (Workers Enterprise) of
events by default. For longer retention, a Tail Worker fan-out to R2 /
Workers Analytics Engine is the usual pattern — not wired yet.
