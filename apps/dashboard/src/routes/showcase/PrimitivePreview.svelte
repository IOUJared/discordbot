<script lang="ts">
  import AppShellHarness from "./AppShellHarness.svelte"
  import BadgeHarness from "./BadgeHarness.svelte"
  import NowPlayingHarness from "./NowPlayingHarness.svelte"
  import QueueHarness from "./QueueHarness.svelte"
  import RangeHarness from "./RangeHarness.svelte"
  import RoomNavHarness from "./RoomNavHarness.svelte"
  import type { PrimitiveId, ShowcaseState } from "./state-model"
  import ToastHarness from "./ToastHarness.svelte"
  import TransportHarness from "./TransportHarness.svelte"

  let { primitive, state }: { primitive: PrimitiveId; state: ShowcaseState } = $props()
</script>

<div data-showcase-render data-primitive={primitive} class="preview" class:compact-nav={primitive === "room-navigation"} class:compact-queue={primitive === "queue"}>
  {#if primitive === "app-shell"}
    <AppShellHarness {state} />
  {:else if primitive === "room-navigation"}
    <RoomNavHarness {state} />
  {:else if primitive === "now-playing"}
    <NowPlayingHarness {state} />
  {:else if primitive === "transport"}
    <TransportHarness {state} />
  {:else if primitive === "range-control"}
    <RangeHarness {state} />
  {:else if primitive === "queue"}
    <QueueHarness {state} />
  {:else if primitive === "connection-badge"}
    <BadgeHarness {state} />
  {:else}
    <ToastHarness {state} />
  {/if}
</div>

<style>
  .preview{min-inline-size:0}.compact-nav{block-size:calc(var(--space-12) * 5 + var(--space-8));overflow:hidden}.compact-queue{block-size:var(--showcase-queue);overflow:hidden}
</style>
