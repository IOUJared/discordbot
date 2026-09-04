import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { BitrateKbpsSchema, type SearchResult, TrackSchema } from "@discord-music/contracts"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { RemoteMediaUrlSchema } from "../../src/media/media-url-policy.js"
import type { PlayableMedia } from "../../src/media/types.js"
import { createYouTubeExtractorRollout } from "../../src/media/youtube-extractor-rollout.js"

const track = TrackSchema.parse({
  id: "advanced-track",
  provider: "youtube",
  title: "Advanced track",
  artist: "Artist",
  url: "https://www.youtube.com/watch?v=advanced-track",
  durationMs: 60_000,
  artworkUrl: "https://img.youtube.com/advanced-track.jpg",
})
const media: PlayableMedia = {
  kind: "remote",
  url: RemoteMediaUrlSchema.parse(
    "https://rr1---fixture.googlevideo.com/videoplayback?id=advanced",
  ),
  headers: {},
  container: "webm",
  codec: "opus",
  bitrateKbps: BitrateKbpsSchema.parse(128),
  seekable: true,
}
const localResult = { track, score: 1, bitrateKbps: null } satisfies SearchResult
const localSearch = [localResult] satisfies readonly SearchResult[]
const remoteSearch = [
  {
    track: TrackSchema.parse({
      ...track,
      id: "different-track",
      url: "https://www.youtube.com/watch?v=different-track",
    }),
    score: 1,
    bitrateKbps: null,
  },
] satisfies readonly SearchResult[]
const workspace = fileURLToPath(new URL("../../../../", import.meta.url))
const fingerprintChild = fileURLToPath(
  new URL("./youtube-extractor-rollout-fingerprint-child.mjs", import.meta.url),
)
const fingerprintOutput = z
  .object({ fingerprints: z.array(z.string().regex(/^[0-9a-f]{64}$/u)).length(2) })
  .strict()

function deferred<Value>(): {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
} {
  let resolve: ((value: Value) => void) | undefined
  const promise = new Promise<Value>((nextResolve) => {
    resolve = nextResolve
  })
  if (resolve === undefined) throw new TypeError("Deferred was not initialized")
  return { promise, resolve }
}

describe("YouTube extractor rollout advanced lifecycle", () => {
  it("does not begin a shadow operation after close races pending local extraction", async () => {
    const local = deferred<PlayableMedia>()
    let sidecarCalls = 0
    let sidecarClosed = 0
    const rollout = createYouTubeExtractorRollout({
      mode: "shadow",
      local: { resolve: async () => local.promise },
      createSidecar: () => ({
        resolve: async () => {
          sidecarCalls += 1
          return media
        },
        close: async () => {
          sidecarClosed += 1
        },
      }),
    })

    const request = rollout.resolve(track)
    const close = rollout.close()
    local.resolve(media)
    await Promise.all([request, close])

    expect(sidecarCalls).toBe(0)
    expect(sidecarClosed).toBe(1)
    expect(rollout.pendingShadow()).toBe(0)
  })

  it("emits a mismatch only when local and Rust search track IDs differ", async () => {
    const stages: string[] = []
    const rollout = createYouTubeExtractorRollout({
      mode: "shadow",
      local: { resolve: async () => media },
      localSearch: { search: async () => localSearch },
      observe: (event) => stages.push(event.stage),
      createSidecar: () => ({
        resolve: async () => media,
        search: async () => remoteSearch,
        close: async () => undefined,
      }),
    })

    await expect(rollout.search("advanced")).resolves.toEqual(localSearch)
    await rollout.drain()

    expect(stages).toContain("shadow_mismatch")
    expect(stages).not.toContain("shadow_match")
    await rollout.close()
  })

  it("uses a different fingerprint salt in each child process", () => {
    execFileSync("pnpm", ["--filter", "@discord-music/server", "build"], {
      cwd: workspace,
      stdio: "pipe",
    })
    const first = fingerprintOutput.parse(
      JSON.parse(execFileSync(process.execPath, [fingerprintChild], { encoding: "utf8" })),
    )
    const second = fingerprintOutput.parse(
      JSON.parse(execFileSync(process.execPath, [fingerprintChild], { encoding: "utf8" })),
    )

    expect(new Set(first.fingerprints).size).toBe(1)
    expect(new Set(second.fingerprints).size).toBe(1)
    expect(first.fingerprints[0]).not.toBe(second.fingerprints[0])
  })
})
