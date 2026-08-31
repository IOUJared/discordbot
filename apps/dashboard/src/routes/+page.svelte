<script lang="ts">
  import type { HistoryItem, LoopMode, PlaybackFailureNotification, PlayerState, QueueItem, SearchResult, YouTubePlaylist } from "@discord-music/contracts"
  import { onMount, tick } from "svelte"
  import { base } from "$app/paths"
  import List from "phosphor-svelte/lib/List"
  import SpeakerHigh from "phosphor-svelte/lib/SpeakerHigh"
  import X from "phosphor-svelte/lib/X"
  import HistoryPanel from "$lib/components/HistoryPanel.svelte"
  import NowPlaying from "$lib/components/NowPlaying.svelte"
  import PlaybackFailureToast from "$lib/components/PlaybackFailureToast.svelte"
  import QueuePanel from "$lib/components/QueuePanel.svelte"
  import RoomNav from "$lib/components/RoomNav.svelte"
  import SearchPanel from "$lib/components/SearchPanel.svelte"
  import Range from "$lib/components/Range.svelte"
  import Transport from "$lib/components/Transport.svelte"
  import Badge from "$lib/components/Badge.svelte"
  import Button from "$lib/components/Button.svelte"
  import Artwork from "$lib/components/Artwork.svelte"
  import { interpolatePosition } from "$lib/domain/playback.js"
  import { moveQueueItem } from "$lib/domain/queue.js"
  import { createApi, DashboardApiError, type VoiceChannel } from "$lib/services/api.js"
  import { createSessionStore, consumeAuthFragment, type Session } from "$lib/services/session.js"
  import { connectSnapshotSocket, type SocketStatus } from "$lib/services/socket.js"
  import "./dashboard.css"

  const defaultApiUrl = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:3000"
  const apiUrlStorageKey = "discord-music.api-url"
  const knownInvalidApiHosts = new Set(["example.com", "example.github.io"])

  let apiUrl = $state(defaultApiUrl)
  const isHttpUrl = (value: string): boolean => /^https?:\/\/\S+/.test(value.trim())
  const normalizeApiUrl = (value: string): string =>
    isHttpUrl(value) ? value.trim().replace(/\/$/, "") : "http://127.0.0.1:3000"
  const isAllowedApiHost = (value: string): boolean => {
    if (!isHttpUrl(value)) return false
    const parsed = new URL(value)
    if (knownInvalidApiHosts.has(parsed.hostname)) return false
    return true
  }
  const readStoredApiUrl = (): string | null => {
    if (typeof localStorage === "undefined") return null
    const stored = localStorage.getItem(apiUrlStorageKey)
    if (stored === null) return null
    const normalized = normalizeApiUrl(stored)
    try {
      const parsed = new URL(normalized)
      if (!isAllowedApiHost(normalized)) return null
      return parsed.toString().replace(/\/$/, "")
    } catch {
      return null
    }
  }
  const deriveFallbackApiUrl = (): string => {
    if (typeof location === "undefined") return normalizeApiUrl(defaultApiUrl)
    if (location.hostname.endsWith(".github.io")) return normalizeApiUrl(defaultApiUrl)
    return normalizeApiUrl(`${location.origin}/api`)
  }
  const resolveApiUrl = (): string => {
    if (typeof location === "undefined") return normalizeApiUrl(defaultApiUrl)
    const query = new URLSearchParams(location.search).get("api")
    const defaultCandidate = isAllowedApiHost(defaultApiUrl) ? defaultApiUrl : deriveFallbackApiUrl()
    const candidate = query ?? readStoredApiUrl() ?? defaultCandidate
    const normalized = isAllowedApiHost(candidate)
      ? normalizeApiUrl(candidate)
      : "http://127.0.0.1:3000"
    const finalApiUrl = isAllowedApiHost(normalized) ? normalized : "http://127.0.0.1:3000"
    if (query !== null && isHttpUrl(query) && typeof localStorage !== "undefined") {
      localStorage.setItem(apiUrlStorageKey, normalized)
      const nextParams = new URLSearchParams(location.search)
      nextParams.delete("api")
      const suffix = nextParams.toString()
      const next = `${location.pathname}${suffix.length === 0 ? "" : `?${suffix}`}`
      window.history.replaceState(null, "", next || location.pathname)
    }
    return finalApiUrl
  }
  const wsUrl = $derived(`${apiUrl.replace(/^http/, "ws")}/ws`)
  $effect(() => {
    const resolved = resolveApiUrl()
    apiUrl = resolved
  })
  let session = $state<Session | null>(null)
  let snapshot = $state<PlayerState | null>(null)
  let channels = $state<readonly VoiceChannel[]>([])
  let selectedChannel = $state("")
  const connectedChannel = $derived(
    channels.find((channel) => channel.id === snapshot?.voice.channelId) ?? null,
  )
  let searchResults = $state<readonly SearchResult[]>([])
  let playlist = $state<YouTubePlaylist | null>(null)
  let playlistUrl = $state("")
  let playlistImporting = $state(false)
  let importedCount = $state<number | null>(null)
  let history = $state<readonly HistoryItem[]>([])
  let view = $state<"player" | "history">("player")
  let socketStatus = $state<SocketStatus>("disconnected")
  let loading = $state(true)
  let busy = $state(false)
  let searchLoading = $state(false)
  let historyLoading = $state(false)
  let error = $state<string | null>(null)
  let searchError = $state<string | null>(null)
  let queueError = $state<string | null>(null)
  let playbackFailure = $state<PlaybackFailureNotification | null>(null)
  let pendingId = $state<string | null>(null)
  let queueOpen = $state(false)
  let observedAt = $state(Date.now())
  let displayPosition = $state(0)
  let disconnect: (() => void) | null = null
  const store = typeof sessionStorage === "undefined" ? null : createSessionStore(sessionStorage)
  const api = $derived.by(() => createApi(apiUrl, () => session?.token ?? null))

  const applyState = (next: PlayerState): void => { snapshot = next; observedAt = Date.now(); displayPosition = next.player.positionMs; error = null }
  const refresh = async (): Promise<void> => { applyState(await api.state()) }
  const explain = (caught: unknown): string => caught instanceof DashboardApiError ? caught.message : caught instanceof Error ? caught.message : "The request failed. Try again."
  const beginSocket = (): void => { if (session === null) return; disconnect?.(); disconnect = connectSnapshotSocket({ url: wsUrl, token: session.token, onState: applyState, onFailure: (failure) => { playbackFailure = failure }, onStatus: (status) => { socketStatus = status }, refresh }) }
  const containQueueFocus = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && queueOpen) { queueOpen = false; return }
    if (event.key !== "Tab" || !queueOpen || typeof document === "undefined") return
    const overlay = document.querySelector<HTMLElement>("aside[role=dialog]")
    if (overlay === null) return
    const focusable = [...overlay.querySelectorAll<HTMLElement>(".close, .queue > header button, summary, details[open] button:not([disabled])")].filter((element) => element.getClientRects().length > 0)
    if (focusable.length === 0) return
    const currentIndex = focusable.findIndex((element) => element === document.activeElement)
    const nextIndex = currentIndex < 0 ? event.shiftKey ? focusable.length - 1 : 0 : (currentIndex + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length
    const next = focusable[nextIndex]
    if (next === undefined) return
    event.preventDefault()
    next.focus()
  }

  $effect(() => {
    if (!queueOpen || typeof document === "undefined") return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const overlay = document.querySelector("aside")
    const surfaces = document.querySelectorAll(".skip, .main, nav, .mobile-header, .mobile-footer")
    overlay?.setAttribute("role", "dialog")
    overlay?.setAttribute("aria-modal", "true")
    overlay?.setAttribute("aria-label", "Queue")
    for (const surface of surfaces) surface.setAttribute("inert", "")
    document.body.style.overflow = "hidden"
    let active = true
    let remainingFrames = 4
    const focusWhenVisible = (): void => {
      const close = document.querySelector<HTMLElement>("aside .close")
      if (!active || close === null) return
      if (getComputedStyle(close).visibility === "visible") { close.focus(); return }
      remainingFrames -= 1
      if (remainingFrames > 0) requestAnimationFrame(focusWhenVisible)
    }
    void tick().then(() => requestAnimationFrame(focusWhenVisible))
    return () => {
      active = false
      overlay?.removeAttribute("role")
      overlay?.removeAttribute("aria-modal")
      overlay?.removeAttribute("aria-label")
      for (const surface of surfaces) surface.removeAttribute("inert")
      document.body.style.overflow = ""
      previous?.focus()
    }
  })

  onMount(() => {
    document.querySelector(".boot")?.remove()
    let positionTimer: ReturnType<typeof setInterval> | null = null
    const start = async (): Promise<void> => {
      if (store === null) return
      const fragment = await consumeAuthFragment(window.location, window.history, api.exchange)
      if (fragment.kind === "authenticated") store.save(fragment.session)
      if (fragment.kind === "error") error = `Sign-in failed: ${fragment.code.replaceAll("_", " ")}. Try again.`
      session = fragment.kind === "authenticated" ? fragment.session : store.load()
      if (session === null) { loading = false; return }
      try { const channelsRequest = api.channels(); applyState(await api.state()); loading = false; channels = await channelsRequest; beginSocket() } catch (caught) { error = explain(caught) } finally { loading = false }
      positionTimer = setInterval(() => { if (snapshot?.player.currentItem === null || snapshot?.player.currentItem === undefined) return; displayPosition = interpolatePosition({ positionMs: snapshot.player.positionMs, durationMs: snapshot.player.currentItem.track.durationMs, paused: snapshot.player.isPaused, observedAtMs: observedAt }, Date.now()) }, 250)
    }
    void start()
    return () => { disconnect?.(); if (positionTimer !== null) clearInterval(positionTimer) }
  })

  async function logout(): Promise<void> { try { await api.logout() } catch (caught) { if (!(caught instanceof DashboardApiError)) throw caught } store?.clear(); disconnect?.(); session = null; snapshot = null }
  async function command(name: string): Promise<void> {
    if (snapshot === null) return
    busy = true
    try {
      if (name === "loop") { const modes: readonly LoopMode[] = ["off","track","queue"]; const index = modes.indexOf(snapshot.player.loopMode); applyState(await api.loop(modes[(index+1)%modes.length] ?? "off")) }
      else applyState(await api.command(`api/player/${name}`))
    } catch (caught) { error = explain(caught) } finally { busy = false }
  }
  async function search(query: string): Promise<void> {
    searchLoading = true
    searchError = null
    searchResults = []
    playlist = null
    importedCount = null
    try {
      if (/^https:\/\/(?:www\.|m\.)?youtube\.com\/.*[?&]list=[^&]+/iu.test(query.trim())) {
        playlistUrl = query.trim()
        playlist = await api.previewPlaylist(playlistUrl)
      } else {
        playlistUrl = ""
        searchResults = await api.search(query)
      }
    } catch (caught) { searchError = explain(caught) } finally { searchLoading = false }
  }
  async function importPlaylist(): Promise<void> {
    if (snapshot === null || playlist === null) return
    if (!snapshot.voice.connected && selectedChannel.length === 0) { searchError = "Choose a voice channel before adding the playlist."; return }
    playlistImporting = true
    searchError = null
    try {
      const result = await api.importPlaylist(playlistUrl, snapshot.version, snapshot.voice.connected ? undefined : selectedChannel)
      applyState(result.state)
      importedCount = result.importedCount
    } catch (caught) {
      if (caught instanceof DashboardApiError && caught.status === 409) await refresh()
      searchError = explain(caught)
    } finally { playlistImporting = false }
  }
  async function add(result: SearchResult, next: boolean): Promise<void> {
    if (snapshot === null) return
    if (!snapshot.voice.connected && selectedChannel.length === 0) { searchError = "Choose a voice channel before adding the first track."; return }
    busy = true
    try { const updated = await api.add(result.track, snapshot.version, snapshot.voice.connected ? undefined : selectedChannel); applyState(updated); const added = updated.player.queue.find((item) => item.track.id === result.track.id); if (next && added !== undefined) applyState(await api.queueCommand(added.id,"next",updated.version)) } catch (caught) { if (caught instanceof DashboardApiError && caught.status === 409) await refresh(); searchError = explain(caught) } finally { busy = false }
  }
  async function reorderQueue(item: QueueItem, target: number): Promise<void> {
    if (snapshot === null) return
    const before = snapshot
    const from = before.player.queue.findIndex((row) => row.id === item.id)
    if (from < 0 || target < 0 || target >= before.player.queue.length || from === target) return
    pendingId = item.id
    snapshot = { ...before, player: { ...before.player, queue: moveQueueItem(before.player.queue,from,target) } }
    try { applyState(await api.reorder(item.id,target,before.version)) } catch (caught) { snapshot = before; if (caught instanceof DashboardApiError && caught.status === 409) await refresh(); queueError = caught instanceof DashboardApiError && caught.status === 409 ? "Queue changed elsewhere. The latest order is shown." : explain(caught) } finally { pendingId = null }
  }
  async function queueAction(name: "up"|"down"|"next"|"play"|"remove"|"clear", item?: QueueItem, index?: number): Promise<void> {
    if (snapshot === null) return
    queueError = null
    try {
      if (name === "clear") { applyState(await api.clear(snapshot.version)); return }
      if (item === undefined || index === undefined) return
      if (name === "remove") { applyState(await api.remove(item.id,snapshot.version)); return }
      if (name === "next" || name === "play") { applyState(await api.queueCommand(item.id,name,snapshot.version)); return }
      const target = name === "up" ? index-1 : index+1
      await reorderQueue(item,target)
    } catch (caught) { if (caught instanceof DashboardApiError && caught.status === 409) await refresh(); queueError = explain(caught) }
  }
  async function selectView(next: "player"|"history"): Promise<void> { view = next; if (next === "history") { historyLoading = true; try { history = await api.history() } catch (caught) { error = explain(caught) } finally { historyLoading = false } } }
  async function historyAction(item: HistoryItem, play: boolean): Promise<void> { await add({ track:item.queueItem.track, score:1 },play); view="player" }
  async function voiceAction(): Promise<void> { if (snapshot === null) return; busy=true; try { applyState(snapshot.voice.connected ? await api.leave() : await api.join(selectedChannel)) } catch(caught){error=explain(caught)} finally{busy=false} }
  async function connectVoiceChannel(channel: VoiceChannel): Promise<void> { if (snapshot === null || snapshot.voice.channelId === channel.id) return; selectedChannel=channel.id; busy=true; try { applyState(await api.join(channel.id)) } catch(caught){error=explain(caught)} finally{busy=false} }
</script>

<svelte:window onkeydown={containQueueFocus} />
<svelte:head>
  <title>Discord Music Remote</title>
  <link
    rel="preload"
    as="image"
    type="image/avif"
    href={`${base}/artwork-mountain-720.avif`}
    imagesrcset={`${base}/artwork-mountain-360.avif 360w, ${base}/artwork-mountain-480.avif 480w, ${base}/artwork-mountain-720.avif 720w`}
    imagesizes="(max-width: 767px) 244px, 598px"
    fetchpriority="high"
  />
</svelte:head>
<a class="skip" href="#main">Skip to player</a>
{#if loading}<main class="center"><div class="skeleton" aria-label="Loading music room"></div><p>Loading music room…</p></main>
{:else if session === null}<main class="login" data-testid="auth-anonymous"><SpeakerHigh size={48} weight="duotone" aria-hidden="true" /><p class="eyebrow">Private music control</p><h1>Listening room</h1><p>Sign in with Discord to manage playback for your server.</p>{#if error}<p class="error" role="alert">{error}</p>{/if}<a class="login-button" href={`${apiUrl}/auth/discord`}>Sign in with Discord</a><a href={`${base}/showcase/`}>View the design system</a></main>
{:else if snapshot === null}<main class="center"><h1>Room unavailable</h1><p class="error" role="alert">{error ?? "The server did not return room state."}</p><Button label="Try again" variant="primary" onclick={() => void refresh()} /><Button label="Log out" onclick={() => void logout()} /></main>
{:else}<div class="shell">
  <header class="mobile-header"><strong>{connectedChannel?.name ?? "Voice channels"}</strong><Badge status={socketStatus === "connected" ? "connected" : socketStatus === "disconnected" ? "disconnected" : "reconnecting"} label={socketStatus} /><button aria-label="Open queue" onclick={() => queueOpen=true}><List size={22} aria-hidden="true" /></button></header>
  <RoomNav {channels} activeChannelId={snapshot.voice.channelId} voiceConnected={snapshot.voice.connected} {socketStatus} {view} {busy} onchange={(next) => void selectView(next)} onchannel={(channel) => void connectVoiceChannel(channel)} logout={() => void logout()} />
  <main id="main" class="main">
    {#if error}<div class="banner" role="alert">{error}<button aria-label="Dismiss error" onclick={() => error=null}><X size={18} aria-hidden="true" /></button></div>{/if}
    <div class="voice desktop-voice"><span class="voice-context">{snapshot.voice.connected ? `Connected to ${connectedChannel?.name ?? "voice"}` : "Choose a voice channel in the sidebar"}</span>{#if snapshot.voice.connected}<Button label="Leave voice" loading={busy} onclick={() => void voiceAction()} />{/if}</div>
    {#if view === "history"}<HistoryPanel items={history} loading={historyLoading} action={(item,play) => void historyAction(item,play)} />{:else}<NowPlaying player={snapshot.player} position={displayPosition} {busy} command={(name) => void command(name)} seek={(value) => void api.seek(value).then(applyState).catch((caught) => error=explain(caught))} volume={(value) => void api.volume(value).then(applyState).catch((caught) => error=explain(caught))} /><section class="mobile-queue-preview" aria-labelledby="mobile-queue-title"><header><h2 id="mobile-queue-title">Queue <span>{snapshot.player.queue.length}</span></h2><button onclick={() => queueOpen=true}>Review queue</button></header>{#if snapshot.player.queue.length === 0}<p>Queue is empty.</p>{:else}<ol>{#each snapshot.player.queue.slice(0,2) as item}<li><span><strong>{item.track.title}</strong><small>{item.track.artist}</small></span><time>{Math.floor(item.track.durationMs/60_000)}:{Math.floor((item.track.durationMs%60_000)/1_000).toString().padStart(2,"0")}</time></li>{/each}</ol>{/if}</section><SearchPanel results={searchResults} {playlist} loading={searchLoading} importing={playlistImporting} {importedCount} error={searchError} onsearch={(query) => void search(query)} onadd={(result,next) => void add(result,next)} onimport={() => void importPlaylist()} /><details class="mobile-voice"><summary>Voice channel</summary><div class="voice"><label><span class="sr-only">Voice channel</span><select bind:value={selectedChannel} disabled={snapshot.voice.connected}>{#if channels.length===0}<option value="">No channels available</option>{:else}<option value="">Choose a channel</option>{#each channels as channel}<option value={channel.id}>{channel.name} · {channel.memberCount}</option>{/each}{/if}</select></label><Button label={snapshot.voice.connected ? "Leave voice" : "Join voice"} disabled={!snapshot.voice.connected && selectedChannel.length===0} loading={busy} onclick={() => void voiceAction()} /></div></details>{/if}
  </main>
  {#if queueOpen}<button class="queue-backdrop" tabindex="-1" aria-label="Dismiss queue backdrop" onclick={() => queueOpen=false}></button>{/if}
  <aside class:open={queueOpen}><button class="close" aria-label="Close queue" onclick={() => queueOpen=false}><X size={22} aria-hidden="true" /></button><QueuePanel queue={snapshot.player.queue} {pendingId} error={queueError} action={(name,item,index) => void queueAction(name,item,index)} reorder={(item,index) => void reorderQueue(item,index)} /></aside>
  <footer class="mobile-footer"><button onclick={() => queueOpen=true}><List size={22} aria-hidden="true" />Queue ({snapshot.player.queue.length})</button><Badge status={snapshot.voice.connected ? "connected" : "degraded"} label={snapshot.voice.connected ? "Voice connected" : "Voice not joined"} /></footer>
</div>{/if}
<PlaybackFailureToast failure={playbackFailure} dismiss={() => playbackFailure = null} />
{#if session !== null && snapshot !== null && snapshot.player.currentItem !== null}
  <footer class="desktop-player-footer">
    <div class="footer-track">{#if snapshot.player.currentItem.track.artworkUrl}<Artwork src={snapshot.player.currentItem.track.artworkUrl} alt="" />{/if}<strong>{snapshot.player.currentItem.track.title}</strong><span>{snapshot.player.currentItem.track.artist}</span></div>
    <Transport paused={snapshot.player.isPaused} hasCurrent={true} {busy} loopMode={snapshot.player.loopMode} {command} />
    <Range label="Volume" value={snapshot.player.volume} max={200} oninput={(value) => void api.volume(value).then(applyState).catch((caught) => error=explain(caught))} />
  </footer>
{/if}
