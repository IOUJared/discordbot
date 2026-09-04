import {
  DurationMsSchema,
  TrackSchema,
  type YouTubePlaylist,
  YouTubePlaylistSchema,
} from "@discord-music/contracts"
import { z } from "zod"

const playlistEntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  uploader: z.string().min(1),
  duration: z.number().nonnegative(),
  thumbnail: z.url().nullable().optional(),
})
const playlistOutputSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  uploader: z.string().min(1),
  thumbnail: z.url().nullable().optional(),
  entries: z.array(playlistEntrySchema).min(1).max(500),
})
const allowedYouTubeHosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"])

export function youtubePlaylistArgs(url: string): readonly string[] {
  return [
    "--ignore-config",
    "--dump-single-json",
    "--flat-playlist",
    "--yes-playlist",
    "--no-warnings",
    url,
  ]
}

export function parseYouTubePlaylistUrl(url: string): URL {
  const parsed = new URL(url)
  if (!allowedYouTubeHosts.has(parsed.hostname) || parsed.searchParams.get("list") === null) {
    throw new RangeError("Enter a valid YouTube playlist URL")
  }
  return parsed
}

export function parsePlaylistOutput(output: string): YouTubePlaylist {
  const parsed = playlistOutputSchema.parse(JSON.parse(output))
  const tracks = parsed.entries.map((entry) =>
    TrackSchema.parse({
      id: entry.id,
      provider: "youtube",
      title: entry.title,
      artist: entry.uploader,
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(entry.id)}`,
      durationMs: DurationMsSchema.parse(Math.round(entry.duration * 1_000)),
      artworkUrl:
        entry.thumbnail ?? `https://i.ytimg.com/vi/${encodeURIComponent(entry.id)}/hqdefault.jpg`,
    }),
  )
  return YouTubePlaylistSchema.parse({
    id: parsed.id,
    title: parsed.title,
    author: parsed.uploader,
    ...(parsed.thumbnail === undefined || parsed.thumbnail === null
      ? {}
      : { artworkUrl: parsed.thumbnail }),
    tracks,
  })
}
