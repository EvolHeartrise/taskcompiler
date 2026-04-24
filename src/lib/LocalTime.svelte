<script lang="ts">
	type Props = { ms: number | null | undefined };
	let { ms }: Props = $props();

	function pad(n: number): string {
		return String(n).padStart(2, '0');
	}

	// Canonical UTC fallback. Same format the client will render, just in UTC — so
	// the width matches the post-mount string character-for-character when the
	// browser's default formatter picks a similar shape.
	function utcFallback(ts: number): string {
		const d = new Date(ts);
		return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
	}

	function localLabel(ts: number): string {
		return new Date(ts).toLocaleString();
	}

	// Flipped to true after mount — SSR and first hydration both see `false`, so
	// hydration matches. $effect only runs client-side after mount.
	let mounted = $state(false);
	$effect(() => {
		mounted = true;
	});

	// Initial value (mounted=false) matches SSR. Post-mount, re-derives as localLabel.
	let label = $derived(ms == null ? '—' : mounted ? localLabel(ms) : utcFallback(ms));
	let iso = $derived(ms == null ? null : new Date(ms).toISOString());
</script>

{#if ms == null}
	<span class="muted">—</span>
{:else}
	<time datetime={iso} class="local-time">{label}</time>
{/if}

<style>
	.local-time {
		font-variant-numeric: tabular-nums;
	}
</style>
