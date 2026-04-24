<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import LocalTime from '$lib/LocalTime.svelte';
	import {
		createProjectInvite,
		getProjectMembership,
		leaveProject,
		removeProjectMember,
		revokeProjectInvite
	} from '../data.remote';

	let projectId = $derived(page.params.projectId!);
	let currentUserId = $derived<string | null>(
		(page.data as { user?: { id: string } | null }).user?.id ?? null
	);
	let projectName = $derived<string>(
		(page.data as { project?: { name: string } }).project?.name ?? 'this project'
	);

	const membershipQuery = $derived(getProjectMembership({ projectId }));

	let inviteEmail = $state('');
	let inviteSubmitting = $state(false);
	let inviteError = $state<string | null>(null);

	let removingUserId = $state<string | null>(null);
	let removeError = $state<string | null>(null);

	let revokingInviteId = $state<string | null>(null);
	let revokeError = $state<string | null>(null);

	let leaveSubmitting = $state(false);
	let leaveError = $state<string | null>(null);

	function looksLikeEmail(raw: string): boolean {
		const trimmed = raw.trim();
		if (trimmed.length === 0) return false;
		const at = trimmed.indexOf('@');
		if (at <= 0 || at !== trimmed.lastIndexOf('@')) return false;
		if (at === trimmed.length - 1) return false;
		if (trimmed.includes(' ')) return false;
		return true;
	}

	async function onInviteSubmit(e: SubmitEvent) {
		e.preventDefault();
		inviteError = null;
		const email = inviteEmail.trim();
		if (!looksLikeEmail(email)) {
			inviteError = 'Enter a valid email address.';
			return;
		}
		inviteSubmitting = true;
		try {
			const result = await createProjectInvite({ email, projectId });
			if (result.ok) {
				inviteEmail = '';
			} else {
				inviteError = result.error;
			}
		} catch (err) {
			inviteError = err instanceof Error ? err.message : String(err);
		} finally {
			inviteSubmitting = false;
		}
	}

	async function onRemoveMember(userId: string, name: string) {
		if (!confirm(`Remove ${name} from this project? They will lose access immediately.`)) {
			return;
		}
		removeError = null;
		removingUserId = userId;
		try {
			const result = await removeProjectMember({ projectId, userId });
			if (!result.ok) {
				removeError = result.error;
			}
		} catch (err) {
			removeError = err instanceof Error ? err.message : String(err);
		} finally {
			removingUserId = null;
		}
	}

	async function onRevokeInvite(inviteId: string, email: string) {
		if (!confirm(`Revoke the invite for ${email}?`)) {
			return;
		}
		revokeError = null;
		revokingInviteId = inviteId;
		try {
			const result = await revokeProjectInvite({ inviteId, projectId });
			if (!result.ok) {
				revokeError = result.error;
			}
		} catch (err) {
			revokeError = err instanceof Error ? err.message : String(err);
		} finally {
			revokingInviteId = null;
		}
	}

	async function onLeave() {
		if (
			!confirm(
				`Leave ${projectName}? You will lose access immediately and need a new invite to rejoin.`
			)
		) {
			return;
		}
		leaveError = null;
		leaveSubmitting = true;
		try {
			const result = await leaveProject({ projectId });
			if (result.ok) {
				await goto(resolve('/projects'));
			} else {
				leaveError = result.error;
				leaveSubmitting = false;
			}
		} catch (err) {
			leaveError = err instanceof Error ? err.message : String(err);
			leaveSubmitting = false;
		}
	}
</script>

<svelte:head><title>Members · Runely</title></svelte:head>

<div class="page-head">
	<div>
		<h1>Members</h1>
		<p class="muted">
			Everyone with access to <b>{projectName}</b>. Every member can invite, remove, and edit —
			there are no roles. The creator keeps a badge so you know who started the project.
		</p>
	</div>
</div>

{#if removeError}
	<div class="alert">{removeError}</div>
{/if}
{#if revokeError}
	<div class="alert">{revokeError}</div>
{/if}
{#if leaveError}
	<div class="alert">{leaveError}</div>
{/if}

<div class="card">
	<h2>Invite by email</h2>
	<form onsubmit={onInviteSubmit}>
		<div class="row">
			<label class="field grow">
				<span>Email</span>
				<input
					name="email"
					type="email"
					bind:value={inviteEmail}
					placeholder="teammate@example.com"
					autocomplete="off"
					spellcheck="false"
					required
					disabled={inviteSubmitting}
				/>
				<span class="hint">
					Sends an invite link valid for 7 days. The recipient signs in with that email to accept.
				</span>
			</label>
			<button class="btn primary" type="submit" disabled={inviteSubmitting}>
				{inviteSubmitting ? 'Sending…' : 'Send invite'}
			</button>
		</div>
		{#if inviteError}
			<div class="alert inline">{inviteError}</div>
		{/if}
	</form>
</div>

<div class="card">
	{#await membershipQuery}
		<h2>Members</h2>
		<div class="muted small">Loading…</div>
	{:then membership}
		<h2>Members <span class="muted small">({membership.members.length})</span></h2>
		<ul class="rows">
			{#each membership.members as m (m.userId)}
				{@const isSelf = currentUserId !== null && m.userId === currentUserId}
				<li>
					<div class="row-head">
						<div class="who">
							<div class="name-line">
								<span class="name">{m.name || m.email}</span>
								{#if m.role === 'owner'}
									<span class="chip creator">creator</span>
								{/if}
								{#if isSelf}
									<span class="chip self">you</span>
								{/if}
							</div>
							<div class="email">{m.email}</div>
						</div>
						<div class="meta">
							<span class="muted small">joined <LocalTime ms={m.joinedAt} /></span>
						</div>
						<div class="actions">
							{#if !isSelf}
								<button
									type="button"
									class="btn small danger"
									onclick={() => onRemoveMember(m.userId, m.name || m.email)}
									disabled={removingUserId === m.userId}
								>
									{removingUserId === m.userId ? 'Removing…' : 'Remove'}
								</button>
							{/if}
						</div>
					</div>
				</li>
			{/each}
		</ul>
	{/await}
</div>

<div class="card">
	{#await membershipQuery}
		<h2>Pending invites</h2>
		<div class="muted small">Loading…</div>
	{:then membership}
		<h2>Pending invites <span class="muted small">({membership.invites.length})</span></h2>
		{#if membership.invites.length === 0}
			<div class="muted small">No pending invites.</div>
		{:else}
			<ul class="rows">
				{#each membership.invites as inv (inv.id)}
					<li>
						<div class="row-head">
							<div class="who">
								<div class="name-line">
									<span class="name">{inv.email}</span>
								</div>
								<div class="email muted small">
									invited <LocalTime ms={inv.createdAt} /> · expires
									<LocalTime ms={inv.expiresAt} />
								</div>
							</div>
							<div class="actions">
								<button
									type="button"
									class="btn small danger"
									onclick={() => onRevokeInvite(inv.id, inv.email)}
									disabled={revokingInviteId === inv.id}
								>
									{revokingInviteId === inv.id ? 'Revoking…' : 'Revoke'}
								</button>
							</div>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	{/await}
</div>

<div class="card danger-card">
	<h2>Leave project</h2>
	<p class="muted small">
		You'll lose access to {projectName} immediately. To rejoin, someone still in the project will need
		to send you a new invite.
	</p>
	<button type="button" class="btn danger" onclick={onLeave} disabled={leaveSubmitting}>
		{leaveSubmitting ? 'Leaving…' : 'Leave this project'}
	</button>
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
	.danger-card {
		border-color: #fecaca;
		background: #fffafa;
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
	input[type='email'] {
		width: 100%;
		padding: 8px 10px;
		border: 1px solid #d1d5db;
		border-radius: 6px;
		font: inherit;
	}
	input[type='email']:disabled {
		background: #f9fafb;
		color: #9ca3af;
	}
	.btn {
		display: inline-block;
		padding: 8px 14px;
		border-radius: 6px;
		border: 1px solid #d1d5db;
		background: #fff;
		color: #111;
		cursor: pointer;
		font: inherit;
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
	.alert.inline {
		margin-top: 10px;
		margin-bottom: 0;
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
	}
	.row-head {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}
	.who {
		flex: 1;
		min-width: 0;
	}
	.name-line {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.name {
		font-weight: 600;
		color: #111;
	}
	.email {
		font-size: 12.5px;
		color: #6b7280;
		margin-top: 2px;
	}
	.meta {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.chip {
		display: inline-block;
		padding: 1px 8px;
		border-radius: 999px;
		font-size: 11px;
		font-weight: 600;
	}
	.chip.creator {
		background: #eef2ff;
		color: #3730a3;
	}
	.chip.self {
		background: #f3f4f6;
		color: #374151;
	}
	@media (max-width: 700px) {
		.row {
			flex-direction: column;
			align-items: stretch;
		}
	}
</style>
