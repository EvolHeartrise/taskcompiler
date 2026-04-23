<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	function fmt(ts: number): string {
		return new Date(ts).toLocaleString();
	}

	function triggerLabel(t: string, cron: string | null): string {
		if (t === 'webhook') return 'webhook';
		if (t === 'cron') return cron ? `cron (${cron})` : 'cron';
		return cron ? `both (${cron})` : 'both';
	}
</script>

<div class="page-head">
	<h1>Workflows</h1>
	<a class="btn primary" href={resolve('/new')}>+ New workflow</a>
</div>

{#if data.workflows.length === 0}
	<div class="empty">
		<p>No workflows yet.</p>
		<p>
			<a href={resolve('/new')}>Create your first one</a> by describing what it should do in plain English.
		</p>
	</div>
{:else}
	<table class="wf-table">
		<thead>
			<tr>
				<th>Name</th>
				<th>Trigger</th>
				<th class="num">Events</th>
				<th class="num">Runs</th>
				<th class="num">Failed</th>
				<th>Created</th>
				<th></th>
			</tr>
		</thead>
		<tbody>
			{#each data.workflows as w (w.id)}
				<tr>
					<td>
						<a class="name" href={resolve('/w/[workflowId]', { workflowId: w.id })}>{w.name}</a>
						<div class="id">{w.id}</div>
					</td>
					<td>{triggerLabel(w.triggerType, w.cronExpr)}</td>
					<td class="num">{w.totalEvents}</td>
					<td class="num">{w.totalRuns}</td>
					<td class="num">
						{#if w.failedRuns > 0}
							<span class="badge failed">{w.failedRuns}</span>
						{:else}
							0
						{/if}
					</td>
					<td class="muted">{fmt(w.createdAt)}</td>
					<td><a href={resolve('/w/[workflowId]', { workflowId: w.id })}>Open →</a></td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}

<style>
	.page-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 16px;
	}
	h1 {
		font-size: 22px;
		margin: 0;
	}
	.btn {
		display: inline-block;
		padding: 8px 14px;
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
	.empty {
		background: #fff;
		border: 1px dashed #d1d5db;
		border-radius: 8px;
		padding: 32px;
		text-align: center;
		color: #6b7280;
	}
	.wf-table {
		width: 100%;
		border-collapse: collapse;
		background: #fff;
		border: 1px solid #e5e7eb;
		border-radius: 8px;
		overflow: hidden;
	}
	.wf-table th,
	.wf-table td {
		padding: 10px 12px;
		border-bottom: 1px solid #f1f5f9;
		text-align: left;
		vertical-align: top;
	}
	.wf-table th {
		background: #f9fafb;
		font-weight: 600;
		color: #374151;
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.02em;
	}
	.wf-table tbody tr:last-child td {
		border-bottom: none;
	}
	.wf-table .num {
		text-align: right;
	}
	.wf-table .name {
		font-weight: 600;
		color: #111;
	}
	.wf-table .id {
		font-family: ui-monospace, monospace;
		font-size: 11px;
		color: #9ca3af;
	}
	.muted {
		color: #6b7280;
	}
	.badge {
		display: inline-block;
		padding: 1px 7px;
		border-radius: 999px;
		font-size: 11.5px;
		font-weight: 600;
	}
	.badge.failed {
		background: #fee2e2;
		color: #991b1b;
	}
</style>
