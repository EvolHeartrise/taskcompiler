<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import { resolve } from '$app/paths';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { authClient } from '$lib/auth-client';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	async function signOut() {
		await authClient.signOut();
		await invalidateAll();
		await goto(resolve('/auth'));
	}

	let currentWorkflowId = $derived(page.params.workflowId ?? null);
	let isOnHome = $derived(page.url.pathname === '/');
	let isOnNew = $derived(page.url.pathname.startsWith('/new'));
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Runely</title>
</svelte:head>

{#if data.user}
	<div class="app">
		<aside class="sidebar">
			<div class="sidebar-inner">
				<a class="brand" href={resolve('/')}>
					<img src={favicon} alt="" class="brand-icon" />
					<span>Runely</span>
				</a>

				<nav class="primary" aria-label="Primary">
					<a href={resolve('/')} class="nav-link" class:active={isOnHome}>Workflows</a>
					<a href={resolve('/new')} class="nav-link new" class:active={isOnNew}>+ New workflow</a>
				</nav>

				{#if data.workflows.length > 0}
					<div class="section">
						<div class="section-title">Your workflows</div>
						<ul class="wf-list">
							{#each data.workflows as w (w.id)}
								<li>
									<a
										href={resolve('/w/[workflowId]', { workflowId: w.id })}
										class="wf-link"
										class:active={currentWorkflowId === w.id}
										title={w.name}
									>
										{w.name}
									</a>
								</li>
							{/each}
						</ul>
					</div>
				{/if}

				<div class="spacer"></div>

				<div class="user-area">
					<div class="who" title={data.user.email}>{data.user.email}</div>
					<button type="button" class="signout" onclick={signOut}>Sign out</button>
				</div>
			</div>
		</aside>
		<main class="main">
			<div class="container">
				{@render children()}
			</div>
		</main>
	</div>
{:else}
	<main class="unauthed">
		{@render children()}
	</main>
{/if}

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
		display: flex;
		align-items: stretch;
		min-height: 100vh;
	}
	.sidebar {
		flex: 0 0 240px;
		width: 240px;
		background: #fff;
		border-right: 1px solid #e5e7eb;
		position: sticky;
		top: 0;
		height: 100vh;
		overflow-y: auto;
	}
	.sidebar-inner {
		display: flex;
		flex-direction: column;
		min-height: 100%;
		padding: 16px 12px;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 8px 12px;
		color: #111;
		font-weight: 700;
		font-size: 17px;
		letter-spacing: -0.01em;
	}
	.brand:hover {
		text-decoration: none;
	}
	.brand-icon {
		width: 22px;
		height: 22px;
	}
	.primary {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding-bottom: 8px;
		border-bottom: 1px solid #f1f5f9;
		margin-bottom: 10px;
	}
	.nav-link {
		display: block;
		padding: 7px 10px;
		border-radius: 6px;
		color: #374151;
		font-weight: 500;
	}
	.nav-link:hover {
		background: #f3f4f6;
		color: #111;
		text-decoration: none;
	}
	.nav-link.active {
		background: #111827;
		color: #fff;
	}
	.nav-link.new {
		color: #2563eb;
	}
	.nav-link.new.active {
		background: #111827;
		color: #fff;
	}
	.section {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.section-title {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #6b7280;
		padding: 4px 10px;
	}
	.wf-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.wf-link {
		display: block;
		padding: 6px 10px;
		border-radius: 6px;
		color: #4b5563;
		font-size: 13px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.wf-link:hover {
		background: #f3f4f6;
		color: #111;
		text-decoration: none;
	}
	.wf-link.active {
		background: #eef2ff;
		color: #3730a3;
		font-weight: 600;
	}
	.spacer {
		flex: 1;
	}
	.user-area {
		border-top: 1px solid #f1f5f9;
		padding: 10px 10px 2px;
		margin-top: 10px;
	}
	.who {
		color: #374151;
		font-size: 12.5px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		margin-bottom: 4px;
	}
	.signout {
		background: none;
		border: none;
		padding: 0;
		color: #6b7280;
		cursor: pointer;
		font-size: 12.5px;
		text-decoration: underline;
	}
	.signout:hover {
		color: #111;
	}

	.main {
		flex: 1;
		min-width: 0;
	}
	.container {
		max-width: 1100px;
		margin: 0 auto;
		padding: 24px 20px 48px;
	}
	.unauthed {
		display: block;
	}

	@media (max-width: 800px) {
		.app {
			flex-direction: column;
		}
		.sidebar {
			position: static;
			width: 100%;
			flex: 0 0 auto;
			height: auto;
			border-right: none;
			border-bottom: 1px solid #e5e7eb;
		}
		.sidebar-inner {
			min-height: 0;
		}
		.spacer {
			display: none;
		}
	}
</style>
