<script lang="ts">
  import MusicNotes from "phosphor-svelte/lib/MusicNotes"
  import SpinnerGap from "phosphor-svelte/lib/SpinnerGap"
  import Artwork from "$lib/components/Artwork.svelte"
  import Button from "$lib/components/Button.svelte"
  import Range from "$lib/components/Range.svelte"
  import Transport from "$lib/components/Transport.svelte"
  import { showcaseItem } from "./fixtures"
  import type { ShowcaseState } from "./state-model"
  let { state }: { state: ShowcaseState } = $props()
  const noop = (): void => undefined
  const noopValue = (_value: number): void => undefined
</script>

<section class="now-harness" class:hover-state={state === "hover"} class:focus-state={state === "focus-visible"} aria-label={`Now playing ${state} state`}>
  {#if state === "empty" || state === "error"}
    <div class="art empty"><MusicNotes size={40} aria-hidden="true" /></div>
    <strong>Nothing is playing</strong>
    <span>{state === "error" ? "Media unavailable. Try another result." : "Search for a track and add it to the queue."}</span>
    {#if state === "error"}<Button label="Try another result" variant="danger" />{/if}
  {:else}
    <div class="art"><Artwork src={showcaseItem.track.artworkUrl ?? ""} alt={`Artwork for ${showcaseItem.track.title}`} priority /></div>
    <strong>{showcaseItem.track.title}</strong><span>{showcaseItem.track.artist}</span>
    <Button label="Artwork menu" pressed={state === "active"} disabled={state === "disabled" || state === "loading"} loading={state === "loading"} />
    <Range label={state === "loading" ? "Loading position" : "Seek"} value={state === "loading" ? 0 : 68} disabled={state === "disabled" || state === "loading"} oninput={noopValue} />
    <Transport paused={false} hasCurrent busy={state === "disabled" || state === "loading"} loopMode="off" command={noop} />
    {#if state === "loading"}<p class="loading"><SpinnerGap class="spin" size={18} aria-hidden="true" />Loading track metadata…</p>{/if}
  {/if}
</section>

<style>
  .now-harness{display:grid;gap:var(--space-2);padding:var(--space-3);background:var(--surface-primary)}.art{inline-size:min(100%,var(--showcase-media-min));aspect-ratio:1;display:grid;place-items:center;overflow:hidden;border-radius:var(--radius-surface);background:var(--surface-raised);color:var(--text-muted)}.now-harness>strong{overflow-wrap:anywhere}.now-harness>span{color:var(--text-secondary)}.hover-state :global(button:first-of-type){background:var(--surface-hover)}.focus-state :global(button:first-of-type){outline:var(--focus-width) solid var(--focus-ring);outline-offset:var(--focus-width)}.loading{display:flex;align-items:center;gap:var(--space-2);color:var(--text-secondary)}:global(.spin){animation:spin var(--motion-standard) linear infinite}@keyframes spin{to{transform:rotate(1turn)}}@media(prefers-reduced-motion:reduce){:global(.spin){animation:none}}
</style>
