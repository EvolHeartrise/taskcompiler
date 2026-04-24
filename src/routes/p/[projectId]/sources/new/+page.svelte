<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import { createEventSourceForProject } from './data.remote';

	let projectId = $derived(page.params.projectId!);

	const initial = untrack(() => createEventSourceForProject.result);
	let name = $state(initial?.values?.name ?? '');
	let trigger = $state<'webhook' | 'cron'>(
		(initial?.values?.trigger as 'webhook' | 'cron' | undefined) ?? 'webhook'
	);
	let cronExpr = $state(initial?.values?.cronExpr ?? '');

	let needsCron = $derived(trigger === 'cron');
	const result = $derived(createEventSourceForProject.result);
</script>

<div class="page-head">
	<div>
		<h1>New event</h1>
		<p class="muted">
			An event is a webhook URL or cron schedule. Data received here fans out to every workflow you
			attach.
		</p>
	</div>
	<a href={resolve('/p/[projectId]', { projectId })} class="back">← Back</a>
</div>

{#if result?.error}
	<div class="alert">{result.error}</div>
{/if}

<form {...createEventSourceForProject}>
	<input type="hidden" name="projectId" value={projectId} />
	<label class="field">
		<span>Name</span>
		<input
			name="name"
			type="text"
			bind:value={name}
			placeholder="github-webhook, daily-9am, stripe-events"
			required
		/>
		<span class="hint">A short label you'll recognize in the dashboard.</span>
	</label>

	<fieldset class="field">
		<legend>Trigger</legend>
		<label class="radio">
			<input type="radio" name="trigger" value="webhook" bind:group={trigger} /> webhook
		</label>
		<label class="radio">
			<input type="radio" name="trigger" value="cron" bind:group={trigger} /> cron
		</label>
	</fieldset>

	{#if needsCron}
		<label class="field">
			<span>Cron expression</span>
			<input
				name="cronExpr"
				type="text"
				placeholder="0 9 * * *"
				bind:value={cronExpr}
				required={needsCron}
			/>
			<span class="hint">Standard 5-field cron (min hour dom mon dow), UTC.</span>
		</label>
	{/if}

	<div class="actions">
		<a href={resolve('/p/[projectId]', { projectId })} class="btn">Cancel</a>
		<button class="btn primary" type="submit">Create event</button>
	</div>
</form>

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
	.field > span,
	legend {
		display: block;
		font-weight: 600;
		font-size: 13px;
		margin-bottom: 6px;
		padding: 0;
	}
	input[type='text'] {
		width: 100%;
		padding: 9px 11px;
		border: 1px solid #d1d5db;
		border-radius: 6px;
		font: inherit;
	}
	fieldset {
		border: none;
		padding: 0;
		margin: 0 0 18px;
	}
	.radio {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-right: 18px;
		font-weight: 400;
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
</style>
