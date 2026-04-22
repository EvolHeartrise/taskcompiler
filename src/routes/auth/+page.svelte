<script lang="ts">
	import { page } from '$app/state';
	import { authClient } from '$lib/auth-client';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let email = $state('');
	let submitting = $state(false);
	let sentTo = $state<string | null>(null);
	let error = $state<string | null>(null);

	const callbackURL = $derived(page.url.searchParams.get('next') ?? '/');

	async function handleMagicLink(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		if (!email) return;
		submitting = true;
		const res = await authClient.signIn.magicLink({ email, callbackURL });
		submitting = false;
		if (res.error) {
			error = res.error.message ?? 'Could not send magic link.';
			return;
		}
		sentTo = email;
	}

	async function handleGoogle() {
		error = null;
		const res = await authClient.signIn.social({ provider: 'google', callbackURL });
		if (res.error) {
			error = res.error.message ?? 'Could not start Google sign-in.';
		}
	}
</script>

<svelte:head><title>Sign in · Runely</title></svelte:head>

<div class="wrap">
	<div class="card">
		<h1>Sign in to Runely</h1>
		<p class="muted">Use Google or a magic link sent to your email.</p>

		{#if error}
			<div class="alert">{error}</div>
		{/if}

		{#if sentTo}
			<div class="sent">
				<div class="strong">Check your email</div>
				<div class="muted">We sent a sign-in link to <b>{sentTo}</b>. It expires in 5 minutes.</div>
				<button
					type="button"
					class="btn-link"
					onclick={() => {
						sentTo = null;
					}}>Use a different email</button
				>
			</div>
		{:else}
			{#if data.googleEnabled}
				<button type="button" class="btn google" onclick={handleGoogle}>
					<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
						<path
							fill="#4285F4"
							d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.74 3.28-8.09z"
						/>
						<path
							fill="#34A853"
							d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.99.66-2.25 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A10.99 10.99 0 0 0 12 23z"
						/>
						<path
							fill="#FBBC05"
							d="M5.84 14.11A6.59 6.59 0 0 1 5.5 12c0-.73.13-1.44.34-2.11V7.05H2.18A10.99 10.99 0 0 0 1 12c0 1.77.42 3.45 1.18 4.95l3.66-2.84z"
						/>
						<path
							fill="#EA4335"
							d="M12 5.38c1.62 0 3.07.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.05l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
						/>
					</svg>
					Continue with Google
				</button>

				<div class="divider"><span>or</span></div>
			{/if}

			<form onsubmit={handleMagicLink}>
				<label class="field">
					<span>Email</span>
					<input
						type="email"
						bind:value={email}
						placeholder="you@example.com"
						autocomplete="email"
						required
					/>
				</label>
				<button class="btn primary" type="submit" disabled={submitting}>
					{submitting ? 'Sending…' : 'Email me a sign-in link'}
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
		max-width: 380px;
		background: #fff;
		border: 1px solid #e5e7eb;
		border-radius: 10px;
		padding: 28px;
	}
	h1 {
		font-size: 20px;
		margin: 0 0 4px;
	}
	.muted {
		color: #6b7280;
		margin: 0 0 20px;
		font-size: 14px;
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
	.sent {
		background: #f0fdf4;
		border: 1px solid #bbf7d0;
		border-radius: 6px;
		padding: 16px;
	}
	.sent .strong {
		font-weight: 600;
		margin-bottom: 4px;
	}
	.btn-link {
		background: none;
		border: none;
		padding: 8px 0 0;
		color: #374151;
		text-decoration: underline;
		cursor: pointer;
		font-size: 13px;
	}
	.field {
		display: block;
		margin-bottom: 14px;
	}
	.field > span {
		display: block;
		font-weight: 600;
		font-size: 13px;
		margin-bottom: 6px;
	}
	input[type='email'] {
		width: 100%;
		padding: 9px 11px;
		border: 1px solid #d1d5db;
		border-radius: 6px;
		font: inherit;
		box-sizing: border-box;
	}
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		width: 100%;
		padding: 10px 14px;
		border-radius: 6px;
		border: 1px solid #d1d5db;
		background: #fff;
		color: #111;
		cursor: pointer;
		font: inherit;
		box-sizing: border-box;
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
	.btn.google {
		font-weight: 500;
	}
	.divider {
		position: relative;
		text-align: center;
		margin: 18px 0;
		color: #9ca3af;
		font-size: 12px;
	}
	.divider::before {
		content: '';
		position: absolute;
		inset: 50% 0 0 0;
		border-top: 1px solid #e5e7eb;
	}
	.divider span {
		position: relative;
		padding: 0 10px;
		background: #fff;
	}
</style>
