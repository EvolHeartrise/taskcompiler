<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let submitting = $state(false);

	const view = $derived(data.state);
</script>

<svelte:head><title>Project invite · Runely</title></svelte:head>

<div class="wrap">
	<div class="card">
		<h1>Project invite</h1>

		{#if form?.error}
			<div class="alert">{form.error}</div>
		{/if}

		{#if view.kind === 'invalid'}
			<p class="muted">{view.reason}</p>
			<a class="btn" href={resolve('/')}>Go to Runely</a>
		{:else if view.kind === 'expired'}
			<p class="muted">This invite has expired. Ask whoever sent it to issue a new one.</p>
			<a class="btn" href={resolve('/')}>Go to Runely</a>
		{:else if view.kind === 'revoked'}
			<p class="muted">This invite was revoked and is no longer valid.</p>
			<a class="btn" href={resolve('/')}>Go to Runely</a>
		{:else if view.kind === 'accepted'}
			<p class="muted">This invite has already been accepted.</p>
			<a class="btn" href={resolve('/')}>Go to Runely</a>
		{:else if view.kind === 'unauthenticated'}
			<p>You're invited to <b>{view.projectName}</b>.</p>
			<p class="muted small">
				This invite was sent to <b>{view.email}</b>. Sign in with that email to accept.
			</p>
			<a class="btn primary" href="{resolve('/auth')}?next={encodeURIComponent(view.nextUrl)}"
				>Sign in to accept</a
			>
		{:else if view.kind === 'wrong_account'}
			<p>You're invited to <b>{view.projectName}</b>.</p>
			<p class="muted small">
				This invite was sent to <b>{view.inviteEmail}</b>. You're signed in as
				<b>{view.currentEmail}</b>. Sign out and sign in as
				<b>{view.inviteEmail}</b> to accept.
			</p>
			<a class="btn" href="{resolve('/auth')}?next={encodeURIComponent(view.nextUrl)}"
				>Switch account</a
			>
		{:else if view.kind === 'ready'}
			<p>You're invited to join <b>{view.projectName}</b>.</p>
			<p class="muted small">Accepting will add your account to this project.</p>
			<form
				method="POST"
				action="?/accept"
				use:enhance={() => {
					submitting = true;
					return async ({ update }) => {
						await update();
						submitting = false;
					};
				}}
			>
				<button class="btn primary" type="submit" disabled={submitting}>
					{submitting ? 'Accepting…' : `Accept invite to ${view.projectName}`}
				</button>
			</form>
		{/if}
	</div>
</div>

<style>
	.wrap {
		display: flex;
		justify-content: center;
		padding: 60px 16px;
	}
	.card {
		width: 100%;
		max-width: 420px;
		background: #fff;
		border: 1px solid #e5e7eb;
		border-radius: 10px;
		padding: 28px;
	}
	h1 {
		font-size: 20px;
		margin: 0 0 12px;
	}
	p {
		margin: 0 0 12px;
		font-size: 14px;
	}
	.muted {
		color: #6b7280;
	}
	.small {
		font-size: 13px;
	}
	.alert {
		background: #fef2f2;
		border: 1px solid #fecaca;
		color: #991b1b;
		border-radius: 6px;
		padding: 10px 12px;
		margin-bottom: 14px;
		font-size: 13px;
	}
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		padding: 10px 14px;
		border-radius: 6px;
		border: 1px solid #d1d5db;
		background: #fff;
		color: #111;
		cursor: pointer;
		font: inherit;
		text-decoration: none;
		box-sizing: border-box;
		margin-top: 4px;
	}
	.btn.primary {
		background: #111827;
		border-color: #111827;
		color: #fff;
	}
	.btn.primary:disabled {
		opacity: 0.6;
		cursor: default;
	}
</style>
