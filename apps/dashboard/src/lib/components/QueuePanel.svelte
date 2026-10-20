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
  let scrollTop = $state(0)
  let scrollHeight = $state(1)
  let clientHeight = $state(1)
  const thumbSize = $derived(Math.min(100, clientHeight / scrollHeight * 100))
  const thumbOffset = $derived(scrollHeight <= clientHeight ? 0 : scrollTop / (scrollHeight - clientHeight) * (100 - thumbSize))
  const time = (ms: number): string => `${Math.floor(ms / 60_000)}:${Math.floor((ms % 60_000) / 1_000).toString().padStart(2,"0")}`
  const observeScroll = (node: HTMLDivElement): { destroy(): void } => {
    const update = (): void => {
      scrollTop = node.scrollTop
      scrollHeight = node.scrollHeight
      clientHeight = node.clientHeight
    }
    const resizeObserver = new ResizeObserver(update)
    const mutationObserver = new MutationObserver(update)
    resizeObserver.observe(node)
    mutationObserver.observe(node, { childList: true, subtree: true })
    node.addEventListener("scroll", update, { passive: true })
    queueMicrotask(update)
    return { destroy: () => { resizeObserver.disconnect(); mutationObserver.disconnect(); node.removeEventListener("scroll", update) } }
  }
  const drop = (event: DragEvent, index: number): void => {
    event.preventDefault()
    const sourceId = event.dataTransfer?.getData("text/plain") ?? ""
    const source = queue.find((item) => item.id === sourceId)
    if (source !== undefined) reorder?.(source, index)
  }
</script>
<section class="queue" aria-labelledby="queue-title">
  <header><h2 id="queue-title">Queue <span>{queue.length} items</span></h2><Button label="Clear" variant="danger" disabled={queue.length === 0} onclick={() => action("clear")} /></header>
  <div class="queue-scroll">
  <div class="queue-body" use:observeScroll>
    {#if error}<div class="error" role="alert" data-testid="queue-error">{error}</div>{/if}
    {#if queue.length === 0}<div class="empty"><MusicNotes size={40} weight="duotone" aria-hidden="true" /><strong>No requests</strong><span>Search for a track to add one.</span></div>{:else}
      <ol>{#each queue as item,index (item.id)}<li class:active={index === 0} class:pending={pendingId === item.id} data-queue-id={item.id} draggable="true" ondragstart={(event) => event.dataTransfer?.setData("text/plain",item.id)} ondragover={(event) => event.preventDefault()} ondrop={(event) => drop(event,index)}><div class="position"><DotsSixVertical size={18} aria-hidden="true" /><span>{index+1}</span></div><div class="track"><strong title={item.track.title}>{item.track.title}</strong><span>{item.track.artist}</span></div>{#if index === 0}<span class="row-play"><Play size={18} weight="fill" aria-hidden="true" /></span>{/if}<span class="duration">{time(item.track.durationMs)}</span><details><summary aria-label={`Queue actions for ${item.track.title}`}><DotsThreeVertical size={20} weight="bold" aria-hidden="true" /></summary><div class="actions"><IconButton label={`Move ${item.track.title} up`} disabled={index === 0 || pendingId !== null} onclick={() => action("up",item,index)}><ArrowUp size={18} weight="bold" aria-hidden="true" /></IconButton><IconButton label={`Move ${item.track.title} down`} disabled={index === queue.length-1 || pendingId !== null} onclick={() => action("down",item,index)}><ArrowDown size={18} weight="bold" aria-hidden="true" /></IconButton><IconButton label={`Play ${item.track.title} next`} onclick={() => action("next",item,index)}><SkipForward size={18} weight="fill" aria-hidden="true" /></IconButton><IconButton label={`Play ${item.track.title} now`} onclick={() => action("play",item,index)}><Play size={18} weight="fill" aria-hidden="true" /></IconButton><IconButton label={`Remove ${item.track.title}`} onclick={() => action("remove",item,index)}><Trash size={18} weight="bold" aria-hidden="true" /></IconButton></div></details></li>{/each}</ol>
      <div class="queue-dock"><MusicNotes size={40} weight="duotone" aria-hidden="true" /><strong>Request dock</strong><span>Search or paste a link to line up another track.</span></div>
    {/if}
  </div><div class="scroll-track" class:hidden={scrollHeight <= clientHeight} aria-hidden="true"><span style={`block-size:${thumbSize}%;inset-block-start:${thumbOffset}%`}></span></div></div>
</section>
<style>
  .queue{min-block-size:0;block-size:100%;display:grid;grid-template-rows:auto minmax(0,1fr);background:linear-gradient(180deg,rgba(31,29,46,.72),rgba(22,20,31,.92));border-inline-start:var(--line-width) solid var(--hairline)}
  header{min-block-size:calc(var(--space-10) + var(--space-12));display:flex;align-items:center;justify-content:space-between;padding:var(--space-5);border-block-end:var(--line-width) solid var(--hairline)}
  h2{margin:0;font-size:var(--type-h2);display:flex;align-items:center;gap:var(--space-2);letter-spacing:-.02em}
  h2 span{display:inline-flex;align-items:center;padding:2px var(--space-2);border-radius:999px;background:var(--surface-raised);color:var(--text-secondary);font-family:var(--font-mono);font-size:var(--type-label);letter-spacing:0}
  .queue-scroll{min-block-size:0;position:relative}
  .queue-body{block-size:100%;min-block-size:0;overflow:auto;scrollbar-gutter:stable;scrollbar-color:var(--line-strong) transparent}
  .queue-body::-webkit-scrollbar{inline-size:var(--space-2)}
  .queue-body::-webkit-scrollbar-track{background:transparent}
  .queue-body::-webkit-scrollbar-thumb{border-radius:999px;background:var(--line-strong)}
  .scroll-track{position:absolute;inset-block:var(--space-2);inset-inline-end:var(--space-1);inline-size:var(--space-1);border-radius:999px;background:rgba(224,222,244,.05);pointer-events:none}
  .scroll-track.hidden{display:none}
  .scroll-track span{position:absolute;inset-inline:0;border-radius:inherit;background:var(--line-strong)}
  ol{margin:0;padding:var(--space-2);list-style:none;display:grid;gap:2px}
  li{display:grid;grid-template-columns:var(--space-10) minmax(0,1fr) var(--space-5) var(--space-10) var(--target);align-items:center;gap:var(--space-2);min-block-size:var(--queue-row);padding:var(--space-2) var(--space-3);border:0;border-radius:var(--radius-control);transition:background var(--motion-micro)}
  li:hover{background:rgba(224,222,244,.04)}
  li.active{background:linear-gradient(90deg,rgba(196,167,231,.16),rgba(196,167,231,.04));box-shadow:inset 2px 0 0 var(--indigo-500)}
  li[draggable="true"]{cursor:grab}
  li[draggable="true"]:active{cursor:grabbing}
  li.pending{opacity:.55;background:rgba(196,167,231,.08)}
  .position{display:grid;grid-template-columns:auto auto;align-items:center;gap:var(--space-1);color:var(--text-muted);font-family:var(--font-mono);font-size:var(--type-label)}
  .track{min-inline-size:0;display:grid;gap:1px}
  .track strong,.track span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .track strong{font-weight:500;color:var(--text-primary)}
  .track span,.duration{color:var(--text-secondary)}
  .duration{font-family:var(--font-mono);font-size:var(--type-label)}
  .row-play{color:var(--indigo-500);display:grid;place-items:center}
  details{position:relative}
  summary{inline-size:var(--target);block-size:var(--target);display:grid;place-items:center;color:var(--text-muted);cursor:pointer;list-style:none;border-radius:999px}
  summary:hover{background:var(--surface-hover);color:var(--text-primary)}
  summary::-webkit-details-marker{display:none}
  .actions{position:absolute;z-index:3;inset-block-start:100%;inset-inline-end:0;display:flex;gap:2px;padding:var(--space-1);border:var(--line-width) solid var(--hairline);border-radius:var(--radius-control);background:var(--glass-strong);backdrop-filter:blur(16px);box-shadow:var(--shadow-dialog)}
  .empty,.queue-dock{display:grid;gap:var(--space-2);padding:var(--space-6);color:var(--text-muted)}
  .empty{min-block-size:100%;place-items:center;align-content:center;text-align:center}
  .queue-dock{grid-template-columns:auto minmax(0,1fr);align-items:center;margin:var(--space-6);padding:var(--space-4);border:var(--line-width) dashed var(--line-strong);background:transparent;border-radius:var(--radius-surface)}
  .queue-dock :global(svg){grid-row:1/3}
  .queue-dock strong,.queue-dock span{text-align:start}
  .queue-dock strong{color:var(--text-secondary);font-weight:600}
  .queue-dock span{grid-column:2;font-size:var(--type-compact)}
  .error{padding:var(--space-3);margin:var(--space-3) var(--space-2) 0;color:var(--status-error);background:rgba(235,111,146,.1);border-radius:var(--radius-control);font-size:var(--type-compact)}
  @media(max-width:1023px){.queue{border-inline-start:0}.queue-dock{display:none}.actions{position:fixed;z-index:8;inset:auto var(--space-4) var(--space-4);justify-content:center;padding:var(--space-2)}}
  @media(max-width:480px){li{grid-template-columns:var(--space-8) minmax(0,1fr) var(--space-10) var(--target)}h2 span,.position,.duration{font-family:var(--font-ui)}.row-play{display:none}.duration{font-size:var(--type-label)}}
</style>
