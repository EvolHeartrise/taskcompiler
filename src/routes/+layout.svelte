<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import { resolve } from '$app/paths';
	import type { Snippet } from 'svelte';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Runely</title>
</svelte:head>

<div class="app">
	<header class="site-header">
		<div class="container">
			<a class="brand" href={resolve('/')}>Runely</a>
			<nav>
				<a href={resolve('/')}>Workflows</a>
				<a href={resolve('/new')}>New</a>
			</nav>
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
			-apple-system,
			BlinkMacSystemFont,
			'Segoe UI',
			Roboto,
			Oxygen,
			Ubuntu,
			Cantarell,
			sans-serif;
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
			ui-monospace,
			SFMono-Regular,
			Menlo,
			Monaco,
			Consolas,
			'Liberation Mono',
			'Courier New',
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
		gap: 16px;
	}
	nav a {
		color: #4b5563;
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
