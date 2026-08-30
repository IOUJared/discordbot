<script lang="ts">
  import type { QueueItem } from "@discord-music/contracts"
  import ArrowDown from "phosphor-svelte/lib/ArrowDown"
  import ArrowUp from "phosphor-svelte/lib/ArrowUp"
  import DotsSixVertical from "phosphor-svelte/lib/DotsSixVertical"
  import DotsThreeVertical from "phosphor-svelte/lib/DotsThreeVertical"
  import MusicNotes from "phosphor-svelte/lib/MusicNotes"
  import Play from "phosphor-svelte/lib/Play"
  import SkipForward from "phosphor-svelte/lib/SkipForward"
  import Trash from "phosphor-svelte/lib/Trash"
  import Button from "./Button.svelte"
  import IconButton from "./IconButton.svelte"
  let { queue, pendingId = null, error = null, action, reorder }: { queue: readonly QueueItem[]; pendingId?: string | null; error?: string | null; action: (name: "up"|"down"|"next"|"play"|"remove"|"clear", item?: QueueItem, index?: number) => void; reorder?: (item: QueueItem, index: number) => void } = $props()
  const time = (ms: number): string => `${Math.floor(ms / 60_000)}:${Math.floor((ms % 60_000) / 1_000).toString().padStart(2,"0")}`
  const drop = (event: DragEvent, index: number): void => {
    event.preventDefault()
    const sourceId = event.dataTransfer?.getData("text/plain") ?? ""
    const source = queue.find((item) => item.id === sourceId)
    if (source !== undefined) reorder?.(source, index)
  }
</script>
<section class="queue" aria-labelledby="queue-title">
  <header><h2 id="queue-title">Queue <span>{queue.length} items</span></h2><Button label="Clear" variant="danger" disabled={queue.length === 0} onclick={() => action("clear")} /></header>
  <div class="queue-body">
    {#if error}<div class="error" role="alert" data-testid="queue-error">{error}</div>{/if}
    {#if queue.length === 0}<div class="empty"><MusicNotes size={40} weight="duotone" aria-hidden="true" /><strong>No requests</strong><span>Search for a track to add one.</span></div>{:else}
      <ol>{#each queue as item,index (item.id)}<li class:active={index === 0} class:pending={pendingId === item.id} data-queue-id={item.id} draggable="true" ondragstart={(event) => event.dataTransfer?.setData("text/plain",item.id)} ondragover={(event) => event.preventDefault()} ondrop={(event) => drop(event,index)}><div class="position"><DotsSixVertical size={18} aria-hidden="true" /><span>{index+1}</span></div><div class="track"><strong title={item.track.title}>{item.track.title}</strong><span>{item.track.artist}</span></div>{#if index === 0}<span class="row-play"><Play size={18} weight="fill" aria-hidden="true" /></span>{/if}<span class="duration">{time(item.track.durationMs)}</span><details><summary aria-label={`Queue actions for ${item.track.title}`}><DotsThreeVertical size={20} weight="bold" aria-hidden="true" /></summary><div class="actions"><IconButton label={`Move ${item.track.title} up`} disabled={index === 0 || pendingId !== null} onclick={() => action("up",item,index)}><ArrowUp size={18} weight="bold" aria-hidden="true" /></IconButton><IconButton label={`Move ${item.track.title} down`} disabled={index === queue.length-1 || pendingId !== null} onclick={() => action("down",item,index)}><ArrowDown size={18} weight="bold" aria-hidden="true" /></IconButton><IconButton label={`Play ${item.track.title} next`} onclick={() => action("next",item,index)}><SkipForward size={18} weight="fill" aria-hidden="true" /></IconButton><IconButton label={`Play ${item.track.title} now`} onclick={() => action("play",item,index)}><Play size={18} weight="fill" aria-hidden="true" /></IconButton><IconButton label={`Remove ${item.track.title}`} onclick={() => action("remove",item,index)}><Trash size={18} weight="bold" aria-hidden="true" /></IconButton></div></details></li>{/each}</ol>
      <div class="queue-dock"><MusicNotes size={40} weight="duotone" aria-hidden="true" /><strong>Request dock</strong><span>Search or paste a link to line up another track.</span></div>
    {/if}
  </div>
</section>
<style>
  .queue{min-block-size:0;display:grid;grid-template-rows:auto minmax(0,1fr);background:var(--surface-recessed);border-inline-start:var(--line-width) solid var(--line-subtle)}header{min-block-size:calc(var(--space-10) + var(--space-12));display:flex;align-items:center;justify-content:space-between;padding:var(--space-5);border-block-end:var(--line-width) solid var(--line-subtle)}h2{margin:0;font-size:var(--type-h2)}h2 span{color:var(--text-muted);font-family:var(--font-mono);font-size:var(--type-label)}.queue-body{min-block-size:0;overflow:auto}ol{margin:0;padding:0;list-style:none}li{display:grid;grid-template-columns:var(--space-10) minmax(0,1fr) var(--space-5) var(--space-10) var(--target);align-items:center;gap:var(--space-2);min-block-size:var(--queue-row);padding:var(--space-2) var(--space-4);border-block-end:var(--line-width) solid var(--line-subtle)}li.active{background:var(--indigo-050)}li[draggable="true"]{cursor:grab}li[draggable="true"]:active{cursor:grabbing}li.pending{opacity:.6;background:var(--indigo-050)}.position{display:grid;grid-template-columns:auto auto;align-items:center;gap:var(--space-1);color:var(--text-muted);font-family:var(--font-mono)}.track{min-inline-size:0;display:grid}.track strong,.track span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.track span,.duration{color:var(--text-secondary)}.duration{font-family:var(--font-mono);font-size:var(--type-label)}.row-play{color:var(--indigo-500)}details{position:relative}summary{inline-size:var(--target);block-size:var(--target);display:grid;place-items:center;color:var(--text-secondary);cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}.actions{position:absolute;z-index:3;inset-block-start:100%;inset-inline-end:0;display:flex;gap:var(--space-1);padding:var(--space-1);border:var(--line-width) solid var(--line-subtle);border-radius:var(--radius-control);background:var(--surface-raised)}.empty,.queue-dock{display:grid;gap:var(--space-2);padding:var(--space-6);color:var(--text-muted)}.empty{min-block-size:100%;place-items:center;align-content:center;text-align:center}.queue-dock{grid-template-columns:auto minmax(0,1fr);align-items:center;margin:var(--space-6);padding:var(--space-4);border-block-start:var(--line-width) solid var(--line-subtle);background:var(--surface-primary);border-radius:var(--radius-surface)}.queue-dock :global(svg){grid-row:1/3}.queue-dock strong,.queue-dock span{text-align:start}.queue-dock span{grid-column:2}.error{padding:var(--space-3);color:var(--status-error);background:var(--surface-raised)}
  @media(max-width:1023px){.queue{border-inline-start:0}.queue-dock{display:none}.actions{position:fixed;z-index:8;inset:auto var(--space-4) var(--space-4);justify-content:center;padding:var(--space-2)}}
  @media(max-width:480px){li{grid-template-columns:var(--space-8) minmax(0,1fr) var(--space-10) var(--target)}h2 span,.position,.duration{font-family:var(--font-ui)}.row-play{display:none}.duration{font-size:var(--type-label)}}
</style>
