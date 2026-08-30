<script lang="ts">
  import SpinnerGap from "phosphor-svelte/lib/SpinnerGap"
  import Button from "$lib/components/Button.svelte"
  import type { ShowcaseState } from "./state-model"
  let { state }: { state: ShowcaseState } = $props()
</script>

<div class="toast-region" class:hover-state={state === "hover"} class:focus-state={state === "focus-visible"} aria-live="polite">
  {#if state !== "default" && state !== "empty"}
    <article class:error={state === "error"}>
      {#if state === "loading"}<SpinnerGap class="spin" size={18} aria-hidden="true" />{/if}
      <span><strong>{state === "error" ? "Command failed" : state === "loading" ? "Command pending" : "Added to queue"}</strong><small>{state === "error" ? "Reconnect, then retry." : "Still Water is ready."}</small></span>
      <Button label={state === "active" ? "Dismissing" : state === "error" ? "Retry" : "Dismiss"} pressed={state === "active"} disabled={state === "disabled"} />
    </article>
  {/if}
</div>
{#if state === "default"}<p class="quiet">Hidden until a notification arrives.</p>{/if}
{#if state === "empty"}<p class="quiet">No notifications.</p>{/if}

<style>
  .toast-region{min-block-size:calc(var(--space-12) * 2 + var(--space-4));display:grid;align-content:end}.quiet{color:var(--text-muted)}article{display:flex;align-items:center;gap:var(--space-2);padding:var(--space-3);border-radius:var(--radius-control);background:var(--surface-raised)}article>span{min-inline-size:0;display:grid;flex:1}.hover-state :global(article>button){background:var(--surface-hover)}.focus-state :global(article>button){outline:var(--focus-width) solid var(--focus-ring);outline-offset:var(--focus-width)}.error{color:var(--status-error)}small{color:var(--text-secondary)}:global(.spin){animation:spin var(--motion-standard) linear infinite}@keyframes spin{to{transform:rotate(1turn)}}@media(prefers-reduced-motion:reduce){:global(.spin){animation:none}}
</style>
