<script lang="ts">
  import SpinnerGap from "phosphor-svelte/lib/SpinnerGap"
  import WarningCircle from "phosphor-svelte/lib/WarningCircle"
  import Button from "$lib/components/Button.svelte"
  import type { ShowcaseState } from "./state-model"

  let { state: showcaseState }: { state: ShowcaseState } = $props()
  let queueOpen = $state(false)
  let queueTrigger = $state<HTMLButtonElement>()
  let queueClose = $state<HTMLButtonElement>()
  const openQueue = (): void => {
    queueOpen = true
    requestAnimationFrame(() => queueClose?.focus())
  }
  const closeQueue = (): void => {
    queueOpen = false
    requestAnimationFrame(() => queueTrigger?.focus())
  }
</script>

<div class="mini-shell" class:hover-state={showcaseState === "hover"} class:focus-state={showcaseState === "focus-visible"} aria-label={`App shell ${showcaseState} state`}>
  <a href={`#shell-main-${showcaseState}`} class="skip-mini">Skip to main</a>
  <header><strong>Listening room</strong><span>Main Room</span><button bind:this={queueTrigger} class="queue-trigger" disabled={showcaseState === "disabled"} onclick={openQueue}>Open queue</button></header>
  <nav aria-label="Showcase room navigation"><Button label="Main Room" pressed={showcaseState === "active"} disabled={showcaseState === "disabled"} /></nav>
  <main id={`shell-main-${showcaseState}`}>
    {#if showcaseState === "loading"}<SpinnerGap class="spin" size={24} aria-hidden="true" /><strong>Reconnecting room</strong><span class="skeleton" aria-hidden="true"></span>
    {:else if showcaseState === "empty"}<strong>No active room</strong><span>Choose a room to begin.</span>
    {:else if showcaseState === "error"}<WarningCircle size={24} aria-hidden="true" /><strong>Room failed to load</strong><Button label="Retry room" variant="danger" />
    {:else}<strong>Now playing</strong><span>Mountain Echoes</span>{/if}
  </main>
  <aside aria-label="Queue region">Queue · {showcaseState === "empty" ? 0 : 1}</aside>
  <footer>Player footer</footer>
  {#if queueOpen}<div class="queue-backdrop"><div class="queue-overlay" role="dialog" aria-modal="true" aria-label="App shell queue"><button bind:this={queueClose} onclick={closeQueue}>Close queue</button><strong>Queue</strong><span>{showcaseState === "empty" ? "No requests" : "Mountain Echoes"}</span></div></div>{/if}
</div>

<style>
  .mini-shell{min-block-size:calc(var(--space-12) * 4 + var(--space-6));display:grid;grid-template:"header header header" auto "nav main queue" 1fr "footer footer footer" auto/var(--footer-mobile) minmax(0,1fr) var(--footer-mobile);overflow:hidden;border:var(--line-width) solid var(--line-subtle);border-radius:var(--radius-surface);background:var(--surface-canvas)}
  header{grid-area:header;display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);padding:var(--space-2);background:var(--surface-recessed)}nav{grid-area:nav;padding:var(--space-2);background:var(--surface-recessed)}main{grid-area:main;inline-size:auto;margin:0;padding:var(--space-3);display:grid;place-content:center;gap:var(--space-1);text-align:center}aside{grid-area:queue;padding:var(--space-2);border-inline-start:var(--line-width) solid var(--line-subtle)}footer{grid-area:footer;padding:var(--space-2);background:var(--surface-recessed)}.queue-trigger,.queue-overlay button{display:none;min-block-size:var(--target);border:0;border-radius:var(--radius-control);background:var(--surface-raised);color:var(--text-primary)}.queue-backdrop{display:none}.queue-overlay{min-block-size:0;gap:var(--space-2);padding:var(--space-3);background:var(--surface-raised)}.hover-state nav :global(button:not(:disabled)){background:var(--surface-hover)}.focus-state nav :global(button:not(:disabled)){outline:var(--focus-width) solid var(--focus-ring);outline-offset:var(--focus-width)}.skip-mini{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%)}.skip-mini:focus{inline-size:auto;block-size:auto;clip-path:none}:global(.spin){animation:spin var(--motion-standard) linear infinite}@keyframes spin{to{transform:rotate(1turn)}}
  @media(prefers-reduced-motion:reduce){:global(.spin){animation:none}}
  .skeleton{inline-size:75%;block-size:var(--space-2);margin-inline:auto;border-radius:var(--radius-control);background:var(--surface-hover)}
  @media(min-width:768px) and (max-width:1023px){.mini-shell{position:relative;grid-template:"header header" auto "nav main" 1fr "footer footer" auto/var(--rail-collapsed) minmax(0,1fr)}aside{display:none}.queue-trigger,.queue-overlay button{display:block}.hover-state .queue-trigger{background:var(--surface-hover)}.focus-state .queue-trigger{outline:var(--focus-width) solid var(--focus-ring);outline-offset:var(--focus-width)}.queue-backdrop{position:absolute;inset:0;display:grid;justify-items:end;background:var(--surface-canvas)}.queue-overlay{inline-size:min(100%,var(--drawer-tablet));display:grid;align-content:start}}
  @media(max-width:767px){.mini-shell{position:relative;grid-template:"header" auto "main" 1fr "footer" auto/minmax(0,1fr)}nav,aside,header>span{display:none}.queue-trigger,.queue-overlay button{display:block}.hover-state .queue-trigger{background:var(--surface-hover)}.focus-state .queue-trigger{outline:var(--focus-width) solid var(--focus-ring);outline-offset:var(--focus-width)}.queue-backdrop{position:absolute;inset:0;display:grid;align-items:end;background:var(--surface-canvas)}.queue-overlay{display:grid;align-content:start;border-radius:var(--radius-surface) var(--radius-surface) 0 0}}
</style>
