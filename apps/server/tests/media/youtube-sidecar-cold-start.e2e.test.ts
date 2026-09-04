import { type SearchResult, TrackSchema } from "@discord-music/contracts"
import { afterEach, describe, expect, it } from "vitest"

import type { PlayableMedia } from "../../src/media/types.js"
import { YouTubeMusicSource } from "../../src/media/youtube.js"
import type { YouTubeExtractor } from "../../src/media/youtube-extractor.js"
import {
  createYouTubeExtractorRollout,
  type SidecarExtractorClient,
} from "../../src/media/youtube-extractor-rollout.js"
import { SidecarUnavailableError } from "../../src/media/youtube-sidecar-client.js"
import { beginHttpSearch, searchApi, startSearchApp } from "./youtube-sidecar-e2e-fixture.js"

const results = [
  {
    track: TrackSchema.parse({
      id: "cold-start-video",
      provider: "youtube",
      title: "Cold start song",
      artist: "Artist",
      url: "https://www.youtube.com/watch?v=cold-start-video",
      durationMs: 42_000,
      artworkUrl: "https://img.youtube.com/cold-start-video.jpg",
    }),
    score: 1,
    bitrateKbps: null,
  },
] satisfies readonly SearchResult[]

const apps: { close(): Promise<void> }[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe("Node media sidecar cold start", () => {
  it("serves an authenticated local search after a cold Rust outage and recovers without restart", async () => {
    // Given: Node starts in Rust mode before its private sidecar is reachable.
    let sidecarOnline = false
    let sidecarCalls = 0
    let localCalls = 0
    const local: YouTubeExtractor = {
      resolve: async () => Promise.reject(new TypeError("Resolve is outside this scenario")),
    }
    const rollout = createYouTubeExtractorRollout({
      mode: "rust",
      local,
      localSearch: {
        search: async () => {
          localCalls += 1
          return results
        },
      },
      createSidecar: (): SidecarExtractorClient => ({
        search: async () => {
          sidecarCalls += 1
          if (!sidecarOnline) throw new SidecarUnavailableError("cold sidecar")
          return results
        },
        resolve: async (): Promise<PlayableMedia> =>
          Promise.reject(new TypeError("Resolve is outside this scenario")),
        close: async () => undefined,
      }),
    })
    expect(sidecarCalls).toBe(0)
    const source = new YouTubeMusicSource(undefined, undefined, { searchClient: rollout })
    const runtime = await startSearchApp(searchApi(source.search.bind(source)), () => undefined)
    apps.push({
      close: async () => {
        await Promise.all([runtime.app.close(), rollout.close()])
      },
    })
    expect(sidecarCalls).toBe(0)

    // When: an authenticated search arrives before sidecar recovery, then the same Node process retries.
    const cold = await beginHttpSearch(runtime.address, "cold-start").completion
    sidecarOnline = true
    const recovered = await beginHttpSearch(runtime.address, "recovered").completion

    // Then: the cold request takes the typed local fallback and later traffic returns to Rust-ready.
    expect(cold).toMatchObject({ kind: "response", statusCode: 200, body: { results } })
    expect(recovered).toMatchObject({ kind: "response", statusCode: 200, body: { results } })
    expect(localCalls).toBe(1)
    expect(sidecarCalls).toBe(2)
    expect(rollout.state()).toBe("ready")
  })
})
