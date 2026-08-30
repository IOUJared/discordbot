<script lang="ts">
  import ArrowsClockwise from "phosphor-svelte/lib/ArrowsClockwise"
  import Pause from "phosphor-svelte/lib/Pause"
  import Play from "phosphor-svelte/lib/Play"
  import Shuffle from "phosphor-svelte/lib/Shuffle"
  import SkipBack from "phosphor-svelte/lib/SkipBack"
  import SkipForward from "phosphor-svelte/lib/SkipForward"
  import Stop from "phosphor-svelte/lib/Stop"
  import type { LoopMode } from "@discord-music/contracts"
  import IconButton from "./IconButton.svelte"
  let { paused, hasCurrent, busy, loopMode, command }: { paused: boolean; hasCurrent: boolean; busy: boolean; loopMode: LoopMode; command: (name: string) => void } = $props()
</script>
<div class="transport" aria-label="Playback controls">
  <IconButton label="Shuffle queue" disabled={!hasCurrent || busy} onclick={() => command("shuffle")}><Shuffle size={22} weight="bold" aria-hidden="true" /></IconButton>
  <IconButton label="Restart track" disabled={!hasCurrent || busy} onclick={() => command("restart")}><SkipBack size={22} weight="fill" aria-hidden="true" /></IconButton>
  <button class="play" aria-label={paused ? "Resume playback" : "Pause playback"} disabled={!hasCurrent || busy} onclick={() => command(paused ? "resume" : "pause")}>{#if paused}<Play size={28} weight="fill" aria-hidden="true" />{:else}<Pause size={28} weight="fill" aria-hidden="true" />{/if}</button>
  <IconButton label="Skip track" disabled={!hasCurrent || busy} onclick={() => command("skip")}><SkipForward size={22} weight="fill" aria-hidden="true" /></IconButton>
  <IconButton label={`Loop mode: ${loopMode}`} active={loopMode !== "off"} disabled={busy} onclick={() => command("loop")}><ArrowsClockwise size={22} weight="bold" aria-hidden="true" /></IconButton>
  <IconButton label="Stop playback" disabled={!hasCurrent || busy} onclick={() => command("stop")}><Stop size={20} weight="fill" aria-hidden="true" /></IconButton>
</div>
<style>
  .transport{display:flex;align-items:center;justify-content:center;gap:var(--space-2);flex-wrap:wrap}.play{display:grid;place-items:center;inline-size:var(--space-12);block-size:var(--space-12);border:0;border-radius:var(--radius-control);background:var(--indigo-400);color:var(--text-primary)}.play:hover:not(:disabled){background:var(--indigo-300)}.play:active:not(:disabled){transform:scale(.96)}.play:disabled{background:var(--surface-raised);color:var(--text-muted)}
</style>
