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

	// URL is the source of truth for the active project. These read-only
	// derivations come straight from page.params / page.data so the sidebar
	// always reflects the URL — across tabs, in browser history, etc.
	let activeProjectId = $derived<string | null>(page.params.projectId ?? null);
	let projectSources = $derived<
		Array<{ id: string; name: string; triggerType: string; cronExpr: string | null }>
	>(
		(
			page.data as {
				eventSources?: Array<{
					id: string;
					name: string;
					triggerType: string;
					cronExpr: string | null;
				}>;
			}
		).eventSources ?? []
	);
	let projectWorkflows = $derived<Array<{ id: string; name: string; eventSourceId: string }>>(
		(
			page.data as {
				workflows?: Array<{ id: string; name: string; eventSourceId: string }>;
			}
		).workflows ?? []
	);
	let currentSourceId = $derived(page.params.sourceId ?? null);
	let currentWorkflowId = $derived(page.params.workflowId ?? null);

	let isOnProjectHome = $derived(
		activeProjectId !== null && page.url.pathname === `/p/${activeProjectId}`
	);
	let isOnNewSource = $derived(page.url.pathname.endsWith('/sources/new'));
	let isOnSecrets = $derived(page.url.pathname.endsWith('/secrets'));
	let isOnProjects = $derived(page.url.pathname.startsWith('/projects'));

	function sourceTriggerLabel(t: string): string {
		return t === 'cron' ? 'cron' : 'webhook';
	}

	async function onProjectChange(e: Event) {
		const next = (e.currentTarget as HTMLSelectElement).value;
		if (!next || next === activeProjectId) return;
		// Switch to the project's home. We could try to preserve the current
		// sub-page (e.g. /secrets), but workflow ids are project-scoped so
		// /w/[id] would 404 anyway. Project root is always safe.
		await goto(resolve('/p/[projectId]', { projectId: next }));
	}
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

				{#if data.projects.length > 0}
					<div class="project-switcher">
						<div class="ps-label">Project</div>
						<select
							aria-label="Active project"
							value={activeProjectId ?? ''}
							onchange={onProjectChange}
						>
							{#if activeProjectId === null}
								<option value="" disabled>Select a project…</option>
							{/if}
							{#each data.projects as p (p.id)}
								<option value={p.id}>{p.name}</option>
							{/each}
						</select>
						<a href={resolve('/projects')} class="ps-manage" class:active={isOnProjects}>
							Manage projects
						</a>
					</div>
				{/if}

				{#if activeProjectId !== null}
					<nav class="primary" aria-label="Primary">
						<a
							href={resolve('/p/[projectId]', { projectId: activeProjectId })}
							class="nav-link"
							class:active={isOnProjectHome}
						>
							Events
						</a>
						<a
							href={resolve('/p/[projectId]/sources/new', { projectId: activeProjectId })}
							class="nav-link new"
							class:active={isOnNewSource}
						>
							+ New event
						</a>
						<a
							href={resolve('/p/[projectId]/secrets', { projectId: activeProjectId })}
							class="nav-link"
							class:active={isOnSecrets}
						>
							Secrets
						</a>
					</nav>

					{#if projectSources.length > 0}
						<div class="section">
							<div class="section-title">Events in this project</div>
							<ul class="wf-list">
								{#each projectSources as s (s.id)}
									{@const attached = projectWorkflows.filter((w) => w.eventSourceId === s.id)}
									<li>
										<a
											href={resolve('/p/[projectId]/s/[sourceId]', {
												projectId: activeProjectId,
												sourceId: s.id
											})}
											class="wf-link"
											class:active={currentSourceId === s.id}
											title={s.name}
										>
											<span class="wf-name">{s.name}</span>
											<span class="wf-sub">{sourceTriggerLabel(s.triggerType)}</span>
										</a>
										{#if attached.length > 0}
											<ul class="wf-sublist">
												{#each attached as w (w.id)}
													<li>
														<a
															href={resolve('/p/[projectId]/w/[workflowId]', {
																projectId: activeProjectId,
																workflowId: w.id
															})}
															class="wf-link nested"
															class:active={currentWorkflowId === w.id}
															title={w.name}
														>
															{w.name}
														</a>
													</li>
												{/each}
											</ul>
										{/if}
									</li>
								{/each}
							</ul>
						</div>
					{/if}
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
	.project-switcher {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 6px 8px 10px;
		border-bottom: 1px solid #f1f5f9;
		margin-bottom: 10px;
	}
	.ps-label {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #6b7280;
	}
	.project-switcher select {
		width: 100%;
		padding: 6px 8px;
		border: 1px solid #d1d5db;
		border-radius: 6px;
		background: #fff;
		color: #111;
		font: inherit;
		font-size: 13px;
		cursor: pointer;
	}
	.project-switcher select:hover {
		border-color: #9ca3af;
	}
	.ps-manage {
		font-size: 12px;
		color: #6b7280;
		padding: 2px 0 0;
	}
	.ps-manage:hover {
		color: #111;
	}
	.ps-manage.active {
		color: #111;
		font-weight: 600;
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
	.wf-link .wf-name {
		font-weight: 600;
		color: #111;
	}
	.wf-link .wf-sub {
		display: block;
		font-size: 11px;
		color: #9ca3af;
		font-weight: 400;
	}
	.wf-link.active .wf-name {
		color: #3730a3;
	}
	.wf-sublist {
		list-style: none;
		margin: 2px 0 6px;
		padding: 0 0 0 14px;
		display: flex;
		flex-direction: column;
		gap: 1px;
		border-left: 1px solid #e5e7eb;
	}
	.wf-link.nested {
		font-size: 12.5px;
		padding: 4px 10px;
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
