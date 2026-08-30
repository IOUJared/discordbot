import { TrackSchema } from "@discord-music/contracts"
import { describe, expect, it } from "vitest"
import { createRemoteMediaPolicy } from "../../src/media/media-url-policy.js"
import type { ProcessExecutor } from "../../src/media/types.js"
import {
  parseResolvedOutput,
  parseSearchOutput,
  YouTubeMusicSource,
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
      url: "https://rr1---sn-a5mekn7z.googlevideo.com/videoplayback?token=secret",
      http_headers: { Authorization: "secret", "User-Agent": "agent" },
      ext: "webm",
      acodec: "opus",
      protocol: "https",
    })

    // When
    const media = parseResolvedOutput(output)

    // Then
    expect(media).toEqual({
      kind: "remote",
      url: "https://rr1---sn-a5mekn7z.googlevideo.com/videoplayback?token=secret",
      headers: { Authorization: "secret", "User-Agent": "agent" },
      container: "webm",
      codec: "opus",
      seekable: true,
    })
  })

  it("rejects a resolved Host header override", () => {
    // Given: yt-dlp output that tries to replace the validated URL authority.
    const output = JSON.stringify({
      url: "https://rr1---sn-a5mekn7z.googlevideo.com/videoplayback?id=abc",
      http_headers: { Host: "127.0.0.1" },
      ext: "webm",
      acodec: "opus",
      protocol: "https",
    })

    // When: the external JSON crosses the media boundary.
    const parse = () => parseResolvedOutput(output)

    // Then: the authority-changing header is rejected.
    expect(parse).toThrow()
  })

  it("rejects a manifest protocol that could make FFmpeg fetch nested URLs", () => {
    // Given: yt-dlp output representing a remote HLS manifest.
    const output = JSON.stringify({
      url: "https://rr1---sn-a5mekn7z.googlevideo.com/manifest.m3u8",
      http_headers: {},
      ext: "mp4",
      acodec: "aac",
      protocol: "m3u8_native",
    })

    // When: the external JSON crosses the media boundary.
    const parse = () => parseResolvedOutput(output)

    // Then: nested network authority cannot reach FFmpeg through stdin.
    expect(parse).toThrow()
  })

  it("rejects a private DNS answer immediately after yt-dlp resolves media", async () => {
    // Given: yt-dlp returns an allowed delivery host that resolves to loopback.
    const executor: ProcessExecutor = {
      async run() {
        return {
          stdout: JSON.stringify({
            url: "https://rr1---sn-a5mekn7z.googlevideo.com/videoplayback?id=abc",
            http_headers: {},
            ext: "webm",
            acodec: "opus",
            protocol: "https",
          }),
          stderr: "",
        }
      },
    }
    const policy = createRemoteMediaPolicy(async () => [{ address: "127.0.0.1", family: 4 }])
    const source = new YouTubeMusicSource(executor, policy)
    const track = TrackSchema.parse({
      id: "abc",
      provider: "youtube",
      title: "Song",
      artist: "Artist",
      url: "https://www.youtube.com/watch?v=abc",
      durationMs: 42_000,
    })

    // When: the source resolves the track.
    const resolve = source.resolve(track)

    // Then: the media is rejected before it can reach playback.
    await expect(resolve).rejects.toThrow()
  })
})
