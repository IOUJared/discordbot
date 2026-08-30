<script lang="ts">
  import Transport from "$lib/components/Transport.svelte"
  import type { ShowcaseState } from "./state-model"
  let { state }: { state: ShowcaseState } = $props()
  const noop = (): void => undefined
</script>

<div class="transport-harness" class:hover-state={state === "hover"} class:focus-state={state === "focus-visible"}>
  <Transport paused={false} hasCurrent={state !== "empty"} busy={state === "disabled" || state === "loading"} loopMode={state === "active" ? "queue" : "off"} command={noop} />
  {#if state === "loading"}<p role="status">Sending playback command…</p>{/if}
  {#if state === "error"}<p class="error" role="alert">Playback command failed.</p>{/if}
</div>

<style>
  .transport-harness{display:grid;gap:var(--space-2)}.hover-state :global(.play){background:var(--surface-hover)}.focus-state :global(.play){outline:var(--focus-width) solid var(--focus-ring);outline-offset:var(--focus-width)}p{color:var(--text-secondary)}.error{color:var(--status-error)}
</style>
