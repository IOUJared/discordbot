<script lang="ts">
  import type { MediaProviderSettings, MediaSourcePreference } from "@discord-music/contracts"
  import Badge from "./Badge.svelte"
  import Button from "./Button.svelte"

  let {
    settings,
    busy,
    error,
    onpreference,
    onconnection,
  }: {
    settings: MediaProviderSettings
    busy: boolean
    error: string | null
    onpreference: (preference: MediaSourcePreference) => void
    onconnection: (connect: boolean) => void
  } = $props()
</script>

<section class="provider-settings" aria-labelledby="provider-settings-title" data-testid="provider-settings">
  <header>
    <p class="eyebrow">Playback sources</p>
    <h1 id="provider-settings-title">Source priority</h1>
    <p>Choose where searches look first. YouTube remains the fallback for tracks outside the simulator catalog.</p>
  </header>

  <div class="provider-card">
    <div class="provider-heading">
      <div>
        <strong>Mock TIDAL</strong>
        <span>Local classroom simulator</span>
      </div>
      <Badge
        status={settings.mockTidalConnected ? "connected" : "degraded"}
        label={settings.mockTidalConnected ? "Simulator connected" : "Simulator off · YouTube active"}
      />
    </div>
    <p class="detail">Generates local lossless WAV audio at 48 kHz. It does not use a TIDAL account, API key, password, or network service.</p>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <Button
      label={settings.mockTidalConnected ? "Disconnect simulator" : "Connect simulator"}
      variant={settings.mockTidalConnected ? "secondary" : "primary"}
      loading={busy}
      onclick={() => onconnection(!settings.mockTidalConnected)}
    />
  </div>

  <fieldset disabled={busy}>
    <legend>Search priority</legend>
    <label>
      <input
        type="radio"
        name="source-priority"
        value="mock_tidal_first"
        checked={settings.preference === "mock_tidal_first"}
        onchange={() => onpreference("mock_tidal_first")}
      />
      <span><strong>Mock TIDAL first</strong><small>Use local lossless fixtures when available, then YouTube.</small></span>
    </label>
    <label>
      <input
        type="radio"
        name="source-priority"
        value="youtube_only"
        checked={settings.preference === "youtube_only"}
        onchange={() => onpreference("youtube_only")}
      />
      <span><strong>YouTube only</strong><small>Skip the simulator and search through <span class="nowrap">yt-dlp</span>.</small></span>
    </label>
  </fieldset>
</section>

<style>
  .provider-settings{inline-size:min(100%,var(--panel-max));margin:var(--space-12) auto;display:grid;gap:var(--space-6);padding:var(--space-6);border:0;background:transparent}.provider-settings header{display:grid;gap:var(--space-2)}header>p:last-child,.detail,small,.provider-heading span{color:var(--text-secondary)}.provider-card,fieldset{display:grid;gap:var(--space-4);padding:var(--space-5);border:var(--line-width) solid var(--line-subtle);border-radius:var(--radius-surface);background:var(--surface-recessed)}.provider-heading{display:flex;align-items:center;justify-content:space-between;gap:var(--space-4)}.provider-heading>div{display:grid;gap:var(--space-1)}.provider-card :global(button){justify-self:start}fieldset{margin:0}legend{padding-inline:var(--space-2);font-weight:600}fieldset label{min-block-size:var(--target);display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:var(--space-3);padding:var(--space-3);border-radius:var(--radius-control);background:var(--surface-raised);cursor:pointer}fieldset label:hover{background:var(--surface-hover)}fieldset input{inline-size:20px;block-size:20px;accent-color:var(--indigo-500)}fieldset>label>span{display:grid;gap:var(--space-1)}.nowrap{white-space:nowrap}.error{color:var(--status-error)}
  @media(max-width:767px){.provider-settings{margin:0;padding:var(--space-4)}.provider-card,fieldset{padding:var(--space-4)}.provider-heading{align-items:start;display:grid}}
</style>
