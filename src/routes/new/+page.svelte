<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	import { untrack } from 'svelte';

	let { form }: PageProps = $props();

	const initial = untrack(() => form);
	let name = $state(initial?.values?.name ?? '');
	let prompt = $state(initial?.values?.prompt ?? '');
	let trigger = $state<'webhook' | 'cron' | 'both'>(
		(initial?.values?.trigger as 'webhook' | 'cron' | 'both' | undefined) ?? 'webhook'
	);
	let cronExpr = $state(initial?.values?.cronExpr ?? '');
	let submitting = $state(false);

	let needsCron = $derived(trigger === 'cron' || trigger === 'both');
</script>

<div class="page-head">
	<div>
		<h1>New workflow</h1>
		<p class="muted">
			Describe what the workflow should do in plain English. An LLM will generate a TypeScript module
			that runs on every trigger.
		</p>
	</div>
	<a href={resolve('/')} class="back">← Back</a>
</div>

{#if submitting}
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
	{#if form?.error}
		<div class="alert">{form.error}</div>
	{/if}

	<form
		method="POST"
		use:enhance={() => {
			submitting = true;
			return async ({ update }) => {
				await update({ reset: false });
				submitting = false;
			};
		}}
	>
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
				placeholder="Every day at 9am, fetch the top 5 posts from Hacker News and post them to the Slack webhook SLACK_WEBHOOK."
				bind:value={prompt}
				required
			></textarea>
		</label>

		<fieldset class="field">
			<legend>Trigger</legend>
			<label class="radio">
				<input type="radio" name="trigger" value="webhook" bind:group={trigger} /> webhook
			</label>
			<label class="radio">
				<input type="radio" name="trigger" value="cron" bind:group={trigger} /> cron
			</label>
			<label class="radio">
				<input type="radio" name="trigger" value="both" bind:group={trigger} /> both
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
				<span class="hint">Standard 5-field cron (min hour dom mon dow).</span>
			</label>
		{/if}

		<div class="actions">
			<a href={resolve('/')} class="btn">Cancel</a>
			<button class="btn primary" type="submit">Generate workflow</button>
		</div>
	</form>
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
	input[type='text'],
	textarea {
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
