import { type Track, TrackSchema } from "@discord-music/contracts"

import { type RemoteMediaPolicy, remoteMediaPolicy } from "./media-url-policy.js"
import { nodeProcessExecutor } from "./process-executor.js"
import type { PlayableMedia, ProcessExecutor } from "./types.js"
import type { YouTubeExtractor } from "./youtube-extractor.js"
import { parseResolvedOutput } from "./youtube-output.js"

const processTimeoutMs = 20_000

export class LocalYouTubeResolver implements YouTubeExtractor {
  constructor(
    private readonly executor: ProcessExecutor = nodeProcessExecutor,
    private readonly policy: RemoteMediaPolicy = remoteMediaPolicy,
    private readonly youtubeCookiesPath?: string,
  ) {}

  async resolve(track: Track, signal?: AbortSignal): Promise<PlayableMedia> {
    const parsedTrack = TrackSchema.parse(track)
    if (parsedTrack.provider !== "youtube") {
      throw new RangeError("Track is not a YouTube track")
    }
    const parsedUrl = new URL(parsedTrack.url)
    const playbackUrl =
      this.youtubeCookiesPath === undefined
        ? parsedTrack.url
        : new URL(
            `${parsedUrl.pathname}${parsedUrl.search}`,
            "https://music.youtube.com",
          ).toString()
    const result = await this.executor.run({
      file: "yt-dlp",
      args: [
        "--ignore-config",
        ...(this.youtubeCookiesPath === undefined ? [] : ["--cookies", this.youtubeCookiesPath]),
        "--no-playlist",
        "--no-warnings",
        "-f",
        "bestaudio",
        "--print",
        "%(.{url,http_headers,ext,acodec,abr,protocol})#j",
        playbackUrl,
      ],
      timeoutMs: processTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
    })
    const media = parseResolvedOutput(result.stdout)
    await this.policy.authorize(media.url)
    return media
  }
}
