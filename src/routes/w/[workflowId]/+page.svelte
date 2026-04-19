<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';
	import type { Event, HealSession, Run, WorkflowVersion } from '$lib/server/db/types';

	let { data, form }: PageProps = $props();

	let genInFlight = $derived(
		data.inFlight.gen?.status === 'running' || data.inFlight.gen?.status === 'queued'
	);
	let healInFlight = $derived(
		data.inFlight.heal?.status === 'running' || data.inFlight.heal?.status === 'queued'
	);
	let anyInFlight = $derived(genInFlight || healInFlight);

	$effect(() => {
		if (!anyInFlight) return;
		const id = setInterval(() => {
			void invalidateAll();
		}, 3000);
		return () => clearInterval(id);
	});

	type TabId = 'overview' | 'events' | 'failures' | 'healings' | 'code';
	const TABS: { id: TabId; label: string }[] = [
		{ id: 'overview', label: 'Overview' },
		{ id: 'events', label: 'Events & Runs' },
		{ id: 'failures', label: 'Failures' },
		{ id: 'healings', label: 'Healings' },
		{ id: 'code', label: 'Code' }
	];

	let activeTab = $derived<TabId>(
		((page.url.searchParams.get('tab') as TabId | null) ?? 'overview') as TabId
	);

	function tabQuery(id: TabId, extra?: Record<string, string>): string {
		const sp = new URLSearchParams(page.url.searchParams);
		sp.set('tab', id);
		if (extra) {
			for (const [k, v] of Object.entries(extra)) sp.set(k, v);
		}
		return sp.toString();
	}

	let webhookUrl = $derived(`${data.origin}/hook/${data.workflow.id}`);

	let triggerPayload = $state('{}');
	let copied = $state(false);

	async function copyWebhook() {
		try {
			await navigator.clipboard.writeText(webhookUrl);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			// ignore
		}
	}

	function fmt(ts: number | null | undefined): string {
		if (!ts) return '—';
		return new Date(ts).toLocaleString();
	}

	function duration(startedAt: number, finishedAt: number | null): string {
		if (finishedAt === null) return 'running…';
		const ms = finishedAt - startedAt;
		if (ms < 1000) return `${ms}ms`;
		return `${(ms / 1000).toFixed(2)}s`;
	}

	function truncate(s: string, n: number): string {
		if (s.length <= n) return s;
		return s.slice(0, n) + '…';
	}

	function safeJson(v: unknown): string {
		try {
			return JSON.stringify(v, null, 2);
		} catch {
			return String(v);
		}
	}

	function shortId(id: string): string {
		return id.slice(0, 8);
	}

	function triggerLabel(t: string, cron: string | null): string {
		if (t === 'webhook') return 'webhook';
		if (t === 'cron') return cron ? `cron (${cron})` : 'cron';
		return cron ? `both (${cron})` : 'both';
	}

	// Expand state for rows
	let expandedEvents = $state<Record<string, boolean>>({});
	let expandedRuns = $state<Record<string, boolean>>({});
	let expandedFailures = $state<Record<string, boolean>>({});
	let expandedHeals = $state<Record<string, boolean>>({});
	let transcriptOpen = $state<Record<string, boolean>>({});

	function toggle(map: Record<string, boolean>, id: string): void {
		map[id] = !map[id];
	}

	// Selected version for the Code tab
	let selectedVersionId = $derived(
		page.url.searchParams.get('version') ?? data.currentVersion?.id ?? ''
	);
	let selectedVersion = $derived<WorkflowVersion | null>(
		data.versions.find((v) => v.id === selectedVersionId) ??
			data.selectedVersion ??
			data.currentVersion ??
			null
	);

	function findHealForRun(runId: string): HealSession | undefined {
		return data.heals.find((h) => h.triggeringRunId === runId);
	}

	function findRunForEvent(eventId: string): Run | undefined {
		return data.runs.find((r) => r.eventId === eventId);
	}

	function findEvent(eventId: string): Event | undefined {
		return data.events.find((e) => e.id === eventId);
	}

	const triggerResult = $derived(form?.trigger);
	const replayResult = $derived(form?.replay);
</script>

<div class="head">
	<div>
		<div class="crumbs">
			<a href={resolve('/')}>← Workflows</a>
		</div>
		<h1>{data.workflow.name}</h1>
		<div class="meta">
			<span class="chip">{triggerLabel(data.workflow.triggerType, data.workflow.cronExpr)}</span>
			<span class="mono muted">{data.workflow.id}</span>
			<span class="muted">· created {fmt(data.workflow.createdAt)}</span>
			{#if data.currentVersion}
				<span class="muted">· v{data.currentVersion.version}</span>
			{/if}
		</div>
	</div>
</div>

<nav class="tabs">
	{#each TABS as t (t.id)}
		<a
			class="tab"
			class:active={activeTab === t.id}
			href={resolve(`/w/[workflowId]?${tabQuery(t.id)}` as `/w/[workflowId]?${string}`, {
				workflowId: data.workflow.id
			})}
		>
			{t.label}
			{#if t.id === 'failures' && data.stats.totalFailed > 0}
				<span class="tab-count">{data.stats.totalFailed}</span>
			{/if}
			{#if t.id === 'healings' && data.stats.totalHeals > 0}
				<span class="tab-count">{data.stats.totalHeals}</span>
			{/if}
		</a>
	{/each}
</nav>

{#if activeTab === 'overview'}
	{#if genInFlight}
		<div class="banner banner-info">
			<strong>Generating workflow…</strong>
			<span class="muted small">This page auto-refreshes every 3 seconds.</span>
		</div>
	{:else if data.inFlight.gen?.status === 'errored'}
		<div class="banner banner-error">
			<strong>Generation failed</strong>
			{#if data.inFlight.gen.error}
				<span class="muted small">{data.inFlight.gen.error.name}: {data.inFlight.gen.error.message}</span>
			{/if}
		</div>
	{/if}
	{#if healInFlight}
		<div class="banner banner-info">
			<strong>Healing in progress…</strong>
			<span class="muted small">This page auto-refreshes every 3 seconds.</span>
		</div>
	{/if}
	<section class="grid">
		<div class="card stats">
			<div class="stat"><div class="k">Events</div><div class="v">{data.stats.totalEvents}</div></div>
			<div class="stat"><div class="k">Runs</div><div class="v">{data.stats.totalRuns}</div></div>
			<div class="stat">
				<div class="k">Failed runs</div>
				<div class="v" class:danger={data.stats.totalFailed > 0}>{data.stats.totalFailed}</div>
			</div>
			<div class="stat">
				<div class="k">Heal sessions</div>
				<div class="v">{data.stats.totalHeals}</div>
			</div>
		</div>

		<div class="card">
			<h2>Webhook URL</h2>
			<div class="webhook-row">
				<code class="webhook">{webhookUrl}</code>
				<button type="button" class="btn small" onclick={copyWebhook}>
					{copied ? 'Copied ✓' : 'Copy'}
				</button>
			</div>
			<p class="muted small">
				Send a <code>POST</code> with a JSON body, or <code>GET</code> with query params.
			</p>
		</div>

		<div class="card">
			<h2>Manual trigger</h2>
			<form
				method="POST"
				action="?/trigger"
				use:enhance={() => {
					return async ({ update }) => {
						await update({ reset: false });
					};
				}}
			>
				<label class="field">
					<span>Payload (JSON)</span>
					<textarea name="payload" rows="5" bind:value={triggerPayload}></textarea>
				</label>
				<button class="btn primary" type="submit">Trigger</button>
			</form>
			{#if triggerResult}
				{#if 'ok' in triggerResult && triggerResult.ok}
					<div
						class="result"
						class:ok={triggerResult.status === 'ok'}
						class:failed={triggerResult.status === 'failed'}
					>
						<div><strong>status:</strong> {triggerResult.status}</div>
						<div><strong>eventId:</strong> <span class="mono">{triggerResult.eventId}</span></div>
						<div><strong>runId:</strong> <span class="mono">{triggerResult.runId}</span></div>
						{#if triggerResult.result !== null && triggerResult.result !== undefined}
							<details><summary>result</summary><pre>{safeJson(triggerResult.result)}</pre></details>
						{/if}
						{#if triggerResult.error}
							<details open
								><summary>error</summary><pre>{safeJson(triggerResult.error)}</pre></details
							>
						{/if}
					</div>
				{:else if 'error' in triggerResult}
					<div class="alert">{triggerResult.error}</div>
				{/if}
			{/if}
		</div>

		<div class="card">
			<h2>Replay failed events</h2>
			<p class="muted small">
				Re-executes every failed event through the current version. Successful replays are
				counted as new OK runs, and the original failures are marked superseded.
			</p>
			<form
				method="POST"
				action="?/replay"
				use:enhance={() => {
					return async ({ update }) => {
						await update({ reset: false });
					};
				}}
			>
				<button class="btn" type="submit" disabled={data.stats.totalFailed === 0}>
					Replay {data.stats.totalFailed} failed run{data.stats.totalFailed === 1 ? '' : 's'}
				</button>
			</form>
			{#if replayResult}
				{#if 'ok' in replayResult && replayResult.ok}
					<div class="result ok">
						<div>
							Attempted: {replayResult.attempted} · OK: {replayResult.okCount} · Failed: {replayResult.failedCount}
						</div>
					</div>
				{:else if 'error' in replayResult}
					<div class="alert">{replayResult.error}</div>
				{/if}
			{/if}
		</div>
	</section>
{/if}

{#if activeTab === 'events'}
	<section class="split">
		<div class="card">
			<h2>Events <span class="muted small">({data.events.length})</span></h2>
			{#if data.events.length === 0}
				<div class="muted small">No events yet. Fire the webhook or use Manual trigger.</div>
			{:else}
				<ul class="rows">
					{#each data.events as ev (ev.id)}
						{@const run = findRunForEvent(ev.id)}
						<li>
							<button class="row-btn" type="button" onclick={() => toggle(expandedEvents, ev.id)}>
								<div class="row-head">
									<span class="mono">{shortId(ev.id)}</span>
									<span class="chip small">{ev.triggerType}</span>
									<span class="muted small">{fmt(ev.receivedAt)}</span>
								</div>
								<div class="row-body">
									<code class="preview">{truncate(safeJson(ev.payload), 200)}</code>
								</div>
							</button>
							{#if expandedEvents[ev.id]}
								<div class="details">
									<div class="kv"><span>event id</span><code>{ev.id}</code></div>
									{#if run}
										<div class="kv"><span>latest run</span><code>{run.id}</code> <span class="badge {run.status}">{run.status}</span></div>
									{/if}
									<div class="block">
										<div class="label">payload</div>
										<pre>{safeJson(ev.payload)}</pre>
									</div>
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		<div class="card">
			<h2>Runs <span class="muted small">({data.runs.length})</span></h2>
			{#if data.runs.length === 0}
				<div class="muted small">No runs yet.</div>
			{:else}
				<ul class="rows">
					{#each data.runs as run (run.id)}
						<li>
							<button class="row-btn" type="button" onclick={() => toggle(expandedRuns, run.id)}>
								<div class="row-head">
									<span class="mono">{shortId(run.id)}</span>
									<span class="badge {run.status}">{run.status}</span>
									<span class="muted small">{fmt(run.startedAt)}</span>
									<span class="muted small">· {duration(run.startedAt, run.finishedAt)}</span>
									{#if run.isReplay}<span class="chip small">replay</span>{/if}
								</div>
								<div class="row-body muted small">
									event {shortId(run.eventId)}
								</div>
							</button>
							{#if expandedRuns[run.id]}
								<div class="details">
									<div class="kv"><span>run id</span><code>{run.id}</code></div>
									<div class="kv"><span>event id</span><code>{run.eventId}</code></div>
									<div class="kv"><span>version id</span><code>{run.versionId}</code></div>
									{#if run.parentRunId}
										<div class="kv"><span>parent run</span><code>{run.parentRunId}</code></div>
									{/if}
									{#if run.result !== null && run.result !== undefined}
										<div class="block">
											<div class="label">result</div>
											<pre>{safeJson(run.result)}</pre>
										</div>
									{/if}
									{#if run.error}
										<div class="block">
											<div class="label">error</div>
											<pre>{run.error.name}: {run.error.message}
{run.error.stack ?? ''}</pre>
										</div>
									{/if}
									{#if run.logs && run.logs.length > 0}
										<div class="block">
											<div class="label">logs</div>
											<pre>{run.logs
													.map((l) => `[${new Date(l.ts).toISOString()}] ${l.level.toUpperCase()} ${l.message}${l.data !== undefined ? ' ' + safeJson(l.data) : ''}`)
													.join('\n')}</pre>
										</div>
									{/if}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</section>
{/if}

{#if activeTab === 'failures'}
	<section>
		<div class="card">
			<h2>Failed runs <span class="muted small">({data.failedRuns.length})</span></h2>
			{#if data.failedRuns.length === 0}
				<div class="muted small">No failures 🎉</div>
			{:else}
				<ul class="rows">
					{#each data.failedRuns as run (run.id)}
						{@const heal = findHealForRun(run.id)}
						<li>
							<button
								class="row-btn"
								type="button"
								onclick={() => toggle(expandedFailures, run.id)}
							>
								<div class="row-head">
									<span class="mono">{shortId(run.id)}</span>
									<span class="badge failed">failed</span>
									<span class="muted small">{fmt(run.startedAt)}</span>
								</div>
								<div class="row-body">
									{#if run.error}
										<strong>{run.error.name}</strong>:
										<span class="muted">{truncate(run.error.message, 160)}</span>
									{/if}
									{#if heal}
										<span class="chip small">heal {heal.status}</span>
									{/if}
								</div>
							</button>
							{#if expandedFailures[run.id]}
								<div class="details">
									<div class="kv"><span>run id</span><code>{run.id}</code></div>
									<div class="kv"><span>event id</span><code>{run.eventId}</code></div>
									{#if heal}
										<div class="kv">
											<span>heal session</span>
											<a
												href={resolve(
													`/w/[workflowId]?${tabQuery('healings', { heal: heal.id })}` as `/w/[workflowId]?${string}`,
													{ workflowId: data.workflow.id }
												)}
												><code>{heal.id}</code></a
											>
											<span class="badge {heal.status}">{heal.status}</span>
										</div>
									{/if}
									{#if run.error}
										<div class="block">
											<div class="label">error</div>
											<pre>{run.error.name}: {run.error.message}

{run.error.stack ?? ''}</pre>
										</div>
									{/if}
									{#if run.logs && run.logs.length > 0}
										<div class="block">
											<div class="label">logs</div>
											<pre>{run.logs
													.map((l) => `[${new Date(l.ts).toISOString()}] ${l.level.toUpperCase()} ${l.message}${l.data !== undefined ? ' ' + safeJson(l.data) : ''}`)
													.join('\n')}</pre>
										</div>
									{/if}
									{#if findEvent(run.eventId)}
										<div class="block">
											<div class="label">event payload</div>
											<pre>{safeJson(findEvent(run.eventId)?.payload)}</pre>
										</div>
									{/if}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</section>
{/if}

{#if activeTab === 'healings'}
	<section>
		<div class="card">
			<h2>Heal sessions <span class="muted small">({data.heals.length})</span></h2>
			{#if data.heals.length === 0}
				<div class="muted small">No healings yet.</div>
			{:else}
				<ul class="rows">
					{#each data.heals as h (h.id)}
						<li>
							<button class="row-btn" type="button" onclick={() => toggle(expandedHeals, h.id)}>
								<div class="row-head">
									<span class="mono">{shortId(h.id)}</span>
									<span class="badge {h.status}">{h.status}</span>
									<span class="muted small">started {fmt(h.startedAt)}</span>
									<span class="muted small">· finished {fmt(h.finishedAt)}</span>
								</div>
								<div class="row-body muted small">
									triggered by run {shortId(h.triggeringRunId)}
									{#if h.testResults}
										· tests {h.testResults.passed}/{h.testResults.total}
									{/if}
									{#if h.newVersionId}
										· new version
									{/if}
								</div>
							</button>
							{#if expandedHeals[h.id]}
								<div class="details">
									<div class="kv"><span>id</span><code>{h.id}</code></div>
									<div class="kv"><span>triggering run</span><code>{h.triggeringRunId}</code></div>
									{#if h.newVersionId}
										<div class="kv">
											<span>new version</span>
											<a
												href={resolve(
													`/w/[workflowId]?${tabQuery('code', { version: h.newVersionId })}` as `/w/[workflowId]?${string}`,
													{ workflowId: data.workflow.id }
												)}><code>{h.newVersionId}</code></a
											>
										</div>
									{/if}
									{#if h.diff}
										<div class="block">
											<div class="label">diff</div>
											<pre>{h.diff}</pre>
										</div>
									{/if}
									{#if h.testResults}
										<div class="block">
											<div class="label">
												test results ({h.testResults.passed}/{h.testResults.total})
											</div>
											<table class="inner">
												<thead>
													<tr><th>event</th><th>ok</th><th>error</th></tr>
												</thead>
												<tbody>
													{#each h.testResults.details as d (d.eventId)}
														<tr>
															<td class="mono">{shortId(d.eventId)}</td>
															<td>
																{#if d.ok}
																	<span class="badge ok">ok</span>
																{:else}
																	<span class="badge failed">fail</span>
																{/if}
															</td>
															<td class="muted">
																{#if d.error}
																	{d.error.name}: {truncate(d.error.message, 120)}
																{:else}—{/if}
															</td>
														</tr>
													{/each}
												</tbody>
											</table>
										</div>
									{/if}
									{#if h.agentTranscript && h.agentTranscript.length > 0}
										<div class="block">
											<button
												class="disclosure"
												type="button"
												onclick={() => toggle(transcriptOpen, h.id)}
											>
												{transcriptOpen[h.id] ? '▾' : '▸'} agent transcript ({h.agentTranscript.length})
											</button>
											{#if transcriptOpen[h.id]}
												<ul class="transcript">
													{#each h.agentTranscript as t, i (i)}
														<li>
															<div class="t-head">
																<span class="chip small">{t.role}</span>
																<span class="muted small">{fmt(t.ts)}</span>
															</div>
															<pre>{t.message}</pre>
															{#if t.data !== undefined}
																<pre class="data">{safeJson(t.data)}</pre>
															{/if}
														</li>
													{/each}
												</ul>
											{/if}
										</div>
									{/if}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</section>
{/if}

{#if activeTab === 'code'}
	<section>
		<div class="card">
			<div class="code-head">
				<label>
					<span>Version</span>
					<select
						onchange={(e) => {
							const v = (e.currentTarget as HTMLSelectElement).value;
							window.location.href = resolve(
								`/w/[workflowId]?${tabQuery('code', { version: v })}` as `/w/[workflowId]?${string}`,
								{ workflowId: data.workflow.id }
							);
						}}
					>
						{#each data.versions as v (v.id)}
							<option value={v.id} selected={selectedVersion?.id === v.id}>
								v{v.version} · {v.createdBy} · {fmt(v.createdAt)}
								{v.id === data.currentVersion?.id ? '(current)' : ''}
							</option>
						{/each}
					</select>
				</label>
			</div>

			{#if selectedVersion}
				<div class="version-meta">
					<div class="kv"><span>version</span>{selectedVersion.version}</div>
					<div class="kv"><span>createdBy</span>{selectedVersion.createdBy}</div>
					<div class="kv"><span>createdAt</span>{fmt(selectedVersion.createdAt)}</div>
					{#if selectedVersion.parentVersionId}
						<div class="kv">
							<span>parent</span>
							<a
								href={resolve(
									`/w/[workflowId]?${tabQuery('code', { version: selectedVersion.parentVersionId })}` as `/w/[workflowId]?${string}`,
									{ workflowId: data.workflow.id }
								)}><code>{selectedVersion.parentVersionId}</code></a
							>
						</div>
					{/if}
					{#if selectedVersion.healedFromRunId}
						<div class="kv">
							<span>healed from run</span>
							<code>{selectedVersion.healedFromRunId}</code>
						</div>
					{/if}
				</div>
				<pre class="code"><code>{selectedVersion.sourceTs}</code></pre>
			{:else}
				<div class="muted small">No version available.</div>
			{/if}
		</div>
	</section>
{/if}

<style>
	.head {
		margin-bottom: 12px;
	}
	.crumbs {
		font-size: 13px;
		margin-bottom: 4px;
	}
	h1 {
		font-size: 22px;
		margin: 0 0 4px;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
		font-size: 13px;
	}
	.chip {
		display: inline-block;
		padding: 2px 8px;
		border-radius: 999px;
		background: #eef2ff;
		color: #3730a3;
		font-size: 12px;
		font-weight: 500;
	}
	.chip.small {
		font-size: 11px;
		padding: 1px 7px;
	}
	.tabs {
		display: flex;
		gap: 2px;
		border-bottom: 1px solid #e5e7eb;
		margin: 14px 0 20px;
	}
	.tab {
		padding: 10px 14px;
		color: #4b5563;
		border-bottom: 2px solid transparent;
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.tab:hover {
		color: #111;
		text-decoration: none;
	}
	.tab.active {
		color: #111;
		border-bottom-color: #111;
		font-weight: 600;
	}
	.tab-count {
		background: #fee2e2;
		color: #991b1b;
		border-radius: 999px;
		padding: 0 7px;
		font-size: 11px;
		font-weight: 600;
	}
	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 16px;
	}
	.split {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 16px;
	}
	.card {
		background: #fff;
		border: 1px solid #e5e7eb;
		border-radius: 8px;
		padding: 16px;
	}
	.card h2 {
		font-size: 14px;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: #374151;
		margin: 0 0 10px;
	}
	.stats {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 10px;
	}
	.stat .k {
		font-size: 11px;
		color: #6b7280;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}
	.stat .v {
		font-size: 24px;
		font-weight: 700;
		color: #111;
	}
	.stat .v.danger {
		color: #dc2626;
	}
	.webhook-row {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.webhook {
		flex: 1;
		background: #f3f4f6;
		padding: 8px 10px;
		border-radius: 4px;
		overflow-x: auto;
		white-space: nowrap;
	}
	.field {
		display: block;
		margin-bottom: 10px;
	}
	.field > span {
		display: block;
		font-weight: 600;
		font-size: 12px;
		margin-bottom: 4px;
	}
	textarea {
		width: 100%;
		padding: 8px 10px;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		font-family: ui-monospace, monospace;
		font-size: 12.5px;
	}
	.btn {
		display: inline-block;
		padding: 7px 12px;
		border-radius: 6px;
		border: 1px solid #d1d5db;
		background: #fff;
		color: #111;
		cursor: pointer;
	}
	.btn.primary {
		background: #111827;
		border-color: #111827;
		color: #fff;
	}
	.btn.small {
		padding: 5px 10px;
		font-size: 12px;
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.alert {
		background: #fef2f2;
		border: 1px solid #fecaca;
		color: #991b1b;
		border-radius: 6px;
		padding: 8px 10px;
		margin-top: 10px;
	}
	.banner {
		display: flex;
		gap: 10px;
		align-items: baseline;
		border-radius: 6px;
		padding: 10px 14px;
		margin-bottom: 14px;
	}
	.banner-info {
		background: #eff6ff;
		border: 1px solid #bfdbfe;
		color: #1e3a8a;
	}
	.banner-error {
		background: #fef2f2;
		border: 1px solid #fecaca;
		color: #991b1b;
	}
	.result {
		margin-top: 10px;
		padding: 10px 12px;
		border-radius: 6px;
		border: 1px solid #e5e7eb;
		background: #f9fafb;
		font-size: 13px;
	}
	.result.ok {
		border-color: #86efac;
		background: #f0fdf4;
	}
	.result.failed {
		border-color: #fca5a5;
		background: #fef2f2;
	}
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.rows li {
		border: 1px solid #e5e7eb;
		border-radius: 6px;
		overflow: hidden;
	}
	.row-btn {
		display: block;
		width: 100%;
		padding: 10px 12px;
		border: none;
		background: #fff;
		text-align: left;
		cursor: pointer;
	}
	.row-btn:hover {
		background: #fafbfc;
	}
	.row-head {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-wrap: wrap;
	}
	.row-body {
		margin-top: 4px;
		font-size: 12.5px;
		color: #374151;
	}
	.preview {
		display: block;
		background: #f9fafb;
		padding: 6px 8px;
		border-radius: 4px;
		color: #475569;
		overflow-x: auto;
		white-space: nowrap;
	}
	.details {
		border-top: 1px solid #e5e7eb;
		padding: 12px;
		background: #fafbfc;
		font-size: 13px;
	}
	.kv {
		margin-bottom: 4px;
	}
	.kv > span:first-child {
		display: inline-block;
		min-width: 110px;
		color: #6b7280;
		font-weight: 500;
	}
	.block {
		margin-top: 10px;
	}
	.block .label {
		font-size: 11px;
		text-transform: uppercase;
		color: #6b7280;
		margin-bottom: 4px;
		letter-spacing: 0.03em;
	}
	pre {
		background: #0f172a;
		color: #e2e8f0;
		padding: 10px 12px;
		border-radius: 4px;
		overflow-x: auto;
		font-size: 12px;
		margin: 0;
		white-space: pre-wrap;
		word-break: break-word;
	}
	pre.data {
		background: #1e293b;
		margin-top: 4px;
	}
	.badge {
		display: inline-block;
		padding: 1px 8px;
		border-radius: 999px;
		font-size: 11.5px;
		font-weight: 600;
	}
	.badge.ok,
	.badge.success {
		background: #dcfce7;
		color: #166534;
	}
	.badge.failed {
		background: #fee2e2;
		color: #991b1b;
	}
	.badge.running {
		background: #fef3c7;
		color: #92400e;
	}
	.badge.superseded,
	.badge.abandoned {
		background: #e5e7eb;
		color: #4b5563;
	}
	.mono {
		font-family: ui-monospace, monospace;
		font-size: 12px;
	}
	.muted {
		color: #6b7280;
	}
	.small {
		font-size: 12px;
	}
	.inner {
		width: 100%;
		border-collapse: collapse;
	}
	.inner th,
	.inner td {
		padding: 4px 8px;
		border-bottom: 1px solid #e5e7eb;
		text-align: left;
		font-size: 12.5px;
	}
	.inner th {
		font-weight: 600;
		color: #374151;
	}
	.disclosure {
		background: transparent;
		border: none;
		padding: 4px 0;
		color: #111;
		cursor: pointer;
		font: inherit;
	}
	.transcript {
		list-style: none;
		padding: 0;
		margin: 8px 0 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.transcript li {
		border: 1px solid #e5e7eb;
		border-radius: 4px;
		padding: 8px 10px;
		background: #fff;
	}
	.t-head {
		display: flex;
		gap: 8px;
		align-items: center;
		margin-bottom: 4px;
	}
	.code-head {
		display: flex;
		gap: 10px;
		align-items: center;
		margin-bottom: 10px;
	}
	.code-head select {
		padding: 6px 8px;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		font: inherit;
	}
	.version-meta {
		background: #f9fafb;
		border: 1px solid #e5e7eb;
		border-radius: 4px;
		padding: 10px 12px;
		margin-bottom: 12px;
		font-size: 13px;
	}
	.code {
		max-height: 560px;
		overflow: auto;
	}
	@media (max-width: 900px) {
		.grid,
		.split {
			grid-template-columns: 1fr;
		}
		.stats {
			grid-template-columns: repeat(2, 1fr);
		}
	}
</style>
