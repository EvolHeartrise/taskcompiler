# Cloudflare Migration Reference (April 2026)

Working reference compiled during Phase 0 of the Runely → Cloudflare migration. Subsequent milestone briefs inline relevant sections.

## 1. SvelteKit + `@sveltejs/adapter-cloudflare`

### Package Version

- **Current:** `@sveltejs/adapter-cloudflare@7.2.8` (as of April 2026)
- Install: `npm install -D @sveltejs/adapter-cloudflare@latest`

### svelte.config.js

```javascript
import adapter from '@sveltejs/adapter-cloudflare';

export default {
	kit: {
		adapter: adapter({
			platformProxy: {
				// Wrangler getPlatformProxy options
			},
			fallback: 'index.html'
		})
	}
};
```

### Minimal wrangler.toml (SvelteKit on Workers)

```toml
name = "runely-app"
main = ".svelte-kit/cloudflare/_worker.js"
compatibility_date = "2026-04-17"
compatibility_flags = ["nodejs_compat"]

[site]
bucket = ".svelte-kit/cloudflare/assets"

[build]
command = "npm run build"
```

### Flow of platform.env to Routes

- **In `+server.ts` / `+page.server.ts`:**
  ```typescript
  export async function POST({ request, platform, locals }) {
  	const db = platform.env.DB;
  	const kv = platform.env.MY_KV;
  }
  ```
- **Via `handle` hook in `hooks.server.ts`:**
  ```typescript
  export async function handle({ event, resolve }) {
  	event.locals.db = event.platform.env.DB;
  	event.locals.kv = event.platform.env.MY_KV;
  	return resolve(event);
  }
  ```

### Local Dev Story (2026 Recommended)

**Use `wrangler dev`** (not `vite dev`):

- Run: `npm run dev` mapped to `wrangler dev`
- Miniflare emulation of Workers runtime + D1 + KV locally
- Full platform.env binding emulation
- Local D1 DB persists in `.wrangler/state/d1/`

### Required Compatibility Flags

- **`nodejs_compat`** — Enables Node.js built-in APIs. Auto-pulls `nodejs_compat_v2` if `compatibility_date >= 2024-09-23`.
- **`nodejs_als`** — If you only need AsyncLocalStorage (lighter).
- SvelteKit on Workers typically requires `nodejs_compat` for SSR.

### Known Gotchas

- **Bundle size limits:** 3 MB (gzip) free, 10 MB paid. Check with `wrangler deploy --dry-run`.
- **No direct `fs` access** — use `read()` from `$app/server` or R2/KV.
- **TypeScript:** Install `@cloudflare/workers-types` for `platform.env` typing.

---

## 2. D1 (SQLite on Workers)

### wrangler.toml Binding

```toml
[[d1_databases]]
binding = "DB"
database_name = "production"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Local dev: omit `database_id`, use `preview_database_id` → local SQLite file (auto-created).

### Query API

```typescript
const stmt = env.DB.prepare('SELECT * FROM users WHERE id = ?');
const row = await stmt.bind(userId).first<User>(); // T | null
const rows = await stmt.bind(userId).all<User>(); // T[]
const result = await stmt.run(); // { success, meta }
```

### Batch API (atomic)

```typescript
const results = await env.DB.batch([
	env.DB.prepare('INSERT INTO users VALUES (?, ?)').bind(id, name),
	env.DB.prepare('UPDATE counters SET count = count + 1 WHERE id = ?').bind(id)
]);
```

### Migrations

```bash
# Create migration file in ./migrations/
npx wrangler d1 migrations create <DATABASE> <MESSAGE>
#   → ./migrations/0001_<MESSAGE>.sql

# List unapplied
npx wrangler d1 migrations list <DATABASE> [--local|--remote]

# Apply
npx wrangler d1 migrations apply <DATABASE> [--local|--remote]
```

File naming: `0000_create_users.sql`, `0001_add_email.sql`, …

### Local Development

- `wrangler dev` auto-creates local D1 in `.wrangler/state/d1/`
- Persists across restarts; delete dir to reset
- Custom location: `wrangler dev --persist-to=/path/to/db.sqlite`

---

## 3. Workers for Platforms (WFP)

### Create Namespace

```bash
curl -X POST https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/dispatch/namespaces \
  -H "Authorization: Bearer {api_token}" \
  -H "Content-Type: application/json" \
  -d '{ "name": "production" }'
```

### Upload User Worker

**Endpoint:** `PUT /accounts/{account_id}/workers/dispatch/namespaces/{namespace_name}/scripts/{script_name}`

```bash
curl -X PUT \
  https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/dispatch/namespaces/{namespace}/scripts/{worker_name} \
  -H "Authorization: Bearer {api_token}" \
  -F "metadata=@metadata.json;type=application/json" \
  -F "main.js=@dist/main.js;type=application/javascript" \
  -F "module.js=@dist/module.js;type=application/javascript"
```

**metadata.json:**

```json
{
	"main_module": "main.js",
	"bindings": [
		{ "type": "d1", "name": "DB", "database_id": "xxx" },
		{ "type": "plain_text", "name": "CUSTOMER_ID", "text": "cust_123" }
	],
	"compatibility_date": "2026-04-17",
	"compatibility_flags": ["nodejs_compat"]
}
```

- Multi-module: include each file as a form field; `main_module` must match one uploaded file
- API token needs `workers:write` + `workers:read`

### Dispatcher Binding

```toml
[[services]]
binding = "DISPATCHER"
service = "{namespace_name}"
```

```typescript
const response = await env.DISPATCHER.get(userWorkerId).fetch(request);
```

### Delete User Worker

`DELETE /accounts/{id}/workers/dispatch/namespaces/{ns}/scripts/{script_name}`

### Cron Triggers on WFP User Workers

**UNCONFIRMED (April 2026).** Workaround: Workflows `step.sleep()` / `step.sleepUntil()` or external cron → dispatcher invocation. **Verify before M4.**

---

## 4. Cloudflare Workflows

### WorkflowEntrypoint Class

```typescript
import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workflows';

export default class MyWorkflow extends WorkflowEntrypoint<Env, Params> {
	async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
		const result = await step.do('task_name', async () => {
			return await someAsyncWork();
		});
		return { success: true, data: result };
	}
}

type Params = { userId: string; action: string };
```

### Step Methods

```typescript
// step.do with retry/timeout
const r = await step.do(
	'fetch-user',
	{ retries: 5, delay: '10s', backoff: 'exponential', timeout: '30s' },
	async () => {
		/* memoized by name */
	}
);

// sleep
await step.sleep('wait-10s', '10 seconds');
await step.sleepUntil('resume-at-time', new Date(Date.now() + 3600000));

// waitForEvent
const event = await step.waitForEvent('wait-for-approval', 'approval', { timeout: '24 hours' });
```

Step memoization: name is cache key. Deterministic replay skips completed steps. Result size limit: 1 MiB per step.

### Binding (wrangler.toml)

```toml
[[workflows]]
name = "my-workflow"
class_name = "MyWorkflow"
script_name = "my-worker"
```

### Instance Lifecycle

```typescript
const instance = await env.MY_WORKFLOW.create({
	id: `user_${userId}_workflow`,
	params: { userId, action: 'process' }
});
// Status
const status = await env.MY_WORKFLOW.get(id).status();
// Returns: { status: 'running' | 'complete' | 'errored' | 'paused' | 'terminated' | ..., output?, error? }

// Controls
await instance.pause();
await instance.resume();
await instance.restart();
await instance.terminate();
```

### Streaming to Browser

**Recommended:** Workflows + Durable Object + SSE. Workflow writes per-step state to DO; HTTP handler streams via `Content-Type: text/event-stream`.

**Simpler:** Poll `/api/workflow-status/:id` from browser; handler calls `env.WORKFLOW.get(id).status()`.

### Limits

- **Steps per instance:** 10,000 (default), 25,000 (Paid)
- **Step result size:** 1 MiB (use R2 for larger)
- **Instance state:** 1 GB (Paid)
- **Retention:** 30 days (Paid)
- **Concurrent executing:** 50,000 (Paid); sleeping/waiting don't count
- **CPU per step:** 30 s default, 5 min configurable (Paid)

### Billing

- CPU: executing time only (not sleep/wait)
- Requests: one per instance creation + one per `step.do()`
- Storage: GB-month (identical to Durable Objects)

---

## 5. AI Gateway (Anthropic Integration)

### Option Picks for Runely

- **Use passthrough URL** for Anthropic (native Messages API, **tool use confirmed**).
- **BYOK for M1** (Anthropic key as Worker secret); switch to unified billing in M4 if desired.

### Endpoint

```
POST https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_NAME}/anthropic/v1/messages
```

### Headers (BYOK)

```
x-api-key: ${ANTHROPIC_API_KEY}
anthropic-version: 2023-06-01
content-type: application/json
```

### Body (Anthropic Messages API)

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 4096,
  "system": "...",
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": [
        { "type": "text", "text": "..." },
        { "type": "tool_use", "id": "toolu_...", "name": "read_file", "input": {...} }
      ]
    },
    { "role": "user", "content": [
        { "type": "tool_result", "tool_use_id": "toolu_...", "content": "..." }
      ]
    }
  ],
  "tools": [
    { "name": "read_file", "description": "...", "input_schema": { "type": "object", ... } }
  ]
}
```

**Stop reasons:** `end_turn`, `tool_use`, `max_tokens`, `stop_sequence`.

### Anthropic Tool-Use Known Issue

SDK `client.messages.toolRunner()` fails with AI Gateway unified billing (auth key injection in follow-ups). **Implement the loop manually** — we already do.

### Streaming

Add `"stream": true` to body → `ReadableStream` of text deltas.

---

## 6. Runtime TypeScript → JavaScript Transpilation

**Recommendation: transpile at upload time.** The control-plane Worker bundles `esbuild-wasm` only if it needs runtime transpile.

- **M1:** not yet relevant — current loader stays (engine unchanged in M1).
- **M2:** use `esbuild-wasm` inside control-plane OR pre-emit JS from the agent (shape-preserving, avoids wasm weight).

`esbuild-wasm` overhead: ~10 MB bundle addition, ~3× slower than native. Manageable on Paid tier (10 MB limit).

---

## 7. Size Limits & Bundle Constraints

| Plan | Compressed (gzip) | Uncompressed |
| ---- | ----------------- | ------------ |
| Free | 3 MB              | 64 MB        |
| Paid | 10 MB             | 64 MB        |

Check size: `wrangler deploy --dry-run --outdir bundled/`

Typical SvelteKit control-plane Worker: **2–3 MB gzip** → leaves ~7 MB headroom on Paid.

---

## 8. Observability & Logs

### console.log in Tenant Workers

Patterns: (a) tenant Worker returns `{result, logs}` JSON in response body, (b) Tail Worker pipes to central collector.

```toml
[tail_consumers]
service = "log-collector"
```

### Logs Engine

- Real-time in dashboard (all plans)
- Workers Logpush → external SIEM (Paid tier)

---

## 9. Queues

### Bindings

```toml
[[queues.producers]]
binding = "MY_QUEUE"

[[queues.consumers]]
queue = "my-queue"
max_batch_size = 10
max_batch_timeout = 30
```

```typescript
await env.MY_QUEUE.send({ type: 'user-signup', userId: 123 });

export default {
	async queue(batch, env) {
		for (const msg of batch.messages) {
			await msg.ack();
		}
	}
};
```

### Limits (Free, April 2026)

- 10,000 messages/day; 128 KB per message; batch up to 100; retention 24 h.

---

## 10. Durable Objects (SQLite-Backed)

### Class Shape

```typescript
import { DurableObject } from 'cloudflare:durable_objects';

export class WorkflowDO extends DurableObject {
	async fetch(request) {
		const cursor = this.state.storage.sql.exec('SELECT * FROM workflow_state WHERE id = ?', [
			this.name
		]);
		const rows = cursor.all();
		const state = await this.state.storage.get('current_state');
		await this.state.storage.put('current_state', newState);
	}
}
```

### Addressing

```typescript
const id = env.WORKFLOW_DO.idFromName(workflowId);
const stub = env.WORKFLOW_DO.get(id);
await stub.fetch(new Request('https://internal/save-state', { method: 'POST', body: jsonData }));
```

### Storage Billing

- Started **Jan 7, 2026**, per GB-month
- Limits: 10 GB per DO (Paid); 5 GB total per account (Free)

---

## UNCONFIRMED items to verify during implementation

1. Cron Triggers on user Workers in a dispatch namespace (M4 blocker — have Workflows fallback ready).
2. `env.AI` binding tool-use for Anthropic models (we use passthrough URL, so this is moot for Runely).

## Sources

- adapter-cloudflare: https://svelte.dev/docs/kit/adapter-cloudflare
- SvelteKit on Workers: https://developers.cloudflare.com/workers/framework-guides/web-apps/sveltekit/
- D1 Worker API: https://developers.cloudflare.com/d1/worker-api/d1-database/
- D1 Migrations: https://developers.cloudflare.com/d1/reference/migrations/
- Workers for Platforms: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/
- User Worker Upload: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/get-started/user-workers/
- Multipart Upload Metadata: https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/
- Workflows Overview: https://developers.cloudflare.com/workflows/
- Workflows API: https://developers.cloudflare.com/workflows/build/workers-api/
- Workflows Limits: https://developers.cloudflare.com/workflows/reference/limits/
- AI Gateway: https://developers.cloudflare.com/ai-gateway/
- Anthropic via AI Gateway: https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/
- Queues Limits: https://developers.cloudflare.com/queues/platform/limits/
- Durable Objects: https://developers.cloudflare.com/durable-objects/
- SQLite Storage API: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
