<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let projectId = $derived(page.params.projectId!);
	let sourceId = $derived(page.params.sourceId!);

	let webhookUrl = $derived(`${data.origin}/hook/${data.eventSource.id}`);
	let copied = $state(false);
	let expandedEvents = $state<Record<string, boolean>>({});
	let deleteDialog: HTMLDialogElement | undefined = $state();
	let deleteConfirmName = $state('');
	let canDelete = $derived(deleteConfirmName === data.eventSource.name);
	const deleteResult = $derived(form?.delete);

	function fmt(ts: number | null | undefined): string {
		if (!ts) return '—';
		return new Date(ts).toLocaleString();
	}

	function shortId(id: string): string {
		return id.slice(0, 8);
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

	function toggle(map: Record<string, boolean>, id: string): void {
		map[id] = !map[id];
	}

	function triggerLabel(t: string, cron: string | null): string {
		if (t === 'cron') return cron ? `cron (${cron})` : 'cron';
		return 'webhook';
	}

	async function copyWebhook() {
		try {
			await navigator.clipboard.writeText(webhookUrl);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			/* clipboard API unavailable */
		}
	}

	function openDeleteDialog() {
		deleteConfirmName = '';
		deleteDialog?.showModal();
	}
	function closeDeleteDialog() {
		deleteDialog?.close();
	}
	$effect(() => {
		if (deleteResult && 'error' in deleteResult) {
			deleteDialog?.showModal();
		}
	});
</script>

<div class="head">
	<div>
		<div class="crumbs">
			<a href={resolve('/p/[projectId]', { projectId })}>← Events</a>
		</div>
		<h1>{data.eventSource.name}</h1>
		<div class="meta">
			<span class="chip"
				>{triggerLabel(data.eventSource.triggerType, data.eventSource.cronExpr)}</span
			>
			<span class="mono muted">{data.eventSource.id}</span>
			<span class="muted">· created {fmt(data.eventSource.createdAt)}</span>
		</div>
	</div>
</div>

<section class="grid">
	<div class="card stats">
		<div class="stat">
			<div class="k">Events received</div>
			<div class="v">{data.stats.totalEvents}</div>
		</div>
		<div class="stat">
			<div class="k">Attached workflows</div>
			<div class="v">{data.workflows.length}</div>
		</div>
	</div>

	{#if data.eventSource.triggerType === 'webhook'}
		<div class="card">
			<h2>Webhook URL</h2>
			<div class="webhook-row">
				<code class="webhook">{webhookUrl}</code>
				<button type="button" class="btn small" onclick={copyWebhook}>
					{copied ? 'Copied ✓' : 'Copy'}
				</button>
			</div>
			<p class="muted small">
				Send a <code>POST</code> with a JSON body, or <code>GET</code> with query params. Each request
				fans out to every attached workflow.
			</p>
		</div>
	{:else}
		<div class="card">
			<h2>Schedule</h2>
			<div class="webhook-row">
				<code class="webhook">{data.eventSource.cronExpr ?? '—'}</code>
			</div>
			<p class="muted small">
				Fires automatically on this schedule (UTC). Every tick emits one event that fans out to each
				attached workflow.
			</p>
		</div>
	{/if}
</section>

<section>
	<div class="section-head">
		<h2>Attached workflows</h2>
		<a
			class="btn primary small"
			href={resolve(
				`/p/[projectId]/new?source=${encodeURIComponent(sourceId)}` as `/p/[projectId]/new?${string}`,
				{ projectId }
			)}
		>
			+ Attach workflow
		</a>
	</div>
	<div class="card">
		{#if data.workflows.length === 0}
			<div class="muted small">
				No workflows attached yet. Attach one to start processing events.
			</div>
		{:else}
			<table class="wf-table">
				<thead>
					<tr>
						<th>Workflow</th>
						<th>Status</th>
						<th class="num">Runs</th>
						<th class="num">Failed</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#each data.workflows as w (w.id)}
						<tr>
							<td>
								<a
									class="wf-name"
									href={resolve('/p/[projectId]/w/[workflowId]', {
										projectId,
										workflowId: w.id
									})}
								>
									{w.name}
								</a>
								<div class="wf-id">{w.id}</div>
							</td>
							<td>
								{#if w.status === 'paused'}
									<span class="badge paused">paused</span>
								{:else if w.currentVersionId}
									<span class="badge ok">live</span>
								{:else}
									<span class="badge running">generating</span>
								{/if}
							</td>
							<td class="num">{w.totalRuns}</td>
							<td class="num">
								{#if w.failedRuns > 0}
									<span class="badge failed">{w.failedRuns}</span>
								{:else}
									0
								{/if}
							</td>
							<td>
								<a
									href={resolve('/p/[projectId]/w/[workflowId]', {
										projectId,
										workflowId: w.id
									})}>Open →</a
								>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</div>
</section>

<section>
	<div class="section-head">
		<h2>Recent events</h2>
		<span class="muted small">Showing last {data.events.length}</span>
	</div>
	<div class="card">
		{#if data.events.length === 0}
			<div class="muted small">
				No events yet.
				{#if data.eventSource.triggerType === 'webhook'}
					Send a request to the webhook URL above.
				{:else}
					Cron events will appear here when the schedule fires.
				{/if}
			</div>
		{:else}
			<ul class="rows">
				{#each data.events as ev (ev.id)}
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
								<div class="block">
									<div class="label">payload</div>
									<pre>{safeJson(ev.payload)}</pre>
								</div>
								{#if Object.keys(ev.headers).length > 0}
									<div class="block">
										<div class="label">headers</div>
										<pre>{safeJson(ev.headers)}</pre>
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

<section class="danger-zone">
	<div class="danger-row">
		<div>
			<div class="danger-title">Delete this event</div>
			<div class="muted small">
				Removes the event source, every captured event, and every workflow attached to it (along
				with their deployed scripts, versions, runs, and heal sessions).
			</div>
		</div>
		<button type="button" class="btn danger" onclick={openDeleteDialog}>Delete event</button>
	</div>
</section>

<dialog bind:this={deleteDialog} class="delete-dialog" onclose={() => (deleteConfirmName = '')}>
	<form
		method="POST"
		action="?/delete"
		use:enhance={() => {
			return async ({ update }) => {
				await update({ reset: false });
			};
		}}
	>
		<h2>Delete event</h2>
		<p>
			Permanently delete <b>{data.eventSource.name}</b> and everything attached — {data.workflows
				.length} workflow{data.workflows.length === 1 ? '' : 's'}, every captured event, every run,
			every heal session. This cannot be undone.
		</p>
		<label class="field">
			<span>Type <code>{data.eventSource.name}</code> to confirm</span>
			<input
				name="confirm_name"
				type="text"
				bind:value={deleteConfirmName}
				autocomplete="off"
				spellcheck="false"
			/>
		</label>
		{#if deleteResult && 'error' in deleteResult}
			<div class="alert">{deleteResult.error}</div>
		{/if}
		<div class="dialog-actions">
			<button type="button" class="btn" onclick={closeDeleteDialog}>Cancel</button>
			<button type="submit" class="btn danger" disabled={!canDelete}>Delete event</button>
		</div>
	</form>
</dialog>

<style>
	.head {
		margin-bottom: 14px;
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
	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 16px;
		margin-bottom: 18px;
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
	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin: 18px 0 10px;
	}
	.section-head h2 {
		font-size: 15px;
		font-weight: 700;
		color: #111;
		margin: 0;
	}
	.stats {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
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
	.btn.primary:hover {
		background: #000;
		text-decoration: none;
	}
	.btn.small {
		padding: 5px 10px;
		font-size: 12px;
	}
	.btn.danger {
		background: #fff;
		border-color: #fca5a5;
		color: #991b1b;
	}
	.btn.danger:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.danger-zone {
		margin-top: 24px;
		padding-top: 16px;
		border-top: 1px solid #f1f5f9;
	}
	.danger-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
	}
	.danger-title {
		font-weight: 600;
		color: #374151;
		margin-bottom: 2px;
	}
	.wf-table {
		width: 100%;
		border-collapse: collapse;
	}
	.wf-table th,
	.wf-table td {
		padding: 8px 10px;
		border-bottom: 1px solid #f1f5f9;
		text-align: left;
		vertical-align: top;
	}
	.wf-table th {
		font-weight: 600;
		color: #374151;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}
	.wf-table tbody tr:last-child td {
		border-bottom: none;
	}
	.wf-table .num {
		text-align: right;
	}
	.wf-name {
		font-weight: 600;
		color: #111;
	}
	.wf-id {
		font-family: ui-monospace, monospace;
		font-size: 11px;
		color: #9ca3af;
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
	.badge {
		display: inline-block;
		padding: 1px 8px;
		border-radius: 999px;
		font-size: 11.5px;
		font-weight: 600;
	}
	.badge.ok {
		background: #dcfce7;
		color: #166534;
	}
	.badge.running {
		background: #fef3c7;
		color: #92400e;
	}
	.badge.failed {
		background: #fee2e2;
		color: #991b1b;
	}
	.badge.paused {
		background: #fef3c7;
		color: #78350f;
		border: 1px solid #fcd34d;
	}
	.alert {
		background: #fef2f2;
		border: 1px solid #fecaca;
		color: #991b1b;
		border-radius: 6px;
		padding: 8px 10px;
		margin-top: 10px;
	}
	.delete-dialog {
		border: none;
		border-radius: 10px;
		padding: 0;
		max-width: 480px;
		width: calc(100% - 32px);
		box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
	}
	.delete-dialog::backdrop {
		background: rgba(15, 23, 42, 0.5);
	}
	.delete-dialog form {
		padding: 22px 24px;
	}
	.delete-dialog h2 {
		margin: 0 0 8px;
		font-size: 18px;
		color: #111;
		text-transform: none;
		letter-spacing: 0;
	}
	.delete-dialog p {
		margin: 0 0 16px;
		color: #374151;
		font-size: 13.5px;
	}
	.delete-dialog .field {
		margin-bottom: 12px;
	}
	.delete-dialog .field > span {
		display: block;
		font-size: 13px;
		margin-bottom: 6px;
		color: #374151;
	}
	.delete-dialog .field > span code {
		display: inline-block;
		padding: 1px 6px;
		background: #fef2f2;
		border: 1px solid #fecaca;
		border-radius: 4px;
		color: #991b1b;
		font-family: ui-monospace, monospace;
		font-size: 12.5px;
		font-weight: 600;
	}
	.delete-dialog input[type='text'] {
		width: 100%;
		padding: 9px 11px;
		border: 1px solid #d1d5db;
		border-radius: 6px;
		font: inherit;
		font-family: ui-monospace, monospace;
	}
	.dialog-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 6px;
	}
	.dialog-actions .btn.danger:not(:disabled) {
		background: #dc2626;
		border-color: #dc2626;
		color: #fff;
	}
	.dialog-actions .btn.danger:not(:disabled):hover {
		background: #991b1b;
		border-color: #991b1b;
	}
</style>
