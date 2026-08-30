<script lang="ts">
  import Range from "$lib/components/Range.svelte"
  import type { ShowcaseState } from "./state-model"
  let { state }: { state: ShowcaseState } = $props()
  const noopValue = (_value: number): void => undefined
</script>

<div class="range-harness" class:hover-state={state === "hover"} class:active-state={state === "active"} class:focus-state={state === "focus-visible"}>
  <Range label={state === "empty" ? "Seek unavailable" : state === "loading" ? "Loading position" : "Seek"} value={state === "empty" || state === "loading" ? 0 : 68} disabled={state === "disabled" || state === "empty" || state === "loading"} oninput={noopValue} />
  {#if state === "error"}<p role="alert">Seek rejected. Position restored.</p>{/if}
</div>

<style>
  .range-harness{display:grid;gap:var(--space-2)}.hover-state :global(input){filter:brightness(1.2)}.active-state :global(input){transform:scaleY(1.08)}.focus-state :global(input){outline:var(--focus-width) solid var(--focus-ring);outline-offset:var(--focus-width)}p{color:var(--status-error)}@media(prefers-reduced-motion:reduce){.active-state :global(input){transform:none}}
</style>
