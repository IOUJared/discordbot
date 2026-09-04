import { describe, expect, it } from "vitest"

import { type RemoteMediaPolicy, RemoteMediaUrlSchema } from "../../src/media/media-url-policy.js"
import type { ProcessExecutor } from "../../src/media/types.js"
import { YouTubeMusicSource } from "../../src/media/youtube.js"
import { fixture, searchResults } from "./youtube.test-helpers.js"

describe("YouTube search preload and eviction", () => {
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
          return searchResults
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
            return searchResults
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
        return searchResults
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
})
