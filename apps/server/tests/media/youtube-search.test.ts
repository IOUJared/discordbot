import { beforeEach, describe, expect, it, vi } from "vitest"

const { post } = vi.hoisted(() => ({ post: vi.fn() }))

vi.mock("ky", () => ({ default: { post } }))

import { youtubeSearchClient } from "../../src/media/youtube-search.js"

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
})
