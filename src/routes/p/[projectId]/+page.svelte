<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let projectId = $derived(page.params.projectId!);

	function fmt(ts: number): string {
		return new Date(ts).toLocaleString();
	}

	function triggerLabel(t: string, cron: string | null): string {
		if (t === 'cron') return cron ? `cron (${cron})` : 'cron';
		return 'webhook';
	}

	let workflowsBySource = $derived(
		data.workflows.reduce<Record<string, typeof data.workflows>>((acc, w) => {
			(acc[w.eventSourceId] ??= []).push(w);
			return acc;
		}, {})
	);
</script>

<div class="page-head">
	<div>
		<h1>Events</h1>
		<p class="muted small">
			An event is a webhook URL or cron schedule. Attach one or more workflows to fan out every
			event to each workflow in parallel.
		</p>
	</div>
	<a class="btn primary" href={resolve('/p/[projectId]/sources/new', { projectId })}>+ New event</a>
</div>

{#if data.eventSources.length === 0}
	<div class="empty">
		<p>No events yet.</p>
		<p>
			<a href={resolve('/p/[projectId]/sources/new', { projectId })}>Create your first one</a> — a webhook
			URL or cron schedule. Then attach workflows to it.
		</p>
	</div>
{:else}
	<ul class="source-list">
		{#each data.eventSources as s (s.id)}
			{@const attached = workflowsBySource[s.id] ?? []}
			<li class="source-card">
				<div class="source-head">
					<div>
						<a
							class="source-name"
							href={resolve('/p/[projectId]/s/[sourceId]', { projectId, sourceId: s.id })}
						>
							{s.name}
						</a>
						<div class="source-meta">
							<span class="chip">{triggerLabel(s.triggerType, s.cronExpr)}</span>
							<span class="muted small">{s.totalEvents} events</span>
							<span class="muted small">· created {fmt(s.createdAt)}</span>
						</div>
					</div>
					<a
						class="btn small"
						href={resolve(
							`/p/[projectId]/new?source=${encodeURIComponent(s.id)}` as `/p/[projectId]/new?${string}`,
							{ projectId }
						)}
					>
						+ Attach workflow
					</a>
				</div>
				{#if attached.length === 0}
					<div class="no-workflows">No workflows attached yet.</div>
				{:else}
					<table class="wf-table">
						<thead>
							<tr>
								<th>Workflow</th>
								<th class="num">Runs</th>
								<th class="num">Failed</th>
								<th></th>
							</tr>
						</thead>
						<tbody>
							{#each attached as w (w.id)}
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
			</li>
		{/each}
	</ul>
{/if}

<style>
	.page-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 20px;
		margin-bottom: 20px;
	}
	h1 {
		font-size: 22px;
		margin: 0 0 4px;
	}
	.muted {
		color: #6b7280;
	}
	.small {
		font-size: 12px;
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
	.btn.small {
		padding: 5px 10px;
		font-size: 12px;
	}
	.empty {
		background: #fff;
		border: 1px dashed #d1d5db;
		border-radius: 8px;
		padding: 32px;
		text-align: center;
		color: #6b7280;
	}
	.source-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.source-card {
		background: #fff;
		border: 1px solid #e5e7eb;
		border-radius: 8px;
		padding: 14px 16px;
	}
	.source-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 12px;
	}
	.source-name {
		display: inline-block;
		font-weight: 700;
		font-size: 16px;
		color: #111;
	}
	.source-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-top: 2px;
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
	.no-workflows {
		color: #6b7280;
		font-size: 13px;
		padding: 6px 2px 2px;
	}
	.wf-table {
		width: 100%;
		border-collapse: collapse;
	}
	.wf-table th,
	.wf-table td {
		padding: 8px 10px;
		border-top: 1px solid #f1f5f9;
		text-align: left;
		vertical-align: top;
	}
	.wf-table th {
		font-weight: 600;
		color: #374151;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		background: #f9fafb;
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
