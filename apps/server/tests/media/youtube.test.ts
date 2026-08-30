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
    expect(args.at(-1)).toBe(`ytsearch10:${payload}`)
    expect(args).toContain("--flat-playlist")
    expect(args).not.toContain("-f")
  })

  it("derives YouTube artwork when flat search omits a thumbnail", () => {
    // Given
    const output = JSON.stringify({
      entries: [
        {
          id: "video-2",
          title: "Another Song",
          uploader: "Another Artist",
          duration: 120,
        },
      ],
    })

    // When
    const results = parseSearchOutput(output)

    // Then
    expect(results.at(0)?.track.artworkUrl).toBe("https://i.ytimg.com/vi/video-2/hqdefault.jpg")
    expect(results.at(0)?.track.url).toBe("https://www.youtube.com/watch?v=video-2")
  })

  it("ranks a verified official artist upload above an unofficial copy", () => {
    // Given
    const output = JSON.stringify({
      entries: [
        {
          id: "fan-copy",
          title: "Northern Lines (Official Video)",
          uploader: "Music Reuploads",
          channel_is_verified: false,
          duration: 240,
        },
        {
          id: "artist-upload",
          title: "Northern Lines (Official Music Video)",
          uploader: "Small Hours",
          channel_is_verified: true,
          duration: 240,
        },
      ],
    })

    // When
    const results = parseSearchOutput(output)

    // Then
    expect(results.map((result) => result.track.id)).toEqual(["artist-upload"])
  })

  it("collapses duplicate audio video and lyric uploads of the same song", () => {
    // Given
    const output = JSON.stringify({
      entries: [
        {
          id: "official-video",
          title: "Small Hours - Northern Lines (Official Video) feat. North Wind",
          uploader: "Small Hours",
          channel_is_verified: true,
          duration: 240,
        },
        {
          id: "official-audio",
          title: "Small Hours - Northern Lines (Official Audio) ft. North Wind",
          uploader: "Small Hours",
          channel_is_verified: true,
          duration: 240,
        },
        {
          id: "lyrics",
          title: "Small Hours - Northern Lines Lyrics",
          uploader: "Lyrics Channel",
          channel_is_verified: true,
          duration: 240,
        },
      ],
    })

    // When
    const results = parseSearchOutput(output)

    // Then
    expect(results.map((result) => result.track.id)).toEqual(["official-video"])
  })

  it("keeps meaningful alternate versions as separate choices", () => {
    // Given
    const output = JSON.stringify({
      entries: [
        {
          id: "studio",
          title: "Small Hours - Northern Lines (Official Video)",
          uploader: "Small Hours",
          channel_is_verified: true,
          duration: 240,
        },
        {
          id: "remix",
          title: "Small Hours - Northern Lines (Midnight Remix)",
          uploader: "Small Hours",
          channel_is_verified: true,
          duration: 260,
        },
      ],
    })

    // When
    const results = parseSearchOutput(output)

    // Then
    expect(results.map((result) => result.track.id)).toEqual(["studio", "remix"])
  })

  it("caches normalized repeat searches until the cache entry expires", async () => {
    // Given
    let now = 1_000
    let executions = 0
    const executor: ProcessExecutor = {
      async run() {
        executions += 1
        return { stdout: fixture, stderr: "" }
      },
    }
    const source = new YouTubeMusicSource(executor, undefined, {
      now: () => now,
      searchCacheTtlMs: 30_000,
    })

    // When
    await source.search(" Daft Punk ")
    await source.search("daft punk")
    now += 30_001
    await source.search("DAFT PUNK")

    // Then
    expect(executions).toBe(2)
  })

  it("evicts the oldest search when the cache reaches capacity", async () => {
    // Given
    let executions = 0
    const executor: ProcessExecutor = {
      async run() {
        executions += 1
        return { stdout: fixture, stderr: "" }
      },
    }
    const source = new YouTubeMusicSource(executor, undefined, { searchCacheCapacity: 1 })

    // When
    await source.search("first")
    await source.search("second")
    await source.search("first")

    // Then
    expect(executions).toBe(3)
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
