import { z } from "zod"

import { parseYouTubePlaylistUrl } from "./youtube-playlist.js"

const radioSearchOutputSchema = z.object({
  entries: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      uploader: z.string().min(1),
      url: z.url(),
    }),
  ),
})

export type RadioPlaylistCandidate = {
  readonly id: string
  readonly title: string
  readonly author: string
  readonly url: string
}

const maximumCandidates = 8
export const minimumRadioTracks = 50
export const maximumRadioTracks = 100

export function youtubeRadioSearchArgs(genre: string): readonly string[] {
  const parameters = new URLSearchParams({
    search_query: `${genre} music playlist`,
    sp: "EgIQAw%3D%3D",
  })
  return [
    "--dump-single-json",
    "--flat-playlist",
    "--playlist-end",
    String(maximumCandidates),
    "--no-warnings",
    `https://www.youtube.com/results?${parameters.toString()}`,
  ]
}

export function youtubeRadioPlaylistArgs(url: string): readonly string[] {
  return [
    "--dump-single-json",
    "--flat-playlist",
    "--yes-playlist",
    "--playlist-end",
    String(maximumRadioTracks),
    "--no-warnings",
    parseYouTubePlaylistUrl(url).toString(),
  ]
}

export function parseRadioSearchOutput(output: string): readonly RadioPlaylistCandidate[] {
  const parsed = radioSearchOutputSchema.parse(JSON.parse(output))
  return parsed.entries.flatMap((entry) => {
    try {
      parseYouTubePlaylistUrl(entry.url)
      return [{ id: entry.id, title: entry.title, author: entry.uploader, url: entry.url }]
    } catch (error) {
      if (error instanceof RangeError) return []
      throw error
    }
  })
}

export class RadioPlaylistNotFoundError extends Error {
  readonly name = "RadioPlaylistNotFoundError"

  constructor(readonly genre: string) {
    super(`No YouTube playlist with at least ${minimumRadioTracks} tracks matched ${genre}`)
  }
}
