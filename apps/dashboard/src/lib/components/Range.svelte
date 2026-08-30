<script lang="ts">
  let { label, value = 50, max = 100, disabled = false, showOutput = true, oninput }: { label: string; value?: number; max?: number; disabled?: boolean; showOutput?: boolean; oninput?: (value: number) => void } = $props()
</script>

<label><span>{label}</span><input type="range" min="0" {max} {value} {disabled} aria-valuetext={`${value} of ${max}`} oninput={(event) => oninput?.(Number(event.currentTarget.value))} />{#if showOutput}<output>{value}</output>{/if}</label>

<style>
  label { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-3); color: var(--text-secondary); }
  input { min-block-size: var(--target); accent-color: var(--indigo-500); cursor: pointer; }
  input:active { transform: scaleY(1.08); } output { min-inline-size: var(--space-10); font-family: var(--font-mono); }
  @media (prefers-reduced-motion: reduce) { input:active { transform: none; } }
</style>
