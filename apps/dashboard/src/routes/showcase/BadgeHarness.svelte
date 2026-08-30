<script lang="ts">
  import Badge from "$lib/components/Badge.svelte"
  import type { ShowcaseState } from "./state-model"
  let { state }: { state: ShowcaseState } = $props()
</script>

<button class="badge-trigger" class:hover-state={state === "hover"} class:focus-state={state === "focus-visible"} disabled={state === "disabled"} aria-label="Connection details">
  <Badge status={state === "loading" ? "reconnecting" : state === "error" ? "disconnected" : state === "empty" ? "degraded" : "connected"} label={state === "loading" ? "Reconnecting" : state === "error" ? "Disconnected" : state === "empty" ? "No configured room" : "Connected"} />
</button>

<style>
  .badge-trigger{min-block-size:var(--target);padding-inline:var(--space-3);border:0;border-radius:var(--radius-control);background:var(--surface-raised);color:inherit}.badge-trigger:hover:not(:disabled),.hover-state{background:var(--surface-hover)}.focus-state{outline:var(--focus-width) solid var(--focus-ring);outline-offset:var(--focus-width)}.badge-trigger:disabled{color:var(--text-muted)}
</style>
