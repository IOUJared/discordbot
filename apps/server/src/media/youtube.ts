import {
  DurationMsSchema,
  type SearchResult,
  type Track,
  TrackSchema,
} from "@discord-music/contracts"
import { z } from "zod"

import {
  type RemoteMediaPolicy,
  RemoteMediaUrlSchema,
  remoteMediaPolicy,
} from "./media-url-policy.js"
import { nodeProcessExecutor } from "./process-executor.js"
import type { MusicSource, PlayableMedia, ProcessExecutor, RemotePlayableMedia } from "./types.js"

const searchEntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  uploader: z.string().min(1),
  channel_is_verified: z.boolean().nullable().optional(),
  duration: z.number().nonnegative(),
  thumbnail: z.url().optional(),
})
const searchOutputSchema = z.object({ entries: z.array(searchEntrySchema) })
const safeHttpHeadersSchema = z
  .record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u), z.string().regex(/^[^\r\n]*$/u))
  .refine((headers) =>
    Object.keys(headers).every(
      (name) =>
        ![
          "host",
          "connection",
          "content-length",
          "proxy-authorization",
          "transfer-encoding",
        ].includes(name.toLocaleLowerCase()),
    ),
  )
const resolvedOutputSchema = z.object({
  url: RemoteMediaUrlSchema,
  http_headers: safeHttpHeadersSchema.default({}),
  ext: z.string().min(1),
  acodec: z.string().min(1),
  protocol: z.enum(["http", "https"]),
})
const processTimeoutMs = 20_000
const defaultSearchCacheTtlMs = 30_000
const defaultSearchCacheCapacity = 100
const maximumSearchResults = 5
const duplicateQualifier =
  /[([]\s*(?:official(?:\s+music)?\s+video|official\s+audio|lyrics?(?:\s+video)?|audio|visuali[sz]er)\s*[)\]]/giu
const featuredArtists = /\b(?:ft|feat|featuring)\.?\s+.*$/giu
const trailingDuplicateQualifier =
  /\s+(?:official(?:\s+music)?\s+video|official\s+audio|lyrics?(?:\s+video)?|visuali[sz]er)\s*$/giu

type YouTubeMusicSourceOptions = {
  readonly now?: () => number
  readonly searchCacheTtlMs?: number
  readonly searchCacheCapacity?: number
}

type SearchCacheEntry = {
  readonly expiresAt: number
  readonly results: readonly SearchResult[]
}

export function youtubeSearchArgs(query: string): readonly string[] {
  return [
    "--dump-single-json",
    "--flat-playlist",
    "--no-playlist",
    "--no-warnings",
    `ytsearch10:${query}`,
  ]
}

export function parseSearchOutput(output: string): readonly SearchResult[] {
  const parsed = searchOutputSchema.parse(JSON.parse(output))
  const ranked = parsed.entries
    .map((entry, index) => ({
      entry,
      index,
      official:
        entry.channel_is_verified === true &&
        (/\bofficial\b/iu.test(entry.title) || /(?:\s+-\s+topic|\bvevo)$/iu.test(entry.uploader)),
    }))
    .sort(
      (left, right) => Number(right.official) - Number(left.official) || left.index - right.index,
    )
  const seenSongs = new Set<string>()

  return ranked
    .flatMap(({ entry }, index) => {
      const words = entry.title
        .normalize("NFKC")
        .replace(duplicateQualifier, " ")
        .replace(featuredArtists, " ")
        .replace(trailingDuplicateQualifier, " ")
        .toLocaleLowerCase("en-US")
        .match(/[\p{L}\p{N}]+/gu)
      const songKey = words?.join(" ") ?? entry.title.toLocaleLowerCase("en-US")
      if (seenSongs.has(songKey)) {
        return []
      }
      seenSongs.add(songKey)

      return {
        track: TrackSchema.parse({
          id: entry.id,
          provider: "youtube",
          title: entry.title,
          artist: entry.uploader,
          url: `https://www.youtube.com/watch?v=${encodeURIComponent(entry.id)}`,
          durationMs: DurationMsSchema.parse(Math.round(entry.duration * 1_000)),
          artworkUrl:
            entry.thumbnail ??
            `https://i.ytimg.com/vi/${encodeURIComponent(entry.id)}/hqdefault.jpg`,
        }),
        score: Math.max(0, 1 - index * 0.1),
      }
    })
    .slice(0, maximumSearchResults)
}

export function parseResolvedOutput(output: string): RemotePlayableMedia {
  const parsed = resolvedOutputSchema.parse(JSON.parse(output))
  return {
    kind: "remote",
    url: parsed.url,
    headers: parsed.http_headers,
    container: parsed.ext,
    codec: parsed.acodec,
    seekable: true,
  }
}

export class YouTubeMusicSource implements MusicSource {
  private readonly now: () => number
  private readonly searchCacheTtlMs: number
  private readonly searchCacheCapacity: number
  private readonly searchCache = new Map<string, SearchCacheEntry>()

  constructor(
    private readonly executor: ProcessExecutor = nodeProcessExecutor,
    private readonly policy: RemoteMediaPolicy = remoteMediaPolicy,
    options: YouTubeMusicSourceOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.searchCacheTtlMs = options.searchCacheTtlMs ?? defaultSearchCacheTtlMs
    this.searchCacheCapacity = options.searchCacheCapacity ?? defaultSearchCacheCapacity
  }

  async search(query: string, signal?: AbortSignal): Promise<readonly SearchResult[]> {
    const cacheKey = query.trim().toLocaleLowerCase()
    const cached = this.searchCache.get(cacheKey)
    if (cached !== undefined && cached.expiresAt > this.now()) {
      return cached.results
    }
    this.searchCache.delete(cacheKey)

    const request = {
      file: "yt-dlp",
      args: youtubeSearchArgs(query),
      timeoutMs: processTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
    }
    const result = await this.executor.run(request)
    const results = parseSearchOutput(result.stdout)
    if (this.searchCache.size >= this.searchCacheCapacity) {
      const oldest = this.searchCache.keys().next()
      if (!oldest.done) {
        this.searchCache.delete(oldest.value)
      }
    }
    this.searchCache.set(cacheKey, {
      expiresAt: this.now() + this.searchCacheTtlMs,
      results,
    })
    return results
  }

  async resolve(track: Track, signal?: AbortSignal): Promise<PlayableMedia> {
    const parsedTrack = TrackSchema.parse(track)
    if (parsedTrack.provider !== "youtube") {
      throw new RangeError("Track is not a YouTube track")
    }
    const request = {
      file: "yt-dlp",
      args: [
        "--dump-single-json",
        "--no-playlist",
        "--no-warnings",
        "-f",
        "bestaudio",
        parsedTrack.url,
      ],
      timeoutMs: processTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
    }
    const result = await this.executor.run(request)
    const media = parseResolvedOutput(result.stdout)
    await this.policy.authorize(media.url)
    return media
  }
}
