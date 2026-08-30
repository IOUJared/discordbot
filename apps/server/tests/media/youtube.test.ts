import { describe, expect, it } from "vitest"

import {
  parseResolvedOutput,
  parseSearchOutput,
  youtubeSearchArgs,
} from "../../src/media/youtube.js"

const fixture = JSON.stringify({
  entries: [
    {
      id: "video-1",
      title: "Song",
      uploader: "Artist",
      webpage_url: "https://www.youtube.com/watch?v=video-1",
      duration: 42,
      thumbnail: "https://img.youtube.com/video-1.jpg",
    },
  ],
})

describe("YouTube yt-dlp boundary", () => {
  it("parses a search fixture into shared tracks", () => {
    // Given
    const output = fixture

    // When
    const results = parseSearchOutput(output)

    // Then
    expect(results.at(0)?.track).toMatchObject({ id: "video-1", durationMs: 42_000 })
  })

  it("rejects malformed external JSON", () => {
    // Given
    const output = JSON.stringify({ entries: [{ id: 7 }] })

    // When
    const parse = () => parseSearchOutput(output)

    // Then
    expect(parse).toThrow()
  })

  it("keeps an injection payload as one process argument", () => {
    // Given
    const payload = "x; touch /tmp/should-not-exist && $(id)"

    // When
    const args = youtubeSearchArgs(payload)

    // Then
    expect(args.at(-1)).toBe(`ytsearch5:${payload}`)
  })

  it("parses playable URL headers and seek support", () => {
    // Given
    const output = JSON.stringify({
      url: "https://media.example/audio?token=secret",
      http_headers: { Authorization: "secret", "User-Agent": "agent" },
      ext: "webm",
      acodec: "opus",
      protocol: "https",
    })

    // When
    const media = parseResolvedOutput(output)

    // Then
    expect(media).toEqual({
      url: "https://media.example/audio?token=secret",
      headers: { Authorization: "secret", "User-Agent": "agent" },
      container: "webm",
      codec: "opus",
      seekable: true,
    })
  })
})
