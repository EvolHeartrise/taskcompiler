<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import { createWorkflowAndGenerate, getEventSourcesWithCounts } from './data.remote';

	let projectId = $derived(page.params.projectId!);
	let preselectedSourceId = $derived(page.url.searchParams.get('source'));

	const sourcesQuery = $derived(getEventSourcesWithCounts({ projectId, preselectedSourceId }));

	const initial = untrack(() => createWorkflowAndGenerate.result);
	let name = $state(initial?.values?.name ?? '');
	let prompt = $state(initial?.values?.prompt ?? '');
	let sourceId = $state(initial?.values?.sourceId ?? '');
	let backfill = $state(Boolean(initial?.values?.backfill));
	let submitting = $state(false);

	const result = $derived(createWorkflowAndGenerate.result);

	// Once the sources query resolves, default the select if the user hasn't
	// chosen one yet (and the form didn't repopulate from an error).
	$effect(() => {
		if (sourceId !== '') return;
		void sourcesQuery.then((d) => {
			if (sourceId === '') {
				sourceId = d.preselectedSourceId ?? d.eventSources[0]?.id ?? '';
			}
		});
	});

	function triggerLabel(t: string, cron: string | null): string {
		if (t === 'cron') return cron ? `cron (${cron})` : 'cron';
		return 'webhook';
	}
</script>

<div class="page-head">
	<div>
		<h1>Attach workflow</h1>
		<p class="muted">
			Describe what this workflow should do in plain English. An LLM will generate a TypeScript
			module that runs on every event from the selected event source.
		</p>
	</div>
	<a href={resolve('/p/[projectId]', { projectId })} class="back">← Back</a>
</div>

{#await sourcesQuery}
	<div class="muted">Loading event sources…</div>
{:then data}
	{@const selectedSource = data.eventSources.find((s) => s.id === sourceId)}

	{#if data.eventSources.length === 0}
		<div class="empty">
			<p>No events yet. Workflows attach to an event source (webhook or cron schedule).</p>
			<p>
				<a href={resolve('/p/[projectId]/sources/new', { projectId })}>Create an event first</a>,
				then come back here.
			</p>
		</div>
	{:else if submitting}
		<div class="generating">
			<div class="spinner" aria-hidden="true"></div>
			<div>
				<div class="strong">Generating workflow…</div>
				<div class="muted">This can take 10–30 seconds while the agent writes your module.</div>
				{#if prompt}
					<blockquote>{prompt}</blockquote>
				{/if}
			</div>
		</div>
	{:else}
		{#if result?.error}
			<div class="alert">{result.error}</div>
		{/if}

		<form
			{...createWorkflowAndGenerate.enhance(async ({ submit }) => {
				submitting = true;
				try {
					await submit();
				} finally {
					submitting = false;
				}
			})}
		>
			<input type="hidden" name="projectId" value={projectId} />
			<label class="field">
				<span>Event source</span>
				<select name="sourceId" bind:value={sourceId} required>
					{#each data.eventSources as s (s.id)}
						<option value={s.id}>
							{s.name} · {triggerLabel(s.triggerType, s.cronExpr)} · {s.eventCount} event{s.eventCount ===
							1
								? ''
								: 's'}
						</option>
					{/each}
				</select>
				<span class="hint">
					Every event from this source will fan out to this workflow (plus any siblings).
				</span>
			</label>

			<label class="field">
				<span>Name</span>
				<input
					name="name"
					type="text"
					bind:value={name}
					placeholder="daily-digest-to-slack"
					required
				/>
			</label>

			<label class="field">
				<span>Prompt</span>
				<textarea
					name="prompt"
					rows="8"
					placeholder="Post the top 5 items from the incoming payload to the Slack webhook SLACK_WEBHOOK."
					bind:value={prompt}
					required
				></textarea>
			</label>

			{#if selectedSource && selectedSource.eventCount > 0}
				<label class="field checkbox">
					<input type="checkbox" name="backfill" bind:checked={backfill} />
					<span>
						<b
							>Backfill against {selectedSource.eventCount} historical event{selectedSource.eventCount ===
							1
								? ''
								: 's'}</b
						>
						<span class="hint">
							After generation, run the new workflow against every past event on this source as
							replay runs. Useful for graceful handover from an older workflow — the new one
							inherits the source's history.
						</span>
					</span>
				</label>
			{/if}

			<div class="actions">
				<a href={resolve('/p/[projectId]', { projectId })} class="btn">Cancel</a>
				<button class="btn primary" type="submit">Generate workflow</button>
			</div>
		</form>
	{/if}
{/await}

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
		margin: 0;
	}
	.back {
		font-size: 13px;
	}
	.alert {
		background: #fef2f2;
		border: 1px solid #fecaca;
		color: #991b1b;
		border-radius: 6px;
		padding: 10px 12px;
		margin-bottom: 14px;
	}
	.empty {
		background: #fff;
		border: 1px dashed #d1d5db;
		border-radius: 8px;
		padding: 32px;
		text-align: center;
		color: #6b7280;
	}
	form {
		background: #fff;
		border: 1px solid #e5e7eb;
		border-radius: 8px;
		padding: 20px;
	}
	.field {
		display: block;
		margin-bottom: 18px;
	}
	.field > span {
		display: block;
		font-weight: 600;
		font-size: 13px;
		margin-bottom: 6px;
	}
	.field.checkbox {
		display: flex;
		align-items: flex-start;
		gap: 10px;
	}
	.field.checkbox input[type='checkbox'] {
		margin-top: 3px;
	}
	.field.checkbox > span {
		font-weight: 400;
	}
	.field.checkbox > span b {
		display: block;
		font-weight: 600;
		font-size: 13px;
		margin-bottom: 2px;
	}
	input[type='text'],
	textarea,
	select {
		width: 100%;
		padding: 9px 11px;
		border: 1px solid #d1d5db;
		border-radius: 6px;
		font: inherit;
	}
	textarea {
		resize: vertical;
		font-family: inherit;
	}
	.hint {
		display: block;
		color: #6b7280;
		font-size: 12px;
		margin-top: 4px;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		padding-top: 6px;
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
	}
	.generating {
		display: flex;
		gap: 16px;
		align-items: flex-start;
		background: #fff;
		border: 1px solid #e5e7eb;
		border-radius: 8px;
		padding: 24px;
	}
	.strong {
		font-weight: 600;
		margin-bottom: 2px;
	}
	blockquote {
		margin: 10px 0 0;
		padding: 10px 12px;
		background: #f9fafb;
		border-left: 3px solid #d1d5db;
		color: #374151;
		white-space: pre-wrap;
		border-radius: 0 4px 4px 0;
	}
	.spinner {
		width: 22px;
		height: 22px;
		border: 3px solid #e5e7eb;
		border-top-color: #111827;
		border-radius: 50%;
		animation: spin 1s linear infinite;
		flex-shrink: 0;
		margin-top: 2px;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
