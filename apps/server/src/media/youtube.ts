import type { SearchResult, Track, YouTubePlaylist } from "@discord-music/contracts"

import { type RemoteMediaPolicy, remoteMediaPolicy } from "./media-url-policy.js"
import { nodeProcessExecutor } from "./process-executor.js"
import type {
  MusicSource,
  PlayableMedia,
  PlaylistSource,
  ProcessExecutor,
  RadioSource,
} from "./types.js"
import { BoundedTtlCache, canonicalizeSearchQuery } from "./youtube-cache.js"
import type { YouTubeExtractor } from "./youtube-extractor.js"
import { LocalYouTubeResolver } from "./youtube-local-resolver.js"
import {
  parsePlaylistOutput,
  parseYouTubePlaylistUrl,
  youtubePlaylistArgs,
} from "./youtube-playlist.js"
import {
  maximumRadioTracks,
  minimumRadioTracks,
  parseRadioSearchOutput,
  RadioPlaylistNotFoundError,
  youtubeRadioPlaylistArgs,
  youtubeRadioSearchArgs,
} from "./youtube-radio.js"
import { type YouTubeSearchClient, youtubeSearchClient } from "./youtube-search.js"
import { YouTubeSearchCoalescer } from "./youtube-search-coalescer.js"
import {
  fingerprintMediaIds,
  MEDIA_SIDECAR_OBSERVATION_SCHEMA,
  requestCorrelationId,
  type SidecarRuntimeObservationSink,
} from "./youtube-sidecar-observation.js"

export { parseResolvedOutput } from "./youtube-output.js"
export { parsePlaylistOutput, youtubePlaylistArgs } from "./youtube-playlist.js"

const processTimeoutMs = 20_000
const defaultSearchCacheTtlMs = 10 * 60_000
const defaultPlaylistCacheTtlMs = 30_000
const defaultSearchCacheCapacity = 100
const defaultResolvedCacheTtlMs = 5 * 60_000
type YouTubeMusicSourceOptions = {
  readonly now?: () => number
  readonly searchCacheTtlMs?: number
  readonly searchCacheCapacity?: number
  readonly resolvedCacheTtlMs?: number
  readonly resolvedCacheCapacity?: number
  readonly youtubeCookiesPath?: string
  readonly searchClient?: YouTubeSearchClient
  readonly extractor?: YouTubeExtractor
  readonly preloadFirstSearchResult?: boolean
  readonly observe?: SidecarRuntimeObservationSink
  readonly observeSearchResultIds?: boolean
}

type PendingResolution = {
  readonly trackId: string
  readonly expiresAt: number
  readonly controller: AbortController
  readonly outcome: Promise<PlayableMedia | undefined>
}

export class YouTubeMusicSource implements MusicSource, PlaylistSource, RadioSource {
  private readonly now: () => number
  private readonly searchCacheTtlMs: number
  private readonly searchCacheCapacity: number
  private readonly resolvedCacheTtlMs: number
  private readonly youtubeCookiesPath: string | undefined
  private readonly searchClient: YouTubeSearchClient
  private readonly extractor: YouTubeExtractor
  private readonly preloadFirstSearchResult: boolean
  private readonly observe: SidecarRuntimeObservationSink
  private readonly observeSearchResultIds: boolean
  private readonly searchCache: BoundedTtlCache<readonly SearchResult[]>
  private readonly searchCoalescer: YouTubeSearchCoalescer<readonly SearchResult[]>
  private readonly playlistCache: BoundedTtlCache<YouTubePlaylist>
  private readonly resolvedCache: BoundedTtlCache<PlayableMedia>
  private pendingResolution: PendingResolution | undefined

  constructor(
    private readonly executor: ProcessExecutor = nodeProcessExecutor,
    policy: RemoteMediaPolicy = remoteMediaPolicy,
    options: YouTubeMusicSourceOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.searchCacheTtlMs = options.searchCacheTtlMs ?? defaultSearchCacheTtlMs
    this.searchCacheCapacity = options.searchCacheCapacity ?? defaultSearchCacheCapacity
    this.resolvedCacheTtlMs = options.resolvedCacheTtlMs ?? defaultResolvedCacheTtlMs
    this.searchCache = new BoundedTtlCache({
      capacity: this.searchCacheCapacity,
      ttlMs: this.searchCacheTtlMs,
      now: this.now,
    })
    this.playlistCache = new BoundedTtlCache({
      capacity: this.searchCacheCapacity,
      ttlMs: options.searchCacheTtlMs ?? defaultPlaylistCacheTtlMs,
      now: this.now,
    })
    this.resolvedCache = new BoundedTtlCache({
      capacity: options.resolvedCacheCapacity ?? defaultSearchCacheCapacity,
      ttlMs: this.resolvedCacheTtlMs,
      now: this.now,
    })
    this.youtubeCookiesPath = options.youtubeCookiesPath
    this.searchClient = options.searchClient ?? youtubeSearchClient
    this.extractor =
      options.extractor ?? new LocalYouTubeResolver(executor, policy, options.youtubeCookiesPath)
    this.preloadFirstSearchResult =
      options.preloadFirstSearchResult ?? options.searchClient === undefined
    this.observe = options.observe ?? (() => undefined)
    this.observeSearchResultIds = options.observeSearchResultIds ?? false
    this.searchCoalescer = new YouTubeSearchCoalescer(this.observe)
  }

  async search(query: string, signal?: AbortSignal): Promise<readonly SearchResult[]> {
    if (signal?.aborted === true) throw new DOMException("The operation was aborted", "AbortError")
    const correlationId = requestCorrelationId(signal)
    const cacheKey = canonicalizeSearchQuery(query)
    const cached = this.searchCache.get(cacheKey)
    if (cached !== undefined) {
      this.preload(cached.at(0)?.track)
      return cached
    }

    const search = this.searchCoalescer.run({
      key: cacheKey,
      correlationId,
      ...(signal === undefined ? {} : { signal }),
      start: async (sharedSignal) => {
        const results = await this.searchClient.search(query, sharedSignal)
        this.searchCache.set(cacheKey, results)
        this.preload(results.at(0)?.track)
        return results
      },
    })
    const results = await search.outcome
    return this.observeSearchResults(search.correlationId, results)
  }

  private observeSearchResults(
    correlationId: string,
    results: readonly SearchResult[],
  ): readonly SearchResult[] {
    if (this.observeSearchResultIds) {
      this.observe({
        schema: MEDIA_SIDECAR_OBSERVATION_SCHEMA,
        stage: "in_memory_id_match",
        correlationId,
        count: 1,
        fingerprint: fingerprintMediaIds(results.map(({ track }) => track.id)),
      })
    }
    return results
  }

  async playlist(url: string, signal?: AbortSignal): Promise<YouTubePlaylist> {
    const parsedUrl = parseYouTubePlaylistUrl(url)
    const cacheKey = parsedUrl.toString()
    const cached = this.playlistCache.get(cacheKey)
    if (cached !== undefined) return cached
    const result = await this.executor.run({
      file: "yt-dlp",
      args: youtubePlaylistArgs(parsedUrl.toString()),
      timeoutMs: processTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
    })
    const playlist = parsePlaylistOutput(result.stdout)
    this.playlistCache.set(cacheKey, playlist)
    return playlist
  }

  async radio(genre: string, signal?: AbortSignal): Promise<YouTubePlaylist> {
    const cookieArgs =
      this.youtubeCookiesPath === undefined ? [] : ["--cookies", this.youtubeCookiesPath]
    const discovery = await this.executor.run({
      file: "yt-dlp",
      args: [...cookieArgs, ...youtubeRadioSearchArgs(genre)],
      timeoutMs: processTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
    })
    const candidates = parseRadioSearchOutput(discovery.stdout)
    for (const candidate of candidates) {
      const result = await this.executor.run({
        file: "yt-dlp",
        args: [...cookieArgs, ...youtubeRadioPlaylistArgs(candidate.url)],
        timeoutMs: processTimeoutMs,
        ...(signal === undefined ? {} : { signal }),
      })
      const playlist = parsePlaylistOutput(result.stdout)
      const tracks = playlist.tracks
        .filter(
          (track, index, allTracks) =>
            allTracks.findIndex((candidateTrack) => candidateTrack.id === track.id) === index,
        )
        .slice(0, maximumRadioTracks)
      if (tracks.length >= minimumRadioTracks) return { ...playlist, tracks }
    }
    throw new RadioPlaylistNotFoundError(genre)
  }

  private preload(track: Track | undefined): void {
    if (!this.preloadFirstSearchResult || track === undefined) return
    if (this.resolvedCache.get(track.id) !== undefined) return
    if (
      this.pendingResolution?.trackId === track.id &&
      this.pendingResolution.expiresAt > this.now()
    ) {
      return
    }
    this.pendingResolution?.controller.abort()
    const controller = new AbortController()
    this.pendingResolution = {
      trackId: track.id,
      expiresAt: this.now() + this.resolvedCacheTtlMs,
      controller,
      outcome: this.extractor.resolve(track, controller.signal).then(
        (media) => {
          this.resolvedCache.set(track.id, media)
          return media
        },
        () => undefined,
      ),
    }
  }

  async resolve(track: Track, signal?: AbortSignal): Promise<PlayableMedia> {
    if (signal?.aborted === true) throw new DOMException("The operation was aborted", "AbortError")
    const cached = this.resolvedCache.get(track.id)
    if (cached !== undefined) return cached
    const pending = this.pendingResolution
    if (pending?.trackId === track.id && pending.expiresAt > this.now()) {
      this.pendingResolution = undefined
      const abort = () => pending.controller.abort()
      signal?.addEventListener("abort", abort, { once: true })
      try {
        const media = await pending.outcome
        if (media !== undefined) return media
      } finally {
        signal?.removeEventListener("abort", abort)
      }
    }
    const media = await this.extractor.resolve(track, signal)
    this.resolvedCache.set(track.id, media)
    return media
  }
}
