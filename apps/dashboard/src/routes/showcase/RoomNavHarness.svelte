<script lang="ts">
  import House from "phosphor-svelte/lib/House"
  import Lock from "phosphor-svelte/lib/Lock"
  import SpinnerGap from "phosphor-svelte/lib/SpinnerGap"
  import Badge from "$lib/components/Badge.svelte"
  import Button from "$lib/components/Button.svelte"
  import type { ShowcaseState } from "./state-model"
  let { state }: { state: ShowcaseState } = $props()
</script>

<nav class:hover-state={state === "hover"} class:focus-state={state === "focus-visible"} aria-label={`Room navigation ${state} state`}>
  <p class="eyebrow">Room</p>
  {#if state === "empty"}
    <div class="message"><strong>No active room</strong><span>Choose a room to start listening.</span></div>
  {:else}
    <Button label="Main Room" pressed={state === "active"} disabled={state === "disabled"} loading={state === "loading"} />
    <button class="room-action" disabled={state === "disabled"}><House size={18} aria-hidden="true" />Stage</button>
    <button class="room-action" disabled title="Study is unavailable"><Lock size={18} aria-hidden="true" />Study</button>
    <Badge status={state === "loading" ? "reconnecting" : state === "error" ? "disconnected" : "connected"} label={state === "loading" ? "Reconnecting" : state === "error" ? "Room load failed" : "Voice connected"} />
    {#if state === "loading"}<SpinnerGap class="spin" size={18} aria-hidden="true" />{/if}
    {#if state === "error"}<p class="error" role="alert">Rooms could not be loaded.</p>{/if}
  {/if}
</nav>

<style>
  nav{min-block-size:calc(var(--space-12) * 4);display:grid;align-content:start;gap:var(--space-2);padding:var(--space-3);background:var(--surface-recessed)}.room-action{min-block-size:var(--target);display:flex;align-items:center;gap:var(--space-2);padding-inline:var(--space-3);border:0;border-radius:var(--radius-control);background:transparent;color:var(--text-secondary)}.room-action:hover:not(:disabled),.hover-state :global(button:first-of-type){background:var(--surface-hover);color:var(--text-primary)}.focus-state :global(button:first-of-type){outline:var(--focus-width) solid var(--focus-ring);outline-offset:var(--focus-width)}.message{display:grid;gap:var(--space-1);color:var(--text-secondary)}.error{color:var(--status-error)}:global(.spin){animation:spin var(--motion-standard) linear infinite}@keyframes spin{to{transform:rotate(1turn)}}@media(prefers-reduced-motion:reduce){:global(.spin){animation:none}}
</style>
