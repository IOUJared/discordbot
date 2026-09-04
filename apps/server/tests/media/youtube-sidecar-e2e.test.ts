import { type SearchResult, TrackSchema } from "@discord-music/contracts"
import { afterEach, describe, expect, it } from "vitest"

import type { PlayableMedia } from "../../src/media/types.js"
import { YouTubeMusicSource } from "../../src/media/youtube.js"
import type { YouTubeExtractor } from "../../src/media/youtube-extractor.js"
import {
  createYouTubeExtractorRollout,
  type SidecarExtractorClient,
} from "../../src/media/youtube-extractor-rollout.js"
import type { SidecarRuntimeObservation } from "../../src/media/youtube-sidecar-observation.js"
import {
  beginHttpSearch,
  deferred,
  searchApi,
  startSearchApp,
} from "./youtube-sidecar-e2e-fixture.js"
import {
  rustCorrelationIds,
  rustCounterDeltas,
  rustStages,
  startRustSearchApp,
} from "./youtube-sidecar-rust-e2e-fixture.js"

const results = [
  {
    track: TrackSchema.parse({
      id: "video-1",
      provider: "youtube",
      title: "Song",
      artist: "Artist",
      url: "https://www.youtube.com/watch?v=video-1",
      durationMs: 42_000,
      artworkUrl: "https://img.youtube.com/video-1.jpg",
    }),
    score: 1,
    bitrateKbps: null,
  },
] satisfies readonly SearchResult[]

const apps: { close(): Promise<void> }[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function blockedSource(events: SidecarRuntimeObservation[]): {
  readonly source: YouTubeMusicSource
  readonly release: (value: readonly SearchResult[]) => void
  readonly started: Promise<void>
  readonly aborts: () => number
} {
  const result = deferred<readonly SearchResult[]>()
  const started = deferred<void>()
  let aborts = 0
  const source = new YouTubeMusicSource(undefined, undefined, {
    observe: (event) => events.push(event),
    searchClient: {
      search: async (_query, signal) => {
        started.resolve()
        signal?.addEventListener(
          "abort",
          () => {
            aborts += 1
          },
          { once: true },
        )
        return result.promise
      },
    },
  })
  return { source, release: result.resolve, started: started.promise, aborts: () => aborts }
}

async function waitForWaiterCount(
  events: SidecarRuntimeObservation[],
  waiterCount: number,
  occurrences = 1,
): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (
      events.filter((event) => event.stage === "waiter_count" && event.waiterCount === waiterCount)
        .length >= occurrences
    )
      return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new TypeError(`Waiter count ${waiterCount} was not observed: ${JSON.stringify(events)}`)
}

describe("Node media sidecar runtime", () => {
  it("preserves public contracts in disabled shadow and rust modes", async () => {
    // Given: local and sidecar adapters return the same strict public result.
    let constructed = 0
    let closed = 0
    const local: YouTubeExtractor = {
      resolve: async () => Promise.reject(new TypeError("Resolve is outside this scenario")),
    }
    const localSearch = { search: async () => results }
    const createSidecar = (): SidecarExtractorClient => {
      constructed += 1
      return {
        search: async () => results,
        resolve: async (): Promise<PlayableMedia> =>
          Promise.reject(new TypeError("Resolve is outside this scenario")),
        close: async () => {
          closed += 1
        },
      }
    }
    const disabled = createYouTubeExtractorRollout({ mode: "disabled", local, localSearch })
    const shadow = createYouTubeExtractorRollout({
      mode: "shadow",
      local,
      localSearch,
      createSidecar,
    })
    const rust = createYouTubeExtractorRollout({ mode: "rust", local, localSearch, createSidecar })

    // When: the same search crosses each mode and every rollout closes.
    const publicResults = await Promise.all([
      disabled.search("song"),
      shadow.search("song"),
      rust.search("song"),
    ])
    await shadow.drain()
    await Promise.all([disabled.close(), shadow.close(), rust.close()])

    // Then: the public contract is identical and disabled never constructs a client.
    expect(publicResults).toEqual([results, results, results])
    expect(constructed).toBe(2)
    expect(closed).toBe(2)
  })

  it("request close after body completion is not disconnect while response is pending", async () => {
    // Given: a real Fastify search request whose extraction is blocked after its body completes.
    const events: SidecarRuntimeObservation[] = []
    const blocked = blockedSource(events)
    const runtime = await startSearchApp(
      searchApi(blocked.source.search.bind(blocked.source)),
      (event) => events.push(event),
    )
    apps.push(runtime.app)
    const request = beginHttpSearch(runtime.address, "normal-close")
    await blocked.started

    // When: the pending extraction succeeds after the request body stream has closed normally.
    blocked.release(results)
    const response = await request.completion

    // Then: the response finishes successfully without disconnect or underlying cancellation.
    expect(response).toMatchObject({ kind: "response", statusCode: 200 })
    expect(events.some(({ stage }) => stage === "response_finish")).toBe(true)
    expect(events.some(({ stage }) => stage === "disconnect")).toBe(false)
    expect(blocked.aborts()).toBe(0)
  })

  it("response socket close decrements two coalesced waiters from two to one without abort", async () => {
    // Given: two real HTTP callers joined to one blocked extraction.
    const events: SidecarRuntimeObservation[] = []
    const blocked = blockedSource(events)
    const runtime = await startSearchApp(
      searchApi(blocked.source.search.bind(blocked.source)),
      (event) => events.push(event),
    )
    apps.push(runtime.app)
    const first = beginHttpSearch(runtime.address, "shared")
    const second = beginHttpSearch(runtime.address, "shared")
    await waitForWaiterCount(events, 2)

    // When: only the first response socket is destroyed and the extraction then succeeds.
    first.destroy()
    await waitForWaiterCount(events, 1, 2)
    blocked.release(results)

    // Then: the other caller succeeds and the shared extraction was not cancelled.
    await expect(first.completion).resolves.toEqual({ kind: "closed" })
    await expect(second.completion).resolves.toMatchObject({ kind: "response", statusCode: 200 })
    expect(blocked.aborts()).toBe(0)
    expect(events.filter(({ stage }) => stage === "disconnect")).toHaveLength(1)
  })

  it("second response socket close decrements one to zero and cancels exactly once", async () => {
    // Given: two real HTTP callers joined to one blocked extraction.
    const events: SidecarRuntimeObservation[] = []
    const blocked = blockedSource(events)
    const runtime = await startSearchApp(
      searchApi(blocked.source.search.bind(blocked.source)),
      (event) => events.push(event),
    )
    apps.push(runtime.app)
    const first = beginHttpSearch(runtime.address, "all-gone")
    const second = beginHttpSearch(runtime.address, "all-gone")
    await waitForWaiterCount(events, 2)

    // When: both response sockets are destroyed in order.
    first.destroy()
    await waitForWaiterCount(events, 1, 2)
    second.destroy()
    await waitForWaiterCount(events, 0)
    await Promise.all([first.completion, second.completion])

    // Then: the final waiter transition cancels the shared extraction exactly once.
    expect(blocked.aborts()).toBe(1)
    expect(events.filter(({ stage }) => stage === "disconnect")).toHaveLength(2)
    expect(
      events.filter(({ stage, waiterCount }) => stage === "waiter_count" && waiterCount === 0),
    ).toHaveLength(1)
    expect(events.some(({ stage }) => stage === "response_finish")).toBe(false)
  })

  it("destroyed coalesced requests cancel through Rust and drain its registry", async () => {
    // Given: two real Node requests share one release Rust request blocked at its upstream.
    const events: SidecarRuntimeObservation[] = []
    const runtime = await startRustSearchApp(events)
    apps.push({ close: runtime.close })
    const first = beginHttpSearch(runtime.address, "rust-cancel")
    const second = beginHttpSearch(runtime.address, "rust-cancel")
    await Promise.race([
      waitForWaiterCount(events, 2),
      Promise.all([first.completion, second.completion]).then((responses) => {
        throw new TypeError(
          `Rust requests finished before coalescing: ${JSON.stringify(responses)}`,
        )
      }),
    ])

    // When: both public response sockets disconnect.
    first.destroy()
    await waitForWaiterCount(events, 1, 2)
    second.destroy()
    await Promise.all([first.completion, second.completion, runtime.drained])

    // Then: Rust drains its supervised request and caller abort never falls back locally.
    expect(runtime.localCalls()).toBe(0)
    expect(rustCounterDeltas(runtime.rustEvents(), "registry")).toEqual([1, -1])
    expect(rustCounterDeltas(runtime.rustEvents(), "innertube_upstream")).toEqual([1, -1])
    expect(rustCounterDeltas(runtime.rustEvents(), "rust_handler")).toEqual([1, -1])
    const nodeEvents = runtime.nodeEvents()
    expect(nodeEvents.filter(({ stage }) => stage === "route_start")).toHaveLength(2)
    expect(nodeEvents.map(({ stage }) => stage)).toEqual(
      expect.arrayContaining(["waiter_count", "client_sent", "client_failure", "sidecar_outcome"]),
    )
    expect(rustStages(runtime.rustEvents())).toEqual(
      expect.arrayContaining(["rust_handler", "registry", "innertube_upstream"]),
    )
    const correlationIds = new Set([
      ...nodeEvents.map(({ correlationId }) => correlationId),
      ...rustCorrelationIds(runtime.rustEvents()),
    ])
    expect(correlationIds.size).toBe(1)
    expect([...correlationIds][0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    )
    expect(JSON.stringify(runtime.rustEvents())).not.toContain("rust-cancel")
    expect(JSON.stringify(events)).not.toContain("rust-cancel")
    expect(events.filter(({ stage }) => stage === "disconnect")).toHaveLength(2)
    expect(
      events.filter(({ stage, waiterCount }) => stage === "waiter_count" && waiterCount === 0),
    ).toHaveLength(1)
  })
})
