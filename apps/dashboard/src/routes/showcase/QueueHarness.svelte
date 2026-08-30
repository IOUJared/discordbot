<script lang="ts">
  import SpinnerGap from "phosphor-svelte/lib/SpinnerGap"
  import Button from "$lib/components/Button.svelte"
  import { showcaseItem } from "./fixtures"
  import type { ShowcaseState } from "./state-model"
  let { state: showcaseState }: { state: ShowcaseState } = $props()
  let open = $state(true)
  let trigger = $state<HTMLButtonElement>()
  let closeButton = $state<HTMLButtonElement>()
  const titleId = $derived(`showcase-queue-${showcaseState}`)
  const openQueue = (): void => {
    open = true
    requestAnimationFrame(() => closeButton?.focus())
  }
  const closeQueue = (): void => {
    open = false
    requestAnimationFrame(() => trigger?.focus())
  }
</script>

<div class="queue-harness" class:hover-state={showcaseState === "hover"} class:focus-state={showcaseState === "focus-visible"}>
  <button bind:this={trigger} class="overlay-trigger" onclick={openQueue}>Open queue showcase</button>
  <section class="desktop-pane" aria-labelledby={`${titleId}-desktop`}>{@render QueueContent(`${titleId}-desktop`, showcaseState)}</section>
  {#if open}<div class="backdrop"><div class="overlay" role="dialog" aria-modal="true" aria-labelledby={`${titleId}-overlay`}><button bind:this={closeButton} class="close" onclick={closeQueue}>Close queue</button>{@render QueueContent(`${titleId}-overlay`, showcaseState)}</div></div>{/if}
</div>

{#snippet QueueContent(id: string, state: ShowcaseState)}
  <header><h4 {id}>Queue <span>{state === "empty" ? 0 : 1} items</span></h4><Button label="Clear" variant="danger" disabled={state === "disabled" || state === "empty" || state === "loading"} /></header>
  <div class="queue-body">
    {#if state === "error"}<p class="error" role="alert">The queue changed. Try again.</p><Button label="Retry reorder" variant="danger" />
    {:else if state === "empty"}<div class="empty"><strong>No requests</strong><span>Search for a track to add one.</span></div>
    {:else}<ol><li class:active={state === "active"} class:pending={state === "loading"}><span>1</span><span><strong>{showcaseItem.track.title}</strong><small>{showcaseItem.track.artist}</small></span>{#if state === "loading"}<SpinnerGap class="spin" size={18} aria-hidden="true" />{:else}<Button label="Move up" disabled={state === "disabled"} />{/if}</li></ol>{/if}
  </div>
{/snippet}

<style>
  .queue-harness{position:relative;min-block-size:var(--showcase-queue);overflow:hidden;background:var(--surface-recessed)}.overlay-trigger{position:absolute;inset-inline-start:var(--space-2);inset-block-end:var(--space-2);z-index:2;min-block-size:var(--target);border:0;border-radius:var(--radius-control);background:var(--surface-raised);color:var(--text-primary)}header{display:flex;align-items:center;justify-content:space-between;padding:var(--space-3);border-block-end:var(--line-width) solid var(--line-subtle)}h4{margin:0}h4 span,small{color:var(--text-muted)}.queue-body{max-block-size:calc(var(--showcase-queue) - var(--target) * 2);overflow:auto;padding:var(--space-2)}ol{margin:0;padding:0;list-style:none}li{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:var(--space-2);padding:var(--space-2);background:var(--surface-primary)}li>span:nth-child(2){min-inline-size:0;display:grid}li strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.active{background:var(--indigo-100)}.pending{opacity:.7}.empty{display:grid;place-items:center;gap:var(--space-2);padding:var(--space-8);color:var(--text-muted)}.error{color:var(--status-error)}.backdrop{display:none}.close{min-block-size:var(--target);border:0;background:var(--surface-raised);color:var(--text-primary)}.hover-state header :global(button){background:var(--surface-hover)}.focus-state header :global(button){outline:var(--focus-width) solid var(--focus-ring);outline-offset:var(--focus-width)}:global(.spin){animation:spin var(--motion-standard) linear infinite}@keyframes spin{to{transform:rotate(1turn)}}
  @media(max-width:1023px){.desktop-pane{display:none}.backdrop{position:absolute;inset:0;display:grid;background:var(--surface-canvas)}.overlay{min-block-size:0;display:grid;grid-template-rows:auto minmax(0,1fr);background:var(--surface-raised)}.overlay-trigger{position:relative;inset:auto}.close{justify-self:end;padding-inline:var(--space-3)}.hover-state .close{background:var(--surface-hover)}.focus-state .close{outline:var(--focus-width) solid var(--focus-ring);outline-offset:var(--focus-width)}}
  @media(min-width:768px) and (max-width:1023px){.backdrop{justify-items:end}.overlay{inline-size:min(100%,var(--drawer-tablet))}}
  @media(max-width:767px){.backdrop{align-items:end}.overlay{max-block-size:var(--drawer-mobile);border-radius:var(--radius-surface) var(--radius-surface) 0 0}}
  @media(prefers-reduced-motion:reduce){:global(.spin){animation:none}}
</style>
