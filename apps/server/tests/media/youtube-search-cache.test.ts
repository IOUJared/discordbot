import type { SearchResult } from "@discord-music/contracts"
import { describe, expect, it } from "vitest"

import { YouTubeMusicSource } from "../../src/media/youtube.js"
import type { SidecarRuntimeObservation } from "../../src/media/youtube-sidecar-observation.js"
import { searchResults } from "./youtube.test-helpers.js"

describe("YouTube search cache and cancellation", () => {
  it("caches normalized repeat searches until the cache entry expires", async () => {
    // Given
    let now = 1_000
    let executions = 0
    const searchClient = {
      async search() {
        executions += 1
        return searchResults
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

  it("Given equivalent Unicode and whitespace When searches repeat Then one upstream call is used", async () => {
    // Given
    let executions = 0
    const source = new YouTubeMusicSource(undefined, undefined, {
      searchClient: {
        async search() {
          executions += 1
          return searchResults
        },
      },
    })

    // When
    await source.search("  CAFÉ\tＤＡＦＴ  ")
    await source.search("cafe\u0301 daft")

    // Then
    expect(executions).toBe(1)
  })

  it("Given the default cache When five minutes pass Then a repeat remains cached", async () => {
    // Given
    let now = 1_000
    let executions = 0
    const source = new YouTubeMusicSource(undefined, undefined, {
      now: () => now,
      searchClient: {
        async search() {
          executions += 1
          return searchResults
        },
      },
    })
    await source.search("Daft Punk")

    // When
    now += 5 * 60_000
    await source.search("daft punk")

    // Then
    expect(executions).toBe(1)
  })

  it("coalesces concurrent normalized searches into one upstream request", async () => {
    // Given
    let executions = 0
    const source = new YouTubeMusicSource(undefined, undefined, {
      searchClient: {
        async search() {
          executions += 1
          await new Promise((resolve) => setImmediate(resolve))
          return searchResults
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

  it("Given two coalesced search waiters When one aborts Then shared extraction continues", async () => {
    // Given: two callers share one blocked upstream search.
    let release: ((results: readonly SearchResult[]) => void) | undefined
    let underlyingAborts = 0
    const source = new YouTubeMusicSource(undefined, undefined, {
      searchClient: {
        search: async (_query, signal) =>
          new Promise<readonly SearchResult[]>((resolve, reject) => {
            release = resolve
            signal?.addEventListener(
              "abort",
              () => {
                underlyingAborts += 1
                reject(new DOMException("aborted", "AbortError"))
              },
              { once: true },
            )
          }),
      },
    })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = source.search("coalesced", firstController.signal)
    const second = source.search("coalesced", secondController.signal)

    // When: only the first caller disconnects and the shared upstream then succeeds.
    firstController.abort()
    release?.(searchResults)

    // Then: the disconnected waiter rejects while the remaining waiter succeeds without cancellation.
    await expect(first).rejects.toMatchObject({ name: "AbortError" })
    await expect(second).resolves.toEqual(searchResults)
    expect(underlyingAborts).toBe(0)
  })

  it("Given two coalesced search waiters When both abort Then shared extraction aborts once", async () => {
    // Given: two callers share one blocked upstream search.
    let underlyingAborts = 0
    const source = new YouTubeMusicSource(undefined, undefined, {
      searchClient: {
        search: async (_query, signal) =>
          new Promise<readonly SearchResult[]>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                underlyingAborts += 1
                reject(new DOMException("aborted", "AbortError"))
              },
              { once: true },
            )
          }),
      },
    })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = source.search("coalesced", firstController.signal)
    const second = source.search("coalesced", secondController.signal)

    // When: both callers disconnect.
    firstController.abort()
    secondController.abort()

    // Then: each waiter rejects and the shared extraction receives exactly one abort.
    await expect(first).rejects.toMatchObject({ name: "AbortError" })
    await expect(second).rejects.toMatchObject({ name: "AbortError" })
    expect(underlyingAborts).toBe(1)
  })

  it("Given Rust search observations When results return Then only a salted fingerprint is emitted", async () => {
    // Given: a query and track identifier that must remain private.
    const observations: SidecarRuntimeObservation[] = []
    const source = new YouTubeMusicSource(undefined, undefined, {
      observe: (event) => observations.push(event),
      observeSearchResultIds: true,
      searchClient: { search: async () => searchResults },
    })

    // When: the strict sidecar result becomes the public result in memory.
    await source.search("private-search-query")

    // Then: the event contains one match and an opaque process-salted fingerprint only.
    const serialized = JSON.stringify(observations)
    expect(serialized).not.toContain("private-search-query")
    expect(serialized).not.toContain("video-1")
    expect(observations.find(({ stage }) => stage === "in_memory_id_match")).toMatchObject({
      count: 1,
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
  })
})
