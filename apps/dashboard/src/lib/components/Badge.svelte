<script lang="ts">
  import CheckCircle from "phosphor-svelte/lib/CheckCircle"
  import SpinnerGap from "phosphor-svelte/lib/SpinnerGap"
  import WarningCircle from "phosphor-svelte/lib/WarningCircle"
  import WifiSlash from "phosphor-svelte/lib/WifiSlash"
  let { status, label }: { status: "connected" | "reconnecting" | "disconnected" | "degraded"; label: string } = $props()
</script>

<span class="badge" class:success={status === "connected"} class:warning={status === "reconnecting" || status === "degraded"} class:error={status === "disconnected"} role="status" data-status={status}>
  {#if status === "connected"}<CheckCircle size={18} weight="fill" color="var(--status-success)" aria-hidden="true" />{:else if status === "reconnecting"}<SpinnerGap size={18} weight="bold" class="spin" aria-hidden="true" />{:else if status === "disconnected"}<WifiSlash size={18} weight="bold" aria-hidden="true" />{:else}<WarningCircle size={18} weight="fill" color="var(--status-warning)" aria-hidden="true" />{/if}
  {label}
</span>

<style>
  .badge { display: inline-flex; min-block-size: var(--target); align-items: center; gap: var(--space-2); color: var(--text-secondary); }
  .success { color: var(--status-success); } .warning { color: var(--status-warning); } .error { color: var(--status-error); }
  :global(.spin) { animation: spin var(--motion-standard) linear infinite; }
  @keyframes spin { to { transform: rotate(1turn); } }
  @media (prefers-reduced-motion: reduce) { :global(.spin) { animation: none; } }
</style>
