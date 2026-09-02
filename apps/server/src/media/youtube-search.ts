import { DurationMsSchema, type SearchResult, TrackSchema } from "@discord-music/contracts"
import ky from "ky"
import { z } from "zod"

const textRunsSchema = z.object({
  runs: z.array(z.object({ text: z.string().min(1) })).min(1),
})
const videoRendererSchema = z.object({
  videoId: z.string().min(1),
  title: textRunsSchema,
  ownerText: textRunsSchema,
  lengthText: z.object({ simpleText: z.string().regex(/^\d+(?::\d+)+$/u) }),
  thumbnail: z.object({
    thumbnails: z.array(z.object({ url: z.url() })).min(1),
  }),
  ownerBadges: z
    .array(
      z.object({
        metadataBadgeRenderer: z.object({ style: z.string() }),
      }),
    )
    .optional(),
})
const youtubeSearchEndpoint = "https://www.youtube.com/youtubei/v1/search"
const youtubeWebClientVersion = "2.20240101.00.00"
const youtubeVideoFilter = "EgIQAQ%3D%3D"
const videoRendererField =
  "contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents.itemSectionRenderer.contents.videoRenderer"
const youtubeSearchFieldMask = ["videoId", "title", "ownerText", "lengthText", "thumbnail"]
  .map((field) => `${videoRendererField}.${field}`)
  .join(",")
const maximumSearchResults = 5
const youtubeSearchTimeoutMs = 2_500

export interface YouTubeSearchClient {
  search(query: string, signal?: AbortSignal): Promise<readonly SearchResult[]>
}

function durationSeconds(value: string): number {
  return value
    .split(":")
    .map(Number)
    .reduce((total, part) => total * 60 + part, 0)
}

function collectVideoRenderers(value: unknown, output: unknown[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectVideoRenderers(item, output)
    return
  }
  if (typeof value !== "object" || value === null) return
  if (Object.hasOwn(value, "videoRenderer")) output.push(Reflect.get(value, "videoRenderer"))
  for (const child of Object.values(value)) collectVideoRenderers(child, output)
}

export function parseYouTubeSearchResponse(value: unknown): readonly SearchResult[] {
  const candidates: unknown[] = []
  collectVideoRenderers(value, candidates)

  return candidates.flatMap((candidate, index) => {
    const parsed = videoRendererSchema.safeParse(candidate)
    if (!parsed.success || index >= maximumSearchResults) return []
    const renderer = parsed.data
    const thumbnail = renderer.thumbnail.thumbnails.at(-1)
    if (thumbnail === undefined) return []

    return {
      track: TrackSchema.parse({
        id: renderer.videoId,
        provider: "youtube",
        title: renderer.title.runs.map(({ text }) => text).join(""),
        artist: renderer.ownerText.runs.map(({ text }) => text).join(""),
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(renderer.videoId)}`,
        durationMs: DurationMsSchema.parse(durationSeconds(renderer.lengthText.simpleText) * 1_000),
        artworkUrl: thumbnail.url,
      }),
      score: Math.max(0, 1 - index * 0.1),
      bitrateKbps: null,
    }
  })
}

export const youtubeSearchClient: YouTubeSearchClient = {
  async search(query, signal) {
    const response = await ky
      .post(youtubeSearchEndpoint, {
        timeout: youtubeSearchTimeoutMs,
        retry: 0,
        ...(signal === undefined ? {} : { signal }),
        headers: {
          "x-goog-fieldmask": youtubeSearchFieldMask,
          "x-youtube-client-name": "1",
          "x-youtube-client-version": youtubeWebClientVersion,
        },
        json: {
          context: {
            client: {
              clientName: "WEB",
              clientVersion: youtubeWebClientVersion,
              gl: "US",
              hl: "en",
            },
          },
          params: youtubeVideoFilter,
          query,
        },
      })
      .json<unknown>()
    return parseYouTubeSearchResponse(response)
  },
}
