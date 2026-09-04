import { readFile } from "node:fs/promises"

import { TrackSchema } from "@discord-music/contracts"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

const { post } = vi.hoisted(() => ({ post: vi.fn() }))

vi.mock("ky", () => ({ default: { post } }))

import { parseYouTubeSearchResponse, youtubeSearchClient } from "../../src/media/youtube-search.js"

const fixtures = new URL("../../../../spec/media-sidecar/v1/", import.meta.url)
const searchResponseSchema = z
  .object({
    version: z.literal(1),
    results: z.array(
      z
        .object({
          track: TrackSchema.extend({ artworkUrl: z.url() }),
          score: z.number().min(0).max(1),
          bitrateKbps: z.null(),
        })
        .strict(),
    ),
  })
  .strict()

const response = {
  contents: {
    itemSectionRenderer: {
      contents: [
        {
          videoRenderer: {
            videoId: "video-1",
            title: { runs: [{ text: "Song" }] },
            ownerText: { runs: [{ text: "Artist" }] },
            lengthText: { simpleText: "3:42" },
            thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/vi/video-1/hqdefault.jpg" }] },
          },
        },
      ],
    },
  },
}

describe("YouTube low-latency search boundary", () => {
  beforeEach(() => {
    post.mockReset()
    post.mockReturnValue({ json: async () => response })
  })

  it("Given a query When YouTube is searched Then only required video metadata is requested", async () => {
    // Given
    const query = "Daft Punk"

    // When
    await youtubeSearchClient.search(query)

    // Then
    expect(post).toHaveBeenCalledWith(
      "https://www.youtube.com/youtubei/v1/search",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-goog-fieldmask": expect.stringContaining("videoId"),
        }),
        json: expect.objectContaining({ params: "EgIQAQ%3D%3D", query }),
      }),
    )
  })

  it("does not return an internal error when YouTube search takes longer than 900 ms", async () => {
    // Given
    const query = "slow upstream response"

    // When
    await youtubeSearchClient.search(query)

    // Then
    expect(post).toHaveBeenCalledWith(
      "https://www.youtube.com/youtubei/v1/search",
      expect.objectContaining({ timeout: 2_500 }),
    )
  })

  it("normalizes the padded shared Innertube fixture like the v1 contract", async () => {
    // Given: the shared raw corpus has ECMAScript-trimmable text and a blank-after-trim slot.
    const raw: unknown = JSON.parse(
      await readFile(new URL("raw/innertube-padding.json", fixtures), "utf8"),
    )
    const expected = searchResponseSchema.parse(
      JSON.parse(
        await readFile(new URL("fixtures/responses/search-padding.json", fixtures), "utf8"),
      ),
    )

    // When: the retained Node parser normalizes that raw renderer response.
    const actual = parseYouTubeSearchResponse(raw)

    // Then: title/artist trimming, IDs, URLs, durations, scores, and order match the shared fixture exactly.
    expect(actual).toEqual(expected.results)
  })

  it("matches Zod code-point limits and thumbnail URL candidates", () => {
    // Given: astral and combining boundaries plus non-HTTP and invalid thumbnail candidates.
    const astral513Utf16 = `${"😀".repeat(256)}a`
    const combining512CodePoints = "e\u0301".repeat(256)
    const renderer = (id: string, title: string, thumbnails: unknown) => ({
      videoRenderer: {
        videoId: id,
        title: { runs: [{ text: title }] },
        ownerText: { runs: [{ text: "Artist" }] },
        lengthText: { simpleText: "1:00" },
        thumbnail: { thumbnails },
      },
    })
    const candidates = {
      contents: [
        renderer("astral-513-utf16", astral513Utf16, [{ url: "ftp://images.example/cover" }]),
        renderer("combining-512-code-points", combining512CodePoints, [
          { url: "data:text/plain,cover" },
        ]),
        renderer("astral-513-code-points", "😀".repeat(513), [
          { url: "https://images.example/cover" },
        ]),
        renderer("relative-before-valid", "Title", [
          { url: "/relative" },
          { url: "https://images.example/cover" },
        ]),
        renderer("malformed-before-valid", "Title", [
          { url: "not a url" },
          { url: "https://images.example/cover" },
        ]),
      ],
    }

    // When: the retained Node parser normalizes the bounded renderer window.
    const actual = parseYouTubeSearchResponse(candidates)

    // Then: code points are bounded while every candidate URL is schema-validated without scheme filtering.
    expect(
      actual.map(({ track, score }) => [track.id, track.title, track.artworkUrl, score]),
    ).toEqual([
      ["astral-513-utf16", astral513Utf16, "ftp://images.example/cover", 1],
      ["combining-512-code-points", combining512CodePoints, "data:text/plain,cover", 0.9],
    ])
    expect(
      parseYouTubeSearchResponse({
        contents: [renderer("null-thumbnail", "Title", [{ url: null }])],
      }),
    ).toEqual([])
  })
})
