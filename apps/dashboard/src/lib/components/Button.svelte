<script lang="ts">
  import SpinnerGap from "phosphor-svelte/lib/SpinnerGap"

  let { label, variant = "secondary", disabled = false, loading = false, pressed = false, onclick }: {
    label: string
    variant?: "primary" | "secondary" | "danger"
    disabled?: boolean
    loading?: boolean
    pressed?: boolean
    onclick?: () => void
  } = $props()
</script>

<button class:primary={variant === "primary"} class:danger={variant === "danger"} class:pressed disabled={disabled || loading} aria-busy={loading} {onclick}>
  {#if loading}<span class="spinner"><SpinnerGap size={18} weight="bold" aria-hidden="true" /></span>{/if}
  {label}
</button>

<style>
  button { min-block-size: var(--target); padding-inline: var(--space-4); border: 0; border-radius: var(--radius-control); background: var(--surface-raised); color: var(--text-primary); font: inherit; font-weight: 600; transition: transform var(--motion-micro), background var(--motion-micro); }
  button:hover:not(:disabled) { background: var(--surface-hover); }
  button:active:not(:disabled), button.pressed { transform: scale(.98); }
  button.primary { background: var(--indigo-400); }
  button.danger { color: var(--status-error); }
  button:disabled { color: var(--text-muted); cursor: not-allowed; }
  .spinner { display: inline-grid; animation: spin var(--motion-standard) linear infinite; }
  @keyframes spin { to { transform: rotate(1turn); } }
  @media (prefers-reduced-motion: reduce) { button { transition: none; } button:active:not(:disabled), button.pressed { transform: none; } .spinner { animation: none; } }
</style>
