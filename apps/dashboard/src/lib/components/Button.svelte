<script lang="ts">
  import SpinnerGap from "phosphor-svelte/lib/SpinnerGap"

  let { label, ariaLabel, variant = "secondary", disabled = false, loading = false, pressed = false, onclick }: {
    label: string
    ariaLabel?: string
    variant?: "primary" | "secondary" | "danger"
    disabled?: boolean
    loading?: boolean
    pressed?: boolean
    onclick?: () => void
  } = $props()
</script>

<button class:primary={variant === "primary"} class:danger={variant === "danger"} class:pressed disabled={disabled || loading} aria-busy={loading} aria-label={ariaLabel} {onclick}>
  {#if loading}<span class="spinner"><SpinnerGap size={18} weight="bold" aria-hidden="true" /></span>{/if}
  {label}
</button>

<style>
  button { min-block-size: var(--target); display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2); padding-inline: var(--space-4); border: 0; border-radius: 999px; background: var(--surface-raised); color: var(--text-primary); font: inherit; font-weight: 600; letter-spacing: -.01em; transition: transform var(--motion-micro), background var(--motion-micro), box-shadow var(--motion-micro); }
  button:hover:not(:disabled) { background: var(--surface-hover); }
  button:active:not(:disabled), button.pressed { transform: scale(.98); }
  button.primary { background: var(--indigo-500); color: var(--surface-canvas); box-shadow: 0 8px 22px rgba(196, 167, 231, .22); }
  button.primary:hover:not(:disabled) { background: var(--indigo-600); box-shadow: 0 10px 26px rgba(196, 167, 231, .3); }
  button.danger { color: var(--status-error); background: transparent; box-shadow: inset 0 0 0 1px rgba(235, 111, 146, .3); }
  button.danger:hover:not(:disabled) { background: rgba(235, 111, 146, .14); box-shadow: inset 0 0 0 1px rgba(235, 111, 146, .45); }
  button:disabled { color: var(--text-muted); cursor: not-allowed; background: var(--surface-primary); box-shadow: none; }
  .spinner { display: inline-grid; animation: spin var(--motion-standard) linear infinite; }
  @keyframes spin { to { transform: rotate(1turn); } }
  @media (prefers-reduced-motion: reduce) { button { transition: none; } button:active:not(:disabled), button.pressed { transform: none; } .spinner { animation: none; } }
</style>
