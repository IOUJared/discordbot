import { TrackSchema } from "@discord-music/contracts"
import { describe, expect, it } from "vitest"
import {
  createRemoteMediaPolicy,
  type RemoteMediaPolicy,
  RemoteMediaUrlSchema,
} from "../../src/media/media-url-policy.js"
import type { ProcessExecutor } from "../../src/media/types.js"
import {
  parsePlaylistOutput,
  parseResolvedOutput,
  parseSearchOutput,
  YouTubeMusicSource,
  youtubePlaylistArgs,
} from "../../src/media/youtube.js"
import { parseRadioSearchOutput, youtubeRadioSearchArgs } from "../../src/media/youtube-radio.js"

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
  it("Given a radio genre When playlist discovery arguments are built Then YouTube playlist results are requested safely", () => {
    // Given
    const genre = "indie rock; $(id)"

    // When
    const args = youtubeRadioSearchArgs(genre)

    // Then
    expect(args.at(-1)).toContain("search_query=indie+rock%3B+%24%28id%29+music+playlist")
    expect(args.at(-1)).toContain("sp=EgIQAw%253D%253D")
    expect(args).toContain("--flat-playlist")
  })

  it("Given playlist-filtered YouTube results When discovery output is parsed Then only valid playlist URLs remain", () => {
    // Given
    const output = JSON.stringify({
      entries: [
        {
          id: "PL-first",
          title: "Indie essentials",
          uploader: "Curator",
          url: "https://www.youtube.com/playlist?list=PL-first",
        },
        {
          id: "video",
          title: "Not a playlist",
          uploader: "Channel",
          url: "https://www.youtube.com/watch?v=video",
        },
      ],
    })

    // When
    const candidates = parseRadioSearchOutput(output)

    // Then
    expect(candidates).toEqual([
      {
        id: "PL-first",
        title: "Indie essentials",
        author: "Curator",
        url: "https://www.youtube.com/playlist?list=PL-first",
      },
    ])
  })

  it("Given radio playlist candidates When the first is too short Then a 50-100 track candidate is selected", async () => {
    // Given
    const discovery = JSON.stringify({
      entries: [
        {
          id: "PL-short",
          title: "Short mix",
          uploader: "Curator A",
          url: "https://www.youtube.com/playlist?list=PL-short",
        },
        {
          id: "PL-radio",
          title: "Indie radio",
          uploader: "Curator B",
          url: "https://www.youtube.com/playlist?list=PL-radio",
        },
      ],
    })
    const playlist = (id: string, count: number) =>
      JSON.stringify({
        id,
        title: id === "PL-radio" ? "Indie radio" : "Short mix",
        uploader: "Curator",
        entries: Array.from({ length: count }, (_, index) => ({
          id: `${id}-${index}`,
          title: `Song ${index + 1}`,
          uploader: `Artist ${index + 1}`,
          duration: 180,
        })),
      })
    const outputs = [discovery, playlist("PL-short", 40), playlist("PL-radio", 75)]
    const source = new YouTubeMusicSource({
      async run() {
        const stdout = outputs.shift()
        if (stdout === undefined) throw new RangeError("Unexpected radio process execution")
        return { stdout, stderr: "" }
      },
    })

    // When
    const selected = await source.radio("indie rock")

    // Then
    expect(selected).toMatchObject({ id: "PL-radio", title: "Indie radio" })
    expect(selected.tracks).toHaveLength(75)
    expect(outputs).toEqual([])
  })

  it("Given a YouTube playlist When yt-dlp metadata is parsed Then every video stays in playlist order", () => {
    // Given
    const output = JSON.stringify({
      id: "PL-list",
      title: "Road trip",
      uploader: "Jared",
      thumbnail: null,
      entries: [
        { id: "first", title: "First song", uploader: "Artist A", duration: 61, thumbnail: null },
        { id: "second", title: "Second song", uploader: "Artist B", duration: 122 },
      ],
    })

    // When
    const playlist = parsePlaylistOutput(output)

    // Then
    expect(playlist).toMatchObject({
      id: "PL-list",
      title: "Road trip",
      author: "Jared",
      tracks: [
        { id: "first", title: "First song", durationMs: 61_000 },
        { id: "second", title: "Second song", durationMs: 122_000 },
      ],
    })
  })

  it("Given a playlist URL When process arguments are built Then only YouTube playlist extraction is enabled", () => {
    // Given
    const url = "https://www.youtube.com/playlist?list=PL-list"

    // When
    const args = youtubePlaylistArgs(url)

    // Then
    expect(args).toContain("--yes-playlist")
    expect(args.at(-1)).toBe(url)
  })

  it("Given a non-YouTube URL When playlist metadata is requested Then it is rejected before process execution", async () => {
    // Given
    let executions = 0
    const source = new YouTubeMusicSource({
      async run() {
        executions += 1
        return { stdout: fixture, stderr: "" }
      },
    })

    // When
    const request = source.playlist("https://example.com/playlist?id=secret")

    // Then
    await expect(request).rejects.toThrow("YouTube playlist")
    expect(executions).toBe(0)
  })

  it("Given a playlist preview When the same playlist is imported Then metadata is reused", async () => {
    // Given
    let executions = 0
    const output = JSON.stringify({
      id: "PL-list",
      title: "Road trip",
      uploader: "Jared",
      entries: [{ id: "first", title: "First song", uploader: "Artist", duration: 61 }],
    })
    const source = new YouTubeMusicSource({
      async run() {
        executions += 1
        return { stdout: output, stderr: "" }
      },
    })
    const url = "https://www.youtube.com/playlist?list=PL-list"

    // When
    await source.playlist(url)
    await source.playlist(url)

    // Then
    expect(executions).toBe(1)
  })

  it("parses a search fixture into shared tracks", () => {
    // Given
    const output = fixture

    // When
    const results = parseSearchOutput(output)

    // Then
    expect(results.at(0)).toMatchObject({
      track: { id: "video-1", durationMs: 42_000 },
      bitrateKbps: null,
    })
  })

  it("Given selected audio formats When search metadata is parsed Then higher bitrates rank first", () => {
    // Given
    const output = JSON.stringify({
      entries: [
        { id: "standard", title: "Song Standard", uploader: "Artist", duration: 180, abr: 128 },
        { id: "premium", title: "Song Premium", uploader: "Artist", duration: 180, abr: 251.7 },
        { id: "unknown", title: "Song Unknown", uploader: "Artist", duration: 180 },
      ],
    })

    // When
    const results = parseSearchOutput(output)

    // Then
    expect(results.map(({ track, bitrateKbps }) => [track.id, bitrateKbps])).toEqual([
      ["premium", 252],
      ["standard", 128],
      ["unknown", null],
    ])
  })

  it("rejects malformed external JSON", () => {
    // Given
    const output = JSON.stringify({ entries: [{ id: 7 }] })

    // When
    const parse = () => parseSearchOutput(output)

    // Then
    expect(parse).toThrow()
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
    const searchClient = {
      async search() {
        executions += 1
        return parseSearchOutput(fixture)
      },
    }
    const source = new YouTubeMusicSource(undefined, undefined, {
      now: () => now,
      searchCacheTtlMs: 30_000,
      searchClient,
    })

    // When
    await source.search(" Daft Punk ")
    await source.search("daft punk")
    now += 30_001
    await source.search("DAFT PUNK")

    // Then
    expect(executions).toBe(2)
  })

  it("coalesces concurrent normalized searches into one upstream request", async () => {
    // Given
    let executions = 0
    const source = new YouTubeMusicSource(undefined, undefined, {
      searchClient: {
        async search() {
          executions += 1
          await new Promise((resolve) => setImmediate(resolve))
          return parseSearchOutput(fixture)
        },
      },
    })

    // When
    const [first, second] = await Promise.all([
      source.search(" Daft Punk "),
      source.search("daft punk"),
    ])

    // Then
    expect(executions).toBe(1)
    expect(second).toBe(first)
  })

  it("pre-resolves the first result so selecting it reuses the in-flight media lookup", async () => {
    // Given
    let executions = 0
    const executor: ProcessExecutor = {
      async run() {
        executions += 1
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
    const deliveryUrl = RemoteMediaUrlSchema.parse(
      "https://rr1---sn-a5mekn7z.googlevideo.com/videoplayback?id=abc",
    )
    const policy: RemoteMediaPolicy = {
      async authorize() {
        return {
          url: deliveryUrl,
          hostname: "rr1---sn-a5mekn7z.googlevideo.com",
          address: "142.250.190.110",
          family: 4,
          port: 443,
        }
      },
    }
    const source = new YouTubeMusicSource(executor, policy, {
      preloadFirstSearchResult: true,
      searchClient: {
        async search() {
          return parseSearchOutput(fixture)
        },
      },
    })

    // When
    const results = await source.search("Daft Punk")
    expect(executions).toBe(1)
    const first = results.at(0)
    if (first === undefined) throw new RangeError("Expected a search result")
    await source.resolve(first.track)

    // Then
    expect(executions).toBe(1)
  })

  it("Given a YouTube query When search runs Then metadata comes from the low-latency search client", async () => {
    // Given
    let processExecutions = 0
    const source = new YouTubeMusicSource(
      {
        async run() {
          processExecutions += 1
          return { stdout: fixture, stderr: "" }
        },
      },
      undefined,
      {
        searchClient: {
          async search() {
            return parseSearchOutput(fixture)
          },
        },
      },
    )

    // When
    const results = await source.search("Daft Punk")

    // Then
    expect(results.at(0)?.track.id).toBe("video-1")
    expect(processExecutions).toBe(0)
  })

  it("evicts the oldest search when the cache reaches capacity", async () => {
    // Given
    let executions = 0
    const searchClient = {
      async search() {
        executions += 1
        return parseSearchOutput(fixture)
      },
    }
    const source = new YouTubeMusicSource(undefined, undefined, {
      searchCacheCapacity: 1,
      searchClient,
    })

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
      abr: 251.7,
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
      bitrateKbps: 252,
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

  it("Given a Premium cookie secret When a track resolves Then yt-dlp authenticates with that file", async () => {
    // Given
    let args: readonly string[] = []
    const executor: ProcessExecutor = {
      async run(request) {
        args = request.args
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
    const deliveryUrl = RemoteMediaUrlSchema.parse(
      "https://rr1---sn-a5mekn7z.googlevideo.com/videoplayback?id=abc",
    )
    const policy: RemoteMediaPolicy = {
      async authorize() {
        return {
          url: deliveryUrl,
          hostname: "rr1---sn-a5mekn7z.googlevideo.com",
          address: "142.250.190.110",
          family: 4,
          port: 443,
        }
      },
    }
    const source = new YouTubeMusicSource(executor, policy, {
      youtubeCookiesPath: "/run/secrets/youtube.cookies.txt",
    })
    const premiumTrack = TrackSchema.parse({
      id: "abc",
      provider: "youtube",
      title: "Song",
      artist: "Artist",
      url: "https://www.youtube.com/watch?v=abc",
      durationMs: 42_000,
    })

    // When
    await source.resolve(premiumTrack)

    // Then
    expect(args).toContain("--cookies")
    expect(args).not.toContain("--dump-single-json")
    expect(args.at(args.indexOf("--print") + 1)).toBe(
      "%(.{url,http_headers,ext,acodec,abr,protocol})#j",
    )
    expect(args.at(args.indexOf("--cookies") + 1)).toBe("/run/secrets/youtube.cookies.txt")
    expect(args.at(-1)).toBe("https://music.youtube.com/watch?v=abc")
  })
})
