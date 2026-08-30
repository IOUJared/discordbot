import { describe, expect, it } from "vitest"

import { interpolatePosition, nextReconnectDelay } from "../src/lib/domain/playback.js"
import { moveQueueItem } from "../src/lib/domain/queue.js"

describe("playback domain", () => {
  it("Given playing media When time advances Then position is interpolated and capped", () => {
    expect(
      interpolatePosition(
        { positionMs: 8_000, durationMs: 10_000, paused: false, observedAtMs: 1_000 },
        5_000,
      ),
    ).toBe(10_000)
  })

  it("Given paused media When time advances Then position stays at the snapshot", () => {
    expect(
      interpolatePosition(
        { positionMs: 8_000, durationMs: 10_000, paused: true, observedAtMs: 1_000 },
        5_000,
      ),
    ).toBe(8_000)
  })

  it("Given reconnect attempts When delay is requested Then exponential jitter is deterministic", () => {
    expect(nextReconnectDelay(3, () => 0.5)).toBe(4_000)
  })
})

describe("queue domain", () => {
  it("Given queue rows When an item moves Then order changes without mutating input", () => {
    const input = ["a", "b", "c"]
    expect(moveQueueItem(input, 2, 0)).toEqual(["c", "a", "b"])
    expect(input).toEqual(["a", "b", "c"])
  })
})
