<script lang="ts">
  import SpinnerGap from "phosphor-svelte/lib/SpinnerGap"
  import RoomNav from "$lib/components/RoomNav.svelte"
  import type { VoiceChannel } from "$lib/services/api.js"
  import type { ShowcaseState } from "./state-model"

  let { state: showcaseState }: { state: ShowcaseState } = $props()

  const channels: readonly VoiceChannel[] = [
    { id: "voice-main", name: "Main Room", memberCount: 2 },
    { id: "voice-lounge", name: "Lounge", memberCount: 3 },
  ]

  let activeChannelId = $state<string | null>("voice-main")
</script>

<div
  class:hover-state={showcaseState === "hover"}
  class:focus-state={showcaseState === "focus-visible"}
  aria-label={`Room navigation ${showcaseState} state`}
>
  <RoomNav
    channels={showcaseState === "empty" || showcaseState === "error" ? [] : channels}
    {activeChannelId}
    voiceConnected={activeChannelId !== null}
    socketStatus={showcaseState === "loading" ? "reconnecting" : showcaseState === "error" ? "disconnected" : "connected"}
    view="player"
    busy={showcaseState === "disabled" || showcaseState === "loading"}
    onchange={() => undefined}
    onchannel={(channel) => (activeChannelId = channel.id)}
    logout={() => undefined}
  />
  {#if showcaseState === "loading"}<SpinnerGap class="spin" size={18} aria-label="Loading voice channels" />{/if}
  {#if showcaseState === "error"}<p class="error" role="alert">Voice channels could not be loaded.</p>{/if}
</div>

<style>
  div{position:relative;min-block-size:calc(var(--space-12) * 5);background:var(--surface-recessed)}
  div :global(nav){min-block-size:inherit;border:0;padding:var(--space-3);gap:var(--space-3)}
  div :global(.status){margin-block-start:0;padding-block-start:var(--space-3)}
  .hover-state :global(.channels button:first-of-type){background:var(--surface-hover);color:var(--text-primary)}
  .focus-state :global(.channels button:first-of-type){outline:var(--focus-width) solid var(--focus-ring);outline-offset:var(--focus-width)}
  .error{position:absolute;inset-inline:var(--space-4);inset-block-end:var(--space-3);color:var(--status-error);font-size:var(--type-compact)}
  :global(.spin){position:absolute;inset-inline-end:var(--space-4);inset-block-start:var(--space-4);animation:spin var(--motion-standard) linear infinite}
  @keyframes spin{to{transform:rotate(1turn)}}
  @media(prefers-reduced-motion:reduce){:global(.spin){animation:none}}
</style>
