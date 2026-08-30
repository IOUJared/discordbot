<script lang="ts">
  import type { Snippet } from "svelte"
  let { label, active = false, disabled = false, loading = false, onclick, children }: { label: string; active?: boolean; disabled?: boolean; loading?: boolean; onclick?: () => void; children: Snippet } = $props()
</script>

<button aria-label={label} aria-pressed={active} aria-busy={loading} {disabled} {onclick} title={disabled ? `${label} unavailable` : label}>{@render children()}</button>

<style>
  button { display:grid; place-items:center; inline-size:var(--target); block-size:var(--target); border:0; border-radius:var(--radius-control); background:transparent; color:var(--text-secondary); transition:transform var(--motion-micro),background var(--motion-micro); }
  button:hover:not(:disabled) { background:var(--surface-hover); color:var(--text-primary); } button:active:not(:disabled) { transform:scale(.96); } button[aria-pressed="true"] { color:var(--indigo-500); background:var(--indigo-100); } button:disabled { color:var(--text-muted); cursor:not-allowed; }
  @media(prefers-reduced-motion:reduce){button{transition:none}button:active:not(:disabled){transform:none}}
</style>
