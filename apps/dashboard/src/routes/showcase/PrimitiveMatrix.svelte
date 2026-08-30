<script lang="ts">
  import PrimitivePreview from "./PrimitivePreview.svelte"
  import { notApplicableReason, primitiveIds, primitiveNames, showcaseStates } from "./state-model"
</script>

<div class="matrix" data-testid="primitive-state-matrix">
  {#each primitiveIds as primitive}
    <section class="primitive" aria-labelledby={`primitive-${primitive}`}>
      <header><p class="eyebrow">Reusable primitive</p><h2 id={`primitive-${primitive}`}>{primitiveNames[primitive]}</h2></header>
      <div class="state-grid">
        {#each showcaseStates as state}
          {@const reason = notApplicableReason(primitive, state)}
          <article data-matrix-cell={`${primitive}-${state}`} data-kind={reason === null ? "component" : "na"} class={`showcase-state is-${state}`}>
            <h3>{state}</h3>
            {#if reason === null}<PrimitivePreview {primitive} {state} />{:else}<p class="not-applicable">N/A — {reason}</p>{/if}
          </article>
        {/each}
      </div>
    </section>
  {/each}
</div>
<div id="matrix-end" tabindex="-1"></div>

<style>
  .matrix{display:grid;gap:var(--space-8)}.primitive{padding:var(--space-5);border-block-start:var(--line-width) solid var(--line-subtle);border-radius:var(--radius-surface);background:var(--surface-primary)}.primitive>header{padding:0 0 var(--space-4)}.state-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--space-3)}article{min-inline-size:0;padding:var(--space-3);border:var(--line-width) solid var(--line-subtle);border-radius:var(--radius-surface);background:var(--surface-recessed);overflow:hidden}article>h3{margin:0 0 var(--space-3);color:var(--text-secondary);font-size:var(--type-label);letter-spacing:var(--tracking-label);text-transform:uppercase}.not-applicable{min-block-size:calc(var(--space-12) * 2 + var(--space-4));display:grid;place-items:center;color:var(--text-muted);text-align:center}
  .is-disabled{opacity:.72}.is-loading{background:var(--indigo-050)}.is-empty{border-style:dashed}.is-error{border-color:var(--status-error)}
  @media(max-width:1023px){.state-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @media(max-width:767px){.primitive{padding:var(--space-4)}.state-grid{grid-template-columns:minmax(0,1fr)}}
</style>
