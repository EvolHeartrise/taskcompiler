<script lang="ts">
	import { page } from '$app/state';
	import { can, type ProjectRole } from '$lib/permissions';
	import { deleteSecret, getSecrets, upsertSecret } from './data.remote';

	let projectId = $derived(page.params.projectId!);
	let secretsQuery = $derived(getSecrets(projectId));

	let currentRole = $derived<ProjectRole>((page.data as { role?: ProjectRole }).role ?? 'editor');
	let canManage = $derived(can(currentRole, 'secret.manage'));

	let newName = $state('');
	let newValue = $state('');
	let editing = $state<Record<string, string>>({});

	function fmt(ts: number): string {
		return new Date(ts).toLocaleString();
	}

	const upsertResult = $derived(upsertSecret.result);
	const deleteResult = $derived(deleteSecret.result);
</script>

<svelte:head><title>Secrets · TaskCompiler</title></svelte:head>

<div class="page-head">
	<div>
		<h1>Secrets</h1>
		<p class="muted">
			Account-level secrets available to all your workflows via <code>ctx.secret("NAME")</code>.
			Values are write-only — once saved they can't be viewed again, only overwritten. Changes take
			effect on the next workflow invocation; no redeploy needed.
		</p>
	</div>
</div>

{#if !canManage}
	<div class="notice">Read-only — secrets are managed by Admins and the Owner.</div>
{/if}

{#if upsertResult}
	{#if upsertResult.ok}
		<div class="result ok">Saved <b>{upsertResult.name}</b>.</div>
	{:else}
		<div class="alert">{upsertResult.error}</div>
	{/if}
{/if}

{#if deleteResult}
	{#if deleteResult.ok}
		<div class="result ok">Deleted <b>{deleteResult.name}</b>.</div>
	{:else}
		<div class="alert">{deleteResult.error}</div>
	{/if}
{/if}

{#if canManage}
	<div class="card">
		<h2>Add or update a secret</h2>
		<form
			{...upsertSecret.enhance(async ({ submit }) => {
				await submit();
				newValue = '';
			})}
		>
			<input type="hidden" name="projectId" value={projectId} />
			<div class="row">
				<label class="field grow">
					<span>Name</span>
					<input
						name="name"
						type="text"
						value={newName}
						oninput={(e) => (newName = e.currentTarget.value.toUpperCase())}
						placeholder="SECRET_NAME"
						autocomplete="off"
						autocapitalize="characters"
						spellcheck="false"
						required
					/>
					<span class="hint">A–Z, 0–9, underscores.</span>
				</label>
				<label class="field grow">
					<span>Value</span>
					<input
						name="value"
						type="password"
						bind:value={newValue}
						placeholder="paste the secret value"
						autocomplete="new-password"
						spellcheck="false"
						required
					/>
					<span class="hint">Saved opaque. Not displayed again after this submit.</span>
				</label>
				<button class="btn primary" type="submit">Save</button>
			</div>
		</form>
	</div>
{/if}

<div class="card">
	{#await secretsQuery}
		<h2>Your secrets</h2>
		<div class="muted small">Loading…</div>
	{:then secrets}
		<h2>Your secrets <span class="muted small">({secrets.length})</span></h2>
		{#if secrets.length === 0}
			<div class="muted small">
				{#if canManage}No secrets yet. Add one above.{:else}No secrets yet.{/if}
			</div>
		{:else}
			<ul class="rows">
				{#each secrets as s (s.name)}
					{@const updateForm = upsertSecret.for(s.name)}
					{@const deleteForm = deleteSecret.for(s.name)}
					<li>
						<div class="row-head">
							<code class="name">{s.name}</code>
							<span class="muted small">updated {fmt(s.updatedAt)}</span>
						</div>
						{#if canManage}
							<div class="row-actions">
								<form
									{...updateForm.enhance(async ({ submit }) => {
										await submit();
										editing[s.name] = '';
									})}
								>
									<input type="hidden" name="projectId" value={projectId} />
									<input type="hidden" name="name" value={s.name} />
									<input
										name="value"
										type="password"
										placeholder="new value (leave blank to cancel)"
										autocomplete="new-password"
										spellcheck="false"
										bind:value={editing[s.name]}
									/>
									<button
										class="btn small"
										type="submit"
										disabled={!(editing[s.name] ?? '').length}
									>
										Update
									</button>
								</form>
								<form {...deleteForm}>
									<input type="hidden" name="projectId" value={projectId} />
									<input type="hidden" name="name" value={s.name} />
									<button class="btn small danger" type="submit">Delete</button>
								</form>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	{/await}
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
	.notice {
		background: #f9fafb;
		border: 1px solid #e5e7eb;
		color: #374151;
		border-radius: 6px;
		padding: 8px 12px;
		margin-bottom: 12px;
		font-size: 13px;
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
	.hint {
		display: block;
		color: #6b7280;
		font-size: 12px;
		font-weight: 400;
		margin-top: 4px;
	}
	input[type='text'],
	input[type='password'] {
		width: 100%;
		padding: 8px 10px;
		border: 1px solid #d1d5db;
		border-radius: 6px;
		font: inherit;
	}
	.btn {
		padding: 8px 14px;
		border-radius: 6px;
		border: 1px solid #d1d5db;
		background: #fff;
		color: #111;
		cursor: pointer;
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
	.btn.danger {
		color: #991b1b;
		border-color: #fca5a5;
	}
	.btn.danger:hover {
		background: #fef2f2;
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
	.row-head {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.name {
		font-family: ui-monospace, monospace;
		font-weight: 600;
		background: #f3f4f6;
		padding: 3px 8px;
		border-radius: 4px;
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
	.row-actions input[type='password'] {
		min-width: 220px;
	}
	@media (max-width: 700px) {
		.row {
			flex-direction: column;
			align-items: stretch;
		}
	}
</style>
