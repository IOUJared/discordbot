import { TrackSchema } from "@discord-music/contracts"
import { describe, expect, it } from "vitest"

import {
  createRemoteMediaPolicy,
  type RemoteMediaPolicy,
  RemoteMediaUrlSchema,
} from "../../src/media/media-url-policy.js"
import type { ProcessExecutor } from "../../src/media/types.js"
import { parseResolvedOutput, YouTubeMusicSource } from "../../src/media/youtube.js"

describe("YouTube resolve boundary", () => {
  it("Given an injected extractor When a track resolves Then local process execution is bypassed", async () => {
    // Given
    let processExecutions = 0
    const resolvedUrl = RemoteMediaUrlSchema.parse(
      "https://rr1---sn-a5mekn7z.googlevideo.com/videoplayback?id=injected",
    )
    const source = new YouTubeMusicSource(
      {
        async run() {
          processExecutions += 1
          throw new RangeError("Local resolver must not run")
        },
      },
      undefined,
      {
        extractor: {
          async resolve() {
            return {
              kind: "remote",
              url: resolvedUrl,
              headers: {},
              container: "webm",
              codec: "opus",
              bitrateKbps: null,
              seekable: true,
            }
          },
        },
      },
    )
    const track = TrackSchema.parse({
      id: "injected",
      provider: "youtube",
      title: "Injected",
      artist: "Extractor",
      url: "https://www.youtube.com/watch?v=injected",
      durationMs: 42_000,
    })

    // When
    const media = await source.resolve(track)

    // Then
    expect(media.url).toBe(resolvedUrl)
    expect(processExecutions).toBe(0)
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
    expect(args.at(0)).toBe("--ignore-config")
    expect(args).toContain("--cookies")
    expect(args).not.toContain("--dump-single-json")
    expect(args.at(args.indexOf("--print") + 1)).toBe(
      "%(.{url,http_headers,ext,acodec,abr,protocol})#j",
    )
    expect(args.at(args.indexOf("--cookies") + 1)).toBe("/run/secrets/youtube.cookies.txt")
    expect(args.at(-1)).toBe("https://music.youtube.com/watch?v=abc")
  })
})
