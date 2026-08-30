<script lang="ts">
  import type { PlaybackFailureNotification } from "@discord-music/contracts"
  import X from "phosphor-svelte/lib/X"

  let { failure, dismiss }: { failure: PlaybackFailureNotification | null; dismiss: () => void } =
    $props()
</script>

<div class="toast-region" aria-live="assertive" aria-atomic="true">
  {#if failure !== null}
    <article role="alert" data-testid="playback-failure-toast">
      <span><strong>Track skipped</strong><small>{failure.title} could not be played.</small></span>
      <button aria-label="Dismiss playback failure" onclick={dismiss}><X size={18} aria-hidden="true" /></button>
    </article>
  {/if}
</div>

<style>
  .toast-region{position:fixed;z-index:9;inset-block-start:var(--space-4);inset-inline-end:var(--space-4);inline-size:min(calc(100% - var(--space-8)),22rem);pointer-events:none}article{display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3);border:var(--line-width) solid var(--status-error);border-radius:var(--radius-control);background:var(--surface-raised);pointer-events:auto}span{min-inline-size:0;display:grid;flex:1}small{color:var(--text-secondary);overflow-wrap:anywhere}button{min-inline-size:var(--target);min-block-size:var(--target);display:grid;place-items:center;border:0;border-radius:var(--radius-control);background:transparent;color:var(--text-secondary)}button:hover{background:var(--surface-hover);color:var(--text-primary)}button:focus-visible{outline:var(--focus-width) solid var(--focus-ring);outline-offset:var(--focus-width)}
</style>
