import { TrackSchema } from "@discord-music/contracts"
import { describe, expect, it } from "vitest"

import { RemoteMediaUrlSchema } from "../../src/media/media-url-policy.js"
import type { PlayableMedia } from "../../src/media/types.js"
import { YouTubeMusicSource } from "../../src/media/youtube.js"

const media: PlayableMedia = {
  kind: "remote",
  url: RemoteMediaUrlSchema.parse(
    "https://rr1---sn-a5mekn7z.googlevideo.com/videoplayback?id=cache",
  ),
  headers: {},
  container: "webm",
  codec: "opus",
  bitrateKbps: null,
  seekable: true,
}

function track(id: string) {
  return TrackSchema.parse({
    id,
    provider: "youtube",
    title: `Track ${id}`,
    artist: "Artist",
    url: `https://www.youtube.com/watch?v=${id}`,
    durationMs: 42_000,
  })
}

describe("YouTube resolved media cache", () => {
  it("Given a successful resolution When the track repeats Then extraction runs once", async () => {
    // Given
    let executions = 0
    const source = new YouTubeMusicSource(undefined, undefined, {
      extractor: {
        async resolve() {
          executions += 1
          return media
        },
      },
    })

    // When
    const first = await source.resolve(track("repeat"))
    const second = await source.resolve(track("repeat"))

    // Then
    expect(first).toBe(media)
    expect(second).toBe(media)
    expect(executions).toBe(1)
  })

  it("Given an expired resolution When the track repeats Then extraction refreshes", async () => {
    // Given
    let now = 1_000
    let executions = 0
    const source = new YouTubeMusicSource(undefined, undefined, {
      now: () => now,
      resolvedCacheTtlMs: 100,
      extractor: {
        async resolve() {
          executions += 1
          return media
        },
      },
    })
    await source.resolve(track("expires"))

    // When
    now = 1_100
    await source.resolve(track("expires"))

    // Then
    expect(executions).toBe(2)
  })

  it("Given a failed resolution When retried Then the failure was not cached", async () => {
    // Given
    let executions = 0
    const source = new YouTubeMusicSource(undefined, undefined, {
      extractor: {
        async resolve() {
          executions += 1
          if (executions === 1) throw new RangeError("temporary extraction failure")
          return media
        },
      },
    })

    // When
    await expect(source.resolve(track("retry"))).rejects.toBeInstanceOf(RangeError)
    const retried = await source.resolve(track("retry"))

    // Then
    expect(retried).toBe(media)
    expect(executions).toBe(2)
  })

  it("Given a full resolution cache When an entry is added Then the oldest is evicted", async () => {
    // Given
    let executions = 0
    const source = new YouTubeMusicSource(undefined, undefined, {
      resolvedCacheCapacity: 1,
      extractor: {
        async resolve() {
          executions += 1
          return media
        },
      },
    })
    await source.resolve(track("first"))
    await source.resolve(track("second"))

    // When
    await source.resolve(track("first"))

    // Then
    expect(executions).toBe(3)
  })

  it("Given a cached resolution When the caller is already aborted Then it rejects", async () => {
    // Given
    let executions = 0
    const source = new YouTubeMusicSource(undefined, undefined, {
      extractor: {
        async resolve() {
          executions += 1
          return media
        },
      },
    })
    const repeatedTrack = track("aborted")
    await source.resolve(repeatedTrack)
    const controller = new AbortController()
    controller.abort()

    // When
    const outcome = source.resolve(repeatedTrack, controller.signal)

    // Then
    await expect(outcome).rejects.toMatchObject({ name: "AbortError" })
    expect(executions).toBe(1)
  })
})
