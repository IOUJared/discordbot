<script lang="ts">
  let { label, value = 50, max = 100, disabled = false, showOutput = true, oninput, onchange }: { label: string; value?: number; max?: number; disabled?: boolean; showOutput?: boolean; oninput?: (value: number) => void; onchange?: (value: number) => void } = $props()
  const fill = $derived(Math.max(0, Math.min(100, Math.round((value / Math.max(1, max)) * 100))))
</script>

<label><span>{label}</span><input type="range" min="0" {max} {value} {disabled} style={`--fill:${fill}%`} aria-valuetext={`${value} of ${max}`} oninput={(event) => oninput?.(Number(event.currentTarget.value))} onchange={(event) => onchange?.(Number(event.currentTarget.value))} />{#if showOutput}<output>{value}</output>{/if}</label>

<style>
  label { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-3); color: var(--text-secondary); }
  input { -webkit-appearance: none; appearance: none; inline-size: 100%; min-block-size: var(--target); background: transparent; cursor: pointer; }
  input::-webkit-slider-runnable-track { block-size: 6px; border-radius: 999px; background: linear-gradient(to right, var(--indigo-500) 0 var(--fill), rgba(224, 222, 244, .16) var(--fill) 100%); }
  input::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; inline-size: 14px; block-size: 14px; margin-block-start: -4px; border: 0; border-radius: 50%; background: var(--text-primary); box-shadow: 0 2px 6px rgba(0, 0, 0, .55); transition: transform var(--motion-micro); }
  input:hover:not(:disabled)::-webkit-slider-thumb { transform: scale(1.15); }
  input::-moz-range-track { block-size: 6px; border-radius: 999px; background: rgba(224, 222, 244, .16); }
  input::-moz-range-progress { block-size: 6px; border-radius: 999px; background: var(--indigo-500); }
  input::-moz-range-thumb { inline-size: 14px; block-size: 14px; border: 0; border-radius: 50%; background: var(--text-primary); box-shadow: 0 2px 6px rgba(0, 0, 0, .55); }
  input:disabled { cursor: not-allowed; opacity: .45; }
  output { min-inline-size: var(--space-10); font-family: var(--font-mono); font-size: var(--type-compact); color: var(--text-secondary); }
  @media (prefers-reduced-motion: reduce) { input::-webkit-slider-thumb { transition: none; } input:hover:not(:disabled)::-webkit-slider-thumb { transform: none; } }
</style>
