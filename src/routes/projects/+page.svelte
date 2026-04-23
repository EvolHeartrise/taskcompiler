<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let newName = $state('');
	let renaming = $state<Record<string, string>>({});

	function fmt(ts: number): string {
		return new Date(ts).toLocaleString();
	}

	const createResult = $derived(form?.create);
	const renameResult = $derived(form?.rename);
</script>

<svelte:head><title>Projects · Runely</title></svelte:head>

<div class="page-head">
	<div>
		<h1>Projects</h1>
		<p class="muted">
			Each project is its own workspace — workflows and secrets are scoped per project. Open a
			project to switch into it, or use the sidebar dropdown.
		</p>
	</div>
</div>

{#if createResult && 'error' in createResult}
	<div class="alert">{createResult.error}</div>
{/if}

{#if renameResult && 'ok' in renameResult && renameResult.ok}
	<div class="result ok">Renamed to <b>{renameResult.name}</b>.</div>
{:else if renameResult && 'error' in renameResult}
	<div class="alert">{renameResult.error}</div>
{/if}

<div class="card">
	<h2>New project</h2>
	<form
		method="POST"
		action="?/create"
		use:enhance={() => {
			return async ({ update }) => {
				await update({ reset: false });
				newName = '';
			};
		}}
	>
		<div class="row">
			<label class="field grow">
				<span>Name</span>
				<input
					name="name"
					type="text"
					bind:value={newName}
					placeholder="my-side-project"
					autocomplete="off"
					spellcheck="false"
					required
				/>
			</label>
			<button class="btn primary" type="submit">Create project</button>
		</div>
	</form>
</div>

<div class="card">
	<h2>Your projects <span class="muted small">({data.projects.length})</span></h2>
	{#if data.projects.length === 0}
		<div class="muted small">No projects yet. Add one above.</div>
	{:else}
		<ul class="rows">
			{#each data.projects as p (p.id)}
				{@const isLastVisited = p.id === data.lastVisitedProjectId}
				<li class:active={isLastVisited}>
					<div class="row-head">
						<div class="name-block">
							<a class="name" href={resolve('/p/[projectId]', { projectId: p.id })}>{p.name}</a>
							{#if isLastVisited}<span class="chip">last visited</span>{/if}
						</div>
						<span class="muted small">
							{p.workflowCount} workflow{p.workflowCount === 1 ? '' : 's'} · created {fmt(
								p.createdAt
							)}
						</span>
					</div>
					<div class="row-actions">
						<a class="btn small" href={resolve('/p/[projectId]', { projectId: p.id })}>
							Open project →
						</a>
						<form
							method="POST"
							action="?/rename"
							use:enhance={() => {
								return async ({ update }) => {
									await update({ reset: false });
									renaming[p.id] = '';
								};
							}}
						>
							<input type="hidden" name="projectId" value={p.id} />
							<input
								name="name"
								type="text"
								placeholder="new name"
								autocomplete="off"
								spellcheck="false"
								bind:value={renaming[p.id]}
							/>
							<button class="btn small" type="submit" disabled={!(renaming[p.id] ?? '').length}>
								Rename
							</button>
						</form>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.page-head {
		margin-bottom: 16px;
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
	.card {
		background: #fff;
		border: 1px solid #e5e7eb;
		border-radius: 8px;
		padding: 16px;
		margin-bottom: 16px;
	}
	.card h2 {
		font-size: 14px;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: #374151;
		margin: 0 0 10px;
	}
	.row {
		display: flex;
		gap: 12px;
		align-items: flex-end;
	}
	.field {
		display: block;
	}
	.field.grow {
		flex: 1;
	}
	.field > span {
		display: block;
		font-weight: 600;
		font-size: 12px;
		margin-bottom: 4px;
	}
	input[type='text'] {
		width: 100%;
		padding: 8px 10px;
		border: 1px solid #d1d5db;
		border-radius: 6px;
		font: inherit;
	}
	.btn {
		display: inline-block;
		padding: 8px 14px;
		border-radius: 6px;
		border: 1px solid #d1d5db;
		background: #fff;
		color: #111;
		cursor: pointer;
		text-decoration: none;
	}
	.btn:hover {
		text-decoration: none;
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.btn.primary {
		background: #111827;
		border-color: #111827;
		color: #fff;
	}
	.btn.small {
		padding: 6px 10px;
		font-size: 12px;
	}
	.alert {
		background: #fef2f2;
		border: 1px solid #fecaca;
		color: #991b1b;
		border-radius: 6px;
		padding: 8px 12px;
		margin-bottom: 12px;
		font-size: 13px;
	}
	.result {
		background: #f9fafb;
		border: 1px solid #e5e7eb;
		border-radius: 6px;
		padding: 8px 12px;
		margin-bottom: 12px;
		font-size: 13px;
	}
	.result.ok {
		background: #f0fdf4;
		border-color: #86efac;
		color: #166534;
	}
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.rows li {
		border: 1px solid #e5e7eb;
		border-radius: 6px;
		padding: 10px 12px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.rows li.active {
		border-color: #818cf8;
		background: #f5f7ff;
	}
	.row-head {
		display: flex;
		align-items: center;
		gap: 10px;
		justify-content: space-between;
		flex-wrap: wrap;
	}
	.name-block {
		display: inline-flex;
		gap: 8px;
		align-items: center;
	}
	.name {
		font-weight: 600;
		font-size: 14px;
	}
	.chip {
		display: inline-block;
		padding: 1px 8px;
		border-radius: 999px;
		background: #eef2ff;
		color: #3730a3;
		font-size: 11px;
		font-weight: 600;
	}
	.row-actions {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-wrap: wrap;
	}
	.row-actions form {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.row-actions input[type='text'] {
		min-width: 180px;
	}
	@media (max-width: 700px) {
		.row {
			flex-direction: column;
			align-items: stretch;
		}
	}
</style>
