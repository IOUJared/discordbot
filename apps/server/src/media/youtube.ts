import {
  DurationMsSchema,
  type SearchResult,
  type Track,
  TrackSchema,
} from "@discord-music/contracts"
import { z } from "zod"

import { nodeProcessExecutor } from "./process-executor.js"
import type { MusicSource, PlayableMedia, ProcessExecutor } from "./types.js"

const searchEntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  uploader: z.string().min(1),
  webpage_url: z.url(),
  duration: z.number().nonnegative(),
  thumbnail: z.url().optional(),
})
const searchOutputSchema = z.object({ entries: z.array(searchEntrySchema) })
const resolvedOutputSchema = z.object({
  url: z.url(),
  http_headers: z.record(z.string(), z.string()).default({}),
  ext: z.string().min(1),
  acodec: z.string().min(1),
  protocol: z.string().min(1),
})
const processTimeoutMs = 20_000

export function youtubeSearchArgs(query: string): readonly string[] {
  return ["--dump-single-json", "--no-playlist", "--no-warnings", `ytsearch5:${query}`]
}

export function parseSearchOutput(output: string): readonly SearchResult[] {
  const parsed = searchOutputSchema.parse(JSON.parse(output))
  return parsed.entries.map((entry, index) => {
    const artwork = entry.thumbnail === undefined ? {} : { artworkUrl: entry.thumbnail }
    return {
      track: TrackSchema.parse({
        id: entry.id,
        provider: "youtube",
        title: entry.title,
        artist: entry.uploader,
        url: entry.webpage_url,
        durationMs: DurationMsSchema.parse(Math.round(entry.duration * 1_000)),
        ...artwork,
      }),
      score: Math.max(0, 1 - index * 0.1),
    }
  })
}

export function parseResolvedOutput(output: string): PlayableMedia {
  const parsed = resolvedOutputSchema.parse(JSON.parse(output))
  return {
    url: parsed.url,
    headers: parsed.http_headers,
    container: parsed.ext,
    codec: parsed.acodec,
    seekable: parsed.protocol === "https" || parsed.protocol === "http",
  }
}

export class YouTubeMusicSource implements MusicSource {
  constructor(private readonly executor: ProcessExecutor = nodeProcessExecutor) {}

  async search(query: string, signal?: AbortSignal): Promise<readonly SearchResult[]> {
    const request = {
      file: "yt-dlp",
      args: youtubeSearchArgs(query),
      timeoutMs: processTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
    }
    const result = await this.executor.run(request)
    return parseSearchOutput(result.stdout)
  }

  async resolve(track: Track, signal?: AbortSignal): Promise<PlayableMedia> {
    const request = {
      file: "yt-dlp",
      args: ["--dump-single-json", "--no-playlist", "--no-warnings", "-f", "bestaudio", track.url],
      timeoutMs: processTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
    }
    const result = await this.executor.run(request)
    return parseResolvedOutput(result.stdout)
  }
}
