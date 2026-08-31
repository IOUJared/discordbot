<script lang="ts">
  import type { PlayerSnapshot } from "@discord-music/contracts"
  import MusicNotes from "phosphor-svelte/lib/MusicNotes"
  import SpeakerHigh from "phosphor-svelte/lib/SpeakerHigh"
  import Artwork from "./Artwork.svelte"
  import Range from "./Range.svelte"
  import TrackTitle from "./TrackTitle.svelte"
  import Transport from "./Transport.svelte"
  let { player, position, busy, command, previewSeek, seek, volume }: { player: PlayerSnapshot; position: number; busy: boolean; command: (name: string) => void; previewSeek: (value: number) => void; seek: (value: number) => void; volume: (value: number) => void } = $props()
  const time = (ms: number) => `${Math.floor(ms / 60_000)}:${Math.floor((ms % 60_000) / 1_000).toString().padStart(2,"0")}`
</script>
<section class="now" aria-labelledby="now-title">
  {#if player.currentItem === null}
    <div class="art empty"><MusicNotes size={64} weight="duotone" aria-hidden="true" /></div><div class="nothing"><h1 id="now-title">Nothing is playing</h1><p>Search for a track and add it to the queue.</p></div>
  {:else}
    <h2 class="panel-title">Now playing</h2>
    <div class="art">{#if player.currentItem.track.artworkUrl}<Artwork src={player.currentItem.track.artworkUrl} alt={`Artwork for ${player.currentItem.track.title}`} priority />{:else}<MusicNotes size={64} weight="duotone" aria-hidden="true" />{/if}</div>
    <div class="meta" data-testid="current-track" data-track-id={player.currentItem.track.id}><p class="eyebrow">Now playing</p><h1 id="now-title" aria-label={player.currentItem.track.title}><TrackTitle title={player.currentItem.track.title} /></h1><p>{player.currentItem.track.artist}</p><div class="source-line"><p class="requested">Requested by {player.currentItem.requestedBy} · {player.currentItem.track.provider}</p>{#if player.bitrateKbps !== null && player.bitrateKbps !== undefined}<span class="quality" aria-label={`Source audio quality: ${player.bitrateKbps} kilobits per second`}><span>Source</span><strong>{player.bitrateKbps} kbps</strong></span>{/if}</div></div>
    <div class="seek" data-testid="seek-control"><Range label={time(position)} value={Math.round(position)} max={Math.max(1,player.currentItem.track.durationMs)} disabled={!player.seekable} showOutput={false} oninput={previewSeek} onchange={seek} /><span>{time(player.currentItem.track.durationMs)}</span>{#if !player.seekable}<small role="status">Seeking unavailable for this source.</small>{/if}</div>
    <Transport paused={player.isPaused} hasCurrent={true} {busy} loopMode={player.loopMode} {command} />
    <div class="volume"><SpeakerHigh size={22} aria-hidden="true" /><Range label="Volume" value={player.volume} max={200} oninput={volume} /></div>
  {/if}
</section>
<style>
  .now{min-block-size:0;overflow:visible;padding:calc(var(--space-8) + var(--space-1));display:grid;grid-auto-rows:max-content;align-content:start;gap:var(--space-4);background:var(--surface-primary)}.panel-title{inline-size:min(100%,var(--art-max));margin:0 auto var(--space-2);font-size:var(--type-h2)}.art{inline-size:min(100%,var(--art-max));aspect-ratio:var(--art-ratio);margin-inline:auto;display:grid;place-items:center;border-radius:var(--radius-surface);overflow:hidden;background:var(--surface-raised);color:var(--text-muted)}.meta,.nothing{inline-size:min(100%,var(--art-max));margin-inline:auto}.meta{margin-block-start:var(--space-3)}.meta h1{font-size:clamp(var(--type-h1),var(--type-fluid),var(--type-display));line-height:var(--line-tight);overflow-wrap:anywhere}.meta p{color:var(--text-secondary)}.eyebrow{text-transform:uppercase;font-size:var(--type-label);letter-spacing:var(--tracking-label)}.source-line{display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);margin-block-start:var(--space-2)}.requested{min-inline-size:0;margin:0;font-size:var(--type-compact)}.quality{flex:none;display:inline-flex;align-items:center;gap:var(--space-2);padding:var(--space-1) var(--space-2);border:var(--line-width) solid var(--line-subtle);border-radius:var(--radius-control);background:var(--surface-raised);color:var(--text-secondary);font-family:var(--font-mono);font-size:var(--type-label);letter-spacing:var(--tracking-label);text-transform:uppercase}.quality strong{color:var(--indigo-600);font-weight:600;letter-spacing:0;text-transform:none}.seek{inline-size:min(100%,var(--art-max));margin:var(--space-2) auto 0;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:var(--space-3);font-family:var(--font-mono);color:var(--text-secondary)}.seek small{grid-column:1/-1;color:var(--text-muted);font-family:var(--font-ui)}.volume{inline-size:min(100%,var(--art-max));margin:var(--space-2) auto 0;padding-block-start:var(--space-4);border-block-start:var(--line-width) solid var(--line-subtle);display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:var(--space-3)}
  @media(min-width:1024px){.meta>.eyebrow,.now>:global(.transport){display:none}}
  @media(min-width:2200px) and (min-height:1100px){.now{grid-template-rows:auto auto auto minmax(0,1fr) auto auto;align-content:stretch}.seek{grid-row:5}.volume{grid-row:6}}
  @media(max-width:1023px){.panel-title{display:none}.art{aspect-ratio:1}.now{padding:var(--space-5)}}
  @media(max-width:767px){.now{overflow:visible;gap:var(--space-2);padding:var(--space-1) var(--space-4) var(--space-2)}.art{inline-size:min(100%,var(--art-mobile))}.meta{position:relative}.meta,.seek{margin-block-start:0}.seek{font-family:var(--font-ui)}.source-line{position:absolute;inset-block-start:0;inset-inline-end:0;margin:0}.requested,.volume{display:none}.quality{padding-block:0}}
</style>
