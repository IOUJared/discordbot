<script lang="ts">
  import type { PlaybackFailureNotification } from "@discord-music/contracts"
  import X from "phosphor-svelte/lib/X"

  let { failure, dismiss }: { failure: PlaybackFailureNotification | null; dismiss: () => void } =
    $props()
  const standardMotionDuration = (): number => {
    const token = getComputedStyle(document.documentElement).getPropertyValue("--motion-standard")
    const duration = Number.parseFloat(token)
    return token.includes("ms") ? duration : duration * 1_000
  }
  const toastMotion = (_node: Element) => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    return {
      duration: standardMotionDuration(),
      css: (t: number) => {
        if (reduced) return `opacity:${t}`
        const remaining = 1 - t
        return `opacity:${t};transform:translateY(${-8 * remaining}px);filter:blur(${2 * remaining}px)`
      },
    }
  }
</script>

<div class="toast-region" data-testid="playback-failure-region" aria-live="polite" aria-atomic="true">
  {#if failure !== null}
    <article role="status" data-testid="playback-failure-toast" transition:toastMotion>
      <span><strong>Track skipped</strong><small>{failure.title} could not be played.</small></span>
      <button aria-label="Dismiss playback failure" onclick={dismiss}><X size={18} aria-hidden="true" /></button>
    </article>
  {/if}
</div>

<style>
  .toast-region{position:fixed;z-index:9;inset-block-start:calc(var(--header-mobile) + var(--space-4));inset-inline-start:50%;inline-size:min(calc(100% - var(--space-8)),22rem);pointer-events:none;transform:translateX(-50%)}
  article{display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3) var(--space-3) var(--space-3) var(--space-4);border:var(--line-width) solid rgba(235,111,146,.4);border-inline-start-width:3px;border-radius:var(--radius-control);background:var(--glass-strong);backdrop-filter:blur(20px);box-shadow:var(--shadow-dialog);pointer-events:auto;will-change:transform,opacity,filter}
  span{min-inline-size:0;display:grid;flex:1;gap:2px}
  strong{font-weight:600}
  small{color:var(--text-secondary);overflow-wrap:anywhere}
  button{min-inline-size:var(--target);min-block-size:var(--target);display:grid;place-items:center;border:0;border-radius:999px;background:transparent;color:var(--text-secondary);transition:background var(--motion-micro),color var(--motion-micro)}
  button:hover{background:var(--surface-hover);color:var(--text-primary)}
  button:focus-visible{outline:var(--focus-width) solid var(--focus-ring);outline-offset:var(--focus-width)}
  @media(min-width:768px){.toast-region{inset-block-start:auto;inset-block-end:calc(var(--footer-mobile) + var(--space-4))}}
  @media(min-width:1024px){.toast-region{inset-block-start:50%;inset-block-end:auto;transform:translate(-50%,-50%)}}
  @media(prefers-reduced-motion:reduce){article{will-change:opacity}button{transition:none}}
</style>
