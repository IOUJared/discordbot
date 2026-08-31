<script lang="ts">
  import type { SearchResult, YouTubePlaylist } from "@discord-music/contracts"
  import MagnifyingGlass from "phosphor-svelte/lib/MagnifyingGlass"
  import MusicNotes from "phosphor-svelte/lib/MusicNotes"
  import Plus from "phosphor-svelte/lib/Plus"
  import SkipForward from "phosphor-svelte/lib/SkipForward"
  import Button from "./Button.svelte"

  let {
    results,
    loading,
    error,
    onsearch,
    onadd,
    playlist,
    importing,
    importedCount,
    onimport,
  }: {
    results: readonly SearchResult[]
    loading: boolean
    error: string | null
    onsearch: (query: string) => void
    onadd: (result: SearchResult, next: boolean) => void
    playlist: YouTubePlaylist | null
    importing: boolean
    importedCount: number | null
    onimport: () => void
  } = $props()

  let query = $state("")
  let hasSearched = $state(false)
  let visibleCount = $state(3)
  const visibleResults = $derived(results.slice(0, visibleCount))

  const duration = (durationMs: number): string =>
    `${Math.floor(durationMs / 60_000)}:${Math.floor((durationMs % 60_000) / 1_000)
      .toString()
      .padStart(2, "0")}`

  function submit(): void {
    hasSearched = true
    visibleCount = 3
    onsearch(query)
  }
</script>

<section class="search" aria-labelledby="search-title" aria-busy={loading}>
  <header>
    <p class="eyebrow">Request a track</p>
    <h2 id="search-title">Find your next track</h2>
    <p class="intro">Preview the artwork and details before adding it to the room.</p>
  </header>

  {#if error}<p class="error" role="alert">{error}</p>{/if}

  <form
    onsubmit={(event) => {
      event.preventDefault()
      submit()
    }}
  >
    <label>
      <span class="sr-only">Song, artist, or YouTube link</span>
      <MagnifyingGlass size={20} aria-hidden="true" />
      <input bind:value={query} placeholder="Song, artist, or YouTube link" required />
    </label>
    <Button label="Search" variant="primary" {loading} />
  </form>

  {#if loading}
    <div class="loading-results" role="status" aria-label="Searching for tracks">
      {#each [0, 1, 2] as row}
        <div class="result-skeleton" aria-hidden="true" data-row={row}>
          <span class="skeleton-art"></span>
          <span class="skeleton-copy"><i></i><i></i><i></i></span>
        </div>
      {/each}
    </div>
  {:else if playlist !== null}
    <article class="playlist" data-testid="playlist-preview" aria-labelledby="playlist-title">
      <div class="playlist-head">
        <div class="playlist-art">
          {#if playlist.artworkUrl}<img src={playlist.artworkUrl} alt="" width="72" height="72" />{:else}<MusicNotes size={30} weight="duotone" aria-hidden="true" />{/if}
        </div>
        <div class="playlist-copy">
          <span class="playlist-label">YouTube playlist</span>
          <h3 id="playlist-title">{playlist.title}</h3>
          <span>{playlist.author} · {playlist.tracks.length} {playlist.tracks.length === 1 ? "video" : "videos"}</span>
        </div>
      </div>
      <ol>
        {#each playlist.tracks.slice(0, 3) as track, index (track.id)}
          <li><span class="playlist-index">{index + 1}</span><span><strong title={track.title}>{track.title}</strong><small>{track.artist}</small></span><time>{duration(track.durationMs)}</time></li>
        {/each}
      </ol>
      {#if playlist.tracks.length > 3}<p class="playlist-more">+ {playlist.tracks.length - 3} more videos will be added in order</p>{/if}
      <Button label={importedCount === null ? `Add all ${playlist.tracks.length} to queue` : `Added ${importedCount} to queue`} ariaLabel={importedCount === null ? `Add all ${playlist.tracks.length} videos from ${playlist.title} to queue` : `Added ${importedCount} videos from ${playlist.title} to queue`} variant="primary" loading={importing} disabled={importedCount !== null} onclick={onimport} />
    </article>
  {:else if results.length > 0}
    <div class="result-summary" aria-live="polite">
      <span>Search results</span>
      <strong>
        {visibleResults.length < results.length ? `${visibleResults.length} of ` : ""}{results.length}
        {results.length === 1 ? "match" : "matches"}
      </strong>
    </div>
    <ul>
      {#each visibleResults as result, index (result.track.id)}
        <li data-testid="search-result" data-track-id={result.track.id}>
          <div class="result-art">
            {#if result.track.artworkUrl}
              <img
                src={result.track.artworkUrl}
                alt={`Artwork for ${result.track.title}`}
                width="72"
                height="72"
                loading="lazy"
                decoding="async"
              />
            {:else}
              <MusicNotes size={28} weight="duotone" aria-hidden="true" />
            {/if}
          </div>
          <div class="result-copy">
            <div class="result-heading">
              <strong title={result.track.title}>{result.track.title}</strong>
              {#if index === 0}<span class="best">Highest quality</span>{/if}
            </div>
            <span class="artist" title={result.track.artist}>{result.track.artist}</span>
            <div class="metadata">
              <span>{duration(result.track.durationMs)}</span>
              <span>YouTube</span>
              <span>{result.bitrateKbps === null ? "Bitrate unavailable" : `${result.bitrateKbps} kbps`}</span>
            </div>
          </div>
          <div class="result-actions">
            <button
              class="add"
              type="button"
              aria-label={`Add ${result.track.title} to queue`}
              onclick={() => onadd(result, false)}
            >
              <Plus size={18} weight="bold" aria-hidden="true" />
              <span>Add to queue</span>
            </button>
            <button
              type="button"
              aria-label={`Play ${result.track.title} next`}
              onclick={() => onadd(result, true)}
            >
              <SkipForward size={18} weight="fill" aria-hidden="true" />
              <span>Play next</span>
            </button>
          </div>
        </li>
      {/each}
    </ul>
    {#if visibleResults.length < results.length}
      <div class="search-more">
        <Button
          label="Search more"
          onclick={() => {
            visibleCount = Math.min(visibleCount + 3, results.length)
          }}
        />
      </div>
    {/if}
  {:else if hasSearched && error === null}
    <div class="empty">
      <MagnifyingGlass size={28} aria-hidden="true" />
      <div><strong>No matches found</strong><span>Try a song title with the artist name.</span></div>
    </div>
  {:else}
    <div class="empty">
      <MusicNotes size={28} weight="duotone" aria-hidden="true" />
      <div><strong>Ready for requests</strong><span>Search by song, artist, or YouTube link.</span></div>
    </div>
  {/if}
</section>

<style>
  .search{inline-size:min(100%,var(--panel-max));margin-inline:auto;display:grid;align-content:start;gap:var(--space-4);padding:var(--space-5);background:var(--surface-recessed);border-radius:var(--radius-surface)}
  header{display:grid;gap:var(--space-1);padding:0}.eyebrow{text-transform:uppercase;font-size:var(--type-label);letter-spacing:var(--tracking-label);color:var(--text-muted)}h2{margin:0}.intro{color:var(--text-secondary);font-size:var(--type-compact)}
  form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--space-2)}label{min-block-size:var(--target);display:flex;align-items:center;gap:var(--space-2);padding-inline:var(--space-3);background:var(--surface-raised);border-radius:var(--radius-control)}input{min-inline-size:0;inline-size:100%;border:0;outline:0;background:transparent;color:var(--text-primary)}
  .result-summary{display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);padding-block-start:var(--space-1);color:var(--text-muted);font-size:var(--type-label);text-transform:uppercase;letter-spacing:var(--tracking-label)}.result-summary strong{color:var(--text-secondary);font-family:var(--font-mono);letter-spacing:0;text-transform:none}
  ul{display:grid;gap:var(--space-3);list-style:none;padding:0;margin:0}li{min-inline-size:0;display:grid;grid-template-columns:var(--result-art,var(--search-art)) minmax(0,1fr);grid-template-areas:"art copy" "art actions";align-items:start;gap:var(--space-3);padding:var(--space-3);border:0;border-radius:var(--radius-surface);background:var(--surface-primary)}
  .result-art{grid-area:art;inline-size:var(--result-art,var(--search-art));block-size:var(--result-art,var(--search-art));display:grid;place-items:center;overflow:hidden;border-radius:var(--radius-control);background:var(--surface-raised);color:var(--text-muted)}.result-art img{inline-size:100%;block-size:100%;display:block;object-fit:cover}
  .result-copy{grid-area:copy;min-inline-size:0;display:grid;align-content:start;gap:var(--space-1)}.result-heading{min-inline-size:0;display:flex;align-items:center;gap:var(--space-2)}.result-heading strong,.artist{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.result-heading strong{min-inline-size:0}.artist{color:var(--text-secondary)}.best{flex:none;padding:var(--space-1) var(--space-2);border-radius:var(--radius-control);background:var(--indigo-100);color:var(--indigo-600);font-size:var(--type-label)}.metadata{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2);color:var(--text-muted);font-family:var(--font-mono);font-size:var(--type-label)}.metadata span{display:inline;white-space:nowrap}.metadata span+span::before{content:"•";margin-inline-end:var(--space-2)}
  .result-actions{grid-area:actions;display:flex;flex-wrap:wrap;gap:var(--space-2)}.result-actions button{min-inline-size:0;min-block-size:var(--target);display:flex;align-items:center;justify-content:center;gap:var(--space-2);padding-inline:var(--space-3);border:0;border-radius:var(--radius-control);background:var(--surface-raised);color:var(--text-secondary)}.result-actions button:hover{background:var(--surface-hover);color:var(--text-primary)}.result-actions .add{background:var(--indigo-300);color:var(--text-primary)}.result-actions .add:hover{background:var(--indigo-400)}
  .search-more{display:grid}
  .playlist{display:grid;gap:var(--space-3);padding:var(--space-4);background:var(--surface-primary);border-radius:var(--radius-surface)}.playlist-head{display:grid;grid-template-columns:var(--search-art) minmax(0,1fr);align-items:center;gap:var(--space-3)}.playlist-art{inline-size:var(--search-art);block-size:var(--search-art);display:grid;place-items:center;overflow:hidden;border-radius:var(--radius-control);background:var(--surface-raised);color:var(--text-muted)}.playlist-art img{inline-size:100%;block-size:100%;object-fit:cover}.playlist-copy{min-inline-size:0;display:grid;gap:var(--space-1)}.playlist-copy h3{margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.playlist-copy>span:last-child,.playlist-more{color:var(--text-secondary)}.playlist-label{color:var(--indigo-600);font-size:var(--type-label);font-weight:600;text-transform:uppercase;letter-spacing:var(--tracking-label)}.playlist ol{display:grid;gap:0;margin:0;padding:0;list-style:none;border-block:var(--line-width) solid var(--line-subtle)}.playlist li{display:grid;grid-template-columns:var(--space-6) minmax(0,1fr) auto;align-items:center;gap:var(--space-2);min-block-size:var(--target);padding-block:var(--space-2);background:transparent;border-radius:0;border-block-end:var(--line-width) solid var(--line-subtle)}.playlist li:last-child{border-block-end:0}.playlist li>span:nth-child(2){min-inline-size:0;display:grid}.playlist li strong,.playlist li small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.playlist li small,.playlist li time,.playlist-index{color:var(--text-muted);font-size:var(--type-label)}.playlist li time,.playlist-index{font-family:var(--font-mono)}.playlist-more{margin:0;font-size:var(--type-compact)}
  .empty{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:var(--space-3);min-block-size:calc(var(--space-12) + var(--space-4));padding:var(--space-4);background:var(--surface-primary);border-radius:var(--radius-control);color:var(--text-muted)}.empty div{min-inline-size:0;display:grid;gap:var(--space-1)}.empty strong{color:var(--text-secondary)}.empty span{overflow-wrap:anywhere}
  .loading-results{display:grid;gap:var(--space-3)}.result-skeleton{display:grid;grid-template-columns:var(--result-art,var(--search-art)) minmax(0,1fr);gap:var(--space-3);padding:var(--space-3);background:var(--surface-primary);border-radius:var(--radius-surface)}.skeleton-art{inline-size:var(--result-art,var(--search-art));block-size:var(--result-art,var(--search-art));background:var(--surface-raised);border-radius:var(--radius-control)}.skeleton-copy{display:grid;align-content:center;gap:var(--space-2)}.skeleton-copy i{display:block;block-size:var(--space-2);inline-size:85%;background:var(--surface-raised);border-radius:var(--radius-control)}.skeleton-copy i:nth-child(2){inline-size:60%}.skeleton-copy i:nth-child(3){inline-size:40%}
  .error{color:var(--status-error)}.sr-only{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip:rect(0,0,0,0)}
  @media(max-width:767px){.search{--result-art:var(--search-art-mobile)}ul>li{grid-template-areas:"art copy" "actions actions"}.result-actions button{flex:1 1 0;padding-inline:var(--space-2)}.playlist-head{grid-template-columns:var(--search-art-mobile) minmax(0,1fr)}.playlist-art{inline-size:var(--search-art-mobile);block-size:var(--search-art-mobile)}}
  @media(max-width:480px){form{grid-template-columns:1fr}.result-heading{align-items:start;flex-direction:column}.best{order:-1}.result-actions button span{line-height:1.15;text-align:center}}
</style>
