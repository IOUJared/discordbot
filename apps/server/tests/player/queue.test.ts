import {
  DurationMsSchema,
  QueueItemIdSchema,
  TimestampSchema,
  TrackIdSchema,
  UserIdSchema,
} from "@discord-music/contracts"
import { describe, expect, it } from "vitest"

import { DuplicateQueueItemError, PlayerQueue } from "../../src/player/queue.js"

const userId = UserIdSchema.parse("owner")
const timestamp = TimestampSchema.parse("2026-01-01T00:00:00.000Z")

function item(index: number) {
  return {
    id: QueueItemIdSchema.parse(`queue-${index}`),
    track: {
      id: TrackIdSchema.parse(`track-${index}`),
      provider: "youtube" as const,
      title: `Track ${index}`,
      artist: "Artist",
      url: `https://youtube.example/watch?v=${index}`,
      durationMs: DurationMsSchema.parse(180_000),
    },
    requestedBy: userId,
    addedAt: timestamp,
  }
}

describe("PlayerQueue", () => {
  it("keeps duplicate tracks as distinct queue items", () => {
    // Given
    const queue = new PlayerQueue([item(1), { ...item(1), id: QueueItemIdSchema.parse("queue-2") }])

    // When
    const ids = queue.list().map(({ id }) => id)

    // Then
    expect(ids).toEqual(["queue-1", "queue-2"])
  })

  it("rejects duplicate queue item IDs before ID operations become ambiguous", () => {
    // Given
    const queue = new PlayerQueue([item(1)])

    // When
    const duplicate = () => queue.push({ ...item(2), id: QueueItemIdSchema.parse("queue-1") })

    // Then
    expect(duplicate).toThrow(DuplicateQueueItemError)
    expect(queue.list().map(({ id }) => id)).toEqual(["queue-1"])
  })

  it("supports remove, move, and play-next ordering", () => {
    // Given
    const queue = new PlayerQueue([item(1), item(2), item(3), item(4)])

    // When
    queue.remove(QueueItemIdSchema.parse("queue-2"))
    queue.move(QueueItemIdSchema.parse("queue-4"), 0)
    queue.playNext(QueueItemIdSchema.parse("queue-3"))

    // Then
    expect(queue.list().map(({ id }) => id)).toEqual(["queue-3", "queue-4", "queue-1"])
  })

  it("uses injected randomness for deterministic shuffle", () => {
    // Given
    const queue = new PlayerQueue([item(1), item(2), item(3)])
    const values = [0, 0.5]
    let index = 0

    // When
    queue.shuffle(() => values[index++] ?? 0)

    // Then
    expect(queue.list().map(({ id }) => id)).toEqual(["queue-3", "queue-2", "queue-1"])
  })
})
