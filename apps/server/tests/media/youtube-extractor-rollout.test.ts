import { BitrateKbpsSchema, type Track, TrackSchema } from "@discord-music/contracts"
import { describe, expect, it } from "vitest"

import { RemoteMediaUrlSchema } from "../../src/media/media-url-policy.js"
import type { PlayableMedia } from "../../src/media/types.js"
import {
  createYouTubeExtractorRollout,
  type ExtractorRolloutObservation,
  type SidecarExtractorClient,
} from "../../src/media/youtube-extractor-rollout.js"
import {
  SidecarClientDeadlineError,
  SidecarDeadlineError,
  SidecarExtractorError,
  SidecarInternalError,
  SidecarInvalidRequestError,
  SidecarOverloadedError,
  SidecarProtocolError,
  SidecarRequestRejectedError,
  SidecarUnavailableError,
} from "../../src/media/youtube-sidecar-client.js"

const track = TrackSchema.parse({
  id: "rollout-track",
  provider: "youtube",
  title: "Rollout track",
  artist: "Artist",
  url: "https://www.youtube.com/watch?v=rollout-track",
  durationMs: 60_000,
  artworkUrl: "https://img.youtube.com/rollout-track.jpg",
})
const media: PlayableMedia = {
  kind: "remote",
  url: RemoteMediaUrlSchema.parse("https://rr1---fixture.googlevideo.com/videoplayback?id=rollout"),
  headers: {},
  container: "webm",
  codec: "opus",
  bitrateKbps: BitrateKbpsSchema.parse(128),
  seekable: true,
}

function deferred<Value>(): {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
  readonly reject: (reason: unknown) => void
} {
  let resolve: ((value: Value) => void) | undefined
  let reject: ((reason: unknown) => void) | undefined
  const promise = new Promise<Value>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  if (resolve === undefined || reject === undefined)
    throw new TypeError("Deferred was not initialized")
  return { promise, resolve, reject }
}

function localExtractor(result: PlayableMedia = media): {
  readonly calls: () => number
  readonly resolve: (input: Track, signal?: AbortSignal) => Promise<PlayableMedia>
} {
  let calls = 0
  return {
    calls: () => calls,
    async resolve() {
      calls += 1
      return result
    },
  }
}

function sidecarClient(
  resolve: (input: Track, signal?: AbortSignal) => Promise<PlayableMedia>,
): SidecarExtractorClient & { readonly closeCalls: () => number } {
  let closeCalls = 0
  return {
    resolve,
    async close() {
      closeCalls += 1
    },
    closeCalls: () => closeCalls,
  }
}

describe("YouTube extractor rollout", () => {
  it("implements every mode state and fallback transition", async () => {
    // Given: local extraction and each strict client outcome from the frozen v1 cause table.
    const noFallback = [
      new SidecarInvalidRequestError("invalid"),
      new SidecarRequestRejectedError("rejected"),
      new SidecarExtractorError("extractor"),
    ] as const
    const fallbackOnce = [
      new SidecarOverloadedError("busy"),
      new SidecarDeadlineError("deadline"),
      new SidecarClientDeadlineError("client deadline"),
      new SidecarInternalError("internal"),
      new SidecarUnavailableError("unavailable"),
      new SidecarProtocolError("protocol"),
    ] as const

    const disabled = createYouTubeExtractorRollout({
      mode: "disabled",
      local: localExtractor(),
    })

    // When: disabled resolves, strict Rust failures occur, then a valid response succeeds.
    await expect(disabled.resolve(track)).resolves.toEqual(media)
    expect(disabled.state()).toBe("disabled")

    for (const error of noFallback) {
      const local = localExtractor()
      const rollout = createYouTubeExtractorRollout({
        mode: "rust",
        local,
        createSidecar: () => sidecarClient(async () => Promise.reject(error)),
      })
      await expect(rollout.resolve(track)).rejects.toBe(error)
      expect(local.calls()).toBe(0)
      expect(rollout.state()).toBe("degraded")
      await rollout.close()
    }
    for (const error of fallbackOnce) {
      const local = localExtractor()
      const rollout = createYouTubeExtractorRollout({
        mode: "rust",
        local,
        createSidecar: () => sidecarClient(async () => Promise.reject(error)),
      })
      await expect(rollout.resolve(track)).resolves.toEqual(media)
      expect(local.calls()).toBe(1)
      expect(rollout.state()).toBe("degraded")
      await rollout.close()
    }
    const local = localExtractor()
    const rust = createYouTubeExtractorRollout({
      mode: "rust",
      local,
      createSidecar: () => sidecarClient(async () => media),
    })
    await expect(rust.resolve(track)).resolves.toEqual(media)

    const abortedLocal = localExtractor()
    const aborted = createYouTubeExtractorRollout({
      mode: "rust",
      local: abortedLocal,
      createSidecar: () =>
        sidecarClient(async () => Promise.reject(new DOMException("aborted", "AbortError"))),
    })
    await expect(aborted.resolve(track)).rejects.toMatchObject({ name: "AbortError" })
    expect(abortedLocal.calls()).toBe(0)
    expect(aborted.state()).toBe("unknown")

    const shadow = createYouTubeExtractorRollout({
      mode: "shadow",
      local: localExtractor(),
      createSidecar: () =>
        sidecarClient(async () => Promise.reject(new SidecarProtocolError("mismatch"))),
    })
    await expect(shadow.resolve(track)).resolves.toEqual(media)
    await shadow.drain()

    // Then: only the permitted causes fallback once, and a valid Rust result recovers readiness.
    expect(local.calls()).toBe(0)
    expect(rust.state()).toBe("ready")
    expect(shadow.state()).toBe("degraded")
    await Promise.all([aborted.close(), disabled.close(), rust.close(), shadow.close()])
  })

  it("caps shadow work at 32 and skips call 33", async () => {
    // Given: thirty-two sidecar operations held open and a local result that is immediately available.
    const held = Array.from({ length: 32 }, () => deferred<PlayableMedia>())
    const observations: ExtractorRolloutObservation[] = []
    const local = localExtractor()
    let sidecarCalls = 0
    const rollout = createYouTubeExtractorRollout({
      mode: "shadow",
      local,
      observe: (event) => observations.push(event),
      createSidecar: () =>
        sidecarClient(async () => {
          const operation = held.at(sidecarCalls)
          sidecarCalls += 1
          if (operation === undefined) throw new TypeError("Unexpected shadow sidecar call")
          return operation.promise
        }),
    })

    // When: thirty-three local requests are made while every shadow operation remains pending.
    await Promise.all(Array.from({ length: 33 }, () => rollout.resolve(track)))

    // Then: no queue forms beyond thirty-two and the thirty-third call records a degraded skip.
    expect(local.calls()).toBe(33)
    expect(sidecarCalls).toBe(32)
    expect(rollout.pendingShadow()).toBe(32)
    expect(rollout.state()).toBe("degraded")
    expect(observations.filter(({ stage }) => stage === "local_extraction")).toHaveLength(33)
    expect(observations.filter(({ stage }) => stage === "shadow_start")).toHaveLength(32)
    expect(observations.filter(({ stage }) => stage === "shadow_skip")).toHaveLength(1)
    expect(observations.at(-1)).toMatchObject({
      stage: "shadow_skip",
      state: "degraded",
      pendingShadow: 32,
    })
    for (const operation of held) operation.resolve(media)
    await rollout.drain()
    expect(rollout.pendingShadow()).toBe(0)
    expect(rollout.state()).toBe("ready")
    expect(observations.filter(({ stage }) => stage === "sidecar_outcome")).toHaveLength(32)
    expect(observations.filter(({ stage }) => stage === "shadow_match")).toHaveLength(0)
    await rollout.close()
  })

  it("close aborts and drains exactly once", async () => {
    // Given: a shadow call whose sidecar operation observes its abort signal.
    const started = deferred<void>()
    const ended = deferred<void>()
    const client = sidecarClient(
      async (_input, signal) =>
        new Promise<PlayableMedia>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              ended.resolve()
              reject(new DOMException("aborted", "AbortError"))
            },
            { once: true },
          )
          started.resolve()
        }),
    )
    const rollout = createYouTubeExtractorRollout({
      mode: "shadow",
      local: localExtractor(),
      createSidecar: () => client,
    })
    await rollout.resolve(track)
    await started.promise

    // When: concurrent callers close the rollout.
    await Promise.all([rollout.close(), rollout.close()])

    // Then: the operation is aborted/reaped exactly once and client teardown is singular.
    await ended.promise
    expect(rollout.pendingShadow()).toBe(0)
    expect(client.closeCalls()).toBe(1)
  })
})
