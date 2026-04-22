<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import { resolve } from '$app/paths';
	import { goto, invalidateAll } from '$app/navigation';
	import { authClient } from '$lib/auth-client';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	async function signOut() {
		await authClient.signOut();
		await invalidateAll();
		await goto(resolve('/auth'));
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Runely</title>
</svelte:head>

<div class="app">
	<header class="site-header">
		<div class="container">
			<a class="brand" href={resolve('/')}>Runely</a>
			{#if data.user}
				<nav>
					<a href={resolve('/')}>Workflows</a>
					<a href={resolve('/new')}>New</a>
					<span class="who">{data.user.email}</span>
					<button type="button" class="signout" onclick={signOut}>Sign out</button>
				</nav>
			{/if}
		</div>
	</header>
	<main class="container">
		{@render children()}
	</main>
</div>

<style>
	:global(html, body) {
		margin: 0;
		padding: 0;
		background: #fafafa;
		color: #1a1a1a;
		font-family:
			-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
		font-size: 14px;
		line-height: 1.5;
	}
	:global(*, *::before, *::after) {
		box-sizing: border-box;
	}
	:global(a) {
		color: #2563eb;
		text-decoration: none;
	}
	:global(a:hover) {
		text-decoration: underline;
	}
	:global(button) {
		font: inherit;
	}
	:global(code, pre) {
		font-family:
			ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New',
			monospace;
		font-size: 12.5px;
	}
	.app {
		min-height: 100vh;
	}
	.site-header {
		background: #fff;
		border-bottom: 1px solid #e5e7eb;
	}
	.site-header .container {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding-top: 14px;
		padding-bottom: 14px;
	}
	.brand {
		font-weight: 700;
		font-size: 18px;
		color: #111;
		letter-spacing: -0.01em;
	}
	.brand:hover {
		text-decoration: none;
	}
	nav {
		display: flex;
		align-items: center;
		gap: 16px;
	}
	nav a {
		color: #4b5563;
	}
	.who {
		color: #6b7280;
		font-size: 13px;
		padding-left: 4px;
		border-left: 1px solid #e5e7eb;
		margin-left: 4px;
		padding-inline-start: 10px;
	}
	.signout {
		background: none;
		border: none;
		color: #4b5563;
		cursor: pointer;
		padding: 0;
		text-decoration: underline;
	}
	.signout:hover {
		color: #111;
	}
	.container {
		max-width: 1100px;
		margin: 0 auto;
		padding: 0 20px;
	}
	main {
		padding-top: 24px;
		padding-bottom: 48px;
	}
</style>
