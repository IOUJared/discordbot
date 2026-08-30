<script lang="ts">
  import Badge from "$lib/components/Badge.svelte"
  import Button from "$lib/components/Button.svelte"
  import type { ShowcaseState } from "./state-model"
  let { state }: { state: ShowcaseState } = $props()
  const legendId = $derived(`source-priority-${state}`)
</script>

<section class="provider-harness" class:hover-state={state === "hover"} class:focus-state={state === "focus-visible"} aria-labelledby={legendId}>
  <header><p class="eyebrow">Playback sources</p><h4 id={legendId}>Source priority</h4></header>
  <div class="provider-heading"><span><strong>Mock TIDAL</strong><small>Local classroom simulator</small></span><Badge status={state === "empty" ? "degraded" : state === "error" ? "disconnected" : state === "loading" ? "reconnecting" : "connected"} label={state === "empty" ? "Simulator off · YouTube active" : state === "error" ? "Source update failed" : state === "loading" ? "Updating source" : "Simulator connected"} /></div>
  {#if state === "error"}<p class="error" role="alert">Source preference could not be saved.</p>{/if}
  <Button label={state === "empty" ? "Connect simulator" : "Disconnect simulator"} variant={state === "empty" ? "primary" : "secondary"} disabled={state === "disabled"} loading={state === "loading"} />
  <fieldset disabled={state === "disabled" || state === "loading"}>
    <legend>Search priority</legend>
    <label><input type="radio" name={`priority-${state}`} checked={state !== "empty" && state !== "active"} /><span><strong>Mock TIDAL first</strong><small>Local lossless fixtures, then YouTube.</small></span></label>
    <label><input type="radio" name={`priority-${state}`} checked={state === "empty" || state === "active"} /><span><strong>YouTube only</strong><small>Skip the simulator.</small></span></label>
  </fieldset>
</section>

<style>
  .provider-harness{display:grid;gap:var(--space-3);padding:var(--space-3);background:var(--surface-recessed)}header{padding:0}h4{margin:0}.provider-heading{display:grid;gap:var(--space-2)}.provider-heading>span,label>span{display:grid}small{color:var(--text-secondary)}fieldset{display:grid;gap:var(--space-2);margin:0;padding:var(--space-3);border:var(--line-width) solid var(--line-subtle);border-radius:var(--radius-surface)}label{min-block-size:var(--target);display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:var(--space-2);padding:var(--space-2);border-radius:var(--radius-control);background:var(--surface-raised)}label:hover{background:var(--surface-hover)}input{inline-size:var(--space-5);block-size:var(--space-5);accent-color:var(--indigo-500)}.hover-state :global(button:first-of-type){background:var(--surface-hover)}.focus-state :global(button:first-of-type){outline:var(--focus-width) solid var(--focus-ring);outline-offset:var(--focus-width)}.error{color:var(--status-error)}
</style>
